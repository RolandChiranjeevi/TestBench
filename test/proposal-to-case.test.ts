import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db } from "../server/db.ts";
import { makeManualRun, makeProject } from "./helpers.ts";
import { bagFromFiles } from "../server/importers/bag.ts";
import { importAuditPackage } from "../server/audits.ts";
import { agentRequirements } from "../server/agentexport.ts";
import { applyManualUpdate, addToProject, createCaseFromProposal, getManualTest, ignoreManualUpdate, listManualTests, reviewManualTest, updateManualTest } from "../server/manualtests.ts";
import { getRequirement, listRequirements } from "../server/requirements.ts";
import { approveImported, importRequirements } from "../server/reqimport.ts";
import { requirementCoverage } from "../server/reqlinks.ts";
import { coverageGaps } from "../server/coveragegaps.ts";

let n = 0;
const proj = () => makeProject(`PC${++n}`, `Proposal to case ${n}`);
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

const test = (over: Record<string, unknown> = {}) => ({
  sourceId: "focus-order", title: "Focus order follows the visual order", description: "Checkout", preconditions: "A cart with one item",
  steps: ["Open the checkout", "Tab through the controls", "Compare with the screen"], expected: "Focus moves top to bottom", priority: "high", category: "accessibility",
  wcag: ["2.4.3", "1.3.2"], refs: { requirements: ["CHK-A11Y"] }, ...over,
});
function run(p: { id: number; key: string }, tests: unknown[]) {
  const f = new Map<string, Uint8Array>();
  f.set("manifest.json", Buffer.from(JSON.stringify({ format: "testbench-audit-package", version: 1, audit: { id: "a1", title: "Audit", project: p.key, agent: { name: "agent" } }, files: [], parts: {} })));
  f.set("bugs.json", Buffer.from('{"version":1,"bugs":[]}'));
  f.set("manual-tests.json", Buffer.from(JSON.stringify({ version: 1, tests })));
  return importAuditPackage(bagFromFiles(f), { projectId: p.id, source: "upload" });
}
const setup = () => {
  const p = proj();
  importRequirements(p.id, JSON.stringify({ format: "testbench-requirements", version: 1, project: p.key, requirements: [{ id: "CHK-A11Y", title: "Keyboard users can pay", kind: "accessibility", wcag: ["2.4.3"] }] }));
  approveImported(p.id);
  run(p, [test()]);
  const id = (db.prepare("SELECT id FROM manual_tests WHERE project_id = ?").get(p.id) as { id: number }).id;
  return { p, id };
};
const caseOf = (id: number) => db.prepare("SELECT c.* FROM cases c JOIN manual_tests m ON m.case_id = c.id WHERE m.id = ?").get(id) as Record<string, any>;
const stepsOf = (caseId: number) => db.prepare("SELECT id, action, expected FROM case_steps WHERE case_id = ? ORDER BY position").all(caseId) as { id: number; action: string; expected: string }[];

describe("a proposal becomes a test case", () => {
  it("only after a person has accepted it", () => {
    const { id } = setup();
    assert.throws(() => createCaseFromProposal(id), /Accept the proposal first/);
    reviewManualTest(id, "rejected");
    assert.throws(() => createCaseFromProposal(id), /Accept the proposal first/);
    assert.equal(getManualTest(id).testCase, null);
  });

  it("creates a project test case with the steps, the expected result, the priority, tags and the requirement link", () => {
    const { p, id } = setup();
    updateManualTest(id, { humanPriority: "critical", title: "Focus order, my wording" });
    reviewManualTest(id, "accepted");
    const made = createCaseFromProposal(id);
    assert.equal(made.key, `${p.key}-1`);
    const c = caseOf(id);
    assert.deepEqual([c.project_id, c.title, c.priority, c.status, c.description, c.preconditions], [p.id, "Focus order, my wording", "critical", "draft", "Checkout", "A cart with one item"], "an AI suggestion never starts as ready");
    assert.deepEqual(JSON.parse(c.tags), ["agent-proposed", "accessibility", "wcag-1.3.2", "wcag-2.4.3"]);
    const steps = stepsOf(c.id);
    assert.deepEqual(steps.map((s) => s.action), ["Open the checkout", "Tab through the controls", "Compare with the screen"]);
    assert.deepEqual(steps.map((s) => s.expected), ["", "", "Focus moves top to bottom"], "the expected result sits on the last step");
    assert.deepEqual(listRequirements(p.id)[0].caseIds, [c.id], "linked to the requirement it names");
    const t = getManualTest(id);
    assert.deepEqual([t.testCase?.key, t.testCase?.title, t.testCase?.lastStatus, t.status], [`${p.key}-1`, "Focus order, my wording", null, "accepted"]);
    assert.equal(listManualTests(p.id).items[0].testCase, `${p.key}-1`);
  });

  it("only once: a second try says which test case it already is, and no second case is made", () => {
    const { p, id } = setup();
    reviewManualTest(id, "accepted");
    createCaseFromProposal(id);
    assert.throws(() => createCaseFromProposal(id), new RegExp(`already the test case ${p.key}-1`));
    assert.equal(count("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?", p.id), 1);
  });

  it("the project's cases are numbered as usual, and the case is not run by being created", () => {
    const { p, id } = setup();
    db.prepare("UPDATE projects SET next_case_number = 8 WHERE id = ?").run(p.id);
    reviewManualTest(id, "accepted");
    assert.equal(createCaseFromProposal(id).key, `${p.key}-8`);
    assert.equal(count("SELECT COUNT(*) AS n FROM results r JOIN runs ru ON ru.id = r.run_id WHERE ru.project_id = ?", p.id), 0);
    assert.equal(count("SELECT next_case_number AS n FROM projects WHERE id = ?", p.id), 9);
  });

  it("coverage follows the results of the case, which a person records by running it", () => {
    const { p, id } = setup();
    reviewManualTest(id, "accepted");
    createCaseFromProposal(id);
    const req = () => listRequirements(p.id)[0];
    assert.equal(req().coverage.state, "uncovered", "a draft case is linked, but only ready cases count");
    assert.deepEqual([req().links.cases, req().links.withoutTest], [0, true]);
    const caseId = caseOf(id).id;
    db.prepare("UPDATE cases SET status = 'ready' WHERE id = ?").run(caseId); // a person marks it ready
    assert.equal(req().coverage.state, "untested", "a ready case is linked and has not been run");
    assert.deepEqual([req().links.cases, req().links.withoutTest], [1, false]);
    makeManualRun(p.id, [[caseId, "passed"]], "2026-11-01 10:00:00");
    assert.equal(req().coverage.state, "passing");
    makeManualRun(p.id, [[caseId, "failed"]], "2026-11-02 10:00:00");
    assert.equal(req().coverage.state, "failing", "the latest result decides");
    assert.equal(getManualTest(id).testCase?.lastStatus, "failed");
    assert.deepEqual(getRequirement(req().id)?.cases.map((c) => c.id), [caseId]);
  });

  it("is in the agent's export as the test case the proposal became", () => {
    const { p, id } = setup();
    reviewManualTest(id, "accepted");
    createCaseFromProposal(id);
    let r = agentRequirements(p.id).requirements[0];
    assert.deepEqual(r.links.manualTests.map((t) => t.testCase), [`${p.key}-1`], "named as what the proposal became");
    assert.deepEqual(r.links.testCases, [], "but a draft is not a test case that covers the requirement");
    db.prepare("UPDATE cases SET status = 'ready' WHERE id = ?").run(caseOf(id).id);
    r = agentRequirements(p.id).requirements[0];
    assert.deepEqual(r.links.testCases, [`${p.key}-1`], "ready: it covers it");
  });
});

describe("after the test case exists", () => {
  it("the proposal's own text can no longer be edited: the test case is edited instead", () => {
    const { p, id } = setup();
    reviewManualTest(id, "accepted");
    createCaseFromProposal(id);
    assert.throws(() => updateManualTest(id, { title: "New" }), new RegExp(`become the test case ${p.key}-1. Edit the test case instead`));
    assert.throws(() => updateManualTest(id, { humanPriority: "low" }), /Edit the test case/);
    assert.equal(getManualTest(id).title, "Focus order follows the visual order");
  });

  it("a newer agent version waits; keeping mine leaves the case alone", () => {
    const { p, id } = setup();
    reviewManualTest(id, "accepted");
    createCaseFromProposal(id);
    db.prepare("UPDATE cases SET title = 'My own wording of the case' WHERE id = ?").run(caseOf(id).id);
    run(p, [test({ title: "Agent title 2", steps: ["One", "Two"], expected: "New expectation", priority: "low" })]);
    assert.ok(getManualTest(id).pendingUpdate, "waits as a revision");
    assert.equal(caseOf(id).title, "My own wording of the case", "the test case is not touched by an import");
    assert.equal(stepsOf(caseOf(id).id).length, 3);
    ignoreManualUpdate(id);
    assert.equal(getManualTest(id).pendingUpdate, null);
    assert.equal(caseOf(id).title, "My own wording of the case");
  });

  it("using the agent's version updates the case, keeps the step rows that exist (so earlier results keep their steps) and the case's number", () => {
    const { p, id } = setup();
    reviewManualTest(id, "accepted");
    createCaseFromProposal(id);
    const before = stepsOf(caseOf(id).id);
    const caseId = caseOf(id).id;
    run(p, [test({ title: "Agent title 2", steps: ["One", "Two"], expected: "New expectation", priority: "low", wcag: ["2.4.3"] })]);
    applyManualUpdate(id);
    const c = caseOf(id);
    assert.deepEqual([c.id, c.title, c.priority], [caseId, "Agent title 2", "low"]);
    assert.deepEqual(JSON.parse(c.tags), ["agent-proposed", "accessibility", "wcag-2.4.3"]);
    const after = stepsOf(caseId);
    assert.deepEqual(after.map((s) => [s.action, s.expected]), [["One", ""], ["Two", "New expectation"]]);
    assert.deepEqual(after.map((s) => s.id), before.slice(0, 2).map((s) => s.id), "the rows are reused");
    assert.equal(getManualTest(id).pendingUpdate, null);
    assert.equal(count("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?", p.id), 1);
  });

  it("an unchanged re-import changes nothing about the case", () => {
    const { p, id } = setup();
    reviewManualTest(id, "accepted");
    createCaseFromProposal(id);
    const before = JSON.stringify([caseOf(id), stepsOf(caseOf(id).id)]);
    run(p, [test()]);
    assert.equal(JSON.stringify([caseOf(id), stepsOf(caseOf(id).id)]), before);
  });

  it("if the test case is deleted the proposal can become a test case again", () => {
    const { p, id } = setup();
    reviewManualTest(id, "accepted");
    const first = createCaseFromProposal(id);
    db.prepare("DELETE FROM cases WHERE id = ?").run(first.caseId);
    assert.equal(getManualTest(id).testCase, null);
    const second = createCaseFromProposal(id);
    assert.equal(getManualTest(id).testCase?.key, second.key);
    assert.equal(second.key, `${p.key}-2`, "numbers are not reused");
  });

  it("a proposal never links its case to another project's requirements", () => {
    const { p, id } = setup();
    const other = proj();
    importRequirements(other.id, JSON.stringify({ format: "testbench-requirements", version: 1, project: other.key, requirements: [{ id: "CHK-A11Y", title: "The other project's own" }] }));
    approveImported(other.id);
    reviewManualTest(id, "accepted");
    const c = createCaseFromProposal(id);
    assert.deepEqual(listRequirements(other.id)[0].caseIds, []);
    assert.deepEqual(listRequirements(p.id)[0].caseIds, [c.caseId]);
  });
});

describe("adding a suggestion to the project in one step", () => {
  const manual = (id: number) => db.prepare("SELECT review_status, reviewed_at, review_note, case_id FROM manual_tests WHERE id = ?").get(id) as { review_status: string; reviewed_at: string | null; review_note: string; case_id: number | null };
  const cases = (projectId: number) => count("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?", projectId);

  it("accepts and makes the test case in one go, as a draft, with the steps, the requirement link and the optional note", () => {
    const { p, id } = setup();
    const made = addToProject(id, "Looks right");
    assert.equal(made.key, `${p.key}-1`);
    const m = manual(id);
    assert.deepEqual([m.review_status, !!m.reviewed_at, m.review_note, m.case_id], ["accepted", true, "Looks right", caseOf(id).id]);
    const c = caseOf(id);
    assert.deepEqual([c.status, c.title], ["draft", "Focus order follows the visual order"], "a suggestion never starts as ready");
    assert.deepEqual(stepsOf(c.id).map((s) => s.action), ["Open the checkout", "Tab through the controls", "Compare with the screen"]);
    assert.equal(count("SELECT COUNT(*) AS n FROM requirement_cases WHERE case_id = ?", c.id), 1, "linked to the requirement it names");
    assert.deepEqual([getManualTest(id).testCase?.status, getManualTest(id).status], ["draft", "accepted"]);
  });

  it("the person's edits come first: what they wrote is what is added", () => {
    const { id } = setup();
    updateManualTest(id, { title: "My wording", humanPriority: "critical" });
    addToProject(id);
    const c = caseOf(id);
    assert.deepEqual([c.title, c.priority, c.status], ["My wording", "critical", "draft"]);
  });

  it("a suggestion that is already a test case is refused with 409 and nothing changes: repeating it makes no second case", () => {
    const { p, id } = setup();
    addToProject(id);
    for (let i = 0; i < 3; i++) assert.throws(() => addToProject(id), (e: unknown) => (e as { status?: number }).status === 409 && /already the test case/.test((e as Error).message));
    assert.equal(cases(p.id), 1);
    assert.equal(manual(id).review_status, "accepted");
  });

  it("finishes a suggestion that was accepted before but never made into a case (a retry after a half-done step)", () => {
    const { p, id } = setup();
    reviewManualTest(id, "accepted");
    assert.equal(manual(id).case_id, null);
    addToProject(id);
    assert.equal(cases(p.id), 1);
    assert.equal(caseOf(id).status, "draft");
  });

  it("a dismissed suggestion is refused (restore it first) and stays dismissed with no case; once restored it can be added", () => {
    const { p, id } = setup();
    reviewManualTest(id, "rejected", "Not needed right now");
    assert.throws(() => addToProject(id), (e: unknown) => (e as { status?: number }).status === 409 && /Restore it to Suggested first/.test((e as Error).message));
    assert.deepEqual([manual(id).review_status, manual(id).case_id, cases(p.id)], ["rejected", null, 0]);
    reviewManualTest(id, "proposed"); // restored: it is a suggestion again, and nothing was lost
    assert.equal(manual(id).reviewed_at, null);
    addToProject(id);
    assert.deepEqual([manual(id).review_status, cases(p.id)], ["accepted", 1]);
  });

  it("an unknown suggestion is a 404", () => {
    setup();
    assert.throws(() => addToProject(999999), (e: unknown) => (e as { status?: number }).status === 404);
  });

  it("if the case cannot be made, the acceptance is undone too (one transaction)", () => {
    const { p, id } = setup();
    db.prepare("DROP TRIGGER IF EXISTS fail_new_case").run();
    db.prepare("CREATE TEMP TRIGGER fail_new_case BEFORE INSERT ON cases BEGIN SELECT RAISE(ABORT, 'no case today'); END").run();
    try {
      assert.throws(() => addToProject(id), /no case today/);
    } finally {
      db.prepare("DROP TRIGGER fail_new_case").run();
    }
    assert.deepEqual([manual(id).review_status, manual(id).case_id, cases(p.id)], ["proposed", null, 0], "still a suggestion");
  });
});

describe("only ready test cases count as coverage", () => {
  it("a draft made from a suggestion covers nothing; marking it ready makes it count; deprecating it stops it", () => {
    const { p, id } = setup();
    const req = () => listRequirements(p.id)[0];
    addToProject(id);
    const caseId = caseOf(id).id;
    assert.deepEqual([req().coverage.state, req().links.cases, req().links.withoutTest, req().activeCaseIds], ["uncovered", 0, true, []], "a draft does not count");
    assert.equal(requirementCoverage(p.id).summary.withoutTest, 1);
    assert.equal(agentRequirements(p.id).requirements[0].coverage.hasTest, false, "nor for an agent");
    assert.deepEqual(coverageGaps(p.id).requirementsWithoutCases.map((r) => r.id), [req().id], "it is still a gap");
    assert.equal(getRequirement(req().id)?.coverage.state, "uncovered", "also in the detail view");
    db.prepare("UPDATE cases SET status = 'ready' WHERE id = ?").run(caseId);
    assert.deepEqual([req().coverage.state, req().links.cases, req().links.withoutTest, req().activeCaseIds], ["untested", 1, false, [caseId]], "ready counts");
    assert.equal(requirementCoverage(p.id).summary.withoutTest, 0);
    assert.equal(agentRequirements(p.id).requirements[0].coverage.hasTest, true);
    assert.deepEqual(coverageGaps(p.id).requirementsWithoutCases, []);
    db.prepare("UPDATE cases SET status = 'deprecated' WHERE id = ?").run(caseId);
    assert.deepEqual([req().coverage.state, req().links.withoutTest], ["uncovered", true], "a deprecated case does not count either");
  });

  it("a case a person writes keeps counting only when it is ready, the same rule for every case", () => {
    const { p } = setup();
    const c = db.prepare("INSERT INTO cases (project_id, number, title, status) VALUES (?, 50, 'By hand', 'draft') RETURNING id").get(p.id) as { id: number };
    db.prepare("INSERT INTO requirement_cases (requirement_id, case_id) VALUES (?, ?)").run(listRequirements(p.id)[0].id, c.id);
    assert.equal(listRequirements(p.id)[0].links.withoutTest, true, "a draft written by hand does not count either");
    db.prepare("UPDATE cases SET status = 'ready' WHERE id = ?").run(c.id);
    assert.equal(listRequirements(p.id)[0].links.withoutTest, false);
  });
});
