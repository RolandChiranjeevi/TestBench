import { db } from "./db.ts";
import { resolveRefs } from "./auditcommon.ts";
import type { CoverageGapItem, ParsedPackage, PlanItem } from "./importers/auditpackage.ts";

/**
 * The test plan of an audit: plan items and coverage gaps, from the optional test-plan.json of an audit package.
 *  - They belong to the audit and are kept apart from test cases, runs and results. A plan item says what was planned, not that it was tested, so it never
 *    counts towards a requirement having a test (`withoutTest`). A coverage gap says what the audit did not verify, and is shown on the requirement it names.
 *  - Identity: the latest import of the same audit wins. A package with a test-plan.json replaces the plan of that audit (an empty file empties it); a package
 *    without one says nothing about the plan and leaves it as it is.
 *  - A reference to a requirement is kept as written (REQ-3, or a stable id such as REQ-LOCAL-002) and matched against the project's requirements when it is
 *    shown, so a requirement that is created later is found without another import.
 */

export type PlanAction = "new" | "unchanged" | "updated";
export interface PlanCounts { new: number; unchanged: number; updated: number; removed: number }
export interface PlannedTestPlan {
  /** False when the package has no test-plan.json. */
  listed: boolean;
  planItems: { counts: PlanCounts; items: { sourceId: string; title: string; action: PlanAction }[]; removed: string[] };
  coverageGaps: { counts: PlanCounts; items: { sourceId: string; action: PlanAction }[]; removed: string[] };
  /** References to requirements that match no requirement of the project now. */
  unresolvedRefs: number;
  data: { planItems: PlanItem[]; coverageGaps: CoverageGapItem[] } | null;
}

const zero = (): PlanCounts => ({ new: 0, unchanged: 0, updated: 0, removed: 0 });
const refsOf = (r: { requirements: string[] }) => [...new Set(r.requirements.map((x) => x.trim()).filter(Boolean))];
const itemKey = (x: { title: string; type: string; risk: string; priority: string; readiness: string; preconditions: string; testData: string; steps: string[]; acceptanceCriteria: string; automation: string; requirements: string[] }) =>
  JSON.stringify([x.title, x.type, x.risk, x.priority, x.readiness, x.preconditions, x.testData, x.steps, x.acceptanceCriteria, x.automation, x.requirements]);
const incomingItem = (p: PlanItem) => ({ title: p.title, type: p.type, risk: p.risk, priority: p.priority, readiness: p.readiness ?? "", preconditions: p.preconditions, testData: p.testData, steps: p.steps, acceptanceCriteria: p.acceptanceCriteria, automation: p.automation, requirements: refsOf(p.refs) });
const storedItem = (r: Record<string, any>) => ({ title: r.title, type: r.test_type, risk: r.risk, priority: r.priority, readiness: r.readiness, preconditions: r.preconditions, testData: r.test_data, steps: JSON.parse(r.steps) as string[], acceptanceCriteria: r.acceptance_criteria, automation: r.automation, requirements: JSON.parse(r.requirement_refs) as string[] });
const gapKey = (description: string, requirements: string[]) => JSON.stringify([description, requirements]);

/** What importing this package would do to the audit's plan, compared with what is stored now. Nothing is written. */
export function planTestPlan(pkg: ParsedPackage, project: { id: number; key: string }): PlannedTestPlan {
  const none: PlannedTestPlan = { listed: false, planItems: { counts: zero(), items: [], removed: [] }, coverageGaps: { counts: zero(), items: [], removed: [] }, unresolvedRefs: 0, data: null };
  if (!pkg.testPlan) return none;
  const audit = db.prepare("SELECT id FROM audits WHERE project_id = ? AND agent_audit_id = ?").get(project.id, pkg.manifest.audit.id) as { id: number } | undefined;
  const oldItems = new Map((audit ? (db.prepare("SELECT * FROM audit_plan_items WHERE audit_id = ?").all(audit.id) as Record<string, any>[]) : []).map((r) => [r.source_id as string, r]));
  const oldGaps = new Map((audit ? (db.prepare("SELECT * FROM audit_coverage_gaps WHERE audit_id = ?").all(audit.id) as Record<string, any>[]) : []).map((r) => [r.source_id as string, r]));
  const out: PlannedTestPlan = { ...none, listed: true, data: pkg.testPlan };
  for (const p of pkg.testPlan.planItems) {
    const old = oldItems.get(p.sourceId);
    const action: PlanAction = !old ? "new" : itemKey(storedItem(old)) === itemKey(incomingItem(p)) ? "unchanged" : "updated";
    out.planItems.counts[action]++;
    out.planItems.items.push({ sourceId: p.sourceId, title: p.title, action });
    oldItems.delete(p.sourceId);
  }
  for (const g of pkg.testPlan.coverageGaps) {
    const old = oldGaps.get(g.sourceId);
    const action: PlanAction = !old ? "new" : gapKey(old.description, JSON.parse(old.requirement_refs)) === gapKey(g.description, refsOf(g.refs)) ? "unchanged" : "updated";
    out.coverageGaps.counts[action]++;
    out.coverageGaps.items.push({ sourceId: g.sourceId, action });
    oldGaps.delete(g.sourceId);
  }
  out.planItems.removed = [...oldItems.keys()];
  out.planItems.counts.removed = out.planItems.removed.length;
  out.coverageGaps.removed = [...oldGaps.keys()];
  out.coverageGaps.counts.removed = out.coverageGaps.removed.length;
  const lookup = (raw: string) => resolveRefs(project.id, project.key, { requirements: [raw], cases: [], tests: [] })[0];
  for (const raw of [...pkg.testPlan.planItems.flatMap((p) => refsOf(p.refs)), ...pkg.testPlan.coverageGaps.flatMap((g) => refsOf(g.refs))]) if (lookup(raw).state !== "resolved") out.unresolvedRefs++;
  return out;
}

/** Replaces the plan of the audit with the package's (latest import wins). Does nothing when the package has no test-plan.json. Call inside the import's transaction. */
export function storeTestPlan(auditId: number, plan: PlannedTestPlan) {
  if (!plan.data) return;
  db.prepare("DELETE FROM audit_plan_items WHERE audit_id = ?").run(auditId);
  db.prepare("DELETE FROM audit_coverage_gaps WHERE audit_id = ?").run(auditId);
  const insItem = db.prepare(`INSERT INTO audit_plan_items (audit_id, source_id, position, title, test_type, risk, priority, readiness, preconditions, test_data, steps, acceptance_criteria, automation, requirement_refs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  plan.data.planItems.forEach((p, i) => insItem.run(auditId, p.sourceId, i, p.title, p.type, p.risk, p.priority, p.readiness ?? "", p.preconditions, p.testData, JSON.stringify(p.steps), p.acceptanceCriteria, p.automation, JSON.stringify(refsOf(p.refs))));
  const insGap = db.prepare("INSERT INTO audit_coverage_gaps (audit_id, source_id, position, description, requirement_refs) VALUES (?, ?, ?, ?, ?)");
  plan.data.coverageGaps.forEach((g, i) => insGap.run(auditId, g.sourceId, i, g.description, JSON.stringify(refsOf(g.refs))));
}

export const planCounts = (auditId: number) => ({
  planItems: (db.prepare("SELECT COUNT(*) AS n FROM audit_plan_items WHERE audit_id = ?").get(auditId) as { n: number }).n,
  coverageGaps: (db.prepare("SELECT COUNT(*) AS n FROM audit_coverage_gaps WHERE audit_id = ?").get(auditId) as { n: number }).n,
});

export interface LinkedRequirement { raw: string; state: string; label: string; requirementId: number | null; reason: string }
function linkRequirement(projectId: number, projectKey: string, raw: string): LinkedRequirement {
  const r = resolveRefs(projectId, projectKey, { requirements: [raw], cases: [], tests: [] })[0];
  const q = r.requirementId ? (db.prepare("SELECT number, title FROM requirements WHERE id = ?").get(r.requirementId) as { number: number; title: string } | undefined) : undefined;
  return { raw, state: r.state, label: q ? `REQ-${q.number} · ${q.title}` : raw, requirementId: r.requirementId, reason: r.reason };
}

/** The plan of one audit for its view, with every requirement reference matched against the project's requirements as they are now. Null when there is no such audit. */
export function auditPlan(auditId: number) {
  const a = db.prepare("SELECT a.id, a.agent_audit_id AS agentAuditId, a.title, a.project_id AS projectId, p.key AS projectKey FROM audits a JOIN projects p ON p.id = a.project_id WHERE a.id = ?").get(auditId) as
    { id: number; agentAuditId: string; title: string; projectId: number; projectKey: string } | undefined;
  if (!a) return null;
  const link = (raw: string) => linkRequirement(a.projectId, a.projectKey, raw);
  const planItems = (db.prepare("SELECT * FROM audit_plan_items WHERE audit_id = ? ORDER BY position").all(auditId) as Record<string, any>[]).map((r) => ({
    sourceId: r.source_id as string, title: r.title as string, type: r.test_type as string, risk: r.risk as string, priority: r.priority as string, readiness: r.readiness as string,
    preconditions: r.preconditions as string, testData: r.test_data as string, steps: JSON.parse(r.steps) as string[], acceptanceCriteria: r.acceptance_criteria as string,
    automation: r.automation as string, result: r.result as string | null, requirements: (JSON.parse(r.requirement_refs) as string[]).map(link),
  }));
  const coverageGaps = (db.prepare("SELECT * FROM audit_coverage_gaps WHERE audit_id = ? ORDER BY position").all(auditId) as Record<string, any>[]).map((r) => ({
    sourceId: r.source_id as string, description: r.description as string, requirements: (JSON.parse(r.requirement_refs) as string[]).map(link),
  }));
  return { audit: { id: a.id, agentAuditId: a.agentAuditId, title: a.title }, planItems, coverageGaps };
}

/** The plan items and coverage gaps of the project's audits that name one requirement, for the requirement's own view. */
export function planForRequirement(requirementId: number) {
  const q = db.prepare("SELECT project_id AS projectId, number, external_id AS externalId FROM requirements WHERE id = ?").get(requirementId) as { projectId: number; number: number; externalId: string | null } | undefined;
  if (!q) return { planItems: [], coverageGaps: [] };
  const norm = (s: string) => s.trim().toLowerCase();
  const names = (refs: string) => (JSON.parse(refs) as string[]).some((raw) => norm(raw) === `req-${q.number}` || (!!q.externalId && norm(raw) === norm(q.externalId)));
  const planItems = (db.prepare(`SELECT i.source_id AS sourceId, i.title, i.test_type AS type, i.risk, i.priority, i.readiness, i.requirement_refs AS refs, a.id AS auditId, a.agent_audit_id AS agentAuditId, a.title AS auditTitle
    FROM audit_plan_items i JOIN audits a ON a.id = i.audit_id WHERE a.project_id = ? ORDER BY a.last_imported_at DESC, a.id DESC, i.position`).all(q.projectId) as Record<string, any>[])
    .filter((r) => names(r.refs)).map(({ refs: _refs, ...r }) => r);
  const coverageGaps = (db.prepare(`SELECT g.source_id AS sourceId, g.description, g.requirement_refs AS refs, a.id AS auditId, a.agent_audit_id AS agentAuditId, a.title AS auditTitle
    FROM audit_coverage_gaps g JOIN audits a ON a.id = g.audit_id WHERE a.project_id = ? ORDER BY a.last_imported_at DESC, a.id DESC, g.position`).all(q.projectId) as Record<string, any>[])
    .filter((r) => names(r.refs)).map(({ refs: _refs, ...r }) => r);
  return { planItems, coverageGaps };
}
