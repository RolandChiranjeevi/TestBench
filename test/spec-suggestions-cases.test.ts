import "./env.ts";
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { runAs, type AccountUser } from "../server/accountcontext.ts";
import { db } from "../server/db.ts";
import { deleteCases } from "../server/deletion.ts";
import { importReport } from "../server/importers/import.ts";
import { parseReport } from "../server/importers/parse.ts";
import {
  applyAutomationSuggestion, applySpecSuggestion, buildSpec, decideAutomationSuggestion, editAutomationSuggestion, getAutomationSuggestion, listCaseAutomationSuggestions, specFile,
  suggestSpecForCase, suggestSpecFromCase, suggestSpecFromRequirement, suggestSpecForRequirement, type CaseFields,
} from "../server/automation.ts";
import { makeCase, makeProject } from "./helpers.ts";

// E3: a Playwright spec suggestion made from a test case. Same template, same rules for edits, Apply and download as for a plan item or a requirement (E1, E2), plus the expected result of
// every step, and the case's tag in the test's title so that imported results are linked to the test case.

let n = 0;
const proj = () => makeProject(`SC${++n}`, `Spec case ${n}`);
const user = (name: string): AccountUser => {
  const id = (db.prepare("INSERT INTO users (email, name, password_hash) VALUES (?, ?, 'h') RETURNING id").get(`${name.toLowerCase().replace(/\W/g, "")}@x.io`, name) as { id: number }).id;
  return { id, email: "", name, isOwner: false, disabledAt: null, createdAt: "", lastLoginAt: null };
};
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
const row = (id: number) => db.prepare("SELECT * FROM automation_suggestions WHERE id = ?").get(id) as Record<string, any>;
const STEPS: [string, string][] = [["Open the login page", "The form is shown"], ["Sign in as a user", ""], ["Open the cart", "The cart is empty"]];
const readyCase = (projectId: number, title = "Login works", steps: [string, string][] = STEPS, status = "ready") => makeCase(projectId, title, { steps, status });
const makeSpec = (caseId: number) => { const r = suggestSpecForCase(caseId); assert.equal(r.created.length, 1, r.message); return r.created[0]; };
const fields = (over: Partial<CaseFields> = {}): CaseFields => ({ title: "Login works", description: "", preconditions: "", priority: "high", steps: STEPS.map(([action, expected]) => ({ action, expected })), ...over });
const titleOf = (text: string) => JSON.parse(/^ {2}test\((".*"), async/m.exec(text)![1]) as string;

describe("the spec rule for a test case", () => {
  it("is deterministic, named tc-<number>-<title>, starts with test.fixme (once), and has a step for every step of the case", () => {
    const a = suggestSpecFromCase(fields(), "SC1-7", 7), b = suggestSpecFromCase(fields(), "SC1-7", 7);
    assert.deepEqual(a, b);
    assert.ok("content" in a);
    assert.equal(a.fileName, "tc-7-login-works.spec.ts");
    const t = a.content.artifactText!;
    assert.equal(t.split("test.fixme(").length - 1, 1);
    assert.match(t, /from test case SC1-7 by a fixed rule/);
    for (const [action] of STEPS) assert.ok(t.includes(`await test.step(${JSON.stringify(action)}, async () => {`), action);
    assert.doesNotMatch(t, /page\.(goto|locator|getBy)|https?:\/\//, "no selector and no URL is made up");
    assert.doesNotMatch(t, /Checks \(from the acceptance criteria\)/, "the checks are the steps' own expected results");
  });

  it("the title ends with the case's tag, in the test's own title, and the tag survives a very long title", () => {
    const a = suggestSpecFromCase(fields(), "SC1-7", 7);
    assert.ok("content" in a);
    assert.equal(titleOf(a.content.artifactText!), "Login works @SC1-7");
    assert.match(a.content.artifactText!, /test\.describe\("Login works", /, "the describe block has the plain title");
    const long = suggestSpecFromCase(fields({ title: "Long ".repeat(200) }), "SC1-7", 7);
    assert.ok("content" in long);
    assert.ok(titleOf(long.content.artifactText!).endsWith(" @SC1-7"), titleOf(long.content.artifactText!).slice(-30));
  });

  it("every step has its expected result as a comment and a TODO to write the expect; a step without one has a TODO and nothing is made up", () => {
    const a = suggestSpecFromCase(fields(), "SC1-7", 7);
    assert.ok("content" in a);
    const t = a.content.artifactText!;
    assert.match(t, /\/\/ Expected: The form is shown\n +\/\/ TODO: expect\(\.\.\.\) for the expected result above/);
    assert.match(t, /\/\/ Expected: The cart is empty/);
    assert.equal(t.split("// Expected: ").length - 1, 2, "only the two expected results the case has");
    assert.equal(t.split("// TODO: Fill in the expected result for this step.").length - 1, 1, "one TODO, for the step that has none");
    const block = t.split("await test.step(").find((s) => s.startsWith('"Sign in as a user"'))!;
    assert.match(block, /TODO: Fill in the expected result for this step\./);
    assert.doesNotMatch(block, /Expected: /);
    assert.match(a.content.summary, /1 without an expected result/);
  });

  it("the case's preconditions and description are comments, and nothing is made without steps", () => {
    const a = suggestSpecFromCase(fields({ preconditions: "A user exists", description: "Covers sign in" }), "SC1-7", 7);
    assert.ok("content" in a);
    assert.match(a.content.artifactText!, /\/\/ {3}Preconditions: A user exists\n +\/\/ {3}Description: Covers sign in/);
    for (const steps of [[], [{ action: "  ", expected: "x" }]]) {
      assert.deepEqual(suggestSpecFromCase(fields({ steps }), "SC1-7", 7), { reason: "Nothing was generated: the test case has no steps. Add steps to the test case and ask again." });
    }
  });

  it("hostile text can only end up inside a string literal or a comment: no extra code line, no tricky character", () => {
    const evil = '"); process.exit(1); //\n*/ `${x}` \u2028 \u202e \u0000 await evil();';
    const r = suggestSpecFromCase(fields({ title: evil, description: evil, preconditions: evil, steps: [{ action: evil, expected: evil }, { action: evil, expected: "" }] }), "SC1-2", 2);
    assert.ok("content" in r);
    const t = r.content.artifactText!;
    assert.doesNotMatch(t, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028-\u202e]/);
    const code = t.split("\n").filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/"(?:[^"\\\n]|\\.)*"/g, '""'));
    const ok = [/^$/, /^import \{ test, expect \} from "";$/, /^test\.describe\("", \(\) => \{$/, /^ +test\("", async \(\{ page \}\) => \{$/, /^ +test\.fixme\(true, ""\);$/, /^ +await test\.step\("", async \(\) => \{$/, /^ *\}\);$/];
    assert.ok(code.every((l) => ok.some((re) => re.test(l))), code.join("\n"));
  });

  it("a key that cannot be a tag makes nothing", () => {
    for (const key of ["", "sc1-7", "SC1_7", "SC1-", 'SC1-7"); //']) assert.ok("reason" in suggestSpecFromCase(fields(), key, 7), key);
  });
});

describe("the E1 and E2 templates are unchanged", () => {
  // Made with the code as it was before E3. The case's own parts (an expected result per step, a tag) are opt-in, so nothing else may move.
  it("buildSpec without them gives exactly the text it gave", () => {
    assert.equal(
      buildSpec({ source: "plan item P1", title: "Login works", steps: ["Open the page", "Sign in"], assertions: ["The dashboard shows", "No error"], testData: "user: demo\nrole: admin" }),
      [
        "// DRAFT: made by TestBench from plan item P1 by a fixed rule. Not reviewed and not run.",
        "// A person rewrites every TODO. Remove test.fixme only when the test is finished and reviewed.",
        'import { test, expect } from "@playwright/test";',
        "",
        'test.describe("Login works", () => {',
        '  test("Login works", async ({ page }) => {',
        '    test.fixme(true, "Draft from TestBench: not reviewed, not run. Remove this line when a person has finished the test.");',
        "    // Test data (from the source):",
        "    //   user: demo",
        "    //   role: admin",
        '    await test.step("Open the page", async () => {',
        "      // TODO: where this starts and what to do (no selector or URL is known here)",
        "    });",
        '    await test.step("Sign in", async () => {',
        "      // TODO: where this starts and what to do (no selector or URL is known here)",
        "    });",
        "    // Checks (from the acceptance criteria):",
        "    // TODO: expect(...) for: The dashboard shows",
        "    // TODO: expect(...) for: No error",
        "  });",
        "});",
        "",
      ].join("\n"),
    );
  });

  it("a requirement spec has no tag and no per-step expected results", () => {
    const r = suggestSpecFromRequirement({ title: "Todo can be added", description: "A user with an empty list.", acceptanceCriteria: "- The text is shown\n- The input is cleared", kind: "functional", priority: "high", wcag: [], viewports: [] }, 7);
    assert.ok("content" in r);
    const t = r.content.artifactText!;
    assert.equal(titleOf(t), "Todo can be added");
    assert.doesNotMatch(t, /@REQ|@SC|Expected: |Fill in the expected result/);
    assert.match(t, /\/\/ Checks \(from the acceptance criteria\):/);
  });
});

describe("who gets a spec for a test case, and once", () => {
  let tess!: AccountUser;
  before(() => { tess = user("Tess Case"); });

  it("only a ready test case gets one: a draft or deprecated one is 409, an unknown one is 404, and nothing is stored", () => {
    const p = proj(); const draft = readyCase(p.id, "D", STEPS, "draft"), old = readyCase(p.id, "O", STEPS, "deprecated");
    for (const c of [draft, old]) assert.throws(() => runAs(tess, () => suggestSpecForCase(c.id)), /Make the test case ready first/);
    assert.throws(() => runAs(tess, () => suggestSpecForCase(999999)), /not found/);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestions WHERE project_id = ?", p.id), 0);
  });

  it("a test case without steps stores nothing and says why", () => {
    const p = proj(); const c = readyCase(p.id, "Empty", []);
    const r = runAs(tess, () => suggestSpecForCase(c.id));
    assert.deepEqual([r.created, r.message], [[], "Nothing was generated: the test case has no steps. Add steps to the test case and ask again."]);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestions WHERE project_id = ?", p.id), 0);
  });

  it("is the rule's: origin rule, a spec for the case, proposed, not applied, with a file name; asking again makes no second one; a rejected one is not made again", () => {
    const p = proj(); const c = readyCase(p.id);
    const s = runAs(tess, () => makeSpec(c.id));
    assert.deepEqual([s.origin, s.subjectKind, s.sourceId, s.auditId, s.label, s.status, s.rule, s.isSpec, s.artifactName], ["rule", "case", String(c.id), null, "Suggested by rule", "proposed", "playwright_spec_from_case", true, `tc-${c.number}-login-works.spec.ts`]);
    assert.deepEqual(s.history.map((h) => [h.kind, h.byRule]), [["suggested", true]]);
    assert.equal(s.appliedAt, null);
    assert.equal(s.testCase, null, "a spec suggestion makes no test case");
    const again = runAs(tess, () => suggestSpecForCase(c.id));
    assert.deepEqual([again.created, again.message], [[], "This test case already has a spec suggestion."]);
    assert.equal(listCaseAutomationSuggestions(c.id).length, 1);
    runAs(tess, () => decideAutomationSuggestion(s.id, "rejected"));
    assert.equal(runAs(tess, () => suggestSpecForCase(c.id)).created.length, 0, "a rejected one is not made again");
  });

  it("the list is of that case only, and the automation Apply refuses a spec", () => {
    const p = proj(); const a = readyCase(p.id, "A"), b = readyCase(p.id, "B");
    const s = runAs(tess, () => makeSpec(a.id)); runAs(tess, () => makeSpec(b.id));
    assert.deepEqual(listCaseAutomationSuggestions(a.id).map((x) => x.id), [s.id]);
    assert.throws(() => runAs(tess, () => applyAutomationSuggestion(s.id)), /spec suggestion/);
  });
});

describe("edit, Apply, download and change for a case spec", () => {
  let ada!: AccountUser;
  before(() => { ada = user("Ada Case"); });

  it("the text is editable and the edit is in the history; before Apply there is no download", () => {
    const p = proj(); const c = readyCase(p.id);
    const s = runAs(ada, () => makeSpec(c.id));
    assert.throws(() => specFile(s.id), /Apply the spec first/);
    runAs(ada, () => editAutomationSuggestion(s.id, { artifactText: "// mine\n" }));
    assert.equal(getAutomationSuggestion(s.id).history.at(-1)!.changes![0].field, "Spec text");
  });

  it("Apply records who and when, never approves, makes no test case, and makes the edited text downloadable", () => {
    const p = proj(); const c = readyCase(p.id);
    const s = runAs(ada, () => makeSpec(c.id));
    runAs(ada, () => editAutomationSuggestion(s.id, { artifactText: "// mine\n" }));
    const cases = count("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?", p.id);
    const made = runAs(ada, () => applySpecSuggestion(s.id));
    assert.equal(made.fileName, `tc-${c.number}-login-works.spec.ts`);
    const r = row(s.id);
    assert.deepEqual([r.review_status, r.applied_by, r.applied_by_user_id, r.case_id], ["draft", "Ada Case", ada.id, null]);
    assert.equal(count("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?", p.id), cases, "no test case");
    assert.deepEqual(specFile(s.id), { fileName: `tc-${c.number}-login-works.spec.ts`, text: "// mine\n" });
  });

  it("the database refuses an Apply without an account", () => {
    const p = proj(); const c = readyCase(p.id);
    const s = runAs(ada, () => makeSpec(c.id));
    assert.throws(() => db.prepare("UPDATE automation_suggestions SET applied_at = datetime('now'), applied_by = 'x' WHERE id = ?").run(s.id), /needs a person with an account/);
  });

  it("when the test case changes afterwards, the suggestion says so (and a changed expected result counts)", () => {
    const p = proj(); const c = readyCase(p.id);
    const s = runAs(ada, () => makeSpec(c.id));
    assert.equal(getAutomationSuggestion(s.id).subjectChanged, false);
    db.prepare("UPDATE case_steps SET expected = 'Something else' WHERE case_id = ? AND position = 0").run(c.id);
    assert.equal(getAutomationSuggestion(s.id).subjectChanged, true);
    assert.equal(getAutomationSuggestion(s.id).subjectGone, false);
  });
});

describe("when the test case goes", () => {
  let ida!: AccountUser;
  before(() => { ida = user("Ida Case"); });
  const spec = (caseId: number) => runAs(ida, () => makeSpec(caseId));
  const mine = (projectId: number) => count("SELECT COUNT(*) AS n FROM automation_suggestions WHERE project_id = ?", projectId);

  it("deleting one case removes its spec suggestions (and their history), and only those", () => {
    const p = proj(); const a = readyCase(p.id, "A"), b = readyCase(p.id, "B");
    const sa = spec(a.id); spec(b.id);
    db.prepare("DELETE FROM cases WHERE id = ?").run(a.id);
    assert.equal(mine(p.id), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestion_revisions WHERE suggestion_id = ?", sa.id), 0);
    assert.equal(listCaseAutomationSuggestions(b.id).length, 1);
  });

  it("deleting several at once (the case list's delete) removes them too", () => {
    const p = proj(); const a = readyCase(p.id, "A"), b = readyCase(p.id, "B"), c = readyCase(p.id, "C");
    spec(a.id); spec(b.id); spec(c.id);
    deleteCases(p.id, [a.id, b.id]);
    assert.equal(mine(p.id), 1);
    assert.equal(listCaseAutomationSuggestions(c.id).length, 1);
  });

  it("deleting the project removes them, and another project's suggestions are not touched", () => {
    const p = proj(), q = proj();
    spec(readyCase(p.id).id); spec(readyCase(q.id).id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(p.id);
    assert.equal(mine(p.id), 0);
    assert.equal(mine(q.id), 1);
  });

  it("a requirement's suggestion is left alone when a case goes", () => {
    const p = proj(); const c = readyCase(p.id);
    const q = (db.prepare("INSERT INTO requirements (project_id, number, title, status, acceptance_criteria) VALUES (?, 1, 'R', 'approved', '- ok') RETURNING id").get(p.id) as { id: number }).id;
    spec(c.id);
    runAs(ida, () => suggestSpecForRequirement(q));
    db.prepare("DELETE FROM cases WHERE id = ?").run(c.id);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestions WHERE project_id = ? AND subject_kind = 'requirement'", p.id), 1);
    assert.equal(mine(p.id), 1);
  });
});

describe("results are linked to the test case by the tag in the title", () => {
  let lena!: AccountUser;
  before(() => { lena = user("Lena Case"); });

  /** A Playwright JSON report in which the test has this title, as Playwright writes it. */
  const report = (file: string, title: string) => JSON.stringify({
    config: { rootDir: "/repo/e2e" }, stats: { startTime: "2026-01-02T03:04:05.000Z" },
    suites: [{ title: file, file, specs: [{ title, file, line: 3, column: 1, tests: [{ projectName: "chromium", status: "expected", results: [{ status: "passed", duration: 12, retry: 0 }] }] }] }],
  });
  const linked = (projectId: number, title: string, file = "x.spec.ts") => {
    const res = importReport(parseReport(report(file, title)), { projectId, source: "upload", title: "import" });
    return db.prepare("SELECT r.case_id AS r, t.case_id AS t FROM results r JOIN automated_tests t ON t.id = r.automated_test_id WHERE r.run_id = ?").get(res.runId) as { r: number | null; t: number | null };
  };

  it("an import of a test with the generated title links its result and its automated test to the case", () => {
    const p = proj(); const c = readyCase(p.id);
    const s = runAs(lena, () => makeSpec(c.id));
    const title = titleOf(s.artifactText);
    assert.equal(title, `Login works @${p.key}-${c.number}`);
    assert.deepEqual(linked(p.id, title, s.artifactName!), { r: c.id, t: c.id });
  });

  it("the same title without the tag is not linked: the tag is what does it", () => {
    const p = proj(); readyCase(p.id);
    assert.deepEqual(linked(p.id, "Login works"), { r: null, t: null });
  });

  it("the tag of another project's case does not link", () => {
    const p = proj(), q = proj(); readyCase(p.id); const other = readyCase(q.id);
    const s = runAs(lena, () => makeSpec(other.id));
    assert.deepEqual(linked(p.id, titleOf(s.artifactText)), { r: null, t: null });
  });
});
