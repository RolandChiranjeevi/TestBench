import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db } from "../server/db.ts";
import { makeCase, makeProject } from "./helpers.ts";
import { bagFromFiles } from "../server/importers/bag.ts";
import { PackageError } from "../server/importers/auditpackage.ts";
import { deleteAudit, importAuditPackage } from "../server/audits.ts";
import { createRequirement } from "../server/requirements.ts";
import {
  applyManualUpdate, deleteManualTest, getManualTest, ignoreManualUpdate, listManualTests, reviewManualTest, updateManualTest,
} from "../server/manualtests.ts";

let n = 0;
const proj = () => makeProject(`MT${++n}`, `Manual tests ${n}`);
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

const base = (over: Record<string, unknown> = {}) => ({
  sourceId: "focus-order", title: "Focus order follows the visual order", description: "Checkout page", preconditions: "A cart with one item",
  steps: ["Open the checkout", "Tab through every control"], expected: "Focus moves top to bottom, left to right", priority: "high", category: "accessibility",
  wcag: ["2.4.3"], ...over,
});

/** One run of the audit "a1": bugs and (unless `tests` is undefined) a manual-tests.json. `raw` replaces the file's text. */
function files(p: { key: string }, tests: unknown[] | undefined, o: { project?: string; bugs?: unknown[]; raw?: string; audit?: string } = {}) {
  const f = new Map<string, Uint8Array>();
  f.set("manifest.json", Buffer.from(JSON.stringify({
    format: "testbench-audit-package", version: 1, audit: { id: o.audit ?? "a1", title: "Checkout audit", project: o.project ?? p.key, agent: { name: "agent", version: "1" } }, files: [], parts: {},
  })));
  f.set("bugs.json", Buffer.from(JSON.stringify({ version: 1, bugs: o.bugs ?? [] })));
  if (o.raw !== undefined) f.set("manual-tests.json", Buffer.from(o.raw));
  else if (tests) f.set("manual-tests.json", Buffer.from(JSON.stringify({ version: 1, tests })));
  return bagFromFiles(f);
}
const run = (p: { id: number; key: string }, tests: unknown[] | undefined, o: Parameters<typeof files>[2] = {}) => importAuditPackage(files(p, tests, o), { projectId: p.id, source: "upload" });
const idOf = (p: { id: number }, sourceId: string) => (db.prepare("SELECT id FROM manual_tests WHERE project_id = ? AND source_id = ?").get(p.id, sourceId) as { id: number }).id;
const revs = (id: number) => count("SELECT COUNT(*) AS n FROM manual_test_revisions WHERE manual_test_id = ?", id);

describe("a package with manual tests", () => {
  it("imports them as proposals, apart from bug reports, with everything the agent described", () => {
    const p = proj();
    const s = run(p, [base(), base({ sourceId: "mobile-layout", title: "Layout at phone width", category: "responsive", wcag: [], viewports: [{ device: "iPhone 13", width: 390, height: 844 }, { breakpoint: "md" }], priority: "medium" })], { bugs: [{ sourceId: "b1", title: "A bug" }] });
    assert.equal(s.manualTests.listed, true);
    assert.deepEqual(s.manualTests.counts, { new: 2, unchanged: 0, updated: 0, pending: 0 });
    assert.deepEqual(s.counts, { new: 1, unchanged: 0, updated: 0, pending: 0 }, "bug reports are counted on their own");
    const t = getManualTest(idOf(p, "focus-order"));
    assert.equal(t.status, "proposed");
    assert.equal(t.requiresHumanCheck, true);
    assert.deepEqual([t.title, t.category, t.wcag, t.steps.length, t.priority], ["Focus order follows the visual order", "accessibility", ["2.4.3"], 2, { agent: "high", human: null, effective: "high" }]);
    assert.equal(t.preconditions, "A cart with one item");
    assert.equal(t.originAuditId, "a1");
    assert.equal(t.origin.agent.name, "agent");
    assert.ok(t.audit && t.agentUpdatedAt, "audit, agent and last update are shown");
    assert.deepEqual(getManualTest(idOf(p, "mobile-layout")).viewports, [{ device: "iPhone 13", width: 390, height: 844 }, { breakpoint: "md" }]);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?", p.id), 0, "not mixed into the project's own test cases");
    assert.equal(count("SELECT COUNT(*) AS n FROM results r JOIN runs ru ON ru.id = r.run_id WHERE ru.project_id = ?", p.id), 0, "no result is created, nothing is run");
  });

  it("ignores any status the agent writes, and cannot accept its own test", () => {
    const p = proj();
    run(p, [base({ status: "accepted", reviewStatus: "accepted", result: "passed" })]);
    const t = getManualTest(idOf(p, "focus-order"));
    assert.equal(t.status, "proposed");
    assert.equal(t.reviewedAt, null);
  });

  it("a package without manual-tests.json still imports, as before", () => {
    const p = proj();
    const s = run(p, undefined, { bugs: [{ sourceId: "b1", title: "A bug" }] });
    assert.equal(s.manualTests.listed, false);
    assert.deepEqual(s.manualTests.counts, { new: 0, unchanged: 0, updated: 0, pending: 0 });
    assert.equal(s.counts.new, 1);
  });

  it("a dry run reports what would happen and stores nothing", () => {
    const p = proj();
    const s = importAuditPackage(files(p, [base()]), { projectId: p.id, source: "upload" }, { dryRun: true });
    assert.equal(s.manualTests.counts.new, 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM manual_tests WHERE project_id = ?", p.id), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM audits WHERE project_id = ?", p.id), 0);
  });
});

describe("an invalid package", () => {
  const bad: [string, unknown, RegExp][] = [
    ["a test without steps", base({ steps: [] }), /steps/],
    ["an empty step", base({ steps: ["ok", "  "] }), /steps/],
    ["no expected result", base({ expected: "" }), /expected/],
    ["an unknown category", base({ category: "performance" }), /category/],
    ["an unknown priority", base({ priority: "urgent" }), /priority/],
    ["a responsive test without a viewport", base({ category: "responsive", wcag: [] }), /viewport/],
    ["a viewport that names nothing", base({ category: "responsive", wcag: [], viewports: [{}] }), /device, a width or a breakpoint/],
    ["a WCAG criterion that is not one", base({ wcag: ["AA"] }), /WCAG/],
    ["an id with spaces", base({ sourceId: "has space" }), /sourceId/],
  ];
  for (const [name, test, re] of bad) {
    it(`is refused whole for ${name}`, () => {
      const p = proj();
      assert.throws(() => run(p, [test], { bugs: [{ sourceId: "b1", title: "A bug" }] }), (e) => e instanceof PackageError && re.test(e.message));
      assert.equal(count("SELECT COUNT(*) AS n FROM audits WHERE project_id = ?", p.id), 0, "nothing stored, not even the bug reports");
      assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), 0);
    });
  }
  it("is refused for a repeated sourceId, for text that is not JSON and for the wrong version", () => {
    const p = proj();
    assert.throws(() => run(p, [base(), base()]), /appears twice/);
    assert.throws(() => run(p, undefined, { raw: "not json" }), /not valid JSON/);
    assert.throws(() => run(p, undefined, { raw: JSON.stringify({ version: 2, tests: [] }) }), PackageError);
    assert.equal(count("SELECT COUNT(*) AS n FROM manual_tests WHERE project_id = ?", p.id), 0);
  });
  it("is refused whole for the wrong project key, manual tests included", () => {
    const p = proj();
    const other = proj();
    assert.throws(() => run(p, [base()], { project: other.key }), /for project/);
    assert.equal(count("SELECT COUNT(*) AS n FROM manual_tests WHERE project_id IN (?, ?)", p.id, other.id), 0);
  });
});

describe("importing the same audit again", () => {
  it("an unchanged package changes nothing: no new revision, no duplicate", () => {
    const p = proj();
    run(p, [base()]);
    const id = idOf(p, "focus-order");
    const s = run(p, [base()]);
    assert.deepEqual(s.manualTests.counts, { new: 0, unchanged: 1, updated: 0, pending: 0 });
    assert.equal(revs(id), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM manual_tests WHERE project_id = ?", p.id), 1);
  });

  it("an untouched proposal is updated, and the older version stays as a revision", () => {
    const p = proj();
    run(p, [base()]);
    const id = idOf(p, "focus-order");
    const s = run(p, [base({ title: "Focus order, improved", steps: ["Open", "Tab"] })]);
    assert.deepEqual(s.manualTests.counts, { new: 0, unchanged: 0, updated: 1, pending: 0 });
    const t = getManualTest(id);
    assert.deepEqual([t.title, t.steps, t.pendingUpdate, t.revisions.length], ["Focus order, improved", ["Open", "Tab"], null, 2]);
  });

  it("an accepted test keeps its version; the agent's new one waits with a comparison, and the person picks", () => {
    const p = proj();
    run(p, [base()]);
    const id = idOf(p, "focus-order");
    reviewManualTest(id, "accepted", "looks right");
    const s = run(p, [base({ expected: "Focus never leaves the dialog", priority: "critical" })]);
    assert.deepEqual(s.manualTests.counts, { new: 0, unchanged: 0, updated: 0, pending: 1 });
    let t = getManualTest(id);
    assert.deepEqual([t.status, t.expected, t.priority.agent], ["accepted", "Focus moves top to bottom, left to right", "high"], "not overwritten");
    assert.equal(t.pendingUpdate?.rev, 2);
    assert.deepEqual(t.pendingUpdate?.changes.map((c) => c.field).sort(), ["Agent's priority", "Expected result"]);
    assert.equal(t.pendingUpdate?.changes.find((c) => c.field === "Expected result")?.to, "Focus never leaves the dialog");

    ignoreManualUpdate(id); // "Keep mine"
    t = getManualTest(id);
    assert.equal(t.pendingUpdate, null);
    assert.equal(t.expected, "Focus moves top to bottom, left to right");
    assert.equal(run(p, [base({ expected: "Focus never leaves the dialog", priority: "critical" })]).manualTests.counts.unchanged, 1, "the ignored version is not flagged again");

    run(p, [base({ expected: "Third version", priority: "critical" })]);
    applyManualUpdate(id); // "Use the agent's"
    t = getManualTest(id);
    assert.deepEqual([t.status, t.expected, t.priority.agent, t.pendingUpdate], ["accepted", "Third version", "critical", null], "review status survives");
  });

  it("an edited test is never overwritten, even while it is still proposed", () => {
    const p = proj();
    run(p, [base()]);
    const id = idOf(p, "focus-order");
    updateManualTest(id, { title: "My title", steps: ["My step"], expected: "My expectation", humanPriority: "low" });
    const s = run(p, [base({ title: "Agent title 2" })]);
    assert.equal(s.manualTests.counts.pending, 1);
    const t = getManualTest(id);
    assert.deepEqual([t.title, t.steps, t.expected, t.status], ["My title", ["My step"], "My expectation", "proposed"]);
    assert.ok(t.editedAt);
    assert.equal(t.pendingUpdate?.changes.find((c) => c.field === "Title")?.from, "My title");
  });

  it("keeps the agent's version and the person's version apart, and a review is never the agent's judgement", () => {
    const p = proj();
    run(p, [base()]);
    const id = idOf(p, "focus-order");
    updateManualTest(id, { title: "Mine", humanPriority: "low" });
    reviewManualTest(id, "accepted");
    const t = getManualTest(id);
    assert.deepEqual(t.priority, { agent: "high", human: "low", effective: "low" });
    assert.equal(t.agentVersion?.title, "Focus order follows the visual order", "what the agent said is still there");
    assert.equal(t.title, "Mine");
    assert.equal(t.agentVersion?.priority, "high");
    updateManualTest(id, { humanPriority: null });
    assert.equal(getManualTest(id).priority.effective, "high");
  });

  it("a person can accept, reject and reopen", () => {
    const p = proj();
    run(p, [base()]);
    const id = idOf(p, "focus-order");
    reviewManualTest(id, "rejected", "not relevant");
    assert.deepEqual([getManualTest(id).status, getManualTest(id).reviewNote], ["rejected", "not relevant"]);
    reviewManualTest(id, "proposed");
    const t = getManualTest(id);
    assert.deepEqual([t.status, t.reviewedAt], ["proposed", null]);
  });
});

describe("a manual test that is missing from the latest run", () => {
  it("is shown as missing, kept as it was, and present again with no duplicate when it returns", () => {
    const p = proj();
    run(p, [base(), base({ sourceId: "second", title: "Second" })]);
    assert.equal(getManualTest(idOf(p, "second")).latestRun.presence, "no_later_run", "one run only");
    run(p, [base()]);
    const id = idOf(p, "second");
    reviewManualTest(id, "accepted");
    const r = getManualTest(id).latestRun;
    assert.deepEqual([r.presence, r.runs, r.lastSeen?.run, r.latest?.run], ["missing", 2, 1, 2]);
    assert.deepEqual([getManualTest(id).status, getManualTest(id).title], ["accepted", "Second"], "not removed, closed or changed");
    assert.deepEqual(listManualTests(p.id, { presence: "missing" }).items.map((i) => i.sourceId), ["second"]);
    assert.deepEqual(listManualTests(p.id).presenceCounts, { present: 1, missing: 1, no_later_run: 0 });

    run(p, [base(), base({ sourceId: "second", title: "Second" })]);
    assert.equal(getManualTest(id).latestRun.presence, "present");
    assert.equal(idOf(p, "second"), id, "the same test");
    assert.equal(count("SELECT COUNT(*) AS n FROM manual_tests WHERE project_id = ?", p.id), 2);
    assert.equal(revs(id), 1, "unchanged content, no new revision");
  });

  it("a later run without manual-tests.json says nothing about manual tests", () => {
    const p = proj();
    run(p, [base()]);
    run(p, [base()]);
    run(p, undefined); // the agent left the file out this time
    const r = getManualTest(idOf(p, "focus-order")).latestRun;
    assert.equal(r.presence, "no_later_run");
    assert.match(r.reason, /no manual-tests\.json/);
    assert.equal(listManualTests(p.id).presenceCounts.missing, 0);
  });

  it("an empty manual-tests.json does say that nothing was listed", () => {
    const p = proj();
    run(p, [base()]);
    run(p, []);
    assert.equal(getManualTest(idOf(p, "focus-order")).latestRun.presence, "missing");
  });

  it("tests of a deleted audit that a person reviewed stay; untouched proposals go", () => {
    const p = proj();
    run(p, [base(), base({ sourceId: "other", title: "Other" })]);
    reviewManualTest(idOf(p, "focus-order"), "accepted");
    const auditId = (db.prepare("SELECT id FROM audits WHERE project_id = ?").get(p.id) as { id: number }).id;
    const r = deleteAudit(auditId);
    assert.deepEqual([r.manualDeleted, r.manualKept], [1, 1]);
    const kept = getManualTest(idOf(p, "focus-order"));
    assert.deepEqual([kept.status, kept.audit], ["accepted", null]);
    assert.equal(kept.latestRun.presence, "no_later_run");
    assert.equal(count("SELECT COUNT(*) AS n FROM manual_tests WHERE project_id = ?", p.id), 1);
    run(p, [base()]); // the audit comes back and the kept test is found again
    assert.ok(getManualTest(idOf(p, "focus-order")).audit);
    assert.equal(count("SELECT COUNT(*) AS n FROM manual_tests WHERE project_id = ? AND source_id = 'focus-order'", p.id), 1);
  });
});

describe("references stay inside the project", () => {
  it("resolves requirements and cases of this project only, and says why the others do not", () => {
    const p = proj();
    const other = proj();
    const req = createRequirement(p.id, { title: "Keyboard users can pay" });
    const reqNumber = (db.prepare("SELECT number FROM requirements WHERE id = ?").get(req) as { number: number }).number;
    createRequirement(other.id, { title: "Other project's" });
    db.prepare("UPDATE requirements SET external_id = 'CHK-1' WHERE id = ?").run(req);
    const c = makeCase(p.id, "Pay with card");
    makeCase(other.id, "Other project's case");
    run(p, [base({ refs: { requirements: [`REQ-${reqNumber}`, "CHK-1", "REQ-999", "NOPE-1"], cases: [`${p.key}-${c.number}`, `${other.key}-1`, `${p.key}-999`] } })]);
    const t = getManualTest(idOf(p, "focus-order"));
    const byRaw = Object.fromEntries(t.refs.map((r) => [r.raw, r]));
    assert.equal(byRaw[`REQ-${reqNumber}`].state, "resolved");
    assert.equal(byRaw["CHK-1"].state, "resolved", "the stable id of the requirement");
    assert.equal(byRaw["REQ-999"].state, "unresolved");
    assert.match(byRaw["REQ-999"].reason, /no such requirement/);
    assert.equal(byRaw["NOPE-1"].state, "unresolved");
    assert.equal(byRaw[`${p.key}-${c.number}`].state, "resolved");
    assert.equal(byRaw[`${other.key}-1`].state, "wrong_project");
    assert.match(byRaw[`${other.key}-1`].reason, new RegExp(`belongs to project ${other.key}`));
    assert.equal(byRaw[`${p.key}-999`].state, "unresolved");
  });

  it("another project's requirement is not reachable by its number or its stable id", () => {
    const owner = proj();
    const q = proj();
    const r = createRequirement(owner.id, { title: "Exists only in the other project" });
    db.prepare("UPDATE requirements SET external_id = 'ONLY-HERE' WHERE id = ?").run(r);
    const number = (db.prepare("SELECT number FROM requirements WHERE id = ?").get(r) as { number: number }).number;
    run(q, [base({ refs: { requirements: [`REQ-${number}`, "ONLY-HERE"] } })]);
    assert.deepEqual(getManualTest(idOf(q, "focus-order")).refs.map((x) => x.state), ["unresolved", "unresolved"]);
    assert.equal(count("SELECT COUNT(*) AS n FROM manual_test_refs WHERE requirement_id = ?", r), 0);
  });

  it("an unresolved reference resolves later, after the requirement has been created", () => {
    const p = proj();
    run(p, [base({ refs: { requirements: ["REQ-1"] } })]);
    const id = idOf(p, "focus-order");
    assert.equal(getManualTest(id).refs[0].state, "unresolved");
    createRequirement(p.id, { title: "Now it exists" });
    run(p, [base({ refs: { requirements: ["REQ-1"] } })]); // any later import tries again
    assert.equal(getManualTest(id).refs[0].state, "resolved");
  });

  it("a person can name the requirements a test covers; that edit is theirs and is not overwritten", () => {
    const p = proj();
    run(p, [base()]);
    const id = idOf(p, "focus-order");
    createRequirement(p.id, { title: "R1" });
    updateManualTest(id, { requirements: ["REQ-1", "REQ-77"] });
    assert.deepEqual(getManualTest(id).refs.map((r) => [r.raw, r.state]), [["REQ-1", "resolved"], ["REQ-77", "unresolved"]]);
    run(p, [base({ title: "Agent changes the title" })]);
    assert.deepEqual(getManualTest(id).refs.map((r) => r.raw), ["REQ-1", "REQ-77"], "an edited test keeps its links until the person applies the agent's version");
  });
});

describe("listing and deleting", () => {
  it("filters on status, category, priority, WCAG criterion, search and presence", () => {
    const p = proj();
    run(p, [
      base(),
      base({ sourceId: "contrast", title: "Contrast of error text", wcag: ["1.4.3", "1.4.11"], priority: "low" }),
      base({ sourceId: "mobile", title: "Phone layout", category: "responsive", wcag: [], viewports: [{ width: 390 }], priority: "medium" }),
      base({ sourceId: "login-flow", title: "Login makes sense", category: "usability", wcag: [], priority: "critical" }),
    ]);
    reviewManualTest(idOf(p, "login-flow"), "accepted");
    const ids = (o: Parameters<typeof listManualTests>[1]) => listManualTests(p.id, o).items.map((i) => i.sourceId).sort();
    assert.deepEqual(ids({}), ["contrast", "focus-order", "login-flow", "mobile"]);
    assert.deepEqual(ids({ status: "accepted" }), ["login-flow"]);
    assert.deepEqual(ids({ category: "accessibility" }), ["contrast", "focus-order"]);
    assert.deepEqual(ids({ priority: "critical" }), ["login-flow"]);
    assert.deepEqual(ids({ wcag: "1.4.11" }), ["contrast"]);
    assert.deepEqual(ids({ wcag: "any" }), ["contrast", "focus-order"]);
    assert.deepEqual(ids({ q: "phone" }), ["mobile"]);
    updateManualTest(idOf(p, "contrast"), { humanPriority: "critical" });
    assert.deepEqual(ids({ priority: "critical" }), ["contrast", "login-flow"], "the person's priority counts when they set one");
    assert.deepEqual(listManualTests(p.id).wcagCriteria, ["1.4.3", "1.4.11", "2.4.3"]);
    assert.deepEqual(listManualTests(p.id).counts, { proposed: 3, accepted: 1 });
    assert.throws(() => listManualTests(p.id, { category: "nope" }), /category must be one of/);
    assert.throws(() => listManualTests(p.id, { presence: "gone" }), /presence must be one of/);
  });

  it("is project scoped: the same ids in two projects are two tests", () => {
    const a = proj();
    const b = proj();
    run(a, [base()]);
    assert.equal(listManualTests(b.id).items.length, 0);
    run(b, [base()]);
    assert.equal(listManualTests(a.id).items.length, 1);
    assert.equal(listManualTests(b.id).items.length, 1);
    assert.notEqual(idOf(a, "focus-order"), idOf(b, "focus-order"));
  });

  it("deleting an accepted test needs confirmation", () => {
    const p = proj();
    run(p, [base()]);
    const id = idOf(p, "focus-order");
    reviewManualTest(id, "accepted");
    assert.throws(() => deleteManualTest(id), /accepted/);
    deleteManualTest(id, true);
    assert.equal(count("SELECT COUNT(*) AS n FROM manual_tests WHERE project_id = ?", p.id), 0);
  });
});
