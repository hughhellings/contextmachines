/**
 * Schedules for the app, on apps/cloud's cron (read-only reuse of cron.ts), with presets and a time
 * zone. They fire only while `contextmachines ui` is open: start() and stop() follow the server.
 *
 * One browser at a time (C18): a schedule hands its job to the app's own runner. If that runner is
 * busy, the fire is recorded as skipped_busy and nothing starts: never a second browser.
 * Replay only (section 4): `ai` is always "none". The runner still goes through every gate (C25).
 * Missed minutes are skipped, not caught up (as the cloud's scheduler).
 */
import { CronError, matches, minuteKey, parseCron } from "./cron.ts";
import type { AppSchedule, EnvId, GroupId, ProjectId, RunId, SchedulePreset, TestId } from "../contracts.ts";
import type { AppStore } from "./projects.ts";
import { bad, isObj, newId, notFound, nowIso } from "./util.ts";

export const PRESETS: Record<Exclude<SchedulePreset, "cron">, string> = {
  hourly: "0 * * * *",
  daily: "0 9 * * *",
  weekdays: "0 9 * * 1-5",
};

/** What a schedule asks the app's runner to do. */
export interface ScheduledJob {
  scheduleId: string;
  projectId: ProjectId;
  envId?: EnvId;
  target: { group: GroupId } | { test: TestId } | { all: true };
  ai: "none";
  source: "scheduled";
}

/** The app's one runner (ui-server's job queue), as the scheduler sees it. */
export interface Runner {
  busy(): boolean;
  start(job: ScheduledJob): Promise<RunId | undefined> | RunId | undefined;
}

export type ScheduleEvent = { type: "schedule"; scheduleId: string; state: "fired" | "skipped_busy"; runId?: RunId };

/** The wall clock in a time zone, as a local Date (so cron.ts's local-time matching reads it). */
export function zoned(at: Date, timeZone: string): Date {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(at).map((p) => [p.type, p.value]));
  return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute));
}

export function checkZone(tz: unknown): string {
  if (typeof tz !== "string" || !tz) throw bad("Pick a time zone, like Europe/London.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw bad(`"${tz.slice(0, 60)}" isn't a time zone.`);
  }
  return tz;
}

export class AppScheduler {
  private readonly store: AppStore;
  private readonly runner: Runner;
  private readonly emit: (e: ScheduleEvent) => void;
  private timer: NodeJS.Timeout | undefined;

  constructor(store: AppStore, runner: Runner, emit: (e: ScheduleEvent) => void = () => {}) {
    this.store = store;
    this.runner = runner;
    this.emit = emit;
  }

  list(projectId: ProjectId): AppSchedule[] {
    this.store.project(projectId);
    return this.store.data.schedules.filter((s) => s.projectId === projectId);
  }

  save(projectId: ProjectId, input: unknown, now = new Date()): AppSchedule {
    const p = this.store.project(projectId);
    if (!isObj(input)) throw bad("Send the schedule.");
    const preset = input.preset as SchedulePreset;
    if (!["hourly", "daily", "weekdays", "cron"].includes(preset)) throw bad("A schedule is hourly, daily, weekdays or a cron line.");
    const cron = preset === "cron" ? (typeof input.cron === "string" ? input.cron.trim() : "") : PRESETS[preset];
    try {
      parseCron(cron);
    } catch (error) {
      throw bad(error instanceof CronError ? error.message : "That cron line isn't one.");
    }
    const timeZone = checkZone(input.timeZone);
    const t = input.target;
    let target: AppSchedule["target"];
    if (isObj(t) && t.all === true) target = { all: true };
    else if (isObj(t) && typeof t.group === "string" && this.store.data.groups.some((g) => g.id === t.group && g.projectId === projectId)) target = { group: t.group };
    else if (isObj(t) && typeof t.test === "string" && /^tst_[0-9a-f]{12}$/.test(t.test)) target = { test: t.test };
    else throw bad("A schedule runs a group of this project, one test, or all saved tests.");
    const envId = input.envId === undefined || input.envId === null || input.envId === "" ? undefined : this.store.envFor(projectId, input.envId).id;
    const fields = { preset, cron, timeZone, target, ...(envId ? { envId } : {}), ai: "none" as const, enabled: input.enabled !== false };
    if (typeof input.id === "string") {
      const s = this.store.data.schedules.find((x) => x.id === input.id && x.projectId === p.id);
      if (!s) throw notFound("schedule");
      if (!envId) delete s.envId;
      Object.assign(s, fields);
      this.store.save();
      return s;
    }
    const s: AppSchedule = { id: newId("sch"), projectId: p.id, ...fields, createdAt: nowIso(now) };
    this.store.data.schedules.push(s);
    this.store.save();
    return s;
  }

  delete(id: string): void {
    if (!this.store.data.schedules.some((s) => s.id === id)) throw notFound("schedule");
    this.store.data.schedules = this.store.data.schedules.filter((s) => s.id !== id);
    this.store.save();
  }

  /** While the app is open only: every 20 s. */
  start(everyMs = 20_000): void {
    this.stop();
    // A tick never rejects (tick catches the runner), but guard the timer too: an unhandled rejection would end the server.
    this.timer = setInterval(() => void this.tick(new Date()).catch(() => undefined), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Looks at one moment: each due schedule fires once that minute, or is skipped when the runner is busy. */
  async tick(at: Date): Promise<ScheduleEvent[]> {
    const events: ScheduleEvent[] = [];
    let changed = false;
    for (const s of this.store.data.schedules) {
      if (!s.enabled || !this.store.data.projects.some((p) => p.id === s.projectId)) continue;
      let wall: Date;
      let due = false;
      try {
        wall = zoned(at, s.timeZone);
        due = matches(parseCron(s.cron), wall);
      } catch {
        continue;
      }
      if (!due) continue;
      const key = `${s.timeZone} ${minuteKey(wall)}`;
      const was = s as AppSchedule & { lastKey?: string };
      if (was.lastKey === key) continue;
      was.lastKey = key;
      changed = true;
      if (this.runner.busy()) {
        s.lastSkippedBusy = nowIso(at);
        const e: ScheduleEvent = { type: "schedule", scheduleId: s.id, state: "skipped_busy" };
        events.push(e);
        this.emit(e);
        continue;
      }
      s.lastFired = nowIso(at);
      let runId: RunId | undefined;
      try {
        runId = await this.runner.start({ scheduleId: s.id, projectId: s.projectId, ...(s.envId ? { envId: s.envId } : {}), target: s.target, ai: "none", source: "scheduled" });
      } catch (error) {
        // The runner refused (a stale environment, a test that is gone): recorded, never a crash, and the other schedules still get their turn.
        (s as AppSchedule & { lastError?: string }).lastError = error instanceof Error ? error.message.slice(0, 200) : "The run couldn't start.";
        continue;
      }
      delete (s as AppSchedule & { lastError?: string }).lastError;
      const e: ScheduleEvent = { type: "schedule", scheduleId: s.id, state: "fired", ...(runId ? { runId } : {}) };
      events.push(e);
      this.emit(e);
    }
    if (changed) this.store.save();
    return events;
  }
}
