import { afterEach, describe, expect, it } from "vitest";
import { controlLabel, isScreenDocument, snapshotPage } from "../src/page.ts";
import { isRouteWord, normalizeUrl } from "../src/url.ts";

afterEach(() => {
  document.body.innerHTML = "";
});
const path = (url: string) => normalizeUrl(url, "https://shop.test/")?.path;

describe("an account API's own routes are not someone's name", () => {
  it("keeps sign-in and recovery endpoints next to the records they sit beside", () => {
    expect(path("/users/login")).toBe("/users/login");
    expect(path("/users/forgot-password")).toBe("/users/forgot-password");
    expect(path("/users/sign_in")).toBe("/users/sign_in");
    expect(path("/accounts/verifyEmail")).toBe("/accounts/verifyEmail");
    expect(path("/users/me")).toBe("/users/me");
  });

  it("still hides a person's name or a record id after the same collections (trap)", () => {
    expect(path("/users/jane-smith")).toBe("/users/:id");
    expect(path("/users/janesmith")).toBe("/users/:id");
    expect(path("/users/42/reset-password")).toBe("/users/:id/reset-password");
    expect(path("/profiles/maria-lopez-garcia")).toBe("/profiles/:id");
    // Digits in it: an id or a handle, never a route word.
    expect(isRouteWord("login2")).toBe(false);
    expect(isRouteWord("jane-smith")).toBe(false);
  });
});

describe("a control's text reads as it does on screen", () => {
  it("keeps words in separate boxes apart and drops a list number standing in its own box", () => {
    document.body.innerHTML = `<button style="display:flex"><span>06</span><span>How do my invoices get in?</span></button>`;
    expect(controlLabel(document.querySelector("button")!)).toBe("How do my invoices get in?");
    document.body.innerHTML = `<button><div>Accounts</div><div>Account operations</div></button>`;
    expect(controlLabel(document.querySelector("button")!)).toBe("Accounts Account operations");
  });

  it("leaves inline words and a number that is part of the name alone (trap)", () => {
    document.body.innerHTML = `<button>Save <b>draft</b></button><a href="/plans" role="button">2 seats</a><button style="display:flex"><span>Step</span><span>3</span></button>`;
    expect(controlLabel(document.querySelector("button")!)).toBe("Save draft");
    expect(controlLabel(document.querySelector("a")!)).toBe("2 seats");
    expect(controlLabel(document.querySelectorAll("button")[1]!)).toBe("Step 3");
  });
});

describe("a page's headings are its own, not its list's", () => {
  const headings = () => snapshotPage(document, (u) => u).headings;

  it("leaves out the titles of items in a feed (a card's link, repeated list items)", () => {
    document.body.innerHTML = `
      <main>
        <div class="user-info"><h1>Profile</h1></div>
        <div class="article-preview"><a class="preview-link" href="/article/a"><h1>Mastering Knowledge with Self-Assessments</h1></a></div>
        <div class="article-preview"><a class="preview-link" href="/article/b"><h1>Discover Daily Routines</h1></a></div>
        <ul><li class="r"><h3>Result one</h3></li><li class="r"><h3>Result two</h3></li></ul>
      </main>`;
    expect(headings()).toEqual(["Profile"]);
  });

  it("keeps a lone article's heading and a page's own repeated sections (trap)", () => {
    document.body.innerHTML = `
      <main><article><h1>How we price</h1></article>
        <section class="feature"><h2>Automatic sync</h2></section><section class="feature"><h2>Reminders</h2></section></main>`;
    expect(headings()).toEqual(["How we price", "Automatic sync", "Reminders"]);
  });
});

describe("only an HTML document is a screen", () => {
  it("is false for a reply opened at its own address", () => {
    expect(isScreenDocument(document)).toBe(true);
    expect(isScreenDocument({ contentType: "application/json" } as Document)).toBe(false);
    expect(isScreenDocument({ contentType: "text/plain" } as Document)).toBe(false);
    expect(isScreenDocument({ contentType: "application/xhtml+xml" } as Document)).toBe(true);
  });
});
