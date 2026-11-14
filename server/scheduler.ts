import { Cron } from "croner";
import { db } from "./db.ts";
import { startSuiteRun, suiteCaseIds, SuiteError } from "./runsuites.ts";

/**
 * Suites on a schedule.
 *
 * A suite can have a schedule: a 5-field cron expression and a time zone of its own (never the server's). When it is due, the scheduler makes the same MANUAL run that
 * the Run button makes (startSuiteRun) from the cases the suite holds then, marked meta.scheduled. Nothing is run automatically: the run is a list of untested cases for a
 * person to go through. A person decided on the schedule, it is labelled as scheduled, and the scheduler never decides, approves or changes anything else. Starting
 * automated tests from a schedule comes later, with the trigger from the UI.
 *
 * Rules:
 *  - a schedule that runs more often than every 15 minutes is refused, and so is more than 50 scheduled suites in a project;
 *  - a due time that is more than 2 hours late (the computer was off or asleep) is not run, it is recorded as missed. Within 2 hours it is run once. Several missed
 *    times in a row are one: the next time is worked out from now;
 *  - if the previous scheduled run of the suite is still in progress, this one is skipped. A run somebody started by hand does not count;
 *  - every time that falls due is written once to suite_schedule_fires, with what came of it. UNIQUE (template_id, scheduled_for) keeps two ticks, or two processes,
 *    from starting the same run twice.
 */

export const MIN_INTERVAL_MINUTES = 15;
export const CATCH_UP_MINUTES = 120;
export const MAX_SCHEDULES_PER_PROJECT = 50;

export type FireOutcome = "started" | "skipped_overlap" | "skipped_empty" | "missed" | "error";
export interface FireResult { templateId: number; scheduledFor: string; outcome: FireOutcome; runId: number | null; note: string }

const bad = (message: string) => new SuiteError(400, message);

/** Times are kept like everywhere else in the database: UTC as "YYYY-MM-DD HH:MM:SS". */
export const toDbTime = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
export const fromDbTime = (s: string) => new Date(`${s.replace(" ", "T")}Z`);

const NAMES = /JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|SUN|MON|TUE|WED|THU|FRI|SAT/gi;
const FIELD_NAMES = ["minute", "hour", "day of month", "month", "day of week"];

const zones = new Set<string>(Intl.supportedValuesOf("timeZone"));
/** An IANA name such as Europe/Stockholm, or UTC. (The cron library accepts any text as a time zone without complaint, so this is checked here.) */
export const isTimezone = (tz: string) => tz === "UTC" || zones.has(tz);

const cronOf = (expression: string, timezone: string) => new Cron(expression, { timezone, paused: true });

/**
 * The expression in one normal form, or a SuiteError (400) saying what is wrong. Only the five usual fields are allowed: no seconds, no year, no @daily or @reboot,
 * and none of the extra syntax (L, W, #, ?) that the library has. Numbers, ranges, lists, steps and the names of months and days are.
 */
export function validateSchedule(expression: string, timezone: string, now: Date = new Date()): string {
  const expr = expression.trim().replace(/\s+/g, " ");
  if (!expr) throw bad("The schedule is empty");
  if (!isTimezone(timezone)) throw bad(`Unknown time zone "${timezone}". Use a name such as Europe/Stockholm or UTC`);
  const fields = expr.split(" ");
  if (fields.length !== 5) throw bad(`A schedule has 5 fields (minute hour day-of-month month day-of-week), not ${fields.length}`);
  fields.forEach((f, i) => {
    if (!/^[0-9A-Za-z*/,-]+$/.test(f)) throw bad(`The ${FIELD_NAMES[i]} field has characters that are not allowed`);
    if (/[A-Za-z]/.test(f.replace(NAMES, ""))) throw bad(`The ${FIELD_NAMES[i]} field may only hold numbers and the names of months or days (JAN, MON)`);
  });
  let cron: Cron;
  try {
    cron = cronOf(expr, timezone);
  } catch (e) {
    throw bad((e as Error).message.replace(/^CronPattern: /, ""));
  }
  const runs = cron.nextRuns(24, now);
  cron.stop();
  if (runs.length === 0) throw bad("This schedule never runs");
  for (let i = 1; i < runs.length; i++) {
    const gap = Math.round((runs[i].getTime() - runs[i - 1].getTime()) / 60_000);
    if (gap < MIN_INTERVAL_MINUTES) throw bad(`This schedule runs more often than every ${MIN_INTERVAL_MINUTES} minutes (two runs are ${gap} ${gap === 1 ? "minute" : "minutes"} apart)`);
  }
  return expr;
}

/** The next time after `after` (the following one, never `after` itself), or null when there is none. */
export function nextRunAfter(expression: string, timezone: string, after: Date): Date | null {
  const cron = cronOf(expression, timezone);
  const next = cron.nextRun(after);
  cron.stop();
  return next;
}

/** The next `count` times, for showing a person what a schedule means before it is saved. Never saves anything. */
export function previewSchedule(expression: string, timezone: string, now: Date = new Date(), count = 5): { ok: true; next: string[]; schedulerEnabled: boolean } | { ok: false; error: string; schedulerEnabled: boolean } {
  try {
    const expr = validateSchedule(expression, timezone, now);
    const cron = cronOf(expr, timezone);
    const next = cron.nextRuns(count, now).map(toDbTime);
    cron.stop();
    return { ok: true, next, schedulerEnabled: schedulerEnabled() };
  } catch (e) {
    return { ok: false, error: (e as Error).message, schedulerEnabled: schedulerEnabled() };
  }
}

interface TemplateSchedule { id: number; project_id: number; name: string; schedule: string | null; schedule_tz: string; next_run_at: string | null }

/**
 * Sets, changes or clears the schedule of a suite. `schedule: null` (or empty) clears it; leaving a field out leaves it as it is. Nothing is changed when something is wrong.
 * Saving the same schedule again changes nothing, so the next time is not pushed back.
 */
export function setSchedule(templateId: number, input: { schedule?: string | null; timezone?: string }, by: string, now: Date = new Date()) {
  const t = db.prepare("SELECT id, project_id, name, schedule, schedule_tz, next_run_at FROM run_templates WHERE id = ?").get(templateId) as TemplateSchedule | undefined;
  if (!t) throw new SuiteError(404, "Suite not found");
  const timezone = input.timezone ?? t.schedule_tz;
  if (input.timezone !== undefined && !isTimezone(timezone)) throw bad(`Unknown time zone "${timezone}". Use a name such as Europe/Stockholm or UTC`);
  const wanted = input.schedule === undefined ? t.schedule : input.schedule;
  if (wanted === null || wanted.trim() === "") {
    if (input.schedule !== undefined || input.timezone !== undefined) {
      db.prepare("UPDATE run_templates SET schedule = NULL, next_run_at = NULL, schedule_set_by = NULL, schedule_set_at = NULL, schedule_tz = ?, updated_at = datetime('now') WHERE id = ?").run(timezone, templateId);
    }
    return;
  }
  const expression = validateSchedule(wanted, timezone, now);
  if (expression === t.schedule && timezone === t.schedule_tz && t.next_run_at) return;
  if (t.schedule === null) {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM run_templates WHERE project_id = ? AND schedule IS NOT NULL").get(t.project_id) as { n: number }).n;
    if (n >= MAX_SCHEDULES_PER_PROJECT) throw bad(`A project can have at most ${MAX_SCHEDULES_PER_PROJECT} scheduled suites`);
  }
  const next = nextRunAfter(expression, timezone, now);
  db.prepare("UPDATE run_templates SET schedule = ?, schedule_tz = ?, next_run_at = ?, schedule_set_by = ?, schedule_set_at = ?, updated_at = datetime('now') WHERE id = ?")
    .run(expression, timezone, next ? toDbTime(next) : null, by, toDbTime(now), templateId);
}

/** The schedule of a suite as the screens need it: when it runs next, and what became of the latest times it fell due. */
export function scheduleDetails(templateId: number, now: Date = new Date()) {
  const t = db.prepare("SELECT schedule, schedule_tz FROM run_templates WHERE id = ?").get(templateId) as { schedule: string | null; schedule_tz: string } | undefined;
  let nextRuns: string[] = [];
  if (t?.schedule) {
    try {
      const cron = cronOf(t.schedule, t.schedule_tz);
      nextRuns = cron.nextRuns(3, now).map(toDbTime);
      cron.stop();
    } catch { /* a stored schedule the library no longer accepts: nothing to show */ }
  }
  const fires = db
    .prepare("SELECT scheduled_for, outcome, run_id, note, fired_at FROM suite_schedule_fires WHERE template_id = ? ORDER BY scheduled_for DESC, id DESC LIMIT 10")
    .all(templateId) as { scheduled_for: string; outcome: FireOutcome; run_id: number | null; note: string; fired_at: string }[];
  return { next_runs: nextRuns, fires, scheduler_enabled: schedulerEnabled() };
}

const localDate = (d: Date, timezone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

type StartRun = typeof startSuiteRun;

function fire(t: TemplateSchedule, now: Date, start: StartRun): FireResult {
  const scheduledFor = t.next_run_at!;
  const due = fromDbTime(scheduledFor);
  const late = Math.round((now.getTime() - due.getTime()) / 60_000);
  let next: string | null = null;
  try {
    const n = nextRunAfter(t.schedule!, t.schedule_tz, now);
    next = n ? toDbTime(n) : null;
  } catch { /* leave it empty: it is worked out again when the schedule is saved or the app starts */ }
  const result = (outcome: FireOutcome, runId: number | null, note: string): FireResult => ({ templateId: t.id, scheduledFor, outcome, runId, note });
  try {
    return db
      .transaction((): FireResult => {
        // The time is claimed first. If it is already there, someone else has dealt with it and nothing more is done.
        const claimed = db.prepare("INSERT OR IGNORE INTO suite_schedule_fires (template_id, scheduled_for, outcome, note) VALUES (?, ?, 'error', 'starting')").run(t.id, scheduledFor);
        db.prepare("UPDATE run_templates SET next_run_at = ? WHERE id = ?").run(next, t.id);
        if (claimed.changes === 0) {
          const row = db.prepare("SELECT outcome, run_id, note FROM suite_schedule_fires WHERE template_id = ? AND scheduled_for = ?").get(t.id, scheduledFor) as { outcome: FireOutcome; run_id: number | null; note: string };
          return result(row.outcome, row.run_id, row.note);
        }
        const record = (outcome: FireOutcome, runId: number | null, note: string) => {
          db.prepare("UPDATE suite_schedule_fires SET outcome = ?, run_id = ?, note = ? WHERE template_id = ? AND scheduled_for = ?").run(outcome, runId, note, t.id, scheduledFor);
          return result(outcome, runId, note);
        };
        if (late > CATCH_UP_MINUTES) return record("missed", null, `Due ${scheduledFor} UTC, ${late} minutes late (the limit is ${CATCH_UP_MINUTES}): not run`);
        const open = db
          .prepare("SELECT id FROM runs WHERE template_id = ? AND status = 'in_progress' AND json_extract(meta, '$.scheduled') IS NOT NULL ORDER BY id DESC LIMIT 1")
          .get(t.id) as { id: number } | undefined;
        if (open) return record("skipped_overlap", null, `Run #${open.id} from an earlier schedule is still in progress`);
        if (suiteCaseIds(t.id).length === 0) return record("skipped_empty", null, "The suite has no test cases");
        const run = start(t.id, { title: `${t.name} · ${localDate(due, t.schedule_tz)} (scheduled)`, scheduledFor });
        return record("started", run.id, late > 1 ? `Started ${late} minutes late` : "");
      })
      .immediate();
  } catch (e) {
    // The transaction was rolled back, so nothing half-done is left. The time is recorded as an error and not tried again every minute.
    const note = (e as Error).message.slice(0, 300);
    db.prepare("INSERT OR IGNORE INTO suite_schedule_fires (template_id, scheduled_for, outcome, note) VALUES (?, ?, 'error', ?)").run(t.id, scheduledFor, note);
    db.prepare("UPDATE run_templates SET next_run_at = ? WHERE id = ?").run(next, t.id);
    return result("error", null, note);
  }
}

/**
 * Deals with every suite that is due at `now` (the clock is a parameter so that tests can set it). Returns what became of each. A failure in one suite does not stop
 * the others. `start` is what makes the run; it is the same function as the Run button's.
 */
export function runDueSchedules(now: Date = new Date(), start: StartRun = startSuiteRun): FireResult[] {
  const due = db
    .prepare("SELECT id, project_id, name, schedule, schedule_tz, next_run_at FROM run_templates WHERE schedule IS NOT NULL AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id")
    .all(toDbTime(now)) as TemplateSchedule[];
  return due.map((t) => fire(t, now, start));
}

/** A suite with a schedule but no next time (the app was stopped in the middle of a change, or a database came from somewhere else) gets one. */
export function repairNextRuns(now: Date = new Date()): number {
  const rows = db.prepare("SELECT id, project_id, name, schedule, schedule_tz, next_run_at FROM run_templates WHERE schedule IS NOT NULL AND next_run_at IS NULL").all() as TemplateSchedule[];
  let fixed = 0;
  for (const t of rows) {
    try {
      const next = nextRunAfter(t.schedule!, t.schedule_tz, now);
      if (next) { db.prepare("UPDATE run_templates SET next_run_at = ? WHERE id = ?").run(toDbTime(next), t.id); fixed++; }
    } catch { /* a stored schedule the library does not accept: left alone */ }
  }
  return fixed;
}

/** On unless TESTBENCH_SCHEDULER=0 (for Docker or a second instance on the same data). Schedules are still saved when it is off; they just do not start anything. */
export const schedulerEnabled = () => process.env.TESTBENCH_SCHEDULER !== "0";

/** Starts the timer: a first look after 15 seconds and then every minute. Returns false when it is turned off. Like the other background jobs it does not keep the process alive. */
export function startScheduler(log: (msg: string) => void = console.log): boolean {
  if (!schedulerEnabled()) {
    log("Scheduler is off (TESTBENCH_SCHEDULER=0): scheduled suites will not start.");
    return false;
  }
  const tick = () => {
    try {
      for (const r of runDueSchedules()) log(`Scheduled suite ${r.templateId}: ${r.outcome}${r.note ? ` (${r.note})` : ""}${r.runId ? `, run #${r.runId}` : ""}`);
    } catch (e) {
      log(`Scheduler: ${(e as Error).message}`);
    }
  };
  try {
    repairNextRuns();
  } catch (e) {
    log(`Scheduler: ${(e as Error).message}`);
  }
  setTimeout(tick, 15_000).unref();
  setInterval(tick, 60_000).unref();
  return true;
}
