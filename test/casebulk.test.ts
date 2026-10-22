import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db, parseJson } from "../server/db.ts";
import { bulkUpdateCases, CaseBulkError, duplicateCase } from "../server/casebulk.ts";
import { createRequirement, setRequirementCases } from "../server/requirements.ts";
import { makeCase, makeProject, makeSuite } from "./helpers.ts";

const row = (id: number) => db.prepare("SELECT * FROM cases WHERE id = ?").get(id) as Record<string, any>;
const tagsOf = (id: number) => parseJson<string[]>(row(id).tags, []);

describe("bulkUpdateCases", () => {
  it("moves cases to a suite, or to no suite, and leaves everything else alone", () => {
    const p = makeProject("BU");
    const auth = makeSuite(p.id, "Auth");
    const a = makeCase(p.id, "A", { tags: ["x"] });
    const b = makeCase(p.id, "B");
    const untouched = makeCase(p.id, "Untouched");

    assert.deepEqual(bulkUpdateCases(p.id, [a.id, b.id], { suiteId: auth }), { updated: 2 });
    assert.equal(row(a.id).suite_id, auth);
    assert.equal(row(b.id).suite_id, auth);
    assert.equal(row(untouched.id).suite_id, null);
    assert.deepEqual(tagsOf(a.id), ["x"]); // priority, status and tags unchanged

    bulkUpdateCases(p.id, [a.id], { suiteId: null });
    assert.equal(row(a.id).suite_id, null);
    assert.equal(row(b.id).suite_id, auth);
  });

  it("sets priority and status without touching the suite", () => {
    const p = makeProject("BP");
    const s = makeSuite(p.id, "S");
    const c = makeCase(p.id, "C", { suiteId: s });
    bulkUpdateCases(p.id, [c.id], { priority: "critical", status: "deprecated" });
    assert.equal(row(c.id).priority, "critical");
    assert.equal(row(c.id).status, "deprecated");
    assert.equal(row(c.id).suite_id, s);
  });

  it("adds tags without replacing, skips duplicates case-insensitively, and removes by name", () => {
    const p = makeProject("BT");
    const a = makeCase(p.id, "A", { tags: ["Smoke", "auth"] });
    const b = makeCase(p.id, "B");
    bulkUpdateCases(p.id, [a.id, b.id], { addTags: ["smoke", "regression", "  "] });
    assert.deepEqual(tagsOf(a.id), ["Smoke", "auth", "regression"]);
    assert.deepEqual(tagsOf(b.id), ["smoke", "regression"]);
    bulkUpdateCases(p.id, [a.id, b.id], { removeTags: ["SMOKE"] });
    assert.deepEqual(tagsOf(a.id), ["auth", "regression"]);
    assert.deepEqual(tagsOf(b.id), ["regression"]);
  });

  it("ignores cases from other projects", () => {
    const p1 = makeProject("BO1");
    const p2 = makeProject("BO2");
    const mine = makeCase(p1.id, "mine");
    const theirs = makeCase(p2.id, "theirs");
    const r = bulkUpdateCases(p1.id, [mine.id, theirs.id], { priority: "high" });
    assert.equal(r.updated, 1);
    assert.equal(row(mine.id).priority, "high");
    assert.equal(row(theirs.id).priority, "medium");
  });

  it("refuses a suite from another project, an empty selection and a no-op", () => {
    const p1 = makeProject("BE1");
    const p2 = makeProject("BE2");
    const c = makeCase(p1.id, "c");
    const foreign = makeSuite(p2.id, "Foreign");
    assert.throws(() => bulkUpdateCases(p1.id, [c.id], { suiteId: foreign }), (e: unknown) => e instanceof CaseBulkError && e.status === 400);
    assert.throws(() => bulkUpdateCases(p1.id, [], { priority: "low" }), /at least one/);
    assert.throws(() => bulkUpdateCases(p1.id, [c.id], {}), /Nothing to change/);
    assert.equal(row(c.id).suite_id, null);
  });
});

describe("duplicateCase", () => {
  const p = makeProject("DU");
  const suite = makeSuite(p.id, "Checkout");
  const original = makeCase(p.id, "Pay by card", {
    suiteId: suite,
    tags: ["smoke"],
    steps: [["Open checkout", "Form shows"], ["Enter card", "Accepted"]],
  });
  db.prepare("UPDATE cases SET description = 'Pays', preconditions = 'Logged in', priority = 'critical', status = 'ready' WHERE id = ?").run(original.id);
  const req = createRequirement(p.id, { title: "Customers can pay" });
  setRequirementCases(req, p.id, [original.id]);
  const copyId = duplicateCase(original.id);

  it("creates a draft with the next case number and a marked title", () => {
    const c = row(copyId);
    assert.equal(c.number, original.number + 1);
    assert.equal(c.title, "Pay by card (copy)");
    assert.equal(c.status, "draft");
  });

  it("keeps suite, text, priority and tags", () => {
    const c = row(copyId);
    assert.equal(c.suite_id, suite);
    assert.equal(c.description, "Pays");
    assert.equal(c.preconditions, "Logged in");
    assert.equal(c.priority, "critical");
    assert.deepEqual(tagsOf(copyId), ["smoke"]);
  });

  it("copies the steps in order, as new steps", () => {
    const steps = (id: number) => db.prepare("SELECT id, position, action, expected FROM case_steps WHERE case_id = ? ORDER BY position").all(id) as { id: number; action: string; expected: string }[];
    const o = steps(original.id);
    const c = steps(copyId);
    assert.deepEqual(c.map((s) => [s.action, s.expected]), [["Open checkout", "Form shows"], ["Enter card", "Accepted"]]);
    assert.ok(c.every((s) => !o.some((x) => x.id === s.id)));
  });

  it("does not inherit requirement links, and leaves the original untouched", () => {
    const links = db.prepare("SELECT case_id FROM requirement_cases WHERE requirement_id = ?").all(req) as { case_id: number }[];
    assert.deepEqual(links.map((l) => l.case_id), [original.id]);
    assert.equal(row(original.id).title, "Pay by card");
  });

  it("can be repeated and numbers keep counting", () => {
    const second = duplicateCase(original.id);
    assert.equal(row(second).number, original.number + 2);
  });

  it("fails clearly for a case that does not exist", () => {
    assert.throws(() => duplicateCase(999999), (e: unknown) => e instanceof CaseBulkError && e.status === 404);
  });
});
