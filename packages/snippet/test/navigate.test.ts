import { describe, expect, it } from "vitest";

describe("Take me there", () => {
  it("only goes to ordinary web pages on this site", async () => {
    const { sameSiteUrl } = await import("../src/index.ts");
    const w = window as Window & typeof globalThis;
    const here = w.location.origin;
    expect(sameSiteUrl(w, "/invoices")).toBe(`${here}/invoices`);
    for (const bad of ["javascript:alert(1)", " javascript:alert(1)", "data:text/html,x", "https://evil.test/x", "//evil.test/x"]) expect(sameSiteUrl(w, bad), bad).toBeUndefined();
  });
});
