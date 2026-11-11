import { db } from "./db.ts";
import { actorName, actorUserId } from "./actor.ts";
import { AuditError, resolveRefs } from "./auditcommon.ts";
import type { CoverageGapItem, ParsedPackage, PlanItem } from "./importers/auditpackage.ts";

/**
 * The test plan of an audit: plan items and coverage gaps, from the optional test-plan.json of an audit package.
 *  - They belong to the audit and are kept apart from test cases, runs and results. A plan item says what was planned, not that it was tested, so it never
 *    counts towards a requirement having a test (`withoutTest`). A coverage gap says what the audit did not verify, and is shown on the requirement it names.
 *  - Plan items and coverage gaps work the same way (one "subject" each, below). One is the agent's proposal until a person owns it. A person owns it once they edit it,
 *    decide it (approved / rejected) or add it themselves. An import updates or removes only what nobody owns; for what a person owns, the agent's newer version (or its
 *    removal) waits in pending_json until a person applies or ignores it. An import never deletes what a person owns or added, an empty test-plan.json included.
 *    A package without a test-plan.json leaves the plan as it is.
 *  - Every change is written to audit_plan_revisions (plan items) or audit_gap_revisions (gaps), so the history says who changed what and when, and what the agent sent.
 *  - A reference to a requirement is kept as written (REQ-3, or a stable id such as REQ-LOCAL-002) and matched against the project's requirements when it is
 *    shown, so a requirement that is created later is found without another import.
 */

type PlanAction = "new" | "unchanged" | "updated";
/** `pending` counts what a person owns where the agent sent a newer version or left it out: it is kept, and the agent's version waits. */
export interface PlanCounts { new: number; unchanged: number; updated: number; removed: number; pending: number }
type PlanItemAction = PlanAction | "pending";
export interface PlanFields {
  title: string; type: string; risk: string; priority: string; readiness: string; preconditions: string; testData: string; steps: string[];
  acceptanceCriteria: string; automation: string; requirements: string[];
}
export interface GapFields { description: string; requirements: string[] }
export type PlanStatus = "proposed" | "draft" | "approved" | "rejected";
const AGENT_LABEL = "Agent import";
interface SubjectPlan { counts: PlanCounts; items: { sourceId: string; title: string; action: PlanItemAction }[]; removed: string[]; waiting: string[] }
export interface PlannedTestPlan {
  /** False when the package has no test-plan.json. */
  listed: boolean;
  planItems: SubjectPlan;
  coverageGaps: SubjectPlan;
  /** References to requirements that match no requirement of the project now. */
  unresolvedRefs: number;
  data: { planItems: PlanItem[]; coverageGaps: CoverageGapItem[] } | null;
}

type Who = { name: string; userId: number | null };
const agent: Who = { name: AGENT_LABEL, userId: null };
const person = (): Who => ({ name: actorName(), userId: actorUserId() });
const zero = (): PlanCounts => ({ new: 0, unchanged: 0, updated: 0, removed: 0, pending: 0 });
/** A person owns what they added, edited or decided. The import leaves it alone. */
const owned = (r: Record<string, any>) => r.origin === "human" || r.review_status !== "proposed" || !!r.edited_at;
const refsOf = (r: { requirements: string[] }) => [...new Set(r.requirements.map((x) => x.trim()).filter(Boolean))];
const cleanList = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

// ---- the two kinds of thing, as adapters. Everything below the adapters works on either. ----

interface Subject {
  table: string; revisions: string;
  /** "plan item" / "coverage gap" in messages, and the short word ("item" / "gap"). */
  noun: string; short: string;
  /** The prefix of the id a person's own one is given (H-1, G-1). */
  prefix: string;
  labels: Record<string, string>;
  stored(r: Record<string, any>): any;
  key(f: any): string;
  normalize(f: any): any;
  blank(): any;
  /** A short name for the history. */
  name(f: any): string;
  /** `SET` assignments (no WHERE) and their values. */
  set: string;
  values(f: any): unknown[];
  insertAgent(auditId: number, sourceId: string, position: number, f: any, hash: string): void;
  insertHuman(auditId: number, sourceId: string, position: number, f: any, w: Who): void;
  /** Throws a 400 when the fields cannot be saved. */
  validate(f: any): void;
}

const ITEM_LABELS: Record<keyof PlanFields, string> = {
  title: "Title", type: "Type", risk: "Risk", priority: "Priority", readiness: "Readiness", preconditions: "Preconditions", testData: "Test data", steps: "Steps",
  acceptanceCriteria: "Acceptance criteria", automation: "Automation", requirements: "Requirements",
};
const itemKey = (x: PlanFields) => JSON.stringify([x.title, x.type, x.risk, x.priority, x.readiness, x.preconditions, x.testData, x.steps, x.acceptanceCriteria, x.automation, x.requirements]);
const incomingItem = (p: PlanItem): PlanFields => ({ title: p.title, type: p.type, risk: p.risk, priority: p.priority, readiness: p.readiness ?? "", preconditions: p.preconditions, testData: p.testData, steps: p.steps, acceptanceCriteria: p.acceptanceCriteria, automation: p.automation, requirements: refsOf(p.refs) });
const storedItem = (r: Record<string, any>): PlanFields => ({ title: r.title, type: r.test_type, risk: r.risk, priority: r.priority, readiness: r.readiness, preconditions: r.preconditions, testData: r.test_data, steps: JSON.parse(r.steps) as string[], acceptanceCriteria: r.acceptance_criteria, automation: r.automation, requirements: JSON.parse(r.requirement_refs) as string[] });
const ITEM_COLS = "title = ?, test_type = ?, risk = ?, priority = ?, readiness = ?, preconditions = ?, test_data = ?, steps = ?, acceptance_criteria = ?, automation = ?, requirement_refs = ?";
const itemValues = (f: PlanFields) => [f.title, f.type, f.risk, f.priority, f.readiness, f.preconditions, f.testData, JSON.stringify(f.steps), f.acceptanceCriteria, f.automation, JSON.stringify(f.requirements)];
const ITEM_INSERT = "INSERT INTO audit_plan_items (audit_id, source_id, position, title, test_type, risk, priority, readiness, preconditions, test_data, steps, acceptance_criteria, automation, requirement_refs";

const ITEM: Subject = {
  table: "audit_plan_items", revisions: "audit_plan_revisions", noun: "plan item", short: "item", prefix: "H-", labels: ITEM_LABELS,
  stored: storedItem, key: itemKey,
  normalize: (f: PlanFields): PlanFields => ({ ...f, title: f.title.trim(), steps: f.steps.map((x) => x.trim()).filter(Boolean), requirements: cleanList(f.requirements) }),
  blank: (): PlanFields => ({ title: "", type: "", risk: "", priority: "", readiness: "", preconditions: "", testData: "", steps: [], acceptanceCriteria: "", automation: "", requirements: [] }),
  name: (f: PlanFields) => f.title,
  set: ITEM_COLS, values: itemValues,
  insertAgent: (a, s, pos, f: PlanFields, hash) => { db.prepare(`${ITEM_INSERT}, agent_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(a, s, pos, ...itemValues(f), hash); },
  insertHuman: (a, s, pos, f: PlanFields, w) => {
    db.prepare(`${ITEM_INSERT}, origin, review_status, edited_by, edited_by_user_id, edited_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human', 'draft', ?, ?, datetime('now'))`)
      .run(a, s, pos, ...itemValues(f), w.name, w.userId);
  },
  validate: (f: PlanFields) => { if (!f.title) throw new AuditError(400, "A plan item needs a title"); },
};

const GAP_LABELS: Record<keyof GapFields, string> = { description: "Description", requirements: "Requirements" };
const gapKey = (f: GapFields) => JSON.stringify([f.description, f.requirements]);
const storedGap = (r: Record<string, any>): GapFields => ({ description: r.description, requirements: JSON.parse(r.requirement_refs) as string[] });
const incomingGap = (g: CoverageGapItem): GapFields => ({ description: g.description, requirements: refsOf(g.refs) });
const GAP: Subject = {
  table: "audit_coverage_gaps", revisions: "audit_gap_revisions", noun: "coverage gap", short: "gap", prefix: "G-", labels: GAP_LABELS,
  stored: storedGap, key: gapKey,
  normalize: (f: GapFields): GapFields => ({ description: f.description.trim(), requirements: cleanList(f.requirements) }),
  blank: (): GapFields => ({ description: "", requirements: [] }),
  name: (f: GapFields) => (f.description.length > 80 ? `${f.description.slice(0, 77)}...` : f.description),
  set: "description = ?, requirement_refs = ?", values: (f: GapFields) => [f.description, JSON.stringify(f.requirements)],
  insertAgent: (a, s, pos, f: GapFields, hash) => { db.prepare("INSERT INTO audit_coverage_gaps (audit_id, source_id, position, description, requirement_refs, agent_hash) VALUES (?, ?, ?, ?, ?, ?)").run(a, s, pos, f.description, JSON.stringify(f.requirements), hash); },
  insertHuman: (a, s, pos, f: GapFields, w) => {
    db.prepare("INSERT INTO audit_coverage_gaps (audit_id, source_id, position, description, requirement_refs, origin, review_status, edited_by, edited_by_user_id, edited_at) VALUES (?, ?, ?, ?, ?, 'human', 'draft', ?, ?, datetime('now'))")
      .run(a, s, pos, f.description, JSON.stringify(f.requirements), w.name, w.userId);
  },
  validate: (f: GapFields) => { if (!f.description) throw new AuditError(400, "A coverage gap needs a description"); },
};

/** What differs between two versions, field by field, for the diff a person reads. */
function changesOf(s: Subject, from: any, to: any): { field: string; from: string; to: string }[] {
  const show = (v: unknown) => (Array.isArray(v) ? v.join("\n") : String(v ?? ""));
  return Object.keys(s.labels).filter((k) => JSON.stringify(from[k]) !== JSON.stringify(to[k])).map((k) => ({ field: s.labels[k], from: show(from[k]), to: show(to[k]) }));
}

// ---- what an import would do, and what it does ----

function planSubject(s: Subject, old: Map<string, Record<string, any>>, incoming: { sourceId: string; fields: any }[]): SubjectPlan {
  const out: SubjectPlan = { counts: zero(), items: [], removed: [], waiting: [] };
  for (const p of incoming) {
    const row = old.get(p.sourceId);
    let action: PlanItemAction;
    if (!row) action = "new";
    else if (s.key(s.stored(row)) === s.key(p.fields)) action = "unchanged";
    else if (owned(row)) action = row.agent_hash === s.key(p.fields) ? "unchanged" : "pending"; // kept as it is; an ignored version is not offered again
    else action = "updated";
    out.counts[action]++;
    out.items.push({ sourceId: p.sourceId, title: s.name(p.fields), action });
    old.delete(p.sourceId);
  }
  // What the package leaves out goes only when nobody owns it. A person's own is not the agent's to remove, and an owned one of the agent's is kept with the removal waiting.
  const leftOut = [...old.values()].filter((r) => r.origin === "agent");
  out.removed = leftOut.filter((r) => !owned(r)).map((r) => r.source_id as string);
  out.waiting = leftOut.filter((r) => owned(r)).map((r) => r.source_id as string);
  out.counts.removed = out.removed.length;
  out.counts.pending += out.waiting.length;
  return out;
}

/** What importing this package would do to the audit's plan, compared with what is stored now. Nothing is written. */
export function planTestPlan(pkg: ParsedPackage, project: { id: number; key: string }): PlannedTestPlan {
  const empty = (): SubjectPlan => ({ counts: zero(), items: [], removed: [], waiting: [] });
  const none: PlannedTestPlan = { listed: false, planItems: empty(), coverageGaps: empty(), unresolvedRefs: 0, data: null };
  if (!pkg.testPlan) return none;
  const audit = db.prepare("SELECT id FROM audits WHERE project_id = ? AND agent_audit_id = ?").get(project.id, pkg.manifest.audit.id) as { id: number } | undefined;
  const oldOf = (s: Subject) => new Map((audit ? (db.prepare(`SELECT * FROM ${s.table} WHERE audit_id = ?`).all(audit.id) as Record<string, any>[]) : []).map((r) => [r.source_id as string, r]));
  const out: PlannedTestPlan = { ...none, listed: true, data: pkg.testPlan };
  out.planItems = planSubject(ITEM, oldOf(ITEM), pkg.testPlan.planItems.map((p) => ({ sourceId: p.sourceId, fields: incomingItem(p) })));
  out.coverageGaps = planSubject(GAP, oldOf(GAP), pkg.testPlan.coverageGaps.map((g) => ({ sourceId: g.sourceId, fields: incomingGap(g) })));
  const lookup = (raw: string) => resolveRefs(project.id, project.key, { requirements: [raw], cases: [], tests: [] })[0];
  for (const raw of [...pkg.testPlan.planItems.flatMap((p) => refsOf(p.refs)), ...pkg.testPlan.coverageGaps.flatMap((g) => refsOf(g.refs))]) if (lookup(raw).state !== "resolved") out.unresolvedRefs++;
  return out;
}

/** Writes one entry of the history. `snapshot` is the fields and status as they are after the change (for an agent version that waits: the agent's fields). */
function revise(s: Subject, auditId: number, sourceId: string, kind: string, who: Who, fields: any, status: string, note = "") {
  const rev = (db.prepare(`SELECT COALESCE(MAX(rev), 0) + 1 AS n FROM ${s.revisions} WHERE audit_id = ? AND source_id = ?`).get(auditId, sourceId) as { n: number }).n;
  db.prepare(`INSERT INTO ${s.revisions} (audit_id, source_id, rev, kind, actor, actor_user_id, note, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(auditId, sourceId, rev, kind, who.name, who.userId, note, JSON.stringify({ fields, status }));
}

/** Brings the audit's items (or gaps) in line with the package: what nobody owns follows the package; what a person owns or added is never changed or removed. */
function reconcile(s: Subject, auditId: number, incoming: { sourceId: string; fields: any }[]) {
  const old = new Map((db.prepare(`SELECT * FROM ${s.table} WHERE audit_id = ?`).all(auditId) as Record<string, any>[]).map((r) => [r.source_id as string, r]));
  incoming.forEach((p, i) => {
    const key = s.key(p.fields);
    const row = old.get(p.sourceId);
    old.delete(p.sourceId);
    if (!row) {
      s.insertAgent(auditId, p.sourceId, i, p.fields, key);
      revise(s, auditId, p.sourceId, "agent_import", agent, p.fields, "proposed", "New proposal from the agent");
      return;
    }
    const same = s.key(s.stored(row)) === key;
    if (!owned(row)) {
      db.prepare(`UPDATE ${s.table} SET position = ?, agent_hash = ? WHERE id = ?`).run(i, key, row.id);
      if (!same) {
        db.prepare(`UPDATE ${s.table} SET ${s.set} WHERE id = ?`).run(...s.values(p.fields), row.id);
        revise(s, auditId, p.sourceId, "agent_import", agent, p.fields, "proposed", "Updated by the agent");
      }
      return;
    }
    // A person owns it. A removal that was waiting is withdrawn if the agent brings it back.
    const pending = row.pending_json ? JSON.parse(row.pending_json) : null;
    if (same) { if (pending) db.prepare(`UPDATE ${s.table} SET pending_json = NULL, agent_hash = ? WHERE id = ?`).run(key, row.id); return; }
    if (row.agent_hash === key && !pending?.removed) return; // the agent sent this before and a person ignored it (or it already waits)
    db.prepare(`UPDATE ${s.table} SET pending_json = ?, agent_hash = ? WHERE id = ?`).run(JSON.stringify({ item: p.fields }), key, row.id);
    revise(s, auditId, p.sourceId, "agent_sent", agent, p.fields, row.review_status, "The agent sent a newer version. It waits for a person to apply or ignore it.");
  });
  for (const row of old.values()) {
    if (row.origin !== "agent") continue; // a person's own is not in the agent's package and is never removed by it
    if (!owned(row)) {
      db.prepare(`DELETE FROM ${s.table} WHERE id = ?`).run(row.id);
      revise(s, auditId, row.source_id, "agent_removed", agent, s.stored(row), row.review_status, "Left out of the agent's newer plan");
    } else if (!(row.pending_json && JSON.parse(row.pending_json).removed)) {
      db.prepare(`UPDATE ${s.table} SET pending_json = ? WHERE id = ?`).run(JSON.stringify({ removed: true }), row.id);
      revise(s, auditId, row.source_id, "removal_pending", agent, s.stored(row), row.review_status, `The agent's newer plan leaves this ${s.short} out. It is kept until a person decides.`);
    }
  }
}

/** Does nothing when the package has no test-plan.json. Call inside the import's transaction. */
export function storeTestPlan(auditId: number, plan: PlannedTestPlan) {
  if (!plan.data) return;
  reconcile(ITEM, auditId, plan.data.planItems.map((p) => ({ sourceId: p.sourceId, fields: incomingItem(p) })));
  reconcile(GAP, auditId, plan.data.coverageGaps.map((g) => ({ sourceId: g.sourceId, fields: incomingGap(g) })));
}

export const planCounts = (auditId: number) => ({
  planItems: (db.prepare("SELECT COUNT(*) AS n FROM audit_plan_items WHERE audit_id = ?").get(auditId) as { n: number }).n,
  coverageGaps: (db.prepare("SELECT COUNT(*) AS n FROM audit_coverage_gaps WHERE audit_id = ?").get(auditId) as { n: number }).n,
});

/** A plan item as what is made from it needs it (automation suggestions): its fields, its status, and a fingerprint of its text, to tell later that it has changed. Null when there is no such item. */
export function planItemForSuggestion(auditId: number, sourceId: string) {
  const r = db.prepare("SELECT * FROM audit_plan_items WHERE audit_id = ? AND source_id = ?").get(auditId, sourceId) as Record<string, any> | undefined;
  if (!r) return null;
  const fields = storedItem(r);
  return { fields, status: r.review_status as PlanStatus, hash: itemKey(fields) };
}

/** How much of the audit's plan a person made their own (edited, decided or added), and how many history entries it has: what deleting the audit takes with it. */
export function ownedPlanCounts(auditId: number) {
  const n = (sql: string) => (db.prepare(sql).get(auditId) as { n: number }).n;
  const own = "audit_id = ? AND (origin = 'human' OR review_status != 'proposed' OR edited_at IS NOT NULL)";
  return {
    planItems: n(`SELECT COUNT(*) AS n FROM audit_plan_items WHERE ${own}`),
    coverageGaps: n(`SELECT COUNT(*) AS n FROM audit_coverage_gaps WHERE ${own}`),
    /** Automation suggestions a person has worked on (edited, decided or applied): they go with the audit, and the draft test cases made from them stay. */
    automation: n("SELECT COUNT(*) AS n FROM automation_suggestions WHERE audit_id = ? AND review_status != 'proposed'"),
    history: n("SELECT COUNT(*) AS n FROM audit_plan_revisions WHERE audit_id = ?") + n("SELECT COUNT(*) AS n FROM audit_gap_revisions WHERE audit_id = ?")
      + n("SELECT COUNT(*) AS n FROM automation_suggestion_revisions r JOIN automation_suggestions s ON s.id = r.suggestion_id WHERE s.audit_id = ?"),
  };
}

// ---- the views ----

/** The agent's newer version of something a person owns, as a diff against what is there now; null when nothing waits. */
function pendingView(s: Subject, r: Record<string, any>) {
  if (!r.pending_json) return null;
  const p = JSON.parse(r.pending_json) as { item?: any; removed?: boolean };
  return p.removed ? { removed: true, changes: [] as { field: string; from: string; to: string }[] } : { removed: false, changes: changesOf(s, s.stored(r), p.item) };
}
/** What a view shows about who owns it and what became of it. */
const ownership = (s: Subject, r: Record<string, any>) => ({
  origin: r.origin as "agent" | "human", status: r.review_status as PlanStatus,
  editedBy: (r.edited_by as string) || null, editedAt: r.edited_at as string | null, decidedBy: (r.decided_by as string) || null, decidedAt: r.decided_at as string | null,
  pending: pendingView(s, r),
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
  const planItems = (db.prepare("SELECT * FROM audit_plan_items WHERE audit_id = ? ORDER BY position, id").all(auditId) as Record<string, any>[]).map((r) => ({
    sourceId: r.source_id as string, title: r.title as string, type: r.test_type as string, risk: r.risk as string, priority: r.priority as string, readiness: r.readiness as string,
    preconditions: r.preconditions as string, testData: r.test_data as string, steps: JSON.parse(r.steps) as string[], acceptanceCriteria: r.acceptance_criteria as string,
    automation: r.automation as string, result: r.result as string | null, requirements: (JSON.parse(r.requirement_refs) as string[]).map(link),
    ...ownership(ITEM, r),
  }));
  const coverageGaps = (db.prepare("SELECT * FROM audit_coverage_gaps WHERE audit_id = ? ORDER BY position, id").all(auditId) as Record<string, any>[]).map((r) => ({
    sourceId: r.source_id as string, description: r.description as string, requirements: (JSON.parse(r.requirement_refs) as string[]).map(link),
    ...ownership(GAP, r),
  }));
  return { audit: { id: a.id, agentAuditId: a.agentAuditId, title: a.title }, planItems, coverageGaps };
}

/** The plan items and coverage gaps of the project's audits that name one requirement, for the requirement's own view. What a person rejected is left out. */
export function planForRequirement(requirementId: number) {
  const q = db.prepare("SELECT project_id AS projectId, number, external_id AS externalId FROM requirements WHERE id = ?").get(requirementId) as { projectId: number; number: number; externalId: string | null } | undefined;
  if (!q) return { planItems: [], coverageGaps: [] };
  const norm = (s: string) => s.trim().toLowerCase();
  const names = (refs: string) => (JSON.parse(refs) as string[]).some((raw) => norm(raw) === `req-${q.number}` || (!!q.externalId && norm(raw) === norm(q.externalId)));
  const planItems = (db.prepare(`SELECT i.source_id AS sourceId, i.title, i.test_type AS type, i.risk, i.priority, i.readiness, i.requirement_refs AS refs, a.id AS auditId, a.agent_audit_id AS agentAuditId, a.title AS auditTitle
    FROM audit_plan_items i JOIN audits a ON a.id = i.audit_id WHERE a.project_id = ? AND i.review_status != 'rejected' ORDER BY a.last_imported_at DESC, a.id DESC, i.position`).all(q.projectId) as Record<string, any>[])
    .filter((r) => names(r.refs)).map(({ refs: _refs, ...r }) => r);
  const coverageGaps = (db.prepare(`SELECT g.source_id AS sourceId, g.description, g.requirement_refs AS refs, a.id AS auditId, a.agent_audit_id AS agentAuditId, a.title AS auditTitle
    FROM audit_coverage_gaps g JOIN audits a ON a.id = g.audit_id WHERE a.project_id = ? AND g.review_status != 'rejected' ORDER BY a.last_imported_at DESC, a.id DESC, g.position`).all(q.projectId) as Record<string, any>[])
    .filter((r) => names(r.refs)).map(({ refs: _refs, ...r }) => r);
  return { planItems, coverageGaps };
}

// ---- what a person does with the plan ----

const rowOf = (s: Subject, auditId: number, sourceId: string) => {
  const r = db.prepare(`SELECT * FROM ${s.table} WHERE audit_id = ? AND source_id = ?`).get(auditId, sourceId) as Record<string, any> | undefined;
  if (!r) throw new AuditError(404, `${s.noun[0].toUpperCase()}${s.noun.slice(1)} not found`);
  return r;
};
const stamp = (w: Who) => ["edited_by = ?, edited_by_user_id = ?, edited_at = datetime('now')", [w.name, w.userId]] as const;

/** A person edits. It becomes theirs (a draft, also when it was approved or rejected: the decision was about the earlier text). No change, no entry. */
function edit(s: Subject, auditId: number, sourceId: string, patch: Record<string, unknown>) {
  const row = rowOf(s, auditId, sourceId);
  const cur = s.stored(row);
  const next = s.normalize({ ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
  s.validate(next);
  if (s.key(next) === s.key(cur)) return;
  const w = person();
  const [sets, vals] = stamp(w);
  db.transaction(() => {
    db.prepare(`UPDATE ${s.table} SET ${s.set}, review_status = 'draft', ${sets} WHERE id = ?`).run(...s.values(next), ...vals, row.id);
    revise(s, auditId, sourceId, "edited", w, next, "draft", row.review_status === "draft" ? "" : row.review_status === "proposed" ? "Taken over from the agent's proposal" : `Back to draft: the ${row.review_status} decision was about the earlier text`);
  })();
}

/** A person saves as a draft, approves or rejects. Approving and rejecting record who decided and when; nothing but a person gets here. */
function decide(s: Subject, auditId: number, sourceId: string, status: "draft" | "approved" | "rejected", note?: string) {
  const row = rowOf(s, auditId, sourceId);
  if (row.review_status === status) return;
  const w = person();
  db.transaction(() => {
    if (status === "draft") {
      const [sets, vals] = stamp(w);
      db.prepare(`UPDATE ${s.table} SET review_status = 'draft', ${sets} WHERE id = ?`).run(...vals, row.id);
    } else {
      db.prepare(`UPDATE ${s.table} SET review_status = ?, decided_by = ?, decided_by_user_id = ?, decided_at = datetime('now') WHERE id = ?`).run(status, w.name, w.userId, row.id);
    }
    revise(s, auditId, sourceId, status, w, s.stored(row), status, note?.trim() ?? "");
  })();
}

/** A person applies or ignores the agent's newer version (or its removal) of what they own. Applying takes the agent's text as a draft, to be approved again. */
function resolve(s: Subject, auditId: number, sourceId: string, action: "apply" | "ignore") {
  const row = rowOf(s, auditId, sourceId);
  if (!row.pending_json) throw new AuditError(409, `The agent has not sent a newer version of this ${s.short}`);
  const pending = JSON.parse(row.pending_json) as { item?: any; removed?: boolean };
  const w = person();
  db.transaction(() => {
    if (action === "ignore") {
      db.prepare(`UPDATE ${s.table} SET pending_json = NULL WHERE id = ?`).run(row.id);
      revise(s, auditId, sourceId, "ignored_agent", w, s.stored(row), row.review_status, pending.removed ? `Kept the ${s.short}; the agent's removal was ignored` : "Ignored the agent's newer version");
    } else if (pending.removed) {
      revise(s, auditId, sourceId, "removed_by_agent", w, s.stored(row), row.review_status, "Removed, as the agent's newer plan left it out");
      db.prepare(`DELETE FROM ${s.table} WHERE id = ?`).run(row.id);
    } else {
      const [sets, vals] = stamp(w);
      db.prepare(`UPDATE ${s.table} SET ${s.set}, review_status = 'draft', pending_json = NULL, ${sets} WHERE id = ?`).run(...s.values(pending.item), ...vals, row.id);
      revise(s, auditId, sourceId, "applied_agent", w, pending.item, "draft", "Applied the agent's newer version");
    }
  })();
}

/** A person adds one of their own. It is theirs from the start (origin human, a draft) and the agent's imports never touch it. Returns the id it was given. */
function add(s: Subject, auditId: number, fields: Record<string, unknown>) {
  if (!db.prepare("SELECT 1 FROM audits WHERE id = ?").get(auditId)) throw new AuditError(404, "Audit not found");
  const f = s.normalize({ ...s.blank(), ...fields });
  s.validate(f);
  const w = person();
  return db.transaction(() => {
    let n = (db.prepare(`SELECT COUNT(*) AS n FROM ${s.table} WHERE audit_id = ? AND origin = 'human'`).get(auditId) as { n: number }).n + 1;
    while (db.prepare(`SELECT 1 FROM ${s.table} WHERE audit_id = ? AND source_id = ?`).get(auditId, `${s.prefix}${n}`)) n++;
    const sourceId = `${s.prefix}${n}`;
    const position = (db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM ${s.table} WHERE audit_id = ?`).get(auditId) as { p: number }).p;
    s.insertHuman(auditId, sourceId, position, f, w);
    revise(s, auditId, sourceId, "created", w, f, "draft", "Added by a person");
    return sourceId;
  })();
}

/** The history, oldest first: every entry says what happened, who did it and what changed against how it stood. */
function history(s: Subject, auditId: number) {
  if (!db.prepare("SELECT 1 FROM audits WHERE id = ?").get(auditId)) throw new AuditError(404, "Audit not found");
  const rows = db.prepare(`SELECT * FROM ${s.revisions} WHERE audit_id = ? ORDER BY id`).all(auditId) as Record<string, any>[];
  const standing = new Map<string, any>(); // the text as it stood, to compare each entry against
  const sent = new Set(["agent_sent", "removal_pending", "ignored_agent", "removed_by_agent"]);
  return rows.map((r) => {
    const snap = JSON.parse(r.snapshot) as { fields: any; status: string };
    const before = standing.get(r.source_id);
    const changes = r.kind === "agent_sent" || !sent.has(r.kind) ? (before ? changesOf(s, before, snap.fields) : []) : [];
    if (!sent.has(r.kind)) standing.set(r.source_id, snap.fields);
    return {
      id: r.id as number, sourceId: r.source_id as string, rev: r.rev as number, at: r.at as string, kind: r.kind as string, actor: r.actor as string, byAgent: r.actor_user_id === null && r.actor === AGENT_LABEL,
      note: r.note as string, title: s.name(snap.fields), status: snap.status, changes,
    };
  });
}

export const editPlanItem = (auditId: number, sourceId: string, patch: Partial<PlanFields>) => edit(ITEM, auditId, sourceId, patch);
export const decidePlanItem = (auditId: number, sourceId: string, status: "draft" | "approved" | "rejected", note?: string) => decide(ITEM, auditId, sourceId, status, note);
export const resolvePending = (auditId: number, sourceId: string, action: "apply" | "ignore") => resolve(ITEM, auditId, sourceId, action);
export const addPlanItem = (auditId: number, fields: Pick<PlanFields, "title"> & Partial<PlanFields>) => add(ITEM, auditId, fields);
export const planHistory = (auditId: number) => history(ITEM, auditId);

export const editGap = (auditId: number, sourceId: string, patch: Partial<GapFields>) => edit(GAP, auditId, sourceId, patch);
export const decideGap = (auditId: number, sourceId: string, status: "draft" | "approved" | "rejected", note?: string) => decide(GAP, auditId, sourceId, status, note);
export const resolveGapPending = (auditId: number, sourceId: string, action: "apply" | "ignore") => resolve(GAP, auditId, sourceId, action);
export const addGap = (auditId: number, fields: Pick<GapFields, "description"> & Partial<GapFields>) => add(GAP, auditId, fields);
export const gapHistory = (auditId: number) => history(GAP, auditId);
