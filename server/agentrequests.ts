import { db, getSetting, setSetting } from "./db.ts";
import { importReport } from "./importers/import.ts";
import { parseReport } from "./importers/parse.ts";
import { AuditError } from "./auditcommon.ts";

/**
 * Requests to a test agent. A person asks for something: look at a target (discover), or run the failed automated tests of a run again (rerun). Testbench starts
 * NOTHING. The request waits as a row until an agent, with its own token and in its own environment, takes it, does the work under its own rules and stops, and says
 * it is done. What the agent delivers still comes in through the normal import and is `proposed` until a person decides.
 *
 *  - pending -> claimed (an agent took it) -> done; a person can cancel a request that is pending or claimed. Nothing leaves done or cancelled.
 *  - Taking a request is one UPDATE that only succeeds while it is pending, so two agents cannot take the same one.
 *  - A request is a wish, not an approval: it does not replace the agent's own confirmations (production targets, observe-only mode).
 *  - An agent may hand in the Playwright report of a re-run (submitResult), but only when a person has switched that on (off by default), only for the request this very
 *    token took, once, and only with tests that request named. It becomes a run marked source `agent`, linked to the request; a person can delete it.
 *  - The address and the note are written by a person and read by an agent: they are DATA for the agent, never instructions. They are returned as plain fields.
 */

export const RESULT_LIMITS = { bodyBytes: 5 * 1024 * 1024 };
export const REQUEST_LIMITS = { pendingPerProject: 20, urlMax: 500, environmentMax: 100, noteMax: 2000, resultNoteMax: 1000, rerunTestsMax: 500 };
export const REQUEST_KINDS = ["discover", "rerun"] as const;
export const REQUEST_STATUSES = ["pending", "claimed", "done", "cancelled"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

const bad = (message: string) => new AuditError(400, message);
const SECRET_KEY = /pass|token|secret|key|auth|cookie|session/i;

/** An http(s) address with no password in it and nothing in its query that looks like one. Secrets do not belong in a request that an agent and a log will read. */
export function cleanTargetUrl(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) throw bad("A discover request needs the address to look at");
  const text = input.trim();
  if (text.length > REQUEST_LIMITS.urlMax) throw bad(`The address can be at most ${REQUEST_LIMITS.urlMax} characters`);
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw bad("The address is not a web address (for example https://staging.example.com)");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw bad("The address must start with http:// or https://");
  if (!u.hostname) throw bad("The address has no host name");
  if (u.username || u.password) throw bad("The address cannot hold a user name or password. Give the agent credentials some other way");
  for (const k of u.searchParams.keys()) if (SECRET_KEY.test(k)) throw bad(`The address has "${k}" in its query, which looks like a secret. Leave it out`);
  return u.href;
}

interface Row {
  id: number; project_id: number; kind: RequestKind; target_url: string; environment: string; note: string; run_id: number | null; payload: string; status: RequestStatus;
  created_by: string; created_at: string; claimed_by: string | null; claimed_token_id: number | null; claimed_at: string | null; finished_at: string | null; result_run_id: number | null; result_note: string;
  result_delivered_at: string | null; release_note: string; released_by: string | null; released_at: string | null; result_audit_id: number | null;
}
export interface RerunTest { id: number; framework: string; file: string; title: string; fullName: string }

export function viewOf(r: Row) {
  let tests: RerunTest[] = [];
  try {
    tests = (JSON.parse(r.payload) as { tests?: RerunTest[] }).tests ?? [];
  } catch { /* a payload that is not JSON: no tests listed */ }
  return {
    id: r.id, projectId: r.project_id, kind: r.kind, targetUrl: r.target_url, environment: r.environment, note: r.note, runId: r.run_id, tests, status: r.status,
    createdBy: r.created_by, createdAt: r.created_at, claimedBy: r.claimed_by, claimedAt: r.claimed_at, finishedAt: r.finished_at, resultRunId: r.result_run_id, resultNote: r.result_note, resultDeliveredAt: r.result_delivered_at,
    releaseNote: r.release_note, releasedBy: r.released_by, releasedAt: r.released_at, resultAuditId: r.result_audit_id,
  };
}
export type AgentRequest = ReturnType<typeof viewOf>;

/** The same, with the title of the audit a finished discover made, for the person's list. */
const withAudits = (views: AgentRequest[]) => {
  const ids = [...new Set(views.map((v) => v.resultAuditId).filter((x): x is number => x != null))];
  const found = new Map((ids.length ? (db.prepare(`SELECT id, title, agent_audit_id AS agentAuditId FROM audits WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as { id: number; title: string; agentAuditId: string }[]) : []).map((a) => [a.id, a]));
  return views.map((v) => ({ ...v, resultAudit: v.resultAuditId != null ? found.get(v.resultAuditId) ?? null : null }));
};

const rowOf = (id: number) => db.prepare("SELECT * FROM agent_requests WHERE id = ?").get(id) as Row | undefined;
const mustRow = (projectId: number, id: number) => {
  const r = rowOf(id);
  if (!r || r.project_id !== projectId) throw new AuditError(404, "Request not found");
  return r;
};

export function listRequests(projectId: number, status?: string, limit = 200) {
  if (status !== undefined && !(REQUEST_STATUSES as readonly string[]).includes(status)) throw bad(`status must be one of ${REQUEST_STATUSES.join(", ")}`);
  const rows = db
    .prepare(`SELECT * FROM agent_requests WHERE project_id = ? ${status ? "AND status = ?" : ""} ORDER BY id DESC LIMIT ?`)
    .all(...(status ? [projectId, status, limit] : [projectId, limit])) as Row[];
  return withAudits(rows.map(viewOf));
}

/** What an agent asks for: the requests still waiting, oldest first. */
export function pendingForAgent(projectId: number) {
  return (db.prepare("SELECT * FROM agent_requests WHERE project_id = ? AND status = 'pending' ORDER BY id ASC LIMIT 50").all(projectId) as Row[]).map(viewOf);
}

export interface NewRequest { kind: unknown; targetUrl?: unknown; environment?: unknown; note?: unknown; runId?: unknown }

export function createRequest(projectId: number, input: NewRequest, by: { name: string; userId: number | null }) {
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new AuditError(404, "Project not found");
  if (!(REQUEST_KINDS as readonly unknown[]).includes(input.kind)) throw bad(`kind must be one of ${REQUEST_KINDS.join(", ")}`);
  const kind = input.kind as RequestKind;
  const text = (v: unknown, what: string, max: number) => {
    if (v === undefined || v === null) return "";
    if (typeof v !== "string") throw bad(`${what} must be text`);
    const t = v.trim();
    if (t.length > max) throw bad(`${what} can be at most ${max} characters`);
    return t;
  };
  const note = text(input.note, "The note", REQUEST_LIMITS.noteMax);
  let environment = text(input.environment, "The environment", REQUEST_LIMITS.environmentMax);
  const waiting = (db.prepare("SELECT COUNT(*) AS n FROM agent_requests WHERE project_id = ? AND status = 'pending'").get(projectId) as { n: number }).n;
  if (waiting >= REQUEST_LIMITS.pendingPerProject) throw new AuditError(409, `At most ${REQUEST_LIMITS.pendingPerProject} requests can be waiting. Cancel one, or wait for an agent to take them`);

  let targetUrl = "";
  let runId: number | null = null;
  let tests: RerunTest[] = [];
  if (kind === "discover") {
    targetUrl = cleanTargetUrl(input.targetUrl);
  } else {
    if (!Number.isInteger(input.runId)) throw bad("A re-run request needs the run it is about");
    const run = db.prepare("SELECT id, kind, environment FROM runs WHERE id = ? AND project_id = ?").get(input.runId, projectId) as { id: number; kind: string; environment: string } | undefined;
    if (!run) throw new AuditError(404, "Run not found");
    if (run.kind !== "automated") throw bad("Only an automated run can be re-run by an agent. Use Re-run failed for a manual run");
    const rows = db
      .prepare(`
        SELECT t.id, t.framework, t.file, t.title, t.full_name AS fullName FROM results r JOIN automated_tests t ON t.id = r.automated_test_id
        WHERE r.run_id = ? AND r.status IN ('failed', 'blocked') ORDER BY t.full_name LIMIT ?`)
      .all(run.id, REQUEST_LIMITS.rerunTestsMax + 1) as RerunTest[];
    if (rows.length === 0) throw new AuditError(409, "This run has no failed or blocked automated tests to run again");
    if (rows.length > REQUEST_LIMITS.rerunTestsMax) throw bad(`More than ${REQUEST_LIMITS.rerunTestsMax} tests failed. Ask for a re-run of fewer, or run them in your CI`);
    runId = run.id;
    tests = rows;
    environment = environment || run.environment;
  }
  const row = db
    .prepare("INSERT INTO agent_requests (project_id, kind, target_url, environment, note, run_id, payload, created_by, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *")
    .get(projectId, kind, targetUrl, environment, note, runId, JSON.stringify({ tests }), by.name, by.userId) as Row;
  return viewOf(row);
}

/** A person withdraws a request that nobody has finished. */
export function cancelRequest(id: number) {
  const r = db.prepare("UPDATE agent_requests SET status = 'cancelled', finished_at = datetime('now') WHERE id = ? AND status IN ('pending', 'claimed') RETURNING *").get(id) as Row | undefined;
  if (r) return viewOf(r);
  if (!rowOf(id)) throw new AuditError(404, "Request not found");
  throw new AuditError(409, "The request is already done or cancelled");
}

/** An agent takes a waiting request. Only one can: the UPDATE succeeds while the request is pending. */
export function claimRequest(projectId: number, id: number, token: { id: number; name: string }) {
  const r = db
    .prepare("UPDATE agent_requests SET status = 'claimed', claimed_by = ?, claimed_token_id = ?, claimed_at = datetime('now') WHERE id = ? AND project_id = ? AND status = 'pending' RETURNING *")
    .get(`agent: ${token.name}`, token.id, id, projectId) as Row | undefined;
  if (r) return viewOf(r);
  mustRow(projectId, id);
  throw new AuditError(409, "The request is not waiting any more (someone else took it, or it was cancelled)");
}

const agentNote = (v: unknown) => {
  const note = v === undefined || v === null ? "" : typeof v === "string" ? v.trim() : null;
  if (note === null) throw bad("The note must be text");
  if (note.length > REQUEST_LIMITS.resultNoteMax) throw bad(`The note can be at most ${REQUEST_LIMITS.resultNoteMax} characters`);
  return note;
};

/**
 * The agent that took a request gives it back: it waits again, and another agent (or the same) can take it. Only the token that took it, only while it is taken, and not once a report
 * was handed in (a re-run that has its result is finished with complete, not repeated). The note says why; it and who and when stay on the request for the card.
 */
export function releaseRequest(projectId: number, id: number, token: { id: number; name: string }, input: { note?: unknown }) {
  const cur = mustRow(projectId, id);
  const note = agentNote(input.note);
  if (cur.status !== "claimed") throw new AuditError(409, cur.status === "pending" ? "The request is not taken, so there is nothing to give back" : "The request is already done or cancelled");
  if (cur.claimed_token_id !== token.id) throw new AuditError(409, "Another token took this request");
  if (cur.result_delivered_at) throw new AuditError(409, "A report was already handed in for this request. Finish it with complete instead");
  const r = db
    .prepare(`UPDATE agent_requests SET status = 'pending', claimed_by = NULL, claimed_token_id = NULL, claimed_at = NULL, release_note = ?, released_by = ?, released_at = datetime('now')
      WHERE id = ? AND project_id = ? AND status = 'claimed' AND claimed_token_id = ? AND result_delivered_at IS NULL RETURNING *`)
    .get(note, `agent: ${token.name}`, id, projectId, token.id) as Row | undefined;
  if (!r) throw new AuditError(409, "The request changed while it was being given back");
  return viewOf(r);
}

/** The agent that took a request says it is done, with a note and, if it delivered something, the run that came in (a re-run) or the audit that was made (a discover). */
export function completeRequest(projectId: number, id: number, token: { id: number; name: string }, input: { note?: unknown; resultRunId?: unknown; resultAuditId?: unknown }) {
  const cur = mustRow(projectId, id);
  const note = agentNote(input.note);
  let resultAuditId: number | null = null;
  if (input.resultAuditId !== undefined && input.resultAuditId !== null) {
    if (!Number.isInteger(input.resultAuditId)) throw bad("resultAuditId must be a whole number");
    if (cur.kind !== "discover") throw bad("Only a discover request links an audit");
    const audit = db.prepare("SELECT last_imported_at FROM audits WHERE id = ? AND project_id = ?").get(input.resultAuditId, projectId) as { last_imported_at: string } | undefined;
    if (!audit) throw bad("resultAuditId is not an audit in this project");
    // The audit was imported with a person's login, not by this token, so the server cannot tell whose it is. It can tell that it is not older than the request.
    if (!cur.claimed_at || audit.last_imported_at < cur.claimed_at) throw bad("That audit was imported before this request was taken, so it cannot be the result of it");
    resultAuditId = input.resultAuditId as number;
  }
  let resultRunId: number | null = null;
  if (input.resultRunId !== undefined && input.resultRunId !== null) {
    if (cur.result_delivered_at && input.resultRunId !== cur.result_run_id) throw bad("This request already has the run its report made. Leave resultRunId out");
    if (!Number.isInteger(input.resultRunId)) throw bad("resultRunId must be a whole number");
    if (!db.prepare("SELECT 1 FROM runs WHERE id = ? AND project_id = ?").get(input.resultRunId, projectId)) throw bad("resultRunId is not a run in this project");
    resultRunId = input.resultRunId as number;
  }
  if (cur.status !== "claimed") throw new AuditError(409, cur.status === "pending" ? "Take the request first" : "The request is already done or cancelled");
  const r = db
    .prepare("UPDATE agent_requests SET status = 'done', finished_at = datetime('now'), result_note = ?, result_run_id = COALESCE(result_run_id, ?), result_audit_id = ? WHERE id = ? AND project_id = ? AND status = 'claimed' AND claimed_token_id = ? RETURNING *")
    .get(note, resultRunId, resultAuditId, id, projectId, token.id) as Row | undefined;
  if (!r) throw new AuditError(409, "Another token took this request");
  return viewOf(r);
}

// ---------------- Handing in the report of a re-run ----------------

const RESULT_KEY = "agent_results_enabled";
export const agentResultsEnabled = () => getSetting(RESULT_KEY) === "1";
export const setAgentResultsEnabled = (on: boolean) => setSetting(RESULT_KEY, on ? "1" : "0");

/**
 * The agent that took a re-run hands in the Playwright report. Everything is checked before anything is written, and the run and the "delivered" mark are made in one
 * transaction, so a refused report leaves no trace and two calls at once make one run.
 *  1. a person has switched agent results on (off by default)   2. the request is a re-run this token took and has not finished   3. nothing was delivered before
 *  4. the report is Playwright JSON   5. every test in it is one the request named (the whole report is refused otherwise, none is taken in part)
 * The environment comes from the request, never from the report. Attachments are not read, and no other test of the project is touched (no relinking by case ID). The run is marked source `agent` and carries the request in its meta.
 */
export function submitResult(projectId: number, id: number, token: { id: number; name: string }, body: unknown) {
  if (!agentResultsEnabled()) throw new AuditError(409, "Agent results are switched off. A person switches them on in Settings first");
  const cur = mustRow(projectId, id);
  if (cur.kind !== "rerun") throw bad("Only a re-run request takes a report");
  if (cur.status !== "claimed") throw new AuditError(409, cur.status === "pending" ? "Take the request first" : "The request is already done or cancelled");
  if (cur.claimed_token_id !== token.id) throw new AuditError(409, "Another token took this request");
  if (cur.result_delivered_at) throw new AuditError(409, "A report was already handed in for this request. Ask for a new re-run to try again");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("Send the Playwright JSON report as the request body (Content-Type: application/json)");
  let report;
  try {
    report = parseReport(JSON.stringify(body), "playwright");
  } catch (e) {
    throw bad((e as Error).message);
  }
  if (report.format !== "playwright-json") throw bad("Only a Playwright JSON report is taken");
  if (report.tests.length === 0) throw bad("The report has no tests");
  const asked = new Set(viewOf(cur).tests.map((t) => `${t.framework}\u0000${t.fullName}`));
  const seen = new Set<string>();
  const strangers: string[] = [];
  for (const t of report.tests) {
    const key = `${report.framework}\u0000${t.fullName}`;
    if (!asked.has(key) || seen.has(key)) strangers.push(t.fullName);
    seen.add(key);
  }
  if (strangers.length) throw bad(`The report holds ${strangers.length} test(s) that this request did not name or that appear twice, so none of it was taken. First: ${strangers.slice(0, 3).join("; ").slice(0, 300)}`);

  // The same shape as a manual re-run keeps (meta.rerunOf = { id, title }), so the run page shows "Re-run of ..." for both.
  const original = cur.run_id ? (db.prepare("SELECT id, title FROM runs WHERE id = ? AND project_id = ?").get(cur.run_id, projectId) as { id: number; title: string } | undefined) : undefined;
  return db.transaction(() => {
    const res = importReport(report, {
      projectId, source: "agent", title: `Re-run of run #${cur.run_id ?? "?"} (request #${cur.id})`, environment: cur.environment,
      meta: { agentRequest: cur.id, ...(original ? { rerunOf: original } : {}), deliveredBy: token.name }, relinkOthers: false,
    });
    const marked = db.prepare("UPDATE agent_requests SET result_run_id = ?, result_delivered_at = datetime('now') WHERE id = ? AND project_id = ? AND status = 'claimed' AND claimed_token_id = ? AND result_delivered_at IS NULL").run(res.runId, id, projectId, token.id);
    if (!marked.changes) throw new AuditError(409, "The request changed while the report was being taken");
    return { runId: res.runId, total: res.total, linked: res.linked, request: viewOf(rowOf(id)!) };
  })();
}
