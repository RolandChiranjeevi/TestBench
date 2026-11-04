import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeProject } from "./helpers.ts";
import { bagFromFiles } from "../server/importers/bag.ts";
import { importAuditPackage } from "../server/audits.ts";
import { listManualTests, reviewManualTest } from "../server/manualtests.ts";

let n = 0;
const proj = () => makeProject(`MN${++n}`, `Manual new ${n}`);

const test = (sourceId: string) => ({
  sourceId, title: `Test ${sourceId}`, description: "d", preconditions: "", steps: ["Do it"], expected: "Works", priority: "medium", category: "functional",
});

/** One run of the audit `audit`. `tests` undefined means the package has no manual-tests.json at all. */
function run(p: { id: number; key: string }, audit: string, tests: string[] | undefined, title = `Audit ${audit}`) {
  const f = new Map<string, Uint8Array>();
  f.set("manifest.json", Buffer.from(JSON.stringify({
    format: "testbench-audit-package", version: 1, audit: { id: audit, title, project: p.key, agent: { name: "agent", version: "1" } }, files: [], parts: {},
  })));
  f.set("bugs.json", Buffer.from(JSON.stringify({ version: 1, bugs: [] })));
  if (tests) f.set("manual-tests.json", Buffer.from(JSON.stringify({ version: 1, tests: tests.map(test) })));
  return importAuditPackage(bagFromFiles(f), { projectId: p.id, source: "upload" });
}

const list = (p: { id: number }, o: Record<string, string> = {}) => listManualTests(p.id, { status: "all", ...o });
const newOnes = (p: { id: number }, o: Record<string, string> = {}) => list(p, o).items.filter((i) => i.isNew).map((i) => i.sourceId).sort();
const keys = (p: { id: number }, o: Record<string, string> = {}) => list(p, o).items.map((i) => i.sourceId).sort();

describe("new agent proposals", () => {
  it("marks the proposals whose first version came with the latest import, and counts them", () => {
    const p = proj();
    run(p, "a1", ["X", "Y"]);
    run(p, "a1", ["X", "Y", "Z"]);
    const r = list(p);
    assert.deepEqual(newOnes(p), ["Z"], "X and Y were first proposed in the earlier import");
    assert.equal(r.latest!.newCount, 1);
    assert.equal(r.latest!.auditTitle, "Audit a1");
  });

  it("a newer import with proposals makes the earlier ones old, also a different audit's import", () => {
    const p = proj();
    run(p, "big", ["B1", "B2", "B3"], "Big audit");
    assert.deepEqual(newOnes(p), ["B1", "B2", "B3"]);
    run(p, "smoke", ["S1"], "Smoke test");
    assert.deepEqual(newOnes(p), ["S1"]);
    assert.deepEqual([list(p).latest!.auditTitle, list(p).latest!.newCount], ["Smoke test", 1]);
  });

  it("an import without manual-tests.json says nothing and does not make proposals old", () => {
    const p = proj();
    run(p, "a1", ["X"]);
    run(p, "bugs-only", undefined, "Smoke test: audit.yml");
    assert.deepEqual(newOnes(p), ["X"]);
    assert.equal(list(p).latest!.auditTitle, "Audit a1");
  });

  it("an import with an empty manual-tests.json is the latest and makes earlier proposals old", () => {
    const p = proj();
    run(p, "a1", ["X"]);
    run(p, "a1", []);
    assert.deepEqual(newOnes(p), []);
    assert.equal(list(p).latest!.newCount, 0);
  });

  it("is per project, and a project without proposals has no latest import", () => {
    const a = proj();
    const b = proj();
    run(a, "a1", ["A"]);
    run(b, "b1", ["B"]);
    run(b, "b1", ["B", "B2"]);
    assert.deepEqual(newOnes(a), ["A"]);
    assert.deepEqual(newOnes(b), ["B2"]);
    assert.equal(list(proj()).latest, null);
  });

  it("stays new whatever the review status", () => {
    const p = proj();
    run(p, "a1", ["X"]);
    const id = list(p).items[0].id;
    reviewManualTest(id, "accepted");
    assert.deepEqual(newOnes(p), ["X"]);
  });
});

describe("the New filter", () => {
  it("new=any shows only the new proposals and combines with the status tab", () => {
    const p = proj();
    run(p, "a1", ["OLD"]);
    run(p, "a1", ["OLD", "NEW1", "NEW2"]);
    assert.deepEqual(keys(p), ["NEW1", "NEW2", "OLD"]);
    assert.deepEqual(keys(p, { new: "any" }), ["NEW1", "NEW2"]);
    reviewManualTest(list(p, { new: "any" }).items.find((i) => i.sourceId === "NEW1")!.id, "accepted");
    assert.deepEqual(keys(p, { new: "any", status: "accepted" }), ["NEW1"]);
    assert.deepEqual(keys(p, { new: "any", status: "proposed" }), ["NEW2"]);
    assert.equal(list(p).latest!.newCount, 2, "the count does not depend on the filters");
  });

  it("an empty set gives an empty list, not everything, and a wrong value is refused", () => {
    const p = proj();
    run(p, "a1", ["X"]);
    run(p, "a1", ["X"]);
    assert.deepEqual(keys(p, { new: "any" }), []);
    assert.throws(() => listManualTests(p.id, { new: "yes" }), /new must be any/);
  });

  it("without the filter the list, its order and the status counts are what they were", () => {
    const p = proj();
    run(p, "a1", ["X", "Y"]);
    const r = list(p);
    assert.deepEqual(r.counts, { proposed: 2 });
    assert.equal(r.items.length, 2);
  });
});
