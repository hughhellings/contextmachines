import type { Rule } from "@contextmachines/rules-core";
import { EventBatchSchema, type ActionPattern, type CapturedEvent, type EventBatch } from "@contextmachines/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init, type Handle } from "../src/index.ts";
import { installNetworkCapture, type RawRequest } from "../src/network.ts";
import { Transport } from "../src/transport.ts";

const ENDPOINT = "https://ingest.example.com/v1/events";
const KEY = "pk_test_fixturekey";

const siteModel: ActionPattern[] = [{ id: "assessment.publish", method: "POST", path: "/api/assessments/:id/publish" }];
const rubricRule: Rule = {
  id: "R4_rubric_required",
  version: 1,
  kind: "deterministic",
  bindsTo: { actions: ["assessment.publish"] },
  when: { op: "eq", left: { var: "fields.rubric.empty" }, right: { lit: true } },
  action: "block",
  message: "Add a rubric before publishing.",
  status: "approved",
};

let fakeFetch: ReturnType<typeof vi.fn>;
let originalFetch: typeof fetch;
let handle: Handle | undefined;

beforeEach(() => {
  originalFetch = window.fetch;
  fakeFetch = vi.fn(async () => new Response("{}", { status: 200 }));
  window.fetch = fakeFetch as unknown as typeof fetch;
  vi.spyOn(window.navigator, "sendBeacon").mockReturnValue(true);
});

afterEach(() => {
  handle?.shutdown();
  handle = undefined;
  window.fetch = originalFetch;
  vi.restoreAllMocks();
});

const sentBatches = (): EventBatch[] =>
  fakeFetch.mock.calls.filter(([url]) => String(url) === ENDPOINT).map(([, init]) => JSON.parse(String((init as RequestInit).body)) as EventBatch);

describe("fetch capture is transparent", () => {
  it("returns the original response and preserves arguments", async () => {
    const seen: RawRequest[] = [];
    const uninstall = installNetworkCapture(window, (r) => seen.push(r), () => false);
    const res = await window.fetch("/api/x", { method: "post", body: '{"a":1}' });
    expect(await res.text()).toBe("{}");
    expect(fakeFetch).toHaveBeenCalledWith("/api/x", { method: "post", body: '{"a":1}' });
    await Promise.resolve();
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/x", status: 200 });
    uninstall();
    expect(window.fetch).toBe(fakeFetch);
  });

  it("leaves streaming responses untouched (e.g. Supabase realtime, server-sent events)", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: one\n\n"));
        controller.enqueue(encoder.encode("data: two\n\n"));
        controller.close();
      },
    });
    fakeFetch.mockResolvedValueOnce(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const uninstall = installNetworkCapture(window, () => {}, () => false);
    const res = await window.fetch("/companion/stream", { method: "POST", body: "{}" });
    expect(res.bodyUsed).toBe(false);
    expect(await res.text()).toBe("data: one\n\ndata: two\n\n");
    uninstall();
  });

  it("propagates rejections unchanged", async () => {
    const error = new TypeError("offline");
    fakeFetch.mockRejectedValueOnce(error);
    const seen: RawRequest[] = [];
    const uninstall = installNetworkCapture(window, (r) => seen.push(r), () => false);
    await expect(window.fetch("/api/x")).rejects.toBe(error);
    await Promise.resolve();
    expect(seen[0]?.status).toBe(0);
    uninstall();
  });

  it("still works when our listener throws", async () => {
    const uninstall = installNetworkCapture(window, () => { throw new Error("bug in snippet"); }, () => false);
    const res = await window.fetch("/api/x");
    expect(res.status).toBe(200);
    uninstall();
  });
});

describe("XHR capture", () => {
  it("observes method, url, body and status without altering the request", () => {
    class FakeXHR extends EventTarget {
      status = 0;
      sent: unknown;
      open(_method: string, _url: string) {}
      send(body?: unknown) {
        this.sent = body;
        this.status = 201;
        this.dispatchEvent(new Event("loadend"));
      }
    }
    const fakeWin = { fetch: undefined, XMLHttpRequest: FakeXHR } as unknown as Window & typeof globalThis;
    const seen: RawRequest[] = [];
    const uninstall = installNetworkCapture(fakeWin, (r) => seen.push(r), () => false);
    const xhr = new FakeXHR();
    xhr.open("put", "/api/items/5");
    xhr.send('{"name":"x"}');
    expect(xhr.sent).toBe('{"name":"x"}');
    expect(seen[0]).toMatchObject({ method: "PUT", url: "/api/items/5", body: '{"name":"x"}', status: 201 });
    uninstall();
    expect(FakeXHR.prototype.open).not.toBe(undefined);
  });
});

describe("init end-to-end", () => {
  it("maps the request to an action, evaluates rules in shadow mode, and ships a valid, value-free batch", async () => {
    const outcomes: unknown[] = [];
    handle = init({ key: KEY, endpoint: ENDPOINT, siteModel, rules: [rubricRule], userRole: "lecturer", onOutcome: (o) => outcomes.push(o) });
    expect(handle.active).toBe(true);

    await window.fetch("/api/assessments/8812/publish", { method: "POST", body: JSON.stringify({ title: "Essay on Kant", rubric: "" }) });
    await Promise.resolve();
    await handle.flush();

    expect(outcomes).toEqual([expect.objectContaining({ ruleId: "R4_rubric_required", status: "violated", effectiveAction: "observe", source: "local" })]);

    const [batch] = sentBatches();
    expect(EventBatchSchema.safeParse(batch).success).toBe(true);
    const kinds = batch?.events.map((e: CapturedEvent) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["route", "network", "decision"]));
    expect(batch?.events.find((e) => e.kind === "network")).toMatchObject({ path: "/api/assessments/:id/publish", actionId: "assessment.publish" });
    // Without the clock readings and the random visit id, which can contain any digits by chance.
    const RANDOM = new Set(["t", "sentAt", "sessionId", "durationMs"]);
    expect(JSON.stringify(batch, (k, v) => (RANDOM.has(k) ? undefined : v))).not.toMatch(/Kant|8812/);
  });

  it("check() lets the host app block before sending, using the same redaction", () => {
    const outcomes: unknown[] = [];
    handle = init({ key: KEY, endpoint: ENDPOINT, mode: "live", ui: false, siteModel, rules: [rubricRule], onOutcome: (o) => outcomes.push(o) });
    expect(handle.check("assessment.publish", { rubric: "", title: "Secret title" })).toEqual([
      { ruleId: "R4_rubric_required", ruleVersion: 1, status: "violated", effectiveAction: "block", message: "Add a rubric before publishing.", source: "local" },
    ]);
    expect(handle.check("assessment.publish", { rubric: "Criteria…" })).toEqual([]);
    expect(outcomes).toHaveLength(1);
    expect(fakeFetch).not.toHaveBeenCalled(); // nothing sent to the site's API
  });

  it("does not evaluate the same action twice when check() is followed by the request", async () => {
    handle = init({ key: KEY, endpoint: ENDPOINT, mode: "live", ui: false, siteModel, rules: [rubricRule] });
    handle.check("assessment.publish", { rubric: "" });
    await window.fetch("/api/assessments/1/publish", { method: "POST", body: '{"rubric":""}' });
    await Promise.resolve();
    await window.fetch("/api/assessments/1/publish", { method: "POST", body: '{"rubric":""}' }); // a later, unchecked send is evaluated
    await Promise.resolve();
    await handle.flush();
    const decisions = sentBatches().flatMap((b) => b.events).filter((e) => e.kind === "decision");
    expect(decisions).toHaveLength(2);
  });

  it("shows the on-screen prompt for live violations and records feedback", async () => {
    handle = init({ key: KEY, endpoint: ENDPOINT, mode: "live", siteModel, rules: [{ ...rubricRule, action: "nudge" }] });
    handle.check("assessment.publish", { rubric: "" });
    const host = document.querySelector("[data-ctx-prompt]") as HTMLElement;
    const card = host.shadowRoot?.querySelector(".card") as HTMLElement;
    expect(card.querySelector(".title")?.textContent).toBe("Add a rubric before publishing.");
    ([...card.querySelectorAll("button")].find((b) => b.textContent === "Got it") as HTMLButtonElement).click();
    await handle.flush();
    const feedback = sentBatches().flatMap((b) => b.events).filter((e) => e.kind === "feedback");
    expect(feedback).toEqual([expect.objectContaining({ kind: "feedback", ruleId: "R4_rubric_required", value: "helpful" })]);
  });

  it("loads mode, site model and rules from the config endpoint", async () => {
    fakeFetch.mockImplementation(async (url: string) =>
      String(url).startsWith("https://ingest.example.com/v1/config")
        ? new Response(JSON.stringify({ v: 1, mode: "live", siteModel, rules: [rubricRule], allowValues: [] }), { status: 200 })
        : new Response("{}", { status: 200 }),
    );
    handle = init({ key: KEY, endpoint: ENDPOINT, ui: false, configEndpoint: "https://ingest.example.com/v1/config" });
    expect(handle.check("assessment.publish", { rubric: "" })).toEqual([]); // nothing until config arrives
    await vi.waitFor(() => expect(handle?.check("assessment.publish", { rubric: "" })[0]?.effectiveAction).toBe("block"));
    expect(String(fakeFetch.mock.calls[0]?.[0])).toBe(`https://ingest.example.com/v1/config?key=${KEY}`);
  });

  it("never observes its own transport calls", async () => {
    handle = init({ key: KEY, endpoint: ENDPOINT });
    await window.fetch("/api/ping");
    await Promise.resolve();
    await handle.flush();
    await handle.flush();
    const paths = sentBatches().flatMap((b) => b.events).filter((e) => e.kind === "network").map((e) => (e.kind === "network" ? e.path : ""));
    expect(paths).toEqual(["/api/ping"]);
  });

  it("contains errors thrown by the site's onOutcome callback", async () => {
    handle = init({ key: KEY, endpoint: ENDPOINT, siteModel, rules: [rubricRule], onOutcome: () => { throw new Error("site bug"); } });
    const res = await window.fetch("/api/assessments/1/publish", { method: "POST", body: '{"rubric":""}' });
    expect(res.status).toBe(200);
  });

  it("is idempotent and restores the page on shutdown", () => {
    handle = init({ key: KEY, endpoint: ENDPOINT });
    expect(init({ key: KEY, endpoint: ENDPOINT })).toBe(handle);
    expect(window.fetch).not.toBe(fakeFetch);
    handle.shutdown();
    expect(window.fetch).toBe(fakeFetch);
  });

  it("does nothing when disabled, sampled out, or given a secret key", () => {
    expect(init({ key: KEY, endpoint: ENDPOINT, enabled: false }).active).toBe(false);
    expect(init({ key: KEY, endpoint: ENDPOINT, sampleRate: 0 }).active).toBe(false);
    expect(init({ key: "sk_live_secret", endpoint: ENDPOINT }).active).toBe(false);
    expect(window.fetch).toBe(fakeFetch);
  });

  it("returns an inactive handle instead of throwing on bad config", () => {
    expect(init({ key: KEY, endpoint: "http://[bad" }).active).toBe(false);
  });
});

describe("Transport", () => {
  const event = (t: number): CapturedEvent => ({ t, kind: "route", path: "/" });

  it("caps memory by dropping the oldest events and reports the count", async () => {
    const send = vi.fn(async () => new Response(null, { status: 202 }));
    const transport = new Transport({ endpoint: ENDPOINT, key: KEY, sessionId: "sess_12345678", fetch: send, maxBatch: 100, maxQueue: 3, setTimer: () => 1, clearTimer: () => {} });
    for (let t = 0; t < 5; t++) transport.push(event(t));
    await transport.flush();
    const body = JSON.parse(String((send.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as EventBatch;
    expect(body.events.map((e) => e.t)).toEqual([2, 3, 4]);
    expect(body.dropped).toBe(2);
  });

  it("requeues on server errors and network failures, not on client errors", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response(null, { status: 400 }));
    const transport = new Transport({ endpoint: ENDPOINT, key: KEY, sessionId: "sess_12345678", fetch: send, setTimer: () => 1, clearTimer: () => {} });
    transport.push(event(1));
    await transport.flush();
    expect(transport.pending).toBe(1);
    await transport.flush();
    expect(transport.pending).toBe(1);
    await transport.flush();
    expect(transport.pending).toBe(0);
  });
});

describe("failure reasons", () => {
  it("reads which field a failed reply blames, in the common shapes, never a value", async () => {
    const { readReply } = await import("../src/network.ts");
    expect(readReply(422, { error: { code: "INVALID_KEY", field: "key", message: "Key must be 2-5 capital letters" } })).toEqual({ errorCode: "INVALID_KEY", errorField: "key" });
    expect(readReply(400, { error: { type: "card_error", param: "exp_month" } }).errorField).toBe("exp_month"); // Stripe
    expect(readReply(422, { detail: "x", errors: [{ loc: ["body", "postcode"], msg: "bad" }] }).errorField).toBe("postcode"); // FastAPI
    expect(readReply(400, { errors: [{ path: ["billing", "email"], message: "Invalid email" }] }).errorField).toBe("email"); // Zod
    expect(readReply(422, { errors: { website: ["is not a valid URL"] } }).errorField).toBe("website"); // Rails
    expect(readReply(404, { path: "/api/projects/9", error: "Not Found" }).errorField).toBeUndefined(); // an address, not a field
    expect(readReply(422, { error: { field: "Jane's email jane@x.test" } }).errorField).toBeUndefined();
    expect(readReply(200, { field: "key" }).errorField).toBeUndefined();
  });

  it("keeps only machine codes from replies, never messages", async () => {
    const { failureOf } = await import("../src/network.ts");
    expect(failureOf({ errors: [{ message: "CARD_DECLINED" }], data: null })).toEqual({ appFailed: true, errorCode: "CARD_DECLINED" });
    expect(failureOf({ errors: [{ message: "Card for jane@example.com was declined", extensions: { code: "card_declined" } }] })).toEqual({ appFailed: true, errorCode: "card_declined" });
    expect(failureOf({ errors: [{ message: "Jane Doe's card was declined" }] })).toEqual({ appFailed: true });
    expect(failureOf({ error: "payments_not_connected" })).toEqual({ errorCode: "payments_not_connected" });
    expect(failureOf({ error: { code: "RATE_LIMITED", message: "Try again at 10:42" } })).toEqual({ errorCode: "RATE_LIMITED" });
    expect(failureOf({ error: "user 12345 not found" })).toEqual({});
    expect(failureOf({ data: { ok: true } })).toEqual({});
  });
});

describe("plans", () => {
  const event = (t: number): CapturedEvent => ({ t, kind: "route", path: "/x" });
  it("sends the user's plan with each batch, and drops anything that isn't a short code", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const transport = new Transport({ endpoint: ENDPOINT, key: KEY, sessionId: "sess_12345678", fetch: send, setTimer: () => 1, clearTimer: () => {} });
    const body = (i: number) => JSON.parse(String((send.mock.calls[i] as unknown as [string, RequestInit])[1].body)) as EventBatch;
    transport.identify("u1", "pro", "admin");
    transport.push(event(1));
    await transport.flush();
    expect(body(0)).toMatchObject({ plan: "pro", role: "admin" });
    transport.identify("u1", "Pro plan for jane@example.com");
    transport.push(event(2));
    await transport.flush();
    expect(body(1).plan).toBeUndefined();
  });

  it("sends the page's language as two letters", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const transport = new Transport({ endpoint: ENDPOINT, key: KEY, sessionId: "sess_12345678", fetch: send, lang: () => "fr-CA", setTimer: () => 1, clearTimer: () => {} });
    transport.push(event(1));
    await transport.flush();
    expect((JSON.parse(String((send.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as EventBatch).lang).toBe("fr");
  });
});

describe("reading replies", () => {
  it("stops reading a long streamed reply instead of buffering it", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(16 * 1024).fill(32));
        if (pulled > 1000) controller.close();
      },
    });
    const { installNetworkCapture } = await import("../src/network.ts");
    const seen: unknown[] = [];
    const win = { fetch: async () => new Response(stream, { status: 200, headers: { "content-type": "application/json" } }) } as unknown as Window & typeof globalThis;
    const undo = installNetworkCapture(win, (r) => seen.push(r), () => false);
    await win.fetch("https://a.test/stream");
    await new Promise((r) => setTimeout(r, 50));
    undo();
    expect(seen).toHaveLength(1);
    expect(pulled).toBeLessThan(20); // 64 KB read, then cancelled
  });
});

describe("actions that share an address", () => {
  it("reads tRPC's error code, alone or in a batch", async () => {
    const { failureOf } = await import("../src/network.ts");
    expect(failureOf({ error: { json: { message: "Name too short", code: -32600, data: { code: "BAD_REQUEST" } } } })).toEqual({ errorCode: "BAD_REQUEST" });
    expect(failureOf([{ result: { data: {} } }, { error: { json: { data: { code: "UNAUTHORIZED" } } } }])).toEqual({ errorCode: "UNAUTHORIZED" });
  });

  it("tells a Next.js server action apart by its Next-Action header, never sending more than a short id", async () => {
    const { installNetworkCapture } = await import("../src/network.ts");
    const seen: { nextAction?: string }[] = [];
    const win = { fetch: async () => new Response("0:{}", { status: 200, headers: { "content-type": "text/x-component" } }) } as unknown as Window & typeof globalThis;
    const undo = installNetworkCapture(win, (r) => seen.push(r), () => false);
    await win.fetch("https://a.test/invoices", { method: "POST", headers: { "Next-Action": "7f3a9c21d0e4b5a6c7d8e9f0a1b2c3d4e5f6a7b8" }, body: "[]" });
    await win.fetch("https://a.test/invoices", { method: "POST", headers: { "Next-Action": "not a hash" }, body: "[]" });
    await new Promise((r) => setTimeout(r, 20));
    undo();
    expect(seen.map((r) => r.nextAction)).toEqual(["7f3a9c21d0e4b5a6", undefined]);
  });
});

describe("framework page prefetches", () => {
  it("aren't actions: Next.js's RSC and prefetch fetches are page plumbing", async () => {
    const { isPagePrefetch } = await import("../src/network.ts");
    expect(isPagePrefetch("/pricing", { headers: { RSC: "1", "Next-Router-Prefetch": "1" } })).toBe(true);
    expect(isPagePrefetch("/pricing?_rsc=abc12")).toBe(true);
    expect(isPagePrefetch("/api/invoices", { method: "POST", headers: { "content-type": "application/json" } })).toBe(false);
  });
});
