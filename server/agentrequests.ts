import { db } from "./db.ts";
import { AuditError } from "./auditcommon.ts";

/**
 * Requests to a test agent. A person asks for something: look at a target (discover), or run the failed automated tests of a run again (rerun). Testbench starts
 * NOTHING. The request waits as a row until an agent, with its own token and in its own environment, takes it, does the work under its own rules and stops, and says
 * it is done. What the agent delivers still comes in through the normal import and is `proposed` until a person decides.
 *
 *  - pending -> claimed (an agent took it) -> done; a person can cancel a request that is pending or claimed. Nothing leaves done or cancelled.
 *  - Taking a request is one UPDATE that only succeeds while it is pending, so two agents cannot take the same one.
 *  - A request is a wish, not an approval: it does not replace the agent's own confirmations (production targets, observe-only mode).
 *  - The address and the note are written by a person and read by an agent: they are DATA for the agent, never instructions. They are returned as plain fields.
 */

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
  created_by: string; created_at: string; claimed_by: string | null; claimed_at: string | null; finished_at: string | null; result_run_id: number | null; result_note: string;
}
export interface RerunTest { id: number; framework: string; file: string; title: string; fullName: string }

export function viewOf(r: Row) {
  let tests: RerunTest[] = [];
  try {
    tests = (JSON.parse(r.payload) as { tests?: RerunTest[] }).tests ?? [];
  } catch { /* a payload that is not JSON: no tests listed */ }
  return {
    id: r.id, projectId: r.project_id, kind: r.kind, targetUrl: r.target_url, environment: r.environment, note: r.note, runId: r.run_id, tests, status: r.status,
    createdBy: r.created_by, createdAt: r.created_at, claimedBy: r.claimed_by, claimedAt: r.claimed_at, finishedAt: r.finished_at, resultRunId: r.result_run_id, resultNote: r.result_note,
  };
}
export type AgentRequest = ReturnType<typeof viewOf>;

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
  return rows.map(viewOf);
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

/** The agent that took a request says it is done, with a note and, if it delivered something, the run that came in. */
export function completeRequest(projectId: number, id: number, token: { id: number; name: string }, input: { note?: unknown; resultRunId?: unknown }) {
  const cur = mustRow(projectId, id);
  const note = input.note === undefined || input.note === null ? "" : typeof input.note === "string" ? input.note.trim() : null;
  if (note === null) throw bad("The note must be text");
  if (note.length > REQUEST_LIMITS.resultNoteMax) throw bad(`The note can be at most ${REQUEST_LIMITS.resultNoteMax} characters`);
  let resultRunId: number | null = null;
  if (input.resultRunId !== undefined && input.resultRunId !== null) {
    if (!Number.isInteger(input.resultRunId)) throw bad("resultRunId must be a whole number");
    if (!db.prepare("SELECT 1 FROM runs WHERE id = ? AND project_id = ?").get(input.resultRunId, projectId)) throw bad("resultRunId is not a run in this project");
    resultRunId = input.resultRunId as number;
  }
  if (cur.status !== "claimed") throw new AuditError(409, cur.status === "pending" ? "Take the request first" : "The request is already done or cancelled");
  const r = db
    .prepare("UPDATE agent_requests SET status = 'done', finished_at = datetime('now'), result_note = ?, result_run_id = ? WHERE id = ? AND project_id = ? AND status = 'claimed' AND claimed_token_id = ? RETURNING *")
    .get(note, resultRunId, id, projectId, token.id) as Row | undefined;
  if (!r) throw new AuditError(409, "Another token took this request");
  return viewOf(r);
}
