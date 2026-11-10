import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db } from "../server/db.ts";
import { makeManualRun, makeProject } from "./helpers.ts";
import { bagFromFiles } from "../server/importers/bag.ts";
import { importAuditPackage } from "../server/audits.ts";
import { agentRequirements } from "../server/agentexport.ts";
import { applyManualUpdate, createCaseFromProposal, getManualTest, ignoreManualUpdate, listManualTests, reviewManualTest, updateManualTest } from "../server/manualtests.ts";
import { getRequirement, listRequirements } from "../server/requirements.ts";
import { approveImported, importRequirements } from "../server/reqimport.ts";

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
    assert.deepEqual([c.project_id, c.title, c.priority, c.status, c.description, c.preconditions], [p.id, "Focus order, my wording", "critical", "ready", "Checkout", "A cart with one item"]);
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
    assert.equal(req().coverage.state, "untested", "a case is linked and has not been run");
    assert.deepEqual([req().links.cases, req().links.withoutTest], [1, false]);
    const caseId = caseOf(id).id;
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
    const r = agentRequirements(p.id).requirements[0];
    assert.deepEqual(r.links.manualTests.map((t) => t.testCase), [`${p.key}-1`]);
    assert.deepEqual(r.links.testCases, [`${p.key}-1`]);
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
