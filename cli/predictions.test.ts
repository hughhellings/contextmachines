// "Might trip people up", checked without a browser or an AI:
//   node --test cli/predictions.test.ts
// Every rule has a map it must speak about and traps it must stay quiet on: a guess with nothing
// behind it is worse than no guess.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { predict } from "./predictions.ts";

type Learned = Parameters<typeof predict>[0];
type Act = Learned["actions"][number];

const save = (id: string, name: string, onScreen: string | null, request: string, page: string): Act => ({ id, name, does: null, onScreen, kind: "save", request, pages: [page] });
const screen = (path: string, title: string | null = null, headings: string[] = []) => ({ path, title, headings, photo: null });

/** A small product with nothing to predict: signed-in start, clear buttons, setup met on the way. */
const calm: Learned = {
  url: "https://app.example/",
  product: "Invoicing.",
  mainAction: { id: "invoice.create", label: "Save invoice" },
  setupSteps: [{ action: "invoice.create", requires: "client.create", why: "The form needs a client." }],
  journeys: [{ name: "Bill a client", screens: ["/", "/clients/new", "/invoices/new"] }],
  screens: [screen("/", "Home", ["Dashboard"]), screen("/clients/new", "New client", ["New client"]), screen("/invoices/new", "New invoice", ["Create invoice"])],
  actions: [
    save("client.create", "Save client", "Save client", "POST /api/clients", "/clients/new"),
    save("invoice.create", "Save invoice", "Save invoice", "POST /api/invoices", "/invoices/new"),
    { id: "i18n", name: "Load interface text", does: null, onScreen: null, kind: "read", request: "GET /i18n", pages: [] },
  ],
  learner: { visited: 3, stoppedBy: "complete", savesStopped: 2, seconds: 30 },
};
const kinds = (map: Learned) => predict(map).map((p) => p.kind);

describe("predict", () => {
  it("says nothing about a product with nothing structural to point at", () => {
    assert.deepEqual(predict(calm), []);
  });
  it("says nothing about a map too thin to judge", () => {
    assert.deepEqual(predict({ url: "https://x.example/", product: null, mainAction: null, journeys: [], screens: [screen("/", "Swag Labs")], actions: [] }), []);
  });
});

describe("sign_in_first", () => {
  const wall: Learned = { ...calm, screens: [screen("/", "Log in | Acme", ["Welcome back"]), ...calm.screens.slice(1)] };
  it("fires when the start screen is for signing in and no way to sign up was seen", () => {
    const [p] = predict(wall);
    assert.equal(p?.kind, "sign_in_first");
    assert.equal(p?.screen, "/");
    assert.match(p?.why ?? "", /it saw no way to sign up/, "says what it saw, not that there is none");
  });
  it("knows the start by its address, or as the only sign-in screen when the start sent the browser elsewhere", () => {
    const redirected: Learned = { url: "https://hr.example/", product: null, mainAction: null, journeys: [], screens: [screen("/web/index.php/auth/login", "Acme HR"), screen("/web/index.php/about", "About")], actions: [], learner: calm.learner };
    assert.deepEqual(kinds({ ...redirected, screens: redirected.screens.slice(0, 1) }), [], "a lone sign-in screen: see the trap below");
    const hash: Learned = { ...redirected, url: "https://a.example/#/login", screens: [screen("/#/login"), screen("/#/about", "About")] };
    assert.deepEqual(kinds(hash), ["sign_in_first"]);
  });
  it("trap: a site that is nothing but a sign-in door hands out its accounts (a company's own tool, an HR system)", () => {
    const door: Learned = { url: "https://hr.example/", product: null, mainAction: null, journeys: [], screens: [screen("/web/index.php/auth/login", "Acme HR")], actions: [], learner: calm.learner };
    assert.deepEqual(kinds(door), []);
    assert.deepEqual(kinds({ ...door, screens: [...door.screens, screen("/web/index.php/auth/requestPasswordResetCode", "Acme HR"), screen("/forgot-password", "Reset")] }), []);
  });
  it("trap: a run that stopped early may not have reached the sign-up page", () => {
    for (const stoppedBy of ["max_duration", "max_pages", "interrupted"]) assert.deepEqual(kinds({ ...wall, learner: { ...calm.learner!, stoppedBy } }), [], stoppedBy);
    const { learner: _, ...older } = wall;
    assert.deepEqual(kinds(older), [], "an older map that doesn't say how the run ended");
  });
  it("trap: a sign-up link on the sign-in screen, even one to another host (app.x/login linking www.x/signup)", () => {
    // The learner keeps to the start's host, so the sign-up page itself is never a screen: only the link's words are seen.
    const split: Learned = { ...wall, url: "https://app.shop.example/login", screens: [screen("/login", "Welcome back"), screen("/help", "Help")] };
    assert.deepEqual(kinds(split), ["sign_in_first"]);
    assert.deepEqual(predict(split, { controls: { "/login": { buttons: ["Log in"], links: ["Forgot password?", "Sign up free"] } } }), []);
    assert.deepEqual(predict(split, { controls: { "/login": { buttons: ["Log in", "Start free"], links: [] } } }), []);
    assert.deepEqual(predict(split, { controls: { "/help": { buttons: [], links: ["Create an account"] } } }), []);
  });
  it("trap: a way to sign up anywhere (a screen, a button, a journey) means newcomers can get in", () => {
    assert.deepEqual(kinds({ ...wall, screens: [...wall.screens, screen("/register.htm", "Register for free")] }), []);
    assert.deepEqual(kinds({ ...wall, actions: [...wall.actions, save("signup", "Create account", "Create account", "POST /api/users", "/")] }), []);
    assert.deepEqual(kinds({ ...wall, journeys: [...wall.journeys, { name: "Sign up", screens: ["/"] }] }), []);
    assert.deepEqual(kinds({ ...wall, screens: [...wall.screens, screen("/sign-up")] }), []);
  });
  it("trap: a login box in a sidebar heading doesn't make a page a sign-in screen", () => {
    assert.deepEqual(kinds({ ...calm, screens: [screen("/", "Acme Bank | Welcome", ["Customer Login"]), ...calm.screens.slice(1)] }), []);
  });
  it("trap: a sign-in screen that isn't the start, or a start it can't name among several screens", () => {
    assert.deepEqual(kinds({ ...calm, screens: [...calm.screens, screen("/login", "Log in")] }), []);
    assert.deepEqual(kinds({ ...calm, url: "https://app.example/app", screens: [screen("/login", "Log in"), screen("/home", "Home")] }), []);
  });
  it("trap: words that merely contain sign-in letters", () => {
    assert.deepEqual(kinds({ ...calm, screens: [screen("/", "Design inspiration"), screen("/author/blogin", "Blogin")] }), []);
  });
});

describe("needs_setup_first", () => {
  const offPath: Learned = { ...calm, journeys: [{ name: "Bill a client", screens: ["/", "/invoices/new"] }] };
  it("fires when every journey to an action misses what it needs first", () => {
    const [p] = predict(offPath);
    assert.equal(p?.kind, "needs_setup_first");
    assert.equal(p?.screen, "/invoices/new");
    assert.equal(p?.target, "Save invoice");
    assert.match(p?.why ?? "", /"Save invoice" needs "Save client" done first \(the form needs a client\).*never passes New client/);
  });
  it("still fires when the journey reaches the needed screen only after the action", () => {
    assert.deepEqual(kinds({ ...calm, journeys: [{ name: "Bill a client", screens: ["/", "/invoices/new", "/clients/new"] }] }), ["needs_setup_first"]);
  });
  it("trap: a journey that passes the needed screen on the way", () => {
    assert.deepEqual(kinds(calm), []);
  });
  it("trap: another journey to the same action is a way in", () => {
    assert.deepEqual(kinds({ ...offPath, journeys: [...offPath.journeys, { name: "New client, then bill", screens: ["/clients/new", "/invoices/new"] }] }), []);
  });
  it("trap: steps it can't place (no screen for either action, no journey to it, unknown ids)", () => {
    const noPages = { ...offPath, actions: offPath.actions.map((a) => (a.id === "client.create" ? { ...a, pages: [] } : a)) };
    assert.deepEqual(kinds(noPages), []);
    assert.deepEqual(kinds({ ...offPath, journeys: [{ name: "Look around", screens: ["/"] }] }), []);
    assert.deepEqual(kinds({ ...offPath, setupSteps: [{ action: "invoice.create", requires: "nothing.known" }] }), []);
  });
  it("says it once when the same step is read twice", () => {
    const twice = { ...offPath, setupSteps: [...(offPath.setupSteps ?? []), { action: "invoice.create", requires: "client.create" }] };
    assert.equal(predict(twice).length, 1);
  });
});

describe("unclear_button", () => {
  const admin = (labels: (string | null)[]): Learned => ({
    ...calm,
    mainAction: null,
    actions: labels.map((l, k) => save(`a${k}`, ["Initialize database", "Submit bank settings", "Clean data"][k] ?? `Action ${k}`, l, `POST /admin/${k}`, "/admin")),
    screens: [...calm.screens, screen("/admin", "Admin", ["Administration"])],
  });
  it("fires for a generic word beside other saves, saying what it really does", () => {
    const ps = predict(admin(["Initialize", "Submit"]));
    assert.equal(ps.length, 1);
    assert.equal(ps[0]?.kind, "unclear_button");
    assert.equal(ps[0]?.target, "Submit");
    assert.match(ps[0]?.why ?? "", /"Submit" sits with 1 other save on Administration.*\(it is "Submit bank settings"\)/);
  });
  it("fires for a button with no words, and for two buttons the screen shows with the same words that save different things", () => {
    assert.match(predict(admin(["Initialize", "×"]))[0]?.why ?? "", /a button marked only "×"/);
    assert.match(predict(admin(["Initialize", ""]))[0]?.why ?? "", /a button with no words/);
    const twins = predict(admin(["Add", "Add", "Initialize"]), { controls: { "/admin": { buttons: ["Add", "Add", "Initialize"], links: [] } } });
    assert.deepEqual(twins.map((p) => p.kind), ["unclear_button"], "said once, not once per request");
    assert.match(twins[0]?.why ?? "", /"Add" is on more than one button on Administration, and they save different things \("Initialize database", "Submit bank settings"\)/);
  });
  it("trap: one press that sends several requests is one button, not twins (a search box: suggestions, saved state, a beacon)", () => {
    const search = (n: number): Learned => ({
      ...calm,
      mainAction: null,
      actions: Array.from({ length: n }, (_, k) => save(`s${k}`, ["Search homes", "Get suggestions", "Save search state", "Send beacon"][k]!, "Submit Search", ["POST /graph", "POST /graph?op=suggest", "PUT /search-state", "POST /collector"][k]!, "/")),
    });
    assert.deepEqual(predict(search(2)), []);
    assert.deepEqual(predict(search(4), { controls: { "/": { buttons: ["Submit Search", "Sign in"], links: [] } } }), [], "the screen shows the label on one button only");
  });
  it("trap: a generic word whose several requests are one button, with no other button saving there", () => {
    const one = { ...calm, mainAction: null, actions: [save("x", "Save note", "Save", "POST /api/notes", "/notes"), save("y", "Log save", "Save", "POST /api/log", "/notes")] };
    assert.deepEqual(kinds(one), []);
  });
  it("trap: a lone generic button: the screen says what it is for", () => {
    assert.deepEqual(kinds(admin(["Submit"])), []);
  });
  it("trap: buttons that say what they do, unknown labels, and one save pressed from two buttons", () => {
    assert.deepEqual(kinds(admin(["Initialize", "Clean data"])), []);
    assert.deepEqual(kinds(admin([null, null])), []);
    const same = { ...calm, mainAction: null, actions: [save("x", "Save note", "Save", "POST /api/notes", "/notes"), save("y", "Save note", "Save", "POST /api/notes", "/notes")] };
    assert.deepEqual(kinds(same), []);
  });
  it("trap: the same generic word on different screens", () => {
    const apart = { ...calm, mainAction: null, actions: [save("x", "Save note", "Save", "POST /api/notes", "/notes"), save("y", "Save tag", "Save", "POST /api/tags", "/tags")] };
    assert.deepEqual(kinds(apart), []);
  });
});

describe("destructive_beside_main", () => {
  const withAction = (a: Act): Learned => ({ ...calm, actions: [...calm.actions, a] });
  it("fires for something that destroys or stops things on the main action's screen", () => {
    const [p] = predict(withAction(save("x", "Remove all lines", "Remove all", "POST /api/invoices/clear", "/invoices/new")));
    assert.equal(p?.kind, "destructive_beside_main");
    assert.equal(p?.target, "Remove all");
    assert.match(p?.why ?? "", /same screen as the main action, "Save invoice"/);
    const shouted: Learned = { ...withAction(save("x", "Shut down service", "Shutdown", "POST /svc", "/invoices/new")), mainAction: { id: "invoice.create", label: "SAVE INVOICE" } };
    assert.match(predict(shouted)[0]?.why ?? "", /the main action, "Save invoice"/, "named as everywhere else, in sentence case");
    assert.deepEqual(kinds(withAction(save("y", "Discard draft", "Trash", "DELETE /api/drafts/:id", "/invoices/new"))), ["destructive_beside_main"]);
    assert.deepEqual(kinds(withAction(save("z", "Shut down service", "Shutdown", "POST /svc", "/invoices/new"))), ["destructive_beside_main"]);
  });
  it("trap: the same thing on another screen, or with no main action read", () => {
    assert.deepEqual(kinds(withAction(save("x", "Delete client", "Delete", "DELETE /api/clients/:id", "/clients/new"))), []);
    assert.deepEqual(kinds({ ...withAction(save("x", "Delete line", "Delete", "DELETE /api/lines/:id", "/invoices/new")), mainAction: null }), []);
  });
  it("trap: reads (clearing a filter) and the main action itself", () => {
    const read: Act = { id: "f", name: "Clear filters", does: null, onScreen: "Reset filters", kind: "read", request: "GET /api/invoices", pages: ["/invoices/new"] };
    assert.deepEqual(kinds(withAction(read)), []);
    const resetMain: Learned = { ...calm, mainAction: { id: "invoice.create", label: "Reset and save" }, actions: calm.actions.map((a) => (a.id === "invoice.create" ? { ...a, onScreen: "Reset and save" } : a)) };
    assert.deepEqual(kinds(resetMain), []);
  });
  it("finds the main action by its button's words when the map has no id for it", () => {
    const byLabel: Learned = { ...withAction(save("x", "Delete line", "Delete", "DELETE /api/lines/:id", "/invoices/new")), mainAction: { label: "save invoice" } };
    assert.deepEqual(kinds(byLabel), ["destructive_beside_main"]);
  });
});

describe("long_journey", () => {
  const steps = ["/", "/a", "/b", "/c", "/invoices/new"];
  const long: Learned = { ...calm, setupSteps: [], journeys: [{ name: "Apply for a loan", screens: steps }], screens: steps.map((p) => screen(p, p)) };
  it("fires for five screens or more ending in a save, with no step count shown", () => {
    const [p] = predict(long);
    assert.equal(p?.kind, "long_journey");
    assert.equal(p?.target, "Apply for a loan");
    assert.match(p?.why ?? "", /takes 5 screens/);
  });
  it("trap: a shorter journey, one that saves nothing (browsing), or one that counts its steps", () => {
    assert.deepEqual(kinds({ ...long, journeys: [{ name: "Apply", screens: steps.slice(1) }] }), []);
    assert.deepEqual(kinds({ ...long, journeys: [{ name: "Browse", screens: [...steps.slice(0, 4), "/d"] }] }), []);
    assert.deepEqual(kinds({ ...long, screens: long.screens.map((s) => (s.path === "/b" ? { ...s, headings: ["Step 3 of 5"] } : s)) }), []);
    assert.deepEqual(kinds({ ...long, screens: long.screens.map((s) => (s.path === "/a" ? { ...s, title: "Details (2/5)" } : s)) }), []);
  });
});

describe("order and length", () => {
  it("puts a sign-in wall first and the main action's setup before other guesses, at most six", () => {
    const labels = ["Initialize", "Submit", "Go", "OK", "Yes", "Done", "Next"];
    const busy: Learned = {
      ...calm,
      screens: [screen("/", "Sign in"), ...calm.screens.slice(1)],
      journeys: [{ name: "Bill a client", screens: ["/", "/invoices/new"] }],
      actions: [...calm.actions, ...labels.map((l, k) => save(`b${k}`, `Thing ${k}`, l, `POST /b/${k}`, "/busy"))],
    };
    const ps = predict(busy);
    assert.equal(ps.length, 6);
    assert.deepEqual(ps.slice(0, 2).map((p) => p.kind), ["sign_in_first", "needs_setup_first"]);
    assert.deepEqual(predict(busy), ps, "the same map reads the same way every time");
  });
});

describe("sign_in_first: ways in it knows", () => {
  const door: Learned = { ...calm, url: "https://app.example/login", mainAction: null, setupSteps: [], journeys: [], actions: [], screens: [screen("/login", "Sign in", ["Sign in"]), screen("/privacy", "Privacy", ["Privacy"])] };
  const onSeen = (links: string[]) => predict(door, { controls: { "/login": { buttons: [], links } } }).map((p) => p.kind);
  it("still speaks when nothing there lets a newcomer in", () => {
    assert.deepEqual(onSeen(["Sign in", "Forgot your password?", "Privacy"]), ["sign_in_first"]);
  });
  for (const words of ["Create one", "Get an account", "Open an account", "Don't have an account?", "Request access", "Request early access", "Get access", "Request a demo", "Book a demo", "Contact sales", "Registrieren", "Konto erstellen", "S'inscrire", "s’inscrire", "Créer un compte", "Registrarse", "Crear cuenta", "Criar conta", "Iscriviti"]) {
    it(`stays quiet on "${words}"`, () => assert.deepEqual(onSeen([words]), []));
  }
  for (const href of ["/signup", "/sign-up", "/join", "/register", "/users/register", "/fr/register"]) {
    it(`stays quiet on a link that goes to ${href}, whatever it says`, () => assert.deepEqual(onSeen(["Go", href]), []));
  }
  it("isn't quieted by words that only look like it", () => {
    assert.deepEqual(onSeen(["/rejoinder", "Registered trademark", "Account settings"]), ["sign_in_first"]);
  });
});
