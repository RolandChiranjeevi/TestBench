// What a suite schedule looks like to a person (server/scheduler.ts decides what it means). The form is a preset, a time and some weekdays; the server only ever sees a
// 5-field cron expression. A saved expression that is not one of the presets is shown as Custom, as it is, and never rewritten.

export type Preset = "daily" | "weekly" | "custom";
export interface ScheduleForm { preset: Preset; time: string; days: number[]; cron: string }

/** 0 = Sunday, as in cron. Shown from Monday. */
export const WEEK = [1, 2, 3, 4, 5, 6, 0];
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DEFAULT_FORM: ScheduleForm = { preset: "weekly", time: "08:00", days: [1, 2, 3, 4, 5], cron: "" };

const TIME = /^([01]?\d|2[0-3]):([0-5]?\d)$/;
const two = (n: number) => String(n).padStart(2, "0");
const sorted = (days: number[]) => [...new Set(days)].sort((a, b) => WEEK.indexOf(a) - WEEK.indexOf(b));
const isWeekdays = (days: number[]) => days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d));

/** The cron expression of a form, or "" while it is not complete (no time, no weekday, empty custom). */
export function toCron(f: ScheduleForm): string {
  if (f.preset === "custom") return f.cron.trim().replace(/\s+/g, " ");
  const m = TIME.exec(f.time);
  if (!m) return "";
  const at = `${Number(m[2])} ${Number(m[1])}`;
  if (f.preset === "daily") return `${at} * * *`;
  const days = sorted(f.days);
  if (days.length === 0) return "";
  if (days.length === 7) return `${at} * * *`;
  return `${at} * * ${isWeekdays(days) ? "1-5" : days.join(",")}`;
}

/** The form a saved expression opens as. Anything that is not a daily or weekly time is Custom, with the expression untouched. */
export function fromCron(expression: string | null | undefined): ScheduleForm {
  const expr = (expression ?? "").trim().replace(/\s+/g, " ");
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6](?:,[0-6])*)$/.exec(expr);
  if (!m || Number(m[1]) > 59 || Number(m[2]) > 23) return { ...DEFAULT_FORM, preset: "custom", cron: expr };
  const time = `${two(Number(m[2]))}:${two(Number(m[1]))}`;
  if (m[3] === "*") return { preset: "daily", time, days: DEFAULT_FORM.days, cron: "" };
  const days = m[3] === "1-5" ? [1, 2, 3, 4, 5] : m[3].split(",").map(Number);
  return { preset: "weekly", time, days: sorted(days), cron: "" };
}

/** "Weekdays 08:00 (Europe/Stockholm)", "Mon, Wed 14:30 (UTC)", "Every day 06:00 (UTC)", or the expression itself when it is custom. */
export function describeSchedule(expression: string, timezone: string): string {
  const f = fromCron(expression);
  if (f.preset === "custom") return `${expression} (${timezone})`;
  const when = f.preset === "daily" ? "Every day" : isWeekdays(f.days) ? "Weekdays" : f.days.map((d) => DAY_NAMES[d].slice(0, 3)).join(", ");
  return `${when} ${f.time} (${timezone})`;
}

/** The time zone of this browser, or UTC when it cannot say. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The IANA names this browser knows (the server checks the same list), UTC first. */
export function timezoneNames(): string[] {
  try {
    return ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")];
  } catch {
    return ["UTC"];
  }
}

/** What the schedule log says about one outcome. */
export const OUTCOME_LABEL: Record<string, string> = {
  started: "Run prepared",
  skipped_overlap: "Skipped: the last scheduled run is still open",
  skipped_empty: "Skipped: no test cases",
  missed: "Missed: more than 2 hours late",
  error: "Error",
};
