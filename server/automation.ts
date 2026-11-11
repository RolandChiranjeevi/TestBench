import { db } from "./db.ts";
import { actorName, actorUserId } from "./actor.ts";
import { AuditError, resolveRefs } from "./auditcommon.ts";
import { planItemForSuggestion, type PlanFields } from "./auditplan.ts";
import { addRequirementCases } from "./requirements.ts";

/**
 * Automation suggestions: a structured suggestion for automating something a person has approved (here: a plan item).
 *  - It is made by a fixed rule. There is no model behind it, no network and no code generation: the same plan item always gives the same suggestion. `origin` is 'rule';
 *    'agent' is kept for an agent that proposes suggestions later. A suggestion is never called AI here: it says it was made by a rule.
 *  - It is only ever a suggestion. Nothing is generated, run or changed until a person decides. A person edits it, approves it, rejects it, or ignores it (puts it aside:
 *    hidden by default, can be put back, and not made again). Reject is a decision that stays; ignore is not.
 *  - One suggestion per plan item and rule, ever. Asking again makes no duplicate, and a rejected or ignored suggestion is not made again.
 *  - Only an approved plan item gets one. When the plan item changes afterwards, the suggestion says so.
 *  - Apply makes a DRAFT test case of the suggestion, linked to the requirements the plan item names. It never makes a ready test case and never approves anything: whether the
 *    test case is ready (and counts as coverage) is a separate decision by a person.
 *  - Every change is written to automation_suggestion_revisions: who did what and when.
 */

export const RULE = "scripted_from_plan_item";
export const RULE_LABEL = "rule: scripted from plan item";
export type SuggestionStatus = "proposed" | "draft" | "approved" | "rejected" | "ignored";
export interface SuggestionContent { summary: string; steps: string[]; assertions: string[]; testData: string; plan: string }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** The lines of a text, without list markers (`-`, `*`, `1.`), empty ones dropped. */
const linesOf = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean);

/** What kind of test the plan item's type points to. Fixed words, in this order; anything else is an end-to-end test of the user flow. */
export function approachFor(type: string): string {
  const t = type.toLowerCase();
  if (/\b(api|service|contract)\b/.test(t)) return "an API-level test";
  if (/(perf|load|stress)/.test(t)) return "a load test with a threshold";
  if (/(access|a11y|wcag)/.test(t)) return "an accessibility check";
  if (/(secur|privacy)/.test(t)) return "a security check";
  return "an end-to-end test of the user flow";
}

/**
 * The rule. From a plan item's own fields: the automation steps (its steps, after its preconditions), the checks (its acceptance criteria, one per line), its test data, and a short
 * plan (which kind of test, priority and risk, what is needed first). Without steps or without acceptance criteria nothing is generated, and the reason says which is missing.
 */
export function suggestFromPlanItem(f: PlanFields): { content: SuggestionContent } | { reason: string } {
  const steps = f.steps.map((s) => s.trim()).filter(Boolean);
  const assertions = linesOf(f.acceptanceCriteria).slice(0, 20).map((a) => clip(a, 500));
  const missing = [!steps.length && "steps", !assertions.length && "acceptance criteria"].filter(Boolean) as string[];
  if (missing.length) return { reason: `Nothing was generated: the plan item has no ${missing.join(" and ")}. Add ${missing.length === 2 ? "them" : "it"} to the plan item and ask again.` };
  const approach = approachFor(f.type);
  const setup = f.preconditions.trim();
  const testData = f.testData.trim();
  const allSteps = [...(setup ? [`Set up: ${setup}`] : []), ...steps];
  return {
    content: {
      summary: clip(`Automate “${f.title}” as ${approach}: ${plural(allSteps.length, "step")} and ${plural(assertions.length, "check")}.`, 300),
      steps: allSteps,
      assertions,
      testData,
      plan: [
        `Approach: ${approach}.`,
        `Priority ${f.priority || "not set"}, risk ${f.risk || "not set"}.`,
        `Needed before scripting: ${setup || "no preconditions recorded"}. Test data: ${testData || "none recorded"}.`,
        ...(f.automation.trim() ? [`Note in the plan item: ${f.automation.trim()}`] : []),
        "A person writes and runs the test. Nothing is generated or run by TestBench.",
      ].join("\n"),
    },
  };
}

// ---- the store ----

type Who = { name: string; userId: number | null };
const ruleWho: Who = { name: "Rule: scripted from plan item", userId: null };
const person = (): Who => ({ name: actorName(), userId: actorUserId() });
const stamp = (w: Who) => ["edited_by = ?, edited_by_user_id = ?, edited_at = datetime('now')", [w.name, w.userId]] as const;
const FIELD_LABEL: Record<keyof SuggestionContent, string> = { summary: "Summary", steps: "Steps", assertions: "Checks", testData: "Test data", plan: "Plan" };

const contentOf = (r: Record<string, any>): SuggestionContent => ({
  summary: r.summary, steps: JSON.parse(r.steps) as string[], assertions: JSON.parse(r.assertions) as string[], testData: r.test_data, plan: r.plan,
});
const changesOf = (from: SuggestionContent, to: SuggestionContent) => {
  const show = (v: string | string[]) => (Array.isArray(v) ? v.join("\n") : v);
  return (Object.keys(FIELD_LABEL) as (keyof SuggestionContent)[]).filter((k) => JSON.stringify(from[k]) !== JSON.stringify(to[k])).map((k) => ({ field: FIELD_LABEL[k], from: show(from[k]), to: show(to[k]) }));
};
const keyOf = (c: SuggestionContent) => JSON.stringify([c.summary, c.steps, c.assertions, c.testData, c.plan]);

function revise(id: number, kind: string, who: Who, content: SuggestionContent, status: string, note = "") {
  const rev = (db.prepare("SELECT COALESCE(MAX(rev), 0) + 1 AS n FROM automation_suggestion_revisions WHERE suggestion_id = ?").get(id) as { n: number }).n;
  db.prepare("INSERT INTO automation_suggestion_revisions (suggestion_id, rev, kind, actor, actor_user_id, note, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, rev, kind, who.name, who.userId, note, JSON.stringify({ content, status }));
}

const caseKey = (projectId: number, number: number) => `${(db.prepare("SELECT key FROM projects WHERE id = ?").get(projectId) as { key: string }).key}-${number}`;

const rowOf = (id: number) => {
  const r = db.prepare("SELECT * FROM automation_suggestions WHERE id = ?").get(id) as Record<string, any> | undefined;
  if (!r) throw new AuditError(404, "Automation suggestion not found");
  return r;
};

/** One suggestion for its view: what it says, who made it, what became of it, whether its plan item has changed since, the draft test case made of it, and its history. */
function view(r: Record<string, any>) {
  const item = r.audit_id ? planItemForSuggestion(r.audit_id, r.subject_ref) : null;
  const revs = db.prepare("SELECT * FROM automation_suggestion_revisions WHERE suggestion_id = ? ORDER BY id").all(r.id) as Record<string, any>[];
  let before: SuggestionContent | null = null;
  const history = revs.map((h) => {
    const snap = JSON.parse(h.snapshot) as { content: SuggestionContent; status: string };
    const out = { rev: h.rev as number, at: h.at as string, kind: h.kind as string, actor: h.actor as string, byRule: h.actor_user_id === null, note: h.note as string, status: snap.status, changes: before ? changesOf(before, snap.content) : [] };
    before = snap.content;
    return out;
  });
  const c = r.case_id ? (db.prepare("SELECT id, number, project_id FROM cases WHERE id = ?").get(r.case_id) as { id: number; number: number; project_id: number } | undefined) : undefined;
  return {
    id: r.id as number, auditId: r.audit_id as number | null, sourceId: r.subject_ref as string, subjectKind: r.subject_kind as string, rule: r.rule as string, origin: r.origin as "rule" | "agent",
    proposedBy: r.proposed_by as string, label: r.origin === "rule" ? "Suggested by rule" : "Suggested by an agent",
    ...contentOf(r), status: r.review_status as SuggestionStatus,
    editedBy: (r.edited_by as string) || null, editedAt: r.edited_at as string | null, decidedBy: (r.decided_by as string) || null, decidedAt: r.decided_at as string | null,
    /** The plan item's text has changed since this was suggested (or the plan item is gone). */
    subjectChanged: !item || item.hash !== r.subject_hash, subjectGone: !item,
    testCase: c ? { id: c.id, number: c.number, key: caseKey(c.project_id, c.number) } : null,
    createdAt: r.created_at as string, history,
  };
}
export type SuggestionView = ReturnType<typeof view>;

/** One suggestion, for its view. */
export const getAutomationSuggestion = (id: number) => view(rowOf(id));

/** The suggestions of one audit, oldest first. Ignored ones are included: the page hides them by default. */
export function listAutomationSuggestions(auditId: number) {
  if (!db.prepare("SELECT 1 FROM audits WHERE id = ?").get(auditId)) throw new AuditError(404, "Audit not found");
  return (db.prepare("SELECT * FROM automation_suggestions WHERE audit_id = ? ORDER BY id").all(auditId) as Record<string, any>[]).map(view);
}

/**
 * A person asks for an automation suggestion for an approved plan item. The rule makes it, as `proposed`. Asking again makes no second one; a rejected or ignored one is not made again.
 * Returns what was made (nothing, when there is nothing to make) and a message that says why.
 */
export function suggestAutomation(auditId: number, sourceId: string): { created: SuggestionView[]; message: string } {
  const audit = db.prepare("SELECT id, project_id FROM audits WHERE id = ?").get(auditId) as { id: number; project_id: number } | undefined;
  if (!audit) throw new AuditError(404, "Audit not found");
  const item = planItemForSuggestion(auditId, sourceId);
  if (!item) throw new AuditError(404, "Plan item not found");
  if (item.status !== "approved") throw new AuditError(409, "Approve the plan item first. Automation is only suggested for an approved plan item.");
  const made = suggestFromPlanItem(item.fields);
  if ("reason" in made) return { created: [], message: made.reason };
  const existing = db.prepare("SELECT * FROM automation_suggestions WHERE project_id = ? AND subject_kind = 'plan_item' AND audit_id = ? AND subject_ref = ? AND rule = ?").get(audit.project_id, auditId, sourceId, RULE) as Record<string, any> | undefined;
  if (existing) {
    const status = existing.review_status as SuggestionStatus;
    return { created: [], message: status === "rejected" || status === "ignored" ? `This plan item already has a suggestion, and you ${status === "rejected" ? "rejected" : "ignored"} it. It is not made again.` : "This plan item already has a suggestion." };
  }
  const asker = person();
  const c = made.content;
  const id = db.transaction(() => {
    const newId = (db.prepare(`INSERT INTO automation_suggestions (project_id, audit_id, subject_kind, subject_ref, rule, origin, proposed_by, summary, steps, assertions, test_data, plan, original, subject_hash)
        VALUES (?, ?, 'plan_item', ?, ?, 'rule', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .get(audit.project_id, auditId, sourceId, RULE, RULE_LABEL, c.summary, JSON.stringify(c.steps), JSON.stringify(c.assertions), c.testData, c.plan, JSON.stringify(c), item.hash) as { id: number }).id;
    revise(newId, "suggested", ruleWho, c, "proposed", `Made by a fixed rule when ${asker.name} asked.`);
    return newId;
  })();
  return { created: [view(rowOf(id))], message: "" };
}

function normalize(c: SuggestionContent): SuggestionContent {
  return { summary: c.summary.trim(), steps: c.steps.map((s) => s.trim()).filter(Boolean), assertions: c.assertions.map((s) => s.trim()).filter(Boolean), testData: c.testData.trim(), plan: c.plan.trim() };
}

/** A person edits a suggestion. It becomes theirs (a draft, also when it was approved or rejected: the decision was about the earlier text). No change, no entry. */
export function editAutomationSuggestion(id: number, patch: Partial<SuggestionContent>) {
  const r = rowOf(id);
  const cur = contentOf(r);
  const next = normalize({ ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
  if (!next.summary) throw new AuditError(400, "A suggestion needs a summary");
  if (!next.steps.length) throw new AuditError(400, "A suggestion needs at least one step");
  if (keyOf(next) === keyOf(cur)) return;
  const w = person();
  const [sets, vals] = stamp(w);
  db.transaction(() => {
    db.prepare(`UPDATE automation_suggestions SET summary = ?, steps = ?, assertions = ?, test_data = ?, plan = ?, review_status = 'draft', ${sets} WHERE id = ?`)
      .run(next.summary, JSON.stringify(next.steps), JSON.stringify(next.assertions), next.testData, next.plan, ...vals, id);
    revise(id, "edited", w, next, "draft", r.review_status === "draft" ? "" : r.review_status === "proposed" ? "Taken over from the rule's suggestion" : `Back to draft: the ${r.review_status} decision was about the earlier text`);
  })();
}

/**
 * A person saves as a draft, approves, rejects or ignores a suggestion, or puts an ignored one back to Suggested. Approve, reject and ignore record who decided and when.
 * Only an ignored suggestion can be put back (a rejection is a decision that stays, though it can still be changed by approving or editing).
 */
export function decideAutomationSuggestion(id: number, status: "draft" | "approved" | "rejected" | "ignored" | "proposed", note?: string) {
  const r = rowOf(id);
  if (r.review_status === status) return;
  if (status === "proposed" && r.review_status !== "ignored") throw new AuditError(409, "Only an ignored suggestion can be put back to Suggested.");
  const w = person();
  db.transaction(() => {
    if (status === "draft") {
      const [sets, vals] = stamp(w);
      db.prepare(`UPDATE automation_suggestions SET review_status = 'draft', ${sets} WHERE id = ?`).run(...vals, id);
    } else if (status === "proposed") {
      db.prepare("UPDATE automation_suggestions SET review_status = 'proposed' WHERE id = ?").run(id);
    } else {
      db.prepare("UPDATE automation_suggestions SET review_status = ?, decided_by = ?, decided_by_user_id = ?, decided_at = datetime('now') WHERE id = ?").run(status, w.name, w.userId, id);
    }
    revise(id, status === "proposed" ? "restored" : status, w, contentOf(r), status, note?.trim() ?? "");
  })();
}

/** The priority a test case gets from the plan item's words: critical, high or low when it says so, otherwise medium. */
const casePriority = (raw: string) => (/crit|\bp0\b/i.test(raw) ? "critical" : /high|\bp1\b/i.test(raw) ? "high" : /low|\bp3\b/i.test(raw) ? "low" : "medium");

/**
 * A person applies a suggestion: a DRAFT test case is made of it, linked to the requirements the plan item names, in one transaction. The test case is never ready and the
 * suggestion is never approved by this: the suggestion becomes a draft (when it was still only suggested), and approving it, or making the test case ready, is a decision of its own.
 * Applying twice makes no second test case. A rejected or ignored suggestion has to be changed or put back first.
 */
export function applyAutomationSuggestion(id: number) {
  const r = rowOf(id);
  if (r.review_status === "ignored") throw new AuditError(409, "This suggestion was ignored. Put it back to Suggested first.");
  if (r.review_status === "rejected") throw new AuditError(409, "This suggestion was rejected. Approve or edit it first if you want to apply it.");
  if (r.case_id) {
    const c = db.prepare("SELECT number FROM cases WHERE id = ?").get(r.case_id) as { number: number } | undefined;
    if (c) throw new AuditError(409, `This suggestion is already the test case ${caseKey(r.project_id, c.number)}.`);
  }
  const item = r.audit_id ? planItemForSuggestion(r.audit_id, r.subject_ref) : null;
  if (!item) throw new AuditError(409, "The plan item is gone, so there is nothing to link the test case to.");
  const c = contentOf(r);
  const f = item.fields;
  const w = person();
  const project = db.prepare("SELECT id, key FROM projects WHERE id = ?").get(r.project_id) as { id: number; key: string };
  return db.transaction(() => {
    const n = db.prepare("UPDATE projects SET next_case_number = next_case_number + 1 WHERE id = ? RETURNING next_case_number - 1 AS n").get(project.id) as { n: number };
    const pos = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM cases WHERE project_id = ?").get(project.id) as { p: number }).p;
    const description = [c.summary, c.plan, c.testData ? `Test data: ${c.testData}` : ""].filter(Boolean).join("\n\n");
    const caseId = (db.prepare(`INSERT INTO cases (project_id, suite_id, number, title, description, preconditions, priority, status, tags, position)
        VALUES (?, NULL, ?, ?, ?, ?, ?, 'draft', ?, ?) RETURNING id`)
      .get(project.id, n.n, f.title, description, f.preconditions, casePriority(f.priority), JSON.stringify(["automation-suggestion"]), pos) as { id: number }).id;
    c.steps.forEach((action, i) => db.prepare("INSERT INTO case_steps (case_id, position, action, expected) VALUES (?, ?, ?, ?)").run(caseId, i, action, i === c.steps.length - 1 ? c.assertions.join("\n") : ""));
    for (const raw of f.requirements) {
      const ref = resolveRefs(project.id, project.key, { requirements: [raw], cases: [], tests: [] })[0];
      if (ref.state === "resolved" && ref.requirementId) addRequirementCases(ref.requirementId, project.id, [caseId]);
    }
    if (r.review_status === "proposed") {
      const [sets, vals] = stamp(w);
      db.prepare(`UPDATE automation_suggestions SET review_status = 'draft', case_id = ?, ${sets} WHERE id = ?`).run(caseId, ...vals, id);
    } else {
      db.prepare("UPDATE automation_suggestions SET case_id = ? WHERE id = ?").run(caseId, id);
    }
    const status = r.review_status === "proposed" ? "draft" : r.review_status;
    revise(id, "applied", w, c, status, `Draft test case ${project.key}-${n.n} made. It is a draft: making it ready is a separate decision.`);
    return { caseId, number: n.n, key: `${project.key}-${n.n}` };
  })();
}
