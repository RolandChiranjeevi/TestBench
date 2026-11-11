import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { db, parseJson } from "./db.ts";
import { AuditError, toSqlDate } from "./auditcommon.ts";

/**
 * CI results as bug history.
 *
 *  - A CI bug is keyed by the test's stable testKey: origin_audit_id is '$ci' (no audit package id can contain a $) and source_id is the key,
 *    so the unique index on bug_reports gives one bug per test and project, whatever the branch or the run.
 *  - A failed test makes a bug the first time and adds an occurrence every time after. A flaky test is marked flaky and starts at low severity.
 *  - A test that goes green never closes a bug. When no branch is failing any more the bug is only marked resolved_suspected; a person closes it.
 *  - A failure after resolved_suspected, or after a person closed the bug, puts it back to open. Rejected and duplicate bugs only collect occurrences.
 *  - Sending the same runId again changes nothing; sending it with other content is refused.
 *  - Only failed and flaky results are kept, and passes of tests that already have a CI bug. The rest of a run is counted, not stored.
 */

export const CI_ORIGIN = "$ci";
export const WORKFLOW_STATUSES = ["open", "resolved_suspected", "closed"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export const BUG_SOURCES = ["ci", "agent_audit", "manual"] as const;

/** `drainBytes`: an oversized request up to this size is read and thrown away before it is answered 413; a larger one is disconnected at once. */
export const CI_LIMITS = { bodyBytes: 5 * 1024 * 1024, drainBytes: 64 * 1024 * 1024, results: 5000, error: 8000, step: 500, steps: 100, attachments: 20, tags: 20, tokensPerProject: 20 };

// ---------- Hiding secrets ----------

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]"],
  [/\btb(?:ci|ag)_[A-Za-z0-9_-]{20,}\b/g, "[redacted]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted]"],
  [/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[redacted]@"],
  [/(\b[\w-]*(?:password|passwd|secret|token|api[_-]?key|authorization)[\w-]*\s*[=:]\s*)(?:Bearer\s+)?("[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1[redacted]"],
];

/** Masks things that look like credentials. A failing test's output is free text and can hold whatever the test printed. */
export function redact(text: string): string {
  let out = text;
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

/** An http(s) link without credentials, query string or fragment (those can carry signed tokens). */
function cleanUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    u.username = ""; u.password = ""; u.search = ""; u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * The one route that CI calls. It is exempt from the browser guards (the login cookie and the X-Testbench header) and is instead
 * always authenticated by an API token in the Authorization header, whether or not a password is set.
 */
export const isCiIngest = (method: string, url: string) => method === "POST" && /^\/api\/projects\/\d+\/ci\/test-results\/?(\?.*)?$/.test(url);

// ---------- Tokens ----------

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function createCiToken(projectId: number, name: string) {
  const n = name.trim();
  if (!n || n.length > 80) throw new AuditError(400, "Give the token a name of at most 80 characters");
  const live = (db.prepare("SELECT COUNT(*) AS n FROM ci_tokens WHERE project_id = ? AND revoked_at IS NULL").get(projectId) as { n: number }).n;
  if (live >= CI_LIMITS.tokensPerProject) throw new AuditError(409, `A project can have ${CI_LIMITS.tokensPerProject} active tokens. Revoke one first.`);
  const token = `tbci_${randomBytes(32).toString("base64url")}`;
  const row = db.prepare("INSERT INTO ci_tokens (project_id, name, prefix, token_hash) VALUES (?, ?, ?, ?) RETURNING id, created_at")
    .get(projectId, n, token.slice(0, 9), sha256(token)) as { id: number; created_at: string };
  // The token is returned this once. Only its hash is stored.
  return { id: row.id, name: n, prefix: token.slice(0, 9), createdAt: row.created_at, token };
}

export function listCiTokens(projectId: number) {
  return (db.prepare("SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM ci_tokens WHERE project_id = ? ORDER BY id DESC").all(projectId) as Record<string, any>[])
    .map((t) => ({ id: t.id, name: t.name, prefix: t.prefix, createdAt: t.created_at, lastUsedAt: t.last_used_at, revokedAt: t.revoked_at }));
}

export function revokeCiToken(id: number) {
  const r = db.prepare("UPDATE ci_tokens SET revoked_at = COALESCE(revoked_at, datetime('now')) WHERE id = ?").run(id);
  if (!r.changes) throw new AuditError(404, "Token not found");
}

/** True when the Authorization header carries a live token that belongs to this project. */
export function authenticateCiToken(header: string | undefined, projectId: number): boolean {
  const m = /^Bearer\s+(\S{1,200})$/i.exec(header ?? "");
  if (!m) return false;
  const row = db.prepare("SELECT id, project_id FROM ci_tokens WHERE token_hash = ? AND revoked_at IS NULL").get(sha256(m[1])) as { id: number; project_id: number } | undefined;
  if (!row || row.project_id !== projectId) return false;
  db.prepare("UPDATE ci_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  return true;
}

// ---------- The payload ----------

const text = (max: number) => z.string().max(max);
const isoTime = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "not a date and time such as 2026-11-04T07:00:00Z");
const link = z.string().max(2000).refine((s) => cleanUrl(s) !== null, "not an http(s) link");

const attachmentSchema = z.object({ name: text(200).min(1), url: link, type: text(40).optional() });
const resultSchema = z.object({
  // Any printable text: a test's key is usually its file and title path. Control characters are refused.
  testKey: z.string().min(1).max(300).regex(/^[^\u0000-\u001f\u007f]+$/, "must not contain control characters"),
  title: text(500).min(1),
  status: z.enum(["passed", "failed", "skipped", "flaky"]),
  durationMs: z.number().int().min(0).max(86_400_000 * 7).optional(),
  // A passed test often has no error, and some reporters send null for that. Both mean "no error".
  error: text(200_000).nullish(),
  steps: z.array(text(2000)).max(CI_LIMITS.steps).optional(),
  attachments: z.array(attachmentSchema).max(CI_LIMITS.attachments).optional(),
  tags: z.array(text(50).min(1)).max(CI_LIMITS.tags).optional(),
});
export const ciPayloadSchema = z.object({
  runId: z.string().min(1).max(200).regex(/^[\w.:\-/]+$/, "use letters, digits and . _ : - /"),
  commitSha: text(80).default(""),
  branch: text(250).default(""),
  repository: text(200).default(""),
  pipelineUrl: link.optional(),
  startedAt: isoTime.optional(),
  finishedAt: isoTime.optional(),
  results: z.array(resultSchema).max(CI_LIMITS.results),
});
export type CiPayload = z.infer<typeof ciPayloadSchema>;

type CiStatus = "passed" | "failed" | "flaky";

interface BugRow {
  id: number; review_status: string; workflow_status: WorkflowStatus; edited_at: string | null; tags: string;
}

export interface IngestSummary {
  runId: string;
  replayed: boolean;
  counts: { passed: number; failed: number; flaky: number; skipped: number };
  bugsCreated: number;
  bugsUpdated: number;
  reopened: number;
  resolvedSuspected: number;
  /** `already_processed` only on a replay: the run had been received before and nothing was changed. */
  bugs: { testKey: string; bugId: number; action: "created" | "updated" | "reopened" | "resolved_suspected" | "recorded" | "already_processed" }[];
}

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])].slice(0, 50);
const shortSha = (s: string) => s.slice(0, 8);

export function addEvent(bugId: number, actor: "ci" | "user", kind: string, detail: string) {
  db.prepare("INSERT INTO bug_events (bug_report_id, actor, kind, detail) VALUES (?, ?, ?, ?)").run(bugId, actor, kind, detail);
}

/** For each branch the latest kept result of the test: the places where it is still failing. */
function failingBranches(projectId: number, testKey: string): string[] {
  return (db.prepare(`
    SELECT r.branch AS branch, x.status AS status FROM ci_results x JOIN ci_runs r ON r.id = x.ci_run_id
    WHERE x.project_id = ? AND x.test_key = ? AND x.id = (
      SELECT MAX(y.id) FROM ci_results y JOIN ci_runs q ON q.id = y.ci_run_id WHERE y.project_id = x.project_id AND y.test_key = x.test_key AND q.branch = r.branch)`)
    .all(projectId, testKey) as { branch: string; status: string }[]).filter((r) => r.status !== "passed").map((r) => r.branch);
}

export function ingestCiResults(projectId: number, input: unknown): IngestSummary {
  const parsed = ciPayloadSchema.safeParse(input);
  if (!parsed.success) throw new AuditError(400, parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  const p = parsed.data;
  const seen = new Set<string>();
  const dup = p.results.find((r) => (seen.has(r.testKey) ? true : (seen.add(r.testKey), false)));
  if (dup) throw new AuditError(400, `testKey "${dup.testKey}" appears more than once in the run. Send one result per test (the worst of its retries).`);

  const branch = p.branch.replace(/^refs\/heads\//, "");
  const hash = sha256(JSON.stringify(p));
  const earlier = db.prepare("SELECT payload_hash, summary FROM ci_runs WHERE project_id = ? AND run_id = ?").get(projectId, p.runId) as { payload_hash: string; summary: string } | undefined;
  if (earlier) {
    if (earlier.payload_hash !== hash) throw new AuditError(409, `Run ${p.runId} was received before with other content. Use a new runId for a new run or a re-run.`);
    // Nothing was done this time: the counts of what the run contained stay, but nothing is reported as created, updated or reopened.
    const before = parseJson<IngestSummary>(earlier.summary, { counts: { passed: 0, failed: 0, flaky: 0, skipped: 0 }, bugs: [] } as unknown as IngestSummary);
    return {
      runId: p.runId, replayed: true, counts: before.counts, bugsCreated: 0, bugsUpdated: 0, reopened: 0, resolvedSuspected: 0,
      bugs: before.bugs.map((b) => ({ testKey: b.testKey, bugId: b.bugId, action: "already_processed" as const })),
    };
  }

  return db.transaction((): IngestSummary => {
    const pipelineUrl = p.pipelineUrl ? cleanUrl(p.pipelineUrl) ?? "" : "";
    const run = db.prepare(`INSERT INTO ci_runs (project_id, run_id, commit_sha, branch, repository, pipeline_url, started_at, finished_at, payload_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .get(projectId, p.runId, p.commitSha, branch, p.repository, pipelineUrl, toSqlDate(p.startedAt), toSqlDate(p.finishedAt), hash) as { id: number };
    const where = `${shortSha(p.commitSha) || "unknown commit"} on ${branch || "unknown branch"}`;
    const counts = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
    const summary: IngestSummary = { runId: p.runId, replayed: false, counts, bugsCreated: 0, bugsUpdated: 0, reopened: 0, resolvedSuspected: 0, bugs: [] };
    const found = toSqlDate(p.finishedAt) ?? toSqlDate(p.startedAt);

    for (const r of p.results) {
      counts[r.status]++;
      if (r.status === "skipped") continue;
      const bug = db.prepare("SELECT id, review_status, workflow_status, edited_at, tags FROM bug_reports WHERE project_id = ? AND origin_audit_id = ? AND source_id = ?")
        .get(projectId, CI_ORIGIN, r.testKey) as BugRow | undefined;
      if (r.status === "passed" && !bug) continue;

      const error = redact(r.error ?? "").slice(0, CI_LIMITS.error);
      const steps = (r.steps ?? []).map((s) => redact(s).slice(0, CI_LIMITS.step));
      const attachments = (r.attachments ?? []).map((a) => ({ name: redact(a.name), url: cleanUrl(a.url)!, type: a.type ?? "" }));
      const tags = [...new Set((r.tags ?? []).map((t) => t.trim()).filter(Boolean))];
      const status = r.status as CiStatus;
      const ciResultId = (db.prepare(`INSERT INTO ci_results (ci_run_id, project_id, test_key, title, status, duration_ms, error, steps, attachments, tags)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
        .get(run.id, projectId, r.testKey, r.title, status, r.durationMs ?? null, error, JSON.stringify(steps), JSON.stringify(attachments), JSON.stringify(tags)) as { id: number }).id;

      if (status === "passed") {
        db.prepare("UPDATE bug_reports SET last_ci_status = 'passed', last_ci_at = datetime('now') WHERE id = ?").run(bug!.id);
        // Only a bug that is open and still wanted can become resolved_suspected, and only when no branch is failing any more.
        if (bug!.workflow_status === "open" && (bug!.review_status === "proposed" || bug!.review_status === "accepted") && failingBranches(projectId, r.testKey).length === 0) {
          db.prepare("UPDATE bug_reports SET workflow_status = 'resolved_suspected', resolved_suspected_at = datetime('now') WHERE id = ?").run(bug!.id);
          addEvent(bug!.id, "ci", "resolved_suspected", `Passed on ${where} and no branch is failing any more. Check it and close the bug if it is fixed.`);
          summary.resolvedSuspected++;
          summary.bugs.push({ testKey: r.testKey, bugId: bug!.id, action: "resolved_suspected" });
        } else summary.bugs.push({ testKey: r.testKey, bugId: bug!.id, action: "recorded" });
        continue;
      }

      let bugId: number;
      let action: IngestSummary["bugs"][number]["action"];
      if (!bug) {
        bugId = (db.prepare(`INSERT INTO bug_reports (project_id, audit_id, origin_audit_id, origin, source_id, title, steps, actual, environment, agent_severity, found_at,
              source, test_key, tags, workflow_status, last_ci_status, last_ci_at, ci_flaky)
            VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ci', ?, ?, 'open', ?, datetime('now'), ?) RETURNING id`)
          .get(projectId, CI_ORIGIN, JSON.stringify({ source: "ci", repository: p.repository, branch, commit: p.commitSha, runId: p.runId, pipelineUrl }), r.testKey, r.title,
            JSON.stringify(steps), error, [p.repository, branch].filter(Boolean).join(" · "),
            // CI never decides how serious a bug is. A flaky test starts low so that it does not crowd out real failures.
            status === "flaky" ? "low" : "medium", found, r.testKey, JSON.stringify(tags), status, status === "flaky" ? 1 : 0) as { id: number }).id;
        addEvent(bugId, "ci", "created", `${status === "flaky" ? "Flaky" : "Failed"} on ${where}`);
        summary.bugsCreated++;
        action = "created";
      } else {
        bugId = bug.id;
        const sets = ["last_ci_status = ?", "last_ci_at = datetime('now')", "ci_flaky = ?", "tags = ?"];
        const args: unknown[] = [status, status === "flaky" ? 1 : 0, JSON.stringify(union(parseJson<string[]>(bug.tags, []), tags))];
        // What a person has edited stays; otherwise the bug shows the latest failure.
        if (!bug.edited_at) { sets.push("title = ?", "actual = ?", "steps = ?"); args.push(r.title, error, JSON.stringify(steps)); }
        action = "updated";
        const wanted = bug.review_status === "proposed" || bug.review_status === "accepted";
        const reopens = wanted && ((status === "failed" && bug.workflow_status !== "open") || (status === "flaky" && bug.workflow_status === "resolved_suspected"));
        if (reopens) {
          sets.push("workflow_status = 'open'", "resolved_suspected_at = NULL", "closed_at = NULL");
          addEvent(bug.id, "ci", "reopened", `${status === "flaky" ? "Flaky" : "Failed"} again on ${where} after it was ${bug.workflow_status === "closed" ? "closed" : "marked resolved_suspected"}`);
          summary.reopened++;
          action = "reopened";
        } else summary.bugsUpdated++;
        db.prepare(`UPDATE bug_reports SET ${sets.join(", ")} WHERE id = ?`).run(...args, bug.id);
      }
      db.prepare("INSERT INTO bug_occurrences (bug_report_id, ci_result_id) VALUES (?, ?)").run(bugId, ciResultId);
      summary.bugs.push({ testKey: r.testKey, bugId, action });
    }

    db.prepare("UPDATE ci_runs SET counts = ?, summary = ? WHERE id = ?").run(JSON.stringify(counts), JSON.stringify(summary), run.id);
    return summary;
  })();
}

// ---------- Reading ----------

interface HistoryRow {
  id: number; status: CiStatus; error: string; duration_ms: number | null; attachments: string; steps: string;
  run_id: string; commit_sha: string; branch: string; repository: string; pipeline_url: string; received_at: string; finished_at: string | null;
}
const historyItem = (r: HistoryRow) => ({
  id: r.id, status: r.status, error: r.error, durationMs: r.duration_ms, steps: parseJson<string[]>(r.steps, []),
  attachments: parseJson<{ name: string; url: string; type: string }[]>(r.attachments, []),
  runId: r.run_id, commit: r.commit_sha, branch: r.branch, repository: r.repository, pipelineUrl: r.pipeline_url, at: r.finished_at ?? r.received_at,
});

/** What CI has said about a bug's test. Null for a bug without a test key. */
export function ciDetail(b: { id: number; project_id: number; test_key: string | null; last_ci_status: string | null; last_ci_at: string | null; ci_flaky: number }) {
  if (!b.test_key) return null;
  const rows = db.prepare(`
    SELECT x.id, x.status, x.error, x.duration_ms, x.attachments, x.steps, r.run_id, r.commit_sha, r.branch, r.repository, r.pipeline_url, r.received_at, r.finished_at
    FROM ci_results x JOIN ci_runs r ON r.id = x.ci_run_id WHERE x.project_id = ? AND x.test_key = ? ORDER BY x.id DESC LIMIT 100`).all(b.project_id, b.test_key) as HistoryRow[];
  const history = rows.map(historyItem);
  const n = (status: string) => (db.prepare("SELECT COUNT(*) AS n FROM bug_occurrences o JOIN ci_results x ON x.id = o.ci_result_id WHERE o.bug_report_id = ? AND x.status = ?").get(b.id, status) as { n: number }).n;
  const branches: ReturnType<typeof historyItem>[] = [];
  for (const h of history) if (!branches.some((x) => x.branch === h.branch)) branches.push(h);
  return {
    testKey: b.test_key, lastStatus: b.last_ci_status as CiStatus | null, lastAt: b.last_ci_at, flaky: !!b.ci_flaky,
    failedRuns: n("failed"), flakyRuns: n("flaky"),
    branches: branches.map((h) => ({ branch: h.branch, status: h.status, commit: h.commit, pipelineUrl: h.pipelineUrl, at: h.at })),
    lastFailure: history.find((h) => h.status !== "passed") ?? null,
    history,
  };
}

export const bugEvents = (bugId: number) =>
  (db.prepare("SELECT at, actor, kind, detail FROM bug_events WHERE bug_report_id = ? ORDER BY id DESC LIMIT 100").all(bugId) as { at: string; actor: string; kind: string; detail: string }[]);

// ---------- A person changes the workflow ----------

/** Assignee and workflow status are a person's triage. They are not an edit of the report's text and so do not stop later imports from updating it. */
export function setTriage(id: number, patch: { assignee?: string; workflowStatus?: WorkflowStatus }) {
  const b = db.prepare("SELECT id, workflow_status, assignee FROM bug_reports WHERE id = ?").get(id) as { id: number; workflow_status: WorkflowStatus; assignee: string } | undefined;
  if (!b) throw new AuditError(404, "Bug report not found");
  if (patch.assignee === undefined && patch.workflowStatus === undefined) throw new AuditError(400, "Nothing to change");
  db.transaction(() => {
    if (patch.assignee !== undefined && patch.assignee.trim() !== b.assignee) {
      const a = patch.assignee.trim();
      db.prepare("UPDATE bug_reports SET assignee = ? WHERE id = ?").run(a, id);
      addEvent(id, "user", "assignee", a ? `Assigned to ${a}` : "Unassigned");
    }
    if (patch.workflowStatus !== undefined && patch.workflowStatus !== b.workflow_status) {
      db.prepare(`UPDATE bug_reports SET workflow_status = ?,
          resolved_suspected_at = CASE WHEN ? = 'resolved_suspected' THEN datetime('now') ELSE NULL END,
          closed_at = CASE WHEN ? = 'closed' THEN datetime('now') ELSE NULL END WHERE id = ?`).run(patch.workflowStatus, patch.workflowStatus, patch.workflowStatus, id);
      addEvent(id, "user", "workflow", `${b.workflow_status} → ${patch.workflowStatus}`);
    }
  })();
}
