import type { BadgeLook } from "./statuses";

/** The pure parts of the Results and Compare sections of a spec, so that they can be tested without a screen. */

export interface SpecResultsLike { tests: number; passed: number; failed: number; skipped: number; blocked: number }

/** The one short badge a spec has in the list: what the latest imported results say. A word and an icon, never only a colour. */
export function resultBadge(r: SpecResultsLike): BadgeLook {
  if (r.tests === 0) return { tone: "neutral", icon: "circle-minus", label: "no results" };
  if (r.failed > 0) return { tone: "fail", icon: "circle-x", label: `${r.failed} failed` };
  if (r.blocked > 0) return { tone: "warn", icon: "triangle-alert", label: `${r.blocked} blocked` };
  if (r.passed > 0) return { tone: "ok", icon: "circle-check", label: "passed" };
  if (r.skipped > 0) return { tone: "neutral", icon: "circle-minus", label: "skipped" };
  return { tone: "neutral", icon: "circle", label: "no status" };
}

export type CompareOutcome = "same" | "same except line endings" | "differs";

/** What to say about the outcome of a comparison, and whether "Use the repo version" is offered (when the bytes differ, also if only the line endings do; not when they are the same). */
export function compareView(outcome: CompareOutcome): { text: string; canUse: boolean } {
  if (outcome === "same") return { text: "The same as your file. Nothing to update.", canUse: false };
  if (outcome === "same except line endings") return { text: "The same except for line endings (or the new lines at the very end).", canUse: true };
  return { text: "Different from your file.", canUse: true };
}

/** The lines added and removed, as a sentence; "about" when the count is approximate. */
export function lineSummary(added: number, removed: number, approximate: boolean): string {
  const n = (k: number, w: string) => `${approximate ? "about " : ""}${k} ${w}${k === 1 ? "" : "s"}`;
  return `${n(added, "line")} added, ${n(removed, "line")} removed`;
}

/** The first characters of a hash, for reading; the whole hash stays in the title. */
export const shortHash = (h: string) => h.slice(0, 12);
