import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventBatch } from "@contextmachines/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init, type Handle } from "../src/index.ts";
import { describe as summarise } from "../src/inspect.ts";
import { snapshotPage } from "../src/page.ts";

const ENDPOINT = "https://ingest.example.com/v1/events";
const KEY = "pk_test_fixturekey";

let fakeFetch: ReturnType<typeof vi.fn>;
let originalFetch: typeof fetch;
let beacon: ReturnType<typeof vi.fn>;
let handle: Handle | undefined;

beforeEach(() => {
  originalFetch = window.fetch;
  fakeFetch = vi.fn(async () => new Response("{}", { status: 200 }));
  window.fetch = fakeFetch as unknown as typeof fetch;
  beacon = vi.spyOn(window.navigator, "sendBeacon").mockReturnValue(true) as unknown as ReturnType<typeof vi.fn>;
  document.body.innerHTML = `<button id="save">Save draft</button>`;
});

afterEach(() => {
  handle?.shutdown();
  handle = undefined;
  window.fetch = originalFetch;
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

const panel = () => document.querySelector("[data-ctx-inspect]")?.shadowRoot ?? null;
const entries = () => [...(panel()?.querySelectorAll(".item") ?? [])].reverse(); // the panel lists newest first
const button = (label: string) => [...(panel()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === label) as HTMLButtonElement;
/** Bodies the snippet handed to fetch for the ingest endpoint, in order. */
const sentBodies = () => fakeFetch.mock.calls.filter(([url]) => String(url) === ENDPOINT).map(([, init]) => String((init as RequestInit).body));
const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("inspector", () => {
  it("is off by default", async () => {
    handle = init({ key: KEY, endpoint: ENDPOINT, ui: false });
    document.getElementById("save")?.click();
    await handle.flush();
    expect(sentBodies()).toHaveLength(1);
    expect(document.querySelector("[data-ctx-inspect]")).toBeNull();
  });

  it("turns on with ?ctx-inspect in the address, and inspect: false overrides it", () => {
    window.history.replaceState(null, "", "/editor?ctx-inspect");
    handle = init({ key: KEY, endpoint: ENDPOINT, ui: false });
    expect(panel()?.textContent).toContain("everything this page sends");
    handle.shutdown();
    expect(document.querySelector("[data-ctx-inspect]")).toBeNull();

    handle = init({ key: KEY, endpoint: ENDPOINT, ui: false, inspect: false });
    expect(document.querySelector("[data-ctx-inspect]")).toBeNull();
  });

  it("turns on with inspect: true", () => {
    handle = init({ key: KEY, endpoint: ENDPOINT, ui: false, inspect: true });
    expect(panel()).not.toBeNull();
  });

  it("shows exactly the bodies sent, with their size, a summary and a running total", async () => {
    handle = init({ key: KEY, endpoint: ENDPOINT, ui: false, inspect: true });
    document.getElementById("save")?.click();
    document.getElementById("save")?.click();
    await window.fetch("/api/drafts", { method: "POST", body: '{"title":"My secret plan"}' });
    await Promise.resolve();
    await handle.flush();
    document.getElementById("save")?.click();
    await handle.flush();

    const sent = sentBodies();
    expect(sent).toHaveLength(2);
    const shown = entries();
    expect(shown).toHaveLength(2);
    shown.forEach((item, i) => {
      const body = sent[i] as string;
      // The pretty-printed JSON is the sent body, and nothing else.
      expect(JSON.parse(item.querySelector("pre")?.textContent ?? "")).toEqual(JSON.parse(body));
      expect(item.querySelector(".meta")?.textContent).toContain(`POST · ${bytes(body).toLocaleString("en-US")} bytes`);
      expect(item.querySelector(".url")?.textContent).toBe(ENDPOINT);
    });
    // Flushing sends the page's snapshot too, though the page hadn't settled yet.
    expect(shown[0]?.querySelector(".what")?.textContent).toBe("1 page view, 2 clicks, 1 request (shape only), 1 page snapshot");
    expect(shown[1]?.querySelector(".what")?.textContent).toMatch(/^1 click\b/); // the third quick click may also count as a struggle
    // The request's typed value is never sent, so it is never shown either.
    expect(panel()?.textContent).not.toContain("My secret plan");
    const total = sent.reduce((n, b) => n + bytes(b), 0);
    expect(panel()?.querySelector(".total")?.textContent).toBe(`2 requests sent, ${total.toLocaleString("en-US")} bytes in total`);
  });

  it("copies every body byte for byte", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    handle = init({ key: KEY, endpoint: ENDPOINT, ui: false, inspect: true });
    document.getElementById("save")?.click();
    await handle.flush();
    button("Copy all").click();
    const copied = String(writeText.mock.calls[0]?.[0]);
    expect(copied).toContain(`\n${sentBodies()[0]}\n`);
    await vi.waitFor(() => expect(panel()?.textContent).toContain("Copied 1 request"));
  });

  it("shows what sendBeacon sends as the page closes", async () => {
    handle = init({ key: KEY, endpoint: ENDPOINT, ui: false, inspect: true });
    document.getElementById("save")?.click();
    window.dispatchEvent(new Event("pagehide"));
    expect(beacon).toHaveBeenCalledTimes(1);
    const body = await (beacon.mock.calls[0]?.[1] as Blob).text();
    await vi.waitFor(() => expect(entries()).toHaveLength(1));
    const item = entries()[0] as Element;
    expect(item.querySelector("pre")?.textContent).toBe(JSON.stringify(JSON.parse(body), null, 2));
    expect(item.querySelector(".meta")?.textContent).toContain("sendBeacon");
    expect(item.querySelector(".what")?.textContent).toBe("1 page view, 1 click (sent as the page was hidden or closed)");
  });

  it("does not show a beacon the browser refused, since nothing was sent", async () => {
    beacon.mockReturnValue(false);
    handle = init({ key: KEY, endpoint: ENDPOINT, ui: false, inspect: true });
    document.getElementById("save")?.click();
    window.dispatchEvent(new Event("pagehide"));
    await new Promise((r) => setTimeout(r, 0));
    expect(entries()).toHaveLength(0);
  });

  it("shows the settings fetch too", async () => {
    handle = init({ key: KEY, endpoint: ENDPOINT, ui: false, inspect: true, configEndpoint: "https://ingest.example.com/v1/config" });
    const item = entries()[0] as Element;
    expect(item.querySelector(".meta")?.textContent).toContain("GET · 0 bytes");
    expect(item.querySelector(".url")?.textContent).toBe(`https://ingest.example.com/v1/config?key=${KEY}`);
  });

  it("is never captured: its clicks, its buttons and its text stay out of what is sent", async () => {
    handle = init({ key: KEY, endpoint: ENDPOINT, ui: false, inspect: true });
    document.getElementById("save")?.click();
    await handle.flush();
    button("Hide").click();
    button("Show").click();
    (panel()?.querySelector("summary") as HTMLElement).click();
    await handle.flush();
    const events = sentBodies().flatMap((b) => (JSON.parse(b) as EventBatch).events);
    expect(events.filter((e) => e.kind === "interaction")).toHaveLength(1); // only "Save draft"
    const snapshot = snapshotPage(document, (u) => u);
    expect(snapshot.buttons.map((b) => b.label)).toEqual(["Save draft"]);
    expect(JSON.stringify(snapshot)).not.toContain("everything this page sends");
  });

  it("renders text only, never markup", async () => {
    document.body.innerHTML = `<button id="save" aria-label="<img src=x onerror=alert(1)>">x</button>`;
    handle = init({ key: KEY, endpoint: ENDPOINT, ui: false, inspect: true });
    document.getElementById("save")?.click();
    await handle.flush();
    expect(panel()?.querySelector("img")).toBeNull();
    expect(panel()?.querySelector("pre")?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(readFileSync(join(import.meta.dirname, "../src/inspect.ts"), "utf8")).not.toMatch(/\.(innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write/);
  });

  it("summarises a batch in plain English", () => {
    const batch = { events: [...Array(4).fill({ kind: "interaction", type: "click" }), { kind: "network" }, { kind: "network" }, { kind: "page" }] };
    expect(summarise({ method: "POST", url: ENDPOINT, via: "fetch", body: JSON.stringify(batch) })).toBe("4 clicks, 2 requests (shapes only), 1 page snapshot");
  });
});
