import "./env.ts";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { runAs, type AccountUser } from "../server/accountcontext.ts";
import { db } from "../server/db.ts";
import { bagFromFiles } from "../server/importers/bag.ts";
import { decidePlanItem, deleteAudit, editPlanItem, importAuditPackage, previewAuditDeletion } from "../server/audits.ts";
import { applyAutomationSuggestion, approachFor, decideAutomationSuggestion, editAutomationSuggestion, getAutomationSuggestion, listRequirementAutomationSuggestions, removeRequirementSuggestions, suggestAutomation, suggestAutomationForRequirement, suggestFromPlanItem, suggestFromRequirement } from "../server/automation.ts";
import { getRequirement } from "../server/requirements.ts";
import { makeProject } from "./helpers.ts";

// An automation suggestion is made by a fixed rule from an approved plan item, and is only ever a suggestion: a person edits, approves, rejects or ignores it, and Apply makes a
// DRAFT test case. Nothing is generated or run, and nothing is approved by the rule or by Apply.

let n = 0;
const proj = () => makeProject(`AS${++n}`, `Automation ${n}`);
const item = (over: Record<string, unknown> = {}) => ({
  sourceId: "TPI-001", title: "Add a todo", type: "Functional", risk: "High", priority: "High", readiness: "ready", preconditions: "An empty list", testData: "QA-AUDIT-1",
  steps: ["Type the text", "Press Enter"], acceptanceCriteria: "- The text is shown in the list\n- The input is cleared", automation: "Yes, exploration", refs: { requirements: ["REQ-1"] }, ...over,
});
function pkg(p: { key: string }, planItems: unknown[]) {
  const f = new Map<string, Uint8Array>();
  f.set("manifest.json", Buffer.from(JSON.stringify({ format: "testbench-audit-package", version: 1, audit: { id: "a1", title: "Audit", project: p.key }, files: [], parts: {} })));
  f.set("bugs.json", Buffer.from(JSON.stringify({ version: 1, bugs: [] })));
  f.set("test-plan.json", Buffer.from(JSON.stringify({ version: 1, planItems, coverageGaps: [] })));
  return bagFromFiles(f);
}
const audit = (p: { id: number }) => (db.prepare("SELECT id FROM audits WHERE project_id = ? AND agent_audit_id = 'a1'").get(p.id) as { id: number }).id;
const user = (name: string): AccountUser => {
  const id = (db.prepare("INSERT INTO users (email, name, password_hash) VALUES (?, ?, 'h') RETURNING id").get(`${name.toLowerCase().replace(/\W/g, "")}@x.io`, name) as { id: number }).id;
  return { id, email: "", name, isOwner: false, disabledAt: null, createdAt: "", lastLoginAt: null };
};
const row = (id: number) => db.prepare("SELECT * FROM automation_suggestions WHERE id = ?").get(id) as Record<string, any>;
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
/** A project with a requirement REQ-1 and an audit whose plan items are imported. `approve` approves them as this person (or without one when accounts are off); false leaves them proposed. */
function seeded(items: Record<string, unknown>[] = [item()], approve: AccountUser | null | false = false) {
  const p = proj();
  db.prepare("INSERT INTO requirements (project_id, number, title) VALUES (?, 1, 'Todo can be added')").run(p.id);
  importAuditPackage(pkg(p, items), { projectId: p.id, source: "upload" }, { dryRun: false });
  const a = audit(p);
  if (approve !== false) for (const i of items) { const go = () => decidePlanItem(a, i.sourceId as string, "approved"); if (approve) runAs(approve, go); else go(); }
  return { p, a };
}
const make = (a: number, sourceId = "TPI-001") => { const r = suggestAutomation(a, sourceId); assert.equal(r.created.length, 1, r.message); return r.created[0]; };

// Runs first on purpose: there is no account yet, so this is what a single-person install does.
describe("without accounts (nothing changes for a single-person install)", () => {
  it("a person can ask, edit, approve and apply, and no account is saved", () => {
    const { a } = seeded([item()], null);
    const s = make(a);
    editAutomationSuggestion(s.id, { summary: "Mine" });
    decideAutomationSuggestion(s.id, "approved");
    applyAutomationSuggestion(s.id);
    const r = row(s.id);
    assert.deepEqual([r.review_status, r.decided_by_user_id, r.edited_by_user_id], ["approved", null, null]);
  });
});

describe("the rule", () => {
  it("makes the same suggestion from the same plan item every time, from the item's own text", () => {
    const f = { title: "Add a todo", type: "Functional", risk: "High", priority: "High", readiness: "ready", preconditions: "An empty list", testData: "QA-AUDIT-1", steps: ["Type the text", "Press Enter"], acceptanceCriteria: "- The text is shown in the list\n2. The input is cleared", automation: "Yes", requirements: [] };
    const one = suggestFromPlanItem(f); const two = suggestFromPlanItem(structuredClone(f));
    assert.deepEqual(one, two);
    assert.ok("content" in one);
    if (!("content" in one)) return;
    assert.deepEqual(one.content.steps, ["Set up: An empty list", "Type the text", "Press Enter"], "the preconditions come first, then the item's steps");
    assert.deepEqual(one.content.assertions, ["The text is shown in the list", "The input is cleared"], "one check per line of the acceptance criteria, without list markers");
    assert.equal(one.content.testData, "QA-AUDIT-1");
    assert.match(one.content.plan, /Approach: an end-to-end test of the user flow\.\nPriority High, risk High\.\nNeeded before scripting: An empty list\. Test data: QA-AUDIT-1\.\nNote in the plan item: Yes\n/);
    assert.match(one.content.plan, /Nothing is generated or run by TestBench\.$/);
    assert.match(one.content.summary, /^Automate “Add a todo” as an end-to-end test of the user flow: 3 steps and 2 checks\.$/);
  });

  it("the kind of test comes from the item's type, in fixed words", () => {
    assert.deepEqual(["API", "Load test", "Accessibility (WCAG)", "Security", "Functional", ""].map(approachFor),
      ["an API-level test", "a load test with a threshold", "an accessibility check", "a security check", "an end-to-end test of the user flow", "an end-to-end test of the user flow"]);
  });

  it("without steps, without acceptance criteria or without both, nothing is generated, and the message says which is missing", () => {
    const base = { title: "T", type: "", risk: "", priority: "", readiness: "", preconditions: "", testData: "", steps: ["s"], acceptanceCriteria: "c", automation: "", requirements: [] };
    assert.deepEqual(suggestFromPlanItem({ ...base, steps: [] }), { reason: "Nothing was generated: the plan item has no steps. Add it to the plan item and ask again." });
    assert.deepEqual(suggestFromPlanItem({ ...base, acceptanceCriteria: "  \n " }), { reason: "Nothing was generated: the plan item has no acceptance criteria. Add it to the plan item and ask again." });
    assert.deepEqual(suggestFromPlanItem({ ...base, steps: [], acceptanceCriteria: "" }), { reason: "Nothing was generated: the plan item has no steps and acceptance criteria. Add them to the plan item and ask again." });
  });

  it("asking for a plan item that lacks them stores nothing and says why", () => {
    const { a } = seeded([item({ steps: [] })], null);
    const r = suggestAutomation(a, "TPI-001");
    assert.deepEqual([r.created, r.message], [[], "Nothing was generated: the plan item has no steps. Add it to the plan item and ask again."]);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestions WHERE audit_id = ?", a), 0);
  });
});

describe("who gets a suggestion, and when it is made again", () => {
  let tess!: AccountUser;
  before(() => { tess = user("Tess Tester"); });

  it("only an approved plan item gets one: a proposed, draft or rejected item is refused with 409, nothing is stored", () => {
    const { a } = seeded([item(), item({ sourceId: "TPI-002", title: "Second" }), item({ sourceId: "TPI-003", title: "Third" })], false);
    runAs(tess, () => { editPlanItem(a, "TPI-002", { title: "Second, mine" }); decidePlanItem(a, "TPI-003", "rejected"); });
    for (const id of ["TPI-001", "TPI-002", "TPI-003"]) assert.throws(() => runAs(tess, () => suggestAutomation(a, id)), /Approve the plan item first/, id);
    assert.throws(() => runAs(tess, () => suggestAutomation(a, "NOPE")), /Plan item not found/);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestions WHERE audit_id = ?", a), 0);
    runAs(tess, () => decidePlanItem(a, "TPI-001", "approved"));
    assert.equal(runAs(tess, () => suggestAutomation(a, "TPI-001")).created.length, 1);
  });

  it("a suggestion is the rule's: origin rule, labelled Suggested by rule, proposed, nobody edited or decided it, and the history says the rule made it", () => {
    const { a } = seeded([item()], tess);
    const s = runAs(tess, () => make(a));
    assert.deepEqual([s.origin, s.label, s.proposedBy, s.status, s.editedBy, s.decidedBy, s.testCase], ["rule", "Suggested by rule", "rule: scripted from plan item", "proposed", null, null, null]);
    assert.deepEqual(s.history.map((h) => [h.kind, h.byRule, h.actor]), [["suggested", true, "Rule: scripted from plan item"]]);
    assert.match(s.history[0].note, /when Tess Tester asked/);
  });

  it("asking again makes no second suggestion, and a rejected or ignored one is not made again", () => {
    const { a } = seeded([item(), item({ sourceId: "TPI-002", title: "Second" }), item({ sourceId: "TPI-003", title: "Third" })], tess);
    const first = runAs(tess, () => make(a, "TPI-001"));
    const again = runAs(tess, () => suggestAutomation(a, "TPI-001"));
    assert.deepEqual([again.created, again.message], [[], "This plan item already has a suggestion."]);
    const rejected = runAs(tess, () => make(a, "TPI-002")); runAs(tess, () => decideAutomationSuggestion(rejected.id, "rejected"));
    const ignored = runAs(tess, () => make(a, "TPI-003")); runAs(tess, () => decideAutomationSuggestion(ignored.id, "ignored"));
    assert.match(runAs(tess, () => suggestAutomation(a, "TPI-002")).message, /you rejected it\. It is not made again/);
    assert.match(runAs(tess, () => suggestAutomation(a, "TPI-003")).message, /you ignored it\. It is not made again/);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestions WHERE audit_id = ?", a), 3);
    assert.equal(row(first.id).review_status, "proposed", "and asking again changed nothing");
  });

  it("when the plan item changes after the suggestion, the suggestion says so; an untouched one does not", () => {
    const { a } = seeded([item()], tess);
    const s = runAs(tess, () => make(a));
    assert.equal(getAutomationSuggestion(s.id).subjectChanged, false);
    runAs(tess, () => editPlanItem(a, "TPI-001", { acceptanceCriteria: "- The text is shown in the list, trimmed" }));
    const changed = getAutomationSuggestion(s.id);
    assert.deepEqual([changed.subjectChanged, changed.subjectGone], [true, false]);
    db.prepare("DELETE FROM audit_plan_items WHERE audit_id = ? AND source_id = 'TPI-001'").run(a);
    assert.deepEqual([getAutomationSuggestion(s.id).subjectChanged, getAutomationSuggestion(s.id).subjectGone], [true, true]);
  });
});

describe("what a person does with a suggestion", () => {
  let anna!: AccountUser; let sam!: AccountUser;
  before(() => { anna = user("Anna Berg"); sam = user("Sam Lund"); });
  const fresh = () => { const { a } = seeded([item()], anna); return runAs(anna, () => make(a)); };

  it("editing takes it over as a draft and saves the person, the account and the time; the same text again is not an edit", () => {
    const s = fresh();
    runAs(anna, () => editAutomationSuggestion(s.id, { summary: "Automate it my way", steps: ["One", "Two"] }));
    const r = row(s.id);
    assert.deepEqual([r.review_status, r.edited_by, r.edited_by_user_id, r.summary, JSON.parse(r.steps)], ["draft", "Anna Berg", anna.id, "Automate it my way", ["One", "Two"]]);
    assert.ok(r.edited_at);
    assert.deepEqual(JSON.parse(r.original).steps, s.steps, "the suggestion as the rule made it is kept");
    runAs(sam, () => editAutomationSuggestion(s.id, { summary: "Automate it my way" }));
    assert.equal(row(s.id).edited_by_user_id, anna.id, "no new edit");
    assert.equal(getAutomationSuggestion(s.id).history.filter((h) => h.kind === "edited").length, 1);
    assert.throws(() => runAs(anna, () => editAutomationSuggestion(s.id, { summary: " " })), /needs a summary/);
    assert.throws(() => runAs(anna, () => editAutomationSuggestion(s.id, { steps: [" "] })), /at least one step/);
  });

  it("approve, reject and ignore save who decided and when; draft saves a draft; every step is in the history in order", () => {
    const s = fresh();
    runAs(anna, () => decideAutomationSuggestion(s.id, "draft"));
    runAs(sam, () => decideAutomationSuggestion(s.id, "approved", "looks right"));
    let r = row(s.id);
    assert.deepEqual([r.review_status, r.decided_by, r.decided_by_user_id], ["approved", "Sam Lund", sam.id]);
    assert.ok(r.decided_at);
    runAs(anna, () => decideAutomationSuggestion(s.id, "rejected"));
    runAs(anna, () => decideAutomationSuggestion(s.id, "ignored"));
    r = row(s.id);
    assert.deepEqual([r.review_status, r.decided_by_user_id], ["ignored", anna.id]);
    runAs(anna, () => decideAutomationSuggestion(s.id, "ignored")); // again: nothing new
    const h = getAutomationSuggestion(s.id).history;
    assert.deepEqual(h.map((x) => [x.kind, x.actor]), [["suggested", "Rule: scripted from plan item"], ["draft", "Anna Berg"], ["approved", "Sam Lund"], ["rejected", "Anna Berg"], ["ignored", "Anna Berg"]]);
    assert.deepEqual(h.map((x) => x.rev), [1, 2, 3, 4, 5]);
    assert.equal(h[2].note, "looks right");
  });

  it("an ignored suggestion can be put back to Suggested; nothing else can, and a rejection stays a decision", () => {
    const s = fresh();
    runAs(anna, () => decideAutomationSuggestion(s.id, "draft"));
    assert.throws(() => runAs(anna, () => decideAutomationSuggestion(s.id, "proposed")), /Only an ignored suggestion/);
    runAs(anna, () => decideAutomationSuggestion(s.id, "ignored"));
    runAs(anna, () => decideAutomationSuggestion(s.id, "proposed"));
    assert.equal(row(s.id).review_status, "proposed");
    assert.deepEqual(getAutomationSuggestion(s.id).history.map((x) => x.kind), ["suggested", "draft", "ignored", "restored"]);
    runAs(anna, () => decideAutomationSuggestion(s.id, "rejected"));
    assert.throws(() => runAs(anna, () => decideAutomationSuggestion(s.id, "proposed")), /Only an ignored suggestion/);
    assert.equal(row(s.id).review_status, "rejected");
  });

  it("editing an approved suggestion puts it back to draft, because the decision was about the earlier text", () => {
    const s = fresh();
    runAs(anna, () => decideAutomationSuggestion(s.id, "approved"));
    runAs(sam, () => editAutomationSuggestion(s.id, { plan: "Another plan" }));
    assert.equal(row(s.id).review_status, "draft");
    const last = getAutomationSuggestion(s.id).history.at(-1)!;
    assert.deepEqual([last.kind, last.changes.map((c) => c.field)], ["edited", ["Plan"]]);
    assert.match(last.note, /earlier text/);
  });
});

describe("Apply makes a draft test case and approves nothing", () => {
  let anna!: AccountUser;
  before(() => { anna = user("Ada Apply"); });
  const prepared = () => { const { p, a } = seeded([item()], anna); const s = runAs(anna, () => make(a)); return { p, a, s }; };
  const caseOf = (id: number) => db.prepare("SELECT * FROM cases WHERE id = ?").get(id) as Record<string, any>;

  it("the test case is a draft with the suggestion's steps and checks, linked to the requirement; the suggestion becomes a draft, never approved", () => {
    const { p, s } = prepared();
    const made = runAs(anna, () => applyAutomationSuggestion(s.id));
    const c = caseOf(made.caseId);
    assert.deepEqual([c.status, c.title, c.priority, JSON.parse(c.tags), c.preconditions], ["draft", "Add a todo", "high", ["automation-suggestion"], "An empty list"]);
    assert.match(c.description, /^Automate “Add a todo” as an end-to-end test of the user flow/);
    assert.match(c.description, /Test data: QA-AUDIT-1$/);
    const steps = db.prepare("SELECT action, expected FROM case_steps WHERE case_id = ? ORDER BY position").all(made.caseId);
    assert.deepEqual(steps, [{ action: "Set up: An empty list", expected: "" }, { action: "Type the text", expected: "" }, { action: "Press Enter", expected: "The text is shown in the list\nThe input is cleared" }]);
    const req = db.prepare("SELECT id FROM requirements WHERE project_id = ? AND number = 1").get(p.id) as { id: number };
    assert.equal(count("SELECT COUNT(*) AS n FROM requirement_cases WHERE requirement_id = ? AND case_id = ?", req.id, made.caseId), 1, "linked to the requirement the plan item names");
    const r = row(s.id);
    assert.deepEqual([r.review_status, r.case_id, r.edited_by_user_id, r.decided_by_user_id], ["draft", made.caseId, anna.id, null]);
    assert.notEqual(r.review_status, "approved");
    assert.deepEqual([getAutomationSuggestion(s.id).testCase?.key, getAutomationSuggestion(s.id).history.at(-1)!.kind], [made.key, "applied"]);
  });

  it("a suggestion a person had already approved stays approved, and the test case is still a draft", () => {
    const { s } = prepared();
    runAs(anna, () => decideAutomationSuggestion(s.id, "approved"));
    const made = runAs(anna, () => applyAutomationSuggestion(s.id));
    assert.deepEqual([row(s.id).review_status, caseOf(made.caseId).status], ["approved", "draft"]);
  });

  it("applying twice makes no second test case", () => {
    const { p, s } = prepared();
    const made = runAs(anna, () => applyAutomationSuggestion(s.id));
    assert.throws(() => runAs(anna, () => applyAutomationSuggestion(s.id)), new RegExp(`already the test case ${made.key}`));
    assert.equal(count("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?", p.id), 1);
  });

  it("a rejected or ignored suggestion is not applied until it is changed or put back; nothing is made", () => {
    const { p, a } = seeded([item(), item({ sourceId: "TPI-002", title: "Second" })], anna);
    const one = runAs(anna, () => make(a, "TPI-001")); const two = runAs(anna, () => make(a, "TPI-002"));
    runAs(anna, () => decideAutomationSuggestion(one.id, "rejected")); runAs(anna, () => decideAutomationSuggestion(two.id, "ignored"));
    assert.throws(() => runAs(anna, () => applyAutomationSuggestion(one.id)), /was rejected/);
    assert.throws(() => runAs(anna, () => applyAutomationSuggestion(two.id)), /was ignored/);
    assert.equal(count("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?", p.id), 0);
    runAs(anna, () => decideAutomationSuggestion(two.id, "proposed"));
    assert.ok(runAs(anna, () => applyAutomationSuggestion(two.id)).caseId);
  });

  it("without its plan item there is nothing to link the test case to: refused, nothing is made", () => {
    const { p, a, s } = prepared();
    db.prepare("DELETE FROM audit_plan_items WHERE audit_id = ?").run(a);
    assert.throws(() => runAs(anna, () => applyAutomationSuggestion(s.id)), /plan item is gone/);
    assert.equal(count("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?", p.id), 0);
  });

  it("a failure half way makes no test case and does not change the suggestion (all or nothing)", () => {
    const { p, s } = prepared();
    db.exec("CREATE TRIGGER zz_apply_fails BEFORE INSERT ON case_steps BEGIN SELECT RAISE(ABORT, 'boom'); END");
    try {
      assert.throws(() => runAs(anna, () => applyAutomationSuggestion(s.id)), /boom/);
    } finally { db.exec("DROP TRIGGER zz_apply_fails"); }
    assert.equal(count("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?", p.id), 0);
    assert.deepEqual([row(s.id).review_status, row(s.id).case_id], ["proposed", null]);
    assert.deepEqual(getAutomationSuggestion(s.id).history.map((h) => h.kind), ["suggested"]);
  });
});

describe("with accounts, a decision needs an account in the database itself", () => {
  let carl!: AccountUser;
  before(() => { carl = user("Carl Check"); });

  it("the database refuses an approve, a reject, an ignore or a draft without an account, however it is made", () => {
    const { a } = seeded([item()], carl);
    const s = runAs(carl, () => make(a));
    for (const to of ["approved", "rejected", "ignored", "draft"]) {
      assert.throws(() => db.prepare("UPDATE automation_suggestions SET review_status = ? WHERE id = ?").run(to, s.id), /needs a person with an account/, to);
    }
    assert.throws(() => decideAutomationSuggestion(s.id, "approved"), /needs a person with an account/, "the function, run without a person");
    assert.throws(() => editAutomationSuggestion(s.id, { summary: "Nobody's edit" }), /needs a person with an account/);
    assert.throws(() => applyAutomationSuggestion(s.id), /needs a person with an account/, "Apply too: it takes the suggestion over");
    assert.throws(() => db.prepare("INSERT INTO automation_suggestions (project_id, audit_id, subject_ref, rule, review_status) VALUES (?, ?, 'X', 'r', 'approved')").run(row(s.id).project_id, a), /needs a person with an account/);
    assert.equal(row(s.id).review_status, "proposed");
    assert.equal(count("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?", row(s.id).project_id), 0, "and Apply made no test case");
  });

  it("the rule is not a person: asking makes a proposal and leaves no decision", () => {
    const { a } = seeded([item(), item({ sourceId: "TPI-002", title: "Second" })], carl);
    runAs(carl, () => { make(a, "TPI-001"); make(a, "TPI-002"); });
    const rows = db.prepare("SELECT review_status AS s, decided_by AS d, decided_by_user_id AS u, edited_by AS e FROM automation_suggestions WHERE audit_id = ?").all(a);
    assert.ok(rows.every((r: any) => r.s === "proposed" && !r.d && r.u === null && !r.e), JSON.stringify(rows));
  });

  it("nothing in the server but the person's functions writes a suggestion's status, and the module makes no network call", () => {
    const dir = join(import.meta.dirname, "..", "server");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "automation.ts");
    for (const f of files) assert.doesNotMatch(readFileSync(join(dir, f), "utf8"), /automation_suggestions SET[^;`]*review_status/, f);
    const src = readFileSync(join(dir, "automation.ts"), "utf8");
    const suggest = src.slice(src.indexOf("export function suggestAutomation"), src.indexOf("function normalize"));
    assert.ok(suggest.length > 500);
    assert.doesNotMatch(suggest, /review_status\s*=|decided_by|edited_by\s*=/, "the rule's suggestion never decides or edits");
    assert.doesNotMatch(src, /fetch\(|https?:\/\/|node:http|node:net|child_process|eval\(/, "no network, no code execution");
  });
});

describe("deleting the audit", () => {
  let dora!: AccountUser;
  before(() => { dora = user("Dora Delete"); });

  it("the preview counts the suggestions people worked on and their history; the draft test cases made from them stay", () => {
    const { p, a } = seeded([item(), item({ sourceId: "TPI-002", title: "Second" })], dora);
    const one = runAs(dora, () => make(a, "TPI-001")); runAs(dora, () => make(a, "TPI-002"));
    assert.equal(previewAuditDeletion(a).planOwned.automation, 0, "a suggestion nobody has touched is not work done by people");
    const made = runAs(dora, () => applyAutomationSuggestion(one.id));
    const preview = previewAuditDeletion(a);
    assert.equal(preview.planOwned.automation, 1);
    assert.ok(preview.planOwned.history >= 4, "the plan's history and the suggestions' history are counted");
    deleteAudit(a);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestions WHERE audit_id = ?", a), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestion_revisions WHERE suggestion_id = ?", one.id), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM cases WHERE id = ?", made.caseId), 1, "the draft test case stays");
    assert.equal(count("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?", p.id), 1);
  });
});

// ---------- the same for an approved requirement ----------

const reqIn = (projectId: number, over: Record<string, unknown> = {}) =>
  (db.prepare(`INSERT INTO requirements (project_id, number, title, description, priority, status, acceptance_criteria, kind, wcag, viewports)
    VALUES (?, (SELECT COALESCE(MAX(number), 0) + 1 FROM requirements WHERE project_id = ?), ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .get(projectId, projectId, over.title ?? "Todo can be added", over.description ?? "A user with an empty list.\nMore text that is not used.", over.priority ?? "high", over.status ?? "approved",
      over.criteria ?? "- The text is shown in the list\n- The input is cleared", over.kind ?? "functional", JSON.stringify(over.wcag ?? []), JSON.stringify(over.viewports ?? [])) as { id: number }).id;
const makeReq = (requirementId: number) => { const r = suggestAutomationForRequirement(requirementId); assert.equal(r.created.length, 1, r.message); return r.created[0]; };

describe("the rule for a requirement", () => {
  const f = { title: "Todo can be added", description: "A user with an empty list.\nMore text that is not used.", acceptanceCriteria: "- The text is shown in the list\n2. The input is cleared", kind: "functional", priority: "high", wcag: [] as string[], viewports: [] };

  it("makes the same suggestion every time: the checks are the acceptance criteria, the steps are a skeleton, and the plan says so", () => {
    const one = suggestFromRequirement(f); const two = suggestFromRequirement(structuredClone(f));
    assert.deepEqual(one, two);
    assert.ok("content" in one);
    if (!("content" in one)) return;
    assert.deepEqual(one.content.assertions, ["The text is shown in the list", "The input is cleared"]);
    assert.deepEqual(one.content.steps, ["Set up the situation the requirement describes: A user with an empty list.", "Do what the requirement asks for: Todo can be added"]);
    assert.equal(one.content.testData, "");
    assert.match(one.content.summary, /^Automate the requirement “Todo can be added” as an end-to-end test of the user flow: 2 steps \(a skeleton to rewrite\) and 2 checks\.$/);
    assert.match(one.content.plan, /Approach: an end-to-end test of the user flow\.\nPriority high\.\nA requirement has no steps of its own: the steps are a skeleton/);
    assert.match(one.content.plan, /Test data: none recorded\./);
    assert.match(one.content.plan, /Nothing is generated or run by TestBench\.$/);
  });

  it("the kind of test and the test data follow the requirement's kind, WCAG criteria and viewports", () => {
    const sec = suggestFromRequirement({ ...f, kind: "security_privacy" });
    assert.ok("content" in sec && /Approach: a security check\./.test(sec.content.plan));
    const a11y = suggestFromRequirement({ ...f, wcag: ["1.4.3", "2.4.7"], viewports: [{ device: "Phone", width: 390, height: 844 }, { width: 1024 }] });
    assert.ok("content" in a11y);
    if (!("content" in a11y)) return;
    assert.match(a11y.content.plan, /Approach: an accessibility check\./);
    assert.equal(a11y.content.testData, "WCAG criteria: 1.4.3, 2.4.7\nViewports: Phone 390x844; 1024px wide");
    assert.match(a11y.content.plan, /Test data: taken from the requirement's WCAG criteria and viewports\./);
  });

  it("without a description the steps are just the one; without acceptance criteria nothing is generated, and the message says so", () => {
    const bare = suggestFromRequirement({ ...f, description: "" });
    assert.ok("content" in bare && bare.content.steps.length === 1);
    assert.deepEqual(suggestFromRequirement({ ...f, acceptanceCriteria: " \n  " }), { reason: "Nothing was generated: the requirement has no acceptance criteria. Add them to the requirement and ask again." });
  });
});

describe("who gets a requirement suggestion, and when it is made again", () => {
  let rita!: AccountUser;
  before(() => { rita = user("Rita Req"); });

  it("only an approved requirement gets one: a draft or a deprecated one is refused with 409, an unknown one is 404, and nothing is stored", () => {
    const p = proj();
    const draft = reqIn(p.id, { status: "draft" }); const old = reqIn(p.id, { status: "deprecated" });
    for (const id of [draft, old]) assert.throws(() => runAs(rita, () => suggestAutomationForRequirement(id)), /Approve the requirement first/);
    assert.throws(() => runAs(rita, () => suggestAutomationForRequirement(99999999)), /Requirement not found/);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestions WHERE project_id = ?", p.id), 0);
    const ok = reqIn(p.id);
    assert.equal(runAs(rita, () => suggestAutomationForRequirement(ok)).created.length, 1);
  });

  it("a requirement without acceptance criteria stores nothing and says why", () => {
    const p = proj();
    const r = runAs(rita, () => suggestAutomationForRequirement(reqIn(p.id, { criteria: "" })));
    assert.deepEqual([r.created, r.message], [[], "Nothing was generated: the requirement has no acceptance criteria. Add them to the requirement and ask again."]);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestions WHERE project_id = ?", p.id), 0);
  });

  it("it is the rule's, marked as a requirement's, proposed, with the history saying the rule made it", () => {
    const p = proj(); const id = reqIn(p.id);
    const s = runAs(rita, () => makeReq(id));
    assert.deepEqual([s.origin, s.subjectKind, s.sourceId, s.auditId, s.label, s.proposedBy, s.status, s.rule], ["rule", "requirement", String(id), null, "Suggested by rule", "rule: scripted from requirement", "proposed", "scripted_from_requirement"]);
    assert.deepEqual(s.history.map((h) => [h.kind, h.byRule, h.actor]), [["suggested", true, "Rule: scripted from requirement"]]);
    assert.deepEqual(listRequirementAutomationSuggestions(id).map((x) => x.id), [s.id]);
  });

  it("asking again makes no second suggestion, and a rejected or ignored one is not made again", () => {
    const p = proj(); const a = reqIn(p.id); const b = reqIn(p.id, { title: "Second" }); const c = reqIn(p.id, { title: "Third" });
    const first = runAs(rita, () => makeReq(a));
    assert.deepEqual([runAs(rita, () => suggestAutomationForRequirement(a)).created, runAs(rita, () => suggestAutomationForRequirement(a)).message], [[], "This requirement already has a suggestion."]);
    const rejected = runAs(rita, () => makeReq(b)); runAs(rita, () => decideAutomationSuggestion(rejected.id, "rejected"));
    const ignored = runAs(rita, () => makeReq(c)); runAs(rita, () => decideAutomationSuggestion(ignored.id, "ignored"));
    assert.match(runAs(rita, () => suggestAutomationForRequirement(b)).message, /you rejected it\. It is not made again/);
    assert.match(runAs(rita, () => suggestAutomationForRequirement(c)).message, /you ignored it\. It is not made again/);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestions WHERE project_id = ?", p.id), 3);
    assert.equal(row(first.id).review_status, "proposed");
  });

  it("a requirement's suggestion and a plan item's do not collide, even with the same reference", () => {
    const { p, a } = seeded([item({ sourceId: "1" })], rita);
    const reqId = reqIn(p.id);
    const planOne = runAs(rita, () => make(a, "1"));
    const reqOne = runAs(rita, () => makeReq(reqId));
    assert.notEqual(planOne.id, reqOne.id);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestions WHERE project_id = ?", p.id), 2);
    assert.deepEqual(listRequirementAutomationSuggestions(reqId).map((x) => x.id), [reqOne.id], "the requirement's list holds only its own");
  });

  it("when the requirement's text changes after the suggestion, the suggestion says so; an unrelated change does not; a removed requirement is gone", () => {
    const p = proj(); const id = reqIn(p.id);
    const s = runAs(rita, () => makeReq(id));
    assert.equal(getAutomationSuggestion(s.id).subjectChanged, false);
    db.prepare("UPDATE requirements SET source = 'JIRA-1', priority = 'low' WHERE id = ?").run(id);
    assert.equal(getAutomationSuggestion(s.id).subjectChanged, false, "its source and priority are not what the suggestion is made from");
    db.prepare("UPDATE requirements SET acceptance_criteria = '- Something else' WHERE id = ?").run(id);
    assert.deepEqual([getAutomationSuggestion(s.id).subjectChanged, getAutomationSuggestion(s.id).subjectGone], [true, false]);
    db.prepare("DELETE FROM requirements WHERE id = ?").run(id);
    assert.deepEqual([getAutomationSuggestion(s.id).subjectChanged, getAutomationSuggestion(s.id).subjectGone], [true, true]);
  });
});

describe("a person decides on a requirement suggestion the same way, and Apply links the draft test case to the requirement", () => {
  let rita!: AccountUser; let sam!: AccountUser;
  before(() => { rita = user("Ria Req"); sam = user("Sven Suggest"); });
  const prepared = () => { const p = proj(); const id = reqIn(p.id); const other = reqIn(p.id, { title: "Another requirement" }); const s = runAs(rita, () => makeReq(id)); return { p, id, other, s }; };
  const caseOf = (id: number) => db.prepare("SELECT * FROM cases WHERE id = ?").get(id) as Record<string, any>;

  it("edit takes it over as a draft; approve, ignore and put back work; every step is in the history", () => {
    const { s } = prepared();
    runAs(rita, () => editAutomationSuggestion(s.id, { summary: "Mine", steps: ["One"] }));
    assert.deepEqual([row(s.id).review_status, row(s.id).edited_by, row(s.id).edited_by_user_id], ["draft", "Ria Req", rita.id]);
    runAs(sam, () => decideAutomationSuggestion(s.id, "approved"));
    runAs(sam, () => decideAutomationSuggestion(s.id, "ignored"));
    runAs(sam, () => decideAutomationSuggestion(s.id, "proposed"));
    assert.deepEqual(getAutomationSuggestion(s.id).history.map((h) => [h.kind, h.actor]), [["suggested", "Rule: scripted from requirement"], ["edited", "Ria Req"], ["approved", "Sven Suggest"], ["ignored", "Sven Suggest"], ["restored", "Sven Suggest"]]);
  });

  it("Apply makes a draft test case with the requirement's title and priority, linked to that requirement only; the suggestion becomes a draft, never approved", () => {
    const { id, other, s } = prepared();
    const made = runAs(rita, () => applyAutomationSuggestion(s.id));
    const c = caseOf(made.caseId);
    assert.deepEqual([c.status, c.title, c.priority, c.preconditions, JSON.parse(c.tags)], ["draft", "Todo can be added", "high", "", ["automation-suggestion"]]);
    assert.match(c.description, /^Automate the requirement “Todo can be added”/);
    assert.deepEqual(db.prepare("SELECT action, expected FROM case_steps WHERE case_id = ? ORDER BY position").all(made.caseId), [
      { action: "Set up the situation the requirement describes: A user with an empty list.", expected: "" },
      { action: "Do what the requirement asks for: Todo can be added", expected: "The text is shown in the list\nThe input is cleared" },
    ]);
    assert.deepEqual(db.prepare("SELECT requirement_id AS r FROM requirement_cases WHERE case_id = ?").all(made.caseId), [{ r: id }], "linked to this requirement and no other");
    assert.equal(count("SELECT COUNT(*) AS n FROM requirement_cases WHERE requirement_id = ?", other), 0);
    assert.deepEqual([row(s.id).review_status, row(s.id).case_id, row(s.id).decided_by_user_id], ["draft", made.caseId, null]);
    assert.equal(getRequirement(id)!.coverage.cases, 0, "a draft test case does not count as coverage");
  });

  it("applying twice makes no second test case; a rejected or ignored suggestion is not applied; a requirement that is gone is refused; a failure makes nothing", () => {
    const { p, id, s } = prepared();
    const made = runAs(rita, () => applyAutomationSuggestion(s.id));
    assert.throws(() => runAs(rita, () => applyAutomationSuggestion(s.id)), new RegExp(`already the test case ${made.key}`));
    assert.equal(count("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?", p.id), 1);

    const q = proj(); const r1 = reqIn(q.id); const r2 = reqIn(q.id, { title: "Two" }); const r3 = reqIn(q.id, { title: "Three" }); const r4 = reqIn(q.id, { title: "Four" });
    const rejected = runAs(rita, () => makeReq(r1)); runAs(rita, () => decideAutomationSuggestion(rejected.id, "rejected"));
    const ignored = runAs(rita, () => makeReq(r2)); runAs(rita, () => decideAutomationSuggestion(ignored.id, "ignored"));
    const gone = runAs(rita, () => makeReq(r3)); db.prepare("DELETE FROM requirements WHERE id = ?").run(r3);
    const fails = runAs(rita, () => makeReq(r4));
    assert.throws(() => runAs(rita, () => applyAutomationSuggestion(rejected.id)), /was rejected/);
    assert.throws(() => runAs(rita, () => applyAutomationSuggestion(ignored.id)), /was ignored/);
    assert.throws(() => runAs(rita, () => applyAutomationSuggestion(gone.id)), /requirement is gone/);
    db.exec("CREATE TRIGGER zz_req_apply_fails BEFORE INSERT ON case_steps BEGIN SELECT RAISE(ABORT, 'boom'); END");
    try { assert.throws(() => runAs(rita, () => applyAutomationSuggestion(fails.id)), /boom/); } finally { db.exec("DROP TRIGGER zz_req_apply_fails"); }
    assert.equal(count("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?", q.id), 0);
    assert.deepEqual([row(fails.id).review_status, row(fails.id).case_id], ["proposed", null]);
    assert.ok(id);
  });

  it("with accounts the database refuses a decision on a requirement suggestion without an account; the rule leaves none", () => {
    const { s } = prepared();
    for (const to of ["approved", "rejected", "ignored", "draft"]) assert.throws(() => db.prepare("UPDATE automation_suggestions SET review_status = ? WHERE id = ?").run(to, s.id), /needs a person with an account/, to);
    assert.throws(() => applyAutomationSuggestion(s.id), /needs a person with an account/);
    assert.ok(!row(s.id).decided_by && row(s.id).decided_by_user_id === null && row(s.id).review_status === "proposed");
  });

  it("deleting the requirement removes its suggestions and their history; the draft test case made from one stays", () => {
    const { p, id, s } = prepared();
    const made = runAs(rita, () => applyAutomationSuggestion(s.id));
    removeRequirementSuggestions(id);
    db.prepare("DELETE FROM requirements WHERE id = ?").run(id);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestions WHERE project_id = ?", p.id), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestion_revisions WHERE suggestion_id = ?", s.id), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM cases WHERE id = ?", made.caseId), 1);
  });
});
