import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db } from "../server/db.ts";
import { makeProject } from "./helpers.ts";
import { bagFromFiles } from "../server/importers/bag.ts";
import { importAuditPackage, listBugReports, reviewBugReport } from "../server/audits.ts";
import { ingestCiResults, setTriage } from "../server/ci.ts";
import { latestRuns } from "../server/latestruns.ts";

let n = 0;
const proj = () => makeProject(`LR${++n}`, `Latest runs ${n}`);

let runs = 0;
const fail = (testKey: string, status = "failed") => ({ testKey, title: `Test ${testKey}`, status, error: "boom" });
const pass = (testKey: string) => ({ testKey, title: `Test ${testKey}`, status: "passed" });
const ci = (p: { id: number }, results: unknown[], over: Record<string, unknown> = {}) =>
  ingestCiResults(p.id, {
    runId: `run-${++runs}`, commitSha: "abc1234567890", branch: "main", repository: "org/repo", pipelineUrl: "https://github.com/org/repo/actions/runs/1",
    startedAt: "2026-11-04T07:00:00Z", finishedAt: "2026-11-04T07:04:00Z", results, ...over,
  });

/** An audit package with the given bugs. `auditId` picks which audit it is a run of. */
function audit(p: { id: number; key: string }, auditId: string, bugs: string[], title = `Audit ${auditId}`) {
  const files = new Map<string, Uint8Array>();
  files.set("manifest.json", Buffer.from(JSON.stringify({
    format: "testbench-audit-package", version: 1, audit: { id: auditId, title, project: p.key, agent: { name: "agent", version: "1" } }, files: [], parts: {},
  })));
  files.set("bugs.json", Buffer.from(JSON.stringify({ version: 1, bugs: bugs.map((id) => ({ sourceId: id, title: `Bug ${id}` })) })));
  return importAuditPackage(bagFromFiles(files), { projectId: p.id, source: "upload" });
}

const list = (p: { id: number }, f: Record<string, string> = {}) => listBugReports(p.id, { status: "all", ...f });
const newOnes = (p: { id: number }, f: Record<string, string> = {}) => list(p, f).items.filter((i) => i.newIn).map((i) => i.testKey ?? i.sourceId).sort();
const keys = (p: { id: number }, f: Record<string, string> = {}) => list(p, f).items.map((i) => i.testKey ?? i.sourceId).sort();

describe("new bugs per latest CI run", () => {
  it("counts the bugs whose first occurrence came with the latest run, and marks them", () => {
    const p = proj();
    ci(p, [fail("A"), fail("B")]);
    ci(p, [fail("B"), fail("C"), fail("D")]);
    const r = list(p);
    assert.equal(r.latestRuns.ci!.newCount, 2, "C and D are first seen in the latest run");
    assert.deepEqual(newOnes(p), ["C", "D"]);
    assert.deepEqual(r.items.filter((i) => i.newIn === "ci").length, 2);
  });

  it("a bug from an older run is not new, even if it fails again in the latest one", () => {
    const p = proj();
    ci(p, [fail("A")]);
    ci(p, [fail("A")]);
    assert.equal(list(p).latestRuns.ci!.newCount, 0);
    assert.deepEqual(newOnes(p), []);
  });

  it("stops being new when a newer run arrives, also a run that only has passing tests", () => {
    const p = proj();
    ci(p, [fail("A"), fail("B")]);
    assert.deepEqual(newOnes(p), ["A", "B"]);
    ci(p, [pass("A"), pass("B"), pass("Z")]);
    assert.deepEqual(newOnes(p), []);
    const latest = list(p).latestRuns.ci!;
    assert.equal(latest.newCount, 0, "the strip shows 0 new for a run that found nothing new");
    assert.deepEqual(latest.counts, { passed: 3, failed: 0, flaky: 0, skipped: 0 });
  });

  it("a reopened or flaky-again bug is not new", () => {
    const p = proj();
    ci(p, [fail("A")]);
    const id = list(p).items[0].id;
    setTriage(id, { workflowStatus: "closed" });
    const s = ci(p, [fail("A"), fail("F", "flaky")]);
    assert.equal(s.reopened, 1);
    assert.deepEqual(newOnes(p), ["F"], "A was reopened by the latest run but first seen earlier; F is genuinely new");
  });

  it("is per project: another project's newer run changes nothing", () => {
    const a = proj();
    const b = proj();
    ci(a, [fail("A")]);
    ci(b, [fail("B")]);
    ci(b, [fail("B2")]);
    assert.deepEqual(newOnes(a), ["A"]);
    assert.deepEqual(newOnes(b), ["B2"]);
  });

  it("a replayed run is not a new run", () => {
    const p = proj();
    const payload = { runId: "same", commitSha: "abc", branch: "main", repository: "org/repo", results: [fail("A")] };
    ingestCiResults(p.id, payload);
    ci(p, [fail("B")]);
    ingestCiResults(p.id, payload);
    assert.deepEqual(newOnes(p), ["B"], "the replay of the earlier run did not become the latest");
  });
});

describe("new bugs per latest audit import", () => {
  it("counts the bugs whose first version came with the latest import, and marks them", () => {
    const p = proj();
    audit(p, "a1", ["X", "Y"]);
    audit(p, "a1", ["X", "Y", "Z"]);
    const r = list(p);
    assert.equal(r.latestRuns.audit!.newCount, 1);
    assert.deepEqual(newOnes(p), ["Z"]);
    assert.equal(r.items.find((i) => i.sourceId === "Z")!.newIn, "audit");
  });

  it("an older import's bugs are not new, also when the latest import is another audit of the project", () => {
    const p = proj();
    audit(p, "big", ["B1", "B2", "B3"], "Big audit");
    assert.deepEqual(newOnes(p), ["B1", "B2", "B3"]);
    audit(p, "smoke", ["S1"], "Smoke test");
    assert.deepEqual(newOnes(p), ["S1"]);
    const latest = list(p).latestRuns.audit!;
    assert.deepEqual([latest.auditTitle, latest.newCount], ["Smoke test", 1]);
  });

  it("an import that adds nothing makes the earlier import's bugs stop being new", () => {
    const p = proj();
    audit(p, "a1", ["X"]);
    assert.deepEqual(newOnes(p), ["X"]);
    audit(p, "a1", ["X"]);
    assert.deepEqual(newOnes(p), []);
    assert.equal(list(p).latestRuns.audit!.newCount, 0);
  });
});

describe("filtering and the strip", () => {
  it("new=ci, new=audit and new=any filter the list, and the status tabs still apply", () => {
    const p = proj();
    audit(p, "a1", ["OLD-AUDIT"]);
    ci(p, [fail("OLD-CI")]);
    audit(p, "a2", ["NEW-AUDIT"]);
    ci(p, [fail("NEW-CI")]);
    assert.deepEqual(keys(p), ["NEW-AUDIT", "NEW-CI", "OLD-AUDIT", "OLD-CI"]);
    assert.deepEqual(keys(p, { new: "ci" }), ["NEW-CI"]);
    assert.deepEqual(keys(p, { new: "audit" }), ["NEW-AUDIT"]);
    assert.deepEqual(keys(p, { new: "any" }), ["NEW-AUDIT", "NEW-CI"]);
    const id = list(p, { new: "ci" }).items[0].id;
    reviewBugReport(id, "accepted");
    assert.deepEqual(keys(p, { new: "any", status: "proposed" }), ["NEW-AUDIT"], "the status filter combines with the new filter");
    assert.deepEqual(keys(p, { new: "any", status: "accepted" }), ["NEW-CI"]);
    assert.equal(list(p).latestRuns.ci!.newCount, 1, "the count does not depend on the status filter");
  });

  it("an empty set gives an empty list, not everything, and a wrong value is refused", () => {
    const p = proj();
    ci(p, [fail("A")]);
    ci(p, [pass("A")]);
    assert.deepEqual(keys(p, { new: "ci" }), []);
    assert.deepEqual(keys(p, { new: "audit" }), [], "no audit import at all");
    assert.throws(() => listBugReports(p.id, { new: "yes" }), /new must be ci, audit or any/);
  });

  it("without the filter the list, its order and the status counts are what they were", () => {
    const p = proj();
    audit(p, "a1", ["X"]);
    ci(p, [fail("A"), fail("B")]);
    const r = listBugReports(p.id, { status: "all" });
    const expected = db.prepare("SELECT id FROM bug_reports WHERE project_id = ? ORDER BY imported_at DESC, id DESC").all(p.id) as { id: number }[];
    assert.deepEqual(r.items.map((i) => i.id), expected.map((e) => e.id));
    assert.deepEqual(r.counts, { proposed: 3 });
  });

  it("describes the latest CI run, the latest audit import and the latest manual bug", () => {
    const p = proj();
    assert.deepEqual(latestRuns(p.id), { ci: null, audit: null, manual: null });
    audit(p, "a1", ["X"], "Smoke test: audit.yml");
    ci(p, [fail("A")], { branch: "feature/x", commitSha: "deadbeef00112233", pipelineUrl: "https://github.com/org/repo/actions/runs/42" });
    const r = latestRuns(p.id);
    assert.deepEqual([r.ci!.branch, r.ci!.commit, r.ci!.pipelineUrl, r.ci!.newCount, r.ci!.counts.failed], ["feature/x", "deadbeef00112233", "https://github.com/org/repo/actions/runs/42", 1, 1]);
    assert.deepEqual([r.audit!.auditTitle, r.audit!.newCount, r.audit!.source], ["Smoke test: audit.yml", 1, "upload"]);
    assert.equal(r.manual, null, "the app creates no manual bugs, so there is none");
    db.prepare("INSERT INTO bug_reports (project_id, origin_audit_id, source_id, title, source) VALUES (?, 'manual', 'm1', 'Found by hand', 'manual')").run(p.id);
    assert.equal(latestRuns(p.id).manual!.title, "Found by hand");
    assert.equal(list(p).items.find((i) => i.sourceId === "m1")!.newIn, null, "a manual bug is never marked new");
  });
});
