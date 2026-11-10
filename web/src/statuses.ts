/**
 * What a priority, a severity or an observation status looks like: one tone, one icon and one label, decided here and nowhere else.
 * The Badge components read it. A status is never colour alone: the icon and the word say the same thing.
 * Plain TypeScript, no React, so a test can check it against the server's lists.
 */
export type Tone = "ok" | "fail" | "warn" | "info" | "accent" | "crit" | "neutral";
export type IconName = "chevrons-up" | "chevron-up" | "diamond" | "chevron-down" | "shield-alert" | "info" | "circle" | "eye" | "circle-check" | "archive" | "bug"
  | "circle-x" | "copy" | "triangle-alert" | "eye-off" | "circle-minus";
export interface BadgeLook { tone: Tone; icon: IconName; label: string }

/** How well a requirement is covered by test cases. No test case is a gap (neutral, minus); a test case that has not run yet is neutral too (empty circle). */
export type CoverageState = "uncovered" | "failing" | "passing" | "partial" | "untested";
export const COVERAGE_LOOK: Record<CoverageState, BadgeLook> = {
  uncovered: { tone: "neutral", icon: "circle-minus", label: "No test cases" },
  failing: { tone: "fail", icon: "circle-x", label: "Failing" },
  passing: { tone: "ok", icon: "circle-check", label: "Passing" },
  partial: { tone: "warn", icon: "triangle-alert", label: "Partly tested" },
  untested: { tone: "neutral", icon: "circle", label: "Not run yet" },
};

export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type ObservationStatus = "observed" | "needs_review" | "confirmed" | "resolved" | "archived" | "converted";

/** The decision on a bug report (or on a proposed manual test): proposed waits for a person, so it is the accent; accepted is a decision made, so it is green. */
export type ReviewStatus = "proposed" | "accepted" | "rejected" | "duplicate";
export const REVIEW_STATUS_LOOK: Record<ReviewStatus, BadgeLook> = {
  proposed: { tone: "accent", icon: "eye", label: "Proposed" },
  accepted: { tone: "ok", icon: "circle-check", label: "Accepted" },
  rejected: { tone: "neutral", icon: "circle-x", label: "Rejected" },
  duplicate: { tone: "neutral", icon: "copy", label: "Duplicate" },
};

/** The latest result of a test in CI. Flaky is yellow, like blocked: it passed on retry, so it is not to be trusted. */
export type CiStatus = "passed" | "failed" | "flaky";
export const CI_STATUS_LOOK: Record<CiStatus, BadgeLook> = {
  passed: { tone: "ok", icon: "circle-check", label: "Passed" },
  failed: { tone: "fail", icon: "circle-x", label: "Failed" },
  flaky: { tone: "warn", icon: "triangle-alert", label: "Flaky" },
};

/** Where a bug is in its life after it was accepted. "May be resolved" is green because the test is green again; the person still has to check and close it. */
export type BugWorkflow = "open" | "resolved_suspected" | "closed";
export const BUG_WORKFLOW_LOOK: Record<BugWorkflow, BadgeLook> = {
  open: { tone: "neutral", icon: "circle", label: "Open" },
  resolved_suspected: { tone: "ok", icon: "circle-check", label: "May be resolved" },
  closed: { tone: "neutral", icon: "archive", label: "Closed" },
};

/**
 * Priorities in a test plan are free text from the agent (P0, High, critical ...). P0 and critical are solid red, P1 and high soft red,
 * P2 and medium yellow, anything else (P3, low, an unknown word) neutral.
 */
export function priorityLook(value: string): BadgeLook {
  const label = value.trim();
  if (/^(p0|critical|blocker)$/i.test(label)) return { tone: "crit", icon: "chevrons-up", label };
  if (/^(p1|high)$/i.test(label)) return { tone: "fail", icon: "chevron-up", label };
  if (/^(p2|medium)$/i.test(label)) return { tone: "warn", icon: "diamond", label };
  return { tone: "neutral", icon: "chevron-down", label };
}

export const SEVERITY_LOOK: Record<Severity, BadgeLook> = {
  critical: { tone: "crit", icon: "shield-alert", label: "Critical" },
  high: { tone: "fail", icon: "chevron-up", label: "High" },
  medium: { tone: "warn", icon: "diamond", label: "Medium" },
  low: { tone: "neutral", icon: "chevron-down", label: "Low" },
  info: { tone: "info", icon: "info", label: "Info" },
};

/** Needs review is the accent because it waits for a person; confirmed is a finding that is real, so it is red; resolved is the only green. */
export const OBSERVATION_STATUS_LOOK: Record<ObservationStatus, BadgeLook> = {
  observed: { tone: "neutral", icon: "circle", label: "Observed" },
  needs_review: { tone: "accent", icon: "eye", label: "Needs review" },
  confirmed: { tone: "fail", icon: "shield-alert", label: "Confirmed" },
  resolved: { tone: "ok", icon: "circle-check", label: "Resolved" },
  archived: { tone: "neutral", icon: "archive", label: "Archived" },
  converted: { tone: "info", icon: "bug", label: "Converted" },
};
