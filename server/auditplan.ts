import { db } from "./db.ts";
import { actorName, actorUserId } from "./actor.ts";
import { AuditError, resolveRefs } from "./auditcommon.ts";
import type { CoverageGapItem, ParsedPackage, PlanItem } from "./importers/auditpackage.ts";

/**
 * The test plan of an audit: plan items and coverage gaps, from the optional test-plan.json of an audit package.
 *  - They belong to the audit and are kept apart from test cases, runs and results. A plan item says what was planned, not that it was tested, so it never
 *    counts towards a requirement having a test (`withoutTest`). A coverage gap says what the audit did not verify, and is shown on the requirement it names.
 *  - A plan item is the agent's proposal until a person owns it. A person owns an item once they edit it, decide it (approved / rejected) or add it themselves.
 *    An import updates or removes only items nobody owns; for an item a person owns, the agent's newer version (or its removal) waits in pending_json until a person
 *    applies or ignores it. An import never deletes an item a person owns, an empty test-plan.json included. A package without a test-plan.json leaves the plan as it is.
 *  - Every change is written to audit_plan_revisions, so the history says who changed what and when, and what the agent sent.
 *  - A reference to a requirement is kept as written (REQ-3, or a stable id such as REQ-LOCAL-002) and matched against the project's requirements when it is
 *    shown, so a requirement that is created later is found without another import.
 */

export type PlanAction = "new" | "unchanged" | "updated";
export interface PlanCounts { new: number; unchanged: number; updated: number; removed: number }
/** For plan items, `pending` counts the items a person owns where the agent sent a newer version or left the item out: they are kept, and the agent's version waits. */
export interface PlanItemCounts extends PlanCounts { pending: number }
export type PlanItemAction = PlanAction | "pending";
export interface PlanFields {
  title: string; type: string; risk: string; priority: string; readiness: string; preconditions: string; testData: string; steps: string[];
  acceptanceCriteria: string; automation: string; requirements: string[];
}
export type PlanStatus = "proposed" | "draft" | "approved" | "rejected";
const AGENT_LABEL = "Agent import";
export interface PlannedTestPlan {
  /** False when the package has no test-plan.json. */
  listed: boolean;
  planItems: { counts: PlanItemCounts; items: { sourceId: string; title: string; action: PlanItemAction }[]; removed: string[]; waiting: string[] };
  coverageGaps: { counts: PlanCounts; items: { sourceId: string; action: PlanAction }[]; removed: string[] };
  /** References to requirements that match no requirement of the project now. */
  unresolvedRefs: number;
  data: { planItems: PlanItem[]; coverageGaps: CoverageGapItem[] } | null;
}

const zero = (): PlanCounts => ({ new: 0, unchanged: 0, updated: 0, removed: 0 });
const zeroItems = (): PlanItemCounts => ({ ...zero(), pending: 0 });
/** A person owns an item that they added, edited or decided. The import leaves such an item alone. */
const owned = (r: Record<string, any>) => r.origin === "human" || r.review_status !== "proposed" || !!r.edited_at;
const refsOf = (r: { requirements: string[] }) => [...new Set(r.requirements.map((x) => x.trim()).filter(Boolean))];
const itemKey = (x: PlanFields) => JSON.stringify([x.title, x.type, x.risk, x.priority, x.readiness, x.preconditions, x.testData, x.steps, x.acceptanceCriteria, x.automation, x.requirements]);
const incomingItem = (p: PlanItem): PlanFields => ({ title: p.title, type: p.type, risk: p.risk, priority: p.priority, readiness: p.readiness ?? "", preconditions: p.preconditions, testData: p.testData, steps: p.steps, acceptanceCriteria: p.acceptanceCriteria, automation: p.automation, requirements: refsOf(p.refs) });
const storedItem = (r: Record<string, any>): PlanFields => ({ title: r.title, type: r.test_type, risk: r.risk, priority: r.priority, readiness: r.readiness, preconditions: r.preconditions, testData: r.test_data, steps: JSON.parse(r.steps) as string[], acceptanceCriteria: r.acceptance_criteria, automation: r.automation, requirements: JSON.parse(r.requirement_refs) as string[] });
const gapKey = (description: string, requirements: string[]) => JSON.stringify([description, requirements]);

/** What importing this package would do to the audit's plan, compared with what is stored now. Nothing is written. */
export function planTestPlan(pkg: ParsedPackage, project: { id: number; key: string }): PlannedTestPlan {
  const none: PlannedTestPlan = { listed: false, planItems: { counts: zeroItems(), items: [], removed: [], waiting: [] }, coverageGaps: { counts: zero(), items: [], removed: [] }, unresolvedRefs: 0, data: null };
  if (!pkg.testPlan) return none;
  const audit = db.prepare("SELECT id FROM audits WHERE project_id = ? AND agent_audit_id = ?").get(project.id, pkg.manifest.audit.id) as { id: number } | undefined;
  const oldItems = new Map((audit ? (db.prepare("SELECT * FROM audit_plan_items WHERE audit_id = ?").all(audit.id) as Record<string, any>[]) : []).map((r) => [r.source_id as string, r]));
  const oldGaps = new Map((audit ? (db.prepare("SELECT * FROM audit_coverage_gaps WHERE audit_id = ?").all(audit.id) as Record<string, any>[]) : []).map((r) => [r.source_id as string, r]));
  const out: PlannedTestPlan = { ...none, listed: true, data: pkg.testPlan };
  for (const p of pkg.testPlan.planItems) {
    const old = oldItems.get(p.sourceId);
    const inc = incomingItem(p);
    let action: PlanItemAction;
    if (!old) action = "new";
    else if (itemKey(storedItem(old)) === itemKey(inc)) action = "unchanged";
    else if (owned(old)) action = old.agent_hash === itemKey(inc) ? "unchanged" : "pending"; // kept as it is; an ignored version is not offered again
    else action = "updated";
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
  // An item the package leaves out goes only when nobody owns it. A person's own item is not the agent's to remove, and an owned agent item is kept with the removal waiting.
  const leftOut = [...oldItems.values()].filter((r) => r.origin === "agent");
  out.planItems.removed = leftOut.filter((r) => !owned(r)).map((r) => r.source_id as string);
  out.planItems.waiting = leftOut.filter((r) => owned(r)).map((r) => r.source_id as string);
  out.planItems.counts.removed = out.planItems.removed.length;
  out.planItems.counts.pending += out.planItems.waiting.length;
  out.coverageGaps.removed = [...oldGaps.keys()];
  out.coverageGaps.counts.removed = out.coverageGaps.removed.length;
  const lookup = (raw: string) => resolveRefs(project.id, project.key, { requirements: [raw], cases: [], tests: [] })[0];
  for (const raw of [...pkg.testPlan.planItems.flatMap((p) => refsOf(p.refs)), ...pkg.testPlan.coverageGaps.flatMap((g) => refsOf(g.refs))]) if (lookup(raw).state !== "resolved") out.unresolvedRefs++;
  return out;
}

type Who = { name: string; userId: number | null };
const agent: Who = { name: AGENT_LABEL, userId: null };
const person = (): Who => ({ name: actorName(), userId: actorUserId() });

/** Writes one entry of the history of a plan item. `snapshot` is the item's fields and status as they are after the change (for an agent version that waits: the agent's fields). */
function revise(auditId: number, sourceId: string, kind: string, who: Who, fields: PlanFields, status: string, note = "") {
  const rev = (db.prepare("SELECT COALESCE(MAX(rev), 0) + 1 AS n FROM audit_plan_revisions WHERE audit_id = ? AND source_id = ?").get(auditId, sourceId) as { n: number }).n;
  db.prepare("INSERT INTO audit_plan_revisions (audit_id, source_id, rev, kind, actor, actor_user_id, note, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(auditId, sourceId, rev, kind, who.name, who.userId, note, JSON.stringify({ fields, status }));
}
const COLS = "title = ?, test_type = ?, risk = ?, priority = ?, readiness = ?, preconditions = ?, test_data = ?, steps = ?, acceptance_criteria = ?, automation = ?, requirement_refs = ?";
const colValues = (f: PlanFields) => [f.title, f.type, f.risk, f.priority, f.readiness, f.preconditions, f.testData, JSON.stringify(f.steps), f.acceptanceCriteria, f.automation, JSON.stringify(f.requirements)];

/**
 * Brings the audit's plan in line with the package. Does nothing when the package has no test-plan.json. Call inside the import's transaction.
 * Items nobody owns follow the package (new, updated, removed). Items a person owns are never changed or removed: the agent's newer version, or its leaving the item out, waits.
 * Items a person added themselves are not the agent's and are never touched, not even by an empty plan.
 */
export function storeTestPlan(auditId: number, plan: PlannedTestPlan) {
  if (!plan.data) return;
  const old = new Map((db.prepare("SELECT * FROM audit_plan_items WHERE audit_id = ?").all(auditId) as Record<string, any>[]).map((r) => [r.source_id as string, r]));
  const insItem = db.prepare(`INSERT INTO audit_plan_items (audit_id, source_id, position, title, test_type, risk, priority, readiness, preconditions, test_data, steps, acceptance_criteria, automation, requirement_refs, agent_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  plan.data.planItems.forEach((p, i) => {
    const inc = incomingItem(p);
    const key = itemKey(inc);
    const row = old.get(p.sourceId);
    old.delete(p.sourceId);
    if (!row) {
      insItem.run(auditId, p.sourceId, i, inc.title, inc.type, inc.risk, inc.priority, inc.readiness, inc.preconditions, inc.testData, JSON.stringify(inc.steps), inc.acceptanceCriteria, inc.automation, JSON.stringify(inc.requirements), key);
      revise(auditId, p.sourceId, "agent_import", agent, inc, "proposed", "New proposal from the agent");
      return;
    }
    const cur = storedItem(row);
    const same = itemKey(cur) === key;
    if (!owned(row)) {
      db.prepare("UPDATE audit_plan_items SET position = ?, agent_hash = ? WHERE id = ?").run(i, key, row.id);
      if (!same) {
        db.prepare(`UPDATE audit_plan_items SET ${COLS} WHERE id = ?`).run(...colValues(inc), row.id);
        revise(auditId, p.sourceId, "agent_import", agent, inc, "proposed", "Updated by the agent");
      }
      return;
    }
    // A person owns it. A removal that was waiting is withdrawn if the agent brings the item back.
    const pending = row.pending_json ? JSON.parse(row.pending_json) : null;
    if (same) { if (pending) db.prepare("UPDATE audit_plan_items SET pending_json = NULL, agent_hash = ? WHERE id = ?").run(key, row.id); return; }
    if (row.agent_hash === key && !pending?.removed) return; // the agent sent this before and a person ignored it (or it already waits)
    db.prepare("UPDATE audit_plan_items SET pending_json = ?, agent_hash = ? WHERE id = ?").run(JSON.stringify({ item: inc }), key, row.id);
    revise(auditId, p.sourceId, "agent_sent", agent, inc, row.review_status, "The agent sent a newer version. It waits for a person to apply or ignore it.");
  });
  for (const row of old.values()) {
    if (row.origin !== "agent") continue; // a person's own item is not in the agent's package and is never removed by it
    if (!owned(row)) {
      db.prepare("DELETE FROM audit_plan_items WHERE id = ?").run(row.id);
      revise(auditId, row.source_id, "agent_removed", agent, storedItem(row), row.review_status, "Left out of the agent's newer plan");
    } else if (!(row.pending_json && JSON.parse(row.pending_json).removed)) {
      db.prepare("UPDATE audit_plan_items SET pending_json = ? WHERE id = ?").run(JSON.stringify({ removed: true }), row.id);
      revise(auditId, row.source_id, "removal_pending", agent, storedItem(row), row.review_status, "The agent's newer plan leaves this item out. It is kept until a person decides.");
    }
  }
  db.prepare("DELETE FROM audit_coverage_gaps WHERE audit_id = ?").run(auditId);
  const insGap = db.prepare("INSERT INTO audit_coverage_gaps (audit_id, source_id, position, description, requirement_refs) VALUES (?, ?, ?, ?, ?)");
  plan.data.coverageGaps.forEach((g, i) => insGap.run(auditId, g.sourceId, i, g.description, JSON.stringify(refsOf(g.refs))));
}

export const planCounts = (auditId: number) => ({
  planItems: (db.prepare("SELECT COUNT(*) AS n FROM audit_plan_items WHERE audit_id = ?").get(auditId) as { n: number }).n,
  coverageGaps: (db.prepare("SELECT COUNT(*) AS n FROM audit_coverage_gaps WHERE audit_id = ?").get(auditId) as { n: number }).n,
});

const FIELD_LABEL: Record<keyof PlanFields, string> = {
  title: "Title", type: "Type", risk: "Risk", priority: "Priority", readiness: "Readiness", preconditions: "Preconditions", testData: "Test data", steps: "Steps",
  acceptanceCriteria: "Acceptance criteria", automation: "Automation", requirements: "Requirements",
};
const shown = (v: string | string[]) => (Array.isArray(v) ? v.join("\n") : v);
/** What differs between two versions of an item, field by field, for the diff a person reads. */
export function planChanges(from: PlanFields, to: PlanFields): { field: string; from: string; to: string }[] {
  return (Object.keys(FIELD_LABEL) as (keyof PlanFields)[]).filter((k) => JSON.stringify(from[k]) !== JSON.stringify(to[k])).map((k) => ({ field: FIELD_LABEL[k], from: shown(from[k]), to: shown(to[k]) }));
}
/** The agent's newer version of an item a person owns, as a diff against what is there now; null when nothing waits. */
function pendingView(r: Record<string, any>) {
  if (!r.pending_json) return null;
  const p = JSON.parse(r.pending_json) as { item?: PlanFields; removed?: boolean };
  return p.removed ? { removed: true, changes: [] as { field: string; from: string; to: string }[] } : { removed: false, changes: planChanges(storedItem(r), p.item!) };
}

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
    origin: r.origin as "agent" | "human", status: r.review_status as PlanStatus,
    editedBy: (r.edited_by as string) || null, editedAt: r.edited_at as string | null, decidedBy: (r.decided_by as string) || null, decidedAt: r.decided_at as string | null,
    pending: pendingView(r),
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
    FROM audit_plan_items i JOIN audits a ON a.id = i.audit_id WHERE a.project_id = ? AND i.review_status != 'rejected' ORDER BY a.last_imported_at DESC, a.id DESC, i.position`).all(q.projectId) as Record<string, any>[])
    .filter((r) => names(r.refs)).map(({ refs: _refs, ...r }) => r);
  const coverageGaps = (db.prepare(`SELECT g.source_id AS sourceId, g.description, g.requirement_refs AS refs, a.id AS auditId, a.agent_audit_id AS agentAuditId, a.title AS auditTitle
    FROM audit_coverage_gaps g JOIN audits a ON a.id = g.audit_id WHERE a.project_id = ? ORDER BY a.last_imported_at DESC, a.id DESC, g.position`).all(q.projectId) as Record<string, any>[])
    .filter((r) => names(r.refs)).map(({ refs: _refs, ...r }) => r);
  return { planItems, coverageGaps };
}

// ---- what a person does with the plan ----

const itemRow = (auditId: number, sourceId: string) => {
  const r = db.prepare("SELECT * FROM audit_plan_items WHERE audit_id = ? AND source_id = ?").get(auditId, sourceId) as Record<string, any> | undefined;
  if (!r) throw new AuditError(404, "Plan item not found");
  return r;
};
const cleanList = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
const normalize = (f: PlanFields): PlanFields => ({ ...f, title: f.title.trim(), steps: f.steps.map((x) => x.trim()).filter(Boolean), requirements: cleanList(f.requirements) });
const stamp = (w: Who) => ["edited_by = ?, edited_by_user_id = ?, edited_at = datetime('now')", [w.name, w.userId]] as const;

/** A person edits a plan item. The item becomes theirs (a draft, also when it was approved or rejected: the decision was about the earlier text). No change, no entry. */
export function editPlanItem(auditId: number, sourceId: string, patch: Partial<PlanFields>) {
  const row = itemRow(auditId, sourceId);
  const cur = storedItem(row);
  const next = normalize({ ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
  if (!next.title) throw new AuditError(400, "A plan item needs a title");
  if (itemKey(next) === itemKey(cur)) return;
  const w = person();
  const [sets, vals] = stamp(w);
  db.transaction(() => {
    db.prepare(`UPDATE audit_plan_items SET ${COLS}, review_status = 'draft', ${sets} WHERE id = ?`).run(...colValues(next), ...vals, row.id);
    revise(auditId, sourceId, "edited", w, next, "draft", row.review_status === "draft" ? "" : row.review_status === "proposed" ? "Taken over from the agent's proposal" : `Back to draft: the ${row.review_status} decision was about the earlier text`);
  })();
}

/** A person saves an item as a draft, approves it or rejects it. Approving and rejecting record who decided and when; nothing but a person gets here. */
export function decidePlanItem(auditId: number, sourceId: string, status: "draft" | "approved" | "rejected", note?: string) {
  const row = itemRow(auditId, sourceId);
  if (row.review_status === status) return;
  const w = person();
  db.transaction(() => {
    if (status === "draft") {
      const [sets, vals] = stamp(w);
      db.prepare(`UPDATE audit_plan_items SET review_status = 'draft', ${sets} WHERE id = ?`).run(...vals, row.id);
    } else {
      db.prepare("UPDATE audit_plan_items SET review_status = ?, decided_by = ?, decided_by_user_id = ?, decided_at = datetime('now') WHERE id = ?").run(status, w.name, w.userId, row.id);
    }
    revise(auditId, sourceId, status, w, storedItem(row), status, note?.trim() ?? "");
  })();
}

/** A person applies or ignores the agent's newer version (or its removal) of an item they own. Applying takes the agent's text as a draft, to be approved again. */
export function resolvePending(auditId: number, sourceId: string, action: "apply" | "ignore") {
  const row = itemRow(auditId, sourceId);
  if (!row.pending_json) throw new AuditError(409, "The agent has not sent a newer version of this item");
  const pending = JSON.parse(row.pending_json) as { item?: PlanFields; removed?: boolean };
  const w = person();
  db.transaction(() => {
    if (action === "ignore") {
      db.prepare("UPDATE audit_plan_items SET pending_json = NULL WHERE id = ?").run(row.id);
      revise(auditId, sourceId, "ignored_agent", w, storedItem(row), row.review_status, pending.removed ? "Kept the item; the agent's removal was ignored" : "Ignored the agent's newer version");
    } else if (pending.removed) {
      revise(auditId, sourceId, "removed_by_agent", w, storedItem(row), row.review_status, "Removed, as the agent's newer plan left it out");
      db.prepare("DELETE FROM audit_plan_items WHERE id = ?").run(row.id);
    } else {
      const [sets, vals] = stamp(w);
      db.prepare(`UPDATE audit_plan_items SET ${COLS}, review_status = 'draft', pending_json = NULL, ${sets} WHERE id = ?`).run(...colValues(pending.item!), ...vals, row.id);
      revise(auditId, sourceId, "applied_agent", w, pending.item!, "draft", "Applied the agent's newer version");
    }
  })();
}

/** A person adds an item of their own. It is theirs from the start (origin human, a draft) and the agent's imports never touch it. Returns the id it was given. */
export function addPlanItem(auditId: number, fields: Pick<PlanFields, "title"> & Partial<PlanFields>) {
  if (!db.prepare("SELECT 1 FROM audits WHERE id = ?").get(auditId)) throw new AuditError(404, "Audit not found");
  const f = normalize({ type: "", risk: "", priority: "", readiness: "", preconditions: "", testData: "", steps: [], acceptanceCriteria: "", automation: "", requirements: [], ...fields });
  if (!f.title) throw new AuditError(400, "A plan item needs a title");
  const w = person();
  return db.transaction(() => {
    let n = (db.prepare("SELECT COUNT(*) AS n FROM audit_plan_items WHERE audit_id = ? AND origin = 'human'").get(auditId) as { n: number }).n + 1;
    while (db.prepare("SELECT 1 FROM audit_plan_items WHERE audit_id = ? AND source_id = ?").get(auditId, `H-${n}`)) n++;
    const sourceId = `H-${n}`;
    const position = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM audit_plan_items WHERE audit_id = ?").get(auditId) as { p: number }).p;
    db.prepare(`INSERT INTO audit_plan_items (audit_id, source_id, position, title, test_type, risk, priority, readiness, preconditions, test_data, steps, acceptance_criteria, automation, requirement_refs,
        origin, review_status, edited_by, edited_by_user_id, edited_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human', 'draft', ?, ?, datetime('now'))`)
      .run(auditId, sourceId, position, f.title, f.type, f.risk, f.priority, f.readiness, f.preconditions, f.testData, JSON.stringify(f.steps), f.acceptanceCriteria, f.automation, JSON.stringify(f.requirements), w.name, w.userId);
    revise(auditId, sourceId, "created", w, f, "draft", "Added by a person");
    return sourceId;
  })();
}

/** The history of the audit's plan, oldest first: every entry says what happened, who did it and what changed against the item as it stood. */
export function planHistory(auditId: number) {
  if (!db.prepare("SELECT 1 FROM audits WHERE id = ?").get(auditId)) throw new AuditError(404, "Audit not found");
  const rows = db.prepare("SELECT * FROM audit_plan_revisions WHERE audit_id = ? ORDER BY id").all(auditId) as Record<string, any>[];
  const standing = new Map<string, PlanFields>(); // the item's text as it stood, to compare each entry against
  const sent = new Set(["agent_sent", "removal_pending", "ignored_agent", "removed_by_agent"]);
  return rows.map((r) => {
    const snap = JSON.parse(r.snapshot) as { fields: PlanFields; status: string };
    const before = standing.get(r.source_id);
    const changes = r.kind === "agent_sent" || !sent.has(r.kind) ? (before ? planChanges(before, snap.fields) : []) : [];
    if (!sent.has(r.kind)) standing.set(r.source_id, snap.fields);
    return {
      id: r.id as number, sourceId: r.source_id as string, rev: r.rev as number, at: r.at as string, kind: r.kind as string, actor: r.actor as string, byAgent: r.actor_user_id === null && r.actor === AGENT_LABEL,
      note: r.note as string, title: snap.fields.title, status: snap.status, changes,
    };
  });
}
