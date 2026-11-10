import { describe, expect, it } from "vitest";
import { firestoreWrite } from "../src/body.ts";
import { readMessage, readReply } from "../src/socket.ts";

describe("live connections", () => {
  it("reads the action from each protocol, and its reference for the reply", () => {
    expect(readMessage(JSON.stringify(["4", "17", "lv:phx-1", "event", { type: "click", event: "publish", value: { id: "1" } }]))).toEqual({ operation: "publish", ref: "17", data: { id: "1" } });
    expect(readMessage(JSON.stringify(["4", "18", "lv:phx-1", "event", { type: "form", event: "save", value: "title=Hello&body=x" }]))).toEqual({ operation: "save", ref: "18", data: { title: "Hello", body: "x" } });
    expect(readMessage(JSON.stringify({ command: "message", identifier: "{}", data: JSON.stringify({ action: "speak", message: "hi" }) }))?.operation).toBe("speak");
    expect(readMessage(`421["create_task",{"title":"x"}]`)).toEqual({ operation: "create_task", ref: "1", data: { title: "x" } });
    expect(readMessage(JSON.stringify({ t: "d", d: { r: 5, a: "p", b: { p: "/tasks/abc", d: { title: "x" } } } }))).toEqual({ operation: "set tasks", ref: "5", data: { title: "x" } });
    expect(readMessage(JSON.stringify({ type: "add_comment", payload: { text: "x" } }))?.operation).toBe("add_comment");
  });

  it("reads the protocols whose verb sits somewhere else: DDP, JSON-RPC, Socket.IO namespaces and binary events", () => {
    expect(readMessage(JSON.stringify({ msg: "method", method: "invoices.remove", params: [{ _id: "7" }], id: "3" }))).toEqual({ operation: "invoices.remove", ref: "3", data: { _id: "7" } });
    expect(readMessage(JSON.stringify({ jsonrpc: "2.0", method: "invoice.delete", params: [7], id: 1 }))).toEqual({ operation: "invoice.delete", ref: "1", data: 7 });
    expect(readMessage(JSON.stringify({ method: "invoice.update", params: { id: 7 }, id: 2 }))?.operation).toBe("invoice.update");
    expect(readMessage(`451-["deleteInvoice",{"_placeholder":true,"num":0}]`)?.operation).toBe("deleteInvoice");
    expect(readMessage(`42/admin,7["create_task",{"title":"x"}]`)).toEqual({ operation: "create_task", ref: "7", data: { title: "x" } });
  });

  it("never reads a DDP connection's upkeep or reads as actions", () => {
    for (const msg of [{ msg: "connect", version: "1" }, { msg: "ping" }, { msg: "sub", id: "a", name: "invoices", params: [] }]) expect(readMessage(JSON.stringify(msg))).toBeUndefined();
  });

  it("ignores what isn't a named action: free text, binary-looking data, odd names", () => {
    expect(readMessage("hello there")).toBeUndefined();
    expect(readMessage(JSON.stringify({ type: "Jane Doe's draft" }))).toBeUndefined();
    expect(readMessage(JSON.stringify({ t: "d", d: { r: 1, a: "q", b: { p: "/tasks" } } }))).toBeUndefined(); // a read
  });

  it("reads whether the server refused it, and its code", () => {
    expect(readReply(JSON.stringify(["4", "17", "lv:phx-1", "phx_reply", { status: "error", response: { reason: "missing_title" } }]))).toEqual({ ref: "17", ok: false, errorCode: "missing_title" });
    expect(readReply(JSON.stringify(["4", "18", "lv:phx-1", "phx_reply", { status: "ok", response: {} }]))).toEqual({ ref: "18", ok: true });
    expect(readReply(JSON.stringify({ t: "d", d: { r: 5, b: { s: "permission_denied", d: "Permission denied" } } }))).toEqual({ ref: "5", ok: false, errorCode: "permission_denied" });
  });
});

describe("Firestore", () => {
  it("reads the collection and kind of write, and the fields' shapes (not Firestore's wrapping)", () => {
    const body = new URLSearchParams({ count: "1", req0___data__: JSON.stringify({ writes: [{ update: { name: "projects/p/databases/(default)/documents/tasks/abc123", fields: { title: { stringValue: "Call bank" }, done: { booleanValue: false } } } }] }) }).toString();
    expect(firestoreWrite("/google.firestore.v1.Firestore/Write/channel", body)).toEqual({ collection: "tasks", operation: "update tasks", data: { title: "Call bank", done: false } });
    expect(firestoreWrite("/api/tasks", body)).toBeUndefined();
  });
});
