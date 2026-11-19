import { z } from "zod";
import { db } from "./db.ts";
import { AuditError, hashOf } from "./auditcommon.ts";
import { audit } from "./accounts.ts";
import { addGapByAgent, addPlanItemByAgent, agentPlanCounts, planItemRowId } from "./auditplan.ts";
import { MANUAL_CATEGORIES, PLAN_READINESS } from "./importers/auditpackage.ts";
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
 *  - plan_item and coverage_gap make the request's PLAN: a plan item (what is to be tested) or a coverage gap (what was not verified), as proposals in the same tables a package's
 *    test-plan.json fills (server/auditplan.ts), so a person owns one by editing or deciding it. They need an audit, so the first one makes it: `$agent-<request>`, source `request`,
 *    linked from the request (result_audit_id). They have caps of their own (PLAN_LIMITS) and do not count towards the 200 findings. Their numbers are P-1 ... and GAP-1 ...
 *  - A test_case may name `planItem` (the P-n it was given): the case is then linked to that plan item (cases.plan_item_id). Only a plan item of this request's own plan.
 *  - Everything happens in one transaction, audit entry included, so a refused finding leaves no trace. The audit entry names the agent (`agent: <token name>`, like the
 *    other request-token entries) and the token's id (`credential_id`), never the token or its hash.
 */

export const FINDING_LIMITS = { perRequest: 200, perMinute: 60, bodyBytes: 256 * 1024 };
/** The plan of one request: at most this many plan items and coverage gaps, counted apart from the findings. */
export const PLAN_LIMITS = { planItems: 100, coverageGaps: 50 };
export const FINDING_KINDS = ["test_case", "bug_report", "observation", "manual_test_suggestion", "plan_item", "coverage_gap"] as const;

const text = (max: number) => z.string().max(max).default("");
const title = z.string().trim().min(1).max(300);
const steps = z.array(z.string().max(1000)).max(50).default([]);

/** The body of a finding. Strict: a field that is not listed (a status, a reviewer, an approval) is refused, never ignored. */
export const findingBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("test_case"), title, description: text(5000), preconditions: text(2000), priority: z.enum(PRIORITIES).default("medium"),
    steps: z.array(z.object({ action: z.string().max(1000), expected: z.string().max(1000).default("") }).strict()).max(50).default([]),
    // The P-n of a plan item this request made: the case is linked to it. Anything else is refused.
    planItem: z.string().trim().min(1).max(50).optional(),
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
  // One planned check. The same fields and limits as a plan item of an audit package (test-plan.json); `requirements` are kept as written (REQ-3) and matched against the project's own
  // when they are shown. It is a plan, not a test case: nothing here says that the check was run.
  z.object({
    kind: z.literal("plan_item"), title: z.string().trim().min(1).max(200), type: text(50), risk: text(200), priority: z.enum(PRIORITIES).optional(), readiness: z.enum(PLAN_READINESS).optional(),
    preconditions: text(5000), testData: text(2000), steps, acceptanceCriteria: text(5000), automation: text(200), requirements: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  }).strict(),
  // Something the agent did not verify, and why.
  z.object({ kind: z.literal("coverage_gap"), description: z.string().trim().min(1).max(5000), requirements: z.array(z.string().trim().min(1).max(100)).max(50).default([]) }).strict(),
]);
export type Finding = z.infer<typeof findingBody>;

interface RequestRow { id: number; kind: string; status: string; claimed_token_id: number | null; findings_count: number; target_url: string }

/**
 * The audit that holds the plan of a request. The first plan item or coverage gap makes it (`$agent-<request>`, source `request`, no import behind it) and links it from the request
 * (result_audit_id), so that the request's card shows it. It is found again by its agent id. Runs inside the finding's transaction.
 */
function requestAuditId(projectId: number, r: RequestRow, token: { id: number; name: string }): number {
  const agentAuditId = `$agent-${r.id}`;
  const found = db.prepare("SELECT id FROM audits WHERE project_id = ? AND agent_audit_id = ?").pluck().get(projectId, agentAuditId) as number | undefined;
  if (found !== undefined) return found;
  const id = db.prepare("INSERT INTO audits (project_id, agent_audit_id, title, agent_name, source) VALUES (?, ?, ?, ?, 'request') RETURNING id")
    .pluck().get(projectId, agentAuditId, `Discover ${r.target_url}`, token.name) as number;
  db.prepare("UPDATE agent_requests SET result_audit_id = COALESCE(result_audit_id, ?) WHERE id = ?").run(id, r.id);
  return id;
}

/**
 * Makes one proposal from a finding of a discover request this token took. Returns what was made. `token` is the request token (id and name) that authenticated the call.
 */
export function createFinding(projectId: number, requestId: number, token: { id: number; name: string }, ip: string, f: Finding) {
  return db.transaction(() => {
    const r = db.prepare("SELECT id, kind, status, claimed_token_id, findings_count, target_url FROM agent_requests WHERE id = ? AND project_id = ?").get(requestId, projectId) as RequestRow | undefined;
    if (!r) throw new AuditError(404, "Request not found");
    if (r.kind !== "discover") throw new AuditError(409, "Findings can only be made for a discover request. A re-run hands in its report with the result route, and a run reports a result for each test case");
    if (r.status === "pending") throw new AuditError(409, "The request is not taken. Take it first");
    if (r.status !== "claimed") throw new AuditError(409, "The request is already done or cancelled");
    if (r.claimed_token_id !== token.id) throw new AuditError(409, "Another token took this request");
    const origin = `$agent-${requestId}`;

    // The plan of the request: its own audit, its own caps, and not counted as findings.
    if (f.kind === "plan_item" || f.kind === "coverage_gap") {
      const auditId = requestAuditId(projectId, r, token);
      const have = agentPlanCounts(auditId);
      if (f.kind === "plan_item" && have.planItems >= PLAN_LIMITS.planItems) throw new AuditError(409, `This request already has ${PLAN_LIMITS.planItems} plan items, the most one request can make`);
      if (f.kind === "coverage_gap" && have.coverageGaps >= PLAN_LIMITS.coverageGaps) throw new AuditError(409, `This request already has ${PLAN_LIMITS.coverageGaps} coverage gaps, the most one request can make`);
      const label = `agent: ${token.name}`;
      const planned = f.kind === "plan_item"
        ? addPlanItemByAgent(auditId, {
          title: f.title, type: f.type, risk: f.risk, priority: f.priority ?? "", readiness: f.readiness ?? "", preconditions: f.preconditions, testData: f.testData, steps: f.steps,
          acceptanceCriteria: f.acceptanceCriteria, automation: f.automation, requirements: f.requirements,
        }, label)
        : addGapByAgent(auditId, { description: f.description, requirements: f.requirements }, label);
      audit({ userId: null, label, ip }, "agent_request.finding_created", { projectId, detail: { request: requestId, kind: r.kind, finding_kind: f.kind, id: planned.id, n: planned.sourceId, audit: auditId, credential_id: token.id } });
      const after = agentPlanCounts(auditId);
      return { kind: f.kind, id: planned.id, sourceId: planned.sourceId, auditId, findingsOnRequest: r.findings_count, planItemsOnRequest: after.planItems, coverageGapsOnRequest: after.coverageGaps };
    }

    if (r.findings_count >= FINDING_LIMITS.perRequest) throw new AuditError(409, `This request already has ${FINDING_LIMITS.perRequest} findings, the most one request can make`);

    const n = r.findings_count + 1;
    const bumped = db.prepare("UPDATE agent_requests SET findings_count = findings_count + 1 WHERE id = ? AND status = 'claimed' AND claimed_token_id = ? AND findings_count < ?")
      .run(requestId, token.id, FINDING_LIMITS.perRequest);
    if (!bumped.changes) throw new AuditError(409, "The request changed while the finding was being made");
    const sourceId = `${origin}-${n}`;

    let made: { id: number; number?: number; planItem?: string };
    if (f.kind === "test_case") {
      // A link to a plan item must name one this request made: nothing else is looked up, so a case cannot be pointed at another request's plan or a person's own item.
      let planRow: number | null = null;
      if (f.planItem !== undefined) {
        const auditId = db.prepare("SELECT id FROM audits WHERE project_id = ? AND agent_audit_id = ?").pluck().get(projectId, origin) as number | undefined;
        planRow = auditId === undefined ? null : planItemRowId(auditId, f.planItem);
        if (planRow === null) throw new AuditError(400, `planItem ${f.planItem} is not a plan item of this request. Hand in the plan item first, and use the sourceId it was given`);
      }
      const num = (db.prepare("UPDATE projects SET next_case_number = next_case_number + 1 WHERE id = ? RETURNING next_case_number - 1 AS n").get(projectId) as { n: number }).n;
      const pos = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM cases WHERE project_id = ?").get(projectId) as { p: number }).p;
      const id = (db.prepare(`INSERT INTO cases (project_id, suite_id, number, title, description, preconditions, priority, status, tags, position, created_by_agent_token_id, plan_item_id, agent_request_id)
          VALUES (?, NULL, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?) RETURNING id`)
        .get(projectId, num, f.title, f.description, f.preconditions, f.priority, JSON.stringify(["agent-proposed"]), pos, token.id, planRow, requestId) as { id: number }).id;
      f.steps.forEach((s, i) => db.prepare("INSERT INTO case_steps (case_id, position, action, expected) VALUES (?, ?, ?, ?)").run(id, i, s.action, s.expected));
      made = { id, number: num, ...(f.planItem === undefined ? {} : { planItem: f.planItem }) };
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
