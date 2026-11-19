/**
 * Doing one action, safely, with no AI. An element is found by its role and accessible name (the nth
 * of those), as a saved test finds it on another run. Before anything is pressed or typed:
 *   - the test stays on its starting site: a link, a navigation or a redirect to another registrable
 *     domain ends the step blocked (--allow-host adds hosts; sign-in providers are not added for you);
 *   - a control that reads like paying, buying, booking, subscribing, ordering, sending, publishing,
 *     deleting or cancelling is never pressed, by a click or by Enter or Space on what has focus (read
 *     in the page first, as are the button Enter would submit and a dialog it would say yes to): the
 *     step ends blocked, with the reason (the one exception: a test signed in as a test account, on a
 *     host marked the person's own, may ask for that account's own sign-in code or link: C7 below);
 *   - a value is typed only when it came from the goal, the steps or a --var: a password field takes
 *     a --var only, and a value shaped like a secret that nobody gave is refused.
 */
import type { ElementHandle, Frame, Locator, Page, Request, Route } from "playwright";
import { clerkTokenUrl, onProvider, ownerHeadersFor, type OwnerAccess } from "./access.ts";
import type { Action, CachedAction, Target } from "./types.ts";
import { KNOWN_RULES, withoutSecrets } from "./cache.ts";
import { observe } from "./observe.ts";
import { CHALLENGE_CONTROL, CHALLENGE_REFUSED } from "./botwall.ts";
import { consentHostFor } from "./consent.ts";
import { AUTO, fieldFacts, madeUpValue, refusedMadeUp, type MadeUpRules } from "./values.ts";
import { fillPlaceholders, isPasswordName, ONE_PLACEHOLDER, placeholderNames, usesPlaceholder, type Fresh } from "./placeholders.ts";
import { hrefsToTry, navigateOnReplay, navigateToSave } from "./identity.ts";
import { payGate } from "./paygate.ts";
import { checkoutOf, providerOf, type PayModeResult } from "./paymode.ts";
import { payModeOf } from "./paysurface.ts";
import { basename, extname } from "node:path";
import { readFileSync } from "node:fs";
import { accepts, dragBy, dropFile, downloadsOf, fileInputOf, MIME, saidOf, SCROLL_UNTIL, mainScroller, scrollMark, setRange, sliderOf, slideValue, uploadFile, type Tabs } from "./widgets.ts";

/**
 * Words on a control that mean money, a message or something gone: never pressed. No flag allows it.
 * Each verb in its -s and -ing forms too ("Sending…"), and "pay" as in PayPal or Google Pay.
 */
const DENY: [RegExp, string][] = [
  // A bot check's own control is never pressed, whether or not the page was found to be a wall (botwall.ts states the rule).
  [CHALLENGE_CONTROL, CHALLENGE_REFUSED],
  [/\bpay(s|ing|pal)?\b|\bpayment\b|\b(google|apple|amazon) pay\b|\b(checkout|check out|purchas(e|ing)|buy(s|ing)?|donat(e|ing)|transfer(ring)?|withdraw(ing)?|add funds|top up|tip|pledge|bid)\b/i, "it reads like paying or moving money"],
  [/\b(subscrib(e|ed|es|ing)|start (my |your |a )?(free )?trial|upgrade now|book( now)?|reserv(e|ing))\b/i, "it reads like subscribing, booking or buying"],
  [/\b(place|complete|confirm|submit) (my |your |the )?order\b|\border now\b/i, "it reads like placing an order"],
  [/\b(send(s|ing)?|invit(e|ing)|post(ing)?|repl(y|ying)|publish(ing)?|shar(e|ing)|submit (my |your |the |a )?(message|comment|review|reply|post|feedback|application))\b/i, "it reads like sending or publishing a message, an email or an invite"],
  // A comment, a like or a dislike is said in public, under the visitor's name: a box to write one in included.
  [/\b(comment(ing)?|add a comment|write a comment|leave a comment)\b|^\s*(dis)?lik(e|es|ing)\b|\b(dis)?like (this|the|it)\b|\bthumbs?[ -]?(up|down)\b|^\s*(re)?tweet\b|^\s*follow\b/i, "it reads like commenting, liking or following, which is said in public"],
  [/\b(delet(e|es|ing)|eras(e|es|ing)|wipe|destroy|deactivat(e|ing)|terminat(e|ing)|remov(e|es|ing)|trash|discard|revok(e|ing)|unsubscrib(e|ing))\b|\b(close|cancel) (my |your |the )?(account|subscription|membership|plan)\b|\bleave (the |this )?(team|group|organi[sz]ation|workspace)\b|\bi'?m sure\b/i, "it reads like deleting or cancelling something"],
];

/**
 * A visitor's test (tasks suggested for a site) is done signed out: a control that signs in, signs up
 * or makes an account is never pressed. A test whose goal is a sign-in (test --setup) isn't a visitor's.
 */
const SIGN_IN = /\b(sign(ing)?[ -]?(in|on|up)|log(ging)?[ -]?(in|on)|register|create (an |your |a )?account|join (now|free|for free)|continue with (google|apple|facebook|microsoft|github|x|twitter|linkedin|email|phone)|authori[sz](e|es|ing)|authenticat(e|es|ing))\b/i;

/**
 * What else a visitor never does, as it's said in public or puts their name down: a vote, a rating, a
 * report or a flag, a notification or a waitlist, an application, a quote or an order asked for, a
 * cart, a "+1", or a cookie wall said yes to. Only in a visitor's test: in your own app, "Apply" or
 * "Report" may be the very thing to test.
 */
const VISITOR_DENY = /\b((up|down)?vot(e|es|ing)|rat(e|ing) (this|it|\d)|\d stars?|report (this|video|comment|post|user|abuse|spam|as)|flag (as|this)|notify me|get notified|turn on notifications|notifications? on|(join|get on) (the )?wait ?list|apply (now|for|to (this )?(job|role|position))|request (a |an )?(quote|demo|call ?back|sample)|order (a |an )?(free )?sample|add to (cart|basket|bag)|accept (all|cookies)|allow all)\b|^\s*(\+1|report|flag)\s*$/i;

/** Why a visitor may not press a control with this name, or nothing when they may. */
export function refusedSignedOut(name: string): string | undefined {
  const words = name.replace(/\s+/g, " ").trim();
  if (SIGN_IN.test(words)) return `"${words.slice(0, 60)}" wasn't pressed: it reads like signing in or making an account, and a visitor's test stays signed out`;
  if (VISITOR_DENY.test(words)) return `"${words.slice(0, 60)}" wasn't pressed: it reads like voting, rating, reporting, applying, ordering or signing up for something, which a visitor's test never does`;
  return undefined;
}

/** A change to an account's own security: never made with the person's real account on a site that isn't theirs. */
const SECURITY_SETTINGS = /\b(change (your |my )?(password|e-?mail( address)?)|two[- ]?factor|2fa|security settings|reset (your |my )?password)\b/i;

/**
 * On a site that isn't the person's, signed in with their own account: besides the deny list, it
 * doesn't vote, rate, report, apply, join a list, order or change the account's security (signing in
 * itself is the point, so the sign-in words aren't refused here).
 */
export function refusedOnOwnAccount(name: string): string | undefined {
  const words = name.replace(/\s+/g, " ").trim();
  if (VISITOR_DENY.test(words) || SECURITY_SETTINGS.test(words)) return `"${words.slice(0, 60)}" wasn't pressed: on a site that isn't yours, your own account doesn't vote, rate, report, apply, sign up for things or change its security settings`;
  return undefined;
}

/** Why words like these on a control mean it must not be pressed, or nothing when it may be. */
function deniedWhy(words: string): string | undefined {
  for (const [pattern, why] of DENY) if (pattern.test(words)) return why;
  return undefined;
}

/** Why a control with this name must not be pressed, or nothing when it may be. */
export function refusedName(name: string): string | undefined {
  const words = name.replace(/\s+/g, " ").trim();
  const why = deniedWhy(words);
  return why ? `"${words.slice(0, 60)}" wasn't pressed: ${why}` : undefined;
}

/**
 * W4: a place named as a state a thing can be put in: a board's "Deleted" or "Published" column, a
 * "Trash" zone, a "Mark as paid" box. Its past forms, which the deny list's verbs never meet: never
 * dropped on, nor said yes to in a browser box.
 */
const PLACE_DENY = /\b(delet(ed|ion)|remov(ed|al)|trash(ed)?|bin|recycl(e|ed|ing)( bin)?|archived|discarded|destroyed|published|public|live|sent|outbox|paid|charged|refunded|invoiced|cancel(l)?ed|cancellations?|banned|suspended|deactivated|spam|junk)\b/i;

/** Why a place with these words (a drop zone, a column) mustn't get a thing put in it, or nothing when it may. */
export function refusedPlace(words: string): string | undefined {
  const w = words.replace(/\s+/g, " ").trim();
  return PLACE_DENY.test(w) ? `"${w.slice(0, 60)}" wasn't pressed: it reads like a place where a thing is deleted, published, sent, paid or cancelled` : undefined;
}

/** The deny-list rules a test-mode payment may pass (D14). Every other rule stands. */
const MONEY = /paying or moving money|subscribing, booking or buying|placing an order/;

/** Whether these words trip one of the deny list's money rules (paying or moving money, buying, an order): recover.ts never recovers a form like that. */
export function moneyWords(text: string): boolean {
  const words = text.replace(/\s+/g, " ").trim();
  return DENY.some(([re, why]) => MONEY.test(why) && re.test(words));
}

/**
 * refusedName, with the D14 pay gate: in a run that may pay (ctx.pay), a money word on an owned host
 * with the provider in test mode may be pressed (paygate.ts). `frameUrl`: the address of the
 * document the control is in. A final press it lets through arms the count, which goes up just
 * before the press (so a press that throws still counts: a payment is never tried twice).
 */
function refusedPress(name: string, ctx: ActContext, frameUrl?: string): string | undefined {
  const why = refusedName(name) ?? (ctx.notOwned ? refusedOnOwnAccount(name) : undefined);
  const mode = ctx.pay?.now;
  if (!why || !ctx.pay || !mode || !MONEY.test(why)) return why;
  // Every deny rule the name trips must be a money rule: "Pay and delete my account" stays refused.
  const words = name.replace(/\s+/g, " ").trim();
  if (DENY.some(([re, w]) => re.test(words) && !MONEY.test(w))) return why;
  const top = ctx.page.url();
  // Owned: the top page is on an owned host, or is a provider's page by HOST (the run got there only
  // from an owned host); never "some provider was sighted" (a key in a query string is a sighting).
  const onProviderPage = Boolean(providerOf(top));
  let hosts: string[] = [];
  try {
    hosts = [new URL(top).host, new URL(top).hostname];
  } catch {
    hosts = [];
  }
  // Owned hosts as the person marked them: "localhost:3000", or a host name alone ("127.0.0.1").
  const owned = hosts.some((h) => ctx.pay!.owned.includes(h)) || onProviderPage;
  // The control's own frame counts too: "Subscribe" inside a provider's overlay pays.
  const onProvider = Boolean(checkoutOf(top)) || Boolean(frameUrl && /^https?:/.test(frameUrl) && checkoutOf(frameUrl));
  const g = payGate({ name: words, mode, owned, onProvider, paymentsOn: true, finalPresses: ctx.pay.finalPresses.n });
  if (!g.allow) return `"${words.slice(0, 60)}" wasn't pressed: ${g.why}`;
  if (g.kind === "final") ctx.pay.armed = true;
  return undefined;
}

/** onSite, and in a run that may pay, a payment provider's page or frame (by host only: paymode.providerOf). */
function siteOk(url: string, ctx: ActContext): boolean {
  return onSite(url, ctx.start, ctx.allowHosts) || Boolean(ctx.pay && providerOf(url));
}

/** Where a value may be typed: on the site, or in a pay run on a provider's page or frame whose test mode is seen now. */
function typeOk(url: string, ctx: ActContext): boolean {
  return onSite(url, ctx.start, ctx.allowHosts) || Boolean(ctx.pay?.now?.mayPay && providerOf(url));
}

/**
 * The one exception to "never send" (AUTH C7, decision D1): a button that asks the site to send a
 * sign-in code or link to the test account's own address. Only these words, the whole name, nothing
 * else (a guard test pins the list); never a reset or an invite (that is D1b, not built). It is
 * pressed only when every one of these holds, or the deny list stands:
 *   1. the run signs in as a test account, or signs one up: never a visitor's test;
 *   2. the page is on that account's exact host, where the person said they may sign in (owned, or acknowledged);
 *   3. its words are one of these, whole;
 *   4. its form asks only for an email, a phone, a user name or a code (and, on a sign-up, a name and
 *      a password): never a box for a message, a recipient, a subject or a comment;
 *   5. at most 3 such presses in a run (a site sending real mail in a loop is stopped).
 */
export const SEND_CODE_PHRASES: readonly string[] = [
  "send (the |a |my )?(verification |sign-in |sign in |login )?code",
  "send (me )?(a |the )?(magic |sign-in |sign in |login )?link",
  "email me (a |the )?(code|link|magic link|sign-in link|login link)",
  "text me (a |the )?code",
  "resend (the |a |my )?(verification )?code",
  "send (a )?new code",
  "send verification (code|email)",
  "verify (my )?email",
];

const SEND_CODE = new RegExp(`^(${SEND_CODE_PHRASES.join("|")})$`, "i");

/** At most this many "send code" presses in a run. */
export const MAX_CODE_SENDS = 3;

/** Whether a control's whole name is one of the "send code / send link" words. */
export function sendCodeWords(name: string): boolean {
  return SEND_CODE.test(name.replace(/\s+/g, " ").replace(/[\s.!…→>›]+$/u, "").trim());
}

/** What a form asks for, read in the page (self-contained): each field, as the C7 rule needs it. */
function codeFormFields(e: Element | null): { tag: string; type: string; said: string; editable: boolean; value: string; doc: string }[] {
  if (!e) return [];
  const form = (e as HTMLButtonElement).form ?? e.closest("form") ?? e.closest("dialog, [role=dialog]");
  const scope: ParentNode = form ?? e.ownerDocument;
  const visible = (x: Element) => (x as HTMLElement).offsetParent !== null || (x as HTMLElement).getClientRects().length > 0;
  return [...scope.querySelectorAll("input, textarea, select, [contenteditable]:not([contenteditable=false])")]
    .filter((x) => visible(x) && !["hidden", "submit", "button", "image", "reset", "checkbox", "radio"].includes(((x as HTMLInputElement).type ?? "").toLowerCase()))
    .slice(0, 20)
    .map((x) => {
      const i = x as HTMLInputElement;
      // Each word once ("email" as its name, id, type and label is said once).
      const said = [...new Set([i.name, x.id, x.getAttribute("aria-label"), x.getAttribute("placeholder"), x.getAttribute("autocomplete"), ...[...(i.labels ?? [])].map((l) => l.textContent)].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().toLowerCase().split(" "))].join(" ");
      // What it holds now, compared (never shown) with the account's own values by the caller.
      return { tag: x.tagName.toLowerCase(), type: (x.getAttribute("type") ?? (x.tagName === "INPUT" ? "text" : "")).toLowerCase(), said, editable: (x as HTMLElement).isContentEditable && x.tagName !== "INPUT" && x.tagName !== "TEXTAREA", value: typeof i.value === "string" ? i.value : "", doc: x.ownerDocument.URL };
    });
}

/** A field a "send code" form may hold: who signs in, or the code; a sign-up's name and password too. */
const CODE_FORM_FIELD = /\b(e-?mail|phone|mobile|tel|user ?name|username|login|code|otp|one[- ]?time|verification)\b/;
const SIGN_UP_FIELD = /\b(name|given-name|family-name|first|last|full ?name|password|new-password)\b/;
const NEVER_IN_CODE_FORM = /\b(message|recipients?|invite(e)?s?|invite email|subject|comments?|feedback)\b|^to\b/;
/** A field that says where the code or link goes: it must hold the account's own address, number or name. */
const RECIPIENT_FIELD = /\b(e-?mail|phone|mobile|tel|user ?name|username|login)\b/;

/**
 * Whether a value in a "send code" form is the test account's own (or a value the person gave): the
 * masker knows it as one of the run's values ({admin.username}, {new.email}, a --var), or the person
 * wrote it in their goal or steps. A made-up address is never sent a code or a link.
 */
function ownValue(ctx: ActContext, value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  // One name, or two that share the value ("{admin.username or coder.username}": two accounts, one address).
  const said = /^\{([\w.-]+(?: or [\w.-]+)*)\}$/.exec(ctx.mask(v).trim());
  if (said && !said[1]!.split(" or ").includes("site.access")) return true;
  return ctx.values.fromPerson !== undefined && saidBy(v, ctx.values.fromPerson);
}

/**
 * Why this "send code" press isn't allowed (conditions 2, 4 and 5), or nothing: the press is then
 * counted. Its words (3) and the run (1) were checked by the caller.
 */
async function codeSendRefused(ctx: ActContext, fields: Awaited<ReturnType<typeof codeFormFields>>, name: string): Promise<string | undefined> {
  const sends = ctx.codeSends!;
  const words = `"${name.replace(/\s+/g, " ").trim().slice(0, 60)}" wasn't pressed`;
  let host = "";
  try {
    host = new URL(ctx.page.url()).host;
  } catch {
    // not an address
  }
  // The button's own page, when it is inside an embedded one: its host too must be the account's.
  for (const f of fields.slice(0, 1)) {
    try {
      if (/^https?:/.test(f.doc) && new URL(f.doc).host !== host) host = new URL(f.doc).host;
    } catch {
      // not an address
    }
  }
  if (host !== sends.host) return `${words}: a code or link is asked for only on the test account's own host (${sends.host}), and this page is on ${host || "another page"}`;
  for (const f of fields) {
    if (f.tag === "textarea" || f.editable) return `${words}: its form has a box to write in, so it may send a message`;
    if (NEVER_IN_CODE_FORM.test(f.said)) return `${words}: its form has a field for a message, a recipient, a subject or a comment ('${ctx.mask(f.said.slice(0, 40))}')`;
    const allowed = CODE_FORM_FIELD.test(f.said) || f.type === "email" || f.type === "tel" || (sends.signUp && (SIGN_UP_FIELD.test(f.said) || f.type === "password"));
    if (!allowed) return `${words}: its form asks for more than who signs in ('${ctx.mask(f.said.slice(0, 40)) || f.type}'), so it may not be a sign-in`;
    // Where the code goes must be the account's own: never an address or number the AI made up.
    const recipient = f.type === "email" || f.type === "tel" || (RECIPIENT_FIELD.test(f.said) && !/\b(code|otp|one[- ]?time|verification)\b/.test(f.said) && f.type !== "password");
    if (recipient && !ownValue(ctx, f.value)) {
      const own = [...(ctx.accountNames ?? [])].find((n) => n.endsWith(".username"));
      return `${words}: its '${ctx.mask(f.said.slice(0, 30)) || f.type}' field doesn't hold the test account's own value, so a code or link could go to someone else: fill it with ${own ? `{${own}}` : "the account's own address"}`;
    }
  }
  if (sends.count.n >= MAX_CODE_SENDS) return `${words}: ${MAX_CODE_SENDS} codes or links were asked for already in this run, the most it allows (the site may be sending mail in a loop)`;
  sends.count.n++;
  return undefined;
}

/** The deny rules that hold for a field to type into: a box to write a message, a post or a comment in is said in public. */
const SPEECH = DENY.filter(([, why]) => /sending or publishing|commenting/.test(why));

/**
 * Why a field labelled so isn't typed into (its label, placeholder and title, never what it holds):
 * one to write a message, a post or a comment in; and in a visitor's test, one that signs in or puts
 * their name down. Money words don't stop typing ("Amount"): what would send it is checked when pressed.
 */
function refusedField(label: string, visitor?: boolean): string | undefined {
  const words = label.replace(/\s+/g, " ").trim();
  if (!words) return undefined;
  for (const [pattern, why] of SPEECH) if (pattern.test(words)) return `"${words.slice(0, 60)}" wasn't typed into: ${why}`;
  return visitor ? refusedSignedOut(words)?.replace("wasn't pressed", "wasn't typed into") : undefined;
}

/** A button that only says yes: refused inside a dialog that reads like one of the above ("Delete 3 invoices?" → "OK"). */
const CONFIRMS = /^(ok|okay|yes\b.*|confirm|continue|proceed|i understand|agree|accept|do it|go ahead)$/i;

/** Two-part public suffixes common enough to matter ("example.co.uk" is one site, not "co.uk"). */
const SECOND_LEVEL = /^(co|com|net|org|gov|ac|edu|ltd|plc|ne|or|go)\.[a-z]{2}$/;

/**
 * Hosts where each name under them is someone else's site ("alice.github.io" and "bob.github.io"
 * aren't one site): the common ones of the public suffix list's private part.
 */
const SHARED_HOSTS = [
  "github.io", "gitlab.io", "vercel.app", "netlify.app", "pages.dev", "workers.dev", "herokuapp.com", "web.app", "firebaseapp.com",
  "azurewebsites.net", "azurestaticapps.net", "cloudfront.net", "onrender.com", "fly.dev", "s3.amazonaws.com", "blogspot.com",
  "glitch.me", "replit.app", "repl.co", "surge.sh", "ngrok.io", "ngrok-free.app", "trycloudflare.com", "appspot.com", "wordpress.com",
];

/** The registrable domain of a host: "docs.example.co.uk" → "example.co.uk", "a.b.myapp.vercel.app" → "myapp.vercel.app". A machine's own name or address stays whole. */
export function siteOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || /^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("[")) return h.endsWith(".localhost") ? "localhost" : h;
  const parts = h.split(".");
  const shared = SHARED_HOSTS.find((s) => h === s || h.endsWith(`.${s}`));
  if (shared) return parts.slice(-(shared.split(".").length + 1)).join(".");
  if (parts.length <= 2) return h;
  const lastTwo = parts.slice(-2).join(".");
  return SECOND_LEVEL.test(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

/** Whether an address is on the test's site, or on a host it was allowed. Anything that isn't http(s) is not (but about:blank). */
export function onSite(address: string, start: string, allowHosts: readonly string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(address, start);
  } catch {
    return false;
  }
  if (url.href === "about:blank") return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (siteOf(host) === siteOf(new URL(start).hostname)) return true;
  return allowHosts.some((a) => {
    const allowed = a.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    // Named with its port (localhost:4000): that host on that port only.
    if (/:\d+$/.test(allowed) && !allowed.startsWith("[")) return url.host.toLowerCase() === allowed;
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

/**
 * The element a target names, now: by role and accessible name, the nth of those. A target with no
 * name is the nth of those with no name, never the nth of every element of its role (that could be
 * "Delete account"). Where that finds too few (one inside a shadow root) and the snapshot's ref is
 * at hand, the ref the actor named. The rules a saved test made before matching rules had a version
 * (see locateSaved) replay through exactly this.
 */
export async function locate(page: Page, target: Target & { ref?: string }): Promise<Locator> {
  if (target.role === "item") return itemsNamed(page, target).nth(target.nth);
  const role = target.role as Parameters<Page["getByRole"]>[0];
  const all = target.name ? page.getByRole(role, { name: target.name, exact: true }) : page.getByRole(role, { name: /^$/ });
  if (target.ref && (await all.count().catch(() => 0)) <= target.nth) return page.locator(`aria-ref=${target.ref}`);
  return all.nth(target.nth);
}

/** What the actor is told when the element it named has gone since the look it chose from. */
export const STALE = "that element has gone from the page since the last look (look again)";

/** The element the actor named by its number in the latest look, itself: never another of the same name. */
export async function locateLive(page: Page, ref: string): Promise<{ el: Locator } | { missing: string; stale: true }> {
  const el = page.locator(`aria-ref=${ref}`);
  const n = await el.count().catch(() => 0);
  return n === 1 ? { el } : { missing: STALE, stale: true };
}

/**
 * W5: the element the actor named, drawn again since the look (a form redrawn on each key, a list
 * re-rendered by a timer): its number is gone, but a person still sees the same thing. Found again by
 * a fresh look, by its role and name, only when it was the only one with them in that look and is the
 * only one now, and the same is around it (its row's other words and controls, never a field's value):
 * never one of several (the wrong row's button), never "Approve" on another record drawn in its place,
 * never with no name, never inside an embedded page. Every rule a press or a fill meets is then met on
 * the element found, as on any other.
 */
export async function refind(page: Page, target: Target & { same?: number; around?: string }): Promise<Locator | undefined> {
  if (!target.name.trim() || target.frame || target.nth !== 0 || target.same !== 1 || !target.around) return undefined;
  const now = await observe(page).catch(() => undefined);
  if (!now) return undefined;
  const all = [...now.refs.values()].filter((t) => t.role === target.role && t.name === target.name && !t.frame);
  const one = all.length === 1 ? all[0]! : undefined;
  if (!one || one.same !== 1 || one.around !== target.around) return undefined;
  const el = page.locator(`aria-ref=${one.ref}`);
  return (await el.count().catch(() => 0)) === 1 ? el : undefined;
}

/** The matching rules a saved test is replayed by: 2 adds the counts (`of`), a test id, a link's address, words, and what an item is in. */
export const RULES = KNOWN_RULES;

/** Every visible plain row with these words (an item), inside what it was in when there is one: the deepest element that holds just them. */
function itemsNamed(page: Page | Frame, target: Pick<Target, "name" | "within">): Locator {
  // A long row's name was cut ("…"): it is the row that starts with those words.
  const cut = target.name.endsWith("…");
  const words = target.name.replace(/…$/, "").split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const text = new RegExp(`^\\s*${words.join("\\s*")}${cut ? "" : "\\s*$"}`);
  return itemScope(page, target).getByText(text).filter({ visible: true });
}

/** Where an item is looked for: inside what it was in, when that was saved; else the whole page. */
function itemScope(page: Page | Frame, target: Pick<Target, "within">): Locator {
  const w = target.within;
  return w ? page.getByRole(w.role as Parameters<Page["getByRole"]>[0], w.name ? { name: w.name, exact: true } : { name: /^$/ }) : page.locator(":root");
}

/**
 * Runs in the page, self-contained: for each element, what it sits under (the nearest heading before
 * it in a box that holds both, or its row's other words) and the link it is or is in. Same-named
 * controls in a list ("Details" under each invoice) are told apart by this, not by their place.
 */
function contextFacts(els: Element[]): { near: string; href: string }[] {
  const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const nearOf = (e: Element): string => {
    let depth = 0;
    for (let p = e.parentElement; p && p !== e.ownerDocument.body && depth < 8; p = p.parentElement, depth++) {
      const heads = [...p.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]")].filter((h) => !h.contains(e) && !e.contains(h) && Boolean(h.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING));
      const last = heads.at(-1);
      if (last && norm(last.textContent)) return `h:${norm(last.textContent).slice(0, 60)}`;
      if (p.matches("li, tr, [role=row], [role=listitem], article, [role=article]")) {
        const own = norm(e.textContent);
        const row = norm(p.textContent);
        const rest = norm(own ? row.replace(own, " ") : row);
        if (rest) return `r:${rest.slice(0, 60)}`;
      }
    }
    return "";
  };
  return els.map((e) => ({ near: nearOf(e), href: e.closest("a[href]")?.getAttribute("href") ?? "" }));
}

/** A frame's address as a target names it: its path, no query. */
const framePath = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
};

/** Where a target is looked for: the page, or the embedded page of the same site it was saved in (by its path, and which of those it was). */
export function scopeOf(page: Page, t: Pick<Target, "frame">): Page | Frame | undefined {
  if (!t.frame) return page;
  return page.frames().filter((f) => f !== page.mainFrame() && framePath(f.url()) === t.frame!.path)[t.frame.nth];
}

/** A test id, as a CSS selector over the three attributes sites use. */
const testIdSelector = (id: string) => ["data-testid", "data-test", "data-qa"].map((a) => `[${a}="${id.replace(/["\\]/g, "\\$&")}"]`).join(",");

export type Located = { el: Locator } | { missing: string; /** More or fewer match than when it was saved: which is meant can't be told. */ ambiguous?: true };

/**
 * A saved target, found again. A test saved before the rules had a number replays as it always did
 * (role, name, nth). Under rules 2: a test id must match exactly one element; role and name must
 * match as many as when it was saved (`of`), or the target is ambiguous and is never clicked by its
 * place alone; then its link address, then its words, each only when exactly one matches. Never an
 * element of another role.
 */
export async function locateSaved(top: Page, target: Target, rules?: number, moved?: { savedOrigin?: string; start: string }): Promise<Located> {
  if (!rules) return { el: await locate(top, target) };
  // One saved inside an embedded page is looked for there only: never on the page around it.
  const page = scopeOf(top, target);
  if (!page) return { missing: "the embedded page it was in isn't there" };
  const count = (l: Locator) => l.count().catch(() => 0);
  if (target.testid) {
    const el = page.locator(testIdSelector(target.testid)).filter({ visible: true });
    const n = await count(el);
    if (n === 1) return { el };
    if (n > 1) return { missing: `${n} elements carry its test id`, ambiguous: true };
  }
  // What it said or where it led, each only when exactly one matches: for one with no name, before
  // its place (a reordered list of pictures keeps each address with its picture).
  const byAddress = async (): Promise<Locator | undefined> => {
    if (target.href && target.role === "link") {
      // On another address of the same app, an absolute href on the saved origin is tried there too.
      for (const href of moved ? hrefsToTry(target.href, moved.savedOrigin, moved.start) : [target.href]) {
        const el = page.locator(`a[href="${href.replace(/["\\]/g, "\\$&")}"]`).filter({ visible: true });
        if ((await count(el)) === 1) return el;
      }
    }
    if (target.text) {
      const el = target.role === "item" ? itemScope(page, target).getByText(target.text).filter({ visible: true }) : page.getByRole(target.role as Parameters<Page["getByRole"]>[0], { includeHidden: true }).filter({ hasText: target.text }).filter({ visible: true });
      if ((await count(el)) === 1) return el;
    }
    return undefined;
  };
  if (!target.name) {
    const el = await byAddress();
    if (el) return { el };
  }
  const all = target.role === "item" ? itemsNamed(page, target) : target.name ? page.getByRole(target.role as Parameters<Page["getByRole"]>[0], { name: target.name, exact: true }) : page.getByRole(target.role as Parameters<Page["getByRole"]>[0], { name: /^$/ });
  const n = await count(all);
  // Several of the same name when it was saved: what each sits under, then where each leads, before
  // its place (a list sorted the other way keeps "Details" with its invoice).
  if (n > 0 && (target.near || (target.href && target.name))) {
    const facts = await all.evaluateAll(contextFacts).catch(() => [] as { near: string; href: string }[]);
    if (target.near) {
      const at = facts.flatMap((f, i) => (f.near === target.near ? [i] : []));
      if (at.length === 1) return { el: all.nth(at[0]!) };
    }
    if (target.href && target.name) {
      const at = facts.flatMap((f, i) => (f.href === target.href ? [i] : []));
      if (at.length === 1) return { el: all.nth(at[0]!) };
    }
    // What it was under is nowhere now: which one is meant can't be told.
    if (target.near && !facts.some((f) => f.near === target.near)) return { missing: `none of the ${n} that match sits where it did when it was saved`, ambiguous: true };
  }
  // `of` 0: it wasn't among those role and name count when it was saved, so its place among them means nothing.
  if (n > target.nth && (target.of === undefined || n === target.of)) return { el: all.nth(target.nth) };
  if (target.name) {
    const el = await byAddress();
    if (el) return { el };
  }
  if (!n) return { missing: "it isn't on the page" };
  return { missing: `${n} match now, where ${target.of ?? "fewer"} did when it was saved`, ambiguous: true };
}

/** Whether two names say anything alike: a word in common (any case), or either has no words. */
function shareAWord(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return true;
  for (const w of x) if (y.has(w)) return true;
  return false;
}

/**
 * What a live element is saved as, read before it is pressed (it may be gone after): its place
 * among those of its role and name as locateSaved counts them, how many there were, and, where
 * that alone won't find it again (it's hidden from roles, or has no name), its link or its words.
 */
async function savedIdentity(top: Page, el: Locator, t: Target, info: Inspected, mask: (s: string) => string): Promise<Target> {
  const page = scopeOf(top, t) ?? top;
  const all = t.role === "item" ? itemsNamed(page, t) : t.name ? page.getByRole(t.role as Parameters<Page["getByRole"]>[0], { name: t.name, exact: true }) : page.getByRole(t.role as Parameters<Page["getByRole"]>[0], { name: /^$/ });
  let nth = -1;
  let of = 0;
  try {
    const handle = await el.elementHandle({ timeout: 2000 });
    [nth, of] = await all.evaluateAll((els, h) => [els.indexOf(h as HTMLElement), els.length], handle);
    await handle?.dispose();
  } catch {
    // read nothing: saved as the snapshot counted it
  }
  // Not among those role and name count (hidden from roles): saved with `of` 0, so a replay never
  // takes its place among them for it.
  const out: Target = { role: t.role, name: t.name, nth: nth >= 0 ? nth : t.nth, of: nth >= 0 ? of : 0, ...(t.within ? { within: t.within } : {}), ...(t.frame ? { frame: t.frame } : {}) };
  if (info.testid && info.testid.length <= 100) out.testid = info.testid;
  let href: string | undefined;
  if (info.href && !/^(#|javascript:)/i.test(info.href)) {
    try {
      const abs = new URL(info.href, page.url());
      if (abs.origin === new URL(page.url()).origin && withoutSecrets(abs.href) === abs.href && info.href.length <= 300) href = info.href;
    } catch {
      // not an address
    }
  }
  if (nth < 0 || !t.name) {
    if (href) out.href = href;
    else if (info.text) out.text = mask(info.text.slice(0, 60));
  } else if (of > 1) {
    // Several of the same name: what it sits under, and where it leads, tell it from the others.
    if (href && t.role === "link") out.href = href;
    const near = await all.evaluateAll(contextFacts).then((f) => f[nth]?.near ?? "", () => "");
    if (near && mask(near) === near && near.length <= 80) out.near = near;
  }
  return out;
}

/** Why an action failed, in words the actor can use, and what kind of failure it was: never Playwright's call log. */
export type ErrorKind = "covered" | "hidden" | "stale" | "disabled" | "other";

/** Runs in the page: what covers the middle of an element, named as a person would (a layer by what has focus in it, a dialog, a label). Self-contained. */
function coverOf(e: Element): { name: string; what: string } {
  const label = (x: Element | null) => (x ? (x.getAttribute("aria-label") || x.getAttribute("placeholder") || x.getAttribute("title") || x.getAttribute("alt") || "").replace(/\s+/g, " ").trim() : "");
  const r = e.getBoundingClientRect();
  const c = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!c || c === e || e.contains(c)) return { name: "", what: "" };
  let layer: Element = c;
  // W5: the cover's own branch, never a box that also holds the element (an app drawn in one root <div>
  // is the page, not a layer in front of it).
  while (layer.parentElement && layer.parentElement !== document.body && layer.parentElement !== document.documentElement && !layer.parentElement.contains(e)) layer = layer.parentElement;
  let a = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  if (a && a !== document.body && layer.contains(a) && label(a)) {
    const kind = a.tagName === "INPUT" && (a as HTMLInputElement).type === "search" ? "search box" : a.tagName === "INPUT" || a.tagName === "TEXTAREA" ? "text box" : (a.getAttribute("role") || a.tagName.toLowerCase());
    return { name: label(a), what: `layer:${kind}` };
  }
  const dialog = c.closest("dialog, [role=dialog], [role=alertdialog], [aria-modal=true]");
  if (dialog && label(dialog) && !dialog.contains(e)) return { name: label(dialog), what: "dialog" };
  for (let x: Element | null = c; x && x !== document.body && !x.contains(e); x = x.parentElement) if (label(x)) return { name: label(x), what: "" };
  // W5: a bar fixed to the screen (an app banner, a sticky footer) over the element: named by its words.
  for (let x: Element | null = c; x && x !== document.body && !x.contains(e); x = x.parentElement) {
    const pos = getComputedStyle(x).position;
    if (pos === "fixed" || pos === "sticky") return { name: ((x as HTMLElement).innerText || "").replace(/\s+/g, " ").trim().slice(0, 60), what: "fixed" };
  }
  return { name: ((c as HTMLElement).innerText || "").replace(/\s+/g, " ").trim().slice(0, 60), what: "" };
}

/** A tag in Playwright's call log, named by its label: `<div aria-label="Newsletter sign-up">` → "Newsletter sign-up". */
function tagLabel(tag: string | undefined): string {
  if (!tag) return "";
  for (const a of ["aria-label", "placeholder", "title", "alt"]) {
    const m = new RegExp(`\\b${a}="([^"]*)"`).exec(tag);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return "";
}

const quoted = (s: string, mask: (s: string) => string) => `"${mask(s.replace(/\s+/g, " ").trim().slice(0, 60))}"`;

/**
 * Playwright's error as the actor should hear it: covered (and by what), hidden, off screen,
 * disabled, gone; anything else, its first line. Names are quoted, clipped and masked. `el`, when
 * given, is read once in the page for what covers it.
 */
export async function explainError(message: string, o: { verb?: string; el?: Locator; mask?: (s: string) => string } = {}): Promise<{ error: string; kind: ErrorKind }> {
  const mask = o.mask ?? ((s: string) => s);
  const verb = o.verb ?? "click";
  const covers = [...message.matchAll(/(<[^>\n]+>)[^\n]*?(?: from (<[^>\n]+>)[^\n]*?)? (?:subtree )?intercepts pointer events/g)].at(-1);
  if (covers) {
    let by = "";
    const read = o.el ? await o.el.evaluate(coverOf, undefined, { timeout: 1500 }).catch(() => undefined) : undefined;
    if (read?.what.startsWith("layer:") && read.name) by = `an open layer (${quoted(read.name, mask)} ${read.what.slice(6)})`;
    else if (read?.what === "dialog" && read.name) by = `a dialog (${quoted(read.name, mask)})`;
    else if (read?.what === "fixed") return { error: `didn't ${verb}: it's covered by a bar fixed on the screen${read.name ? ` (${quoted(read.name, mask)})` : ""}: close the bar with its own button (a close, "Not now" or "Dismiss"), or scroll so it no longer covers`, kind: "covered" };
    else {
      const named = tagLabel(covers[1]) || tagLabel(covers[2]) || read?.name || "";
      by = named ? quoted(named, mask) : "something else on the page";
    }
    return { error: `didn't ${verb}: it's covered by ${by}: use what is open, or press Escape to close it`, kind: "covered" };
  }
  if (/element is not attached|element was detached|not attached to the DOM|frame was detached/i.test(message)) return { error: STALE, kind: "stale" };
  // A date, time or date-and-time box given a value in another shape (Playwright's "Malformed value"; its log also says "visible").
  if (/malformed value/i.test(message)) return { error: `didn't ${verb}: the value isn't written the way this box takes it (a date box takes 2026-11-18, a date-and-time box 2026-11-18T09:00, a time box 09:00)`, kind: "other" };
  if (/outside of the viewport/i.test(message)) return { error: `didn't ${verb}: it's off screen and couldn't be scrolled to`, kind: "hidden" };
  if (/element is not enabled|element is disabled|\bdisabled\b/i.test(message)) return { error: `didn't ${verb}: it's disabled`, kind: "disabled" };
  if (/element is not visible|waiting for element to be visible/i.test(message)) return { error: `didn't ${verb}: it isn't visible now (it may be in a closed menu: open the menu first)`, kind: "hidden" };
  return { error: mask(message.split("\n")[0]!.slice(0, 160)), kind: "other" };
}

/**
 * A click as a person makes it, failing fast only when something covers it: tried first without
 * pressing (about 2.5s when covered), scrolled to once if need be, then pressed. One that is just not
 * ready yet (disabled, not shown, moving) gets the click's whole wait, as it always did; a checkbox,
 * radio or switch drawn hidden fails fast, so it is clicked through its label (`fast`).
 */
async function pressClick(el: Locator, fast?: RegExp): Promise<void> {
  try {
    await el.click({ trial: true, timeout: 2500 });
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    if (/intercepts pointer events/.test(said)) {
      await el.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
      await el.click({ trial: true, timeout: 1200 });
    } else if (/outside of the viewport/.test(said)) {
      await el.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
    } else if (fast?.test(said)) {
      throw error;
    }
  }
  await el.click({ timeout: ACTION_MS });
}

/** How an element is named in a label: "'Docs' link". */
const named = (t: Target, mask: (s: string) => string) => `${t.name ? `'${mask(t.name).slice(0, 60)}' ` : ""}${t.role}`;

/** An action as a person would say it, with --var values never shown: "Filling '{password}' into 'Password' textbox". */
export function labelOf(action: CachedAction, mask: (s: string) => string = (s) => s): string {
  switch (action.type) {
    case "click":
      return `Clicking on ${named(action.target, mask)}`;
    case "hover":
      return `Hovering over ${named(action.target, mask)}`;
    case "fill":
      return `Filling ${action.madeUp ? "made-up " : ""}'${mask(action.value).slice(0, 60)}' into ${named(action.target, mask)}`;
    case "select":
      return `Selecting ${action.madeUp ? "made-up " : ""}'${mask(action.value).slice(0, 60)}' in ${named(action.target, mask)}`;
    case "type":
      return `Typing ${action.madeUp ? "made-up " : ""}'${mask(action.value).slice(0, 60)}' into ${action.into ? named(action.into, mask) : "the focused field"}`;
    case "press":
      return `Pressing ${action.key}`;
    case "scroll":
      return `Scrolling ${action.direction}${action.target ? ` in ${named(action.target, mask)}` : ""}`;
    case "navigate":
      return `Going to ${mask(action.url).slice(0, 100)}`;
    case "wait":
      return `Waiting ${(action.ms / 1000).toFixed(1)}s`;
    case "back":
      return "Going back";
    case "dblclick":
      return `Double-clicking on ${named(action.target, mask)}`;
    case "rightclick":
      return `Right-clicking on ${named(action.target, mask)}`;
    case "check":
      return `Checking ${named(action.target, mask)}`;
    case "uncheck":
      return `Unchecking ${named(action.target, mask)}`;
    case "scroll_to":
      return `Scrolling to '${mask(action.text).slice(0, 60)}'${action.target ? ` in ${named(action.target, mask)}` : ""}`;
    case "upload":
      return `Uploading '${mask(/[\\/]/.test(action.value) ? basename(action.value) : action.value).slice(0, 60)}' to ${named(action.target, mask)}`;
    case "drag":
      return `Dragging ${action.target ? named(action.target, mask) : `'${mask(action.from ?? "").slice(0, 60)}'`} onto ${action.to ? named(action.to, mask) : `'${mask(action.onto ?? "").slice(0, 60)}'`}`;
    case "drag_at":
      return `Dragging ${named(action.target, mask)} by ${action.value.slice(0, 20)} px`;
    case "slide":
      return `Setting ${named(action.target, mask)} to ${mask(action.value).slice(0, 20)}`;
    case "switch_tab":
      return `Switching to tab ${action.value.slice(0, 4)}`;
    case "download":
      return `Downloading from ${named(action.target, mask)}`;
    case "click_at":
      return `Clicking at (${Math.round(action.x)}, ${Math.round(action.y)})${action.name ? ` on '${mask(action.name).slice(0, 60)}'` : ""}`;
  }
}

/**
 * W5: runs in the page, self-contained. What is at a point of the screen, through shadow roots: whether
 * it is something only drawn (a canvas, an svg, a picture, a plain box) or a control a person names (a
 * button, a link, a field: those are pressed by their number, never by a point), or an embedded page.
 */
function atPoint(at: [number, number]): { el: Element | null; drawn: boolean; control: string; frame: boolean; words: string[] } {
  let el: Element | null = document.elementFromPoint(at[0], at[1]);
  for (let i = 0; el?.shadowRoot && i < 20; i++) {
    const inner: Element | null = el.shadowRoot.elementFromPoint(at[0], at[1]);
    if (!inner || inner === el) break;
    el = inner;
  }
  if (!el) return { el: null, drawn: false, control: "", frame: false, words: [] };
  const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const frame = el.tagName === "IFRAME" || el.tagName === "FRAME" || el.tagName === "OBJECT" || el.tagName === "EMBED";
  const drawn = /^(CANVAS|IMG|VIDEO|PICTURE)$/.test(el.tagName) || Boolean(el.closest("svg"));
  // The press reaches every element around the point (a click bubbles up, through shadow roots to their
  // hosts): each is read. A control a person names (a button, a link, a field, or a box clickable by its
  // code: an onclick, a tabindex, its own pointer cursor) is pressed by its number, never by a point.
  const CONTROL = "a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem], [role=option], [contenteditable=true]";
  const up = (e: Element): Element | null => e.parentElement ?? ((e.getRootNode() as ShadowRoot).host ?? null);
  const BOUNDARY = /^(TR|LI|ARTICLE|SECTION|FORM|DIALOG|MAIN|BODY|HTML)$/;
  const words: string[] = [];
  let control = "";
  let bounded = false;
  for (let e: Element | null = el, depth = 0; e && e !== e.ownerDocument.documentElement && depth < 40; e = up(e), depth++) {
    const label = norm(e.getAttribute("aria-label") || e.getAttribute("title") || e.getAttribute("alt"));
    const own = norm((e as HTMLElement).innerText ?? e.textContent);
    const tab = e.getAttribute("tabindex");
    const parent = up(e);
    const pointer = getComputedStyle(e).cursor === "pointer" && !(parent && getComputedStyle(parent).cursor === "pointer");
    const coded = e.hasAttribute("onclick") || typeof (e as HTMLElement).onclick === "function" || (tab !== null && Number(tab) >= 0) || pointer;
    const isControl = e.matches(CONTROL) || (e !== el && coded) || (e === el && !drawn && coded);
    // What a press here could set off, read by the deny rules: every name around the point up to its row
    // or section, and the words of each element there that says it takes a click.
    if (!bounded) {
      if (label) words.push(label);
      if ((isControl || coded) && own && own.length <= 200) words.push(own);
    } else if (isControl && (label || own)) words.push(label || own.slice(0, 200));
    if (isControl && !control && (label || own)) {
      const role = e.getAttribute("role") || e.tagName.toLowerCase();
      control = `${role} "${(label || own).slice(0, 60)}"`;
    }
    if (BOUNDARY.test(e.tagName) || /^(row|listitem|article|region|dialog|form)$/.test(e.getAttribute("role") ?? "")) bounded = true;
  }
  return { el, drawn, control, frame, words: [...new Set(words)].slice(0, 30) };
}

/**
 * Keys the actor may press: the ones a person uses to move about and submit, and the shortcuts sites
 * open their search with (Ctrl+K, ⌘K, "/"); never another shortcut that could do anything else.
 */
const KEYS = /^(Enter|Escape|Tab|Shift\+Tab|Space|Backspace|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|Home|End|Control\+K|Meta\+K|\/)$/;

/** The search shortcuts: what has focus is read first ("/" in a text field would type a slash). */
const SHORTCUTS = new Set(["Control+K", "Meta+K", "/"]);

/**
 * What has keyboard focus, read in the page: through shadow roots, and into an embedded page the
 * page may read (same origin). One of another site can't be read, so it is the frame itself.
 */
function deepFocus(): Element | null {
  let a = document.activeElement;
  for (let depth = 0; depth < 5; depth++) {
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    if (!a || (a.tagName !== "IFRAME" && a.tagName !== "FRAME")) break;
    let inner: Document | null = null;
    try {
      inner = (a as HTMLIFrameElement).contentDocument;
    } catch {
      inner = null;
    }
    if (!inner?.activeElement || inner.activeElement === inner.body) break;
    a = inner.activeElement;
  }
  return a;
}

/** Runs in the page: whether this element has the keyboard focus now (through shadow roots). */
function hasFocus(e: Element): boolean {
  let a = e.ownerDocument.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a === e;
}

/** Runs in the page: a field that suggests as it is typed into (a search box, a combobox, one with a list). */
function suggests(e: Element): boolean {
  const role = (e.getAttribute("role") || "").toLowerCase();
  const input = e as HTMLInputElement;
  return role === "combobox" || role === "searchbox" || e.hasAttribute("aria-autocomplete") || (e.tagName === "INPUT" && (input.type === "search" || Boolean(input.list)));
}

/**
 * A value typed into a field. Into one that suggests as it is typed into, all but the last character
 * is filled and the last is pressed as a key, so a site that listens for keys (not only for input)
 * reacts, as it would to a person (C10).
 */
/** Why a stored value wasn't typed: its box couldn't be masked, nor the screen covered, just before the first key. */
export const KEY_REFUSED = "didn't type it: a stored value isn't typed now: its box couldn't be masked or the screen covered first (the video would show it)";

/**
 * A date, time or date-and-time written the way a browser's own date box takes it, when it can be
 * without a guess: "2026-11-02 09:30" into a date-and-time box is 2026-11-02T09:30, the date part into a
 * date box, the time part (and "9:30 pm" as 21:30) into a time box, 2026/11/02 as 2026-11-02. Anything
 * else (11/02/2026, day or month first?) is left as it was, and the box's own refusal says the format.
 */
export function dateForBox(type: string, value: string): string {
  const v = value.trim();
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(v);
  const two = (n: string) => n.padStart(2, "0");
  const hour = (h: string, ap?: string) => {
    let n = Number(h);
    if (ap) n = (n % 12) + (/pm/i.test(ap) ? 12 : 0);
    return n <= 23 ? two(String(n)) : undefined;
  };
  if (m) {
    const date = `${m[1]}-${two(m[2]!)}-${two(m[3]!)}`;
    const h = m[4] !== undefined ? hour(m[4], m[7]) : undefined;
    const time = h !== undefined ? `${h}:${m[5]}${m[6] ? `:${m[6]}` : ""}` : undefined;
    if (type === "date") return date;
    if (type === "datetime-local") return time ? `${date}T${time}` : v;
    if (type === "time") return time ?? v;
    if (type === "month") return date.slice(0, 7);
    return v;
  }
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(v);
  if (t && type === "time") {
    const h = hour(t[1]!, t[4]);
    return h !== undefined ? `${h}:${t[2]}${t[3] ? `:${t[3]}` : ""}` : v;
  }
  return value;
}

const DATE_BOXES = new Set(["date", "datetime-local", "time", "month"]);

async function enter(el: Locator, value: string): Promise<Locator> {
  const chars = [...value];
  const keyed = chars.length > 0 && (await el.evaluate(suggests, undefined, { timeout: 2000 }).catch(() => false));
  if (!keyed) {
    const type = await el.evaluate((e) => (e.tagName === "INPUT" ? (e as HTMLInputElement).type : ""), undefined, { timeout: 2000 }).catch(() => "");
    if (DATE_BOXES.has(type)) value = dateForBox(type, value);
    await el.fill(value, { timeout: ACTION_MS });
    return el;
  }
  const who = await el.evaluate(fieldIdentity, undefined, { timeout: 2000 }).catch(() => ({ id: "", tag: "", name: "", label: "", placeholder: "" }));
  await el.fill(chars.slice(0, -1).join(""), { timeout: ACTION_MS });
  // The page may have drawn the field again on that input (a whole form redrawn with innerHTML on each
  // change, focus put back by id): the last key goes to the field as it is now, not the one that went.
  const now = await redrawn(el, who);
  await now.pressSequentially(chars.at(-1)!, { timeout: ACTION_MS });
  return now;
}

/** Runs in the page, self-contained: what finds a field again after its page draws it anew (W5: not only its id). */
function fieldIdentity(e: Element): { id: string; tag: string; name: string; label: string; placeholder: string } {
  const f = e as HTMLInputElement;
  const by = (f.getAttribute("aria-labelledby") ?? "").split(/\s+/).map((x) => (x ? document.getElementById(x)?.textContent ?? "" : "")).join(" ");
  const label = (f.getAttribute("aria-label") || by || [...(f.labels ?? [])].map((l) => l.textContent ?? "").join(" ") || "").replace(/\s+/g, " ").trim();
  return { id: f.id || "", tag: f.tagName.toLowerCase(), name: f.getAttribute("name") ?? "", label, placeholder: f.getAttribute("placeholder") ?? "" };
}

/**
 * The field after a redraw: itself while it is still on the page; otherwise the one like it now: by its
 * id, else (W5) its name attribute, its label, or its placeholder, each only when exactly one field has
 * it, the focused one first (a redraw that puts the focus back). None found again: left as it was (its
 * key then fails as before, and the AI is told).
 */
async function redrawn(el: Locator, who: ReturnType<typeof fieldIdentity>): Promise<Locator> {
  const attached = await el.evaluate((e) => e.isConnected, undefined, { timeout: 500 }).catch(() => false);
  if (attached) return el;
  const page = el.page();
  const q = (s: string) => s.replace(/["\\]/g, "\\$&");
  const tag = /^(input|textarea|select)$/.test(who.tag) ? who.tag : "";
  const ways: Locator[] = [];
  if (who.id) ways.push(page.locator(`[id="${q(who.id)}"]`));
  if (tag && who.name) ways.push(page.locator(`${tag}[name="${q(who.name)}"]`));
  if (who.label) ways.push(page.getByLabel(who.label, { exact: true }));
  if (who.placeholder) ways.push(page.getByPlaceholder(who.placeholder, { exact: true }));
  for (const way of ways) {
    const focused = way.and(page.locator(":focus"));
    if ((await focused.count().catch(() => 0)) === 1) return focused;
    if ((await way.count().catch(() => 0)) === 1) return way;
  }
  return el;
}

/**
 * The page's answer to an action, waited for as Playwright MCP does (C10): the requests it started
 * (xhr, fetch, a page) within 500 ms of it, up to 3 s; the page itself if it went somewhere; then a
 * moment more. Only what the action started is waited on, never what was already going.
 */
function watchRequests(page: Page): { settle(): Promise<number>; stop(): void } {
  const kinds = new Set(["xhr", "fetch", "document"]);
  const pending = new Set<Request>();
  let seen = 0;
  let navigated = false;
  let windowEnd = Infinity;
  const started = (r: Request) => {
    if (!kinds.has(r.resourceType()) || Date.now() > windowEnd) return;
    pending.add(r);
    seen++;
  };
  const ended = (r: Request) => void pending.delete(r);
  const went = (f: Frame) => {
    if (f === page.mainFrame()) navigated = true;
  };
  // A window the action opened (a sign-in window answering the page, C13) is waited on like a request,
  // until it closes, within the same few seconds: what it sends back shows in the next look.
  const popups = new Set<Page>();
  const opened = (p: Page) => {
    if (Date.now() > windowEnd) return;
    popups.add(p);
    seen++;
    p.once("close", () => popups.delete(p));
  };
  page.on("request", started);
  page.on("requestfinished", ended);
  page.on("requestfailed", ended);
  page.on("framenavigated", went);
  page.on("popup", opened);
  return {
    async settle() {
      const t = Date.now();
      windowEnd = t + SETTLE.window;
      try {
        while (Date.now() - t < SETTLE.max && (Date.now() < windowEnd || pending.size || [...popups].some((p) => !p.isClosed()))) await page.waitForTimeout(50);
        if (navigated) await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
        if (seen || navigated) await page.waitForTimeout(SETTLE.after);
      } catch {
        // the page closed: nothing more to wait for
      }
      return Date.now() - t;
    },
    stop() {
      page.off("request", started);
      page.off("requestfinished", ended);
      page.off("requestfailed", ended);
      page.off("framenavigated", went);
      page.off("popup", opened);
    },
  };
}

/** How long a settle listens for what an action started, waits on it at most, and waits after. */
export const SETTLE = { window: 500, max: 3000, after: 250 } as const;

/** A value looks like a secret: a key, a token, a long run of mixed letters and digits. */
const SECRET_SHAPE = /^(?=.*\d)(?=.*[a-z])[\w~+/=.-]{20,}$|^(sk|pk|rk)[-_]|^gh[pousr]_|^eyJ/i;

export interface Values {
  /** --var values by name: typed as {name}, never shown. */
  vars: Record<string, string>;
  /** A test account's values ({admin.password}), asked for only when typed: never shown, never kept. */
  resolve?: (name: string) => string | undefined;
  /** The goal and the steps as given: words in them may be typed as they are. */
  given: string;
  /** What may be made up for "auto": nothing in a sign-in, never what a --var could fill. */
  madeUp?: MadeUpRules;
  /**
   * A value made when it is typed ({admin.totp}, {admin.email_code}, {admin.magic_link}): undefined
   * when the name isn't one. Never cached: a replay makes a new one.
   */
  /** `on`: the exact host the value would be typed on (a provider test code is typed only on a host marked as yours). */
  fresh?: (name: string, on?: string) => Promise<Fresh> | undefined;
  /**
   * The person's own words, the goal and the steps they gave (not the AI's plan): a typed value found
   * in neither these nor a --var was made up by the AI, and is labelled so, whoever put it in the step.
   */
  fromPerson?: string;
  /**
   * The run keeps a video or photos (or shows a live screen) with no cover over them: no {name} is
   * typed or opened. A recorded run has the cover (cover.ts) and never sets this; it is for a caller
   * that records some other way.
   */
  recording?: boolean;
}

/** Why a value can't be typed now: a {name} in a run that keeps video or photos. */
function recordedValue(values: Values, value: string): string | undefined {
  if (!values.recording || !usesPlaceholder(value)) return undefined;
  const names = placeholderNames(value).map((n) => `{${n}}`).join(", ");
  return `didn't type ${names}: this run's video and photos have no cover for it. A test that types a saved value must name it in its goal or steps`;
}

/** Text as compared for "did the person say it": one case, one space. */
const plainWords = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Whether a typed value came from the person's own words: it appears in them whole (not inside a
 * longer word), whatever its case or spacing. "Acme Ltd" is in "invoice Acme Ltd for 3 hours"; "Acme
 * Test Client" isn't, and nor is "3" in "30". An empty value types nothing, so it's never made up.
 */
export function saidBy(value: string, words: string): boolean {
  const v = plainWords(value);
  if (!v) return true;
  const text = plainWords(words);
  const word = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  for (let at = text.indexOf(v); at >= 0; at = text.indexOf(v, at + 1)) {
    const startsClean = !word(text[at - 1]) || !word(v[0]);
    const endsClean = !word(text[at + v.length]) || !word(v[v.length - 1]);
    if (startsClean && endsClean) return true;
  }
  return false;
}

/**
 * The values made at type time that some words use, made now ({admin.totp}, {admin.email_code}):
 * the values to type them with, or why the step can't go on, with its code (C19).
 */
export async function freshFor(values: Values, raw: string, on?: string): Promise<{ values: Values } | { blocked: string }> {
  if (!values.fresh) return { values };
  const made: Record<string, string> = {};
  for (const name of placeholderNames(raw)) {
    if (name in values.vars) continue;
    const pending = values.fresh(name, on);
    if (!pending) continue;
    const got = await pending;
    if ("problem" in got) return { blocked: `${got.code}: ${got.problem}` };
    made[name] = got.value;
  }
  return Object.keys(made).length ? { values: { ...values, vars: { ...values.vars, ...made } } } : { values };
}

/** The value to type, with {name}s filled in; or why it may not be typed. */
export function valueFor(raw: string, values: Values, password: boolean): { value: string } | { refused: string } {
  const names = placeholderNames(raw);
  const lookup = (n: string) => (n in values.vars ? values.vars[n] : values.resolve?.(n));
  const unknown = names.find((n) => lookup(n) === undefined);
  if (unknown) return { refused: unknown.includes(".") ? `there's no value for {${unknown}} (the account isn't set up, or its ${unknown.split(".")[1]} isn't stored)` : `there's no --var ${unknown}` };
  // A password, by its handle, goes only into a password field: never into a box that shows what is typed.
  if (!password && names.some(isPasswordName)) return { refused: `{${names.find(isPasswordName)!}} is a password: it is only typed into a password field` };
  const value = fillPlaceholders(raw, lookup);
  if (password && !ONE_PLACEHOLDER.test(raw.trim())) return { refused: "a password field only takes a --var value" };
  if (!names.length && SECRET_SHAPE.test(raw) && !values.given.toLowerCase().includes(raw.toLowerCase())) return { refused: "it looks like a secret nobody gave the test" };
  return { value };
}

export type Outcome =
  | {
      done: CachedAction;
      label: string;
      /** What came of it that the actor should know: "the form wasn't sent: Email (Please fill out this field.)". */
      note?: string;
      /** How long the page took to answer it (what it started, a page it went to, a wait asked for): the "slow" friction counts this, never the tool's own time. */
      settledMs?: number;
    }
  | { blocked: string; label: string }
  | { error: string; label: string; /** A value it won't make up was needed: the --var name to pass. */ needs?: string; /** What kind of failure (covered, hidden, stale, disabled): the loop guards count them. */ kind?: ErrorKind };

export interface ActContext {
  page: Page;
  start: string;
  allowHosts: readonly string[];
  values: Values;
  mask: (s: string) => string;
  /** Set by the run when a navigation off the site was stopped (see guardSite). */
  offSite: () => string | undefined;
  /** A visitor's test: nothing that signs in or makes an account is pressed, and no password is typed. */
  visitor?: boolean;
  /**
   * C7: this run signs in as (or signs up) a test account on `host`, marked as the person's own, so a
   * "send code / send link" button may be pressed there, at most 3 times (`count` is the run's).
   * Never set for a visitor's test.
   */
  codeSends?: { host: string; signUp?: boolean; count: { n: number } };
  /** The matching rules of the saved test being replayed (RULES); none for a test saved before they had a number. */
  rules?: number;
  /** The saved test's origin when the run is on another address of the same app: its addresses move to the run's. */
  savedOrigin?: string;
  /** Hosts treated as a sign-in provider's, beside the listed ones (a test's fake provider): nothing is typed there. */
  providerHosts?: readonly string[];
  /** E2: the fields a secret or a {name} value was typed into, painted over in every picture (maskshot.ts). */
  secretFields?: import("./maskshot.ts").SecretFields;
  /**
   * Called just before the first key of a typed value, once any code in it is made: false and nothing is
   * typed (the run's cover couldn't mask the box, or put its card up, for a stored value).
   */
  beforeKey?: (el: Locator) => Promise<boolean>;
  /**
   * D14: this run may pay, in a provider's test mode only, on `owned` hosts (RunOptions.payments).
   * `finalPresses` is the run's count (one per run: never tried again); `now` is the checkout's mode
   * read at the start of this action; `armed`: this action's press is a final pay press the gate let through.
   */
  pay?: { owned: readonly string[]; finalPresses: { n: number }; now?: PayModeResult; armed?: boolean };
  /**
   * The exact hosts (port included) a test account's values may be typed on: the account's own, and
   * hosts marked as the person's or where they said it's their own account. Unset: no account values.
   * A field on any other host gets nothing typed, before a code is even made or asked for.
   */
  accountHosts?: readonly string[];
  /** The account values' names ({admin.password}, {admin.totp}): the ones accountHosts guards. */
  accountNames?: ReadonlySet<string>;
  /** Signed in with the person's own account on a site that isn't theirs: refusedOnOwnAccount holds too. */
  notOwned?: boolean;
  /** W4: the run's tabs, when a window the page opens is kept (switch_tab); unset: it is followed in the first tab, as before. */
  tabs?: Tabs;
  /** W4: where the built-in sample files are made (a test's own folder); the machine's temp folder when unset. */
  samples?: string;
}

/** The exact host of an address (port included, lowercased), or "". */
function exactHost(address: string): string {
  try {
    return new URL(address).host.toLowerCase();
  } catch {
    return "";
  }
}

/** The account values' names in what is to be typed ({admin.password}): never a --var's. */
const accountNamesIn = (ctx: Pick<ActContext, "accountNames" | "values">, raw: string) => placeholderNames(raw).filter((n) => !(n in ctx.values.vars) && (ctx.accountNames?.has(n) || n.includes(".")));

/**
 * Why an account's value may not be typed (or opened) here, or nothing: the field's own page and the
 * top page must both be on one of the account's exact hosts. A --var keeps its own rule.
 */
export function accountHostRefused(ctx: Pick<ActContext, "accountHosts" | "accountNames" | "values" | "notOwned">, raw: string, doc: string, top: string): string | undefined {
  if (!ctx.accountHosts) return undefined;
  const names = accountNamesIn(ctx, raw);
  if (!names.length) return undefined;
  const own = ctx.accountHosts[0] ?? "";
  for (const u of [/^https?:/.test(doc) ? doc : top, top]) {
    const h = exactHost(u);
    if (h && ctx.accountHosts.includes(h)) continue;
    const base = `nothing was typed: {${names[0]}} is for ${own}, and this field is on ${h || "another page"}`;
    const otherSite = !h || siteOf(new URL(`http://${h}`).hostname) !== siteOf(new URL(`http://${own || "x.invalid"}`).hostname);
    // Your own account on a site that isn't yours: never typed on another site, whatever is said (no fix offered).
    if (otherSite && ctx.notOwned) return `${base}, a different site from ${own}. Your account's values are typed only on its own site.`;
    if (!h) return `${base}.`;
    return `${base}${otherSite ? `, a different site from ${own}` : ", another host of the same site"}. If ${h} is where you sign in to ${own}, say so once: npx contextmachines accounts sign-in ${h}`;
  }
  return undefined;
}

/**
 * accountHostRefused again, right before typing, read fresh: the field's own page and the top page now.
 * A field that is gone (its page moved on) gets nothing typed either.
 */
async function hostNow(ctx: ActContext, raw: string, el: Locator, page: Page): Promise<string | undefined> {
  if (!ctx.accountHosts || !accountNamesIn(ctx, raw).length) return undefined;
  const doc = await el.evaluate((e) => (e.isConnected ? e.ownerDocument.URL : ""), undefined, { timeout: 3000 }).catch(() => "");
  if (!doc) return "nothing was typed: the field was gone when the value was ready (the page moved on)";
  return accountHostRefused(ctx, raw, doc, page.url());
}

const ACTION_MS = 8000;

/** A target as it is saved: never the snapshot's ref. */
const plain = (t: Target & { ref?: string; same?: number; around?: string }): Target => {
  const { ref: _ref, same: _same, around: _around, ...rest } = t;
  return rest;
};

/** What an element is, as the safety rules need it, read in the page. */
interface Inspected {
  /** "typing": a field Enter submits from; "control": something Enter or Space presses; "frame": inside an embedded page; "none": nothing focused. */
  kind: "typing" | "control" | "frame" | "none";
  /** Its name as a person reads it: aria-label, aria-labelledby, a button's value or alt, its words. */
  name: string;
  /** The link it is, or is inside. */
  href: string;
  /** For a field in a form: the name of the button Enter would press. */
  submitter: string;
  /** A submit button, or a field Enter submits from: whether its form can be left unsent. */
  submits: boolean;
  /** The words of the dialog it's in, when it's in a short one. */
  dialog: string;
  /** A submit button, or a field Enter submits from, whose form sends a message (a contact or feedback form): why, or "". */
  message: string;
  /** Its own test id (data-testid, data-test, data-qa), or "". */
  testid: string;
  /** Its visible words, the first 80 characters. */
  text: string;
  /** Every word that names it: its label, labels, placeholder, title, value and words, for "is this the element meant". */
  words: string;
  /** The address of the document it is in: the page's, or an embedded page's. */
  doc: string;
  /** What a field is labelled, never what it holds: its aria-label, aria-labelledby, <label>s, placeholder and title. */
  label: string;
}

/**
 * Runs in the page, so it is self-contained. For a field, the button Enter presses is the form's
 * first submit button in tree order, wherever it sits (a button outside with form=, an image input),
 * as the browser picks it.
 */
function inspect(e: Element | null): Inspected {
  const nameOf = (x: Element | null | undefined): string => {
    if (!x) return "";
    const by = x.getAttribute("aria-labelledby");
    const labelled = by ? by.split(/\s+/).map((id) => x.ownerDocument.getElementById(id)?.textContent ?? "").join(" ") : "";
    const input = x as HTMLInputElement;
    const own = x.tagName === "INPUT" ? input.value || input.alt || "" : "";
    return (x.getAttribute("aria-label") || labelled || own || x.getAttribute("alt") || x.textContent || x.getAttribute("title") || "").replace(/\s+/g, " ").trim();
  };
  const none: Inspected = { kind: "none", name: "", href: "", submitter: "", submits: false, dialog: "", message: "", testid: "", text: "", words: "", doc: e?.ownerDocument?.URL ?? "", label: "" };
  if (!e || e === e.ownerDocument.body || e === e.ownerDocument.documentElement) return none;
  if (e.tagName === "IFRAME" || e.tagName === "FRAME") return { ...none, kind: "frame" };
  const type = (e.getAttribute("type") || "").toLowerCase();
  const typing = e.tagName === "TEXTAREA" || e.tagName === "SELECT" || (e as HTMLElement).isContentEditable || (e.tagName === "INPUT" && !["submit", "image", "button", "reset", "checkbox", "radio", "file", "color", "range"].includes(type));
  const form = (e as HTMLInputElement).form ?? null;
  const isSubmit = (x: Element) => (x.tagName === "BUTTON" && (x as HTMLButtonElement).type === "submit") || (x.tagName === "INPUT" && ["submit", "image"].includes((x as HTMLInputElement).type));
  // form.elements leaves out image inputs: they're added, and the first in the page's order is the one.
  const candidates = form ? [...form.elements, ...form.querySelectorAll("input[type=image]"), ...(form.id ? e.ownerDocument.querySelectorAll(`input[type=image][form="${CSS.escape(form.id)}"]`) : [])].filter(isSubmit) : [];
  const def = candidates.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))[0];
  const dialog = e.closest("dialog, [role=dialog], [role=alertdialog]");
  const dialogWords = (dialog?.textContent ?? "").replace(/\s+/g, " ").trim();
  // A form that sends a message whatever its button says ("Submit"): one with a field for the message,
  // or one on a contact or feedback page that takes words or an email. A search (GET, no text box) isn't.
  let message = "";
  if (form && (typing ? e.tagName === "INPUT" : isSubmit(e))) {
    const said = (x: Element) => [x.getAttribute("name"), x.id, x.getAttribute("aria-label"), x.getAttribute("placeholder"), ...[...((x as HTMLInputElement).labels ?? [])].map((l) => l.textContent)].join(" ").toLowerCase();
    // A text box drawn nowhere (display: none: a widget's answer field) is no box a person writes in.
    const fields = [...form.elements].filter((x) => x.tagName !== "TEXTAREA" || (x as HTMLElement).getClientRects().length > 0);
    const box = fields.find((x) => x.tagName === "TEXTAREA" || /\b(message|comments?|feedback|enquiry|inquiry)\b/.test(said(x)));
    const words = [form.getAttribute("aria-label"), form.querySelector("legend, h1, h2, h3")?.textContent, e.ownerDocument.title, e.ownerDocument.querySelector("h1")?.textContent].join(" ").replace(/\s+/g, " ").toLowerCase();
    const contact = /\b(contact|feedback|get in touch|enquir(y|ies)|inquir(y|ies)|write to us|message us|support request|report (a|an) (problem|issue|bug))\b/.test(words);
    const takesWords = fields.some((x) => x.tagName === "TEXTAREA" || (x as HTMLInputElement).type === "email");
    // A box for the person's own record (a note's body), sent by "Save", "Create" or "Add", with no one to
    // send it to (no email or recipient field) and not on a contact page: kept, not sent to anyone.
    const button = (typing ? def : e) ?? null;
    const keeps = Boolean(button) && /^(save|create|add|update)\b/i.test(nameOf(button!).trim()) && !/\b(send|post|publish|share|submit|comment|reply|message)\b/i.test(nameOf(button!));
    const toSomeone = fields.some((x) => (x as HTMLInputElement).type === "email" || /\b(to|recipients?|cc|bcc|subject)\b/.test(said(x)));
    if (box && box.tagName === "TEXTAREA" && (form.method || "get").toLowerCase() === "get" && !contact) message = "";
    else if (box && box.tagName === "TEXTAREA" && keeps && !toSomeone && !contact && !/\b(message|comments?|feedback|enquiry|inquiry)\b/.test(said(box))) message = "";
    else if (box) message = `its form has a field for a message ('${said(box).replace(/\s+/g, " ").trim().slice(0, 40)}')`;
    else if (contact && takesWords && (form.method || "get").toLowerCase() !== "get") message = "its form is a contact or feedback form";
  }
  const html = e as HTMLInputElement;
  const words = [nameOf(e), ...[...(html.labels ?? [])].map((l) => l.textContent ?? ""), e.getAttribute("placeholder"), e.getAttribute("title"), html.value, e.textContent].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 400);
  const labelledBy = (e.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean).map((id) => e.ownerDocument.getElementById(id)?.textContent ?? "");
  const label = [e.getAttribute("aria-label"), ...labelledBy, ...[...(html.labels ?? [])].map((l) => l.textContent ?? ""), e.getAttribute("placeholder"), e.getAttribute("title")].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 300);
  return {
    testid: e.getAttribute("data-testid") || e.getAttribute("data-test") || e.getAttribute("data-qa") || "",
    text: ((e as HTMLElement).innerText ?? e.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
    words,
    kind: typing ? "typing" : "control",
    name: nameOf(e),
    href: e.closest("a[href]")?.getAttribute("href") ?? "",
    submitter: typing ? nameOf(def) : "",
    submits: Boolean(form) && (typing ? e.tagName === "INPUT" : isSubmit(e)),
    dialog: dialogWords.length <= 300 ? dialogWords : "",
    message,
    doc: e.ownerDocument.URL,
    label,
  };
}

/** Runs in the page: the fields of an element's form the browser won't send as they are, with what it says about each. */
function unsent(e: Element | null): string[] {
  const form = (e as HTMLInputElement | null)?.form;
  if (!form) return [];
  return [...form.elements]
    .filter((x) => (x as HTMLInputElement).willValidate && !(x as HTMLInputElement).validity.valid)
    .slice(0, 6)
    .map((x) => {
      const f = x as HTMLInputElement;
      const label = (f.labels?.[0]?.textContent || f.getAttribute("aria-label") || f.placeholder || f.name || f.type).replace(/\s+/g, " ").trim().slice(0, 40);
      return `${label} (${f.validationMessage || "not valid"})`;
    });
}

/** Why pressing a control, read in the page, isn't allowed: its words, the dialog it would say yes to, or where it leads. */
function refusedControl(info: Inspected, ctx: ActContext, base: string, sendCode = false): { why: string; /** Only because it's a link to another site: nothing was sent. */ off?: true } | undefined {
  // A "send code" button the C7 rule let through isn't refused for its words again.
  const own = sendCode ? undefined : refusedPress(info.name, ctx, info.doc) ?? (ctx.visitor ? refusedSignedOut(info.name) : undefined);
  if (own) return { why: own };
  if (info.message) return { why: `"${ctx.mask(info.name.slice(0, 40))}" wasn't pressed: it would send a message (${ctx.mask(info.message)})` };
  const dialogWhy = info.dialog && CONFIRMS.test(info.name) ? deniedWhy(info.dialog) : undefined;
  if (dialogWhy) return { why: `"${info.name.slice(0, 40)}" wasn't pressed: it says yes to a dialog where ${dialogWhy}` };
  // An element of an embedded page is pressed only when that page is of the test's site.
  if (info.doc && /^https?:/.test(info.doc) && !siteOk(info.doc, ctx)) return { why: `"${ctx.mask(info.name.slice(0, 40))}" wasn't pressed: it's inside an embedded page of another site (${hostOf(info.doc, base)})` };
  const from = /^https?:/.test(info.doc) ? info.doc : base;
  if (info.href && !/^(#|javascript:)/i.test(info.href) && !siteOk(new URL(info.href, from).href, ctx)) return { why: `'${ctx.mask(info.name.slice(0, 60))}' ${leadsOff(new URL(info.href, from).href, from)}`, off: true };
  return undefined;
}

/**
 * A visitor's test on a big site meets adverts and links out everywhere: a link to another site that
 * was read before it was pressed (so nothing was sent) is an action that didn't work, and the AI picks
 * another. Anywhere else, and for whatever got as far as leaving, the step ends blocked.
 */
const offLinkOutcome = (stop: { why: string; off?: true }, ctx: ActContext, label: string, key = ""): Outcome =>
  ctx.visitor && stop.off ? { error: `didn't click: ${stop.why.replace(/ \(add --allow-host [^)]*\)$/, "")}, maybe an advert: choose a link of this site`, label } : { blocked: key ? `${key} on the focused control: ${stop.why}` : stop.why, label };

/** "leads off the site, to www.iana.org (add --allow-host www.iana.org to allow it)". */
function leadsOff(to: string, base: string): string {
  const host = hostOf(to, base);
  return `leads off the site, to ${host} (add --allow-host ${hostnameOf(to, base)} to allow it)`;
}

/** Roles a person sets by clicking their label as well as themselves. */
const TOGGLES = new Set(["checkbox", "radio", "switch"]);

/**
 * A checkbox, radio or switch that can't be clicked itself (drawn hidden, or under its own styling),
 * clicked through its label, as a person does: the label's words are read in the page and refused by
 * the same rules first. Measured: the box must change, or it is an error. "none": it has no label.
 */
async function viaLabel(ctx: ActContext, el: Locator, label: string): Promise<Outcome | "none" | undefined> {
  const handle = await el.evaluateHandle((e) => (e as HTMLInputElement).labels?.[0] ?? e.closest("label"), undefined).catch(() => undefined);
  const lab = handle?.asElement() as ElementHandle<Element> | null | undefined;
  if (!lab) return "none";
  const info = await lab.evaluate(inspect);
  const refused = refusedName(info.name) ?? refusedName(info.words) ?? (ctx.visitor ? (refusedSignedOut(info.name) ?? refusedSignedOut(info.words)) : undefined);
  if (refused) return { blocked: `its label ${refused}`, label };
  const stop = refusedControl(info, ctx, ctx.page.url());
  if (stop) return offLinkOutcome(stop, ctx, label);
  // A link or a button inside the label is what a click on it may press: each is read and refused
  // by the same rules first, and one that leads somewhere means the label isn't clicked at all.
  const inner = await lab.evaluateHandle((l) => [...l.querySelectorAll("a[href], button, [role=link], [role=button]")].filter((x) => !x.contains(l)));
  const parts = await inner.evaluate((xs) => xs.length).catch(() => 0);
  for (let k = 0; k < parts; k++) {
    const part = (await inner.evaluateHandle((xs, i) => xs[i]!, k)).asElement() as ElementHandle<Element> | null;
    if (!part) continue;
    const pi = await part.evaluate(inspect);
    const no = refusedControl(pi, ctx, ctx.page.url());
    if (no) return offLinkOutcome(no, ctx, label);
    if (pi.href && !/^(#|javascript:)/i.test(pi.href)) return { error: `didn't click: its label holds a link ('${ctx.mask(pi.name.slice(0, 60))}'), which a click on the label would follow`, label, kind: "other" };
  }
  const before = await el.isChecked({ timeout: 1000 }).catch(() => undefined);
  await lab.click({ trial: true, timeout: 2500 });
  await lab.click({ timeout: ACTION_MS });
  await ctx.page.waitForTimeout(150);
  const after = await el.isChecked({ timeout: 1000 }).catch(() => undefined);
  // Measured: the box changed. Going somewhere else is not the box changing.
  if (before === undefined || after === before) return { error: "didn't click: the checkbox didn't change when its label was clicked", label, kind: "other" };
  return undefined;
}

/**
 * E7: the presses that aren't a plain click, on an element that passed the click's rules. check and
 * uncheck are for a checkbox, radio or switch, and do nothing when it already is so; a hidden styled
 * one is set through its label (read and refused first, as for a click). Measured: the box changed.
 */
async function otherPress(ctx: ActContext, el: Locator, verb: "dblclick" | "rightclick" | "check" | "uncheck", role: string, label: string): Promise<Outcome | undefined> {
  if (verb === "dblclick") {
    await el.dblclick({ trial: true, timeout: 2500 }).catch(() => el.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {}));
    await el.dblclick({ timeout: ACTION_MS });
    return undefined;
  }
  if (verb === "rightclick") {
    await el.click({ button: "right", trial: true, timeout: 2500 }).catch(() => el.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {}));
    await el.click({ button: "right", timeout: ACTION_MS });
    return undefined;
  }
  const want = verb === "check";
  const now = await el.isChecked({ timeout: 2000 }).catch(() => undefined);
  if (now === undefined || !TOGGLES.has(role)) return { error: `didn't ${verb}: it isn't a checkbox, radio or switch; click it instead`, label, kind: "other" };
  if (now === want) return undefined;
  if (!want && role === "radio") return { error: "didn't uncheck: a radio button is unchecked by checking another of its group", label, kind: "other" };
  // A box whose change takes the page elsewhere (a filter that reloads) has done its work when it went.
  const was = ctx.page.url();
  const went = () => ctx.page.url() !== was;
  try {
    await el.setChecked(want, { timeout: 2500 });
  } catch (error) {
    if (went()) return undefined;
    const said = error instanceof Error ? error.message : String(error);
    if (!/intercepts pointer events|not visible|outside of the viewport|did not change its state/.test(said)) throw error;
    const through = await viaLabel(ctx, el, label);
    if (through === "none") throw error;
    if (through && !("error" in through && went())) return through;
  }
  if (went()) return undefined;
  return (await el.isChecked({ timeout: 1000 }).catch(() => undefined)) === want ? undefined : { error: `didn't ${verb}: the box didn't change`, label, kind: "other" };
}

/** Runs in the page: scrolls the element, or the nearest box around it that scrolls, by most of its height. "end": it is already at its end. */
/** Runs in the page: the box around this element that scrolls, or null. Self-contained. */
function scrollerOf(e: Element): Element | null {
  for (let x: Element | null = e; x && x !== x.ownerDocument.documentElement && x !== x.ownerDocument.body; x = x.parentElement) {
    const style = getComputedStyle(x);
    if (/(auto|scroll|overlay)/.test(style.overflowY) && x.scrollHeight > x.clientHeight + 1) return x;
  }
  return null;
}

function scrollBox(e: Element, dir: number): "moved" | "end" | "none" {
  for (let x: Element | null = e; x && x !== x.ownerDocument.documentElement && x !== x.ownerDocument.body; x = x.parentElement) {
    const style = getComputedStyle(x);
    if (!/(auto|scroll|overlay)/.test(style.overflowY) || x.scrollHeight <= x.clientHeight + 1) continue;
    const top = x.scrollTop;
    x.scrollBy({ top: dir * Math.max(40, x.clientHeight * 0.8), behavior: "instant" as ScrollBehavior });
    return x.scrollTop === top ? "end" : "moved";
  }
  return "none";
}

/**
 * Does one action, already resolved to an element by role and name (a ref from the latest snapshot,
 * or a saved test's target). Blocked: a safety stop. Error: it was tried and failed; the step goes on.
 */
export async function act(ctx: ActContext, action: Exclude<Action, { type: "done" } | { type: "stuck" }> | CachedAction, target?: Target & { ref?: string }, to?: Target & { ref?: string }): Promise<Outcome> {
  const requests = watchRequests(ctx.page);
  try {
    return await actOnce(ctx, action, target, requests.settle, to);
  } finally {
    requests.stop();
  }
}

/**
 * The value rules a typed value meets, for fill and type alike: "auto" made up to fit the field (never
 * a password, a card or an ID), words nobody gave labelled made up, a password from a --var only (and
 * never in a visitor's test), and a secret-shaped value nobody gave refused. The value to type, or why not.
 */
async function valueToType<E extends { value: string; madeUp?: true }>(ctx: ActContext, el: Locator, entry: E, fieldName: string): Promise<{ entry: E; facts?: Awaited<ReturnType<typeof fieldFacts>> } | { error: string; needs?: string }> {
  const { mask } = ctx;
  let facts: Awaited<ReturnType<typeof fieldFacts>> | undefined;
  if (AUTO.test(entry.value)) {
    facts = await el.evaluate(fieldFacts, undefined, { timeout: 3000 });
    const made = refusedMadeUp(facts, { ...ctx.values.madeUp, varNames: Object.keys(ctx.values.vars) }) ?? madeUpValue(facts);
    const field = mask(facts.label || fieldName);
    if ("cannot" in made && "given" in made) return { error: `didn't make up a value: '${field}' takes ${made.cannot}: type {${made.varName}}` };
    if ("cannot" in made) return { error: `didn't make up a value: '${field}' needs ${made.cannot}, which is only typed from --var ${made.varName}`, needs: made.varName };
    entry = { ...entry, value: made.value, madeUp: true };
  } else if (!entry.madeUp && ctx.values.fromPerson !== undefined && !usesPlaceholder(entry.value) && !saidBy(entry.value, ctx.values.fromPerson)) {
    // Typed words the person never gave, nor a --var: the AI made them up (in the plan or as it
    // acted), and it says so, as "auto" does.
    entry = { ...entry, madeUp: true };
  }
  return { entry, ...(facts ? { facts } : {}) };
}

async function actOnce(ctx: ActContext, action: Exclude<Action, { type: "done" } | { type: "stuck" }> | CachedAction, target: (Target & { ref?: string }) | undefined, settle: () => Promise<number>, to?: Target & { ref?: string }): Promise<Outcome> {
  const { page, mask } = ctx;
  let cached: CachedAction =
    action.type === "click" || action.type === "hover" || action.type === "dblclick" || action.type === "rightclick" || action.type === "check" || action.type === "uncheck" ? ({ type: action.type, target: plain(target ?? (action as { target: Target }).target) } as CachedAction)
    : action.type === "fill" || action.type === "select" ? { type: action.type, target: plain(target ?? (action as { target: Target }).target), value: action.value, ...("madeUp" in action && action.madeUp ? { madeUp: true as const } : {}) }
    : action.type === "type" ? { type: "type", value: action.value, ...("into" in action && action.into ? { into: action.into } : {}), ...("madeUp" in action && action.madeUp ? { madeUp: true as const } : {}) }
    : action.type === "press" ? { type: "press", key: action.key }
    : action.type === "scroll" ? { type: "scroll", direction: action.direction === "up" ? "up" : "down", ...(target || ("target" in action && action.target) ? { target: plain(target ?? (action as { target: Target }).target) } : {}) }
    : action.type === "navigate" ? { type: "navigate", url: usesPlaceholder(action.url) ? action.url : navigateToSave(action.url, ctx.start) }
    : action.type === "back" ? { type: "back" }
    : action.type === "scroll_to" ? { type: "scroll_to", text: String(action.text ?? ""), ...(target || ("target" in action && action.target) ? { target: plain(target ?? (action as { target: Target }).target) } : {}) }
    // W4: the widget verbs, saved with their element (and, for drag, where it was dropped).
    : action.type === "upload" || action.type === "drag_at" || action.type === "slide" ? { type: action.type, target: plain(target ?? (action as { target: Target }).target), value: String(action.value ?? "") }
    : action.type === "drag" ? dragOf(action, target, to)
    : action.type === "download" ? { type: "download", target: plain(target ?? (action as { target: Target }).target) }
    : action.type === "switch_tab" ? { type: "switch_tab", value: String(action.value ?? "").trim() }
    : action.type === "click_at" ? ("name" in action ? { ...action, x: Number(action.x), y: Number(action.y), name: String(action.name ?? "") } : { type: "click_at", x: Number(action.x), y: Number(action.y), name: "", what: String(action.what ?? "") })
    : { type: "wait", ms: Math.max(0, Math.min(5000, Number((action as { ms?: number }).ms) || 0)) };
  let label = labelOf(cached, mask);
  /** The element whose form may be left unsent by this action: read again once it has settled. */
  let unsentFields: (() => Promise<string[]>) | undefined;
  /** The element acted on, once found: read again for what covers it when the action fails. */
  let el: Locator | undefined;
  /**
   * The element: the one the actor named by number in the latest look, itself (live); or a saved
   * test's target found again by the rules it was saved under.
   */
  const find = async (): Promise<{ el: Locator; live: boolean } | { error: string; kind: ErrorKind }> => {
    const t = target ?? (cached as { target: Target }).target;
    if (target?.ref) {
      const r = await locateLive(page, target.ref);
      if ("el" in r) return { el: r.el, live: true };
      // W5: drawn again since the look: the same role and name, when it was and is the only one.
      const again = await refind(page, target);
      return again ? { el: again, live: true } : { error: r.missing, kind: "stale" };
    }
    const r = await locateSaved(page, t, ctx.rules, ctx.savedOrigin ? { savedOrigin: ctx.savedOrigin, start: ctx.start } : undefined);
    return "el" in r ? { el: r.el, live: false } : { error: `can't find it: ${r.missing}`, kind: r.ambiguous ? "other" : "stale" };
  };
  /** How long the page took to answer, for the "slow" friction. */
  let settledMs = 0;
  /** W4: what the action found out, said to the actor after it ("a file downloaded: …", "the slider is at 40"). */
  let said: string | undefined;
  // D14: the checkout's mode, read once before anything in this action is inspected.
  if (ctx.pay) {
    ctx.pay.armed = false;
    ctx.pay.now = await payModeOf(page).catch(() => undefined);
  }
  // C13 (D6): nothing is ever typed on a sign-in provider's own page (Google, Microsoft, Apple, GitHub).
  if ((cached.type === "fill" || cached.type === "type" || cached.type === "select" || (cached.type === "press" && cached.key === "Enter")) && onProvider(page.url(), ctx.providerHosts)) {
    return { blocked: `nothing is typed on ${hostOf(page.url(), ctx.start)}, a sign-in provider's page: sign in there by hand once (npx contextmachines test --setup --by-hand --as <account>), or use the provider's test mode`, label };
  }
  try {
    switch (cached.type) {
      case "click":
      case "dblclick":
      case "rightclick":
      case "check":
      case "uncheck": {
        // E7: a double-click, a right-click and check/uncheck meet every rule a click does, below.
        const verb = cached.type;
        // C7: a "send code / send link" button, in a run that signs in as a test account (never a visitor's).
        const sendCode = verb === "click" && Boolean(ctx.codeSends) && !ctx.visitor && sendCodeWords(cached.target.name);
        const refused = sendCode ? undefined : refusedPress(cached.target.name, ctx) ?? (ctx.visitor ? refusedSignedOut(cached.target.name) : undefined);
        if (refused) return { blocked: refused, label };
        const found = await find();
        if ("error" in found) return { error: found.error, label, kind: found.kind };
        el = found.el;
        // Its name now, read in the page: the element found may not be the one the name was saved for.
        const info = await el.evaluate(inspect, undefined, { timeout: 3000 });
        // The element the number named, if it says nothing like its name, isn't the one the actor read.
        if (found.live && !shareAWord(cached.target.name, info.words)) return { error: STALE, label, kind: "stale" };
        if (sendCode) {
          // Its name in the page must be the same words, then its host, its form and the count.
          const why = !sendCodeWords(info.name) ? refusedName(info.name) ?? `"${mask(info.name.slice(0, 40))}" wasn't pressed: its name isn't one of the "send code" words` : await codeSendRefused(ctx, await el.evaluate(codeFormFields, undefined, { timeout: 3000 }), info.name);
          if (why) return { blocked: why, label };
        }
        const stop = refusedControl(info, ctx, page.url(), sendCode);
        if (stop) return offLinkOutcome(stop, ctx, label);
        // A checkbox says what it does in its label ("Subscribe to offers"), whatever its own name.
        if (TOGGLES.has(cached.target.role)) {
          const words = await el.evaluate((e) => [...((e as HTMLInputElement).labels ?? [])].map((l) => l.textContent ?? "").join(" ").replace(/\s+/g, " ").trim(), undefined, { timeout: 2000 }).catch(() => "");
          const why = words ? (refusedName(words) ?? (ctx.visitor ? refusedSignedOut(words) : undefined)) : undefined;
          if (why) return { blocked: `its label ${why}`, label };
        }
        // Saved as a replay will find it, read now: after the click it may be gone.
        if (found.live) cached = { type: verb, target: await savedIdentity(page, el, cached.target, info, mask) } as CachedAction & { target: Target };
        // A final pay press is one plain click, and a double-click on a button that sends a form (a sign-in,
        // a code send) would send it twice: refused before the count, so nothing is used up or sent.
        if (verb !== "click" && (ctx.pay?.armed || (verb === "dblclick" && (info.submits || sendCode)))) {
          const paying = Boolean(ctx.pay?.armed);
          if (ctx.pay) ctx.pay.armed = false;
          return { error: `"${mask(info.name.slice(0, 60))}" isn't one it presses with a ${verb === "dblclick" ? "double-click" : verb === "rightclick" ? "right-click" : verb}: ${paying ? "a payment is made with one plain click" : "a button that sends a form is pressed with one plain click"}, so use click`, label };
        }
        // D14: counted before the press of it: a payment is never tried twice.
        if (ctx.pay?.armed) ctx.pay.finalPresses.n++;
        if (verb !== "click") {
          const other = await otherPress(ctx, el, verb, (cached as { target: Target }).target.role, label);
          if (other) return other;
          if (info.submits) {
            const pressed = el;
            unsentFields = () => pressed.evaluate(unsent, undefined, { timeout: 1000 });
          }
          break;
        }
        try {
          await pressClick(el, TOGGLES.has(cached.target.role) ? /not visible/ : undefined);
        } catch (error) {
          // A styled checkbox (hidden, or under its own drawing) is clicked as a person clicks it:
          // through its label, whose words are read and refused first, as the box's own are.
          const said = error instanceof Error ? error.message : String(error);
          if (!TOGGLES.has(cached.target.role) || !/intercepts pointer events|not visible|outside of the viewport/.test(said)) throw error;
          const through = await viaLabel(ctx, el, label);
          if (through === "none") throw error;
          if (through) return through;
        }
        const pressed = el;
        if (info.submits) unsentFields = () => pressed.evaluate(unsent, undefined, { timeout: 1000 });
        break;
      }
      case "hover": {
        // Nothing is pressed, but nothing on the deny list is touched either: refused as a click would be.
        const refused = refusedName(cached.target.name) ?? (ctx.visitor ? refusedSignedOut(cached.target.name) : undefined);
        if (refused) return { blocked: refused.replace("wasn't pressed", "wasn't touched"), label };
        const found = await find();
        if ("error" in found) return { error: found.error, label, kind: found.kind };
        el = found.el;
        const info = await el.evaluate(inspect, undefined, { timeout: 3000 });
        if (found.live && !shareAWord(cached.target.name, info.words)) return { error: STALE, label, kind: "stale" };
        const stop = refusedControl(info, ctx, page.url());
        if (stop) return stop.off && ctx.visitor ? { error: `didn't hover: ${stop.why.replace(/ \(add --allow-host [^)]*\)$/, "")}, maybe an advert`, label } : { blocked: stop.why.replace("wasn't pressed", "wasn't touched"), label };
        if (found.live) cached = { type: "hover", target: await savedIdentity(page, el, cached.target, info, mask) };
        await el.hover({ trial: true, timeout: 2500 });
        await el.hover({ timeout: ACTION_MS });
        break;
      }
      case "fill":
      case "select": {
        const found = await find();
        if ("error" in found) return { error: found.error, label, kind: found.kind };
        el = found.el;
        const doc = await el.evaluate((e) => e.ownerDocument.URL, undefined, { timeout: 3000 }).catch(() => "");
        if (/^https?:/.test(doc) && !typeOk(doc, ctx)) return { blocked: `nothing was typed: the field is inside an embedded page of another site (${hostOf(doc, page.url())})`, label };
        // Nor in a sign-in provider's page embedded in this one, even on a host allowed for its popups.
        if (/^https?:/.test(doc) && onProvider(doc, ctx.providerHosts)) return { blocked: `nothing is typed on ${hostOf(doc, page.url())}, a sign-in provider's page`, label };
        const info = await el.evaluate(inspect, undefined, { timeout: 3000 }).catch(() => undefined);
        // In a visitor's test, a box to write a comment or a post in, by its name or its label, as for
        // type (in your own app, a form's "Comment" field is filled; its send button is refused when pressed).
        if (cached.type === "fill" && ctx.visitor) {
          const why = refusedField(`${cached.target.name} ${info?.label ?? ""}`, ctx.visitor);
          if (why) return { blocked: why, label };
        }
        if (found.live && info) cached = { ...cached, target: await savedIdentity(page, el, cached.target, info, mask) };
        // "auto": a plainly made-up test value that meets what the field asks (a drop-down's option
        // is selected), never a password, a card or an ID. Words nobody gave are labelled made up.
        const given: Extract<CachedAction, { type: "fill" | "select" }> = cached;
        const v = given.type === "select" && !AUTO.test(given.value) ? { entry: given } : await valueToType(ctx, el, given, given.target.name);
        if ("error" in v) return { error: v.error, label, ...(v.needs ? { needs: v.needs } : {}) };
        const entry: Extract<CachedAction, { type: "fill" | "select" }> = "facts" in v && v.facts ? { type: v.facts.tag === "select" ? "select" : "fill", target: given.target, value: v.entry.value, madeUp: true } : v.entry;
        if (entry !== given) {
          cached = entry;
          label = labelOf(entry, mask);
        }
        const password = entry.type === "fill" && (await el.getAttribute("type", { timeout: 2000 }).catch(() => null)) === "password";
        if (password && ctx.visitor) return { blocked: "a password wasn't typed: a visitor's test stays signed out", label };
        // An account's value goes only to its own exact host (and ones the person said are theirs), before any code is made.
        const offHost = entry.type === "fill" ? accountHostRefused(ctx, entry.value, doc, page.url()) : undefined;
        if (offHost) return { blocked: offHost, label };
        const filmed = recordedValue(ctx.values, entry.value);
        if (filmed) return { error: filmed, label };
        // A code made now ({admin.totp}, {admin.email_code}): never cached, never guessed.
        const made = await freshFor(ctx.values, entry.value, exactHost(/^https?:/.test(doc) ? doc : page.url()) || undefined);
        if ("blocked" in made) return { blocked: made.blocked, label };
        // Checked again now: making a code may have waited (a person, an inbox), and the page may have moved on.
        const movedOff = entry.type === "fill" ? await hostNow(ctx, entry.value, el, page) : undefined;
        if (movedOff) return { blocked: movedOff, label };
        const typed = valueFor(entry.value, made.values, password);
        if ("refused" in typed) return { error: `didn't type it: ${typed.refused}`, label, ...(password ? { needs: "password" } : {}) };
        const field = el;
        if (entry.type === "fill") {
          if (ctx.beforeKey && !(await ctx.beforeKey(field))) return { error: KEY_REFUSED, label };
          const into = await enter(field, typed.value);
          // E2: a password or any {name} value (an account's, a --var's: "never shown") is hidden in pictures too.
          if (password || placeholderNames(entry.value).length) ctx.secretFields?.add(into);
        }
        else await field.selectOption({ label: typed.value }, { timeout: ACTION_MS }).catch(() => field.selectOption(typed.value, { timeout: ACTION_MS }));
        break;
      }
      case "type": {
        // What has focus: on a replay, the field it was typed into, focused again; else the element
        // the look said had focus (named, so it is saved), or whatever has focus now.
        const entry: Extract<CachedAction, { type: "type" }> = cached;
        let live = false;
        if (entry.into && !target?.ref) {
          const r = await locateSaved(page, entry.into, ctx.rules, ctx.savedOrigin ? { savedOrigin: ctx.savedOrigin, start: ctx.start } : undefined);
          if (!("el" in r)) return { error: `can't find the field it typed into: ${r.missing}`, label, kind: r.ambiguous ? "other" : "stale" };
          el = r.el;
          await el.focus({ timeout: 3000 });
        } else if (target?.ref) {
          const r = await locateLive(page, target.ref);
          if ("el" in r && (await r.el.evaluate(hasFocus, undefined, { timeout: 2000 }).catch(() => false))) {
            el = r.el;
            live = true;
          }
        }
        if (!el) {
          // Through shadow roots (the browser's own :focus); an embedded page's field has a number of its own.
          const focused = page.locator(":focus").last();
          if ((await focused.count().catch(() => 0)) === 0) return { error: "nothing that takes typing has focus: click the field first, or use fill", label };
          el = focused;
        }
        const info = await el.evaluate(inspect, undefined, { timeout: 3000 });
        if (info.kind === "frame") return { blocked: "nothing was typed: the focus is inside an embedded page of another site", label };
        if (info.kind !== "typing" || (await el.evaluate((e) => e.tagName === "SELECT", undefined, { timeout: 2000 }).catch(() => true))) return { error: `nothing that takes typing has focus${info.name ? ` (it is on ${quoted(info.name, mask)})` : ""}: click the field first, or use fill`, label };
        if (/^https?:/.test(info.doc) && !typeOk(info.doc, ctx)) return { blocked: `nothing was typed: the field is inside an embedded page of another site (${hostOf(info.doc, page.url())})`, label };
        if (/^https?:/.test(info.doc) && onProvider(info.doc, ctx.providerHosts)) return { blocked: `nothing is typed on ${hostOf(info.doc, page.url())}, a sign-in provider's page`, label };
        // A box to write a comment or a post in is refused by its name, as its button would be.
        const refused = refusedName(info.name) ?? (ctx.visitor ? refusedSignedOut(info.name) : undefined);
        if (refused) return { blocked: refused.replace("wasn't pressed", "wasn't typed into"), label };
        // Named by its <label> or placeholder only ("Add a comment..."): refused all the same.
        const byLabel = refusedField(info.label, ctx.visitor);
        if (byLabel) return { blocked: byLabel, label };
        const into = live && target ? await savedIdentity(page, el, plain(target), info, mask) : entry.into;
        const v = await valueToType(ctx, el, { ...entry, ...(into ? { into } : {}) }, info.name);
        if ("error" in v) return { error: v.error, label, ...(v.needs ? { needs: v.needs } : {}) };
        cached = v.entry;
        label = labelOf(cached, mask);
        const password = (await el.getAttribute("type", { timeout: 2000 }).catch(() => null)) === "password";
        if (password && ctx.visitor) return { blocked: "a password wasn't typed: a visitor's test stays signed out", label };
        const offHost = accountHostRefused(ctx, v.entry.value, info.doc, page.url());
        if (offHost) return { blocked: offHost, label };
        const filmed = recordedValue(ctx.values, v.entry.value);
        if (filmed) return { error: filmed, label };
        const made = await freshFor(ctx.values, v.entry.value, exactHost(/^https?:/.test(info.doc) ? info.doc : page.url()) || undefined);
        if ("blocked" in made) return { blocked: made.blocked, label };
        const movedOff = await hostNow(ctx, v.entry.value, el, page);
        if (movedOff) return { blocked: movedOff, label };
        const typed = valueFor(v.entry.value, made.values, password);
        if ("refused" in typed) return { error: `didn't type it: ${typed.refused}`, label, ...(password ? { needs: "password" } : {}) };
        if (ctx.beforeKey && !(await ctx.beforeKey(el))) return { error: KEY_REFUSED, label };
        const typedInto = await enter(el, typed.value);
        if (password || placeholderNames(v.entry.value).length) ctx.secretFields?.add(typedInto);
        break;
      }
      case "press": {
        if (!KEYS.test(cached.key)) return { error: `the key "${cached.key.slice(0, 20)}" isn't one it presses`, label };
        // A search shortcut goes to whatever has focus: read first. "/" in a text field would type a
        // slash; one in an embedded page of another site can't be read; a control on the deny list isn't
        // where keys go.
        if (SHORTCUTS.has(cached.key)) {
          const focused = await page.evaluateHandle(deepFocus);
          const info = await focused.evaluate(inspect);
          if (info.kind === "frame") return { blocked: `${cached.key} wasn't pressed: the focus is inside an embedded page, where it can't be read`, label };
          if (info.kind === "typing" && cached.key === "/") return { error: `"/" wasn't pressed: a text field has focus, where it would type a slash: use type to type into it`, label };
          if (info.kind === "control") {
            const why = refusedName(info.name) ?? (ctx.visitor ? refusedSignedOut(info.name) : undefined);
            if (why) return { blocked: `${cached.key} on the focused control: ${why}`, label };
          }
        }
        // Enter and Space press whatever has focus (reached with Tab, say): it's read first, as a click's
        // target is. Enter in a field submits its form: the button that would press is read too.
        if (cached.key === "Enter" || cached.key === "Space") {
          // Through shadow roots, and into an embedded page the page may read (same origin): one of
          // another site can't be read, so its button can't be, and Enter stays refused there.
          const focused = await page.evaluateHandle(deepFocus);
          const info = await focused.evaluate(inspect);
          if (info.kind === "frame") return { blocked: `${cached.key} wasn't pressed: the focus is inside an embedded page, where its button can't be read`, label };
          // C7, as for a click: Enter on (or in the form of) a "send code" button.
          const sendWords = info.kind === "control" ? info.name : info.kind === "typing" && cached.key === "Enter" ? info.submitter : "";
          const sendCode = Boolean(ctx.codeSends) && !ctx.visitor && Boolean(sendWords) && sendCodeWords(sendWords);
          if (sendCode) {
            const why = await codeSendRefused(ctx, await focused.evaluate(codeFormFields), sendWords);
            if (why) return { blocked: `${cached.key} on the focused control: ${why}`, label };
          }
          if (info.kind === "control") {
            const stop = refusedControl(info, ctx, page.url(), sendCode);
            if (stop) return offLinkOutcome(stop, ctx, label, cached.key);
          }
          if (info.kind === "typing" && cached.key === "Enter") {
            const why = info.submitter && !sendCode ? (refusedPress(info.submitter, ctx, info.doc) ?? (ctx.visitor ? refusedSignedOut(info.submitter) : undefined)) : undefined;
            if (why) return { blocked: `Enter would submit a form whose button is ${why.replace(/ wasn't pressed/, "")}`, label };
            if (info.message) return { blocked: `Enter wasn't pressed: it would send a message (${mask(info.message)})`, label };
            // A field with no form may still post what it holds on Enter: one to write a comment in isn't pressed in.
            const field = refusedField(info.label, ctx.visitor);
            if (field) return { blocked: `Enter wasn't pressed in ${field.replace(" wasn't typed into:", ":")}`, label };
          }
          // The option a combobox has picked out (aria-activedescendant, or its list's selected one) is
          // what Enter or Space chooses: read and refused as a click on it would be.
          const chosen = (await focused.evaluateHandle((e) => {
            if (!e) return null;
            const d = (e as Element).ownerDocument;
            const id = (e as Element).getAttribute?.("aria-activedescendant");
            const active = id ? d.getElementById(id) : null;
            if (active) return active;
            const list = ((e as Element).getAttribute?.("aria-controls") || (e as Element).getAttribute?.("aria-owns") || "").split(/\s+/).filter(Boolean).map((x) => d.getElementById(x)).find(Boolean);
            return list?.querySelector("[aria-selected=true]") ?? null;
          })).asElement() as ElementHandle<Element> | null;
          if (chosen) {
            const ci = await chosen.evaluate(inspect);
            const stop = refusedControl(ci, ctx, page.url());
            if (stop) return offLinkOutcome({ ...stop, why: `${cached.key} wasn't pressed: ${stop.why.replace("wasn't pressed", "is the option it would choose")}` }, ctx, label);
          }
          if (info.submits && (info.kind === "control" || cached.key === "Enter")) unsentFields = () => focused.evaluate(unsent);
        }
        if (ctx.pay?.armed) ctx.pay.finalPresses.n++;
        await page.keyboard.press(cached.key === "Space" ? " " : cached.key);
        break;
      }
      case "scroll": {
        if (!cached.target) {
          await page.mouse.wheel(0, cached.direction === "up" ? -600 : 600);
          break;
        }
        // E7: a box that scrolls by itself (a list, a panel): it, or the nearest box around it that scrolls.
        const found = await find();
        if ("error" in found) return { error: found.error, label, kind: found.kind };
        el = found.el;
        const info = await el.evaluate(inspect, undefined, { timeout: 3000 });
        if (found.live && cached.target.name && !shareAWord(cached.target.name, info.words)) return { error: STALE, label, kind: "stale" };
        if (found.live) cached = { ...cached, target: await savedIdentity(page, el, cached.target, info, mask) };
        const moved = await el.evaluate(scrollBox, cached.direction === "up" ? -1 : 1, { timeout: 3000 });
        if (moved === "none") return { error: "didn't scroll: neither it nor any box around it scrolls; scroll the page instead", label, kind: "other" };
        if (moved === "end") return { error: `didn't scroll: the box is already at its ${cached.direction === "up" ? "top" : "bottom"}`, label, kind: "other" };
        break;
      }
      case "back": {
        // E7: the browser's Back. Where it lands is held to the site like any page (guardSite, then
        // the check below); a run's first page has no page of the site before it.
        const was = page.url();
        // A page a form was sent to is never sent again by going back to it: that load is stopped.
        let resent = false;
        const noResend = (route: Route) => {
          if (route.request().isNavigationRequest() && route.request().method() !== "GET") {
            resent = true;
            return route.abort("blockedbyclient");
          }
          return route.fallback();
        };
        await page.route("**/*", noResend);
        try {
          await page.goBack({ timeout: 20_000, waitUntil: "domcontentloaded" }).catch((error: unknown) => {
            if (!resent) throw error;
          });
        } finally {
          await page.unroute("**/*", noResend).catch(() => {});
        }
        if (resent) return { blocked: "Back wasn't done: the page before was a form's answer, and going back would send the form again", label };
        if (!/^https?:/.test(page.url())) {
          await page.goForward({ timeout: 20_000, waitUntil: "domcontentloaded" }).catch(() => {});
          return { error: "didn't go back: there's no page of this site before this one", label, kind: "other" };
        }
        if (page.url() === was) return { error: "didn't go back: there's no page before this one", label, kind: "other" };
        break;
      }
      case "click_at": {
        // W5: a press at a point of the picture, for what is only drawn (a canvas, a chart, a map). What
        // is there is read first and meets every rule a click does; a control a person names is pressed
        // by its number, never by a point; nothing inside an embedded page is pressed by a point. The
        // words the AI says it sees drawn there meet the same deny rules (a canvas has no words to read).
        const vp = page.viewportSize() ?? { width: 1280, height: 800 };
        const x = Math.round(cached.x);
        const y = Math.round(cached.y);
        const replaying = "name" in action;
        const said = String(cached.what ?? "").replace(/\s+/g, " ").trim();
        // A run that may pay never presses at a point: a payment is one plain click on its button.
        if (ctx.pay) return { error: "didn't click at a point: in a run that may pay, everything is pressed by its number in the snapshot", label, kind: "other" };
        if (!replaying && !said) return { error: "click_at needs what: the words (or the picture) drawn at that point, as you see them", label, kind: "other" };
        if (replaying) {
          // A saved point is pressed again only on the same screen size, and only where words can be read
          // again: a point on a canvas with no words can't be checked, so it is asked afresh.
          if (!cached.name.trim()) return { error: "can't find it: what was pressed at that point has no words to check again", label, kind: "stale" };
          if (cached.vw !== vp.width || cached.vh !== vp.height) return { error: `can't find it: the point was saved on a ${cached.vw ?? "?"} × ${cached.vh ?? "?"} screen, this one is ${vp.width} × ${vp.height}`, label, kind: "stale" };
        }
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= vp.width || y >= vp.height) return { error: `didn't click: (${cached.x}, ${cached.y}) isn't on the screen (it is ${vp.width} × ${vp.height})`, label, kind: "other" };
        const there = await page.evaluateHandle(atPoint, [x, y] as [number, number]);
        const facts = await there.evaluate((t) => ({ drawn: t.drawn, control: t.control, frame: t.frame, none: !t.el, words: t.words })).catch(() => ({ drawn: false, control: "", frame: false, none: true, words: [] as string[] }));
        if (facts.none) return { error: `didn't click: nothing is at (${x}, ${y})`, label, kind: "other" };
        if (facts.frame) return { blocked: `nothing was pressed at (${x}, ${y}): it is inside an embedded page`, label };
        const handle = (await there.evaluateHandle((t) => t.el)).asElement();
        if (!handle) return { error: `didn't click: nothing is at (${x}, ${y})`, label, kind: "other" };
        const info = await handle.evaluate(inspect);
        const what = (info.name || info.words || "").replace(/\s+/g, " ").trim().slice(0, 60);
        // A saved point is pressed again only where the same thing is.
        if (replaying && !shareAWord(cached.name, `${info.name} ${info.words}`)) return { error: `can't find it: '${mask(cached.name.slice(0, 40))}' isn't at (${x}, ${y}) now`, label, kind: "stale" };
        // Every set of words the press could set off: the element's, each one around it that takes the
        // click, and what the AI sees drawn there. Any the deny rules refuse, nothing is pressed.
        for (const words of [what, said, ...facts.words]) {
          if (!words) continue;
          const refused = refusedPress(words, ctx) ?? (ctx.visitor ? refusedSignedOut(words) : undefined);
          if (refused) return { blocked: refused, label };
        }
        if (facts.control) return { error: `didn't click at a point: ${mask(facts.control)} is there, a control with a name: press it by its number in the snapshot`, label, kind: "other" };
        const stop = refusedControl(info, ctx, page.url());
        if (stop) return offLinkOutcome(stop, ctx, label);
        cached = { type: "click_at", x, y, name: what, ...(said ? { what: mask(said).slice(0, 200) } : {}), vw: vp.width, vh: vp.height };
        label = labelOf(cached, mask);
        // Pressed on the element read above, at that point of it (Playwright checks nothing else is on top there).
        const box = await handle.boundingBox();
        if (!box) return { error: `didn't click: nothing is drawn at (${x}, ${y})`, label, kind: "other" };
        await handle.click({ position: { x: x - box.x, y: y - box.y }, timeout: ACTION_MS });
        break;
      }
      case "scroll_to": {
        // E7: words of the page brought into view; nothing pressed, nothing typed.
        const words = cached.text.replace(/\s+/g, " ").trim();
        if (!words) return { error: "scroll_to needs the words to scroll to", label };
        const shown = () => page.getByText(words).filter({ visible: true }).first();
        let at = shown();
        if ((await at.count().catch(() => 0)) === 0) {
          // W4: not on the page yet: scrolled for, as a person scrolls an endless list or one that draws
          // only the rows in view, until the words show or nothing more comes (3 scrolls with no change).
          let box: Locator | undefined;
          let scroller: ElementHandle<Element> | undefined;
          if (cached.target) {
            const found = await find();
            if ("error" in found) return { error: found.error, label, kind: found.kind };
            box = el = found.el;
            if (found.live) {
              const info = await el.evaluate(inspect, undefined, { timeout: 3000 });
              cached = { ...cached, target: await savedIdentity(page, el, cached.target, info, mask) };
            }
          }
          const middle = box ? null : await page.evaluate(mainScroller).catch(() => null);
          const size = page.viewportSize() ?? { width: 1280, height: 800 };
          let mark = await page.evaluate(scrollMark).catch(() => "");
          let still = 0;
          let rounds = 0;
          const until = Date.now() + SCROLL_UNTIL.ms;
          let hit = false;
          while (rounds < SCROLL_UNTIL.rounds && Date.now() < until) {
            rounds++;
            if (box) {
              // The box that scrolls is held, not the row named: a list that draws only the rows in view
              // takes that row away once it scrolls past it.
              scroller ??= (await box.evaluateHandle(scrollerOf)).asElement() ?? undefined;
              const moved = scroller ? await scroller.evaluate((x) => {
                const top = x.scrollTop;
                x.scrollBy({ top: Math.max(40, x.clientHeight * 0.8), behavior: "instant" as ScrollBehavior });
                return x.scrollTop === top ? "end" : "moved";
              }) : "none";
              if (moved === "none") return { error: "didn't scroll: neither it nor any box around it scrolls; scroll_to without a ref scrolls the page", label, kind: "other" };
            } else {
              await page.mouse.move(middle?.x ?? size.width / 2, middle?.y ?? size.height / 2);
              await page.mouse.wheel(0, Math.round(size.height * 0.8));
            }
            await page.waitForTimeout(300);
            await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => {});
            if ((await shown().count().catch(() => 0)) > 0) {
              hit = true;
              break;
            }
            const now = await page.evaluate(scrollMark).catch(() => "");
            still = now === mark ? still + 1 : 0;
            mark = now;
            if (still >= SCROLL_UNTIL.stillRounds) break;
          }
          if (!hit) return { error: `didn't find '${mask(words).slice(0, 60)}': scrolled ${rounds} times${still >= SCROLL_UNTIL.stillRounds ? ", to the end, where nothing more loaded" : ""}`, label, kind: "other" };
          said = `found after scrolling ${rounds} time${rounds === 1 ? "" : "s"}`;
          at = shown();
        }
        await at.scrollIntoViewIfNeeded({ timeout: ACTION_MS });
        break;
      }
      case "upload": {
        // W4: a file given to a file field, its "Browse" button or a drop zone. Only to the person's own
        // app: a file sent to a site that isn't theirs is published, as a post is.
        if (ctx.visitor || ctx.notOwned) return { blocked: "no file was uploaded: a file is only sent to your own app, never to a site that isn't yours", label };
        const found = await find();
        if ("error" in found) return { error: found.error, label, kind: found.kind };
        el = found.el;
        const info = await el.evaluate(inspect, undefined, { timeout: 3000 });
        // A file field's own name ("Choose File") is the browser's, not words of the page: not compared.
        const fileField = await el.evaluate((e) => e.tagName === "INPUT" && (e as HTMLInputElement).type === "file", undefined, { timeout: 2000 }).catch(() => false);
        if (found.live && !fileField && cached.target.name && !shareAWord(cached.target.name, info.words || info.name || info.label)) return { error: STALE, label, kind: "stale" };
        if (/^https?:/.test(info.doc) && !typeOk(info.doc, ctx)) return { blocked: `no file was uploaded: the field is inside an embedded page of another site (${hostOf(info.doc, page.url())})`, label };
        const input = (await el.evaluateHandle(fileInputOf, undefined)).asElement() as ElementHandle<HTMLInputElement> | null;
        const accept = input ? ((await input.getAttribute("accept").catch(() => null)) ?? "") : "";
        const file = uploadFile(cached.value, { ...(ctx.values.fromPerson !== undefined ? { fromPerson: ctx.values.fromPerson } : {}), accept, ...(ctx.samples ? { samples: ctx.samples } : {}) });
        if ("refused" in file) return { error: `didn't upload: ${file.refused}`, label, kind: "other" };
        if (found.live) cached = { ...cached, target: await savedIdentity(page, el, cached.target, info, mask) };
        label = labelOf({ ...cached, value: basename(file.path) }, mask);
        const name = basename(file.path);
        // The words of what was picked (its button, its zone) and of the file field it gives the file to
        // (its label, its name) are read as a click's are, whichever way the file goes in: a field that
        // sends as soon as a file is chosen ("Upload and send to all customers") is a press.
        const fieldWords = input ? await input.evaluate((i) => [i.getAttribute("aria-label") ?? "", i.title, ...[...(i.labels ?? [])].map((l) => l.textContent ?? "")].map((w) => w.replace(/\s+/g, " ").trim()).filter(Boolean)).catch(() => [] as string[]) : [];
        const why = [fileField ? "" : info.name || cached.target.name, info.label ?? "", ...fieldWords].filter(Boolean).map((w) => refusedPress(w, ctx) ?? (ctx.visitor ? refusedSignedOut(w) : undefined)).find(Boolean);
        if (why) return { blocked: why.replace("wasn't pressed", "wasn't given a file"), label };
        if (input) await input.setInputFiles(file.path, { timeout: ACTION_MS });
        else {
          // A button or zone with no file field of its own: pressed as a click is (its words read above),
          // and the picker it opens answered; a zone that opens none gets the file dropped on it.
          const stop = refusedControl(info, ctx, page.url());
          if (stop) return offLinkOutcome(stop, ctx, label);
          const chooser = page.waitForEvent("filechooser", { timeout: 4000 }).catch(() => undefined);
          await pressClick(el);
          const picker = await chooser;
          if (picker) await picker.setFiles(file.path, { timeout: ACTION_MS });
          else {
            await el.evaluate(dropFile, { name, type: MIME[extname(name).toLowerCase()] ?? "application/octet-stream", b64: readFileSync(file.path).toString("base64") }, { timeout: ACTION_MS });
            said = "no file picker opened, so the file was dropped onto it";
          }
        }
        const fits = accepts(accept, name) ? "" : `; the field asks for ${accept.slice(0, 60)}`;
        said = [said, `gave it ${name}${file.sample ? " (a built-in test file)" : ""}${fits}`].filter(Boolean).join("; ");
        break;
      }
      case "drag":
      case "drag_at": {
        // W4: a thing moved with the pointer held down (a card to a column, a row to a new place, a
        // splitter). What it is, and where it is dropped, are read and refused as a click's words are.
        // A drag's thing and its drop place may be named by their words: drop places rarely have a number.
        const source = cached.type === "drag" && !cached.target ? await byWords(page, cached.from ?? "") : await find();
        if ("error" in source) return { error: source.error, label, kind: source.kind };
        el = source.el;
        const live = "live" in source && source.live;
        const info = await el.evaluate(inspect, undefined, { timeout: 3000 });
        const own = cached.type === "drag" ? (cached.target?.name ?? cached.from ?? "") : cached.target.name;
        if (live && own && !shareAWord(own, info.words || info.name)) return { error: STALE, label, kind: "stale" };
        const why = refusedName(info.name) ?? refusedName(own);
        if (why) return { blocked: why.replace("wasn't pressed", "wasn't dragged"), label };
        let end: { x: number; y: number } | undefined;
        let dest: Locator | undefined;
        if (cached.type === "drag") {
          const r = to?.ref ? await locateLive(page, to.ref) : cached.to ? await locateSaved(page, cached.to, ctx.rules, ctx.savedOrigin ? { savedOrigin: ctx.savedOrigin, start: ctx.start } : undefined) : await byWords(page, cached.onto ?? "");
          if (!("el" in r)) return { error: `can't find where to drop it: ${"missing" in r ? r.missing : "error" in r ? r.error : "it isn't on the page"}`, label, kind: "stale" };
          dest = r.el;
          const toInfo = await dest.evaluate(inspect, undefined, { timeout: 3000 });
          // Where it goes is read too: a "Trash" or "Delete" zone is never dropped on.
          const zone = await dest.evaluate(dropZoneWords, undefined, { timeout: 2000 }).catch(() => "");
          const onto = [toInfo.name, cached.to?.name ?? cached.onto ?? "", zone].map((w) => refusedName(w) ?? refusedPlace(w)).find(Boolean);
          if (onto) return { blocked: `it wasn't dropped there: ${onto.replace(/ wasn't pressed:/, " reads like a place that")}`, label };
          if (to?.ref && cached.to) cached = { ...cached, to: await savedIdentity(page, dest, cached.to, toInfo, mask) };
        } else {
          end = dragBy(cached.value);
          if (!end) return { error: `drag_at needs "x,y": the pixels to drag it right and down (negative: left and up), each at most 2000, like "120,0"`, label };
        }
        if (live && cached.target) cached = { ...cached, target: await savedIdentity(page, el, cached.target, info, mask) } as typeof cached;
        // What is under the pointer where it lets go is read too (a drag by pixels has no other drop
        // place to read; a named one may sit inside a "Deleted" column): refused as the drop place is.
        const under = async (x: number, y: number) => {
          const words = await page.evaluate(wordsAtPoint, { x, y }).catch(() => [] as string[]);
          for (const w of words) {
            const no = refusedName(w) ?? refusedPlace(w);
            if (no) return `it wasn't dropped there: ${no.replace(/ wasn't pressed:/, " reads like a place that")}`;
          }
          return undefined;
        };
        const stopped = await dragPointer(page, el, dest ?? end!, under);
        if (stopped) return { blocked: stopped, label };
        break;
      }
      case "slide": {
        // W4: a slider set to a number: with its keys first (as a person using the keyboard), then by the
        // pointer along its track, then (a range input) its value set as a drag would leave it. Read back.
        const found = await find();
        if ("error" in found) return { error: found.error, label, kind: found.kind };
        el = found.el;
        const info = await el.evaluate(inspect, undefined, { timeout: 3000 });
        if (found.live && cached.target.name && !shareAWord(cached.target.name, info.words || info.name || info.label)) return { error: STALE, label, kind: "stale" };
        const why = refusedName(info.name || cached.target.name) ?? refusedName(info.label);
        if (why) return { blocked: why.replace("wasn't pressed", "wasn't moved"), label };
        const want = slideValue(cached.value);
        if (want === undefined) return { error: "slide needs a number, like 40", label };
        const thumb = (await el.evaluate((e) => e.matches("input[type=range], [role=slider]"), undefined, { timeout: 2000 })) ? el : el.locator("input[type=range], [role=slider]").first();
        const s = await thumb.evaluate(sliderOf, undefined, { timeout: 2000 }).catch(() => null);
        if (!s) return { error: "it isn't a slider (a range or role slider): fill it or click it instead", label, kind: "other" };
        if (want < s.min || want > s.max) return { error: `the slider goes from ${s.min} to ${s.max}`, label, kind: "other" };
        if (found.live) cached = { ...cached, target: await savedIdentity(page, el, cached.target, info, mask) };
        const reached = await slideTo(page, thumb, want, s);
        const tol = Math.max(s.step || 0, (s.max - s.min) / 1000) / 2 + 1e-9;
        if (reached === undefined || Math.abs(reached - want) > tol) return { error: `the slider ${reached === undefined ? "couldn't be read" : `stopped at ${reached}`}, not ${want}${s.step ? ` (it moves in steps of ${s.step})` : ""}`, label, kind: "other" };
        said = `the slider is at ${reached}`;
        break;
      }
      case "switch_tab": {
        // W4: another tab shown (a window the page opened, or the first again): nothing pressed.
        if (!ctx.tabs) return { error: "there's only one tab: a window the page opens is followed in this tab", label, kind: "other" };
        const why = ctx.tabs.switchTo(cached.value);
        if (why) return { error: why, label, kind: "other" };
        await page.bringToFront().catch(() => {});
        said = `the tabs: ${ctx.tabs.describe()}`;
        break;
      }
      case "download": {
        // W4: pressed exactly as a click is (every rule of a click), then the file it gave read.
        const files = downloadsOf(page);
        if (!files) return { error: "this run doesn't take downloads", label };
        const coming = files.next(15_000);
        const pressed = await actOnce(ctx, { type: "click", target: cached.target }, target, settle);
        if (!("done" in pressed)) return { ...pressed, label };
        cached = { type: "download", target: (pressed.done as { target: Target }).target };
        const got = await coming;
        if (!got) return { error: "pressing it gave no file within 15 s", label, kind: "other" };
        return { done: cached, label, ...(pressed.settledMs !== undefined ? { settledMs: pressed.settledMs } : {}), note: [pressed.note, saidOf(got, mask)].filter(Boolean).join("; ") };
      }
      case "navigate": {
        // A link from the inbox ({admin.magic_link}), fetched now: never cached, never shown.
        let address = cached.url;
        if (usesPlaceholder(address)) {
          const filmed = recordedValue(ctx.values, address);
          if (filmed) return { error: filmed.replace("didn't type", "didn't open"), label };
          const names = placeholderNames(address);
          if (names.some(isPasswordName)) return { error: "didn't go there: a password is never put in an address", label };
          const made = await freshFor(ctx.values, address);
          if ("blocked" in made) return { blocked: made.blocked, label };
          const missing = names.find((n) => !(n in made.values.vars));
          if (missing) return { error: `didn't go there: {${missing}} isn't a link this test can open (only an emailed sign-in link is)`, label };
          address = fillPlaceholders(address, (n) => made.values.vars[n]);
        }
        let to: string;
        try {
          to = new URL(address, page.url()).href;
          to = navigateOnReplay(to, ctx.savedOrigin, ctx.start);
        } catch {
          return { error: "didn't go there: it isn't an address", label };
        }
        if (!onSite(to, ctx.start, ctx.allowHosts)) return { blocked: `${hostOf(to, page.url())} is another site (add --allow-host ${hostnameOf(to, page.url())} to allow it)`, label };
        // A sign-in link ({admin.magic_link}) opens only on one of the account's exact hosts.
        if (usesPlaceholder(cached.url) && ctx.accountHosts && placeholderNames(cached.url).some((n) => !(n in ctx.values.vars) && n.includes(".")) && !ctx.accountHosts.includes(exactHost(to))) return { blocked: `didn't go there: the sign-in link is for ${ctx.accountHosts[0]}, and it goes to ${exactHost(to) || "another page"}`, label };
        const went = Date.now();
        await page.goto(to, { timeout: 20_000, waitUntil: "domcontentloaded" });
        settledMs = Date.now() - went;
        break;
      }
      case "wait":
        await page.waitForTimeout(cached.ms);
        break;
    }
    // What the action started, waited for (C10); a wait asked for is its own.
    settledMs += cached.type === "wait" ? cached.ms : await settle();
  } catch (error) {
    const off = ctx.offSite();
    if (off) return { blocked: off, label };
    // Never Playwright's call log: what was in the way, in words the actor can use.
    const said = await explainError(error instanceof Error ? error.message : String(error), { verb: cached.type === "click" ? "click" : cached.type === "hover" ? "hover" : cached.type === "dblclick" ? "double-click" : cached.type === "rightclick" ? "right-click" : cached.type === "check" || cached.type === "uncheck" ? cached.type : cached.type === "fill" ? "fill it" : cached.type === "select" ? "select it" : cached.type === "type" ? "type" : cached.type, ...(el ? { el } : {}), mask });
    return { error: said.error, label, kind: said.kind };
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  const off = ctx.offSite() ?? (siteOk(page.url(), ctx) ? undefined : `it went off the site, to ${hostOf(page.url(), ctx.start)}`);
  if (off) return { blocked: off, label };
  // A form the browser wouldn't send (a required field left empty) shows only as a bubble no snapshot has: said here.
  const fields = unsentFields ? await unsentFields().catch(() => [] as string[]) : [];
  const note = [fields.length ? `the form wasn't sent: ${mask(fields.join(", "))}` : "", said ? mask(said) : ""].filter(Boolean).join("; ");
  return { done: cached, label, settledMs, ...(note ? { note } : {}) };
}

/** W4: a drag as it is saved: its element (or its words) and where it goes (an element, or words). */
function dragOf(action: Extract<Action, { type: "drag" }> | Extract<CachedAction, { type: "drag" }>, target: (Target & { ref?: string }) | undefined, to: (Target & { ref?: string }) | undefined): Extract<CachedAction, { type: "drag" }> {
  const a = action as { target?: Target; from?: string; to?: Target | string; onto?: string; text?: string };
  const source = target ? { target: plain(target) } : a.target ? { target: plain(a.target) } : { from: String(a.from ?? a.text ?? "").replace(/\s+/g, " ").trim() };
  const dest = to ? { to: plain(to) } : typeof a.to === "object" && a.to ? { to: plain(a.to) } : { onto: String(a.onto ?? (typeof a.to === "string" ? a.to : "")).replace(/\s+/g, " ").trim() };
  return { type: "drag", ...source, ...dest };
}

/**
 * W4: an element found by its words, for what has no number: a region, list or group of that name, or
 * the one visible element whose words are exactly these (then the one that holds them).
 */
async function byWords(page: Page, words: string): Promise<{ el: Locator } | { error: string; kind: ErrorKind }> {
  const w = words.replace(/\s+/g, " ").trim();
  if (!w) return { error: "it needs the element's number, or its words", kind: "other" };
  for (const role of ["region", "group", "list", "listbox", "grid", "row", "listitem", "article", "tabpanel", "form"] as const) {
    const l = page.getByRole(role, { name: w, exact: true }).filter({ visible: true });
    if ((await l.count().catch(() => 0)) === 1) return { el: l };
  }
  for (const exact of [true, false]) {
    const l = page.getByText(w, { exact }).filter({ visible: true });
    const n = await l.count().catch(() => 0);
    if (n === 1) return { el: l };
    if (n > 1) return { error: `${n} things on the page say '${w.slice(0, 60)}': give its number instead`, kind: "other" };
  }
  return { error: `no words '${w.slice(0, 60)}' show on the page`, kind: "stale" };
}

/** Runs in the page: the words of the drop zone this element is in (its nearest named box), to read before a drop. Self-contained. */
function dropZoneWords(e: Element): string {
  for (let x: Element | null = e; x && x !== e.ownerDocument.body; x = x.parentElement) {
    const name = x.getAttribute("aria-label") || (x.matches("section, [role=region], [role=group], [role=list], ul, ol") ? (x.querySelector("h1,h2,h3,h4,h5,h6")?.textContent ?? "") : "");
    if (name.trim()) return name.trim().slice(0, 80);
  }
  return "";
}

/**
 * W4: a drag as a person's hand does it: the pointer down on the middle of the element, a few small
 * moves (past a library's start distance), then on to the middle of where it goes (or by x,y), a
 * moment there, and up. Native drag and drop and pointer-driven lists both see a real drag.
 */
async function dragPointer(page: Page, from: Locator, to: Locator | { x: number; y: number }, refuse?: (x: number, y: number) => Promise<string | undefined>): Promise<string | undefined> {
  if ("evaluate" in to) await to.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  await from.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  const a = await from.boundingBox({ timeout: 3000 });
  if (!a) throw new Error("element is not visible");
  const sx = a.x + a.width / 2;
  const sy = a.y + a.height / 2;
  let tx: number;
  let ty: number;
  if ("evaluate" in to) {
    const b = await to.boundingBox({ timeout: 3000 });
    if (!b) throw new Error("element is not visible");
    tx = b.x + b.width / 2;
    ty = b.y + b.height / 2;
  } else {
    tx = sx + to.x;
    ty = sy + to.y;
  }
  // Read before the pointer goes down: nothing is picked up to be dropped somewhere refused.
  // The thing dragged is marked for the read (it may follow the pointer): its own column isn't where it goes.
  await from.evaluate((e) => e.setAttribute("data-cm-dragged", "")).catch(() => {});
  const before = await refuse?.(tx, ty);
  if (before) {
    await from.evaluate((e) => e.removeAttribute("data-cm-dragged")).catch(() => {});
    return before;
  }
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 4, sy + 4, { steps: 2 });
  await page.mouse.move(sx + 10, sy + 10, { steps: 2 });
  await page.mouse.move(tx, ty, { steps: 16 });
  await page.mouse.move(tx + 1, ty + 1);
  await page.waitForTimeout(120);
  // And again just before letting go (the page may have moved under it): refused, it goes back home.
  const now = await refuse?.(tx + 1, ty + 1);
  if (now) {
    await page.mouse.move(sx + 10, sy + 10, { steps: 16 });
    await page.mouse.move(sx, sy, { steps: 2 });
    await page.keyboard.press("Escape").catch(() => {});
    await page.mouse.up();
    await from.evaluate((e) => e.removeAttribute("data-cm-dragged")).catch(() => {});
    return now;
  }
  await page.mouse.up();
  await from.evaluate((e) => e.removeAttribute("data-cm-dragged")).catch(() => {});
  return undefined;
}

/** Runs in the page: the words of everything under a point (each element's name, and its drop zone's), to read before a drop. Self-contained. */
function wordsAtPoint(p: { x: number; y: number }): string[] {
  const out = new Set<string>();
  for (const e of document.elementsFromPoint(p.x, p.y).slice(0, 12)) {
    if (e === document.body || e === document.documentElement || e.closest("[data-cm-dragged]")) continue;
    for (const a of ["aria-label", "title", "data-label"]) {
      const v = e.getAttribute(a);
      if (v?.trim()) out.add(v.trim().slice(0, 80));
    }
    for (let x: Element | null = e; x && x !== document.body; x = x.parentElement) {
      const name = x.getAttribute("aria-label") || (x.matches("section, [role=region], [role=group], [role=list], ul, ol") ? (x.querySelector("h1,h2,h3,h4,h5,h6")?.textContent ?? "") : "");
      if (name.trim()) {
        out.add(name.trim().slice(0, 80));
        break;
      }
    }
  }
  return [...out];
}

/** W4: a slider moved to `want`: its keys, then the pointer along its track, then a range's value set. Its value after, or undefined. */
async function slideTo(page: Page, thumb: Locator, want: number, s: NonNullable<ReturnType<typeof sliderOf>>): Promise<number | undefined> {
  const read = async () => (await thumb.evaluate(sliderOf, undefined, { timeout: 2000 }).catch(() => null))?.now;
  const close = (v: number | undefined) => v !== undefined && Math.abs(v - want) <= Math.max(s.step || 0, (s.max - s.min) / 1000) / 2 + 1e-9;
  const keys = async (limit: number) => {
    await thumb.focus({ timeout: 2000 }).catch(() => {});
    let now = await read();
    let stuck = 0;
    for (let i = 0; i < limit && now !== undefined && !close(now) && stuck < 2; i++) {
      await page.keyboard.press(now < want ? (s.vertical ? "ArrowUp" : "ArrowRight") : (s.vertical ? "ArrowDown" : "ArrowLeft"));
      const next = await read();
      // Past it: a step too big to land on the number (it is said as where it stopped).
      if (next !== undefined && now !== undefined && (next - want) * (now - want) < 0) return next;
      stuck = next === now ? stuck + 1 : 0;
      now = next;
    }
    return now;
  };
  const steps = s.step ? Math.abs(want - s.now) / s.step : Infinity;
  if (steps <= 200 || !s.native) {
    const now = await keys(s.native ? 200 : 300);
    if (close(now)) return now;
  }
  if (!s.native) {
    // The pointer along its track (the box the thumb sits in), then the keys for the last steps.
    const track = await thumb.locator("xpath=..").boundingBox({ timeout: 2000 }).catch(() => null);
    const box = await thumb.boundingBox({ timeout: 2000 }).catch(() => null);
    if (track && box && s.max > s.min) {
      const f = (want - s.min) / (s.max - s.min);
      const at = s.vertical ? { x: box.x + box.width / 2, y: track.y + track.height * (1 - f) } : { x: track.x + track.width * f, y: box.y + box.height / 2 };
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(at.x, at.y, { steps: 10 });
      await page.mouse.up();
      return keys(40);
    }
    return read();
  }
  await thumb.evaluate(setRange, want, { timeout: 2000 });
  return read();
}

/** The host name alone, as --allow-host takes it: "localhost", not "localhost:4517". */
function hostnameOf(address: string, base: string): string {
  try {
    return new URL(address, base).hostname || address.slice(0, 40);
  } catch {
    return address.slice(0, 40);
  }
}

function hostOf(address: string, base: string): string {
  try {
    return new URL(address, base).host || address.slice(0, 40);
  } catch {
    return address.slice(0, 40);
  }
}

/**
 * Keeps the test on its site, for every tab of its browser: a navigation of the page itself to
 * another site is stopped before it is sent, and so is a redirect to one. A new tab or window sends
 * nothing to another site (its first address included): where it goes on this site is followed in
 * the test's own tab, and it is closed. Returns what was stopped last, once, for act() to report.
 */
/** An address on this machine: localhost, *.localhost, 127.x, ::1. */
const onThisMachine = (url: string): boolean => {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(h) || h === "::1";
  } catch {
    return false;
  }
};

export async function guardSite(page: Page, start: string, allowHosts: readonly string[], o: { consent?: () => boolean; owner?: OwnerAccess; keepPopup?: (url: string) => boolean; /** D14: also on the site (a payment provider's page, in a pay run). */ alsoAllow?: (url: string) => boolean; /** W4: a window the page opens on the site with a link back to it (window.open) is kept here and shown, not followed. */ tabs?: Tabs } = {}): Promise<() => string | undefined> {
  let stopped: string | undefined;
  // While the first page opens (o.consent says so), a consent host (consent.<site>) counts as the
  // site: big sites send a first visit there to answer a cookie wall, and back. Only then.
  const allowed = (to: string) => onSite(to, start, allowHosts) || (Boolean(o.consent?.()) && consentHostFor(to, start)) || Boolean(o.alsoAllow?.(to));
  const leaving = (to: string) => `it tried to go to another site, ${hostOf(to, start)}, and was stopped (add --allow-host ${hostnameOf(to, start)} to allow it)`;
  const context = page.context();
  // A page load answered through this router has no address of its own, so Chromium takes it for a
  // public page and blocks what it asks of this machine (Local Network Access): a local app's script or
  // API on another local port would fail only under test. A start page on this machine may reach this
  // machine, as it does without the router: granted to its own origin, never to another site's.
  if (onThisMachine(start)) await context.grantPermissions(["local-network-access"], { origin: new URL(start).origin }).catch(() => {});
  /**
   * C15: a request to the owner's exact host goes with the owner's headers (or one to the owner's Clerk
   * Frontend API's /v1/, with its Testing Token as a query parameter): fetched here with no redirect
   * followed and fulfilled, so a redirect to another host is answered as it is, and the next hop comes
   * back through this router, where another host gets nothing. True when it was handled here.
   */
  const ownerRoute = async (route: Route, req: Request): Promise<boolean> => {
    if (!o.owner) return false;
    const extra = ownerHeadersFor(o.owner, req.url());
    const tokened = extra ? undefined : clerkTokenUrl(o.owner, req.url());
    if (!extra && !tokened) return false;
    let res: Awaited<ReturnType<typeof route.fetch>>;
    try {
      // The request's own headers as the browser sent them (its cookies among them), and the owner's added.
      const sent = Object.fromEntries(Object.entries(await req.allHeaders()).filter(([k]) => !k.startsWith(":") && k !== "content-length"));
      res = extra ? await route.fetch({ headers: { ...sent, ...extra }, maxRedirects: 0, timeout: 30_000 }) : await route.fetch({ url: tokened!, maxRedirects: 0, timeout: 30_000 });
    } catch {
      // Never sent again another way: a request that failed with the owner's values fails.
      await route.abort("failed").catch(() => {});
      return true;
    }
    const location = res.headers()["location"];
    if (req.isNavigationRequest() && res.status() >= 300 && res.status() < 400 && location && !allowed(new URL(location, req.url()).href)) {
      stopped = leaving(new URL(location, req.url()).href);
      await route.abort("blockedbyclient").catch(() => {});
      return true;
    }
    await route.fulfill({ response: res }).catch(() => {});
    return true;
  };
  // On the context, not the page: a popup's requests are routed too, so they're stopped before they go.
  await context.route("**/*", async (route) => {
    const req = route.request();
    // A new tab's first request comes before its frame exists: Playwright can't name its page then.
    let from: Page | undefined;
    try {
      from = req.frame().page();
    } catch {
      from = undefined;
    }
    // W4: a window kept (tabs) is held to the site as the test's own tab is, redirects included.
    if (from !== page && !o.tabs?.has(from)) {
      // Another tab or window: nothing it asks of another site is sent. Where it goes on this site is
      // followed in the test's own tab, and it is closed (below).
      if (allowed(req.url())) {
        if (await ownerRoute(route, req)) return;
        return route.fallback();
      }
      // The owner's Clerk Frontend API, asked from a kept sign-in window: with its token, never anything else.
      if (!req.isNavigationRequest() && (await ownerRoute(route, req))) return;
      if (req.isNavigationRequest()) stopped = `it opened another site, ${hostOf(req.url(), start)}, in a new tab, which was closed before it loaded (add --allow-host ${hostnameOf(req.url(), start)} to allow it)`;
      return route.abort("blockedbyclient").catch(() => {});
    }
    if (!req.isNavigationRequest()) {
      if (await ownerRoute(route, req)) return;
      return route.fallback();
    }
    // An embedded page of the test's site is held to the site as the page is (the test may act in it):
    // one of another site (an advert loading), or one not yet anywhere, goes on as it is.
    if (req.frame() !== page.mainFrame()) {
      let was = "";
      try {
        was = req.frame().url();
      } catch {
        was = "";
      }
      if (!/^https?:/.test(was) || !allowed(was)) return route.fallback();
    }
    if (!allowed(req.url())) {
      stopped = leaving(req.url());
      return route.abort("blockedbyclient");
    }
    // The owner's host: fetched with its headers, a POST too (sent once, here), its redirect not followed.
    if (await ownerRoute(route, req)) return;
    // A redirect is followed by the browser without asking again, so a page load is fetched here
    // first: a redirect to another site is stopped before the browser follows it. Only a GET: a
    // form's POST is never sent twice (a redirect after one is caught below, as it lands).
    if (req.method() !== "GET") return route.fallback();
    let res: Awaited<ReturnType<typeof route.fetch>>;
    try {
      res = await route.fetch({ maxRedirects: 0, timeout: 30_000 });
    } catch {
      return route.fallback();
    }
    const location = res.headers()["location"];
    if (res.status() >= 300 && res.status() < 400 && location && !allowed(new URL(location, req.url()).href)) {
      stopped = leaving(new URL(location, req.url()).href);
      return route.abort("blockedbyclient");
    }
    return route.fulfill({ response: res });
  });
  // Whatever got past the above (a redirect after a POST) is still named when it lands.
  page.on("request", (req) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame() && !allowed(req.url())) stopped ??= leaving(req.url());
  });
  // A tab that never asks for anything (about:blank, written by script) is closed all the same.
  context.on("page", (other) => {
    if (other === page) return;
    void other.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {}).then(async () => {
      const to = other.url();
      // C13: a sign-in window the page opened to a host allowed for it (the provider, with --allow-host)
      // is left to finish and answer its opener. Nothing is done in it here, and nothing typed.
      if (o.keepPopup && to.startsWith("http") && o.keepPopup(to) && (await other.opener().catch(() => null)) === page) return;
      // W4: a window the page itself opened on the site with a link back to it (window.open: a picker, a
      // preview) is kept and shown: following it here would lose what it answers back. A link's new tab
      // (no link back) is followed in this tab as before, so the video shows it.
      if (o.tabs?.roomy && to.startsWith("http") && onSite(to, start, allowHosts)) {
        const opener = await other.opener().catch(() => null);
        if (opener && o.tabs.has(opener)) {
          o.tabs.add(other, await other.title().catch(() => ""));
          return;
        }
      }
      await other.close().catch(() => {});
      if (to.startsWith("http") && onSite(to, start, allowHosts)) await page.goto(to, { timeout: 20_000, waitUntil: "domcontentloaded" }).catch(() => {});
    });
  });
  return () => {
    const said = stopped;
    stopped = undefined;
    return said;
  };
}
