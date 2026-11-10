import { run } from "./safe.ts";

/**
 * Actions sent over a live connection (WebSocket) instead of ordinary requests: Phoenix LiveView,
 * Rails ActionCable, Socket.IO (binary events too), Firebase Realtime Database, Meteor's DDP,
 * JSON-RPC, or plain JSON messages with a type.
 * Each message is read for the action's name (a word the developer chose) and its data (shapes
 * only, never values, like any request). Replies are read for one thing: whether the server
 * refused it, and its code. The page's own sending and receiving are never changed.
 */
export interface SocketAction {
  url: string;
  /** "publish", "speak", "set tasks": the action's name. */
  operation: string;
  data?: unknown;
}

export interface SocketReply {
  /** The action this answers. */
  action: SocketAction;
  ok: boolean;
  errorCode?: string;
}

/** Names a developer writes: letters first, then letters, digits and _ . : - (spaces only in "set tasks"). */
const NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,39}$/;
const CODE = /^[A-Za-z][A-Za-z_.-]{2,47}$/;
/** Plumbing every app sends on its own: never an action. */
const PLUMBING = /^(heartbeat|ping|pong|phx_join|phx_leave|phx_reply|presence.*|subscribe|unsubscribe|welcome|confirm_subscription|keepalive|typing)$/i;
const MAX_PENDING = 100;

export function installSocketCapture(win: Window & typeof globalThis, onSend: (a: SocketAction) => void, onReply: (r: SocketReply) => void): () => void {
  const proto = win.WebSocket?.prototype;
  if (!proto) return () => {};
  const originalSend = proto.send;
  /** Sockets we listen to for replies, with the actions still waiting for one (by the protocol's reference). */
  const pending = new WeakMap<WebSocket, Map<string, SocketAction>>();

  const listen = (ws: WebSocket) => {
    if (pending.has(ws)) return pending.get(ws)!;
    const waiting = new Map<string, SocketAction>();
    pending.set(ws, waiting);
    ws.addEventListener("message", (e) =>
      run(() => {
        const reply = readReply(typeof e.data === "string" ? e.data : "");
        const action = reply && waiting.get(reply.ref);
        if (!reply || !action) return;
        waiting.delete(reply.ref);
        onReply({ action, ok: reply.ok, ...(reply.errorCode ? { errorCode: reply.errorCode } : {}) });
      }),
    );
    return waiting;
  };

  const send = function (this: WebSocket, data: Parameters<WebSocket["send"]>[0]) {
    run(() => {
      if (typeof data !== "string") return;
      const read = readMessage(data);
      if (!read || PLUMBING.test(read.operation)) return;
      const action: SocketAction = { url: this.url, operation: read.operation, ...(read.data !== undefined ? { data: read.data } : {}) };
      if (read.ref !== undefined) {
        const waiting = listen(this);
        if (waiting.size < MAX_PENDING) waiting.set(read.ref, action);
      }
      onSend(action);
    });
    return originalSend.call(this, data);
  };
  proto.send = send;
  return () => {
    if (proto.send === send) proto.send = originalSend;
  };
}

/** The action in one outgoing message, the protocol's reference for its reply, and its data. */
export function readMessage(text: string): { operation: string; ref?: string; data?: unknown } | undefined {
  // Socket.IO: 42["event", data], with an optional namespace ("42/admin,") and ack id after the 42.
  // An event carrying files is 45 with the number of files that follow ("451-["upload", ...]").
  const io = /^4([2356])(?:\d+-)?(?:\/[^,[]*,)?(\d*)(\[.*)$/s.exec(text);
  const json = parse(io ? io[3]! : text);
  if (io && Array.isArray(json) && typeof json[0] === "string") return named(json[0], json[1], io[2] || undefined);
  if (Array.isArray(json) && json.length === 5 && typeof json[3] === "string") {
    // Phoenix: [join_ref, ref, topic, event, payload]; a LiveView event carries its own name.
    const [, ref, , event, payload] = json as [unknown, unknown, unknown, string, Record<string, unknown> | undefined];
    const name = event === "event" && typeof payload?.event === "string" ? payload.event : event;
    const value = typeof payload?.value === "string" ? Object.fromEntries(new URLSearchParams(payload.value)) : payload?.value;
    return named(name, value, typeof ref === "string" ? ref : undefined);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  const o = json as Record<string, unknown>;
  // Firebase Realtime Database: {t: "d", d: {r, a: "p" | "m", b: {p: "/tasks/abc", d}}}
  if (o.t === "d" && o.d && typeof o.d === "object") {
    const d = o.d as { r?: unknown; a?: unknown; b?: { p?: unknown; d?: unknown } };
    const verb = d.a === "p" ? "set" : d.a === "m" ? "update" : undefined;
    const collection = typeof d.b?.p === "string" ? d.b.p.split("/").filter(Boolean)[0] : undefined;
    if (!verb || !collection || !NAME.test(collection)) return undefined;
    return { operation: `${verb} ${collection}`, ...(d.r !== undefined ? { ref: String(d.r) } : {}), data: d.b?.d };
  }
  // Meteor's DDP: {msg: "method", method: "tasks.insert", params: [...], id}. Its other messages
  // (connect, ping, sub) are the connection's upkeep and its reads, never actions.
  if (typeof o.msg === "string") {
    if (o.msg !== "method" || typeof o.method !== "string") return undefined;
    return named(o.method, Array.isArray(o.params) ? o.params[0] : o.params, typeof o.id === "string" ? o.id : undefined);
  }
  // JSON-RPC: {jsonrpc: "2.0", method: "invoice.update", params, id}.
  if (typeof o.method === "string" && (o.jsonrpc !== undefined || ("params" in o && "id" in o))) {
    return named(o.method, Array.isArray(o.params) && o.params.length === 1 ? o.params[0] : o.params, typeof o.id === "string" || typeof o.id === "number" ? String(o.id) : undefined);
  }
  // ActionCable: {command: "message", identifier, data: "{\"action\":\"speak\", ...}"}
  if (o.command === "message" && typeof o.data === "string") {
    const data = parse(o.data) as Record<string, unknown> | undefined;
    return data && typeof data.action === "string" ? named(data.action, { ...data, action: undefined }) : undefined;
  }
  // Plain JSON with a type, event or action.
  const name = [o.type, o.event, o.action].find((v): v is string => typeof v === "string");
  return name ? named(name, o.data ?? o.payload, typeof o.id === "string" || typeof o.id === "number" ? String(o.id) : undefined) : undefined;
}

/** A reply to an earlier message: its reference, whether it worked, and the server's code if not. */
export function readReply(text: string): { ref: string; ok: boolean; errorCode?: string } | undefined {
  const io = /^43(\d+)(\[.*)$/s.exec(text);
  const json = parse(io ? io[2]! : text);
  if (io && Array.isArray(json)) {
    const first = json[0] as { error?: unknown } | undefined;
    return { ref: io[1]!, ok: !first?.error, ...code(first?.error) };
  }
  if (Array.isArray(json) && json.length === 5 && json[3] === "phx_reply") {
    const payload = json[4] as { status?: unknown; response?: { reason?: unknown; error?: unknown } } | undefined;
    return { ref: String(json[1]), ok: payload?.status === "ok", ...code(payload?.response?.reason ?? payload?.response?.error) };
  }
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const o = json as Record<string, unknown>;
    if (o.t === "d" && o.d && typeof o.d === "object") {
      const d = o.d as { r?: unknown; b?: { s?: unknown } };
      if (d.r === undefined || typeof d.b?.s !== "string") return undefined;
      return { ref: String(d.r), ok: d.b.s === "ok", ...code(d.b.s === "ok" ? undefined : d.b.s) };
    }
  }
  return undefined;
}

function named(name: string, data: unknown, ref?: string): { operation: string; ref?: string; data?: unknown } | undefined {
  if (!NAME.test(name)) return undefined;
  return { operation: name, ...(ref !== undefined ? { ref } : {}), ...(data !== undefined ? { data } : {}) };
}

function code(v: unknown): { errorCode?: string } {
  return typeof v === "string" && CODE.test(v) ? { errorCode: v } : {};
}

function parse(text: string): unknown {
  if (text.length > 64 * 1024) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
