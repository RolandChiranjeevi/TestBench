import type { Tone } from "./statuses";

// What the status of a request in the list says: one word and one tone, decided here and nowhere else. Plain TypeScript, no React, so a test can check it.
// A load test that ended with a `fail` is not "Done" in the way a discover is: the agent finished, and the result is a failure, so the chip says both.

export type RequestStatus = "pending" | "claimed" | "done" | "cancelled";
export type LoadVerdict = "pass" | "warning" | "fail";
export interface StatusLook { tone: Tone; label: string; title: string }

export const STATUS: Record<RequestStatus, StatusLook> = {
  pending: { tone: "info", label: "Waiting", title: "No agent has taken it yet" },
  claimed: { tone: "accent", label: "Taken", title: "An agent has taken it and is working on it" },
  done: { tone: "ok", label: "Done", title: "The agent says it is finished" },
  cancelled: { tone: "neutral", label: "Cancelled", title: "A person withdrew it" },
};

/** How a finished load test ended, in a word and a tone. A word and a tone for each verdict the server accepts (a test checks it against the server's list). */
export const LOAD_DONE: Record<LoadVerdict, StatusLook> = {
  pass: { tone: "ok", label: "Done · pass", title: "The agent is finished, and the load test stayed within its limits" },
  warning: { tone: "warn", label: "Done · warning", title: "The agent is finished. The load test ended with a warning: open the report to see why" },
  fail: { tone: "fail", label: "Done · fail", title: "The agent is finished. The load test failed: open the report to see why" },
};

/** The chip of a request: its status, and for a finished load test also how it ended. */
export function statusOf(r: { status: RequestStatus; kind: string; loadVerdict?: LoadVerdict | null }): StatusLook {
  if (r.status === "done" && r.kind === "loadtest" && r.loadVerdict) return LOAD_DONE[r.loadVerdict];
  return STATUS[r.status];
}
