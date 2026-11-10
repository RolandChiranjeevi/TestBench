/**
 * What a priority, a severity or an observation status looks like: one tone, one icon and one label, decided here and nowhere else.
 * The Badge components read it. A status is never colour alone: the icon and the word say the same thing.
 * Plain TypeScript, no React, so a test can check it against the server's lists.
 */
export type Tone = "ok" | "fail" | "warn" | "info" | "accent" | "crit" | "neutral";
export type IconName = "chevrons-up" | "chevron-up" | "diamond" | "chevron-down" | "shield-alert" | "info" | "circle" | "eye" | "circle-check" | "archive" | "bug";
export interface BadgeLook { tone: Tone; icon: IconName; label: string }

export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type ObservationStatus = "observed" | "needs_review" | "confirmed" | "resolved" | "archived" | "converted";

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
