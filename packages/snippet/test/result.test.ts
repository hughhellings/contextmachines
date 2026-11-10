import { describe, expect, it } from "vitest";
import { readReply } from "../src/network.ts";
import { describeResult } from "../src/redact.ts";

describe("reply shapes", () => {
  it("describes what came back as shapes only: no values, no string lengths, no keys that are data", () => {
    const shape = describeResult({ id: "T-458aeccf", name: "Jane Doe", total: 120.5, tags: ["a", "b"], owner: { email: "jane@example.com" }, byDate: { "2026-11-02": 3 }, deep: { a: { b: 1 } } });
    expect(shape).toEqual({
      id: { type: "string", empty: false },
      name: { type: "string", empty: false },
      total: { type: "number", empty: false },
      tags: { type: "array", empty: false, length: 2 },
      owner: { type: "object", empty: false },
      "owner.email": { type: "string", empty: false },
      byDate: { type: "object", empty: false },
      deep: { type: "object", empty: false },
      "deep.a": { type: "object", empty: false },
    });
    expect(JSON.stringify(shape)).not.toMatch(/Jane|example|458aeccf|120/);
  });

  it("describes a list by its size and first item, so an empty search shows up", () => {
    expect(describeResult([])).toEqual({ _items: { type: "array", empty: true, length: 0 } });
    expect(describeResult([{ id: 1 }, { id: 2 }])).toEqual({ _items: { type: "array", empty: false, length: 2 }, id: { type: "number", empty: false } });
  });

  it("gives a result only for replies that worked; failures keep just their code", () => {
    expect(readReply(201, { id: "x" })).toEqual({ result: { id: { type: "string", empty: false } } });
    expect(readReply(400, { error: "MARKET_CLOSED", detail: "x" })).toEqual({ errorCode: "MARKET_CLOSED" });
    expect(readReply(200, { errors: [{ message: "CARD_DECLINED" }], data: null })).toEqual({ appFailed: true, errorCode: "CARD_DECLINED" });
    expect(readReply(200, "ok")).toEqual({});
  });
});

import { describeFields } from "../src/redact.ts";

describe("secret fields", () => {
  it("never send a password's length, nor its value even if allow-listed", () => {
    const out = describeFields({ email: "a@b.test", password: "hunter22", user: { newPassword: "x" }, pin: "1234", name: "Jo" }, new Set(["password", "pin", "name"]));
    expect(out.password).toEqual({ type: "string", empty: false });
    expect(out["user.newPassword"]).toEqual({ type: "string", empty: false });
    expect(out.pin).toEqual({ type: "string", empty: false });
    expect(out.name).toMatchObject({ value: "Jo", length: 2 });
  });
});
