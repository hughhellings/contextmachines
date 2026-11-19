// Copied from apps/cloud/src/cron.ts (unchanged below this line) so the app does not need apps/cloud at run time: the cloud is folded into `contextmachines ui`.
/**
 * A five-field cron, read in this process's local time: minute hour day-of-month month day-of-week.
 * Each field takes `*`, a number, a range `a-b`, a step `*\/n` or `a-b/n`, and lists of those `1,15,30`.
 * Day of week is 0-6 from Sunday (7 is Sunday too). As in classic (Vixie) cron, when both day fields are
 * restricted a day matches if either does; a day field that starts with `*` (`*` or `*\/2`) counts as
 * unrestricted, and then both must match.
 *
 * No dependency: the scheduler only needs "does this minute match", and the page "when next".
 */

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
  text: string;
}

const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const NAMES = ["minute", "hour", "day of month", "month", "day of week"];

export class CronError extends Error {
  override name = "CronError";
}

function field(text: string, i: number): Set<number> {
  const [lo, hi] = RANGES[i]!;
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new CronError(`"${part}" isn't a ${NAMES[i]}`);
    const step = m[4] ? Number(m[4]) : 1;
    let a = lo;
    let b = hi;
    if (m[1] !== "*") {
      a = Number(m[2]);
      b = m[3] !== undefined ? Number(m[3]) : m[4] ? hi : a;
    }
    if (a < lo || b > hi || a > b || step < 1) throw new CronError(`"${part}" is out of range for ${NAMES[i]} (${lo}-${hi})`);
    for (let v = a; v <= b; v += step) out.add(i === 4 && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(text: string): Cron {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError(`A schedule has 5 fields (minute hour day month weekday), like "0 9 * * 1-5"; "${text}" has ${parts.length}`);
  const [mi, h, d, mo, w] = parts.map((p, i) => field(p, i)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  return { minute: mi, hour: h, dom: d, month: mo, dow: w, domAny: parts[2]!.startsWith("*"), dowAny: parts[4]!.startsWith("*"), text: parts.join(" ") };
}

export function matches(c: Cron, at: Date): boolean {
  if (!c.minute.has(at.getMinutes()) || !c.hour.has(at.getHours()) || !c.month.has(at.getMonth() + 1)) return false;
  const dom = c.dom.has(at.getDate());
  const dow = c.dow.has(at.getDay());
  return c.domAny || c.dowAny ? dom && dow : dom || dow;
}

/** The first whole minute after `from` that matches, looking at most a year ahead. */
export function nextAfter(c: Cron, from: Date): Date | undefined {
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matches(c, t)) return t;
    t.setMinutes(t.getMinutes() + 1);
  }
  return undefined;
}

/** A minute's key in local time ("2026-11-17T09:00"), so one minute fires once. */
export function minuteKey(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T${p(at.getHours())}:${p(at.getMinutes())}`;
}
