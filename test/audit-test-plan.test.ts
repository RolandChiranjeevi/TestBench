import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db } from "../server/db.ts";
import { makeProject } from "./helpers.ts";
import { bagFromFiles } from "../server/importers/bag.ts";
import { deleteAudit, getAuditPlan, importAuditPackage, listAudits, previewAuditDeletion } from "../server/audits.ts";
import { createRequirement, getRequirement } from "../server/requirements.ts";
import { PackageError, RESULT_STATUSES } from "../server/importers/auditpackage.ts";
import { requirementOverviews } from "../server/reqlinks.ts";

let n = 0;
const proj = () => makeProject(`TP${++n}`, `Test plan ${n}`);
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

const item = (over: Record<string, unknown> = {}) => ({
  sourceId: "TPI-001", title: "Add a todo", type: "Functional", risk: "High", priority: "High", readiness: "ready", preconditions: "An empty list", testData: "QA-AUDIT-1",
  steps: ["Type the text", "Press Enter"], acceptanceCriteria: "The text is shown in the list", automation: "Yes, exploration", refs: { requirements: ["REQ-1"] }, ...over,
});
const gap = (over: Record<string, unknown> = {}) => ({ sourceId: "CG-001", description: "Validation is not verified", refs: { requirements: ["REQ-LOCAL-002"] }, ...over });

/** One run of the audit: bugs.json (empty) and, unless `plan` is undefined, a test-plan.json. `raw` replaces the file's text, `name` its path (then named in parts.testPlan). */
function files(p: { key: string }, plan: unknown, o: { audit?: string; raw?: string; name?: string; parts?: Record<string, unknown> } = {}) {
  const f = new Map<string, Uint8Array>();
  const name = o.name ?? "test-plan.json";
  f.set("manifest.json", Buffer.from(JSON.stringify({
    format: "testbench-audit-package", version: 1, audit: { id: o.audit ?? "a1", title: "Audit", project: p.key }, files: [], parts: o.parts ?? (o.name ? { testPlan: o.name } : {}),
  })));
  f.set("bugs.json", Buffer.from(JSON.stringify({ version: 1, bugs: [] })));
  if (o.raw !== undefined) f.set(name, Buffer.from(o.raw));
  else if (plan !== undefined) f.set(name, Buffer.from(JSON.stringify(plan)));
  return bagFromFiles(f);
}
const run = (p: { id: number; key: string }, plan: unknown, o: Parameters<typeof files>[2] = {}, dryRun = false) =>
  importAuditPackage(files(p, plan, o), { projectId: p.id, source: "upload" }, { dryRun });
const auditId = (p: { id: number }, agentAuditId = "a1") => (db.prepare("SELECT id FROM audits WHERE project_id = ? AND agent_audit_id = ?").get(p.id, agentAuditId) as { id: number }).id;
const planOf = (p: { id: number }) => getAuditPlan(auditId(p));
/** Every row of the plan tables and the audits, for "nothing was written" checks (the database is shared by the tests of this file). */
const totals = () => [count("SELECT COUNT(*) AS n FROM audits"), count("SELECT COUNT(*) AS n FROM audit_plan_items"), count("SELECT COUNT(*) AS n FROM audit_coverage_gaps")];
const file = (planItems: unknown[], coverageGaps: unknown[] = []) => ({ version: 1, planItems, coverageGaps });

describe("test-plan.json in an audit package", () => {
  it("a dry run says what would happen, with the unresolved references counted, and writes nothing", () => {
    const p = proj();
    const before = totals();
    const r = run(p, file([item(), item({ sourceId: "TPI-002", title: "Complete it" })], [gap()]), {}, true);
    assert.equal(r.dryRun, true);
    assert.equal(r.testPlan.listed, true);
    assert.deepEqual(r.testPlan.planItems.counts, { new: 2, unchanged: 0, updated: 0, removed: 0, pending: 0 });
    assert.deepEqual(r.testPlan.coverageGaps.counts, { new: 1, unchanged: 0, updated: 0, removed: 0 });
    assert.equal(r.testPlan.unresolvedRefs, 3, "REQ-1 twice and REQ-LOCAL-002 once, and the project has no requirements yet");
    assert.equal(r.warnings.some((w) => /not listed in the manifest/.test(w)), false, "test-plan.json is not an unlisted file");
    assert.deepEqual(totals(), before, "the dry run wrote nothing");
    assert.equal(count("SELECT COUNT(*) AS n FROM audits WHERE project_id = ?", p.id), 0);
  });

  it("an import stores every field, apart from test cases, runs and results, and shows the requirements as they are now", () => {
    const p = proj();
    createRequirement(p.id, { title: "Todo can be added" });
    createRequirement(p.id, { title: "A user can register a result", externalId: "REQ-LOCAL-002" });
    run(p, file([item()], [gap()]));
    const plan = planOf(p);
    assert.deepEqual({ ...plan.planItems[0], requirements: undefined }, {
      sourceId: "TPI-001", title: "Add a todo", type: "Functional", risk: "High", priority: "High", readiness: "ready", preconditions: "An empty list", testData: "QA-AUDIT-1",
      steps: ["Type the text", "Press Enter"], acceptanceCriteria: "The text is shown in the list", automation: "Yes, exploration", result: null, requirements: undefined,
      origin: "agent", status: "proposed", editedBy: null, editedAt: null, decidedBy: null, decidedAt: null, pending: null,
    });
    assert.deepEqual(plan.planItems[0].requirements.map((r) => [r.raw, r.state, r.label]), [["REQ-1", "resolved", "REQ-1 · Todo can be added"]]);
    assert.deepEqual(plan.coverageGaps.map((g) => [g.sourceId, g.description, g.requirements.map((r) => [r.raw, r.state, r.label])]), [["CG-001", "Validation is not verified", [["REQ-LOCAL-002", "resolved", "REQ-2 · A user can register a result"]]]]);
    assert.deepEqual([count("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?", p.id), count("SELECT COUNT(*) AS n FROM runs WHERE project_id = ?", p.id)], [0, 0], "no test cases and no runs were made");
    assert.deepEqual(listAudits(p.id).map((a) => [a.planItems, a.coverageGaps]), [[1, 1]]);
  });

  it("finds a requirement that is created after the import, without another import", () => {
    const p = proj();
    run(p, file([item({ refs: { requirements: ["REQ-LOCAL-002"] } })]));
    assert.notEqual(planOf(p).planItems[0].requirements[0].state, "resolved");
    createRequirement(p.id, { title: "Registered later", externalId: "REQ-LOCAL-002" });
    assert.equal(planOf(p).planItems[0].requirements[0].state, "resolved");
  });

  it("never counts a plan item as a test, and shows the plan and the coverage gaps on the requirement they name", () => {
    const p = proj();
    const named = createRequirement(p.id, { title: "Named" });
    const other = createRequirement(p.id, { title: "Other" });
    run(p, file([item({ refs: { requirements: ["REQ-1"] } })], [gap({ refs: { requirements: ["REQ-1"] } }), gap({ sourceId: "CG-002", refs: { requirements: ["REQ-2"] } })]));
    assert.equal(requirementOverviews(p.id).get(named)!.withoutTest, true, "planned in an audit is not tested");
    const linked = getRequirement(named)!.linked;
    assert.deepEqual(linked.planItems.map((x: any) => [x.sourceId, x.agentAuditId]), [["TPI-001", "a1"]]);
    assert.deepEqual(linked.coverageGaps.map((x: any) => x.sourceId), ["CG-001"]);
    assert.deepEqual(getRequirement(other)!.linked.planItems, []);
    assert.deepEqual(getRequirement(other)!.linked.coverageGaps.map((x: any) => x.sourceId), ["CG-002"]);
  });

  it("the latest import of the same audit wins: new, unchanged, updated and removed", () => {
    const p = proj();
    run(p, file([item(), item({ sourceId: "TPI-002", title: "Complete it" })], [gap()]));
    const second = file([item(), item({ sourceId: "TPI-002", title: "Complete it, and the counter follows" }), item({ sourceId: "TPI-003", title: "Filter" })], []);
    const before = totals();
    const dry = run(p, second, {}, true);
    assert.deepEqual(dry.testPlan.planItems.counts, { new: 1, unchanged: 1, updated: 1, removed: 0, pending: 0 });
    assert.deepEqual(dry.testPlan.coverageGaps.counts, { new: 0, unchanged: 0, updated: 0, removed: 1 });
    assert.deepEqual(dry.testPlan.coverageGaps.removed, ["CG-001"]);
    assert.deepEqual(totals(), before, "the dry run changed nothing");
    run(p, second);
    assert.deepEqual(planOf(p).planItems.map((x) => x.title), ["Add a todo", "Complete it, and the counter follows", "Filter"]);
    assert.equal(planOf(p).coverageGaps.length, 0);
    const third = run(p, file([item()]), {}, true);
    assert.deepEqual(third.testPlan.planItems.removed.sort(), ["TPI-002", "TPI-003"]);
    run(p, file([item()]));
    assert.equal(planOf(p).planItems.length, 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM audits WHERE project_id = ?", p.id), 1, "still one audit");
  });

  it("a package without test-plan.json leaves the plan alone, and an empty one empties it", () => {
    const p = proj();
    run(p, file([item()], [gap()]));
    const without = run(p, undefined);
    assert.equal(without.testPlan.listed, false);
    assert.deepEqual([planOf(p).planItems.length, planOf(p).coverageGaps.length], [1, 1]);
    run(p, { version: 1 });
    assert.deepEqual([planOf(p).planItems.length, planOf(p).coverageGaps.length], [0, 0]);
  });

  it("a plan with only the basics imports, so older packages keep working, and the file can have another name in parts.testPlan", () => {
    const p = proj();
    run(p, file([{ sourceId: "T1", title: "Only the basics" }]), { name: "plans/mine.json" });
    const x = planOf(p).planItems[0];
    assert.deepEqual([x.type, x.risk, x.priority, x.readiness, x.preconditions, x.testData, x.steps, x.acceptanceCriteria, x.automation, x.requirements], ["", "", "", "", "", "", [], "", "", []]);
  });

  it("refuses a plan that breaks a rule, as a whole, and says which item", () => {
    const p = proj();
    const bad = (plan: unknown, why: RegExp, o: Parameters<typeof files>[2] = {}) => {
      assert.throws(() => run(p, plan, o), (e: unknown) => e instanceof PackageError && why.test(e.message), String(why));
      assert.equal(count("SELECT COUNT(*) AS n FROM audits WHERE project_id = ?", p.id), 0, "nothing was imported");
    };
    bad(file([item(), item()]), /plan item sourceId "TPI-001" appears twice/);
    bad(file([item(), { sourceId: "TPI-9", title: "" }]), /plan item #2 \(TPI-9\)/);
    bad(file([item({ readiness: "maybe" })]), /plan item #1 \(TPI-001\): readiness/);
    bad(file([], [gap(), gap()]), /coverage gap sourceId "CG-001" appears twice/);
    bad(file([], [gap({ description: "" })]), /coverage gap #1 \(CG-001\): description/);
    bad({ version: 2, planItems: [] }, /test-plan\.json: version/);
    bad(undefined, /test-plan\.json is not valid JSON/, { raw: "{" });
    bad(file([item()]), /parts\.testPlan is not a safe path/, { parts: { testPlan: "../x.json" } });
  });

  it("deleting the audit removes its plan, and the preview says how much", () => {
    const p = proj();
    run(p, file([item(), item({ sourceId: "TPI-002" })], [gap()]));
    const id = auditId(p);
    assert.deepEqual(previewAuditDeletion(id).plan, { planItems: 2, coverageGaps: 1 });
    assert.deepEqual([count("SELECT COUNT(*) AS n FROM audit_plan_items WHERE audit_id = ?", id), count("SELECT COUNT(*) AS n FROM audit_coverage_gaps WHERE audit_id = ?", id)], [2, 1]);
    deleteAudit(id);
    assert.deepEqual([count("SELECT COUNT(*) AS n FROM audit_plan_items WHERE audit_id = ?", id), count("SELECT COUNT(*) AS n FROM audit_coverage_gaps WHERE audit_id = ?", id)], [0, 0], "no rows are left behind");
  });

  it("reserves inconclusive as a status of its own, and nothing else", () => {
    assert.deepEqual([...RESULT_STATUSES], ["pass", "fail", "blocked", "skipped", "inconclusive"]);
    const p = proj();
    run(p, file([item()]));
    const id = auditId(p);
    const set = (v: string | null) => db.prepare("UPDATE audit_plan_items SET result = ? WHERE audit_id = ?").run(v, id);
    for (const s of RESULT_STATUSES) assert.doesNotThrow(() => set(s), s);
    assert.throws(() => set("untested"), /CHECK constraint/);
    assert.throws(() => db.prepare("UPDATE audit_plan_items SET readiness = 'maybe' WHERE audit_id = ?").run(id), /CHECK constraint/);
    set(null);
    assert.equal(planOf(p).planItems[0].result, null, "a plan item carries no result until executions are imported");
  });
});
