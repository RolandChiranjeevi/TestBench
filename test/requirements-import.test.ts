import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db } from "../server/db.ts";
import { makeCase, makeProject } from "./helpers.ts";
import { bagFromFiles } from "../server/importers/bag.ts";
import { importAuditPackage, reviewBugReport } from "../server/audits.ts";
import { agentRequirements } from "../server/agentexport.ts";
import { getRequirement, kindProblem, listRequirements, setRequirementCases } from "../server/requirements.ts";
import { importRequirements, RequirementImportError } from "../server/reqimport.ts";
import { requirementCoverage } from "../server/reqlinks.ts";
import { reviewManualTest } from "../server/manualtests.ts";

let n = 0;
const proj = () => makeProject(`RQ${++n}`, `Requirements ${n}`);
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

const file = (p: { key: string }, requirements: unknown[], over: Record<string, unknown> = {}) =>
  JSON.stringify({ format: "testbench-requirements", version: 1, project: p.key, requirements, ...over });
const req = (over: Record<string, unknown> = {}) => ({ id: "CHK-001", title: "Customers can pay by card", description: "Card payment works", kind: "functional", priority: "high", status: "active", source: "https://example.test/spec#1", ...over });
const byExternal = (p: { id: number }, id: string) => db.prepare("SELECT * FROM requirements WHERE project_id = ? AND external_id = ?").get(p.id, id) as Record<string, any>;
const refused = (p: { id: number }, content: string) => assert.throws(() => importRequirements(p.id, content), RequirementImportError);

describe("importing requirements", () => {
  it("creates requirements with kind, WCAG criteria, viewports and the stable id, and maps active/retired onto the existing statuses", () => {
    const p = proj();
    const s = importRequirements(p.id, file(p, [
      req(),
      req({ id: "A11Y-1", title: "Focus order", kind: "accessibility", wcag: ["2.4.3", "1.3.2"], viewports: [{ width: 320 }], status: "draft", priority: "critical", source: "WCAG 2.2" }),
      req({ id: "RESP-1", title: "Works on phones", kind: "responsive", viewports: [{ device: "iPhone 13", width: 390, height: 844 }, { breakpoint: "md" }], status: "retired" }),
      req({ id: "SEC-1", title: "Card numbers are never logged", kind: "security_privacy" }),
      req({ id: "BR-1", title: "Free shipping over 500 kr", kind: "business_rule" }),
      req({ id: "UX-1", title: "Checkout needs no manual", kind: "usability" }),
    ]));
    assert.deepEqual(s.counts, { new: 6, unchanged: 0, updated: 0 });
    assert.equal(s.dryRun, false);
    const a = byExternal(p, "A11Y-1");
    assert.deepEqual([a.kind, a.status, a.priority, JSON.parse(a.wcag), JSON.parse(a.viewports)], ["accessibility", "draft", "critical", ["1.3.2", "2.4.3"], [{ width: 320 }]]);
    assert.equal(byExternal(p, "RESP-1").status, "deprecated");
    assert.equal(byExternal(p, "CHK-001").status, "approved");
    assert.deepEqual(JSON.parse(byExternal(p, "RESP-1").viewports), [{ device: "iPhone 13", width: 390, height: 844 }, { breakpoint: "md" }]);
    assert.deepEqual(listRequirements(p.id).map((r) => r.number), [1, 2, 3, 4, 5, 6], "numbered in the project as usual");
    assert.equal(listRequirements(p.id)[1].wcag.length, 2);
  });

  it("a dry run says what would happen and writes nothing", () => {
    const p = proj();
    const s = importRequirements(p.id, file(p, [req(), req({ id: "X", title: "Other" })]), { dryRun: true });
    assert.equal(s.dryRun, true);
    assert.deepEqual(s.counts, { new: 2, unchanged: 0, updated: 0 });
    assert.equal(count("SELECT COUNT(*) AS n FROM requirements WHERE project_id = ?", p.id), 0);
    assert.equal(count("SELECT next_requirement_number AS n FROM projects WHERE id = ?", p.id), 1, "no number is used up");
  });

  it("is idempotent: the same file again changes nothing, not even a revision", () => {
    const p = proj();
    const content = file(p, [req(), req({ id: "A11Y-1", title: "Focus", kind: "accessibility", wcag: ["2.4.3"] })]);
    importRequirements(p.id, content);
    const revisions = count("SELECT COUNT(*) AS n FROM requirement_revisions");
    const s = importRequirements(p.id, content);
    assert.deepEqual(s.counts, { new: 0, unchanged: 2, updated: 0 });
    assert.equal(count("SELECT COUNT(*) AS n FROM requirements WHERE project_id = ?", p.id), 2, "no duplicates");
    assert.equal(count("SELECT COUNT(*) AS n FROM requirement_revisions"), revisions);
    assert.ok(s.items.every((i) => i.action === "unchanged"));
  });

  it("updates an existing requirement by its stable id, keeps its number and links, and leaves the others alone", () => {
    const p = proj();
    importRequirements(p.id, file(p, [req(), req({ id: "OTHER", title: "Untouched by the second file" })]));
    const c = makeCase(p.id, "Pay by card");
    const target = byExternal(p, "CHK-001");
    setRequirementCases(target.id, p.id, [c.id]);
    const s = importRequirements(p.id, file(p, [req({ title: "Customers can pay by card or invoice", priority: "critical" })]));
    assert.deepEqual(s.counts, { new: 0, unchanged: 0, updated: 1 });
    assert.equal(s.untouched, 1, "the requirement that is not in the file is left as it is");
    assert.deepEqual(s.items[0].changes.map((x) => x.field), ["Title", "Priority"]);
    const after = byExternal(p, "CHK-001");
    assert.deepEqual([after.id, after.number, after.title, after.priority], [target.id, target.number, "Customers can pay by card or invoice", "critical"]);
    assert.equal(byExternal(p, "OTHER").title, "Untouched by the second file");
    assert.deepEqual(getRequirement(target.id)?.cases.map((x) => x.id), [c.id], "the link to the test case survives");
    assert.equal(getRequirement(target.id)!.history[0].material, true, "a new title asks the linked cases for a second look, as an edit does");
    assert.equal(count("SELECT COUNT(*) AS n FROM requirements WHERE project_id = ?", p.id), 2);
  });

  it("an existing requirement can be updated by its Testbench number, but a number cannot create one", () => {
    const p = proj();
    importRequirements(p.id, file(p, [req()]));
    const s = importRequirements(p.id, file(p, [{ id: "REQ-1", title: "Renamed through its number" }]));
    assert.deepEqual([s.counts.updated, s.items[0].matches], [1, "REQ-1"]);
    assert.equal(byExternal(p, "CHK-001").title, "Renamed through its number");
    assert.throws(() => importRequirements(p.id, file(p, [{ id: "REQ-99", title: "Invented" }])), (e) => e instanceof RequirementImportError && /no requirement with that number/.test(e.problems.join()));
    assert.equal(count("SELECT COUNT(*) AS n FROM requirements WHERE project_id = ?", p.id), 1);
  });

  it("never makes a duplicate: the same id twice, an id and the number it already has, and a same-titled new requirement warns", () => {
    const p = proj();
    importRequirements(p.id, file(p, [req()]));
    refused(p, file(p, [req(), req({ title: "Same id again" })]));
    refused(p, file(p, [req({ id: "chk-001" }), req({ id: "CHK-001" })]));
    assert.throws(() => importRequirements(p.id, file(p, [req(), { id: "REQ-1", title: "Same requirement, by number" }])), (e) => e instanceof RequirementImportError && /same requirement/.test(e.problems.join()));
    assert.equal(count("SELECT COUNT(*) AS n FROM requirements WHERE project_id = ?", p.id), 1);
    const s = importRequirements(p.id, file(p, [req({ id: "CHK-002" })]), { dryRun: true });
    assert.match(s.items[0].warnings.join(), /REQ-1 in this project has the same title/);
    assert.equal(count("SELECT COUNT(*) AS n FROM requirements WHERE project_id = ?", p.id), 1);
  });

  it("is all or nothing: one invalid requirement refuses the file", () => {
    const p = proj();
    const bad: [string, unknown][] = [
      ["WCAG on a functional requirement", req({ id: "B1", wcag: ["2.4.3"] })],
      ["viewports on a usability requirement", req({ id: "B2", kind: "usability", viewports: [{ width: 320 }] })],
      ["a WCAG criterion that is not one", req({ id: "B3", kind: "accessibility", wcag: ["AA"] })],
      ["an unknown kind", req({ id: "B4", kind: "performance" })],
      ["an unknown status", req({ id: "B5", status: "met" })],
      ["an unknown priority", req({ id: "B6", priority: "urgent" })],
      ["an empty title", req({ id: "B7", title: " " })],
      ["an id with spaces", req({ id: "has space" })],
    ];
    for (const [name, item] of bad) {
      assert.throws(() => importRequirements(p.id, file(p, [req({ id: "GOOD", title: "A fine one" }), item])), RequirementImportError, name);
      assert.equal(count("SELECT COUNT(*) AS n FROM requirements WHERE project_id = ?", p.id), 0, `${name}: not even the valid one was imported`);
    }
    refused(p, "not json");
    refused(p, JSON.stringify({ requirements: [] }));
    refused(p, file(p, [], { version: 2 }));
    assert.equal(kindProblem("functional", ["2.4.3"], []), "WCAG criteria belong to accessibility requirements");
    assert.equal(kindProblem("accessibility", ["2.4.3"], [{ width: 320 }]), null);
  });

  it("refuses a file for another project whole, and never reaches into another project", () => {
    const p = proj();
    const other = proj();
    importRequirements(other.id, file(other, [req()]));
    assert.throws(() => importRequirements(p.id, file(other, [req({ title: "Would overwrite" })])), (e) => e instanceof RequirementImportError && /is for project/.test(e.message));
    assert.equal(byExternal(other, "CHK-001").title, "Customers can pay by card", "the other project's requirement is untouched");
    // The same stable id in two projects is two requirements.
    importRequirements(p.id, file(p, [req({ title: "Mine" })]));
    assert.equal(byExternal(p, "CHK-001").title, "Mine");
    assert.equal(byExternal(other, "CHK-001").title, "Customers can pay by card");
    assert.notEqual(byExternal(p, "CHK-001").id, byExternal(other, "CHK-001").id);
    // A REQ-n number only ever means this project's requirement.
    importRequirements(p.id, file(p, [{ id: "REQ-1", title: "Renamed here" }]));
    assert.equal(byExternal(other, "CHK-001").title, "Customers can pay by card");
  });
});

describe("the requirements an agent reads", () => {
  it("gives the active requirements with title, description, priority, status, kind, WCAG, viewports and sources, and nothing that says met", () => {
    const p = proj();
    importRequirements(p.id, file(p, [
      req(),
      req({ id: "A11Y-1", title: "Focus order", kind: "accessibility", wcag: ["2.4.3"], viewports: [{ width: 320 }], source: "WCAG 2.2" }),
      req({ id: "DRAFT-1", title: "Not decided", status: "draft" }),
      req({ id: "OLD-1", title: "Gone", status: "retired" }),
    ]));
    const out = agentRequirements(p.id);
    assert.deepEqual([out.format, out.version, out.project], ["testbench-requirements", 1, p.key]);
    assert.deepEqual(out.requirements.map((r) => r.id), ["CHK-001", "A11Y-1"], "only the active ones by default");
    const a = out.requirements[1];
    assert.deepEqual([a.title, a.kind, a.priority, a.status, a.wcag, a.viewports, a.source, a.sourceUrl, a.ref], ["Focus order", "accessibility", "high", "active", ["2.4.3"], [{ width: 320 }], "WCAG 2.2", null, "REQ-2"]);
    assert.equal(out.requirements[0].sourceUrl, "https://example.test/spec#1");
    assert.match(out.note, /must not claim it is/);
    assert.doesNotMatch(JSON.stringify(out), /"(met|fulfilled|satisfied|passing|passed)"/i);
    assert.deepEqual(agentRequirements(p.id, { status: "draft" }).requirements.map((r) => r.id), ["DRAFT-1"]);
    assert.deepEqual(agentRequirements(p.id, { status: "retired" }).requirements.map((r) => r.id), ["OLD-1"]);
    assert.equal(agentRequirements(p.id, { status: "all" }).requirements.length, 4);
    assert.deepEqual(agentRequirements(p.id, { kind: "accessibility" }).requirements.map((r) => r.id), ["A11Y-1"]);
    assert.throws(() => agentRequirements(p.id, { status: "met" }), /status must be one of/);
  });

  it("only lists the project's own requirements", () => {
    const p = proj();
    const other = proj();
    importRequirements(other.id, file(other, [req({ id: "THEIRS", title: "Theirs" })]));
    importRequirements(p.id, file(p, [req()]));
    assert.deepEqual(agentRequirements(p.id).requirements.map((r) => r.id), ["CHK-001"]);
  });

  it("an exported file can be imported again and changes nothing", () => {
    const p = proj();
    importRequirements(p.id, file(p, [req(), req({ id: "A11Y-1", title: "Focus", kind: "accessibility", wcag: ["2.4.3"], viewports: [{ width: 320 }] }), req({ id: "OLD", title: "Old", status: "retired" })]));
    const s = importRequirements(p.id, JSON.stringify(agentRequirements(p.id, { status: "all" })));
    assert.deepEqual(s.counts, { new: 0, unchanged: 3, updated: 0 });
  });

  it("is not changed by anything the agent sends: a proposal does not cover or break a requirement, a person's decision does", () => {
    const p = proj();
    importRequirements(p.id, file(p, [req()]));
    const f = new Map<string, Uint8Array>();
    f.set("manifest.json", Buffer.from(JSON.stringify({ format: "testbench-audit-package", version: 1, audit: { id: "a1", project: p.key }, files: [], parts: {} })));
    f.set("bugs.json", Buffer.from(JSON.stringify({ version: 1, bugs: [{ sourceId: "bug-1", title: "Card fails", refs: { requirements: ["CHK-001"] } }] })));
    f.set("manual-tests.json", Buffer.from(JSON.stringify({ version: 1, tests: [{ sourceId: "t1", title: "Pay", steps: ["Pay"], expected: "Paid", priority: "high", category: "functional", refs: { requirements: ["REQ-1"] } }] })));
    importAuditPackage(bagFromFiles(f), { projectId: p.id, source: "upload" });
    let c = agentRequirements(p.id).requirements[0].coverage;
    assert.deepEqual([c.manualTestsProposed, c.manualTestsAccepted, c.hasTest, c.openBugs, c.proposedBugs], [1, 0, false, 0, 1], "proposals are shown but do not count");
    assert.equal(requirementCoverage(p.id).summary.withoutTest, 1);
    const tid = (db.prepare("SELECT id FROM manual_tests WHERE project_id = ?").get(p.id) as { id: number }).id;
    const bid = (db.prepare("SELECT id FROM bug_reports WHERE project_id = ?").get(p.id) as { id: number }).id;
    reviewManualTest(tid, "accepted");
    reviewBugReport(bid, "accepted");
    c = agentRequirements(p.id).requirements[0].coverage;
    assert.deepEqual([c.manualTestsAccepted, c.hasTest, c.openBugs], [1, true, 1]);
    const links = agentRequirements(p.id).requirements[0].links;
    assert.deepEqual([links.manualTests.map((t) => t.sourceId), links.bugs.map((b) => b.title)], [["t1"], ["Card fails"]]);
    reviewManualTest(tid, "rejected");
    assert.equal(agentRequirements(p.id).requirements[0].links.manualTests.length, 0, "a rejected test is no longer a link");
  });
});

describe("coverage of requirements", () => {
  /** One run of audit "a1" whose bug and manual test both name `reqs`. */
  const audit = (p: { id: number; key: string }, reqs: string[]) => {
    const f = new Map<string, Uint8Array>();
    f.set("manifest.json", Buffer.from(JSON.stringify({ format: "testbench-audit-package", version: 1, audit: { id: "a1", project: p.key }, files: [], parts: {} })));
    f.set("bugs.json", Buffer.from(JSON.stringify({ version: 1, bugs: [{ sourceId: "b", title: "B", refs: { requirements: reqs } }] })));
    f.set("manual-tests.json", Buffer.from(JSON.stringify({ version: 1, tests: [{ sourceId: "t", title: "T", steps: ["x"], expected: "y", priority: "low", category: "functional", refs: { requirements: reqs } }] })));
    return importAuditPackage(bagFromFiles(f), { projectId: p.id, source: "upload" });
  };

  it("tells which requirements have no test, have open bugs, or were not referenced by the latest audit run", () => {
    const p = proj();
    importRequirements(p.id, file(p, [req({ id: "R1", title: "One" }), req({ id: "R2", title: "Two" }), req({ id: "R3", title: "Three" }), req({ id: "OLD", title: "Retired", status: "retired" })]));
    assert.deepEqual(requirementCoverage(p.id).summary, { active: 3, withoutTest: 3, withOpenBugs: 0, notInLatestRun: 0, auditKnown: false }, "no audit yet: nothing to say about a run");
    const c = makeCase(p.id, "Case for R3");
    setRequirementCases(byExternal(p, "R3").id, p.id, [c.id]);
    audit(p, ["R1", "R2"]);
    reviewManualTest((db.prepare("SELECT id FROM manual_tests WHERE project_id = ?").get(p.id) as { id: number }).id, "accepted");
    reviewBugReport((db.prepare("SELECT id FROM bug_reports WHERE project_id = ?").get(p.id) as { id: number }).id, "accepted");
    audit(p, ["R1"]); // the second run only names R1; the accepted copies keep naming R1 and R2 and the newer version waits as a revision
    const cov = requirementCoverage(p.id);
    assert.equal(cov.summary.active, 3);
    assert.equal(cov.summary.auditKnown, true);
    const by = (id: string) => listRequirements(p.id).find((r) => r.external_id === id)!.links;
    assert.deepEqual([by("R1").withoutTest, by("R1").bugs.open, by("R1").audit], [false, 1, "referenced"]);
    assert.equal(by("R3").withoutTest, false, "a linked test case is coverage");
    assert.equal(by("R3").audit, "not_referenced", "no audit run names it");
    assert.equal(getRequirement(byExternal(p, "R1").id)?.linked.manualTests.length, 1);
    assert.equal(getRequirement(byExternal(p, "R1").id)?.linked.bugs.length, 1);
    assert.equal(by("R2").audit, "not_referenced", "the latest run named R1 only, whatever the older accepted copy says");
    assert.equal(cov.summary.notInLatestRun, 2, "R2 and R3");
    assert.equal(cov.summary.withOpenBugs, 2, "the accepted bug's own copy names R1 and R2");
  });

  it("a requirement the latest run no longer names is not referenced, while the earlier run did", () => {
    const p = proj();
    importRequirements(p.id, file(p, [req({ id: "R1", title: "One" }), req({ id: "R2", title: "Two" })]));
    audit(p, ["R1", "R2"]);
    audit(p, ["R1"]);
    const by = (id: string) => listRequirements(p.id).find((r) => r.external_id === id)!.links;
    assert.equal(by("R1").audit, "referenced");
    assert.equal(by("R2").audit, "not_referenced");
    assert.equal(requirementCoverage(p.id).summary.notInLatestRun, 1);
  });

  it("shows references to requirements that do not exist, with the reason", () => {
    const p = proj();
    importRequirements(p.id, file(p, [req()]));
    audit(p, ["CHK-001", "NOPE-9", "REQ-77"]);
    const u = requirementCoverage(p.id).unresolved as { kind: string; raw: string; reason: string }[];
    assert.deepEqual(u.map((x) => [x.kind, x.raw]).sort(), [["bug", "NOPE-9"], ["bug", "REQ-77"], ["manual_test", "NOPE-9"], ["manual_test", "REQ-77"]]);
    assert.ok(u.every((x) => x.reason.length > 0));
    assert.match(u.find((x) => x.raw === "REQ-77")!.reason, /no such requirement in this project/);
  });

  it("links are project scoped: another project's items never count for this project's requirement", () => {
    const p = proj();
    const other = proj();
    importRequirements(p.id, file(p, [req()]));
    importRequirements(other.id, file(other, [req()]));
    audit(other, ["CHK-001"]);
    reviewManualTest((db.prepare("SELECT id FROM manual_tests WHERE project_id = ?").get(other.id) as { id: number }).id, "accepted");
    assert.deepEqual([listRequirements(p.id)[0].links.manualTests, listRequirements(p.id)[0].links.audit], [{ accepted: 0, proposed: 0 }, "no_audit"]);
    assert.equal(listRequirements(other.id)[0].links.manualTests.accepted, 1);
  });
});
