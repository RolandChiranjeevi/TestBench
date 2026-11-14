// What the screens say about automation and about how a suite has changed. Plain functions, so that the words can be tested without a browser.
// The server derives the same thing for suites and runs (server/runsuites.ts, automationByCase); the case list has the two numbers it needs already.

/** manual: no automated test is linked to the case. automated: tests are linked and the case has no manual steps. both: tests are linked and it has steps. */
export type Automation = "manual" | "automated" | "both";

export const AUTOMATION_LABEL: Record<Automation, string> = { manual: "Manual", automated: "Automated", both: "Manual + automated" };

export function automationOf(c: { automated_count: number; step_count: number }): Automation {
  return c.automated_count === 0 ? "manual" : c.step_count > 0 ? "both" : "automated";
}

export interface LastAutomated {
  status: "passed" | "failed";
  at: string;
  runId: number;
  /** How many of the linked tests have a result. */
  tests: number;
}

/** "failed · 2 tests" : what to say about the latest automated result of a case. The time and the link are added by the screen. */
export function lastAutomatedText(a: LastAutomated): string {
  return `${a.status}${a.tests > 1 ? ` · ${a.tests} tests` : ""}`;
}

export interface RunSuiteInfo {
  /** null when the suite has been deleted. */
  id: number | null;
  name: string;
  deleted: boolean;
  /** The run covered only part of the suite on purpose. */
  partial: boolean;
  added: number;
  removed: number;
}

const cases = (n: number) => `${n} ${n === 1 ? "case" : "cases"}`;

/** How the suite has changed since a run was made from it, or null when it has not (or when the run covered only part of it on purpose, or the suite is gone). */
export function suiteDriftText(info: Pick<RunSuiteInfo, "deleted" | "partial" | "added" | "removed">): string | null {
  if (info.deleted || info.partial) return null;
  if (info.added > 0 && info.removed > 0) return `${cases(info.added)} added to the suite and ${info.removed} removed since this run`;
  if (info.added > 0) return `${cases(info.added)} added to the suite since this run`;
  if (info.removed > 0) return `${cases(info.removed)} removed from the suite since this run`;
  return null;
}
