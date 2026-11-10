import nodeConsole from "node:console";
import { describe, expect, it } from "vitest";
import { isFrameNotice } from "./quiet-frames.ts";

describe("the test output stays clean without hiding real errors", () => {
  it("leaves out happy-dom's notice that a frame's page isn't loaded, as happy-dom writes it", () => {
    const seen: unknown[][] = [];
    const quiet = nodeConsole.error;
    // What happy-dom hands the console when a test writes an <iframe src>.
    nodeConsole.error = (...args: unknown[]) => void seen.push(args);
    document.body.innerHTML = `<iframe src="https://frames.example/pay"></iframe>`;
    nodeConsole.error = quiet;
    expect(seen).toHaveLength(1);
    expect(isFrameNotice(seen[0]!)).toBe(true);
  });

  it("keeps every other error (trap: no wider filter)", () => {
    expect(isFrameNotice([new Error("Failed to load iframe page \"x\". Iframe page loading is disabled.")])).toBe(false); // not happy-dom's kind
    expect(isFrameNotice([new DOMException("Failed to load script \"x\".", "NotSupportedError")])).toBe(false);
    expect(isFrameNotice(["Failed to load iframe page \"x\". Iframe page loading is disabled."])).toBe(false); // a string anyone could log
    expect(isFrameNotice([new DOMException("Failed to load iframe page \"x\". Iframe page loading is disabled.", "NotSupportedError"), "more"])).toBe(false);
  });

  it("the snippet sees the test browser's localStorage, not Node's own (which warns with no file behind it)", () => {
    expect(process.execArgv).toContain("--no-experimental-webstorage");
    window.localStorage.setItem("k", "v");
    expect(window.localStorage.getItem("k")).toBe("v");
    window.localStorage.removeItem("k");
  });
});
