import "./env.ts";
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { runAs, type AccountUser } from "../server/accountcontext.ts";
import { db } from "../server/db.ts";
import {
  applyAutomationSuggestion, applySpecSuggestion, decideAutomationSuggestion, editAutomationSuggestion, getAutomationSuggestion, listRequirementAutomationSuggestions, removeRequirementSuggestions, specFile, suggestAutomationForRequirement,
  suggestSpecForRequirement, suggestSpecFromRequirement, type RequirementFields,
} from "../server/automation.ts";
import { makeProject } from "./helpers.ts";

// E2: the same spec suggestion as for a plan item (E1), made from an approved requirement. Same template, same rules for edits, Apply and download.

let n = 0;
const proj = () => makeProject(`SR${++n}`, `Spec req ${n}`);
const reqIn = (projectId: number, over: Record<string, unknown> = {}) =>
  (db.prepare(`INSERT INTO requirements (project_id, number, title, description, priority, status, acceptance_criteria, kind, wcag, viewports)
    VALUES (?, (SELECT COALESCE(MAX(number), 0) + 1 FROM requirements WHERE project_id = ?), ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .get(projectId, projectId, over.title ?? "Todo can be added", over.description ?? "A user with an empty list.\nMore text that is not used.", over.priority ?? "high", over.status ?? "approved",
      over.criteria ?? "- The text is shown in the list\n- The input is cleared", over.kind ?? "functional", JSON.stringify(over.wcag ?? []), JSON.stringify(over.viewports ?? [])) as { id: number }).id;
const user = (name: string): AccountUser => {
  const id = (db.prepare("INSERT INTO users (email, name, password_hash) VALUES (?, ?, 'h') RETURNING id").get(`${name.toLowerCase().replace(/\W/g, "")}@x.io`, name) as { id: number }).id;
  return { id, email: "", name, isOwner: false, disabledAt: null, createdAt: "", lastLoginAt: null };
};
const row = (id: number) => db.prepare("SELECT * FROM automation_suggestions WHERE id = ?").get(id) as Record<string, any>;
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
const makeSpec = (requirementId: number) => { const r = suggestSpecForRequirement(requirementId); assert.equal(r.created.length, 1, r.message); return r.created[0]; };
const fields = (over: Partial<RequirementFields> = {}): RequirementFields => ({ title: "Todo can be added", description: "A user with an empty list.", acceptanceCriteria: "- The text is shown\n- The input is cleared", kind: "functional", priority: "high", wcag: [], viewports: [], ...over });

describe("the spec rule for a requirement", () => {
  it("is deterministic, named req-<number>-<title>, starts with test.fixme (once), and holds a step and a TODO per check", () => {
    const a = suggestSpecFromRequirement(fields(), 7), b = suggestSpecFromRequirement(fields(), 7);
    assert.deepEqual(a, b);
    assert.ok("content" in a);
    assert.equal(a.fileName, "req-7-todo-can-be-added.spec.ts");
    const t = a.content.artifactText!;
    assert.equal(t.split("test.fixme(").length - 1, 1);
    assert.match(t, /\/\/ Source: requirement REQ-7|requirement REQ-7/);
    assert.match(t, /test\.step\("Do what the requirement asks for: Todo can be added"/);
    assert.match(t, /\/\/ TODO: expect\(\.\.\.\) for: The input is cleared/);
    assert.doesNotMatch(t, /page\.(goto|locator|getBy)|https?:\/\//, "no selector and no URL is made up");
  });

  it("without acceptance criteria nothing is made, and the message says why", () => {
    assert.deepEqual(suggestSpecFromRequirement(fields({ acceptanceCriteria: " \n " }), 1), { reason: "Nothing was generated: the requirement has no acceptance criteria. Add them to the requirement and ask again." });
  });

  it("hostile text can only end up inside a string literal or a comment: no extra code line, no tricky character", () => {
    const evil = '"); process.exit(1); //\n*/ `${x}` \u2028 \u202e \u0000 await evil();';
    const r = suggestSpecFromRequirement(fields({ title: evil, description: evil, acceptanceCriteria: `- ${evil}\n- ${evil}` }), 2);
    assert.ok("content" in r);
    const t = r.content.artifactText!;
    assert.doesNotMatch(t, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028-\u202e]/);
    const code = t.split("\n").filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/"(?:[^"\\\n]|\\.)*"/g, '""'));
    const ok = [/^$/, /^import \{ test, expect \} from "";$/, /^test\.describe\("", \(\) => \{$/, /^ +test\("", async \(\{ page \}\) => \{$/, /^ +test\.fixme\(true, ""\);$/, /^ +await test\.step\("", async \(\) => \{$/, /^ *\}\);$/];
    assert.ok(code.every((l) => ok.some((re) => re.test(l))), code.join("\n"));
  });
});

describe("who gets a requirement spec, and once", () => {
  let rita!: AccountUser;
  before(() => { rita = user("Rita Req"); });

  it("only an approved requirement gets one: a draft or deprecated one is 409, an unknown one is 404, and nothing is stored", () => {
    const p = proj(); const draft = reqIn(p.id, { status: "draft" }), old = reqIn(p.id, { status: "deprecated" });
    for (const id of [draft, old]) assert.throws(() => runAs(rita, () => suggestSpecForRequirement(id)), /Approve the requirement first/);
    assert.throws(() => runAs(rita, () => suggestSpecForRequirement(999999)), /not found/);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestions WHERE project_id = ?", p.id), 0);
  });

  it("a requirement without criteria stores nothing and says why", () => {
    const p = proj(); const id = reqIn(p.id, { criteria: "" });
    const r = runAs(rita, () => suggestSpecForRequirement(id));
    assert.deepEqual([r.created, r.message], [[], "Nothing was generated: the requirement has no acceptance criteria. Add them to the requirement and ask again."]);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestions WHERE project_id = ?", p.id), 0);
  });

  it("is the rule's: origin rule, a spec for the requirement, proposed, not applied, with a file name; asking again makes no second one; it lives beside the automation suggestion", () => {
    const p = proj(); const id = reqIn(p.id);
    const s = runAs(rita, () => makeSpec(id));
    assert.deepEqual([s.origin, s.subjectKind, s.sourceId, s.auditId, s.label, s.status, s.rule, s.isSpec, s.artifactName], ["rule", "requirement", String(id), null, "Suggested by rule", "proposed", "playwright_spec_from_requirement", true, "req-1-todo-can-be-added.spec.ts"]);
    assert.deepEqual(s.history.map((h) => [h.kind, h.byRule]), [["suggested", true]]);
    assert.equal(s.appliedAt, null);
    const again = runAs(rita, () => suggestSpecForRequirement(id));
    assert.deepEqual([again.created, again.message], [[], "This requirement already has a spec suggestion."]);
    const auto = runAs(rita, () => suggestAutomationForRequirement(id));
    assert.equal(auto.created.length, 1, "the automation suggestion is a different suggestion");
    assert.equal(listRequirementAutomationSuggestions(id).length, 2);
    runAs(rita, () => decideAutomationSuggestion(s.id, "rejected"));
    assert.equal(runAs(rita, () => suggestSpecForRequirement(id)).created.length, 0, "a rejected one is not made again");
  });

  it("the automation Apply refuses a spec, and the spec Apply refuses an automation suggestion", () => {
    const p = proj(); const id = reqIn(p.id);
    const s = runAs(rita, () => makeSpec(id)); const a = runAs(rita, () => suggestAutomationForRequirement(id)).created[0];
    assert.throws(() => runAs(rita, () => applyAutomationSuggestion(s.id)), /spec suggestion/);
    assert.throws(() => runAs(rita, () => applySpecSuggestion(a.id)), /not a spec suggestion/);
  });
});

describe("edit, Apply, download and delete for a requirement spec", () => {
  let ada!: AccountUser;
  before(() => { ada = user("Ada Req"); });

  it("the text is editable and the edit is in the history; before Apply there is no download", () => {
    const p = proj(); const id = reqIn(p.id);
    const s = runAs(ada, () => makeSpec(id));
    assert.throws(() => specFile(s.id), /Apply the spec first/);
    runAs(ada, () => editAutomationSuggestion(s.id, { artifactText: "// mine\n" }));
    const e = getAutomationSuggestion(s.id);
    assert.equal(e.artifactText, "// mine\n");
    assert.equal(e.history.at(-1)!.changes![0].field, "Spec text");
    assert.throws(() => runAs(ada, () => editAutomationSuggestion(s.id, { artifactText: "  " })), /needs its text/);
  });

  it("Apply records who and when, never approves, makes no test case, and makes the edited text downloadable", () => {
    const p = proj(); const id = reqIn(p.id);
    const s = runAs(ada, () => makeSpec(id));
    runAs(ada, () => editAutomationSuggestion(s.id, { artifactText: "// mine\n" }));
    const cases = count("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?", p.id);
    const made = runAs(ada, () => applySpecSuggestion(s.id));
    assert.equal(made.fileName, "req-1-todo-can-be-added.spec.ts");
    const r = row(s.id);
    assert.deepEqual([r.review_status, r.applied_by, r.applied_by_user_id, r.case_id], ["draft", "Ada Req", ada.id, null]);
    assert.ok(r.applied_at);
    assert.equal(count("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?", p.id), cases, "no test case");
    assert.deepEqual(specFile(s.id), { fileName: "req-1-todo-can-be-added.spec.ts", text: "// mine\n" });
    assert.throws(() => runAs(ada, () => applySpecSuggestion(s.id)), /already applied/);
    runAs(ada, () => decideAutomationSuggestion(s.id, "rejected"));
    assert.throws(() => specFile(s.id), /rejected, so it cannot be downloaded/);
  });

  it("the database refuses an Apply without an account", () => {
    const p = proj(); const id = reqIn(p.id);
    const s = runAs(ada, () => makeSpec(id));
    assert.throws(() => db.prepare("UPDATE automation_suggestions SET applied_at = datetime('now'), applied_by = 'x' WHERE id = ?").run(s.id), /needs a person with an account/);
    assert.throws(() => specFile(s.id), /Apply the spec first/);
  });

  it("deleting the requirement removes its spec suggestions", () => {
    const p = proj(); const id = reqIn(p.id);
    const s = runAs(ada, () => makeSpec(id)); runAs(ada, () => applySpecSuggestion(s.id));
    const other = reqIn(p.id, { title: "Other" }); runAs(ada, () => makeSpec(other));
    removeRequirementSuggestions(id);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestions WHERE id = ?", s.id), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestions WHERE project_id = ?", p.id), 1, "the other requirement's spec stays");
  });
});
