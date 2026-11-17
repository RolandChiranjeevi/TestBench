/** A run that an agent handed in for a request (server/agentrequests.ts, submitResult): source "agent", and the request in meta.agentRequest. Null for any other run. */
export function agentRunInfo(run: { source?: unknown; meta?: unknown }): { requestId: number } | null {
  if (run.source !== "agent") return null;
  const id = run.meta && typeof run.meta === "object" ? (run.meta as { agentRequest?: unknown }).agentRequest : undefined;
  return typeof id === "number" && Number.isInteger(id) ? { requestId: id } : null;
}

/** Where the audit a finished discover made is shown: Bug reports (the route "bugs" in main.tsx), under Audits, with its row marked. */
export const auditPath = (pid: string | number, auditId: number) => `/p/${pid}/bugs?audit=${auditId}`;
