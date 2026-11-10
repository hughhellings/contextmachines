/**
 * Best-effort, synchronous, non-consuming body parsing. Streams and binary
 * bodies are never read: we must not change what the host page sends.
 */
export interface ParsedBody {
  data?: unknown;
  graphqlOperation?: string;
}

const MAX_BODY_CHARS = 256 * 1024;
const GRAPHQL_OP = /^\s*(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/;

export function parseBody(body: unknown): ParsedBody {
  if (body === undefined || body === null) return {};

  if (typeof body === "string") {
    if (body.length > MAX_BODY_CHARS) return {};
    const trimmed = body.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return withGraphql(JSON.parse(body));
      } catch {
        return {};
      }
    }
    if (body.includes("=")) return { data: Object.fromEntries(new URLSearchParams(body)) };
    return {};
  }
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return { data: Object.fromEntries(body) };
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const data: Record<string, unknown> = {};
    body.forEach((value, key) => {
      data[key] = value;
    });
    return { data };
  }
  return {};
}

function withGraphql(json: unknown): ParsedBody {
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const obj = json as Record<string, unknown>;
    if (typeof obj.query === "string") {
      const name = typeof obj.operationName === "string" ? obj.operationName : GRAPHQL_OP.exec(obj.query)?.[1];
      // For GraphQL the meaningful fields are the variables, not the query text.
      const result: ParsedBody = { data: obj.variables ?? {} };
      if (name) result.graphqlOperation = name;
      return result;
    }
  }
  return { data: json };
}

/**
 * A form's intent ("intent" or "_action" field, as Remix and many apps use to share one address):
 * a word the developer chose, so it is read when it looks like one ("delete", "archive-all").
 * `buttons`, for a learner only: also the button-named fields of forms whose buttons share one
 * address ("action=INIT" or "action=CLEAN" from two buttons of one form).
 */
export const INTENT = /^[a-z][a-z0-9_-]{0,39}$/i;
const BUTTON_FIELD = ["action", "op", "operation", "cmd", "command", "do"];

export function intentOf(data: unknown, buttons = false): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;
  const v = d.intent ?? d._action ?? (buttons ? BUTTON_FIELD.map((k) => d[k]).find((x) => x !== undefined) : undefined);
  return typeof v === "string" && INTENT.test(v) ? `intent:${v.toLowerCase()}` : undefined;
}

/**
 * Firestore's web SDK writes through ordinary requests to .../google.firestore.v1.Firestore/Write/channel,
 * form-encoded, with the writes as JSON. The collection and kind of write name the action
 * ("update tasks"); the document's fields give the data (shapes only, like any request).
 */
export function firestoreWrite(path: string, body: unknown): { collection: string; operation: string; data: Record<string, unknown> } | undefined {
  if (!/google\.firestore\.v1\.Firestore\/Write\/channel/.test(path) || typeof body !== "string" || body.length > MAX_BODY_CHARS) return undefined;
  for (const [key, value] of new URLSearchParams(body)) {
    if (!/^req\d+___data__$/.test(key)) continue;
    let json: { writes?: { update?: { name?: string; fields?: Record<string, Record<string, unknown>> }; delete?: string }[] };
    try {
      json = JSON.parse(value);
    } catch {
      continue;
    }
    const write = json.writes?.[0];
    const name = write?.update?.name ?? write?.delete;
    const collection = name?.split("/documents/")[1]?.split("/")[0];
    if (!write || !collection || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(collection)) continue;
    // Firestore wraps each value in its type ({ stringValue: "x" }): unwrap so the shape is the value's.
    const data = Object.fromEntries(Object.entries(write.update?.fields ?? {}).map(([k, v]) => [k, Object.values(v ?? {})[0]]));
    return { collection, operation: `${write.update ? "update" : "delete"} ${collection}`, data };
  }
  return undefined;
}
