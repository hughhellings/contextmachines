import { signedInUser } from "./auto-identify.ts";
import { RuleSet, type EvalContext, type Mode, type Rule, type RuleAction } from "@contextmachines/rules-core";
import type { ActionPattern, CapturedEvent, Delivery } from "@contextmachines/schemas";
import { firestoreWrite, intentOf, parseBody } from "./body.ts";
import { DecideClient } from "./decide.ts";
import { buttonIntent, installInteractionCapture, installRouteCapture } from "./dom.ts";
import { installNetworkCapture, type RawRequest } from "./network.ts";
import { describeFields } from "./redact.ts";
import { run } from "./safe.ts";
import { Transport } from "./transport.ts";
import { Guide } from "./guide.ts";
import { Inspector, inspectRequested, quiet } from "./inspect.ts";
import { isOwnUi, OWN_UI } from "./own.ts";
import { controlLabel, isScreenDocument, setKeepNumbers, snapshotPage, snapshotSignature } from "./page.ts";
import { deviceOf } from "./device.ts";
import { installSocketCapture, type SocketAction, type SocketReply } from "./socket.ts";
import { currentView, withView, withoutView } from "./view.ts";
import { rememberBrowser, sharedDomain, startVisit } from "./visit.ts";

/**
 * Where help may take someone: an ordinary web page on this site or one of its own subdomains.
 * Anything else ("javascript:", another site) is refused, whatever the server says.
 */
export function sameSiteUrl(win: Window & typeof globalThis, path: string): string | undefined {
  let url: URL;
  try {
    url = new URL(path, win.location.origin);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.origin === win.location.origin) return url.href;
  const site = sharedDomain(win);
  return site && (url.hostname === site || url.hostname.endsWith(`.${site}`)) ? url.href : undefined;
}
import { installStruggleCapture, type StruggleCapture } from "./struggle.ts";
import { Prompter, type PromptOutcome } from "./ui.ts";
import { normalizeUrl, pathMatches } from "./url.ts";

export interface InitOptions {
  /** Publishable key (pk_test_… / pk_live_…). Never a secret key. */
  key: string;
  /** Ingest endpoint, e.g. https://ingest.example.com/v1/events */
  endpoint: string;
  /** Off switch for the site's owner. When false the snippet does nothing at all. */
  enabled?: boolean;
  /** 0..1, per visit. */
  sampleRate?: number;
  /** "shadow" (default) only observes; "live" allows configured actions. */
  mode?: Mode;
  /** Exact field paths whose scrubbed values may be sent. Everything else is shape-only. */
  allowValues?: string[];
  /** Only capture requests to these origins (defaults to the page's own origin). */
  captureOrigins?: string[];
  siteModel?: ActionPattern[];
  rules?: Rule[];
  /**
   * Fetch mode, site model, rules and allowed values from the server at start-up
   * (GET <configEndpoint>?key=…). Overrides the local options when it arrives.
   */
  configEndpoint?: string;
  userId?: string;
  /**
   * Proof the user id came from your server: HMAC-SHA256 of the user id with your identity secret,
   * in hex, computed on your server (never in the browser). Required once you turn on verified identity.
   */
  userHash?: string;
  userRole?: string;
  /**
   * Keep one visit across page loads and your own subdomains (www → app) with a first-party
   * cookie holding a random id (default true). Set false to treat each page load separately.
   */
  visitCookie?: boolean;
  /**
   * Recognise a returning browser when you pass no userId, with a first-party cookie holding a
   * random id for 13 months (default false). Mention it in your cookie notice before turning it on.
   * A userId (init or identify) is better: it follows the person across devices.
   */
  rememberBrowser?: boolean;
  /**
   * Recognise the signed-in user by themselves when the site uses Supabase, Clerk, Auth0 (local
   * storage) or Firebase (local persistence), reading only the user's id (default true). Not
   * used once you pass a userId or call identify; false turns it off.
   */
  autoIdentify?: boolean;
  /** The user's plan or tier as your site names it ("free", "pro"), so help only covers what their plan includes. */
  plan?: string;
  /** Decision service for rules that need model judgment. Without it, those rules are only logged. */
  decideEndpoint?: string;
  /**
   * Show a panel listing every request the snippet sends, byte for byte, so you can check it.
   * Also turned on by adding ?ctx-inspect to the page address; false turns that off too.
   */
  inspect?: boolean;
  /**
   * Keep numbers in the site's own words: page headings, the title and button labels ("404 Not
   * Found", "Pay 3 invoices"). Default false: they are masked as "#" because on a live product
   * they can be someone's record numbers, amounts or dates. For reading a site where no one's
   * data is on screen, such as a learner exploring it signed out.
   */
  keepNumbers?: boolean;
  /**
   * Query keys that say which page this is, for a site that routes by its query (index.php?page=
   * invoices): their values become part of the page's address, and a record picked by the query
   * (?id=) becomes ":id". Default none: only the keys' names are sent. For a learner reading a site,
   * like keepNumbers.
   */
  routeKeys?: string[];
  /**
   * Tell apart the buttons of one form that share an address, by the name and value they send
   * ("action=INIT"). Default false: buttons are known by their labels. For a learner, like keepNumbers.
   */
  buttonIntents?: boolean;
  /** Show the built-in on-screen prompt for nudge/fix/block outcomes (default true). */
  ui?: boolean;
  /** Applies a fix for fix-level rules; enables the prompt's "Fix it" button. */
  onFix?: (outcome: SnippetOutcome) => void | Promise<void>;
  /** Called for each violation (local or server-decided). Errors thrown here are contained. */
  onOutcome?: (outcome: SnippetOutcome, ctx: EvalContext) => void;
}

interface RemoteConfig {
  v: 1;
  mode: Mode;
  siteModel: ActionPattern[];
  rules: Rule[];
  allowValues: string[];
}

export interface SnippetOutcome {
  ruleId: string;
  ruleVersion: number;
  status: "violated";
  effectiveAction: RuleAction;
  message: string;
  reason?: string;
  source: "local" | "server";
}

export interface Handle {
  readonly active: boolean;
  /**
   * Pre-flight check before the host app sends an action: runs rules on the
   * given data (shape-only, same redaction as capture) and shows prompts.
   * Returns local violations immediately; model rules are decided in the
   * background. Host apps cancel the action if any outcome is "block".
   */
  check(actionId: string, data: unknown): SnippetOutcome[];
  identify(userId: string | undefined, role?: string, plan?: string, userHash?: string): void;
  flush(): Promise<void>;
  shutdown(): void;
}

const INACTIVE: Handle = { active: false, check: () => [], identify() {}, flush: async () => {}, shutdown() {} };
let current: Handle | undefined;

/** Cookie and consent banner controls: "Accept all cookies", "Reject non-essential", "Cookie choices". */
/** The longest a page's reading waits for it to stop changing. */
const MAX_SETTLE_WAIT_MS = 3000;
const CONSENT = /\bcookies?\b|\bconsent\b|^(accept|reject|allow|decline)( all| non-essential| optional)?$/i;

export function init(options: InitOptions, win: Window & typeof globalThis = window): Handle {
  return run(() => start(options, win)) ?? INACTIVE;
}

function start(options: InitOptions, win: Window & typeof globalThis): Handle {
  if (current?.active) return current; // idempotent: never double-wrap the page
  if (options.enabled === false) return INACTIVE;
  if (!/^pk_(test|live)_/.test(options.key)) return INACTIVE; // refuse secret keys in the browser
  const visit = startVisit(win, Date.now, options.visitCookie !== false);
  // Sampled per visit, so a visit is never half recorded across its pages.
  if (parseInt(visit.id.replace(/-/g, "").slice(0, 8), 16) / 2 ** 32 >= (options.sampleRate ?? 1)) return INACTIVE;

  setKeepNumbers(options.keepNumbers === true);
  const base = win.location.href;
  const normalize = (url: string, from: string) => normalizeUrl(url, from, options.routeKeys);
  const endpoint = new URL(options.endpoint, base);
  const captureOrigins = new Set(options.captureOrigins ?? [win.location.origin]);
  let allowValues = new Set(options.allowValues ?? []);
  let siteModel = options.siteModel ?? [];
  let rules = new RuleSet(options.rules ?? []);
  let mode: Mode = options.mode ?? "shadow";
  let user = { id: options.userId, role: options.userRole, plan: options.plan };
  /** The site told us who is signed in itself: from then on, it decides. */
  let toldBySite = options.userId !== undefined;
  /** The id came from the sign-in tool, not the site (so a sign-out there clears it). */
  let autoId: string | undefined;
  let route: string | undefined;
  /** The address part of the route, without any view inside the page. */
  let basePath: string | undefined;

  const sid = visit.id;
  const originalFetch = win.fetch.bind(win); // captured before wrapping: our own traffic is never observed
  const inspector = inspectRequested(win, options.inspect) ? quiet(() => new Inspector(win.document)) : undefined;
  /** Every request the snippet makes goes through here, so the inspector (when on) sees exactly what is sent. */
  const ownFetch: typeof fetch = inspector
    ? (input, init) => {
        const body = init?.body;
        quiet(() => inspector.record({ method: (init?.method ?? "GET").toUpperCase(), url: String(input), via: "fetch", body: typeof body === "string" ? body : body == null ? undefined : "(non-text body)" }));
        return originalFetch(input, init);
      }
    : originalFetch;
  const sendBeacon = (url: string, data: Blob) => {
    const sent = win.navigator.sendBeacon(url, data);
    // A refused beacon sent nothing; its events stay queued and show up when they are sent.
    if (sent && inspector) void data.text().then((body) => quiet(() => inspector.record({ method: "POST", url, via: "beacon", body })), () => {});
    return sent;
  };
  const decideUrl = options.decideEndpoint ? new URL(options.decideEndpoint, base).href : undefined;
  const decider = decideUrl ? new DecideClient({ endpoint: decideUrl, key: options.key, sessionId: sid, fetch: ownFetch }) : undefined;
  decider?.identify(user.id, options.userHash);
  const transport = new Transport({
    endpoint: endpoint.href,
    key: options.key,
    sessionId: sid,
    ...(options.rememberBrowser === true ? { browserId: rememberBrowser(win) } : {}),
    fetch: ownFetch,
    lang: () => win.document.documentElement.lang,
    device: run(() => deviceOf(win)) ?? "computer",
    sendBeacon: typeof win.navigator.sendBeacon === "function" ? sendBeacon : undefined,
    onResponse: (body) => {
      const deliver = (body as { deliver?: Delivery } | undefined)?.deliver;
      if (deliver && typeof deliver.message === "string" && Array.isArray(deliver.steps)) guide?.present(deliver);
    },
  });
  transport.identify(user.id, user.plan, user.role, options.userHash);

  if (options.configEndpoint) {
    const url = new URL(options.configEndpoint, base);
    url.searchParams.set("key", options.key);
    void ownFetch(url.href, { credentials: "omit" })
      .then((res) => (res.ok ? (res.json() as Promise<RemoteConfig>) : undefined))
      .then((config) =>
        run(() => {
          if (!config || config.v !== 1) return;
          mode = config.mode === "live" ? "live" : "shadow";
          siteModel = Array.isArray(config.siteModel) ? config.siteModel : siteModel;
          rules = new RuleSet(Array.isArray(config.rules) ? config.rules : []);
          allowValues = new Set(Array.isArray(config.allowValues) ? config.allowValues : []);
        }),
      )
      .catch(() => {});
  }

  const emit = (event: CapturedEvent) =>
    run(() => {
      visit.touch();
      transport.push(event);
    });
  const t = () => Date.now();
  /** The last click/submit, so a write that follows can be attributed to the button that caused it. */
  let lastInteraction: { type: "click" | "submit" | "change"; tag: string; label?: string; page?: string; intent?: string; at: number } | undefined;
  const TRIGGER_WINDOW_MS = 2000;
  let onRouteChange: (() => void) | undefined;
  /** Takes a page snapshot that is still waiting, before the route moves on (people can leave a page within half a second). */
  let flushPageCapture: (() => void) | undefined;
  /** Snapshot now (a pop-up or step has just appeared), and re-read the view (the page just drew). */
  let capturePageNow: (() => void) | undefined;
  let checkViewNow: (() => void) | undefined;
  /** The page before this one (for multi-page sites, where the user came from), to offer "Take me there" by going back. */
  let previousRoute: string | undefined = run(() => {
    const ref = win.document.referrer;
    return ref && new URL(ref).origin === win.location.origin ? normalize(ref, base)?.path : undefined;
  });
  /** Last time something visible happened (request, navigation, DOM change): used to spot dead clicks. */
  let lastActivity = 0;
  let struggle: StruggleCapture | undefined;
  const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

  /** Actions the host app already checked via check(): the request that follows is not evaluated again. */
  const prechecked = new Map<string, number>();
  const PRECHECK_WINDOW_MS = 10_000;

  const onRequest = (req: RawRequest): void => {
    const url = normalize(req.url, base);
    if (!url) return;
    // Firestore: the app's data API, on Google's address. Read as "update tasks", never as a channel.
    const firestore = url.origin === FIRESTORE || captureOrigins.has(url.origin) ? firestoreWrite(url.path, req.body) : undefined;
    if (firestore) {
      return onRequest({ ...req, url: `${win.location.origin}/firestore/${firestore.collection}`, body: JSON.stringify(firestore.data), firestoreOperation: firestore.operation });
    }
    if (!captureOrigins.has(url.origin) && !req.firestoreOperation) return;
    // tRPC batches several procedures into one request (/api/trpc/a.list,b.get): each is its own action.
    const batch = /^(.*\/trpc\/)([^/]+,[^/]+)$/.exec(url.path);
    if (batch) {
      batch[2]!.split(",").slice(0, 10).forEach((proc, i) => onRequest({ ...req, url: req.url.replace(batch[2]!, proc), body: i === 0 ? req.body : undefined }));
      return;
    }
    const parsed = parseBody(req.body);
    const fields = describeFields(parsed.data, allowValues);
    // Which action this is, when the address is shared: a GraphQL operation, a Next.js server action, or a form's intent.
    const pressed = lastInteraction && t() - req.durationMs - lastInteraction.at < TRIGGER_WINDOW_MS ? lastInteraction.intent : undefined;
    const operation = req.firestoreOperation ? `firestore:${req.firestoreOperation}` : (parsed.graphqlOperation ?? (req.nextAction ? `next:${req.nextAction}` : (intentOf(parsed.data, options.buttonIntents) ?? (WRITE_METHODS.has(req.method) ? pressed : undefined))));
    const actionId = matchAction(siteModel, req.method, url.path, operation);

    const event: CapturedEvent = { t: t(), kind: "network", method: req.method, path: url.path, queryKeys: url.queryKeys, fields, status: req.status, durationMs: Math.round(req.durationMs) };
    if (operation) event.graphqlOperation = operation;
    if (req.appFailed) event.failed = true;
    if (req.errorCode) event.errorCode = req.errorCode;
    if (req.result) event.result = req.result;
    if (actionId) event.actionId = actionId;
    lastActivity = t();
    // The field a failed reply blames is kept only when it's a field on this page (not, say, a GraphQL path).
    if (WRITE_METHODS.has(req.method) && struggle?.markSubmitted(!(req.appFailed || req.status === 0 || req.status >= 400), req.errorField) && req.errorField) event.errorField = req.errorField;
    // A search (by its address or its fields) whose list came back: empty or not.
    if (req.result && (SEARCH_REQUEST.test(url.path) || url.queryKeys.some((k) => SEARCH_KEY.test(k)) || Object.keys(fields).some((k) => SEARCH_KEY.test(k)))) {
      const lists = Object.entries(req.result).filter(([k, s]) => s.type === "array" && (k === "_items" || LIST_KEY.test(k.split(".").pop() ?? "")));
      if (lists.length) struggle?.searched(lists.every(([, s]) => s.empty));
    }
    const startedAt = t() - req.durationMs;
    if (lastInteraction && WRITE_METHODS.has(req.method) && startedAt - lastInteraction.at >= -50 && startedAt - lastInteraction.at < TRIGGER_WINDOW_MS) {
      const trigger: NonNullable<typeof event.trigger> = { type: lastInteraction.type, tag: lastInteraction.tag };
      if (lastInteraction.label) trigger.label = lastInteraction.label;
      if (lastInteraction.page) trigger.page = lastInteraction.page;
      event.trigger = trigger;
    }
    emit(event);

    if (!actionId) return;
    const checkedAt = prechecked.get(actionId);
    if (checkedAt !== undefined && t() - checkedAt < PRECHECK_WINDOW_MS) {
      prechecked.delete(actionId);
      return;
    }
    evaluate(contextFor(actionId, fields));
  };

  const prompter =
    options.ui === false
      ? undefined
      : run(() => {
          const promptOptions: ConstructorParameters<typeof Prompter>[1] = {
            onFeedback: (o, value) => emit({ t: t(), kind: "feedback", ruleId: o.ruleId, ruleVersion: o.ruleVersion, value }),
          };
          const onFix = options.onFix;
          if (onFix) promptOptions.onFix = (o) => onFix({ ...o, status: "violated", source: "local" });
          return new Prompter(win.document, promptOptions);
        });

  // Guidance: suggestions the server decides to show come back on ingest responses.
  const guide =
    options.ui === false
      ? undefined
      : run(
          () =>
            new Guide(win.document, {
              report: (d, value) => emit({ t: t(), kind: "guidance", suggestionId: d.suggestionId.slice(0, 64), goalId: d.goalId.slice(0, 128), value }),
              currentPath: () => route,
              // A record's page ("/book/:id") is reached by going back to it; others by their address.
              // A view (a pop-up or a step) can't be opened from an address: only the page it is on can be.
              canNavigate: (path) => (!path.includes(":id") || path === previousRoute) && withoutView(path) !== withoutView(route ?? ""),
              navigate: (path) => {
                if (path.includes(":id")) return win.history.back();
                path = withoutView(path);
                const to = sameSiteUrl(win, path);
                if (to) win.location.assign(to);
              },
            }),
        );

  const report = (outcome: SnippetOutcome, ctx: EvalContext) => {
    if (options.onOutcome) run(() => options.onOutcome?.(outcome, ctx));
    const action = outcome.effectiveAction;
    if (prompter && (action === "nudge" || action === "fix" || action === "block")) {
      const prompt: PromptOutcome = { ruleId: outcome.ruleId, ruleVersion: outcome.ruleVersion, effectiveAction: action, message: outcome.message };
      if (outcome.reason) prompt.reason = outcome.reason;
      run(() => prompter.show(prompt));
    }
  };

  const evaluate = (ctx: EvalContext): SnippetOutcome[] => {
    const local: SnippetOutcome[] = [];
    const pendingModelRules = new Set<string>();
    for (const outcome of rules.evaluate(ctx, mode)) {
      emit({ t: t(), kind: "decision", ruleId: outcome.ruleId, ruleVersion: outcome.ruleVersion, status: outcome.status, configuredAction: outcome.configuredAction, effectiveAction: outcome.effectiveAction, actionId: ctx.action.id, mode });
      if (outcome.status === "violated") {
        const o: SnippetOutcome = { ruleId: outcome.ruleId, ruleVersion: outcome.ruleVersion, status: "violated", effectiveAction: outcome.effectiveAction, message: outcome.message, source: "local" };
        local.push(o);
        report(o, ctx);
      } else if (outcome.status === "needs_model") {
        pendingModelRules.add(outcome.ruleId);
      }
    }
    if (pendingModelRules.size === 0 || !decider) return local;
    void decider.decide(ctx).then((res) =>
      run(() => {
        // The server re-checks every rule; only report the ones the browser could not decide.
        for (const o of res?.outcomes ?? []) {
          if (o.status !== "violated" || !pendingModelRules.has(o.ruleId)) continue;
          const outcome: SnippetOutcome = { ruleId: o.ruleId, ruleVersion: o.ruleVersion, status: "violated", effectiveAction: o.effectiveAction, message: o.message, source: "server" };
          if (o.reason) outcome.reason = o.reason;
          report(outcome, ctx);
        }
      }),
    );
    return local;
  };

  const contextFor = (actionId: string, fields: EvalContext["fields"]): EvalContext => ({
    action: { id: actionId },
    fields,
    page: route ? { route } : {},
    user: user.role ? { role: user.role } : {},
  });

  // Actions over a live connection: recorded once the server answers (or after a few seconds), so a
  // refusal and its code come with them. Only what a person caused counts: heartbeats, presence and
  // per-keystroke validation are not actions.
  const SOCKET_REPLY_WAIT_MS = 3000;
  const socketWaiting = new Map<SocketAction, { event: Extract<CapturedEvent, { kind: "network" }>; timer: ReturnType<typeof setTimeout> }>();
  const onSocketSend = (a: SocketAction) => {
    const url = run(() => new URL(a.url.replace(/^ws/, "http")));
    if (!url || !(url.host === win.location.host || [...captureOrigins].some((o) => run(() => new URL(o).host) === url.host) || DATA_SOCKETS.test(url.hostname))) return;
    const at = t();
    if (!lastInteraction || at - lastInteraction.at > TRIGGER_WINDOW_MS) return;
    const operation = `ws:${a.operation}`;
    const event: Extract<CapturedEvent, { kind: "network" }> = { t: at, kind: "network", method: "WS", path: normalize(url.href, base)?.path ?? "/", queryKeys: [], fields: describeFields(a.data, allowValues), graphqlOperation: operation };
    const actionId = matchAction(siteModel, "WS", event.path, operation);
    if (actionId) event.actionId = actionId;
    const trigger: NonNullable<typeof event.trigger> = { type: lastInteraction.type, tag: lastInteraction.tag };
    if (lastInteraction.label) trigger.label = lastInteraction.label;
    if (lastInteraction.page) trigger.page = lastInteraction.page;
    event.trigger = trigger;
    lastActivity = at;
    struggle?.markSubmitted();
    socketWaiting.set(a, { event, timer: setTimeout(() => run(() => { socketWaiting.delete(a); emit(event); }), SOCKET_REPLY_WAIT_MS) });
  };
  const onSocketReply = (r: SocketReply) => {
    const w = socketWaiting.get(r.action);
    if (!w) return;
    clearTimeout(w.timer);
    socketWaiting.delete(r.action);
    lastActivity = t();
    emit({ ...w.event, status: r.ok ? 200 : 422, ...(r.errorCode ? { errorCode: r.errorCode } : {}) });
  };

  // Who is signed in, read from the site's sign-in tool when it doesn't say (see auto-identify.ts).
  const checkSignedIn = () =>
    run(() => {
      if (toldBySite || options.autoIdentify === false) return;
      const id = signedInUser(win);
      if (id === autoId) return;
      autoId = id;
      user = { ...user, id };
      transport.identify(id, user.plan, user.role);
      decider?.identify(id);
    });
  checkSignedIn();
  const signedInTimer = win.setInterval(checkSignedIn, 5000);
  const onStorage = () => checkSignedIn();
  win.addEventListener("storage", onStorage);

  const uninstalls = [
    () => {
      win.clearInterval(signedInTimer);
      win.removeEventListener("storage", onStorage);
    },
    installSocketCapture(win, onSocketSend, onSocketReply),
    installNetworkCapture(win, onRequest, (u) => run(() => new URL(u, base).href.startsWith(endpoint.href)) ?? false),
    installRouteCapture(win, ({ url }) => {
      const n = normalize(url, base);
      if (!n) return;
      basePath = n.path;
      moveTo(n.path, false);
      // The new page usually draws just after the address changes: its pop-up or step is read then.
      setTimeout(() => checkViewNow?.(), 0);
    }),
    installInteractionCapture(
      win.document,
      (i, button) => {
        const at = t();
        // A cookie banner's buttons are never what the person came to do, nor the cause of
        // the app's next request: forget the click rather than credit it.
        if (i.label && CONSENT.test(i.label)) {
          lastInteraction = undefined;
        } else {
          lastInteraction = { type: i.type, tag: i.tag, at };
          if (route) lastInteraction.page = route;
          if (i.label) lastInteraction.label = i.label;
          const intent = options.buttonIntents && button ? buttonIntent(button) : undefined;
          if (intent) lastInteraction.intent = intent;
        }
        emit({ t: at, kind: "interaction", ...i, path: route ?? "/" });
      },
      () => prompter?.element ?? null,
    ),
    installPageCapture(),
    (struggle = installStruggleCapture(win.document, {
      report: (s) => emit({ t: t(), kind: "struggle", ...s }),
      currentPath: () => route ?? "/",
      pathOf: (url) => {
        const n = normalize(url, base);
        return n && n.origin === new URL(base).origin ? n.path : undefined;
      },
      // >=: a navigation in the same millisecond as the click is still a response to it.
      somethingHappenedSince: (since) => lastActivity >= since,
      isOwnUi,
      labelOf: (el) => controlLabel(el),
    })),
  ];

  /**
   * Arrives at a page, or at a view inside one (a pop-up, a wizard step, a tab): everything that
   * happens next is filed under it.
   */
  function moveTo(path: string, viewChange: boolean) {
    if (path === route) return;
    // Signing in usually ends on a new page: check who it is now.
    checkSignedIn();
    // A new address: the page being left is usually still on screen, so its snapshot is taken now.
    // A new view: the screen has already changed, so the snapshot is taken after moving (below).
    if (!viewChange) flushPageCapture?.();
    if (route !== undefined) previousRoute = route;
    // Update the route first: the struggle detector files what happened on the page being left, then reads the new one.
    route = path;
    struggle?.pageChanged();
    guide?.pageChanged(path);
    lastActivity = t();
    emit({ t: t(), kind: "route", path });
    if (viewChange) capturePageNow?.();
    else onRouteChange?.();
  }

  /** Page structure: sent on navigation and when the DOM settles after changes, only if it changed. */
  function installPageCapture(): () => void {
    const sentSignatures = new Map<string, string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capture = () =>
      run(() => {
        timer = undefined;
        // A reply opened on its own (JSON, plain text, an image) is data, not a screen of the product.
        if (!isScreenDocument(win.document)) return;
        const path = route ?? normalize(win.location.href, base)?.path ?? "/";
        const snapshot = snapshotPage(win.document, (url) => normalize(url, base)?.path);
        const signature = snapshotSignature(snapshot);
        if (sentSignatures.get(path) === signature) return;
        if (sentSignatures.size > 200) sentSignatures.clear();
        sentSignatures.set(path, signature);
        emit({ t: t(), kind: "page", path, snapshot });
      });
    // Read once the page stops changing, but never later than this: a ticker or an animation never stops.
    let pendingSince: number | undefined;
    const schedule = (ms: number) => {
      const at = Date.now();
      if (timer !== undefined) {
        if (pendingSince !== undefined && at - pendingSince > MAX_SETTLE_WAIT_MS) return;
        clearTimeout(timer);
      } else pendingSince = at;
      timer = setTimeout(() => {
        pendingSince = undefined;
        capture();
      }, ms);
    };
    schedule(500);
    const observer =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver((records) => {
            if (records.some((r) => !(r.target instanceof Element && r.target.closest(OWN_UI)))) lastActivity = t();
            schedule(1500);
            checkView();
          })
        : undefined;
    // Also what opens, closes and selects things in place: a <dialog> closing only loses its "open".
    observer?.observe(win.document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "hidden", "aria-hidden", "aria-selected", "aria-current", "aria-expanded"] });
    onRouteChange = () => schedule(500);
    // A pop-up opening or a wizard moving on changes the view without changing the address. Checked
    // as the change lands (observer callbacks run before the next input), so nothing typed on the
    // new step is filed under the old one.
    const checkView = () =>
      run(() => {
        if (basePath !== undefined) moveTo(withView(basePath, currentView(win.document)), true);
      });
    checkViewNow = checkView;
    // A pop-up can close within half a second: its snapshot is taken as it opens, not later.
    capturePageNow = () => {
      if (timer !== undefined) clearTimeout(timer);
      capture();
    };
    flushPageCapture = () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      capture();
    };
    return () => {
      flushPageCapture = undefined;
      capturePageNow = undefined;
      checkViewNow = undefined;
      observer?.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      onRouteChange = undefined;
    };
  }

  // Actions still waiting for their live-connection reply are recorded as the page closes, not lost.
  const flushSockets = () => {
    for (const [a, w] of socketWaiting) {
      clearTimeout(w.timer);
      socketWaiting.delete(a);
      emit(w.event);
    }
  };
  const onHide = () => run(() => win.document.visibilityState === "hidden" && (flushSockets(), transport.flushOnExit()));
  const onPageHide = () => run(() => (flushSockets(), transport.flushOnExit()));
  win.document.addEventListener("visibilitychange", onHide);
  win.addEventListener("pagehide", onPageHide);

  const handle: Handle = {
    active: true,
    check(actionId, data) {
      prechecked.set(actionId, t());
      return run(() => evaluate(contextFor(actionId, describeFields(data, allowValues)))) ?? [];
    },
    identify(userId, role, plan, userHash) {
      run(() => {
        toldBySite = true;
        user = { id: userId, role, plan };
        transport.identify(userId, plan, role, userHash);
        decider?.identify(userId, userHash);
      });
    },
    // "Send what you have": live-connection actions still waiting for a reply go too, and a reading
    // of the page still waiting for it to settle. A page left soon after it loads (a link opened and
    // closed again, a learner moving on) is otherwise never described at all.
    flush: () => (run(() => (flushPageCapture?.(), flushSockets())), transport.flush().catch(() => {})),
    shutdown() {
      run(() => {
        uninstalls.forEach((u) => run(u));
        setKeepNumbers(false); // back to masking, for whatever starts next
        prompter?.destroy();
        guide?.destroy();
        inspector?.destroy();
        win.document.removeEventListener("visibilitychange", onHide);
        win.removeEventListener("pagehide", onPageHide);
        transport.flushOnExit();
        transport.stop();
        if (current === handle) current = undefined;
      });
    },
  };
  current = handle;
  return handle;
}

/** How searches are asked for, and where the list comes back. */
const SEARCH_REQUEST = /(^|\/)(search|autocomplete|lookup|find)(\/|$|_|-)/i;
const SEARCH_KEY = /^(q|query|search|term|keywords?|s)$/i;
const LIST_KEY = /^(results|items|data|hits|records|rows|matches|documents|list|entries|nodes|edges)$/i;

/** The app's data APIs on someone else's address: read like the app's own requests. */
const FIRESTORE = "https://firestore.googleapis.com";
const DATA_SOCKETS = /\.(firebaseio\.com|firebasedatabase\.app)$/;

export function matchAction(patterns: readonly ActionPattern[], method: string, path: string, graphqlOperation?: string): string | undefined {
  for (const p of patterns) {
    if (p.method !== "*" && p.method !== method) continue;
    if (!pathMatches(p.path, path)) continue;
    if (p.graphqlOperation && p.graphqlOperation !== graphqlOperation) continue;
    return p.id;
  }
  return undefined;
}

