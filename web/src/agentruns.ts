/** A run that an agent handed in for a request (server/agentrequests.ts, submitResult): source "agent", and the request in meta.agentRequest. Null for any other run. */
export function agentRunInfo(run: { source?: unknown; meta?: unknown }): { requestId: number } | null {
  if (run.source !== "agent") return null;
  const id = run.meta && typeof run.meta === "object" ? (run.meta as { agentRequest?: unknown }).agentRequest : undefined;
  return typeof id === "number" && Number.isInteger(id) ? { requestId: id } : null;
}

type AskedRun = { agentRequest?: { id: number; status: string; claimedBy: string | null } | null };

/**
 * A run that a person asked an agent to run (AG4): the request it was made with, and where that request stands. It is a manual run (source "manual"), so it is not
 * `agentRunInfo`, which is for a report an agent handed in. Null for any other run, and for an answer that is not what it expects.
 */
export function askedRunInfo(run: AskedRun): { requestId: number; status: "pending" | "claimed" | "done" | "cancelled"; label: string; title: string } | null {
  const r = run.agentRequest;
  if (!r || typeof r !== "object" || typeof r.id !== "number" || !Number.isInteger(r.id)) return null;
  const who = typeof r.claimedBy === "string" && r.claimedBy ? r.claimedBy : "an agent";
  switch (r.status) {
    case "pending": return { requestId: r.id, status: r.status, label: `Waiting for agent · request #${r.id}`, title: "A person asked an agent to run these cases. Nobody has taken the request yet. You can still run the cases yourself." };
    case "claimed": return { requestId: r.id, status: r.status, label: `Taken by ${who}`, title: `${who} took request #${r.id} and works on these cases in its own environment.` };
    case "done": return { requestId: r.id, status: r.status, label: "Agent finished", title: `The agent finished request #${r.id}.` };
    case "cancelled": return { requestId: r.id, status: r.status, label: "Request cancelled", title: `Request #${r.id} was cancelled. The run is kept and can be run by hand.` };
    default: return null;
  }
}

/** Where the audit a finished discover made is shown: Bug reports (the route "bugs" in main.tsx), under Audits, with its row marked. */
export const auditPath = (pid: string | number, auditId: number) => `/p/${pid}/bugs?audit=${auditId}`;
