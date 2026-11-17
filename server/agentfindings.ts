import { z } from "zod";
import { db } from "./db.ts";
import { AuditError, hashOf } from "./auditcommon.ts";
import { audit } from "./accounts.ts";
import { MANUAL_CATEGORIES } from "./importers/auditpackage.ts";
import { PRIORITIES } from "./shapes.ts";

/**
 * Findings from a test agent (AG-B): while an agent works on a discover request it took, it can hand in what it found, one finding at a time. A finding is only ever a
 * proposal for a person to review; nothing here approves, accepts, edits or deletes anything, and nothing touches a spec or an account.
 *
 *  - Only the request token that took the request, only while the request is `claimed`, and only for a discover (a re-run delivers its report through `result`).
 *    Anything else is refused before anything is written: 404 (no such request in the project) or 409 (not a discover, not taken, finished, taken by another token, or full).
 *  - One request can make at most FINDING_LIMITS.perRequest findings, counted on the request itself (findings_count), inside the same transaction as the finding.
 *  - test_case -> a `draft` case marked with the token that made it (cases.created_by_agent_token_id) and the tag `agent-proposed`, in no folder.
 *    bug_report and manual_test_suggestion -> `proposed`. observation -> kind `exploratory`, status `observed`. None of them has an audit; their origin is `$agent-<request>`
 *    and their own number inside the request is `$agent-<request>-<n>`.
 *  - Everything happens in one transaction, audit entry included, so a refused finding leaves no trace. The audit entry names the agent (`agent: <token name>`, like the
 *    other request-token entries) and the token's id (`credential_id`), never the token or its hash.
 */

export const FINDING_LIMITS = { perRequest: 200, perMinute: 60, bodyBytes: 256 * 1024 };
export const FINDING_KINDS = ["test_case", "bug_report", "observation", "manual_test_suggestion"] as const;

const text = (max: number) => z.string().max(max).default("");
const title = z.string().trim().min(1).max(300);
const steps = z.array(z.string().max(1000)).max(50).default([]);

/** The body of a finding. Strict: a field that is not listed (a status, a reviewer, an approval) is refused, never ignored. */
export const findingBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("test_case"), title, description: text(5000), preconditions: text(2000), priority: z.enum(PRIORITIES).default("medium"),
    steps: z.array(z.object({ action: z.string().max(1000), expected: z.string().max(1000).default("") }).strict()).max(50).default([]),
  }).strict(),
  z.object({
    kind: z.literal("bug_report"), title, description: text(5000), steps, expected: text(2000), actual: text(2000), environment: text(200), url: text(2000),
    severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  }).strict(),
  z.object({
    kind: z.literal("observation"), title, severity: z.enum(["info", "low", "medium", "high", "critical"]).default("info"),
    evidence: text(4000), recommendation: text(4000), source: text(300),
  }).strict(),
  z.object({
    kind: z.literal("manual_test_suggestion"), title, description: text(5000), preconditions: text(2000), steps, expected: text(2000),
    priority: z.enum(PRIORITIES).default("medium"), category: z.enum(MANUAL_CATEGORIES).default("functional"),
  }).strict(),
]);
export type Finding = z.infer<typeof findingBody>;

interface RequestRow { id: number; kind: string; status: string; claimed_token_id: number | null; findings_count: number }

/**
 * Makes one proposal from a finding of a discover request this token took. Returns what was made. `token` is the request token (id and name) that authenticated the call.
 */
export function createFinding(projectId: number, requestId: number, token: { id: number; name: string }, ip: string, f: Finding) {
  return db.transaction(() => {
    const r = db.prepare("SELECT id, kind, status, claimed_token_id, findings_count FROM agent_requests WHERE id = ? AND project_id = ?").get(requestId, projectId) as RequestRow | undefined;
    if (!r) throw new AuditError(404, "Request not found");
    if (r.kind !== "discover") throw new AuditError(409, "Findings can only be made for a discover request. A re-run hands in its report with the result route, and a run reports a result for each test case");
    if (r.status === "pending") throw new AuditError(409, "The request is not taken. Take it first");
    if (r.status !== "claimed") throw new AuditError(409, "The request is already done or cancelled");
    if (r.claimed_token_id !== token.id) throw new AuditError(409, "Another token took this request");
    if (r.findings_count >= FINDING_LIMITS.perRequest) throw new AuditError(409, `This request already has ${FINDING_LIMITS.perRequest} findings, the most one request can make`);

    const n = r.findings_count + 1;
    const bumped = db.prepare("UPDATE agent_requests SET findings_count = findings_count + 1 WHERE id = ? AND status = 'claimed' AND claimed_token_id = ? AND findings_count < ?")
      .run(requestId, token.id, FINDING_LIMITS.perRequest);
    if (!bumped.changes) throw new AuditError(409, "The request changed while the finding was being made");
    const origin = `$agent-${requestId}`;
    const sourceId = `${origin}-${n}`;

    let made: { id: number; number?: number };
    if (f.kind === "test_case") {
      const num = (db.prepare("UPDATE projects SET next_case_number = next_case_number + 1 WHERE id = ? RETURNING next_case_number - 1 AS n").get(projectId) as { n: number }).n;
      const pos = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM cases WHERE project_id = ?").get(projectId) as { p: number }).p;
      const id = (db.prepare(`INSERT INTO cases (project_id, suite_id, number, title, description, preconditions, priority, status, tags, position, created_by_agent_token_id)
          VALUES (?, NULL, ?, ?, ?, ?, ?, 'draft', ?, ?, ?) RETURNING id`)
        .get(projectId, num, f.title, f.description, f.preconditions, f.priority, JSON.stringify(["agent-proposed"]), pos, token.id) as { id: number }).id;
      f.steps.forEach((s, i) => db.prepare("INSERT INTO case_steps (case_id, position, action, expected) VALUES (?, ?, ?, ?)").run(id, i, s.action, s.expected));
      made = { id, number: num };
    } else if (f.kind === "bug_report") {
      const id = (db.prepare(`INSERT INTO bug_reports (project_id, audit_id, origin_audit_id, origin, source_id, title, description, steps, expected, actual, environment, url, agent_severity, source)
          VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent_audit') RETURNING id`)
        .get(projectId, origin, JSON.stringify({ agentRequest: requestId, n }), sourceId, f.title, f.description, JSON.stringify(f.steps), f.expected, f.actual, f.environment, f.url, f.severity ?? null) as { id: number }).id;
      const payload = {
        title: f.title, description: f.description, steps: f.steps, expected: f.expected, actual: f.actual, environment: f.environment, url: f.url, toolImpact: null, agentSeverity: f.severity ?? null,
        confidence: null, foundAt: null, agentReview: null, fingerprint: "", recurrenceOf: "", refs: { requirements: [], cases: [], tests: [] }, evidence: [],
      };
      db.prepare("INSERT INTO bug_revisions (bug_report_id, rev, payload, content_hash) VALUES (?, 1, ?, ?)").run(id, JSON.stringify(payload), hashOf(payload));
      made = { id };
    } else if (f.kind === "observation") {
      const { kind: _kind, ...content } = f;
      const id = (db.prepare(`INSERT INTO observations (project_id, number, source_id, audit_id, origin_audit_id, kind, title, severity, status, evidence, recommendation, source, content_hash)
          VALUES (?, (SELECT COALESCE(MAX(number), 0) + 1 FROM observations WHERE project_id = ?), ?, NULL, ?, 'exploratory', ?, ?, 'observed', ?, ?, ?, ?) RETURNING id`)
        .get(projectId, projectId, sourceId, origin, f.title, f.severity, f.evidence, f.recommendation, f.source, hashOf(content)) as { id: number }).id;
      made = { id };
    } else {
      const id = (db.prepare(`INSERT INTO manual_tests (project_id, audit_id, origin_audit_id, origin, source_id, title, description, preconditions, steps, expected, category, wcag, viewports, agent_priority)
          VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?) RETURNING id`)
        .get(projectId, origin, JSON.stringify({ agentRequest: requestId, n }), sourceId, f.title, f.description, f.preconditions, JSON.stringify(f.steps), f.expected, f.category, f.priority) as { id: number }).id;
      const payload = { title: f.title, description: f.description, preconditions: f.preconditions, steps: f.steps, expected: f.expected, priority: f.priority, category: f.category, wcag: [], viewports: [], refs: { requirements: [], cases: [], tests: [] } };
      db.prepare("INSERT INTO manual_test_revisions (manual_test_id, rev, payload, content_hash) VALUES (?, 1, ?, ?)").run(id, JSON.stringify(payload), hashOf(payload));
      made = { id };
    }

    audit({ userId: null, label: `agent: ${token.name}`, ip }, "agent_request.finding_created", { projectId, detail: { request: requestId, kind: r.kind, finding_kind: f.kind, id: made.id, n, credential_id: token.id } });
    return { kind: f.kind, ...made, sourceId, findingsOnRequest: n };
  })();
}
