import { db, getSetting, setSetting } from "./db.ts";
import { importReport } from "./importers/import.ts";
import { parseReport, type ParsedTest } from "./importers/parse.ts";
import { AuditError } from "./auditcommon.ts";
import { audit } from "./accounts.ts";
import { createManualRun } from "./runsuites.ts";
import { fileMatchesSpec } from "./specs.ts";

/**
 * Requests to a test agent. A person asks for something: look at a target (discover), run the failed automated tests of a run again (rerun), or run chosen test cases (run:
 * the run is made at once, with an empty result for each case, and the request points at it; the agent reports a result for each case with server/agentresults.ts and the
 * request is done when every case has one, whoever set it). Testbench starts
 * NOTHING. The request waits as a row until an agent, with its own token and in its own environment, takes it, does the work under its own rules and stops, and says
 * it is done. What the agent delivers still comes in through the normal import and is `proposed` until a person decides.
 *
 *  - pending -> claimed (an agent took it) -> done; a person can cancel a request that is pending or claimed. Nothing leaves done or cancelled.
 *  - Taking a request is one UPDATE that only succeeds while it is pending, so two agents cannot take the same one.
 *  - A request is a wish, not an approval: it does not replace the agent's own confirmations (production targets, observe-only mode).
 *  - An agent may hand in the Playwright report of a re-run or of a run request (submitResult), but only when a person has switched that on (off by default), only for the
 *    request this very token took, once, and only with tests that request named (for a run request also a new test in one of its spec files). It becomes a run marked source
 *    `agent`, linked to the request; a person can delete it. TestBench decides which case a test belongs to, never the text of the report.
 *  - The address and the note are written by a person and read by an agent: they are DATA for the agent, never instructions. They are returned as plain fields.
 */

/** A Playwright report handed in for a re-run or a run: at most 5 MB and 1000 tests, and at most 10 handed in a minute per token (every attempt counts). */
export const RESULT_LIMITS = { bodyBytes: 5 * 1024 * 1024, testsMax: 1000, perMinute: 10 };
export const REQUEST_LIMITS = { pendingPerProject: 20, urlMax: 500, environmentMax: 100, noteMax: 2000, resultNoteMax: 1000, rerunTestsMax: 500, runCasesMax: 200, runPayloadBytes: 1024 * 1024, runTitleMax: 200 };
export const REQUEST_KINDS = ["discover", "rerun", "run"] as const;
export const REQUEST_STATUSES = ["pending", "claimed", "done", "cancelled"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

const bad = (message: string) => new AuditError(400, message);
const SECRET_KEY = /pass|token|secret|key|auth|cookie|session/i;

/**
 * The choices a person makes when asking for a discover. They are a PRESELECTION for the agent's one confirmation, never a permission: the agent still stops at its own ceiling (the
 * profile's `permissionMode`, the repository's rules) and at what the person confirms in the session, and a request can never raise either. Nothing here is free text.
 */
export const REQUEST_OPTIONS = {
  targetModes: ["observe_only", "full"],
  gitModes: ["off", "local", "pr"],
  deliverables: ["plan", "cases", "observations", "bugs", "specs"],
  viewports: ["desktop", "tablet", "mobile"],
} as const;
export interface RequestOptions {
  /** What the agent may do to the target: only read it, or also change its state (each action still needs the person's confirmation in the session). */
  targetMode: (typeof REQUEST_OPTIONS.targetModes)[number];
  /** What the agent may do in git: nothing, commit on a local branch, or also push that branch and open a pull request (never merge). */
  gitMode: (typeof REQUEST_OPTIONS.gitModes)[number];
  deliverables: (typeof REQUEST_OPTIONS.deliverables)[number][];
  viewports: (typeof REQUEST_OPTIONS.viewports)[number][];
  /** The person says the target is production. A hint only (the agent still asks for its two confirmations), but with it the target can only be read. */
  production: boolean;
}
export const DEFAULT_REQUEST_OPTIONS: RequestOptions = { targetMode: "observe_only", gitMode: "local", deliverables: ["plan", "cases", "observations", "bugs"], viewports: ["desktop", "tablet", "mobile"], production: false };

/** The options of a discover request, checked and with the defaults filled in. Anything unknown or out of range is refused: these are enumerations, not text. */
export function cleanOptions(input: unknown): RequestOptions {
  if (input === undefined || input === null) return { ...DEFAULT_REQUEST_OPTIONS, deliverables: [...DEFAULT_REQUEST_OPTIONS.deliverables], viewports: [...DEFAULT_REQUEST_OPTIONS.viewports] };
  if (typeof input !== "object" || Array.isArray(input)) throw bad("The options must be an object");
  const o = input as Record<string, unknown>;
  const known = ["targetMode", "gitMode", "deliverables", "viewports", "production"];
  const unknownKey = Object.keys(o).find((k) => !known.includes(k));
  if (unknownKey) throw bad(`Unknown option "${unknownKey.slice(0, 40)}". The options are ${known.join(", ")}`);
  const one = <T extends string>(v: unknown, what: string, allowed: readonly T[], fallback: T): T => {
    if (v === undefined) return fallback;
    if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw bad(`${what} must be one of ${allowed.join(", ")}`);
    return v as T;
  };
  const many = <T extends string>(v: unknown, what: string, allowed: readonly T[], fallback: readonly T[]): T[] => {
    if (v === undefined) return [...fallback];
    if (!Array.isArray(v) || v.length === 0 || v.length > allowed.length) throw bad(`${what} must be a list of at least one of ${allowed.join(", ")}`);
    if (!v.every((x) => typeof x === "string" && (allowed as readonly string[]).includes(x))) throw bad(`${what} can only hold ${allowed.join(", ")}`);
    return allowed.filter((a) => v.includes(a)); // each once, in a fixed order
  };
  if (o.production !== undefined && typeof o.production !== "boolean") throw bad("production must be true or false");
  const options: RequestOptions = {
    targetMode: one(o.targetMode, "targetMode", REQUEST_OPTIONS.targetModes, DEFAULT_REQUEST_OPTIONS.targetMode),
    gitMode: one(o.gitMode, "gitMode", REQUEST_OPTIONS.gitModes, DEFAULT_REQUEST_OPTIONS.gitMode),
    deliverables: many(o.deliverables, "deliverables", REQUEST_OPTIONS.deliverables, DEFAULT_REQUEST_OPTIONS.deliverables),
    viewports: many(o.viewports, "viewports", REQUEST_OPTIONS.viewports, DEFAULT_REQUEST_OPTIONS.viewports),
    production: o.production === true,
  };
  if (options.production && options.targetMode !== "observe_only") throw bad("A production target can only be read: choose observe_only");
  return options;
}

/** Choices that widen what an agent may do: acting on the target, or pushing and opening a pull request. With accounts on, only an admin of the project can ask for them. */
export const optionsNeedAdmin = (o: RequestOptions) => o.targetMode === "full" || o.gitMode === "pr";

/** An http(s) address with no password in it and nothing in its query that looks like one. Secrets do not belong in a request that an agent and a log will read. */
export function cleanTargetUrl(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) throw bad("A discover or run request needs the address to look at");
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
  /** Only in a list: the number of cases of a run request, counted by the database, so that a list does not have to carry their text. */
  case_count?: number;
}
export interface RerunTest { id: number; framework: string; file: string; title: string; fullName: string }
/** One test case of a run request, as it was when a person asked. Test case text only: never a spec's text, a requirement, an attachment or a screenshot. */
export interface RunCase {
  caseId: number; key: string; number: number; title: string; description: string; preconditions: string; priority: string;
  steps: { id: number; action: string; expected: string }[];
  automatedTests: { framework: string; file: string; fullName: string }[];
  specFiles: string[];
}

/**
 * `withCases` false is for a list: the cases of a run request carry the text of test cases (up to 1 MB), which an agent gets when it takes the request and a person sees on the
 * run's page, not in every list.
 */
export function viewOf(r: Row, withCases = true) {
  let tests: RerunTest[] = [];
  let cases: RunCase[] = [];
  let caseCount = r.case_count ?? 0;
  let options: RequestOptions | null = null;
  try {
    // A run request in a list is not parsed at all: its payload can be large, and the list only needs the count.
    if (withCases || r.kind !== "run") {
      const p = JSON.parse(r.payload) as { tests?: RerunTest[]; cases?: RunCase[]; options?: unknown };
      tests = p.tests ?? [];
      // Only a discover has options. One made before options existed has none stored, and reads as the defaults.
      if (r.kind === "discover") options = cleanOptions(p.options);
      if (r.case_count == null) caseCount = p.cases?.length ?? 0;
      if (withCases) cases = p.cases ?? [];
    }
  } catch { /* a payload that is not JSON: no tests or cases listed */ }
  return {
    id: r.id, projectId: r.project_id, kind: r.kind, targetUrl: r.target_url, environment: r.environment, note: r.note, runId: r.run_id, tests, cases, caseCount, options, status: r.status,
    createdBy: r.created_by, createdAt: r.created_at, claimedBy: r.claimed_by, claimedAt: r.claimed_at, finishedAt: r.finished_at, resultRunId: r.result_run_id, resultNote: r.result_note, resultDeliveredAt: r.result_delivered_at,
    releaseNote: r.release_note, releasedBy: r.released_by, releasedAt: r.released_at, resultAuditId: r.result_audit_id,
    // A run request: how far its run has come. An agent that takes it again after a release sees from this what is left.
    progress: r.kind === "run" && r.run_id !== null ? runProgress(r.run_id) : null,
  };
}
export type AgentRequest = ReturnType<typeof viewOf>;

/** For a run: how many of its test cases (those that still exist) have a result, whoever set it (the agent, or a person by hand), and how many have none yet. */
export function runProgress(runId: number): { total: number; reported: number; missing: number } {
  const r = db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'untested' THEN 1 ELSE 0 END), 0) AS missing FROM results WHERE run_id = ? AND case_id IS NOT NULL").get(runId) as { total: number; missing: number };
  return { total: r.total, reported: r.total - r.missing, missing: r.missing };
}

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
    .prepare(`SELECT *, json_array_length(payload, '$.cases') AS case_count FROM agent_requests WHERE project_id = ? ${status ? "AND status = ?" : ""} ORDER BY id DESC LIMIT ?`)
    .all(...(status ? [projectId, status, limit] : [projectId, limit])) as Row[];
  return withAudits(rows.map((r) => viewOf(r, false)));
}

/** What an agent asks for: the requests still waiting, oldest first. */
export function pendingForAgent(projectId: number) {
  // A run request whose run was deleted cannot be taken (it would have nothing to fill in): it stays for a person to cancel. A list carries the count of cases, and the cases
  // themselves come with the claim.
  return (db.prepare(`SELECT *, json_array_length(payload, '$.cases') AS case_count FROM agent_requests
      WHERE project_id = ? AND status = 'pending' AND NOT (kind = 'run' AND run_id IS NULL) ORDER BY id ASC LIMIT 50`).all(projectId) as Row[]).map((r) => viewOf(r, false));
}

/** The run request an agent was asked to run this run by (the newest one), for the run's page: its number, state and who took it. null for a run that was not asked of an agent. */
export function agentRequestOfRun(runId: number): { id: number; status: RequestStatus; claimedBy: string | null; progress: { total: number; reported: number; missing: number }; reportRunId?: number } | null {
  const r = db.prepare("SELECT id, status, claimed_by AS claimedBy, CASE WHEN result_delivered_at IS NOT NULL THEN result_run_id END AS reportRunId FROM agent_requests WHERE run_id = ? AND kind = 'run' ORDER BY id DESC LIMIT 1").get(runId) as
    { id: number; status: RequestStatus; claimedBy: string | null; reportRunId: number | null } | undefined;
  if (!r) return null;
  const { reportRunId, ...rest } = r;
  // reportRunId: the automated run that the agent's Playwright report made (left out until there is one), so that the page of the manual run can link to it.
  return { ...rest, progress: runProgress(runId), ...(reportRunId ? { reportRunId } : {}) };
}

export interface NewRequest { kind: unknown; targetUrl?: unknown; environment?: unknown; note?: unknown; runId?: unknown; caseIds?: unknown; title?: unknown; templateId?: unknown; options?: unknown }

/**
 * The test cases of a run request, as they are now: the text a person wrote (title, description, preconditions, steps), the names of the automated tests linked to the case and of
 * the specs linked to it. Never the text of a spec or of a requirement, an attachment or a screenshot. They come back in the order of the case list, which is the order of the run.
 */
function runCases(projectId: number, input: unknown): RunCase[] {
  const asked = Array.isArray(input) ? [...new Set(input)] : [];
  if (asked.length === 0) throw bad("A run request needs the test cases to run");
  if (!asked.every((x) => Number.isInteger(x))) throw bad("The test cases must be given by their ids");
  if (asked.length > REQUEST_LIMITS.runCasesMax) throw bad(`At most ${REQUEST_LIMITS.runCasesMax} test cases can be in one request. Pick fewer`);
  const rows = db.prepare(`
      SELECT c.id, c.number, c.title, c.description, c.preconditions, c.priority, c.status, p.key AS project_key
      FROM cases c JOIN projects p ON p.id = c.project_id
      WHERE c.project_id = ? AND c.id IN (SELECT value FROM json_each(?)) ORDER BY c.position, c.number`).all(projectId, JSON.stringify(asked)) as
    { id: number; number: number; title: string; description: string; preconditions: string; priority: string; status: string; project_key: string }[];
  if (rows.length !== asked.length) throw bad("Some of the test cases are not in this project");
  const deprecated = rows.filter((r) => r.status === "deprecated");
  if (deprecated.length) throw bad(`${deprecated.length} of the test cases ${deprecated.length === 1 ? "is" : "are"} deprecated and cannot be run: ${deprecated.slice(0, 5).map((r) => `${r.project_key}-${r.number}`).join(", ")}`);
  const steps = db.prepare("SELECT id, action, expected FROM case_steps WHERE case_id = ? ORDER BY position");
  const tests = db.prepare("SELECT framework, file, full_name AS fullName FROM automated_tests WHERE case_id = ? ORDER BY full_name LIMIT 50");
  const specs = db.prepare("SELECT file_name FROM specs WHERE case_id = ? ORDER BY file_name LIMIT 50");
  const cases = rows.map((r): RunCase => ({
    caseId: r.id, key: `${r.project_key}-${r.number}`, number: r.number, title: r.title, description: r.description, preconditions: r.preconditions, priority: r.priority,
    steps: steps.all(r.id) as RunCase["steps"], automatedTests: tests.all(r.id) as RunCase["automatedTests"], specFiles: (specs.all(r.id) as { file_name: string }[]).map((s) => s.file_name),
  }));
  if (Buffer.byteLength(JSON.stringify(cases)) > REQUEST_LIMITS.runPayloadBytes) throw bad("These test cases hold too much text for one request (more than 1 MB). Pick fewer");
  return cases;
}

/** `by.mayWiden` is false only for a person who is not an admin of the project, with accounts on (there are no roles without accounts). */
export function createRequest(projectId: number, input: NewRequest, by: { name: string; userId: number | null; mayWiden?: boolean }) {
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
  let options: RequestOptions | null = null;
  if (kind !== "discover" && input.options !== undefined && input.options !== null) throw bad("Options are only for a discover request, so far");
  if (kind === "discover") {
    targetUrl = cleanTargetUrl(input.targetUrl);
    options = cleanOptions(input.options);
    if (optionsNeedAdmin(options) && by.mayWiden === false) throw new AuditError(403, "Only an admin of the project can ask an agent to act on the target (full) or to open a pull request (pr)");
  } else if (kind === "run") {
    // The address is where the agent runs the cases; the run is made together with the request, in one transaction, so there is never a request without its run.
    targetUrl = cleanTargetUrl(input.targetUrl);
    const cases = runCases(projectId, input.caseIds);
    const title = text(input.title, "The run name", REQUEST_LIMITS.runTitleMax) || `Agent run · ${new Date().toISOString().slice(0, 10)}`;
    let templateId: number | null = null;
    if (input.templateId !== undefined && input.templateId !== null) {
      if (!Number.isInteger(input.templateId)) throw bad("The suite must be given by its id");
      if (!db.prepare("SELECT 1 FROM run_templates WHERE id = ? AND project_id = ?").get(input.templateId, projectId)) throw bad("The suite belongs to another project");
      templateId = input.templateId as number;
    }
    return db.transaction(() => {
      const run = createManualRun(projectId, { title, environment, caseIds: cases.map((c) => c.caseId), templateId });
      const row = db
        .prepare("INSERT INTO agent_requests (project_id, kind, target_url, environment, note, run_id, payload, created_by, created_by_user_id) VALUES (?, 'run', ?, ?, ?, ?, ?, ?, ?) RETURNING *")
        .get(projectId, targetUrl, environment, note, run.id, JSON.stringify({ runId: run.id, targetUrl, environment, note, cases }), by.name, by.userId) as Row;
      db.prepare("UPDATE runs SET meta = json_set(meta, '$.agentRequest', ?) WHERE id = ?").run(row.id, run.id); // the run says which request it was asked by
      return viewOf(row);
    })();
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
    .get(projectId, kind, targetUrl, environment, note, runId, JSON.stringify({ tests, ...(options ? { options } : {}) }), by.name, by.userId) as Row;
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
    .prepare(`UPDATE agent_requests SET status = 'claimed', claimed_by = ?, claimed_token_id = ?, claimed_at = datetime('now')
      WHERE id = ? AND project_id = ? AND status = 'pending' AND NOT (kind = 'run' AND run_id IS NULL) RETURNING *`)
    .get(`agent: ${token.name}`, token.id, id, projectId) as Row | undefined;
  if (r) return viewOf(r);
  const cur = mustRow(projectId, id);
  if (cur.status === "pending" && cur.kind === "run" && cur.run_id === null) throw new AuditError(409, "The run of this request was deleted, so there is nothing to run. A person can cancel the request");
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
  // A re-run that has its report is finished, not repeated. A run request may be given back after its Playwright report was handed in: test cases can still be left, and the report
  // stays (it is handed in once per request, so the next agent cannot hand in another).
  if (cur.kind !== "run" && cur.result_delivered_at) throw new AuditError(409, "A report was already handed in for this request. Finish it with complete instead");
  const r = db
    .prepare(`UPDATE agent_requests SET status = 'pending', claimed_by = NULL, claimed_token_id = NULL, claimed_at = NULL, release_note = ?, released_by = ?, released_at = datetime('now')
      WHERE id = ? AND project_id = ? AND status = 'claimed' AND claimed_token_id = ? AND (kind = 'run' OR result_delivered_at IS NULL) RETURNING *`)
    .get(note, `agent: ${token.name}`, id, projectId, token.id) as Row | undefined;
  if (!r) throw new AuditError(409, "The request changed while it was being given back");
  return viewOf(r);
}

/**
 * A run request whose test cases name automated tests or spec files has one step that only the skill can do: handing in the Playwright report (`result`). It stops being possible when the
 * request is done, and `done` is accepted as soon as every test case has a result, so an agent that never asked for the report would finish without it. TestBench does not block that
 * (a person may have told the agent not to run the tests, and can import the report by hand): the answer says it, so that the agent can tell the user.
 */
function missingReport(cur: Row): { warning?: string } {
  if (cur.kind !== "run" || cur.result_delivered_at) return {};
  const cases = viewOf(cur).cases;
  const tests = cases.reduce((n, c) => n + c.automatedTests.length, 0);
  const specs = cases.reduce((n, c) => n + c.specFiles.length, 0);
  if (!tests && !specs) return {};
  const names = [tests ? `${tests} automated test${tests === 1 ? "" : "s"}` : "", specs ? `${specs} spec file${specs === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
  return { warning: `No Playwright report was handed in, and this request names ${names}. A report can no longer be handed in now that the request is done. If you ran those tests, tell the user, who can import the report file under Import results. If you did not run them, ignore this.` };
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
  if (cur.kind === "run") {
    // A run request is finished when every test case that is still there has a result, whoever set it (the agent, or a person by hand). The run stays in progress: a person reviews it
    // and finishes it. TestBench links the run itself, so the agent cannot name another one.
    if (cur.claimed_token_id !== token.id) throw new AuditError(409, "Another token took this request");
    if (cur.run_id === null) throw new AuditError(409, "The run of this request was deleted, so there is nothing to finish. A person can cancel the request");
    if (input.resultRunId !== undefined && input.resultRunId !== null && input.resultRunId !== cur.run_id) throw bad("TestBench links the run of a run request itself. Leave resultRunId out");
    const p = runProgress(cur.run_id);
    if (p.missing > 0) throw new AuditError(409, `${p.missing} of ${p.total} test cases have no result yet. Report a result for each one, or give the request back with release`);
    resultRunId = cur.run_id;
  }
  const r = db
    .prepare("UPDATE agent_requests SET status = 'done', finished_at = datetime('now'), result_note = ?, result_run_id = COALESCE(result_run_id, ?), result_audit_id = ? WHERE id = ? AND project_id = ? AND status = 'claimed' AND claimed_token_id = ? RETURNING *")
    .get(note, resultRunId, resultAuditId, id, projectId, token.id) as Row | undefined;
  if (!r) throw new AuditError(409, "Another token took this request");
  return { ...viewOf(r), ...missingReport(cur) };
}

// ---------------- Handing in the report of a re-run ----------------

const RESULT_KEY = "agent_results_enabled";
export const agentResultsEnabled = () => getSetting(RESULT_KEY) === "1";
export const setAgentResultsEnabled = (on: boolean) => setSetting(RESULT_KEY, on ? "1" : "0");

/**
 * The agent that took a re-run or a run request hands in a Playwright report. Everything is checked before anything is written, and the run, the links, the "delivered" mark and the
 * audit entry are made in one transaction, so a refused report leaves no trace and two calls at once make one run.
 *  1. a person has switched agent results on (off by default)   2. the request is a re-run or a run request that this token took and that has not finished   3. nothing was delivered before
 *  4. for a run request: its run still exists   5. the report is Playwright JSON, not empty, and has at most RESULT_LIMITS.testsMax tests
 *  6. every test in it is one the request named, once (the whole report is refused otherwise, none is taken in part). A re-run names its failed tests. A run request names the tests linked
 *     to its test cases, and lets in every test in one of its spec files (also a test that TestBench does not know yet), so that a spec made in TestBench can get its first results.
 * Which case a test belongs to is decided here and never by the report (opts.resolveLink): a test that is already known keeps its case (a person's link, or an earlier one, or none), a
 * new test in a spec file of the request gets the case of that spec, and any other new test gets none. The title, the suite and the tags are not read for links, and `@REQ-n` links nothing.
 * The environment comes from the request, never from the report. Attachments are not read, and no other test of the project is touched. The run is a NEW automated run, marked source
 * `agent`, that carries the request in its meta; the manual run of a run request, and the results reported for it, are never touched. What the report says reaches a spec by its file
 * name, as for any import.
 */
export function submitResult(projectId: number, id: number, token: { id: number; name: string }, body: unknown, ip = "") {
  if (!agentResultsEnabled()) throw new AuditError(409, "Agent results are switched off. A person switches them on in Settings first");
  const cur = mustRow(projectId, id);
  if (cur.kind !== "rerun" && cur.kind !== "run") throw bad("Only a re-run or a run request takes a report");
  if (cur.status !== "claimed") throw new AuditError(409, cur.status === "pending" ? "Take the request first" : "The request is already done or cancelled");
  if (cur.claimed_token_id !== token.id) throw new AuditError(409, "Another token took this request");
  if (cur.result_delivered_at) throw new AuditError(409, "A report was already handed in for this request. Ask for a new request to try again");
  if (cur.kind === "run" && cur.run_id === null) throw new AuditError(409, "The run of this request was deleted, so there is nothing to attach a report to. A person can cancel the request");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("Send the Playwright JSON report as the request body (Content-Type: application/json)");
  let report;
  try {
    report = parseReport(JSON.stringify(body), "playwright");
  } catch (e) {
    throw bad((e as Error).message);
  }
  if (report.format !== "playwright-json") throw bad("Only a Playwright JSON report is taken");
  if (report.tests.length === 0) throw bad("The report has no tests");
  if (report.tests.length > RESULT_LIMITS.testsMax) throw bad(`The report holds ${report.tests.length} tests and at most ${RESULT_LIMITS.testsMax} are taken in one report. Send fewer tests`);

  // What the request names: the failed tests of a re-run; for a run request the automated tests linked to its test cases, and its spec files, each with the case it is linked to.
  const view = viewOf(cur);
  const named = new Set(view.tests.map((t) => `${t.framework}\u0000${t.fullName}`));
  const specCases: [string, number][] = [];
  for (const c of cur.kind === "run" ? view.cases : []) {
    for (const t of c.automatedTests) named.add(`${t.framework}\u0000${t.fullName}`);
    for (const f of c.specFiles) specCases.push([f, c.caseId]);
  }
  const caseOfSpecFile = (file: string): number | null => specCases.find(([name]) => fileMatchesSpec(file, name))?.[1] ?? null;
  const seen = new Set<string>();
  const strangers: string[] = [];
  for (const t of report.tests) {
    const key = `${report.framework}\u0000${t.fullName}`;
    if (!(named.has(key) || caseOfSpecFile(t.file) !== null) || seen.has(key)) strangers.push(t.fullName);
    seen.add(key);
  }
  if (strangers.length) {
    const what = cur.kind === "run" ? "did not name (a test linked to one of its test cases, or a test in one of its spec files)" : "did not name";
    throw bad(`The report holds ${strangers.length} test(s) that this request ${what} or that appear twice, so none of it was taken. First: ${strangers.slice(0, 3).join("; ").slice(0, 300)}`);
  }

  // The link is TestBench's to decide: a test that is known keeps its case (also none), a new one in a spec file of the request gets that spec's case, any other gets none.
  const known = db.prepare("SELECT case_id FROM automated_tests WHERE project_id = ? AND framework = ? AND full_name = ?");
  let newTests = 0;
  const resolveLink = (t: ParsedTest): number | null => {
    const row = known.get(projectId, report.framework, t.fullName) as { case_id: number | null } | undefined;
    if (row) return row.case_id;
    newTests++;
    return cur.kind === "run" ? caseOfSpecFile(t.file) : null;
  };

  const isRun = cur.kind === "run";
  // The same shape as a manual re-run keeps (meta.rerunOf = { id, title }), so the run page shows "Re-run of ..." for both; a run request's report says which run it belongs to.
  const original = cur.run_id ? (db.prepare("SELECT id, title FROM runs WHERE id = ? AND project_id = ?").get(cur.run_id, projectId) as { id: number; title: string } | undefined) : undefined;
  return db.transaction(() => {
    const res = importReport(report, {
      projectId, source: "agent", environment: cur.environment, relinkOthers: false, resolveLink,
      title: isRun ? `Automated tests of run #${cur.run_id} (request #${cur.id})` : `Re-run of run #${cur.run_id ?? "?"} (request #${cur.id})`,
      meta: { agentRequest: cur.id, ...(original ? (isRun ? { runOf: original } : { rerunOf: original }) : {}), deliveredBy: token.name },
    });
    const marked = db.prepare("UPDATE agent_requests SET result_run_id = ?, result_delivered_at = datetime('now') WHERE id = ? AND project_id = ? AND status = 'claimed' AND claimed_token_id = ? AND result_delivered_at IS NULL").run(res.runId, id, projectId, token.id);
    if (!marked.changes) throw new AuditError(409, "The request changed while the report was being taken");
    const count = (status: string) => report.tests.filter((t) => t.status === status).length;
    audit({ userId: null, label: `agent: ${token.name}`, ip }, "agent_request.result_delivered", {
      projectId, detail: { request: id, kind: cur.kind, run: cur.run_id, result_run: res.runId, credential_id: token.id, tests: res.total, new_tests: newTests, linked: res.linked, passed: count("passed"), failed: count("failed"), skipped: count("skipped") },
    });
    return { runId: res.runId, total: res.total, linked: res.linked, request: viewOf(rowOf(id)!) };
  })();
}
