/** A run that an agent handed in for a request (server/agentrequests.ts, submitResult): source "agent", and the request in meta.agentRequest. Null for any other run. */
export function agentRunInfo(run: { source?: unknown; meta?: unknown }): { requestId: number } | null {
  if (run.source !== "agent") return null;
  const id = run.meta && typeof run.meta === "object" ? (run.meta as { agentRequest?: unknown }).agentRequest : undefined;
  return typeof id === "number" && Number.isInteger(id) ? { requestId: id } : null;
}

type AskedRun = { agentRequest?: { id: number; status: string; claimedBy: string | null; progress?: { total: number; reported: number; missing: number } | null; reportRunId?: number | null } | null };

/** The link on the page of a run that an agent was asked to run, to the automated run that the agent's Playwright report made (AG5b). */
export const reportRunLabel = (runId: number) => `Automated report: run #${runId}`;

/** "2 of 5 results recorded (includes manual results)": how many test cases of a run that an agent was asked to run have a result, whoever set it. Null when there is nothing to say. */
export function progressLabel(p: { total?: unknown; reported?: unknown } | null | undefined): string | null {
  if (!p || !Number.isInteger(p.total) || !Number.isInteger(p.reported) || (p.total as number) <= 0) return null;
  return `${p.reported} of ${p.total} results recorded (includes manual results)`;
}
/** What the progress chip says when you point at it: that the count is not only the agent's, and that what the agent reported may have been changed since. */
export const PROGRESS_TITLE = "How many of the test cases have a result, whoever set it: the agent, or a person by hand. A result the agent reported may have been changed by a person.";

/** The mark on a result an agent reported (AG5a): its name, and what it does not say, which is that a person may have changed the result since. Null for any other result. */
export function reportedByAgent(result: { reported_by_agent_token_id?: unknown; reported_by_agent?: unknown }): { label: string; title: string } | null {
  if (typeof result.reported_by_agent_token_id !== "number") return null;
  const name = typeof result.reported_by_agent === "string" && result.reported_by_agent ? result.reported_by_agent : "an agent";
  return { label: `Agent: ${name}`, title: "Reported by agent. A person may have changed it." };
}

/**
 * A run that a person asked an agent to run (AG4): the request it was made with, and where that request stands. It is a manual run (source "manual"), so it is not
 * `agentRunInfo`, which is for a report an agent handed in. Null for any other run, and for an answer that is not what it expects.
 */
export function askedRunInfo(run: AskedRun): { requestId: number; status: "pending" | "claimed" | "done" | "cancelled"; label: string; title: string; progress: string | null; reportRunId: number | null } | null {
  const r = run.agentRequest;
  if (!r || typeof r !== "object" || typeof r.id !== "number" || !Number.isInteger(r.id)) return null;
  const who = typeof r.claimedBy === "string" && r.claimedBy ? r.claimedBy : "an agent";
  const progress = progressLabel(r.progress);
  const reportRunId = typeof r.reportRunId === "number" && Number.isInteger(r.reportRunId) ? r.reportRunId : null;
  switch (r.status) {
    case "pending": return { requestId: r.id, status: r.status, progress, reportRunId, label: `Waiting for agent · request #${r.id}`, title: "A person asked an agent to run these cases. Nobody has taken the request yet. You can still run the cases yourself." };
    case "claimed": return { requestId: r.id, status: r.status, progress, reportRunId, label: `Taken by ${who}`, title: `${who} took request #${r.id} and works on these cases in its own environment.` };
    case "done": return { requestId: r.id, status: r.status, progress, reportRunId, label: "Agent finished", title: `The agent finished request #${r.id}. Review the results, then finish the run.` };
    case "cancelled": return { requestId: r.id, status: r.status, progress, reportRunId, label: "Request cancelled", title: `Request #${r.id} was cancelled. The run is kept and can be run by hand.` };
    default: return null;
  }
}

/** Where the audit a finished discover made is shown: Bug reports (the route "bugs" in main.tsx), under Audits, with its row marked. */
export const auditPath = (pid: string | number, auditId: number) => `/p/${pid}/bugs?audit=${auditId}`;
