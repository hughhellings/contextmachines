import type { LearnedAction, LearnedField, SiteModelSnapshot } from "../learn/learner.ts";
import { NOT_PRODUCT } from "../guidance/lifecycle.ts";
import { isRead } from "../learn/naming.ts";

/**
 * The product's actions as contracts: what each request is called, what it does, what it takes
 * and what it gives back. Learned from traffic, named and described by a model, confirmed by
 * the company. This is what the report, the Context API and in-app help all speak in.
 */
export interface ActionPurpose {
  id: string;
  /** A short name in the product's own words ("Send an invoice"). */
  name: string;
  /** One sentence: what it does for the person. */
  does: string;
}

export interface ContractField {
  name: string;
  types: LearnedField["types"];
  /** Sent (or given back) on nearly every call. */
  always: boolean;
  sensitive: boolean;
}

export interface ActionContract {
  id: string;
  name: string;
  /** Where the name came from, most trusted first. */
  nameFrom: "company" | "model" | "screen" | "address";
  does?: string;
  doesFrom?: "company" | "model";
  review: LearnedAction["review"];
  kind: "save" | "read";
  request: { method: string; path: string; graphqlOperation?: string };
  /** The button or form people use to do it, as it reads on screen. */
  onScreen?: string;
  /** Pages it is done from, most used first. */
  pages: string[];
  inputs: ContractField[];
  result: ContractField[];
  seen: number;
  /** Share of calls that worked, when any reply was seen. */
  succeeded: number | null;
  errorCodes: string[];
  /** Sign-in, tracking or session upkeep: kept, but not part of the product's own actions. */
  plumbing?: true;
}

const ALWAYS = 0.95;

/** The best name for an action: the company's, then the model's, then the screen's, then the address's. */
export function actionName(action: LearnedAction, drafted?: ActionPurpose): { name: string; from: ActionContract["nameFrom"] } {
  if (action.review === "confirmed") return { name: action.label, from: "company" };
  if (drafted) return { name: drafted.name, from: "model" };
  if (action.uiLabel) return { name: action.uiLabel, from: "screen" };
  return { name: action.label, from: "address" };
}

/** Names by action id, for anything that shows actions to people. */
export function actionNames(site: SiteModelSnapshot, purposes: readonly ActionPurpose[] = []): Map<string, string> {
  const drafted = new Map(purposes.map((p) => [p.id, p]));
  return new Map(site.actions.map((a) => [a.id, actionName(a, drafted.get(a.id)).name]));
}

export function actionContracts(site: SiteModelSnapshot, purposes: readonly ActionPurpose[] = []): ActionContract[] {
  const drafted = new Map(purposes.map((p) => [p.id, p]));
  return [...site.actions]
    .sort((a, b) => b.seen - a.seen)
    .map((a) => {
      const draft = drafted.get(a.id);
      const { name, from } = actionName(a, draft);
      const replies = Object.entries(a.statuses).reduce((n, [, v]) => n + v, 0);
      const worked = a.statuses["2xx"] ?? 0;
      const does = a.does ? { does: a.does, doesFrom: "company" as const } : draft ? { does: draft.does, doesFrom: "model" as const } : {};
      return {
        id: a.id,
        name,
        nameFrom: from,
        ...does,
        review: a.review,
        kind: isRead(a) ? "read" : "save",
        request: { method: a.method, path: a.path, ...(a.graphqlOperation ? { graphqlOperation: a.graphqlOperation } : {}) },
        ...(a.uiLabel ? { onScreen: a.uiLabel } : {}),
        pages: Object.entries(a.triggerPages).sort((x, y) => y[1] - x[1]).map(([p]) => p),
        inputs: fieldsOf(a.fields, a.seen),
        result: fieldsOf(a.result ?? {}, worked || a.seen),
        seen: a.seen,
        succeeded: replies ? Math.round((worked / replies) * 1000) / 1000 : null,
        errorCodes: Object.entries(a.errorCodes ?? {}).sort((x, y) => y[1] - x[1]).map(([c]) => c),
        ...(NOT_PRODUCT.test(`${a.id} ${a.path}`) ? { plumbing: true as const } : {}),
      } satisfies ActionContract;
    });
}

function fieldsOf(fields: Record<string, LearnedField>, calls: number): ContractField[] {
  return Object.entries(fields)
    .sort((a, b) => b[1].seen - a[1].seen)
    .map(([name, f]) => ({ name, types: f.types, always: calls > 0 && f.seen >= calls * ALWAYS, sensitive: f.sensitive }));
}
