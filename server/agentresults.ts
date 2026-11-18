import { z } from "zod";
import { db } from "./db.ts";
import { AuditError } from "./auditcommon.ts";
import { audit } from "./accounts.ts";
import { runProgress, type RunCase } from "./agentrequests.ts";

/**
 * Results per test case for a run request (AG5a). A person asked an agent to run chosen test cases (server/agentrequests.ts: the run was made then, with an empty result for each
 * case). The agent ran them in its own environment and reports what happened, one batch at a time.
 *
 *  - Only a `run` request, only the request token that took it, only while it is `claimed`, and only when a person has switched agent results on (they count at once for the
 *    status of a test case, for coverage and for requirements). The route checks the token, the rate limit and the switch; this checks the rest.
 *  - A batch is all or nothing: everything is checked first, then everything is written, in one transaction together with the audit entry, so that a refused batch leaves no trace.
 *    Several batches may follow each other; each test case is reported once.
 *  - A result is only taken for a test case that is in the request, whose result in the run is still untouched: nobody has set it, changed it (also put it back to untested),
 *    commented it, linked an issue to it, given it steps or attached something to it, and no agent has reported it. The agent never writes over what a person has done.
 *  - The status of a result is passed, failed, blocked or skipped. An agent that is not sure says blocked; it never says untested. The time is the server's.
 *  - The result is marked with the token that reported it (results.reported_by_agent_token_id). The mark stays when a person changes the result afterwards.
 *  - Nothing here finishes the request or the run: `complete` (agentrequests.ts) needs a result for every test case, and the run stays in progress for a person to review.
 */

export const CASE_RESULT_LIMITS = { resultsPerCall: 200, perMinute: 60, bodyBytes: 256 * 1024, textMax: 2000, stepsMax: 100, durationMaxMs: 24 * 60 * 60 * 1000 };
export const CASE_RESULT_STATUSES = ["passed", "failed", "blocked", "skipped"] as const;

const status = z.enum(CASE_RESULT_STATUSES, { error: "must be passed, failed, blocked or skipped (report a result you are not sure of as blocked; untested is not a result)" });
const step = z.object({ stepId: z.number().int().positive(), status, actual: z.string().max(CASE_RESULT_LIMITS.textMax).default("") }).strict();
const item = z.object({
  caseId: z.number().int().positive(), status,
  note: z.string().max(CASE_RESULT_LIMITS.textMax).default(""), error: z.string().max(CASE_RESULT_LIMITS.textMax).default(""),
  durationMs: z.number().int().min(0).max(CASE_RESULT_LIMITS.durationMaxMs).optional(),
  steps: z.array(step).max(CASE_RESULT_LIMITS.stepsMax).default([]),
}).strict();

/** The body: a list of results, one per test case. Strict: a field that is not listed is refused, never ignored. */
export const caseResultsBody = z.object({ results: z.array(item).min(1).max(CASE_RESULT_LIMITS.resultsPerCall) }).strict();
export type CaseResultsBody = z.infer<typeof caseResultsBody>;

interface ResultRow {
  id: number; case_id: number; status: string; executed_at: string | null; notes: string; jira_key: string | null; reported_by: number | null;
  has_detail: number; has_steps: number; has_files: number;
}
const keys = (list: string[]) => `${list.slice(0, 5).join(", ")}${list.length > 5 ? `, and ${list.length - 5} more` : ""}`;

/**
 * Takes a batch of results for a run request. `token` is the request token (id and name) that authenticated the call. Returns what was reported, counted by status, and how far
 * the run has come.
 */
export function reportCaseResults(projectId: number, requestId: number, token: { id: number; name: string }, ip: string, body: CaseResultsBody) {
  return db.transaction(() => {
    const r = db.prepare("SELECT id, kind, status, claimed_token_id, run_id, payload FROM agent_requests WHERE id = ? AND project_id = ?").get(requestId, projectId) as
      { id: number; kind: string; status: string; claimed_token_id: number | null; run_id: number | null; payload: string } | undefined;
    if (!r) throw new AuditError(404, "Request not found");
    if (r.kind !== "run") throw new AuditError(409, "Results by test case are only taken for a run request. A discover reports findings, and a re-run hands in its report with the result route");
    if (r.status === "pending") throw new AuditError(409, "The request is not taken. Take it first");
    if (r.status !== "claimed") throw new AuditError(409, "The request is already done or cancelled");
    if (r.claimed_token_id !== token.id) throw new AuditError(409, "Another token took this request");
    if (r.run_id === null) throw new AuditError(409, "The run of this request was deleted, so there is nothing to report to. A person can cancel the request");

    // What the request asked for: the test cases and, for each, its steps, as they were when it was asked.
    let asked: RunCase[] = [];
    try {
      asked = (JSON.parse(r.payload) as { cases?: RunCase[] }).cases ?? [];
    } catch { /* a payload that is not JSON names no cases: every case below is then a stranger */ }
    const byId = new Map(asked.map((c) => [c.caseId, c]));

    // 1. The batch itself: no test case twice, only test cases of this request, only steps of those test cases.
    const seen = new Set<number>();
    const twice = body.results.filter((x) => seen.size === seen.add(x.caseId).size).map((x) => String(x.caseId));
    if (twice.length) throw new AuditError(400, `Each test case can be in a batch once. Twice: ${keys(twice)}`);
    const strangers = body.results.filter((x) => !byId.has(x.caseId)).map((x) => String(x.caseId));
    if (strangers.length) throw new AuditError(400, `${strangers.length} of these test cases are not part of this request, so none of the batch was taken. First: ${keys(strangers)}`);
    for (const x of body.results) {
      const own = new Set(byId.get(x.caseId)!.steps.map((s) => s.id));
      const seenSteps = new Set<number>();
      for (const s of x.steps) {
        if (!own.has(s.stepId)) throw new AuditError(400, `Step ${s.stepId} is not a step of test case ${byId.get(x.caseId)!.key}`);
        if (seenSteps.size === seenSteps.add(s.stepId).size) throw new AuditError(400, `Step ${s.stepId} of test case ${byId.get(x.caseId)!.key} is given twice`);
      }
    }

    // 2. The results in the run: each must exist, and be untouched.
    const rows = db.prepare(`
        SELECT r.id, r.case_id, r.status, r.executed_at, r.notes, r.jira_key, r.reported_by_agent_token_id AS reported_by, r.detail IS NOT NULL AS has_detail,
          EXISTS (SELECT 1 FROM step_results s WHERE s.result_id = r.id) AS has_steps, EXISTS (SELECT 1 FROM attachments a WHERE a.result_id = r.id) AS has_files
        FROM results r WHERE r.run_id = ? AND r.case_id IN (SELECT value FROM json_each(?))`).all(r.run_id, JSON.stringify([...seen])) as ResultRow[];
    const resultOf = new Map(rows.map((x) => [x.case_id, x]));
    const gone = body.results.filter((x) => !resultOf.has(x.caseId)).map((x) => byId.get(x.caseId)!.key);
    if (gone.length) throw new AuditError(409, `${gone.length} of these test cases have no result in the run any more (${keys(gone)}), so none of the batch was taken`);
    const touched = rows.filter((x) => x.status !== "untested" || x.executed_at !== null || x.notes !== "" || x.jira_key !== null || x.reported_by !== null || x.has_detail || x.has_steps || x.has_files)
      .map((x) => byId.get(x.case_id)!.key);
    if (touched.length) throw new AuditError(409, `${touched.length} of these test cases already have a result (${keys(touched)}): reported before, or set or changed by a person. Nothing was taken`);

    // 3. The steps must still be there: a step that was deleted since the request was made cannot take a result.
    const stepIds = db.prepare("SELECT id FROM case_steps WHERE case_id = ?");
    for (const x of body.results) {
      if (!x.steps.length) continue;
      const live = new Set((stepIds.all(x.caseId) as { id: number }[]).map((s) => s.id));
      if (x.steps.some((s) => !live.has(s.stepId))) throw new AuditError(409, `The steps of test case ${byId.get(x.caseId)!.key} have changed since the request was made. Ask for a new run`);
    }

    // 4. Write. Each write is guarded again, so that nothing can be written over even if the checks above were wrong.
    const write = db.prepare(`UPDATE results SET status = ?, notes = ?, error = ?, duration_ms = ?, executed_at = datetime('now'), reported_by_agent_token_id = ?
      WHERE id = ? AND run_id = ? AND status = 'untested' AND executed_at IS NULL AND reported_by_agent_token_id IS NULL`);
    const writeStep = db.prepare("INSERT INTO step_results (result_id, step_id, status, actual) VALUES (?, ?, ?, ?)");
    const counts = { passed: 0, failed: 0, blocked: 0, skipped: 0 };
    for (const x of body.results) {
      const row = resultOf.get(x.caseId)!;
      if (!write.run(x.status, x.note, x.error, x.durationMs ?? null, token.id, row.id, r.run_id).changes) throw new AuditError(409, "A result changed while the batch was being taken, so none of it was");
      for (const s of x.steps) writeStep.run(row.id, s.stepId, s.status, s.actual);
      counts[x.status]++;
    }
    audit({ userId: null, label: `agent: ${token.name}`, ip }, "agent_request.results_reported", {
      projectId, detail: { request: requestId, kind: "run", run: r.run_id, credential_id: token.id, reported: body.results.length, ...counts },
    });
    return { reported: body.results.length, counts, progress: runProgress(r.run_id) };
  })();
}
