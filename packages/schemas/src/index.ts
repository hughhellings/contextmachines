/**
 * Wire contracts shared by every component. Server code validates with these
 * schemas; the browser snippet imports the inferred types only (zero runtime cost).
 */
import { z } from "zod";
import { validateExpr, type EvalContext, type Expr, type FieldShape, type Rule } from "@contextmachines/rules-core";

export const LIMITS = {
  maxEventsPerBatch: 100,
  maxFieldsPerEvent: 64,
  maxPathLength: 512,
  maxLabelLength: 80,
} as const;

// ---------- Rules ----------

export const ExprSchema: z.ZodType<Expr> = z.custom<Expr>((value) => validateExpr(value).length === 0, {
  message: "invalid rule expression",
});

export const FieldShapeSchema: z.ZodType<FieldShape> = z.strictObject({
  type: z.enum(["string", "number", "boolean", "null", "array", "object", "file", "unknown"]),
  empty: z.boolean(),
  length: z.number().int().nonnegative().optional(),
  value: z.union([z.string().max(1024), z.number(), z.boolean()]).optional(),
});

const FieldsSchema = z
  .record(z.string().max(128), FieldShapeSchema)
  .refine((f) => Object.keys(f).length <= LIMITS.maxFieldsPerEvent, `at most ${LIMITS.maxFieldsPerEvent} fields`);

export const EvalContextSchema: z.ZodType<EvalContext> = z.strictObject({
  action: z.strictObject({ id: z.string().min(1) }),
  fields: FieldsSchema.optional(),
  page: z.strictObject({ route: z.string().optional() }).optional(),
  user: z.strictObject({ role: z.string().optional() }).optional(),
  pad: z.record(z.string(), z.unknown()).optional(),
});

const RuleBase = {
  id: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
  version: z.number().int().positive(),
  bindsTo: z.strictObject({ actions: z.array(z.string().min(1)).min(1) }),
  action: z.enum(["observe", "nudge", "fix", "block", "escalate"]),
  message: z.string().min(1).max(500),
  status: z.enum(["draft", "approved", "disabled"]),
  tests: z.strictObject({ shouldFlag: z.array(EvalContextSchema), shouldNotFlag: z.array(EvalContextSchema) }).optional(),
};

export const RuleSchema: z.ZodType<Rule> = z.discriminatedUnion("kind", [
  z.strictObject({ ...RuleBase, kind: z.literal("deterministic"), when: ExprSchema }),
  z.strictObject({ ...RuleBase, kind: z.literal("model"), instruction: z.string().min(1).max(4000), when: ExprSchema.optional() }),
]);

/** Audit metadata kept alongside a rule in the control plane (not shipped to the browser). */
export const RuleProvenanceSchema = z.strictObject({
  ruleId: z.string(),
  ruleVersion: z.number().int().positive(),
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("document"), documentId: z.string(), locator: z.string().optional() }),
    z.strictObject({ kind: z.literal("pack"), packId: z.string(), packVersion: z.string() }),
    z.strictObject({ kind: z.literal("manual") }),
    z.strictObject({ kind: z.literal("suggested"), evidence: z.string() }),
  ]),
  approvedBy: z.string().optional(),
  approvedAt: z.iso.datetime().optional(),
});
export type RuleProvenance = z.infer<typeof RuleProvenanceSchema>;

// ---------- Site model ----------

/** Maps a normalised request to a named action, e.g. POST /api/assessments/:id/publish => assessment.publish */
export const ActionPatternSchema = z.strictObject({
  id: z.string().min(1).max(128),
  label: z.string().max(LIMITS.maxLabelLength).optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "*"]),
  path: z.string().startsWith("/").max(LIMITS.maxPathLength),
  graphqlOperation: z.string().max(128).optional(),
});
export type ActionPattern = z.infer<typeof ActionPatternSchema>;

// ---------- Captured events ----------

const Base = { t: z.number().int().nonnegative() };

/**
 * A page address: a path on this site ("/invoices"), or a page on another of the site's own
 * addresses ("//www.acme.com/pricing"). Never a scheme ("javascript:", "https://…"), so it can
 * never become anything but a page when help takes someone there.
 */
const PAGE = /^(\/(?!\/)|\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/|$))/;
const PagePath = z.string().max(LIMITS.maxPathLength).regex(PAGE, "a path starting with /");

/** Whether a page address is safe to send someone to: a path here, or a page on one of these hosts. */
export function isSafePage(page: string, hosts: readonly string[]): boolean {
  if (!PAGE.test(page) || page.length > LIMITS.maxPathLength) return false;
  if (!page.startsWith("//")) return true;
  const host = page.slice(2).split("/")[0] ?? "";
  return hosts.includes(host.toLowerCase());
}

export const NetworkEventSchema = z.strictObject({
  ...Base,
  kind: z.literal("network"),
  method: z.string().max(16),
  path: z.string().max(LIMITS.maxPathLength),
  queryKeys: z.array(z.string().max(64)).max(32),
  graphqlOperation: z.string().max(128).optional(),
  /** A save whatever its method: a GET that changes a cart, stopped by the learner. */
  save: z.literal(true).optional(),
  fields: FieldsSchema,
  status: z.number().int().min(0).max(599).optional(),
  durationMs: z.number().nonnegative().optional(),
  /** The app reported failure despite a 2xx status (e.g. GraphQL "errors"). */
  failed: z.boolean().optional(),
  /** The app's own error code ("CARD_DECLINED"): a machine code only, never a message. */
  errorCode: z.string().regex(/^[A-Za-z][A-Za-z_.-]{2,47}$/).optional(),
  /** The form field a failed reply blames: a field name only. */
  errorField: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,47}$/).optional(),
  /** What a successful reply gave back: shapes only, never values. */
  result: FieldsSchema.optional(),
  actionId: z.string().max(128).optional(),
  /** The click or submit that caused this request, when one happened just before it. */
  trigger: z
    .strictObject({
      type: z.enum(["click", "submit", "change"]),
      tag: z.string().max(32),
      label: z.string().max(LIMITS.maxLabelLength).optional(),
      /** The page (normalised path) the click or submit happened on. */
      page: PagePath.optional(),
    })
    .optional(),
});

export const RouteEventSchema = z.strictObject({ ...Base, kind: z.literal("route"), path: PagePath });

export const InteractionEventSchema = z.strictObject({
  ...Base,
  kind: z.literal("interaction"),
  type: z.enum(["click", "submit", "change"]),
  tag: z.string().max(32),
  role: z.string().max(32).optional(),
  label: z.string().max(LIMITS.maxLabelLength).optional(),
  path: PagePath,
});

export const DecisionEventSchema = z.strictObject({
  ...Base,
  kind: z.literal("decision"),
  ruleId: z.string(),
  ruleVersion: z.number().int().positive(),
  status: z.enum(["violated", "passed", "needs_model"]),
  configuredAction: z.enum(["observe", "nudge", "fix", "block", "escalate"]),
  effectiveAction: z.enum(["observe", "nudge", "fix", "block", "escalate"]),
  actionId: z.string(),
  mode: z.enum(["shadow", "live"]),
});

const Label = z.string().max(LIMITS.maxLabelLength);
/** Page structure: labels, names and types only, never values. */
export const PageSnapshotSchema = z.strictObject({
  title: Label.optional(),
  headings: z.array(Label).max(10),
  forms: z
    .array(
      z.strictObject({
        name: Label.optional(),
        action: z.string().max(LIMITS.maxPathLength).optional(),
        method: z.string().max(16).optional(),
        fields: z.array(z.strictObject({ name: z.string().max(64), label: Label.optional(), type: z.string().max(32), required: z.boolean() })).max(40),
        submitLabels: z.array(Label).max(10),
      }),
    )
    .max(20),
  buttons: z.array(z.strictObject({ label: Label, form: z.number().int().nonnegative().optional(), hidden: z.literal(true).optional() })).max(40),
  frames: z.array(z.strictObject({ origin: z.string().max(200), title: Label.optional(), sameOrigin: z.boolean() })).max(10),
});
export type PageSnapshot = z.infer<typeof PageSnapshotSchema>;

export const PageEventSchema = z.strictObject({ ...Base, kind: z.literal("page"), path: PagePath, snapshot: PageSnapshotSchema });
export type PageEvent = z.infer<typeof PageEventSchema>;

/** What the user did with an on-screen prompt: the ground truth for accuracy and tuning. */
export const FeedbackEventSchema = z.strictObject({
  ...Base,
  kind: z.literal("feedback"),
  ruleId: z.string(),
  ruleVersion: z.number().int().positive(),
  value: z.enum(["dismissed", "helpful", "not_helpful", "fixed"]),
});

/** What the user did with a delivered guidance suggestion. */
export const GuidanceEventSchema = z.strictObject({
  ...Base,
  kind: z.literal("guidance"),
  suggestionId: z.string().max(64),
  goalId: z.string().max(128),
  value: z.enum(["shown", "did_it", "dismissed", "not_relevant", "element_missing"]),
});
export type GuidanceEvent = z.infer<typeof GuidanceEventSchema>;

/** Behaviour that signals someone is stuck: shape only (control label / field name, counts, durations). */
export const StruggleEventSchema = z.strictObject({
  ...Base,
  kind: z.literal("struggle"),
  type: z.enum(["hesitation", "rage_click", "dead_click", "field_churn", "form_abandon", "validation_loop", "u_turn", "crash", "error_page", "missed_tap", "no_results", "searching", "failed_drag", "failed_action"]),
  page: PagePath,
  target: z.string().max(LIMITS.maxLabelLength).optional(),
  count: z.number().int().nonnegative().max(10_000).optional(),
  durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
  /** Validation loops: was the rejected field left empty, or filled but not accepted? (Never what was typed.) */
  detail: z.enum(["empty", "rejected"]).optional(),
  /** Validation loops: the form's button as this user's page labels it. */
  control: z.string().max(LIMITS.maxLabelLength).optional(),
  /** Searching: which signs of looking around were seen. */
  signs: z.array(z.enum(["hovered", "scrolled", "menus", "find", "back_and_forth"])).max(5).optional(),
});
export type StruggleEvent = z.infer<typeof StruggleEventSchema>;

export const CapturedEventSchema = z.discriminatedUnion("kind", [NetworkEventSchema, RouteEventSchema, InteractionEventSchema, DecisionEventSchema, FeedbackEventSchema, PageEventSchema, GuidanceEventSchema, StruggleEventSchema]);

/** A suggestion the server asks the browser to show (returned with the ingest response). */
export const DeliverySchema = z.strictObject({
  suggestionId: z.string(),
  goalId: z.string(),
  message: z.string().max(500),
  why: z.string().max(500).optional(),
  level: z.enum(["tell", "show", "do"]),
  steps: z.array(
    z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("go"), page: z.string(), label: z.string() }),
      z.strictObject({ type: z.literal("press"), label: z.string(), page: z.string().optional(), actionId: z.string(), times: z.number().int() }),
      z.strictObject({ type: z.literal("fill"), page: z.string(), fields: z.array(z.string()) }),
    ]),
  ).max(12),
  doStep: z
    .discriminatedUnion("type", [
      z.strictObject({ type: z.literal("go"), page: z.string(), label: z.string() }),
      z.strictObject({ type: z.literal("press"), label: z.string(), page: z.string().optional(), actionId: z.string(), times: z.number().int() }),
    ])
    .optional(),
});
export type Delivery = z.infer<typeof DeliverySchema>;
export type NetworkEvent = z.infer<typeof NetworkEventSchema>;
export type RouteEvent = z.infer<typeof RouteEventSchema>;
export type InteractionEvent = z.infer<typeof InteractionEventSchema>;
export type DecisionEvent = z.infer<typeof DecisionEventSchema>;
export type FeedbackEvent = z.infer<typeof FeedbackEventSchema>;
export type CapturedEvent = z.infer<typeof CapturedEventSchema>;

export const EventBatchSchema = z.strictObject({
  v: z.literal(1),
  key: z.string().regex(/^pk_(test|live)_[A-Za-z0-9]{8,64}$/),
  sessionId: z.string().min(8).max(64),
  userId: z.string().max(128).optional(),
  /** HMAC-SHA256(identity secret, userId), hex, from the site's own server: proves the user id wasn't typed into a browser. */
  userHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** A returning browser, when the site turned rememberBrowser on and passes no userId: a random id only. */
  browserId: z.string().regex(/^[a-f0-9-]{16,40}$/).optional(),
  /** The user's plan or tier, as the site names it ("free", "pro"): a short code, never anything personal. */
  plan: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).optional(),
  /** The user's role, the same way ("admin", "member"). */
  role: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).optional(),
  /** What they're using, coarsely: never a model, browser or anything identifying. */
  device: z.enum(["phone", "tablet", "computer"]).optional(),
  /** The page's language (<html lang>), two letters: help is only worded in languages we can write. */
  lang: z.string().regex(/^[a-z]{2}$/).optional(),
  sentAt: z.number().int().nonnegative(),
  /** Events discarded because the in-page queue was full. */
  dropped: z.number().int().nonnegative().optional(),
  /** Internal snippet errors contained since the last batch (fail-open health signal). */
  errors: z.number().int().nonnegative().optional(),
  /** Sent as the page closes: nobody will read the reply, so any help is held for the user's next batch. */
  final: z.boolean().optional(),
  events: z.array(CapturedEventSchema).min(1).max(LIMITS.maxEventsPerBatch),
});
export type EventBatch = z.infer<typeof EventBatchSchema>;

// ---------- Decisions ----------

const PublishableKey = z.string().regex(/^pk_(test|live)_[A-Za-z0-9]{8,64}$/);
const RuleActionEnum = z.enum(["observe", "nudge", "fix", "block", "escalate"]);

/** Snippet → decision service, for rules that need server-side judgment. */
export const DecideRequestSchema = z.strictObject({
  v: z.literal(1),
  key: PublishableKey,
  sessionId: z.string().min(8).max(64),
  userId: z.string().max(128).optional(),
  /** See EventBatchSchema.userHash. */
  userHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  context: EvalContextSchema,
});
export type DecideRequest = z.infer<typeof DecideRequestSchema>;

export const DecisionOutcomeSchema = z.strictObject({
  ruleId: z.string(),
  ruleVersion: z.number().int().positive(),
  /** "unresolved": the model could not decide in time or with enough confidence. Never acted on. */
  status: z.enum(["violated", "passed", "unresolved"]),
  effectiveAction: RuleActionEnum,
  message: z.string(),
  reason: z.string().max(500).optional(),
});
export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;

export const DecideResponseSchema = z.strictObject({
  v: z.literal(1),
  mode: z.enum(["shadow", "live"]),
  outcomes: z.array(DecisionOutcomeSchema),
});
export type DecideResponse = z.infer<typeof DecideResponseSchema>;

/**
 * Where a page is, for sites spread over several addresses (www.acme.com for marketing,
 * app.acme.com for the product). Pages on the site's main address keep their plain path
 * ("/settings"); pages elsewhere are written with their address ("//app.acme.com/settings"),
 * which browsers also read as a link to that page. A path already written with an address
 * is moved onto the plain form if that address is the main one.
 */
export function placePath(path: string, pageHost: string, mainHost: string): string {
  const [host, rest] = path.startsWith("//") ? [path.slice(2).split("/")[0] ?? "", `/${path.slice(2).split("/").slice(1).join("/")}`] : [pageHost, path];
  return (host === mainHost ? rest : `//${host}${rest}`).slice(0, LIMITS.maxPathLength);
}

/**
 * Server-side backstop for the snippet's address masking (older snippets, or anything not from
 * our snippet): the segment after a person or organisation word becomes ":id", as do @handles
 * and letters-only tokens. Kept in step with packages/snippet/src/url.ts.
 */
const OWNER = /^(users?|u|people|persons?|members?|profiles?|orgs?|organi[sz]ations?|teams?|workspaces?|compan(y|ies)|customers?|clients?|accounts?|tenants?)$/i;
const OWN_PAGE = /^(new|edit|create|settings|billing|members|invite|invites|invitations|profile|security|preferences|notifications|list|all|me|import|export|integrations|plans?|usage|api|keys|roles|permissions|overview|admin|search|archived?|:id)$/i;
const PERSONAL = [/@/, /\s/, /^(?=.*[a-z])(?=.*[A-Z])[A-Za-z_-]{16,}$/];
export function maskPersonalPath(path: string): string {
  const [host, rest] = path.startsWith("//") ? [`//${path.slice(2).split("/")[0] ?? ""}`, `/${path.slice(2).split("/").slice(1).join("/")}`] : ["", path];
  const out: string[] = [];
  // A view inside the page ("~invite-teammates") is named by the site, and held back separately until confirmed.
  for (const segment of rest.split("/").filter(Boolean)) out.push(!segment.startsWith("~") && ((OWNER.test(out[out.length - 1] ?? "") && !OWN_PAGE.test(segment)) || PERSONAL.some((p) => p.test(segment))) ? ":id" : segment);
  return `${host}/${out.join("/")}`;
}

/** The same, for every page an event mentions. API request paths are left alone. */
export function placeEvent(event: CapturedEvent, pageHost: string, mainHost: string): CapturedEvent {
  const at = (p: string) => placePath(p, pageHost, mainHost);
  switch (event.kind) {
    case "route":
    case "page":
    case "interaction":
      return { ...event, path: at(event.path) };
    case "struggle":
      return { ...event, page: at(event.page) };
    case "network":
      return event.trigger?.page ? { ...event, trigger: { ...event.trigger, page: at(event.trigger.page) } } : event;
    default:
      return event;
  }
}
