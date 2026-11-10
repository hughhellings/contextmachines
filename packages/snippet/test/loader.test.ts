import { describe, expect, it, vi } from "vitest";

describe("the loader", () => {
  it("runs calls queued before load, and ones pushed onto the queue after it (sign-in happens later)", async () => {
    const identify = vi.fn();
    vi.doMock("../src/index.ts", () => ({ init: () => ({ identify, shutdown() {} }) }));
    const w = window as unknown as { __ctx?: { q: unknown[] } };
    w.__ctx = { q: [["init", { key: "pk_live_abcdefgh", endpoint: "/e" }], ["identify", "u_early"]] };
    await import("../src/browser.ts");
    expect(identify).toHaveBeenCalledWith("u_early", undefined, undefined, undefined);
    w.__ctx!.q.push(["identify", "u_later", "member"]);
    expect(identify).toHaveBeenLastCalledWith("u_later", "member", undefined, undefined);
    vi.doUnmock("../src/index.ts");
  });
});

