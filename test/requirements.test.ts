import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db } from "../server/db.ts";
import {
  addRequirementCases, classify, createRequirement, getRequirement, linkCaseByText, listRequirements, markReviewed, recordRevision,
  requirementSummary, setCaseRequirements, setRequirementCases,
} from "../server/requirements.ts";
import { makeCase, makeManualRun, makeProject } from "./helpers.ts";

describe("classify", () => {
  it("names the coverage state from the latest status of each linked case", () => {
    assert.equal(classify([]).state, "uncovered");
    assert.equal(classify(["passed", "passed"]).state, "passing");
    assert.equal(classify(["passed", "failed"]).state, "failing");
    assert.equal(classify(["passed", "blocked"]).state, "failing");
    assert.equal(classify(["passed", undefined]).state, "partial");
    assert.equal(classify([undefined, undefined]).state, "untested");
  });

  it("counts passing, failing and not-run cases", () => {
    assert.deepEqual(classify(["passed", "failed", undefined]), { state: "failing", cases: 3, passing: 1, failing: 1, notRun: 1 });
  });
});

describe("coverage from results", () => {
  const p = makeProject("C");
  const a = makeCase(p.id, "A");
  const b = makeCase(p.id, "B");
  const dep = makeCase(p.id, "Deprecated", { status: "deprecated" });
  const req = createRequirement(p.id, { title: "R" });
  setRequirementCases(req, p.id, [a.id, b.id, dep.id]);
  const stateOf = () => listRequirements(p.id).find((r) => r.id === req)!.coverage;

  it("starts as not run", () => assert.equal(stateOf().state, "untested"));

  it("uses the newest executed result per case, and ignores skipped and untested", () => {
    makeManualRun(p.id, [[a.id, "failed"], [b.id, "passed"]], "2026-10-20 09:00:00");
    assert.equal(stateOf().state, "failing");
    makeManualRun(p.id, [[a.id, "passed"], [b.id, "skipped"]], "2026-10-21 09:00:00");
    // a now passes; b's newest result is skipped, so its older pass still counts
    assert.equal(stateOf().state, "passing");
    makeManualRun(p.id, [[a.id, "untested"]], "2026-10-22 09:00:00");
    assert.equal(stateOf().state, "passing");
  });

  it("leaves deprecated cases out of the count", () => {
    assert.equal(stateOf().cases, 2);
    makeManualRun(p.id, [[dep.id, "failed"]], "2026-10-23 09:00:00");
    assert.equal(stateOf().state, "passing");
  });

  it("summarises the project", () => {
    const empty = createRequirement(p.id, { title: "No tests yet" });
    const s = requirementSummary(p.id);
    assert.equal(s.total, 2);
    assert.equal(s.covered, 1);
    assert.equal(s.uncovered, 1);
    assert.equal(s.passing, 1);
    assert.ok(empty > 0);
  });
});

describe("links", () => {
  it("ignore cases and requirements from other projects", () => {
    const p1 = makeProject("L1");
    const p2 = makeProject("L2");
    const c1 = makeCase(p1.id, "one");
    const c2 = makeCase(p2.id, "two");
    const r1 = createRequirement(p1.id, { title: "r1" });
    setRequirementCases(r1, p1.id, [c1.id, c2.id]);
    assert.deepEqual(listRequirements(p1.id)[0].caseIds, [c1.id]);
    setCaseRequirements(c1.id, p1.id, [r1, 999999]);
    assert.deepEqual(listRequirements(p1.id)[0].caseIds, [c1.id]);
  });

  it("can be edited from the case side without disturbing other cases", () => {
    const p = makeProject("L3");
    const c1 = makeCase(p.id, "one");
    const c2 = makeCase(p.id, "two");
    const r1 = createRequirement(p.id, { title: "r1" });
    const r2 = createRequirement(p.id, { title: "r2" });
    setRequirementCases(r1, p.id, [c1.id, c2.id]);
    setCaseRequirements(c1.id, p.id, [r2]);
    const byId = new Map(listRequirements(p.id).map((r) => [r.id, r.caseIds]));
    assert.deepEqual(byId.get(r1), [c2.id]);
    assert.deepEqual(byId.get(r2), [c1.id]);
  });

  it("addRequirementCases adds without removing", () => {
    const p = makeProject("L4");
    const c1 = makeCase(p.id, "one");
    const c2 = makeCase(p.id, "two");
    const r = createRequirement(p.id, { title: "r" });
    setRequirementCases(r, p.id, [c1.id]);
    addRequirementCases(r, p.id, [c2.id, c1.id]);
    assert.deepEqual(listRequirements(p.id)[0].caseIds.sort(), [c1.id, c2.id].sort());
  });
});

describe("@REQ-n in text", () => {
  const p = makeProject("T");
  const c = makeCase(p.id, "case");
  const r1 = createRequirement(p.id, { title: "one" });
  createRequirement(p.id, { title: "two" });

  it("links the case, only adds, and ignores unknown requirements", () => {
    linkCaseByText(c.id, p.id, "does things @REQ-1 and @REQ-77");
    assert.deepEqual(listRequirements(p.id).find((r) => r.id === r1)!.caseIds, [c.id]);
    linkCaseByText(c.id, p.id, "now mentions only @REQ-2");
    assert.deepEqual(listRequirements(p.id).find((r) => r.id === r1)!.caseIds, [c.id]); // still linked
    assert.equal(listRequirements(p.id).find((r) => r.number === 2)!.caseIds.length, 1);
  });
});

describe("change history and review flags", () => {
  const p = makeProject("H");
  const c1 = makeCase(p.id, "linked before the edit");
  const req = createRequirement(p.id, { title: "Original wording" });
  setRequirementCases(req, p.id, [c1.id]);
  const flagged = () => getRequirement(req)!.cases.map((c) => c.review_needed);

  it("starts with a created entry and a link entry, nothing to review", () => {
    const h = getRequirement(req)!.history;
    assert.deepEqual(h.map((x) => x.changes[0].field).sort(), ["cases", "created"]);
    assert.deepEqual(flagged(), [false]);
  });

  it("a wording change flags linked cases; other changes do not", () => {
    recordRevision(req, [{ field: "priority", from: "medium", to: "high" }], false);
    assert.deepEqual(flagged(), [false]);
    recordRevision(req, [{ field: "title", from: "Original wording", to: "New wording" }], true);
    assert.deepEqual(flagged(), [true]);
  });

  it("cases linked after the change start confirmed, and existing links keep their flag", () => {
    const c2 = makeCase(p.id, "linked after the edit");
    addRequirementCases(req, p.id, [c2.id]);
    const byNumber = new Map(getRequirement(req)!.cases.map((c) => [c.id, c.review_needed]));
    assert.equal(byNumber.get(c1.id), true);
    assert.equal(byNumber.get(c2.id), false);
  });

  it("markReviewed clears one case or all", () => {
    markReviewed(req, [getRequirement(req)!.cases[0].id]);
    assert.deepEqual(flagged(), [false, false]);
    recordRevision(req, [{ field: "description", from: "a", to: "b" }], true);
    assert.deepEqual(flagged(), [true, true]);
    markReviewed(req);
    assert.deepEqual(flagged(), [false, false]);
  });

  it("is removed together with the requirement", () => {
    db.prepare("DELETE FROM requirements WHERE id = ?").run(req);
    const n = db.prepare("SELECT COUNT(*) AS n FROM requirement_revisions WHERE requirement_id = ?").get(req) as { n: number };
    assert.equal(n.n, 0);
  });
});
