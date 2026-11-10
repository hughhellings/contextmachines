import { describe, expect, it } from "vitest";
import { pathName, screenName, screenNames, type NamedScreen } from "../src/learn/screen-names.ts";

const names = (screens: NamedScreen[]) => Object.fromEntries(screenNames(screens));

describe("screen names", () => {
  it("a title every screen shares is the site's name: screens go by their own heading, else their address", () => {
    // A site whose <title> is the same everywhere, with headings on only some pages.
    const screens = [
      { path: "/", title: "demosite", headings: [] },
      { path: "/alertsWindows", title: "demosite", headings: [] },
      { path: "/webtables", title: "demosite", headings: ["Web Tables"] },
      { path: "/basic_auth", title: "demosite", headings: [] },
    ];
    expect(names(screens)).toEqual({ "/": "demosite", "/alertsWindows": "Alerts windows", "/webtables": "Web Tables", "/basic_auth": "Basic auth" });
  });

  it("a heading repeated on every screen (the app's name) leaves the start screen its name and the others their route", () => {
    const screens = [
      { path: "/todomvc/#/", title: "React • TodoMVC", headings: ["todos"] },
      { path: "/todomvc/#/active", title: "React • TodoMVC", headings: ["todos"] },
      { path: "/todomvc/#/completed", title: "React • TodoMVC", headings: ["todos"] },
    ];
    expect(names(screens)).toEqual({ "/todomvc/#/": "todos", "/todomvc/#/active": "Active", "/todomvc/#/completed": "Completed" });
    // A single-page app under a folder, with hash routes and nothing to tell them apart: two of its routes share a last part.
    const bank = ["", "/#/", "/#/manager", "/#/manager/addCust", "/#/manager/list", "/#/customer/list"].map((p) => ({ path: `/demo/BankingProject${p}`, title: "XYZ Bank", headings: [] }));
    expect(Object.values(names(bank))).toEqual(["XYZ Bank", "XYZ Bank", "Manager", "Add cust", "Manager list", "Customer list"]);
    // Hash routes of a page at ".../index.html": the index page is the folder's, and one record of a
    // list is told apart from the list itself, though one more part of the address says nothing more.
    const docs = ["/api-docs/index.html", "/api-docs/index.html/#/Accounts", "/api-docs/index.html/#/Accounts/:id", "/api-docs/index.html/#/Loans/requestLoan"].map((path) => ({ path, title: "Swagger UI", headings: [] }));
    expect(Object.values(names(docs))).toEqual(["Swagger UI", "Accounts", "Account", "Request loan"]);
  });

  it("a sidebar or panel heading repeated across screens is skipped for the title's own part or a heading of the page's own", () => {
    const screens = [
      { path: "/parabank/index.htm", title: "ParaBank | Welcome | Online Banking", headings: ["Customer Login"] },
      { path: "/parabank/services.htm", title: "ParaBank | Services", headings: ["Customer Login"] },
      { path: "/parabank/contact.htm", title: "ParaBank | Customer Care", headings: ["Customer Care", "Customer Login"] },
      { path: "/parabank/about.htm", title: "ParaBank | About Us", headings: ["ParaSoft Demo Website", "Customer Login"] },
    ];
    expect(names(screens)).toEqual({ "/parabank/index.htm": "Welcome", "/parabank/services.htm": "Services", "/parabank/contact.htm": "Customer Care", "/parabank/about.htm": "ParaSoft Demo Website" });
    // A help panel left open on every screen, with an emoji in its heading.
    const shop = [
      { path: "/auth/login", title: "Login - Toolshop - v5.0", headings: ["📋 Testing Guide", "Login"] },
      { path: "/auth/register", title: "Register - Toolshop - v5.0", headings: ["📋 Testing Guide", "Customer registration"] },
      { path: "/category/other", title: "Toolshop - v5.0", headings: ["📋 Testing Guide", "Category: Other"] },
    ];
    expect(names(shop)).toEqual({ "/auth/login": "Login", "/auth/register": "Register", "/category/other": "Category: Other" });
    // Product pages are named from their address: their headings are one product's.
    const store = [
      { path: "/products", title: "Automation Exercise - All Products", headings: ["Category", "Brands", "All Products"] },
      { path: "/product_details/:id", title: "Automation Exercise - Product Details", headings: ["Category", "Brands", "Blue Top"] },
      { path: "/view_cart", title: "Automation Exercise - Checkout", headings: [] },
    ];
    expect(names(store)).toEqual({ "/products": "All Products", "/product_details/:id": "Product details", "/view_cart": "Checkout" });
  });

  it("a profile listing articles is not named after the first article: a heading on several screens is nobody's", () => {
    const screens = [
      { path: "/", title: "Conduit", headings: ["conduit", "Discover Bondar Academy", "Mastering Knowledge"] },
      { path: "/article/:id", title: "Conduit", headings: ["Discover Bondar Academy"] },
      { path: "/profile/:id", title: "Conduit", headings: ["Discover Bondar Academy", "Mastering Knowledge"] },
    ];
    expect(names(screens)).toEqual({ "/": "conduit", "/article/:id": "Article", "/profile/:id": "Profile" });
  });

  it("a heading that is the page's own is kept even when the title is the site's (trap: no over-correction)", () => {
    const screens = [
      { path: "/", title: "The Internet", headings: ["Welcome to the-internet", "Available Examples"] },
      { path: "/login", title: "The Internet", headings: ["Login Page"] },
      { path: "/upload", title: "The Internet", headings: ["File Uploader"] },
      { path: "/pricing", title: "Pricing: Free, or Pro at $12 a month | Acme Notes", headings: ["Free to start. Upgrade when you need more."] },
      { path: "/guides", title: "Guides and how-tos | Acme Notes", headings: ["Every way to get your entries in.", "The browser extension"] },
    ];
    expect(names(screens)).toEqual({
      "/": "Welcome to the-internet",
      "/login": "Login Page",
      "/upload": "File Uploader",
      "/pricing": "Free to start. Upgrade when you need more.",
      "/guides": "Every way to get your entries in.",
    });
    // One screen alone: its heading, else its title.
    expect(names([{ path: "/", title: "Swag Labs", headings: [] }])).toEqual({ "/": "Swag Labs" });
  });

  it("views inside a screen are named after it, and don't make its heading look shared", () => {
    const screens = [
      { path: "/", title: "Acme Notes — Your notes already hold the answers", headings: ["Your notes already hold the answers."] },
      { path: "/~agents", title: "Acme Notes — Your notes already hold the answers", headings: ["Your notes already hold the answers."] },
      { path: "/~the-brief", title: "Acme Notes — Your notes already hold the answers", headings: ["Your notes already hold the answers."] },
      { path: "/faq", title: "FAQ — things people ask | Acme Notes", headings: ["Questions people actually ask."] },
    ];
    expect(names(screens)).toEqual({
      "/": "Your notes already hold the answers.",
      "/~agents": "Your notes already hold the answers: agents",
      "/~the-brief": "Your notes already hold the answers: the brief",
      "/faq": "Questions people actually ask.",
    });
  });

  it("ends a heading cut short when read at a word, never shows a held word, and strips decoration", () => {
    const long = "Embracing Daily Git Routines: Real Code Reviews on GitHub for Effective Coding P";
    expect(long.length).toBe(80);
    expect(screenName([{ path: "/article", headings: [long] }], "/article")).toBe("Embracing Daily Git Routines: Real Code Reviews on GitHub for Effective Coding…");
    expect(screenName([{ path: "/setup", headings: ["held:ab12cd"], title: "held:ef34" }], "/setup")).toBe("Setup");
    expect(screenName([{ path: "/x", headings: ["» ✅ Done ✨"] }], "/x")).toBe("Done");
    // Not decoration: words, numbers kept as written, a masked number.
    expect(screenName([{ path: "/x", headings: ["Step 2 of 3"] }], "/x")).toBe("Step 2 of 3");
  });

  it("reads an address as words", () => {
    expect(pathName("/basic_auth")).toBe("Basic auth");
    expect(pathName("/parabank/sitemap.htm")).toBe("Sitemap");
    expect(pathName("/parabank/index.htm")).toBe("Parabank");
    expect(pathName("/infinite_scroll/:id")).toBe("Infinite scroll");
    expect(pathName("/")).toBe("Home");
    expect(pathName("/#/manager/addCust", 2)).toBe("Manager add cust");
  });
});
