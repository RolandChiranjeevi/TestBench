import { db, parseJson } from "./db.ts";
import { actorName, actorUserId } from "./actor.ts";
import { AuditError, resolveRefs } from "./auditcommon.ts";
import { planItemForSuggestion, type PlanFields } from "./auditplan.ts";
import { addRequirementCases } from "./requirements.ts";
import type { Viewport } from "./shapes.ts";

/**
 * Automation suggestions: a structured suggestion for automating something a person has approved: a plan item, or a requirement.
 *  - It is made by a fixed rule. There is no model behind it, no network and no code generation: the same plan item always gives the same suggestion. `origin` is 'rule';
 *    'agent' is kept for an agent that proposes suggestions later. A suggestion is never called AI here: it says it was made by a rule.
 *  - It is only ever a suggestion. Nothing is generated, run or changed until a person decides. A person edits it, approves it, rejects it, or ignores it (puts it aside:
 *    hidden by default, can be put back, and not made again). Reject is a decision that stays; ignore is not.
 *  - One suggestion per plan item (or requirement) and rule, ever. Asking again makes no duplicate, and a rejected or ignored suggestion is not made again.
 *  - Only an approved plan item, or an approved requirement, gets one. When it changes afterwards, the suggestion says so.
 *  - Apply makes a DRAFT test case of the suggestion, linked to the requirements the plan item names (or to the requirement itself). It never makes a ready test case and never approves anything: whether the
 *    test case is ready (and counts as coverage) is a separate decision by a person.
 *  - Every change is written to automation_suggestion_revisions: who did what and when (the text of a spec included).
 *  - A spec suggestion (E1) is the same thing with a Playwright spec file as its text. It is made from a fixed template: steps and checks become `test.step` calls and TODO comments, with
 *    `test.fixme` in front so that nothing runs by accident, and no selector or URL is invented. Every word from the plan item goes in as a JSON string or a cleaned comment, so text
 *    cannot turn into code. Apply makes it a draft spec: it is recorded who and when, and only then can the file be downloaded. Nothing is run, and nothing is written to disk or to git.
 */

export const RULE = "scripted_from_plan_item";
export const RULE_LABEL = "rule: scripted from plan item";
export type SuggestionStatus = "proposed" | "draft" | "approved" | "rejected" | "ignored";
export interface SuggestionContent { summary: string; steps: string[]; assertions: string[]; testData: string; plan: string; artifactText?: string }

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

export const RULE_REQUIREMENT = "scripted_from_requirement";
export const RULE_REQUIREMENT_LABEL = "rule: scripted from requirement";
export interface RequirementFields { title: string; description: string; acceptanceCriteria: string; kind: string; priority: string; wcag: string[]; viewports: Viewport[] }
const viewportText = (v: Viewport) => [v.device, v.width && v.height ? `${v.width}x${v.height}` : v.width ? `${v.width}px wide` : "", v.breakpoint].filter(Boolean).join(" ");

/**
 * The rule for a requirement. The checks are its acceptance criteria, one per line; without acceptance criteria nothing is generated. A requirement has no steps of its own, so the steps are
 * a skeleton (the situation its description names, then "do what the requirement asks for") that a person rewrites into concrete ones, and the plan says so. The test data is the WCAG
 * criteria and viewports the requirement lists. The kind of test follows the requirement's kind and WCAG criteria.
 */
export function suggestFromRequirement(f: RequirementFields): { content: SuggestionContent } | { reason: string } {
  const assertions = linesOf(f.acceptanceCriteria).slice(0, 20).map((a) => clip(a, 500));
  if (!assertions.length) return { reason: "Nothing was generated: the requirement has no acceptance criteria. Add them to the requirement and ask again." };
  const approach = f.kind === "security_privacy" ? "a security check" : f.wcag.length ? "an accessibility check" : "an end-to-end test of the user flow";
  const firstLine = linesOf(f.description)[0] ?? "";
  const steps = [...(firstLine ? [`Set up the situation the requirement describes: ${clip(firstLine, 300)}`] : []), `Do what the requirement asks for: ${f.title}`];
  const testData = [f.wcag.length ? `WCAG criteria: ${f.wcag.join(", ")}` : "", f.viewports.length ? `Viewports: ${f.viewports.map(viewportText).join("; ")}` : ""].filter(Boolean).join("\n");
  return {
    content: {
      summary: clip(`Automate the requirement “${f.title}” as ${approach}: ${plural(steps.length, "step")} (a skeleton to rewrite) and ${plural(assertions.length, "check")}.`, 300),
      steps,
      assertions,
      testData,
      plan: [
        `Approach: ${approach}.`,
        `Priority ${f.priority || "not set"}.`,
        "A requirement has no steps of its own: the steps are a skeleton, to be rewritten into concrete steps before scripting.",
        `Test data: ${testData ? "taken from the requirement's WCAG criteria and viewports" : "none recorded"}.`,
        "A person writes and runs the test. Nothing is generated or run by TestBench.",
      ].join("\n"),
    },
  };
}

// ---- the spec template (E1) ----

export const RULE_SPEC_PLAN_ITEM = "playwright_spec_from_plan_item";
export const RULE_SPEC_PLAN_ITEM_LABEL = "rule: playwright spec from plan item";
/** Control characters (C0, DEL, C1), the invisible and directional ones (zero width, bidi overrides and isolates, line and paragraph separators, BOM). None of them may reach a spec. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
/** One clean line of text: unsafe characters are spaces, white space is one space, and it is cut at `max`. */
export const cleanText = (s: string, max = 300) => clip(s.replace(UNSAFE, " ").replace(/\s+/g, " ").trim(), max);
/** Text as a string literal: cleaned, then JSON-escaped, so a quote, a backslash or `${` can never end the string or start code. */
const lit = (s: string, max = 300) => JSON.stringify(cleanText(s, max));

/** `<ref>-<title>.spec.ts` in lower case letters, digits and hyphens only: no path, no space, no dot but the extension. */
export function specFileName(ref: string, title: string) {
  const slug = `${ref} ${title}`.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
  return `${slug || "spec"}.spec.ts`;
}

/**
 * The spec, from a template. The only lines are comments, the import, `test.describe`, `test`, `test.fixme` (always there: a finished spec has it removed by a person), `test.step` per step
 * and the closing lines. Text from the source is a JSON string literal or a cleaned `//` comment. No selector and no URL is made up: every step has a TODO for a person to write.
 */
export function buildSpec(a: { source: string; title: string; steps: string[]; assertions: string[]; testData: string }): string {
  const data = a.testData.split(/\r?\n/).map((l) => cleanText(l)).filter(Boolean).slice(0, 10);
  return [
    `// DRAFT: made by TestBench from ${cleanText(a.source, 200)} by a fixed rule. Not reviewed and not run.`,
    "// A person rewrites every TODO. Remove test.fixme only when the test is finished and reviewed.",
    'import { test, expect } from "@playwright/test";',
    "",
    `test.describe(${lit(a.title, 200)}, () => {`,
    `  test(${lit(a.title, 200)}, async ({ page }) => {`,
    '    test.fixme(true, "Draft from TestBench: not reviewed, not run. Remove this line when a person has finished the test.");',
    ...(data.length ? ["    // Test data (from the source):", ...data.map((l) => `    //   ${l}`)] : []),
    ...a.steps.flatMap((s) => [`    await test.step(${lit(s)}, async () => {`, "      // TODO: where this starts and what to do (no selector or URL is known here)", "    });"]),
    "    // Checks (from the acceptance criteria):",
    ...a.assertions.map((c) => `    // TODO: expect(...) for: ${cleanText(c)}`),
    "  });",
    "});",
    "",
  ].join("\n");
}

/** The spec suggestion for a plan item. Without steps or without acceptance criteria nothing is made, for the same reason as the automation suggestion. */
export function suggestSpecFromPlanItem(f: PlanFields, ref: string): { content: SuggestionContent; fileName: string } | { reason: string } {
  const base = suggestFromPlanItem(f);
  if ("reason" in base) return base;
  const { steps, assertions, testData } = base.content;
  const fileName = specFileName(ref, f.title);
  return {
    fileName,
    content: {
      summary: clip(`Playwright spec ${fileName} for “${f.title}”: ${plural(steps.length, "step")} and ${plural(assertions.length, "check")}, as a draft to finish.`, 300),
      steps, assertions, testData,
      plan: ["Draft Playwright spec from the plan item's steps and acceptance criteria.", "It starts with test.fixme, and every step and check is a TODO for a person to write: no selector or URL is known.", "Nothing is run by TestBench and nothing is written to disk or to git. Download it after Apply."].join("\n"),
      artifactText: buildSpec({ source: `plan item ${ref}`, title: f.title, steps, assertions, testData }),
    },
  };
}

// ---- the store ----

type Who = { name: string; userId: number | null };
const ruleWho: Who = { name: "Rule: scripted from plan item", userId: null };
const ruleWhoRequirement: Who = { name: "Rule: scripted from requirement", userId: null };
const person = (): Who => ({ name: actorName(), userId: actorUserId() });
const stamp = (w: Who) => ["edited_by = ?, edited_by_user_id = ?, edited_at = datetime('now')", [w.name, w.userId]] as const;
const FIELD_LABEL: Record<keyof SuggestionContent, string> = { summary: "Summary", steps: "Steps", assertions: "Checks", testData: "Test data", plan: "Plan", artifactText: "Spec text" };

const contentOf = (r: Record<string, any>): SuggestionContent => ({
  summary: r.summary, steps: JSON.parse(r.steps) as string[], assertions: JSON.parse(r.assertions) as string[], testData: r.test_data, plan: r.plan, artifactText: r.artifact_text as string,
});
const changesOf = (from: SuggestionContent, to: SuggestionContent) => {
  const show = (v: string | string[]) => (Array.isArray(v) ? v.join("\n") : v);
  return (Object.keys(FIELD_LABEL) as (keyof SuggestionContent)[]).filter((k) => (k !== "artifactText" || !!from.artifactText || !!to.artifactText) && JSON.stringify(from[k]) !== JSON.stringify(to[k])).map((k) => ({ field: FIELD_LABEL[k], from: show(from[k] ?? ""), to: show(to[k] ?? "") }));
};
const keyOf = (c: SuggestionContent) => JSON.stringify([c.summary, c.steps, c.assertions, c.testData, c.plan, c.artifactText ?? ""]);

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

/** What a suggestion is about, as it is now: its title and priority, a fingerprint of its text (to tell later that it has changed), and the requirements a test case made of it is linked to. */
interface SubjectNow { title: string; hash: string; preconditions: string; priority: string; link: (projectId: number, projectKey: string) => number[] }
const requirementRow = (id: number) => db.prepare("SELECT * FROM requirements WHERE id = ?").get(id) as Record<string, any> | undefined;
const requirementFields = (q: Record<string, any>): RequirementFields => ({
  title: q.title, description: q.description, acceptanceCriteria: q.acceptance_criteria, kind: q.kind, priority: q.priority, wcag: parseJson<string[]>(q.wcag, []), viewports: parseJson<Viewport[]>(q.viewports, []),
});
const requirementHash = (f: RequirementFields) => JSON.stringify([f.title, f.description, f.acceptanceCriteria, f.kind, f.wcag, f.viewports]);

function subjectOf(r: Record<string, any>): SubjectNow | null {
  if (r.subject_kind === "requirement") {
    const q = requirementRow(Number(r.subject_ref));
    if (!q) return null;
    const f = requirementFields(q);
    return { title: f.title, hash: requirementHash(f), preconditions: "", priority: f.priority, link: () => [q.id as number] };
  }
  const item = r.audit_id ? planItemForSuggestion(r.audit_id, r.subject_ref) : null;
  if (!item) return null;
  return {
    title: item.fields.title, hash: item.hash, preconditions: item.fields.preconditions, priority: item.fields.priority,
    link: (projectId, projectKey) => item.fields.requirements.flatMap((raw) => {
      const ref = resolveRefs(projectId, projectKey, { requirements: [raw], cases: [], tests: [] })[0];
      return ref.state === "resolved" && ref.requirementId ? [ref.requirementId] : [];
    }),
  };
}

/** One suggestion for its view: what it says, who made it, what became of it, whether what it is about has changed since, the draft test case made of it, and its history. */
function view(r: Record<string, any>) {
  const item = subjectOf(r);
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
    /** What the suggestion is about (the plan item or the requirement) has changed since it was suggested, or is gone. */
    subjectChanged: !item || item.hash !== r.subject_hash, subjectGone: !item,
    testCase: c ? { id: c.id, number: c.number, key: caseKey(c.project_id, c.number) } : null,
    /** A spec suggestion has a file name (and its text is artifactText); Apply makes it a draft spec, and only then can the file be downloaded. */
    artifactName: (r.artifact_name as string) || null, artifactText: r.artifact_text as string, isSpec: !!r.artifact_name, appliedAt: r.applied_at as string | null, appliedBy: (r.applied_by as string) || null,
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
  return createSuggestion({ projectId: audit.project_id, auditId, kind: "plan_item", ref: sourceId, rule: RULE, label: RULE_LABEL, who: ruleWho, noun: "plan item", content: made.content, hash: item.hash });
}

/**
 * A person asks for a Playwright spec suggestion for an approved plan item. Same rules as the automation suggestion: the rule makes it, as `proposed`, once; a rejected or ignored one is
 * not made again; only an approved plan item gets one. The text is a draft template that a person finishes, and it cannot be downloaded until a person has applied it.
 */
export function suggestSpecForPlanItem(auditId: number, sourceId: string): { created: SuggestionView[]; message: string } {
  const audit = db.prepare("SELECT id, project_id FROM audits WHERE id = ?").get(auditId) as { id: number; project_id: number } | undefined;
  if (!audit) throw new AuditError(404, "Audit not found");
  const item = planItemForSuggestion(auditId, sourceId);
  if (!item) throw new AuditError(404, "Plan item not found");
  if (item.status !== "approved") throw new AuditError(409, "Approve the plan item first. A spec is only suggested for an approved plan item.");
  const made = suggestSpecFromPlanItem(item.fields, sourceId);
  if ("reason" in made) return { created: [], message: made.reason };
  return createSuggestion({ projectId: audit.project_id, auditId, kind: "plan_item", ref: sourceId, rule: RULE_SPEC_PLAN_ITEM, label: RULE_SPEC_PLAN_ITEM_LABEL, who: { name: "Rule: playwright spec from plan item", userId: null }, noun: "plan item", thing: "a spec suggestion", content: made.content, hash: item.hash, artifactName: made.fileName });
}

/**
 * A person asks for an automation suggestion for an approved requirement. Same as for a plan item: the rule makes it, as `proposed`; asking again makes no second one, and a rejected or
 * ignored one is not made again. Only an approved requirement gets one (a draft or a deprecated one is refused with 409).
 */
export function suggestAutomationForRequirement(requirementId: number): { created: SuggestionView[]; message: string } {
  const q = requirementRow(requirementId);
  if (!q) throw new AuditError(404, "Requirement not found");
  if (q.status !== "approved") throw new AuditError(409, "Approve the requirement first. Automation is only suggested for an approved requirement.");
  const f = requirementFields(q);
  const made = suggestFromRequirement(f);
  if ("reason" in made) return { created: [], message: made.reason };
  return createSuggestion({ projectId: q.project_id, auditId: null, kind: "requirement", ref: String(q.id), rule: RULE_REQUIREMENT, label: RULE_REQUIREMENT_LABEL, who: ruleWhoRequirement, noun: "requirement", content: made.content, hash: requirementHash(f) });
}

/** The suggestions of one requirement, oldest first. Ignored ones are included: the page hides them by default. */
export function listRequirementAutomationSuggestions(requirementId: number) {
  const q = requirementRow(requirementId);
  if (!q) throw new AuditError(404, "Requirement not found");
  return (db.prepare("SELECT * FROM automation_suggestions WHERE subject_kind = 'requirement' AND subject_ref = ? AND project_id = ? ORDER BY id").all(String(q.id), q.project_id) as Record<string, any>[]).map(view);
}

/** Removes the suggestions of a requirement that is being deleted (nothing else can reach them). The draft test cases made from them stay. Call before the requirement is deleted. */
export function removeRequirementSuggestions(requirementId: number) {
  const q = requirementRow(requirementId);
  if (q) db.prepare("DELETE FROM automation_suggestions WHERE subject_kind = 'requirement' AND subject_ref = ? AND project_id = ?").run(String(q.id), q.project_id);
}

/** Makes the suggestion, once: asking again makes no second one, and a rejected or ignored one is not made again. */
function createSuggestion(a: { projectId: number; auditId: number | null; kind: "plan_item" | "requirement"; ref: string; rule: string; label: string; who: Who; noun: string; content: SuggestionContent; hash: string; artifactName?: string; thing?: string }): { created: SuggestionView[]; message: string } {
  const existing = db.prepare("SELECT * FROM automation_suggestions WHERE project_id = ? AND subject_kind = ? AND COALESCE(audit_id, 0) = ? AND subject_ref = ? AND rule = ?").get(a.projectId, a.kind, a.auditId ?? 0, a.ref, a.rule) as Record<string, any> | undefined;
  if (existing) {
    const status = existing.review_status as SuggestionStatus;
    return { created: [], message: status === "rejected" || status === "ignored" ? `This ${a.noun} already has ${a.thing ?? "a suggestion"}, and you ${status === "rejected" ? "rejected" : "ignored"} it. It is not made again.` : `This ${a.noun} already has ${a.thing ?? "a suggestion"}.` };
  }
  const asker = person();
  const c = a.content;
  const id = db.transaction(() => {
    const newId = (db.prepare(`INSERT INTO automation_suggestions (project_id, audit_id, subject_kind, subject_ref, rule, origin, proposed_by, summary, steps, assertions, test_data, plan, original, subject_hash, artifact_name, artifact_text)
        VALUES (?, ?, ?, ?, ?, 'rule', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .get(a.projectId, a.auditId, a.kind, a.ref, a.rule, a.label, c.summary, JSON.stringify(c.steps), JSON.stringify(c.assertions), c.testData, c.plan, JSON.stringify(c), a.hash, a.artifactName ?? "", c.artifactText ?? "") as { id: number }).id;
    revise(newId, "suggested", a.who, c, "proposed", `Made by a fixed rule when ${asker.name} asked.`);
    return newId;
  })();
  return { created: [view(rowOf(id))], message: "" };
}

function normalize(c: SuggestionContent): SuggestionContent {
  return {
    summary: c.summary.trim(), steps: c.steps.map((s) => s.trim()).filter(Boolean), assertions: c.assertions.map((s) => s.trim()).filter(Boolean), testData: c.testData.trim(), plan: c.plan.trim(),
    artifactText: c.artifactText === undefined ? undefined : c.artifactText.trim() ? `${c.artifactText.replace(/\s+$/, "")}\n` : "",
  };
}

/** A person edits a suggestion. It becomes theirs (a draft, also when it was approved or rejected: the decision was about the earlier text). No change, no entry. */
export function editAutomationSuggestion(id: number, patch: Partial<SuggestionContent>) {
  const r = rowOf(id);
  const cur = contentOf(r);
  const next = normalize({ ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
  if (!next.summary) throw new AuditError(400, "A suggestion needs a summary");
  if (!next.steps.length) throw new AuditError(400, "A suggestion needs at least one step");
  if (r.artifact_name && !(next.artifactText ?? "").trim()) throw new AuditError(400, "A spec needs its text");
  if ((next.artifactText ?? "").length > 100000) throw new AuditError(400, "The spec text is too long");
  if (keyOf(next) === keyOf(cur)) return;
  const w = person();
  const [sets, vals] = stamp(w);
  db.transaction(() => {
    db.prepare(`UPDATE automation_suggestions SET summary = ?, steps = ?, assertions = ?, test_data = ?, plan = ?, artifact_text = ?, review_status = 'draft', ${sets} WHERE id = ?`)
      .run(next.summary, JSON.stringify(next.steps), JSON.stringify(next.assertions), next.testData, next.plan, next.artifactText ?? "", ...vals, id);
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
 * A person applies a suggestion: a DRAFT test case is made of it, linked to the requirements the plan item names (or to the requirement itself), in one transaction. The test case is never ready and the
 * suggestion is never approved by this: the suggestion becomes a draft (when it was still only suggested), and approving it, or making the test case ready, is a decision of its own.
 * Applying twice makes no second test case. A rejected or ignored suggestion has to be changed or put back first.
 */
export function applyAutomationSuggestion(id: number) {
  const r = rowOf(id);
  if (r.review_status === "ignored") throw new AuditError(409, "This suggestion was ignored. Put it back to Suggested first.");
  if (r.review_status === "rejected") throw new AuditError(409, "This suggestion was rejected. Approve or edit it first if you want to apply it.");
  if (r.artifact_name) throw new AuditError(409, "This is a spec suggestion: apply it as a draft spec.");
  if (r.case_id) {
    const c = db.prepare("SELECT number FROM cases WHERE id = ?").get(r.case_id) as { number: number } | undefined;
    if (c) throw new AuditError(409, `This suggestion is already the test case ${caseKey(r.project_id, c.number)}.`);
  }
  const subject = subjectOf(r);
  if (!subject) throw new AuditError(409, `The ${r.subject_kind === "requirement" ? "requirement" : "plan item"} is gone, so there is nothing to link the test case to.`);
  const c = contentOf(r);
  const w = person();
  const project = db.prepare("SELECT id, key FROM projects WHERE id = ?").get(r.project_id) as { id: number; key: string };
  return db.transaction(() => {
    const n = db.prepare("UPDATE projects SET next_case_number = next_case_number + 1 WHERE id = ? RETURNING next_case_number - 1 AS n").get(project.id) as { n: number };
    const pos = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM cases WHERE project_id = ?").get(project.id) as { p: number }).p;
    const description = [c.summary, c.plan, c.testData ? `Test data: ${c.testData}` : ""].filter(Boolean).join("\n\n");
    const caseId = (db.prepare(`INSERT INTO cases (project_id, suite_id, number, title, description, preconditions, priority, status, tags, position)
        VALUES (?, NULL, ?, ?, ?, ?, ?, 'draft', ?, ?) RETURNING id`)
      .get(project.id, n.n, subject.title, description, subject.preconditions, casePriority(subject.priority), JSON.stringify(["automation-suggestion"]), pos) as { id: number }).id;
    c.steps.forEach((action, i) => db.prepare("INSERT INTO case_steps (case_id, position, action, expected) VALUES (?, ?, ?, ?)").run(caseId, i, action, i === c.steps.length - 1 ? c.assertions.join("\n") : ""));
    for (const requirementId of subject.link(project.id, project.key)) addRequirementCases(requirementId, project.id, [caseId]);
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

/**
 * A person applies a spec suggestion: it becomes a draft spec. It is recorded who and when, and only then can the file be downloaded. The spec is never ready and the suggestion is never
 * approved by this (a suggestion that was only suggested becomes a draft). Nothing is run, and nothing is written to disk or to git. Applying twice is refused. A rejected or ignored
 * suggestion has to be changed or put back first.
 */
export function applySpecSuggestion(id: number) {
  const r = rowOf(id);
  if (!r.artifact_name) throw new AuditError(409, "This is not a spec suggestion.");
  if (r.review_status === "ignored") throw new AuditError(409, "This suggestion was ignored. Put it back to Suggested first.");
  if (r.review_status === "rejected") throw new AuditError(409, "This suggestion was rejected. Approve or edit it first if you want to apply it.");
  if (r.applied_at) throw new AuditError(409, `This spec was already applied: ${r.artifact_name}. It can be downloaded.`);
  const w = person();
  return db.transaction(() => {
    if (r.review_status === "proposed") {
      const [sets, vals] = stamp(w);
      db.prepare(`UPDATE automation_suggestions SET review_status = 'draft', applied_at = datetime('now'), applied_by = ?, applied_by_user_id = ?, ${sets} WHERE id = ?`).run(w.name, w.userId, ...vals, id);
    } else {
      db.prepare("UPDATE automation_suggestions SET applied_at = datetime('now'), applied_by = ?, applied_by_user_id = ? WHERE id = ?").run(w.name, w.userId, id);
    }
    revise(id, "applied", w, contentOf(r), r.review_status === "proposed" ? "draft" : r.review_status, `Draft spec ${r.artifact_name} made. It can now be downloaded. It is a draft: nothing is run, and finishing it is a separate decision.`);
    return { fileName: r.artifact_name as string };
  })();
}

/** The file of an applied spec: its name and its text as it is now (with a person's edits). Refused before Apply, and when the suggestion was rejected or ignored. */
export function specFile(id: number): { fileName: string; text: string } {
  const r = rowOf(id);
  if (!r.artifact_name) throw new AuditError(404, "This suggestion has no spec file.");
  if (!r.applied_at) throw new AuditError(409, "Apply the spec first: a spec can only be downloaded after a person has applied it.");
  if (r.review_status === "rejected" || r.review_status === "ignored") throw new AuditError(409, `This spec was ${r.review_status}, so it cannot be downloaded.`);
  return { fileName: r.artifact_name as string, text: r.artifact_text as string };
}
