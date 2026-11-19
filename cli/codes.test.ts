// Sign-in, checkpoint 2 (AUTH C5 to C9): authenticator codes, the inbox adapter, the one "send code"
// exception to the deny list, codes and links from a local mail catcher, and sign-ups on owned hosts.
// Offline: the local auth fixture, a scripted brain, a file store. No real service, no network.
//   node --test cli/codes.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser, Page } from "playwright";
import { act, MAX_CODE_SENDS, refusedName, SEND_CODE_PHRASES, sendCodeWords, type ActContext } from "../packages/scanner/src/tester/act.ts";
import { withoutSecrets } from "../packages/scanner/src/tester/cache.ts";
import { catcherProblem, findCode, findLink, mailpitInbox, waitForMessage, type Inbox, type InboxMessage } from "../packages/scanner/src/tester/inbox.ts";
import { makeMasker } from "../packages/scanner/src/tester/placeholders.ts";
import { launch } from "../packages/scanner/src/tester/record.ts";
import { newSignInGuard } from "../packages/scanner/src/tester/run.ts";
import { base32Decode, hotp, msLeft, parseTotpSecret, totpAt, totpNow, type TotpSecret } from "../packages/scanner/src/tester/totp.ts";
import type { Action, DecideInput } from "../packages/scanner/src/tester/types.ts";
import type { AskTiming } from "./ai.ts";
import { AccountConfigError, accountResolver, createdAccounts, fileStore, markMine, markSignInOk, parseAccounts, secretsPathFor, signUpDomainAllowed, signUpResolver } from "./accounts.ts";
import { AUTH_TASKS, runAuthTask, type BrainFor } from "./bench/auth-bench.ts";
import { startAuthSite, type AuthSite } from "./bench/auth-site.ts";
import { placesIn } from "./leak.ts";
import { actQuestion } from "./test-command.ts";
import { accountFor, ensureSession } from "./signin.ts";

const temp = (p = "cm-codes-") => mkdtempSync(join(tmpdir(), p));

// ---------------------------------------------------------------------------------------------
// C5: authenticator codes.

describe("C5: authenticator codes (RFC 6238)", () => {
  // RFC 6238 appendix B: the seeds are ASCII, 20, 32 and 64 bytes; 8 digits; 30 s.
  const seeds: Record<"SHA1" | "SHA256" | "SHA512", Buffer> = {
    SHA1: Buffer.from("12345678901234567890"),
    SHA256: Buffer.from("12345678901234567890123456789012"),
    SHA512: Buffer.from("1234567890123456789012345678901234567890123456789012345678901234"),
  };
  const vectors: [number, string, keyof typeof seeds][] = [
    [59, "94287082", "SHA1"], [59, "46119246", "SHA256"], [59, "90693936", "SHA512"],
    [1111111109, "07081804", "SHA1"], [1111111109, "68084774", "SHA256"], [1111111109, "25091201", "SHA512"],
    [1111111111, "14050471", "SHA1"], [1111111111, "67062674", "SHA256"], [1111111111, "99943326", "SHA512"],
    [1234567890, "89005924", "SHA1"], [1234567890, "91819424", "SHA256"], [1234567890, "93441116", "SHA512"],
    [2000000000, "69279037", "SHA1"], [2000000000, "90698825", "SHA256"], [2000000000, "38618901", "SHA512"],
    [20000000000, "65353130", "SHA1"], [20000000000, "77737706", "SHA256"], [20000000000, "47863826", "SHA512"],
  ];

  it("meets all 18 vectors of RFC 6238 appendix B", () => {
    let right = 0;
    for (const [t, want, algorithm] of vectors) {
      const secret: TotpSecret = { key: seeds[algorithm], digits: 8, period: 30, algorithm };
      assert.equal(totpAt(secret, t * 1000), want, `${algorithm} at ${t}`);
      right++;
    }
    assert.equal(right, 18);
  });

  it("reads base32 (spaces, dashes and case ignored) and otpauth:// links, and refuses anything else", () => {
    // "12345678901234567890" in base32.
    const b32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    assert.deepEqual(base32Decode(b32), seeds.SHA1);
    assert.deepEqual(base32Decode("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq"), seeds.SHA1);
    const plain = parseTotpSecret(b32);
    assert.equal(plain.digits, 6);
    assert.equal(plain.period, 30);
    assert.equal(plain.algorithm, "SHA1");
    assert.equal(totpAt(plain, 59_000), "287082", "6 digits are the 8-digit code's last 6");
    const link = parseTotpSecret(`otpauth://totp/Fixture:me@example.test?secret=${b32}&issuer=Fixture&digits=8&period=60&algorithm=SHA256`);
    assert.equal(link.digits, 8);
    assert.equal(link.period, 60);
    assert.equal(link.algorithm, "SHA256");
    assert.throws(() => parseTotpSecret("not base32 at all!"), /base32/);
    assert.throws(() => parseTotpSecret(`otpauth://hotp/x?secret=${b32}`), /totp/);
    assert.throws(() => parseTotpSecret(`otpauth://totp/x?secret=${b32}&algorithm=MD5`), /SHA1/);
    assert.equal(hotp(seeds.SHA1, 0, 6), "755224", "RFC 4226 appendix D, count 0");
  });

  it("waits for the next window when fewer than 5 s are left, so the code is still good when it arrives", async () => {
    const secret = parseTotpSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    let now = 29_000; // 1 s left in the first window
    const slept: number[] = [];
    const code = await totpNow(secret, { now: () => now, sleep: async (ms) => { slept.push(ms); now += ms; } });
    assert.deepEqual(slept, [1050]);
    assert.equal(code, totpAt(secret, 30_050), "the next window's code");
    assert.notEqual(code, totpAt(secret, 29_000));
    now = 10_000; // 20 s left: no wait
    slept.length = 0;
    assert.equal(await totpNow(secret, { now: () => now, sleep: async (ms) => { slept.push(ms); } }), totpAt(secret, 10_000));
    assert.deepEqual(slept, []);
    assert.equal(msLeft(secret, 31_000), 29_000);
  });

  it("a code made for an account is told to the masker before it is handed out, and so is its secret", async () => {
    const out = temp();
    const store = fileStore(secretsPathFor(out));
    store.set("h.test/admin/totp", "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    const account = parseAccounts({ accounts: { admin: { username: "a@example.test", password: { keychain: true }, totp: { keychain: true }, signedIn: { text: "Sign out" } } } }).accounts.get("admin")!;
    const r = accountResolver(account, { host: "h.test", store, env: {} });
    assert.ok(r.names().includes("admin.totp"));
    assert.equal(r.has("admin.totp"), true);
    assert.equal(r.get("admin.totp"), undefined, "never read as a stored value");
    const mask = makeMasker();
    const got = await r.fresh!("admin.totp", { since: 0, mask, allowedHosts: [] });
    assert.ok(got && "value" in got && /^\d{6}$/.test(got.value));
    const value = (got as { value: string }).value;
    assert.equal(mask(`typed ${value} from JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP`), "typed {admin.totp} from {admin.totp_secret}");
    rmSync(out, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------------------------
// C6: the inbox adapter: our code finds the code or the link; never a guess.

const mail = (m: Partial<InboxMessage>): InboxMessage => ({ id: "x", to: ["me@example.test"], subject: "", text: "", html: "", created: 0, ...m });

describe("C6: finding the code or the link in a message", () => {
  const samples: { who: string; m: InboxMessage; want: "code" | "link"; hosts?: string[]; is: string }[] = [
    { who: "Clerk code", want: "code", is: "123456", m: mail({ subject: "123456 is your verification code", text: "Enter the verification code below to sign in.\n\n123456\n\nThis code expires in 10 minutes.\n\nIf you didn't request this, you can ignore this email.\n\nSent by Clerk to your app's users. 2026" }) },
    { who: "Supabase OTP", want: "code", is: "654321", m: mail({ subject: "Confirm your signup", text: "Confirm your signup\n\nEnter the code: 654321" }) },
    { who: "Supabase magic link (local API port)", want: "link", hosts: ["127.0.0.1:54321"], is: "http://127.0.0.1:54321/auth/v1/verify?token=pkce_8c1f&type=magiclink&redirect_to=http://localhost:3000", m: mail({ subject: "Your Magic Link", html: '<h2>Magic Link</h2><p>Follow this link to login:</p><p><a href="http://127.0.0.1:54321/auth/v1/verify?token=pkce_8c1f&amp;type=magiclink&amp;redirect_to=http://localhost:3000">Log In</a></p>' }) },
    { who: "Auth0 code", want: "code", is: "482913", m: mail({ subject: "Verify your email", text: "Your verification code is: 482913\n\nThe code is valid for 5 minutes.\n\n\n\n\n\n\n\nYou're receiving this email because you signed up for an account with an app that uses Auth0 for sign-in. Auth0, 10800 NE 8th Street, Suite 700, Bellevue, WA" }) },
    { who: "Firebase email link", want: "link", hosts: ["myapp.firebaseapp.com"], is: "https://myapp.firebaseapp.com/__/auth/action?apiKey=AIzaFake123&mode=signIn&oobCode=Xy7_q&continueUrl=https://myapp.web.app/finish&lang=en", m: mail({ subject: "Sign in to project-1234", text: "Hello,\n\nWe received a request to sign in to project-1234 using this email address. If you want to sign in with your me@example.test account, click this link:\n\nhttps://myapp.firebaseapp.com/__/auth/action?apiKey=AIzaFake123&mode=signIn&oobCode=Xy7_q&continueUrl=https://myapp.web.app/finish&lang=en\n\nThanks,\nYour project-1234 team" }) },
    { who: "WorkOS Magic Auth", want: "code", is: "778899", m: mail({ subject: "Your Magic Auth code", text: "Your Magic Auth code is 778899. It expires in 10 minutes." }) },
    { who: "letters and digits", want: "code", is: "K7Q2ZP", m: mail({ subject: "Sign-in", text: "Your one-time passcode: K7Q2ZP" }) },
    { who: "a grouped code", want: "code", is: "123456", m: mail({ subject: "Login code", text: "Your login code is 123-456. Don't share it." }) },
    { who: "a plain magic link", want: "link", hosts: ["app.example.com"], is: "https://app.example.com/auth/magic?token=xyz123abc", m: mail({ subject: "Sign in", text: "Click here to sign in: https://app.example.com/auth/magic?token=xyz123abc.\n\nhttps://app.example.com/help" }) },
    { who: "Clerk link", want: "link", hosts: ["accounts.example.com"], is: "https://accounts.example.com/v1/verify?_clerk_js_version=5&token=eyJhbGciOi.fake.sig", m: mail({ subject: "Sign in to Example", html: '<a href="https://accounts.example.com/v1/verify?_clerk_js_version=5&amp;token=eyJhbGciOi.fake.sig">Sign in to Example</a> <a href="https://clerk.com/privacy">Privacy</a>' }) },
    { who: "a code in HTML only", want: "code", is: "246810", m: mail({ subject: "Welcome", html: "<p>Your verification code</p><h2 style=\"letter-spacing:4px\">246810</h2><style>.x{width:600px}</style>" }) },
    { who: "an 8-digit code", want: "code", is: "12345678", m: mail({ subject: "Security", text: "Your security code is 12345678." }) },
  ];

  it("12 sample mails give the right code or link", () => {
    let right = 0;
    for (const s of samples) {
      const found = s.want === "code" ? findCode(s.m) : findLink(s.m, s.hosts ?? []);
      assert.deepEqual(found, s.want === "code" ? { code: s.is } : { link: s.is }, s.who);
      right++;
    }
    assert.equal(right, 12);
  });

  it("4 ambiguous mails are 'not sure': never a guess", () => {
    const two = findCode(mail({ text: "Your code is 111111. Your backup code is 222222." }));
    const phone = findCode(mail({ text: "Your verification code is 333444. Questions? Call +1 201-555-0100." }));
    const links = findLink(mail({ html: '<a href="https://app.example.com/verify?token=a1">Verify</a> or <a href="https://app.example.com/verify?token=b2">verify on mobile</a>' }), ["app.example.com"]);
    const none = findCode(mail({ subject: "Welcome", text: "Welcome! Thanks for signing up." }));
    for (const [what, f] of [["two codes", two], ["a code and a phone number", phone], ["two links", links], ["no code", none]] as const) assert.ok("notSure" in f, `${what}: ${JSON.stringify(f)}`);
  });

  it("a link on a host nobody allowed is never handed out, and http is only for this machine", () => {
    const m = mail({ text: "Sign in: https://evil.example.net/auth/magic?token=abc123def" });
    const f = findLink(m, ["app.example.com"]);
    assert.ok("notSure" in f && /evil\.example\.net/.test(f.notSure));
    assert.ok("notSure" in findLink(mail({ text: "Sign in: http://app.example.com/auth/magic?token=abc123def" }), ["app.example.com"]), "plain http to a real host is refused");
    assert.deepEqual(findLink(mail({ text: "Sign in: http://localhost:3000/auth/magic?token=abc123def" }), ["localhost:3000"]), { link: "http://localhost:3000/auth/magic?token=abc123def" });
  });

  it("a catcher must be on this machine (tier A)", () => {
    assert.equal(catcherProblem("http://127.0.0.1:8025"), undefined);
    assert.equal(catcherProblem("http://localhost:54324"), undefined);
    assert.match(catcherProblem("https://mail.example.com")!, /this machine/);
    assert.match(catcherProblem("ftp://127.0.0.1")!, /http/);
    assert.throws(() => mailpitInbox("https://inbox.example.com"), /this machine/);
    assert.throws(() => parseAccounts({ accounts: { a: { first: "email-code", username: "a@example.test", codes: [{ catcher: "https://inbox.example.com" }], signedIn: { text: "x" } } } }), AccountConfigError);
  });

  it("only messages after the send count, each is used once and deleted, and 'not received' is told from 'down'", async () => {
    const box: InboxMessage[] = [];
    const removed: string[] = [];
    let down = false;
    let looks = 0;
    const inbox: Inbox = {
      where: "a fake inbox",
      list: async () => {
        looks++;
        return down ? { ok: false, why: "the mail catcher answered 503" } : { ok: true, messages: [...box] };
      },
      remove: async (ids) => {
        removed.push(...ids);
        for (const id of ids) box.splice(box.findIndex((m) => m.id === id), 1);
      },
    };
    const fast = { timeoutMs: 300, pollMs: 50 };
    box.push(mail({ id: "old", created: 1000, text: "Your code is 999999" }));
    const before = await waitForMessage(inbox, { to: "me@example.test", since: 2000, want: "code", ...fast });
    assert.ok("notReceived" in before, "a message from before the send is never read");
    box.push(mail({ id: "new", created: 2500, text: "Your code is 424242" }));
    const used = new Set<string>();
    assert.deepEqual(await waitForMessage(inbox, { to: "ME@example.test", since: 2000, want: "code", used, ...fast }), { code: "424242", id: "new" });
    assert.deepEqual(removed, ["new"]);
    assert.ok("notReceived" in (await waitForMessage(inbox, { to: "me@example.test", since: 2000, want: "code", used, ...fast })), "a used message isn't read again");
    box.push(mail({ id: "other", created: 3000, to: ["someone@example.test"], text: "Your code is 121212" }));
    assert.ok("notReceived" in (await waitForMessage(inbox, { to: "me@example.test", since: 2000, want: "code", ...fast })), "another address's message isn't read");
    down = true;
    looks = 0;
    const gone = await waitForMessage(inbox, { to: "me@example.test", since: 2000, want: "code", timeoutMs: 10_000, pollMs: 10 });
    assert.ok("down" in gone, JSON.stringify(gone));
    assert.equal(looks, 3, "down after 3 failed looks, not after the whole minute");
  });
});

// ---------------------------------------------------------------------------------------------
// Addresses lose a magic link's or a callback's token wherever they are kept (C8).

describe("C8: tokens taken out of every kept address", () => {
  it("drops a token-carrying fragment, oobCode, apiKey and Clerk's own, and keeps a page's anchor or hash route", () => {
    assert.equal(withoutSecrets("http://127.0.0.1:3000/app#access_token=LEAKabc123def456&token_type=bearer"), "http://127.0.0.1:3000/app");
    assert.equal(withoutSecrets("https://a.example.com/finish?mode=signIn&oobCode=Xy7_q&apiKey=AIzaFake&lang=en"), "https://a.example.com/finish?mode=signIn&lang=en");
    assert.equal(withoutSecrets("https://a.example.com/x?__clerk_db_jwt=dvb_1&__clerk_ticket=t&tab=2"), "https://a.example.com/x?tab=2");
    assert.equal(withoutSecrets("https://a.example.com/cb?code=4/0Ab&state=xyz&scope=email"), "https://a.example.com/cb?scope=email");
    assert.equal(withoutSecrets("https://a.example.com/pricing#plans"), "https://a.example.com/pricing#plans");
    assert.equal(withoutSecrets("https://a.example.com/#/settings/profile"), "https://a.example.com/#/settings/profile");
    assert.equal(withoutSecrets("https://a.example.com/#eyJhbGciOiJIUzI1NiJ9.e30.sig"), "https://a.example.com/");
  });
});

// ---------------------------------------------------------------------------------------------
// C7: the "send code / send link" exception, its words pinned.

describe("C7: the one 'send' a test may press", () => {
  it("its words are exactly these (a change here is a decision for Sam), and reset or invite isn't one (D1b)", () => {
    assert.deepEqual([...SEND_CODE_PHRASES], [
      "send (the |a |my )?(verification |sign-in |sign in |login )?code",
      "send (me )?(a |the )?(magic |sign-in |sign in |login )?link",
      "email me (a |the )?(code|link|magic link|sign-in link|login link)",
      "text me (a |the )?code",
      "resend (the |a |my )?(verification )?code",
      "send (a )?new code",
      "send verification (code|email)",
      "verify (my )?email",
    ]);
    for (const yes of ["Send code", "Send the code", "Send me a link", "Send magic link", "Email me a code", "Text me a code", "Resend code", "Send a new code", "Send verification email", "Send verification code", "Verify my email", "Send code →"]) assert.ok(sendCodeWords(yes), yes);
    for (const no of ["Send", "Send message", "Send invite", "Send reset link", "Reset my password", "Accept invite", "Send a link to a friend", "Send code to all users", "Send feedback", "Share link"]) {
      assert.equal(sendCodeWords(no), false, no);
    }
    assert.ok(refusedName("Send code"), "outside the exception, the deny list still refuses it");
  });
});

describe("C7: pressed only on the account's own host, in a sign-in's form, at most 3 times", () => {
  let site: AuthSite;
  let browser: Browser;
  before(async () => {
    site = await startAuthSite({ users: [{ username: "me@example.test", password: "pw-c7-" + "fixture" }] });
    browser = await launch(false);
  });
  after(async () => {
    await browser?.close();
    await site?.close();
  });
  const host = () => new URL(site.url).host;
  // The run's masker knows the account's own values: a send-code form must hold one of them (review fix).
  const ownMask = makeMasker();
  ownMask.add("me.username", "me@example.test", true);
  ownMask.add("new.email", "cm-test-c7@example.test", true);
  const ctxFor = (page: Page, o: Partial<ActContext> = {}): ActContext => ({ page, start: site.url, allowHosts: [], values: { vars: {}, given: "" }, mask: ownMask, offSite: () => undefined, codeSends: { host: host(), count: { n: 0 } }, ...o });
  const press = (ctx: ActContext, name: string) => act(ctx, { type: "click", target: { role: "button", name, nth: 0 } });
  const posts = (path: string) => site.hits().filter((h) => h === `POST ${path}`).length;

  it("7 cases: sign-in form yes; Resend beside a code box yes; a sign-up's form yes; a contact form no; a visitor no; another host no; the 4th press no", async () => {
    const page = await browser.newPage();
    try {
      // 1. The sign-in form.
      await page.goto(new URL("/code", site.url).href);
      await page.fill("#email", "me@example.test");
      const one = await press(ctxFor(page), "Send code");
      assert.ok("done" in one, JSON.stringify(one));
      assert.equal(posts("/code"), 1);
      // 2. "Resend code" beside a code box (a page of the site's own, served at its host).
      await page.route(new URL("/resend", site.url).href, (r) => r.fulfill({ contentType: "text/html", body: '<!doctype html><title>Code</title><form method="post" action="/code"><label for="c">Verification code</label><input id="c" name="code" autocomplete="one-time-code"><input type="hidden" name="email" value="me@example.test"><button type="submit">Resend code</button></form>' }));
      await page.goto(new URL("/resend", site.url).href);
      const two = await press(ctxFor(page), "Resend code");
      assert.ok("done" in two, JSON.stringify(two));
      assert.equal(posts("/code"), 2);
      // 3. A sign-up's form: a name and a password too.
      await page.goto(new URL("/signup", site.url).href);
      await page.fill("#name", "Cm Tester");
      await page.fill("#email", "cm-test-c7@example.test");
      await page.fill("#password", "pw-signu" + "p-c7-123");
      const notSignUp = await press(ctxFor(page), "Send verification code");
      assert.ok("blocked" in notSignUp && /asks for more than who signs in/.test(notSignUp.blocked), "outside a sign-up, a name and a password are more than a sign-in asks");
      const three = await press(ctxFor(page, { codeSends: { host: host(), signUp: true, count: { n: 0 } } }), "Send verification code");
      assert.ok("done" in three, JSON.stringify(three));
      assert.equal(posts("/signup"), 1);
      // 3b. An address that isn't the account's: never sent a code (review fix).
      await page.goto(new URL("/code", site.url).href);
      await page.fill("#email", `someone.else@${"gmail"}.com`);
      const stranger = await press(ctxFor(page), "Send code");
      assert.ok("blocked" in stranger && /own value/.test(stranger.blocked), JSON.stringify(stranger));
      assert.equal(posts("/code"), 2);
      // 4. A contact form: a box for a message.
      await page.goto(new URL("/contact", site.url).href);
      await page.fill("#email", "me@example.test");
      const four = await press(ctxFor(page), "Send code");
      assert.ok("blocked" in four && /box to write in|message/.test(four.blocked), JSON.stringify(four));
      // 5. A visitor's test, whatever it was given.
      await page.goto(new URL("/code", site.url).href);
      await page.fill("#email", "me@example.test");
      const five = await press(ctxFor(page, { visitor: true }), "Send code");
      assert.ok("blocked" in five, JSON.stringify(five));
      // 6. A host that isn't the account's.
      const six = await press(ctxFor(page, { codeSends: { host: "staging.example.test", count: { n: 0 } } }), "Send code");
      assert.ok("blocked" in six && /own host/.test(six.blocked), JSON.stringify(six));
      // 7. Three presses, then the fourth is refused.
      const count = { n: 0 };
      for (let k = 0; k < MAX_CODE_SENDS; k++) {
        await page.goto(new URL("/code", site.url).href);
        await page.fill("#email", "me@example.test");
        assert.ok("done" in (await press(ctxFor(page, { codeSends: { host: host(), count } }), "Send code")));
      }
      await page.goto(new URL("/code", site.url).href);
      await page.fill("#email", "me@example.test");
      const seven = await press(ctxFor(page, { codeSends: { host: host(), count } }), "Send code");
      assert.ok("blocked" in seven && /3 codes or links/.test(seven.blocked), JSON.stringify(seven));
      assert.equal(posts("/contact"), 0, "the contact form was never sent");
      assert.equal(posts("/code"), 2 + MAX_CODE_SENDS, "only the allowed presses reached the site");
      // And with no exception at all (a test that isn't signing in): refused, as ever.
      const plain = await press(ctxFor(page, { codeSends: undefined }), "Send code");
      assert.ok("blocked" in plain && /sending or publishing/.test(plain.blocked));
    } finally {
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// C9: sign-ups.

describe("what the AI is told about codes and links", () => {
  it("each made-when-typed value is named and said what it is, never its value", () => {
    const q = actQuestion({ goal: "g", step: { title: "Sign in", intent: "i", check: { kind: "signed_in" } }, n: 1, of: 1, url: "http://x.test/", title: "t", snapshot: "", history: [], vars: ["admin.username", "admin.totp", "admin.email_code", "admin.magic_link"] });
    assert.match(q, /\{admin\.totp\} is an authenticator code, made when it is typed\./);
    assert.match(q, /\{admin\.email_code\} is the code the site emails/);
    assert.match(q, /\{admin\.magic_link\} is the sign-in link the site emails: open it with navigate \{url: "\{admin\.magic_link\}"\}/);
    assert.match(q, /Type each only when the page asks for it/);
    assert.doesNotMatch(actQuestion({ goal: "g", step: { title: "a", intent: "i", check: { kind: "none" } }, n: 1, of: 1, url: "u", title: "t", snapshot: "", history: [], vars: ["email"] }), /made when/);
  });
});

describe("C9: sign-ups only on hosts marked yours, on test domains, each one logged", () => {
  it("test domains only: a real mailbox's domain is refused by name, in the config too", () => {
    for (const yes of ["a@example.com", "a@mail.example.org", "a@example.test", "a@app.localhost", "a@x.invalid"]) assert.ok(signUpDomainAllowed(yes), yes);
    for (const no of [`a@${"gmail"}.com`, `a@${"outlook"}.com`, `a@${"icloud"}.com`, "a@proton.me", "a@mycompany.com", "a@gmail.test.com"]) assert.equal(signUpDomainAllowed(no), false, no);
    assert.throws(() => parseAccounts({ accounts: { n: { first: "sign-up", signUpDomain: "gmail.com", signedIn: { text: "x" } } } }), /test domain/);
    assert.throws(() => parseAccounts({ accounts: { n: { first: "sign-up", username: "a@example.test", signedIn: { text: "x" } } } }), /no stored username/);
  });

  it("each sign-up makes a new address, password and name; none counts as used until typed", () => {
    const account = parseAccounts({ accounts: { "new-user": { first: "sign-up", signedIn: { text: "Sign out" } } } }).accounts.get("new-user")!;
    const a = signUpResolver(account, { host: "h.test", store: fileStore(join(temp(), "s.json")) });
    const b = a.renew!() as typeof a;
    assert.notEqual(a.signUp.email, b.signUp.email);
    assert.notEqual(a.signUp.password, b.signUp.password);
    assert.match(a.signUp.email, /^cm-test-[0-9a-f]{6}@example\.test$/);
    assert.equal(a.signUp.password.length, 24);
    assert.equal(a.peek!("new.email"), a.signUp.email);
    assert.equal(a.used(), false, "told to the masker isn't typed");
    a.get("new.email");
    assert.equal(a.used(), true);
  });

  it("refused on a host not marked yours, without --sign-up, and on live by default", async () => {
    const out = temp();
    const dir = temp("cm-codes-cfg-");
    const cfg = { accounts: { "new-user": { first: "sign-up", codes: [{ catcher: "http://127.0.0.1:9" }], signedIn: { text: "Sign out" } } } };
    writeFileSync(join(dir, "contextmachines.config.json"), JSON.stringify(cfg));
    const store = fileStore(secretsPathFor(out));
    const notMine = accountFor({ dir, outDir: out, url: "http://127.0.0.1:4555/signup", label: "new-user", store });
    assert.ok("error" in notMine && /marked as yours/.test(notMine.error), JSON.stringify(notMine));
    // "It's my own account there" lets an account sign in, never sign up: still refused, by both locks.
    markSignInOk(out, "127.0.0.1:4555");
    const said = accountFor({ dir, outDir: out, url: "http://127.0.0.1:4555/signup", label: "new-user", store });
    assert.ok("error" in said && /SIGNUP_NOT_ALLOWED: .*marked as yours/.test(said.error), JSON.stringify(said));
    const signUpAccount = parseAccounts(cfg).accounts.get("new-user")!;
    const lock2 = await ensureSession({ outDir: out, url: "http://127.0.0.1:4555/signup", account: signUpAccount, resolver: signUpResolver(signUpAccount, { host: "127.0.0.1:4555", store }), mask: makeMasker(), guard: newSignInGuard(), runsDir: join(out, "runs"), allowSignUp: true });
    assert.ok("blocked" in lock2 && lock2.code === "SIGNUP_NOT_ALLOWED", JSON.stringify(lock2));
    markMine(out, "127.0.0.1:4555");
    const use = accountFor({ dir, outDir: out, url: "http://127.0.0.1:4555/signup", label: "new-user", store });
    assert.ok("account" in use, JSON.stringify(use));
    const need = { outDir: out, url: "http://127.0.0.1:4555/signup", account: use.account, resolver: use.resolver, mask: makeMasker(), guard: newSignInGuard(), runsDir: join(out, "runs") };
    const no = await ensureSession(need);
    assert.ok("blocked" in no && no.code === "SIGNUP_NOT_ALLOWED", JSON.stringify(no));
    const live = await ensureSession({ ...need, allowSignUp: true, environment: "live" });
    assert.ok("blocked" in live && live.code === "SIGNUP_NOT_ALLOWED");
    assert.equal(createdAccounts(out).length, 0, "nothing made, nothing logged");
    rmSync(out, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------------------------
// The checkpoint 2 tasks, end to end, with a scripted brain that reads only what the AI is shown.

const refs = (snapshot: string) => [...snapshot.matchAll(/\[(e\d+)\] (\w+) "([^"]*)"/g)].map((m) => ({ ref: m[1]!, role: m[2]!, name: m[3]! }));
const find = (snapshot: string, role: RegExp, name: RegExp) => refs(snapshot).find((r) => role.test(r.role) && name.test(r.name))?.ref;

function codesBrain(prompts: string[]): BrainFor {
  return (noted: AskTiming[], use) => {
    const did = new Set<string>();
    return {
      async plan(goal, url, given, start) {
        prompts.push(JSON.stringify({ goal, url, given, start }));
        noted.push({ what: "plan", model: "scripted", chars: 0, ms: 0, at: 0 });
        if (use.signIn) return [{ title: "Sign in", intent: goal, check: use.signedIn }];
        return [{ title: "Ask for a code", intent: goal, check: { kind: "text_visible", text: "Enter your code" } }];
      },
      async decide(input: DecideInput): Promise<Action> {
        prompts.push(JSON.stringify(input));
        noted.push({ what: "decide", model: "scripted", chars: input.snapshot.length, ms: 0, at: 0 });
        const s = input.snapshot;
        const names = input.vars;
        const signUp = names.includes("new.email");
        const label = signUp ? "new" : "admin";
        const once = (key: string, a: Action): Action | undefined => (did.has(`${input.url}|${key}`) ? undefined : (did.add(`${input.url}|${key}`), a));
        const fields: [RegExp, string][] = [
          [/^full name$/i, "{new.name}"],
          [/^email$/i, signUp ? "{new.email}" : names.includes("admin.username") ? "{admin.username}" : "test+cm@example.com"],
          [/^password$/i, signUp ? "{new.password}" : "{admin.password}"],
          [/^authenticator code$/i, "{admin.totp}"],
          [/^verification code$/i, `{${label}.email_code}`],
        ];
        for (const [name, value] of fields) {
          const ref = find(s, /textbox/, name);
          const a = ref ? once(`fill ${name.source}`, { type: "fill", ref, value }) : undefined;
          if (a) return a;
        }
        const button = find(s, /button/, /^(send code|send me a link|send verification code|verify|sign in|continue)$/i);
        const click = button ? once(`click ${button}`, { type: "click", ref: button }) : undefined;
        if (click) return click;
        if (names.includes("admin.magic_link") && /Check your email/.test(s)) {
          const go = once("magic", { type: "navigate", url: "{admin.magic_link}" });
          if (go) return go;
        }
        return { type: "done" };
      },
    };
  };
}

describe("checkpoint 2 tasks, with a scripted brain", () => {
  let browser: Browser;
  let dir: string;
  before(async () => {
    browser = await launch(false);
    dir = temp("cm-codes-bench-");
  });
  after(async () => {
    await browser?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const cp2 = AUTH_TASKS.filter((t) => t.first || t.totp || ["signup", "no-code", "contact", "visitor"].includes(t.kind));
  it("there are 8 of them", () => assert.equal(cp2.length, 8));
  for (const task of cp2) {
    it(`${task.id}: ${task.mode}`, async () => {
      const prompts: string[] = [];
      const row = await runAuthTask(task, { browser, brainFor: codesBrain(prompts), dir, prompts, inboxWaitMs: 2500 });
      assert.equal(row.leaks.length, 0, JSON.stringify(row.leaks));
      assert.equal(row.right, true, JSON.stringify(row, null, 1));
      assert.equal(row.falsePass, false);
      const all = prompts.join("\n");
      if (task.kind === "sign-in" || task.kind === "signup") {
        assert.equal(row.replayAsks, 0, "the replay asked the AI nothing, and fetched a new code");
        assert.equal(row.signIns, 2);
      }
      if (task.totp) assert.match(all, /\{admin\.totp\}/, "the AI was told the code's handle");
      if (task.id === "au-email-code") assert.match(all, /admin\.email_code/);
      if (task.id === "au-magic") {
        assert.match(all, /\{admin\.magic_link\}/);
        assert.doesNotMatch(all, /access_token|LEAK/, "neither the link's token nor the landing page's reaches the AI");
        // Nothing the run kept holds the landing page's token either.
        const kept = placesIn(join(row.runDir, "contextmachines"), (rel) => rel.startsWith(".auth"));
        assert.equal(kept.filter((p) => /access_token=|LEAK[0-9a-f]{8}/.test(p.text)).length, 0);
      }
      if (task.kind === "signup") {
        assert.equal(row.created, 2, "one audit line per sign-up");
        const created = createdAccounts(join(row.runDir, "contextmachines"));
        assert.ok(created.every((c) => c.status === "left" && /@example\.test$/.test(c.address) && c.passed));
        assert.equal(statSync(join(row.runDir, "contextmachines", ".auth", "created.jsonl")).mode & 0o777, 0o600);
      }
      if (task.kind === "no-code") assert.equal(row.code, task.code);
    });
  }

  it("a link on another port that was allowed opens; one on a host nobody allowed is never opened", async () => {
    const site = await startAuthSite({ users: [{ username: "me@example.test", password: "pw-magic-port" }] });
    const outs: string[] = [];
    try {
      // The link on the other host opens only when that exact host is one you said you sign in on (the
      // password-and-link host rule); allowing it with --allow-host alone isn't enough any more.
      for (const [route, allow, opens, said] of [["/magic-port", ["localhost"], true, true], ["/magic-port", ["localhost"], false, false], ["/magic-elsewhere", [], false, false]] as const) {
        const out = temp();
        outs.push(out);
        markMine(out, new URL(site.url).host);
        if (said) markSignInOk(out, new URL(site.otherUrl).host);
        const store = fileStore(secretsPathFor(out));
        const account = parseAccounts({ accounts: { admin: { first: "magic-link", username: "me@example.test", codes: [{ catcher: site.url }], signInPage: route, signedIn: { text: "Signed in" } } } }).accounts.get("admin")!;
        const resolver = accountResolver(account, { host: new URL(site.url).host, store, env: {}, inboxWaitMs: 2500 });
        const prompts: string[] = [];
        const before = site.hits().filter((h) => h === "/_event/opened/magic-port").length;
        const r = await ensureSession({ outDir: out, url: new URL(route, site.url).href, account, resolver, mask: makeMasker(), guard: newSignInGuard(), browser, runsDir: join(out, "runs"), allowHosts: [...allow], brain: codesBrain(prompts)([], { signIn: true, signedIn: { kind: "signed_in", text: "Signed in" }, names: resolver.names() }) });
        const opened = site.hits().filter((h) => h === "/_event/opened/magic-port").length - before;
        if (opens) assert.equal(opened, 1, `${route}: the allowed link was opened (${JSON.stringify(r).slice(0, 300)})`);
        else if (route === "/magic-port") {
          assert.ok("blocked" in r, `${route} didn't sign in`);
          assert.equal(opened, 0, "a link to a host you didn't say is yours is never opened");
          assert.match(JSON.stringify(r), /the sign-in link is for 127\.0\.0\.1:\d+, and it goes to localhost:\d+/);
        } else {
          assert.ok("blocked" in r, `${route} didn't sign in`);
          assert.equal(opened, 0);
          assert.equal((r as { code?: string }).code, "CODE_NOT_SURE", JSON.stringify(r).slice(0, 300));
        }
      }
    } finally {
      await site.close();
      for (const out of outs) rmSync(out, { recursive: true, force: true });
    }
  });

  it("a visitor's suggested test never presses 'send code' (and the leak check sees no planted value in a code flow's files)", async () => {
    const prompts: string[] = [];
    const row = await runAuthTask(AUTH_TASKS.find((t) => t.id === "au-visitor-send")!, { browser, brainFor: codesBrain(prompts), dir, prompts }, 7);
    assert.equal(row.verdict, "blocked");
    assert.equal(row.problem, undefined, "the site got no send");
    assert.match(row.note ?? "", /wasn't pressed/);
  });
});
