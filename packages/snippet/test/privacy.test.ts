import { describe, expect, it } from "vitest";
import { parseBody } from "../src/body.ts";
import { describeFields, scrub, shapeOf } from "../src/redact.ts";
import { normalizeUrl, pathMatches } from "../src/url.ts";

const BASE = "https://app.example.com/dashboard";

describe("normalizeUrl", () => {
  it.each([
    ["/api/assessments/8812/publish?draft=1&token=abc", "/api/assessments/:id/publish", ["draft", "token"]],
    ["/api/users/3f2b1c9e-8a7d-4e6f-9b0a-1c2d3e4f5a6b", "/api/users/:id", []],
    ["/api/files/a1b2c3d4e5f6a7b8c9d0", "/api/files/:id", []],
    ["/api/users/jane%40uni.edu/profile", "/api/users/:id/profile", []],
    ["/api/courses/ck9x2m7q0000abcd1234/settings", "/api/courses/:id/settings", []],
    ["/api/assessment-settings-advanced", "/api/assessment-settings-advanced", []], // readable slugs survive
    ["/invoice/T-458aeccf", "/invoice/:id", []], // short prefixed record ids
    ["/invoices/INV-00231/pay", "/invoices/:id/pay", []],
    ["/api/rechnungen/RE-2026-001", "/api/rechnungen/:id", []],
    ["/reports/2026-11-03/print", "/reports/:id/print", []],
    ["/api/v2/items", "/api/v2/items", []],
    ["/orders/a1b2c3d4", "/orders/:id", []],
    ["/brief/session-NY%20AM", "/brief/:id", []], // free text a person chose
    ["/settings/two-factor", "/settings/two-factor", []],
    ["/reports/top-100", "/reports/top-100", []],
    ["/v2/checkout/step-3", "/v2/checkout/step-3", []],
  ])("%s", (input, path, queryKeys) => {
    expect(normalizeUrl(input, BASE)).toEqual({ origin: "https://app.example.com", path, queryKeys });
  });

  it("keeps readable names that mix case, and still masks tokens and ids", () => {
    // Words, camelCase and acronyms are the site's own folders and routes: never ids.
    for (const name of ["angularJs-protractor", "BankingProject", "myAccount_settingsOverview", "getting-started-with-the-API", "WebDriverExamples-forBeginners"]) {
      expect(normalizeUrl(`/${name}/home`, BASE)?.path).toBe(`/${name}/home`);
    }
    // Real ids, including letters-only reset and invite tokens that mix case at random.
    for (const id of ["3f2b1c9e-8a7d-4e6f-9b0a-1c2d3e4f5a6b", "cjld2cjxh0000qzrmn831i7rn", "INV-00231", "V1StGXR8_Z5jdHi6MB-mT", "QWxhZGRpbjpvcGVuIHNlc2FtZQ", "kQzRmTnXpLwYvBsDhJgF", "aBcDeFgHiJkLmNoPqR", "xKpqWmzRtvBnYcLd-QwZx"]) {
      expect(normalizeUrl(`/reset/${id}`, BASE)?.path).toBe("/reset/:id");
    }
  });

  it("a long readable slug under a collection is one item of content, not a page of the app", () => {
    // Articles and posts: their titles are content (and can be someone's own words).
    expect(normalizeUrl("/article/Discover-Bondar-Academy:-Your-Gateway-to-Efficient-Learning-1", BASE)?.path).toBe("/article/:id");
    expect(normalizeUrl("/blog/what-to-do-after-a-late-payment", BASE)?.path).toBe("/blog/:id");
    expect(normalizeUrl("/#/article/how_we_cut_our_build_times/comments", BASE)?.path).toBe("/#/article/:id/comments");
    // Traps: the app's own pages keep their names, short slugs under a folder, and any page at the top.
    for (const path of ["/about-us", "/terms-of-service", "/legal/terms-of-service", "/settings/two-factor-auth", "/help/how-to-reset-password", "/invoice-tracking-software", "/frequently-asked-questions-and-answers-page", "/blog/hello-world"]) {
      expect(normalizeUrl(path, BASE)?.path).toBe(path);
    }
  });

  it("drops path parameters after ';', so a session in the address is the same page", () => {
    expect(normalizeUrl("/bank/about.htm;jsessionid=204D87B0941952F9ADEE966D4743E0D5", BASE)?.path).toBe("/bank/about.htm");
    expect(normalizeUrl("/bank/about.htm", BASE)?.path).toBe("/bank/about.htm");
    expect(normalizeUrl("/products;sort=price;page=2/list", BASE)?.path).toBe("/products/list");
    expect(normalizeUrl("/;jsessionid=ABC", BASE)?.path).toBe("/");
    expect(normalizeUrl("/#/orders;filter=open/8812", BASE)?.path).toBe("/#/orders/:id");
    expect(JSON.stringify(normalizeUrl("/a;jsessionid=SECRET123/b", BASE))).not.toContain("SECRET");
    // An encoded ";" is part of the name, not a parameter.
    expect(normalizeUrl("/files/a%3Bb", BASE)?.path).toBe("/files/a;b");
  });

  it("never includes query values", () => {
    expect(JSON.stringify(normalizeUrl("/x?email=jane@uni.edu", BASE))).not.toContain("jane");
  });

  it("returns undefined for unparsable input", () => {
    expect(normalizeUrl("http://[bad", BASE)).toBeUndefined();
  });

  it("reads hash routes as pages, with ids masked, and never reads other hashes", () => {
    expect(normalizeUrl("/#/contacts/new", BASE)?.path).toBe("/#/contacts/new");
    expect(normalizeUrl("/#!/deals/8812?tab=notes", BASE)?.path).toBe("/#/deals/:id");
    expect(normalizeUrl("/app/#/contacts", BASE)?.path).toBe("/app/#/contacts");
    expect(normalizeUrl("/settings#billing", BASE)?.path).toBe("/settings");
    const token = normalizeUrl("/callback#access_token=secret-abc&state=1", BASE);
    expect(token?.path).toBe("/callback");
    expect(JSON.stringify(token)).not.toContain("secret");
  });
});

describe("pathMatches", () => {
  it("matches :param and * against normalised segments", () => {
    expect(pathMatches("/api/assessments/:assessmentId/publish", "/api/assessments/:id/publish")).toBe(true);
    expect(pathMatches("/api/*/publish", "/api/quizzes/publish")).toBe(true);
    expect(pathMatches("/api/assessments/:id", "/api/assessments/:id/publish")).toBe(false);
    expect(pathMatches("/api/assessments/:id", "/api/assessments/new")).toBe(false);
  });
});

describe("redaction", () => {
  it("scrubs emails, tokens, card and phone numbers", () => {
    const out = scrub("mail jane.doe@uni.edu, card 4111 1111 1111 1111, call +61 412 345 678, jwt eyJhbGc.eyJzdWIi.c2lnbmF0dXJl");
    expect(out).not.toMatch(/jane|4111|412 345|eyJ/);
  });

  it("describes shapes without values by default", () => {
    const fields = describeFields({ title: "Essay 1", rubric: "", wordLimit: 2000, settings: { aiAllowed: false, tags: [] } }, new Set());
    expect(fields).toEqual({
      title: { type: "string", empty: false, length: 7 },
      rubric: { type: "string", empty: true, length: 0 },
      wordLimit: { type: "number", empty: false },
      settings: { type: "object", empty: false, length: 2 },
      "settings.aiAllowed": { type: "boolean", empty: false },
      "settings.tags": { type: "array", empty: true, length: 0 },
    });
    expect(JSON.stringify(fields)).not.toContain("Essay");
  });

  it("includes scrubbed values only for allow-listed paths", () => {
    const fields = describeFields({ status: "draft by jane@uni.edu", wordLimit: 2000, secret: "x" }, new Set(["status", "wordLimit"]));
    expect(fields.status?.value).toBe("draft by [email]");
    expect(fields.wordLimit?.value).toBe(2000);
    expect(fields.secret?.value).toBeUndefined();
  });

  it("skips dangerous keys and caps depth", () => {
    const body = JSON.parse('{"__proto__": {"x": 1}, "a": {"b": {"c": {"d": 1}}}}');
    const fields = describeFields(body, new Set());
    expect(Object.keys(fields)).toEqual(["a", "a.b", "a.b.c"]);
  });

  it("describes batch inserts by their first item plus the batch size", () => {
    expect(describeFields([{ client: "Globex", due_date: null }, { client: "Acme" }], new Set())).toEqual({
      _items: { type: "array", empty: false, length: 2 },
      client: { type: "string", empty: false, length: 6 },
      due_date: { type: "null", empty: true },
    });
  });

  it("shapes files without reading them", () => {
    expect(shapeOf(new Blob(["abc"]))).toEqual({ type: "file", empty: false, length: 3 });
  });
});

describe("parseBody", () => {
  it("parses JSON, form-encoded and FormData; ignores streams/binary", () => {
    expect(parseBody('{"a":1}')).toEqual({ data: { a: 1 } });
    expect(parseBody("a=1&b=2")).toEqual({ data: { a: "1", b: "2" } });
    const fd = new FormData();
    fd.append("title", "x");
    expect(parseBody(fd).data).toEqual({ title: "x" });
    expect(parseBody(new ArrayBuffer(8))).toEqual({});
    expect(parseBody("{not json")).toEqual({});
  });

  it("extracts GraphQL operation names and uses variables as fields", () => {
    expect(parseBody(JSON.stringify({ query: "mutation PublishAssessment($id: ID!) { publish(id: $id) }", variables: { id: "1" } }))).toEqual({
      data: { id: "1" },
      graphqlOperation: "PublishAssessment",
    });
  });
});


describe("names in addresses", () => {
  it("masks people and organisations named in the address, not the app's own pages", () => {
    const path = (p: string) => normalizeUrl(p, "https://a.test")!.path;
    expect(path("/users/jane-smith")).toBe("/users/:id");
    expect(path("/org/acme-holdings/billing")).toBe("/org/:id/billing");
    expect(path("/@jane")).toBe("/:id");
    expect(path("/reset/AbCdEfGhIjKlMnOpQr")).toBe("/reset/:id");
    expect(path("/users/new")).toBe("/users/new");
    expect(path("/account/settings")).toBe("/account/settings");
    expect(path("/settings/billing")).toBe("/settings/billing");
    expect(path("/import/configure")).toBe("/import/configure");
  });
});
