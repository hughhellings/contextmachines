import { isHeld } from "./label-gate.ts";

/**
 * Deterministic naming for learned actions: no model involved.
 *   POST   /api/assessments/:id/publish  → assessment.publish   "Publish assessment"
 *   POST   /api/courses/:id/assessments  → course.assessment.create "Create assessment"
 *   PATCH  /api/assessments/:id          → assessment.update    "Update assessment"
 *   GraphQL PublishAssessment            → gql.publishAssessment "Publish assessment"
 */

const NOISE_SEGMENTS = new Set(["api", "rest", "graphql", "internal", "public"]);
const VERSION = /^v\d+(\.\d+)?$/i;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH"]);
const KNOWN_VERBS = new Set([
  "publish", "unpublish", "submit", "archive", "unarchive", "approve", "reject", "duplicate", "copy", "send", "cancel",
  "close", "open", "reopen", "restore", "lock", "unlock", "grade", "assign", "unassign", "invite", "enroll", "export",
  "import", "sync", "start", "stop", "complete", "reset", "verify", "activate", "deactivate", "preview", "release",
  "process", "access", "move", "share", "schedule", "confirm", "refund", "upload", "download", "login", "logout",
  "connect", "disconnect", "link", "unlink", "generate", "calculate", "analyze", "analyse", "run", "retry", "resend", "accept", "decline",
]);

/** Verbs an action id can end in, as a closed list (anything else is "other"). Shared by cross-site insights. */
export const ACTION_VERBS: readonly string[] = [...KNOWN_VERBS, "create", "update", "delete", "list", "view", "save"].sort();

/** The verb of a learned action id ("invoice.send" → "send"; "gql.createInvoice" → "create"), or "other". */
export function actionVerb(actionId: string): string {
  const raw = actionId.startsWith("gql.") ? (actionId.slice(4).match(/^[a-z]+/)?.[0] ?? "") : (actionId.split(".").at(-1) ?? "");
  const verb = raw.toLowerCase();
  return ACTION_VERBS.includes(verb) ? verb : "other";
}

/** A trailing segment after an id is a verb if it is a known verb or does not look like a plural resource. */
function isVerbSegment(segment: string): boolean {
  const word = segment.toLowerCase();
  return KNOWN_VERBS.has(word) || !/s$/.test(word);
}

/**
 * HTTP's safe methods: they only read. QUERY is the newer one, a GET that carries its question in a
 * body (a search or a filter too long for an address), and is read like GET everywhere.
 */
export const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS", "QUERY"]);

/**
 * Whether a request only reads, whatever its method. Many back ends read with POST: Supabase and
 * PostgREST functions (/rest/v1/rpc/my_analysis), search and report endpoints (/api/search,
 * /reports/query). What set it off decides first: a POST that followed a form or a button is what
 * that press asked for, so it is a save unless the press says it looks something up ("Search",
 * "Filter", "Find"), whatever its address says: /check-in, /my-profile, /quote and /get-started
 * behind their buttons are all saves. Only a request nothing labelled set off is judged by the name
 * of the thing called, so a POST named like a question ("get…", "list…", "search…") is a read, and
 * one named like an instruction is a save. A link isn't such a press: it leads somewhere, and the
 * page it opens loads what it shows (and a word still held back can't be read, so says nothing).
 */
const READ_NAME = /^(get|list|fetch|find|search|query|lookup|count|read|load|preview|calc|calculate|compute|resolve|estimate)([_-]|$)/i;
/** Read words that start an instruction: "get started", and "list an item" (a list of them is plural). */
const INSTRUCTION = /^(get[-_]started|list[-_](?!all$)[a-z]+(?<!s))$/i;
/** A database function of the signed-in person's own (PostgREST): "my_…" reads, unlike a page called /my-profile. */
const OWN_FUNCTION = /\/rpc\/my_[a-z]/i;
const LOOKS_UP = /\b(search|filter|find|look ?up)/i;
/** Words a press can have when the address also says it only reads: paging and refreshing a list. */
const ONLY_SHOWS = /\b(load|show|view|refresh|preview|calculate|next|previous|more)\b/i;

export type Press = { type?: "click" | "submit" | "change"; label: string; link?: boolean };

export function isReadRequest(method: string, path: string, triggers?: readonly Press[]): boolean {
  if (SAFE_METHODS.has(method)) return true;
  if (method !== "POST") return false;
  const last = path.split("/").filter((s) => s && s !== ":id").at(-1) ?? "";
  const named = (READ_NAME.test(last) && !INSTRUCTION.test(last)) || OWN_FUNCTION.test(path);
  const presses = (triggers ?? []).filter((t) => t.type !== "change" && !t.link && t.label.trim() && !isHeld(t.label));
  if (presses.length === 0) return named;
  return presses.every((t) => LOOKS_UP.test(t.label) || (named && ONLY_SHOWS.test(t.label)));
}

/** The same, for an action already learned. */
export const isRead = (a: { method: string; path: string; triggers?: readonly Press[]; save?: boolean }): boolean => !a.save && isReadRequest(a.method, a.path, a.triggers);

/**
 * Looking after the system itself, not using the product: a control that sets up, empties or
 * restarts it ("Initialize", "Clean", "Shutdown", "Rebuild index"), or anything on an administration
 * screen beside the product. A demo bank's reset button is the most striking save on its site, and
 * nobody comes to press it. Never what the product is for. An app that lives entirely under
 * /admin (a shop's back office) is its own product, so an address counts only when most of the
 * site isn't there (see mainCandidates).
 */
const UPKEEP_LABEL = /^(re-?)?(init(iali[sz]e)?|clean|clean ?up|purge|wipe|flush|shut ?down|start ?up|restart|reboot|rebuild|reindex|migrate|seed|truncate)\b/i;
const ADMIN_ADDRESS = /(^|[/._-])(admin|administration|administrator|sysadmin|superadmin|maintenance|backoffice)([/._?-]|$)/i;

type Saved = { path: string; uiLabel?: string | undefined; triggerPages?: Record<string, number> };
export const isUpkeep = (a: Saved): boolean => UPKEEP_LABEL.test(a.uiLabel ?? "");
const onAdminScreen = (a: Saved) => ADMIN_ADDRESS.test(a.path) || Object.keys(a.triggerPages ?? {}).some((p) => ADMIN_ADDRESS.test(p));

/** The saves that could be what people come to do, from all a site's saves: see isUpkeep. */
export function mainCandidates<T extends Saved>(saves: readonly T[], pages: readonly { path: string }[]): T[] {
  const kept = saves.filter((a) => !isUpkeep(a));
  const adminIsAPart = pages.filter((p) => ADMIN_ADDRESS.test(p.path)).length * 2 < pages.length;
  return adminIsAPart ? kept.filter((a) => !onAdminScreen(a)) : kept;
}

export interface ActionName {
  id: string;
  label: string;
}

export function nameRestAction(method: string, path: string, triggers?: readonly Press[]): ActionName {
  // tRPC: the procedure is the name (/api/trpc/invoice.sendReminder → invoice.send_reminder "Send reminder invoice").
  const trpc = /\/trpc\/([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)$/.exec(path);
  if (trpc) {
    const parts = trpc[1]!.split(".");
    const verb = slug(parts[parts.length - 1]!);
    const resources = parts.slice(0, -1).map((p) => singular(slug(p)));
    const resource = resources[resources.length - 1] ?? "item";
    return { id: [...resources, verb].join("."), label: `${capitalise(words(verb))} ${words(resource)}` };
  }
  const segments = path.split("/").filter(Boolean);
  const meaningful = segments.filter((s) => !NOISE_SEGMENTS.has(s.toLowerCase()) && !VERSION.test(s));
  if (meaningful.length === 0) return { id: `root.${verbFor(method, false, false)}`, label: `${capitalise(verbFor(method, false, false))} root` };

  const last = meaningful[meaningful.length - 1] ?? "";
  const beforeLast = meaningful[meaningful.length - 2];
  // A trailing verb on a write is the action: /assessments/:id/publish, and /payments/connect (known verbs only when no id precedes it).
  const explicitVerb =
    WRITE_METHODS.has(method) &&
    last !== ":id" &&
    meaningful.length >= 2 &&
    (beforeLast === ":id" ? meaningful.length >= 3 && isVerbSegment(last) : KNOWN_VERBS.has(last.toLowerCase()));

  const resources = (explicitVerb ? meaningful.slice(0, -1) : meaningful).filter((s) => s !== ":id").map((s) => singular(slug(s)));
  const targetsOne = (explicitVerb ? beforeLast : last) === ":id";
  const verb = explicitVerb ? slug(last) : method === "POST" && isReadRequest(method, path, triggers) ? "view" : verbFor(method, targetsOne, true);
  const resource = resources[resources.length - 1] ?? "item";

  return { id: [...resources, verb].join("."), label: `${capitalise(words(verb))} ${words(resource)}` };
}

/**
 * An action told apart by more than its address: a GraphQL operation, a Next.js server action
 * ("next:<id>": the button people press names it), or a form's intent ("intent:delete").
 */
export function nameOperation(method: string, path: string, operation: string): ActionName {
  // Live connections ("ws:publish", "ws:set tasks") and Firestore ("firestore:update tasks").
  if (operation.startsWith("ws:") || operation.startsWith("firestore:")) {
    const name = operation.slice(operation.indexOf(":") + 1);
    const data = /^(set|update|delete) ([A-Za-z][A-Za-z0-9_-]*)$/.exec(name);
    if (data) {
      const resource = singular(slug(data[2]!));
      const verb = data[1] === "set" ? "save" : data[1]!;
      return { id: `${resource}.${verb}`, label: `${capitalise(verb)} ${words(resource)}` };
    }
    const verb = slug(name);
    return { id: `live.${verb}`, label: capitalise(words(verb)) };
  }
  if (!operation.startsWith("next:") && !operation.startsWith("intent:")) return nameGraphqlAction(operation);
  const resources = nameRestAction(method, path).id.split(".").slice(0, -1);
  const resource = resources[resources.length - 1] ?? "page";
  if (operation.startsWith("next:")) return { id: [...resources, `server_action_${operation.slice(5, 11)}`].join("."), label: `Server action on ${words(resource)}` };
  const verb = slug(operation.slice(7));
  return { id: [...resources, verb].join("."), label: `${capitalise(words(verb))} ${words(resource)}` };
}

export function nameGraphqlAction(operation: string): ActionName {
  const phrase = operation.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().trim();
  const [verb = operation, ...rest] = phrase.split(" ");
  const id = `gql.${operation.charAt(0).toLowerCase()}${operation.slice(1)}`;
  return { id, label: `${capitalise(verb)}${rest.length ? ` ${rest.join(" ")}` : ""}` };
}

function verbFor(method: string, targetsOne: boolean, hasResource: boolean): string {
  switch (method) {
    case "GET":
    case "QUERY":
      return targetsOne || !hasResource ? "view" : "list";
    case "POST":
      // POST /contacts creates one; POST /contacts/42 changes that one.
      return targetsOne ? "update" : "create";
    case "PUT":
    case "PATCH":
      return "update";
    case "DELETE":
      return "delete";
    default:
      return method.toLowerCase();
  }
}

export function singular(word: string): string {
  if (/ies$/.test(word) && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/izzes$/.test(word)) return word.slice(0, -3); // quizzes → quiz
  if (/(sses|uses|xes|ches|shes|zzes)$/.test(word)) return word.slice(0, -2); // buzzes → buzz
  if (/(ss|us|is)$/.test(word)) return word;
  if (/s$/.test(word) && word.length > 3) return word.slice(0, -1);
  return word;
}

function slug(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").toLowerCase() || "item";
}

function words(s: string): string {
  return s.replace(/_/g, " ");
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
