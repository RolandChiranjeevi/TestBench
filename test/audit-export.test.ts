import "./env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readCanonicalPackage, readReportCounts, validateContract } from "../server/importers/auditcontract.ts";
import { ExportError, exportToTestbench, PROVENANCE_FORMAT, testPlanSection, withTestPlan } from "../server/importers/testbenchexport.ts";
import { checkPackageDir } from "../server/importers/auditbuild.ts";

// A small but complete audit contract 1.2 package: one viewport, one failing check with a bug proposal, one manual test from a coverage gap.
const AID = "AUD-20260101-01";
const T = "2026-01-01T10:00:00Z";
const VP = { width: 375, height: 812 };

const reportText = (summary: string) => [`# Audit ${AID}`, "", "## Summary", summary, "",
  ...["Scope and environment", "Requirements and readiness", "Execution results", "Bug proposals", "Manual test proposals", "Coverage gaps and not verified",
    "Limitations", "TestBench backlog", "Evidence index", "Human review handover"].flatMap((h) => [`## ${h}`, "text", ""])].join("\n");

/** `summary` replaces the Summary of report.md; without it the Summary states the real numbers in bold, as the qa-run skill writes them. */
function contractPackage(edit: (m: any, bugs: any[], tests: any[]) => void = () => {}, summary?: string) {
  const root = mkdtempSync(join(tmpdir(), "tb-export-"));
  const dir = join(root, AID);
  mkdirSync(join(dir, "evidence"), { recursive: true });
  writeFileSync(join(dir, "evidence", "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  writeFileSync(join(dir, "evidence", "dom.txt"), "counter: 2 items left\n");
  const ev = (id: string, f: string, type: string, related: string[]) => ({ evidence_id: id, type, source: "playwright-mcp", location: `evidence/${f}`, related, captured_at: T, description: `${f} evidence`, viewport: VP, redacted: false });
  const m: any = {
    audit_id: AID, contract_version: "1.2", created_at: T, agent: { name: "qa-run", model: "m" }, target: { url: "https://example.test", environment: "test", build: null },
    scope: {
      objective: "o", target: { url: "https://example.test", environment: "test", build: null }, included_requirement_ids: ["REQ-1", "REQ-2"], excluded_requirement_ids: [],
      allowed_check_types: ["Functional", "Accessibility"], viewports: [VP],
      state_changes: { allowed: true, allowed_actions: [{ action: "complete_todo", limit: "one per viewport", data: "X" }], constraints: "" },
      test_data_constraints: "", out_of_scope: [], stop_conditions: [], confirmed_at: T, confirmed_by: "tester",
    },
    requirements: [
      { requirement_id: "REQ-1", title: "Counter", source: "testbench", readiness: "ready", acceptance_criteria: ["The counter shows 0 after completing"] },
      { requirement_id: "REQ-2", title: "Names", source: "testbench", readiness: "ready", acceptance_criteria: ["Controls have names"] },
    ],
    test_plan_items: [
      { test_plan_item_id: "TPI-001", requirement_id: "REQ-1", title: "Complete one", risk: "High", priority: "High", type: "Functional", readiness: "ready" },
      { test_plan_item_id: "TPI-002", requirement_id: "REQ-2", title: "Names", risk: "Low", priority: "Low", type: "Accessibility", readiness: "ready" },
    ],
    executions: [
      { execution_id: "EX-001", test_plan_item_id: "TPI-001", requirement_id: "REQ-1", status: "fail", reason: null, started_at: "2026-01-01T10:01:00Z", finished_at: "2026-01-01T10:02:00Z", url: "https://example.test", viewport: VP, mode: "mcp-exploration", evidence_ids: ["EV-001", "EV-002"], summary: "s" },
      { execution_id: "EX-002", test_plan_item_id: "TPI-002", requirement_id: "REQ-2", status: "pass", reason: null, started_at: "2026-01-01T10:03:00Z", finished_at: "2026-01-01T10:04:00Z", url: "https://example.test", viewport: VP, mode: "mcp-exploration", evidence_ids: ["EV-002"], summary: "s" },
    ],
    actions: [{ action_id: "ACT-001", execution_id: "EX-001", action: "complete_todo", target: "t", allowed_by_scope: true, performed_at: T, evidence_ids: ["EV-001"] }],
    evidence: [ev("EV-001", "shot.png", "screenshot", ["EX-001", "BP-001"]), ev("EV-002", "dom.txt", "dom-excerpt", ["EX-001", "EX-002", "BP-001"])],
    coverage_gaps: [{ coverage_gap_id: "CG-001", requirement_id: "REQ-2", description: "no screen reader" }],
    testbench_backlog: [], limitations: [], external_actions: [],
    validation: { validated_at: T, contract_version: "1.2", result: "pass", errors: [] },
    delivery: { status: "not_delivered", delivered_at: null, method: null, target: null, request_reference: null, response_reference: null, error: null },
    human_review: { required: true, status: "pending" },
  };
  const bugs: any[] = [{
    bug_proposal_id: "BP-001", title: "Counter: shows 2 instead of 0 when the only todo is completed", finding_category: "functional",
    duplicate_check: "not_available", possible_duplicate_of: null, requirement_link: { requirement_id: "REQ-1", acceptance_criterion: "The counter shows 0 after completing", test_plan_item_id: "TPI-001", execution_ids: ["EX-001"] },
    environment: { url: "https://example.test", browser: "Chromium", viewport: "375x812", test_environment: "test" }, preconditions: ["One todo"],
    steps_to_reproduce: ["Add a todo", "Complete it"], expected_result: "0 items left", actual_result: "2 items left", reproduction_rate: "Always, 2 of 2",
    severity: "Medium", agent_confidence: "High", execution_ids: ["EX-001"], evidence_ids: ["EV-001", "EV-002"], status: "proposed",
  }];
  const tests: any[] = [{
    manual_test_proposal_id: "MTP-001", title: "Listen to the controls with a screen reader", requirement_id: "REQ-2", objective: "Hear the names",
    steps: ["Start a screen reader", "Tab through"], expected_result: "Every control is announced with a name", origin: { type: "coverage_gap", id: "CG-001" },
    reason_manual: "needs a person", evidence_ids: ["EV-002"], status: "proposed",
  }];
  edit(m, bugs, tests);
  const counts = Object.fromEntries(["pass", "fail", "blocked", "skipped", "inconclusive"].map((s) => [s, m.executions.filter((x: any) => x.status === s).length]));
  const defaultSummary = Object.entries(counts).map(([st, n]) => `**${n} ${st}**`).join(", ") +
    `\nBug proposals: **${bugs.length}**. Manual test proposals: **${tests.length}**. Coverage gaps: **${m.coverage_gaps.length}**.`;
  const report = reportText(summary ?? defaultSummary);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2));
  writeFileSync(join(dir, "bugs.json"), JSON.stringify(bugs, null, 2));
  writeFileSync(join(dir, "manual-tests.json"), JSON.stringify(tests, null, 2));
  writeFileSync(join(dir, "report.md"), report);
  return { root, dir, out: join(root, "export", AID) };
}

const hashTree = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath, e.name);
    out[p.slice(dir.length + 1)] = createHash("sha256").update(readFileSync(p)).digest("hex");
  }
  return out;
};
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("audit contract 1.2 check", () => {
  it("accepts the sample package, and refuses a broken one", () => {
    assert.equal(validateContract(readCanonicalPackage(contractPackage().dir), { complete: true }).ok, true);
    const bad = validateContract(readCanonicalPackage(contractPackage((m) => { m.executions[1].status = "passed"; }).dir));
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.startsWith("V-07")));
  });

  it("needs every viewport of the scope for a complete audit", () => {
    const pkg = readCanonicalPackage(contractPackage((m) => { m.scope.viewports.push({ width: 1440, height: 900 }); }).dir);
    assert.equal(validateContract(pkg).ok, true);
    assert.match(validateContract(pkg, { complete: true }).errors.join(), /COMPLETE: no executions at 1440x900/);
  });

  it("finds a token in a text file (V-17)", () => {
    const p = contractPackage();
    writeFileSync(join(p.dir, "evidence", "dom.txt"), "Authorization: Bearer tbag_x");
    assert.ok(validateContract(readCanonicalPackage(p.dir)).errors.some((e) => e.startsWith("V-17")));
  });
});

describe("export to the Testbench import format", () => {
  it("writes an accepted package to the output folder and leaves the input untouched", () => {
    const p = contractPackage();
    const before = hashTree(p.dir);
    const r = exportToTestbench({ input: p.dir, output: p.out, project: "RS", now: new Date(T) });
    assert.deepEqual(hashTree(p.dir), before, "the canonical package is unchanged");
    assert.equal(r.testbench.ok, true, r.testbench.errors.join("; "));
    assert.equal(r.testbench.auditId, AID);
    assert.equal(r.testbench.project, "RS");
    assert.deepEqual(r.testbench.sourceIds, ["BP-001"]);
    assert.deepEqual(r.testbench.manualSourceIds, ["MTP-001"]);
    // The same check run on its own, as the CLI and the import do.
    assert.equal(checkPackageDir(p.out).ok, true);
  });

  it("builds the manifest with files, sha256 and size taken from the copies", () => {
    const p = contractPackage();
    exportToTestbench({ input: p.dir, output: p.out, project: "RS" });
    const m = json(join(p.out, "manifest.json"));
    assert.equal(m.format, "testbench-audit-package");
    assert.equal(m.version, 1);
    assert.deepEqual({ id: m.audit.id, project: m.audit.project, startedAt: m.audit.startedAt, finishedAt: m.audit.finishedAt }, { id: AID, project: "RS", startedAt: "2026-01-01T10:01:00Z", finishedAt: "2026-01-01T10:04:00Z" });
    assert.deepEqual(m.parts, { bugs: "bugs.json", manualTests: "manual-tests.json", narrative: "report.md" });
    for (const f of m.files) {
      const bytes = readFileSync(join(p.out, f.path));
      assert.equal(f.size, bytes.length);
      assert.equal(f.sha256, createHash("sha256").update(bytes).digest("hex"));
      assert.deepEqual(bytes, readFileSync(join(p.dir, f.path)), `${f.path} is a byte-for-byte copy`);
    }
    assert.deepEqual(m.files.map((f: any) => f.path).sort(), ["evidence/dom.txt", "evidence/shot.png"]);
    const canonicalManifest = json(join(p.dir, "manifest.json"));
    assert.equal(readFileSync(join(p.out, "report.md"), "utf8"), readFileSync(join(p.dir, "report.md"), "utf8").replace("## Execution results", `${testPlanSection(canonicalManifest, 2)}\n## Execution results`), "report.md is the canonical one plus the generated Test plan section, nothing else");
  });

  it("maps bug proposals and manual tests, and marks generated values", () => {
    const p = contractPackage();
    exportToTestbench({ input: p.dir, output: p.out, project: "RS" });
    const b = json(join(p.out, "bugs.json"));
    assert.equal(b.version, 1);
    const bug = b.bugs[0];
    assert.equal(bug.sourceId, "BP-001");
    assert.deepEqual(bug.steps, ["Add a todo", "Complete it"]);
    assert.deepEqual([bug.expected, bug.actual, bug.url, bug.environment, bug.agentSeverity, bug.foundAt], ["0 items left", "2 items left", "https://example.test", "test", "medium", "2026-01-01T10:02:00Z"]);
    assert.deepEqual(bug.refs.requirements, ["REQ-1"]);
    assert.deepEqual(bug.evidence.map((e: any) => e.path), ["evidence/shot.png", "evidence/dom.txt"]);
    assert.match(bug.description, /Agent confidence: High/);
    assert.equal("confidence" in bug, false, "no invented number for High/Medium/Low");
    assert.equal("status" in bug, false);

    const t = json(join(p.out, "manual-tests.json"));
    assert.equal(t.version, 1);
    const mt = t.tests[0];
    assert.deepEqual([mt.sourceId, mt.expected, mt.priority, mt.category], ["MTP-001", "Every control is announced with a name", "low", "accessibility"]);
    assert.deepEqual(mt.refs.requirements, ["REQ-2"]);
    assert.match(mt.description, /origin: coverage_gap CG-001/);

    const prov = json(join(p.out, "provenance.json"));
    assert.equal(prov.format, PROVENANCE_FORMAT);
    assert.deepEqual(prov.idMap.bugs, [{ bug_proposal_id: "BP-001", sourceId: "BP-001" }]);
    assert.deepEqual(prov.generated.map((g: any) => [g.target, g.value, g.adapterGenerated]), [
      ["manual-tests.json tests[MTP-001].priority", "low", true], ["manual-tests.json tests[MTP-001].category", "accessibility", true]]);
    assert.ok(prov.notMapped.some((n: any) => n.field.startsWith("manifest.executions")));
  });

  it("takes priority and category from the origin execution's plan item", () => {
    const p = contractPackage((_m, _b, tests) => { tests[0].origin = { type: "execution", id: "EX-001" }; tests[0].requirement_id = "REQ-1"; });
    exportToTestbench({ input: p.dir, output: p.out, project: "RS" });
    const mt = json(join(p.out, "manual-tests.json")).tests[0];
    assert.deepEqual([mt.priority, mt.category], ["high", "functional"]);
  });

  it("writes nothing when the input is not a valid finished package", () => {
    const p = contractPackage((m) => { m.scope.viewports.push({ width: 1440, height: 900 }); });
    assert.throws(() => exportToTestbench({ input: p.dir, output: p.out, project: "RS" }), (e: unknown) => e instanceof ExportError && /COMPLETE/.test(e.message));
    assert.equal(existsSync(join(p.root, "export")), false);
  });

  it("refuses an output inside the input, a missing project key, and a folder it did not write", () => {
    const p = contractPackage();
    assert.throws(() => exportToTestbench({ input: p.dir, output: join(p.dir, "out"), project: "RS" }), ExportError);
    assert.throws(() => exportToTestbench({ input: p.dir, output: p.out, project: "" }), /--project/);
    mkdirSync(p.out, { recursive: true });
    writeFileSync(join(p.out, "keep.txt"), "mine");
    assert.throws(() => exportToTestbench({ input: p.dir, output: p.out, project: "RS", overwrite: true }), /not written by this adapter/);
    assert.equal(readFileSync(join(p.out, "keep.txt"), "utf8"), "mine");
  });

  it("replaces its own earlier export only with overwrite", () => {
    const p = contractPackage();
    exportToTestbench({ input: p.dir, output: p.out, project: "RS" });
    assert.throws(() => exportToTestbench({ input: p.dir, output: p.out, project: "RS" }), /--overwrite/);
    assert.equal(exportToTestbench({ input: p.dir, output: p.out, project: "RS", overwrite: true }).testbench.ok, true);
  });
});

describe("V-20 reads the numbers of report.md without depending on its formatting", () => {
  const validate = (summary: string, edit?: (m: any, bugs: any[], tests: any[]) => void) => validateContract(readCanonicalPackage(contractPackage(edit, summary).dir), { complete: true });
  const ALL = { pass: 1, fail: 1, blocked: 0, skipped: 0, inconclusive: 0, "bug proposals": 1, "manual test proposals": 1, "coverage gaps": 1 };

  it("accepts the same numbers as a table, as prose, and in another wording", () => {
    const table = validate("| Status | Count |\n|---|---|\n| pass | 1 |\n| fail | 1 |\n| blocked | 0 |\n| skipped | 0 |\n| inconclusive | 0 |\n\nWe found 1 bug proposal, 1 manual test proposal and 1 coverage gap.");
    assert.equal(table.ok, true, table.errors.join("; "));
    assert.deepEqual(table.reportCounts, { readable: ALL, unreadable: [] });
    assert.equal(table.warnings.some((w) => w.startsWith("V-20")), false);

    const prose = validate("Results: 1 passed, 1 failed, 0 blocked, 0 skipped, 0 inconclusive.\nBug proposals = 1; Manual test proposals: 1; Coverage gaps: 1");
    assert.equal(prose.ok, true, prose.errors.join("; "));
    assert.deepEqual(prose.reportCounts, { readable: ALL, unreadable: [] });
  });

  it("reads only the Summary, tolerates heading level and line endings, and is not fooled by words that contain a status", () => {
    const r = readReportCounts("# R\r\n\r\n### Summary\r\n**1 pass**, _1 fail_, 0 blocked, 0 skipped, 0 inconclusive. The password was not stored.\r\nBug proposals: 1. Manual test proposals: 1. Coverage gaps: 1.\r\n\r\n### Detail\r\n5 pass, 9 fail, Bug proposals: 7\r\n");
    assert.deepEqual(r, { readable: ALL, unreadable: [] });
    assert.deepEqual(readReportCounts("# R\n\n## Summary\n1 pass\n\n## Execution results\n1 fail, 0 blocked, 0 skipped, 0 inconclusive").readable, { pass: 1 }, "numbers outside the Summary are not counts");
    assert.equal(readReportCounts("# R\n\n## Other\n1 pass").unreadable.length, 8, "no Summary section: nothing is read");
  });

  it("warns, and does not compare, when the numbers cannot be read or are stated in conflicting ways", () => {
    const none = validate("The audit went well.");
    assert.equal(none.ok, true, none.errors.join("; "));
    assert.equal(none.reportCounts.unreadable.length, 8);
    assert.deepEqual(none.reportCounts.readable, {});
    assert.match(none.warnings.join("\n"), /V-20: 8 number\(s\) could not be read reliably from the Summary of report\.md and were not compared with the package: pass \(not found\)/);

    const conflicting = validate("1 pass at first, later 2 pass. 1 fail, 0 blocked, 0 skipped, 0 inconclusive. Bug proposals: 1. Manual test proposals: 1. Coverage gaps: 1.");
    assert.equal(conflicting.ok, true, conflicting.errors.join("; "));
    assert.deepEqual(conflicting.reportCounts.unreadable, [{ name: "pass", reason: "ambiguous: 1 and 2" }]);
    assert.equal(conflicting.reportCounts.readable.fail, 1, "the other numbers are still compared");
    assert.match(conflicting.warnings.join("\n"), /pass \(ambiguous: 1 and 2\)/);
  });

  it("lets the export continue on that warning, and records it in provenance.json", () => {
    const p = contractPackage(undefined, "The audit went well.");
    const r = exportToTestbench({ input: p.dir, output: p.out, project: "RS" });
    assert.equal(r.testbench.ok, true, r.testbench.errors.join("; "));
    const cv = json(join(p.out, "provenance.json")).source.contractValidation;
    assert.equal(cv.ok, true);
    assert.equal(cv.reportCounts.unreadable.length, 8);
    assert.ok(cv.warnings.some((w: string) => w.startsWith("V-20: 8 number(s) could not be read reliably")));
  });

  it("still fails when a number that can be read contradicts the package, and then writes nothing", () => {
    const wrongStatus = validate("**2 pass**, **1 fail**, 0 blocked, 0 skipped, 0 inconclusive. Bug proposals: 1. Manual test proposals: 1. Coverage gaps: 1.");
    assert.equal(wrongStatus.ok, false);
    assert.match(wrongStatus.errors.join("\n"), /V-20: the Summary of report\.md states 2 pass, but the package has 1/);
    const wrongBugs = validate("1 pass, 1 fail, 0 blocked, 0 skipped, 0 inconclusive. Bug proposals: 0. Manual test proposals: 1. Coverage gaps: 1.");
    assert.match(wrongBugs.errors.join("\n"), /states 0 bug proposals, but the package has 1/);

    const p = contractPackage(undefined, "**2 pass**, **1 fail**, 0 blocked, 0 skipped, 0 inconclusive. Bug proposals: 1. Manual test proposals: 1. Coverage gaps: 1.");
    assert.throws(() => exportToTestbench({ input: p.dir, output: p.out, project: "RS" }), (e: unknown) => e instanceof ExportError && /V-20/.test(e.message));
    assert.equal(existsSync(join(p.root, "export")), false);
  });

  it("still requires the headings of contract 5.4, at any heading level", () => {
    const p = contractPackage();
    const text = readFileSync(join(p.dir, "report.md"), "utf8");
    writeFileSync(join(p.dir, "report.md"), text.replace("## Limitations\n", "").replace("## Evidence index", "#### Evidence index"));
    const r = validateContract(readCanonicalPackage(p.dir));
    assert.match(r.errors.join("\n"), /5\.4: report\.md misses the heading\(s\) Limitations/);
    assert.doesNotMatch(r.errors.join("\n"), /Evidence index/);
  });
});

describe("bug proposals are mapped through an explicit, validated field table", () => {
  const run = (edit: (bug: any, m: any) => void = () => {}) => {
    const p = contractPackage((m, bugs) => edit(bugs[0], m));
    const r = exportToTestbench({ input: p.dir, output: p.out, project: "RS" });
    const prov = json(join(p.out, "provenance.json"));
    return { p, r, prov, bug: json(join(p.out, "bugs.json")).bugs[0], rep: prov.bugMapping.bugs[0], manifest: json(join(p.out, "manifest.json")) };
  };

  it("maps a bug with every expected field, and has nothing to warn about", () => {
    const { r, bug, rep, prov } = run();
    assert.deepEqual(r.warnings, []);
    assert.deepEqual([rep.missing, rep.unexpectedFormat, rep.unmappedFields], [[], [], []]);
    assert.deepEqual(prov.exportWarnings, []);
    assert.equal(bug.sourceId, "BP-001");
    assert.deepEqual([bug.steps, bug.expected, bug.actual, bug.url, bug.environment, bug.agentSeverity, bug.foundAt], [["Add a todo", "Complete it"], "0 items left", "2 items left", "https://example.test", "test", "medium", "2026-01-01T10:02:00Z"]);
    assert.deepEqual(bug.refs.requirements, ["REQ-1"]);
    for (const line of ["Finding category: functional", "Requirement: REQ-1, criterion: The counter shows 0 after completing", "Test plan item: TPI-001", "Executions: EX-001",
      "Preconditions: One todo", "Browser: Chromium", "Viewport: 375x812", "Reproduction rate: Always, 2 of 2", "Agent confidence: High", "Duplicate check: not_available"]) {
      assert.ok(bug.description.split("\n").includes(line), `description has "${line}"`);
    }
    assert.ok(rep.mapped.some((x: any) => x.from === "steps_to_reproduce" && x.to === "bugs[].steps"));
    assert.ok(prov.bugMapping.spec.some((x: any) => x.field === "expected_result" && x.mapsTo === "bugs[].expected"));
    assert.ok(rep.notes.some((n: string) => /agent_confidence .* not turned into the number/.test(n)));
    assert.equal(r.testbench.ok, true, r.testbench.errors.join("; "));
  });

  it("warns with the bug id and the field when a field is missing, makes nothing up, and records it", () => {
    const { r, bug, rep, prov } = run((b) => { delete b.expected_result; delete b.severity; });
    assert.ok(r.warnings.includes('bug BP-001: field "expected_result" is missing; bugs[].expected is left empty'));
    assert.ok(r.warnings.includes('bug BP-001: field "severity" is missing; bugs[].agentSeverity is not set'));
    assert.equal(r.warnings.length, 2);
    assert.equal(bug.expected, "");
    assert.equal("agentSeverity" in bug, false);
    assert.doesNotMatch(bug.description, /everity/);
    assert.equal(bug.actual, "2 items left", "the rest of the bug is still mapped");
    assert.deepEqual(rep.missing.map((x: any) => x.field).sort(), ["expected_result", "severity"]);
    assert.deepEqual(prov.exportWarnings, r.warnings);
    assert.equal(r.testbench.ok, true, r.testbench.errors.join("; "));
  });

  it("warns on an unexpected format, copies nothing from it, and records what was found", () => {
    const { r, bug, rep } = run((b) => { b.steps_to_reproduce = "Add a todo, then complete it"; b.severity = "Urgent"; b.environment = "Chromium on macOS"; });
    const w = r.warnings.join("\n");
    assert.match(w, /bug BP-001: field "steps_to_reproduce" has an unexpected format \(accepts: array of non-empty strings; found: string\); bugs\[\]\.steps is left empty/);
    assert.match(w, /bug BP-001: field "severity" has an unexpected format .*; found: string\)/);
    assert.match(w, /bug BP-001: field "environment" has an unexpected format \(accepts: object with url/);
    assert.deepEqual([bug.steps, bug.url, bug.environment], [[], "", ""]);
    assert.equal("agentSeverity" in bug, false);
    assert.doesNotMatch(bug.description, /macOS|Urgent|then complete/);
    assert.deepEqual(rep.unexpectedFormat.map((x: any) => [x.field, x.found, x.valuePreview]).sort(),
      [["environment", "string", "Chromium on macOS"], ["severity", "string", "Urgent"], ["steps_to_reproduce", "string", "Add a todo, then complete it"]]);
    assert.equal(r.testbench.ok, true, r.testbench.errors.join("; "));
  });

  it("accepts the object forms of severity, agent confidence and reproduction rate, and reports fields it does not know", () => {
    const { r, bug, rep } = run((b) => {
      b.severity = { level: "High", rationale: "blocks the flow" };
      b.agent_confidence = { level: "Medium", basis: "one reproduction" };
      b.reproduction_rate = { rate: "Sometimes", attempts: 3 };
      b.internal_note = "x";
      b.requirement_link.extra = 1;
    });
    assert.equal(bug.agentSeverity, "high");
    for (const line of ["Severity rationale: blocks the flow", "Agent confidence: Medium (one reproduction)", "Reproduction rate: Sometimes (attempts: 3)"]) assert.ok(bug.description.split("\n").includes(line), line);
    assert.deepEqual(rep.unmappedFields.sort(), ["internal_note", "requirement_link.extra"]);
    assert.ok(r.warnings.includes('bug BP-001: field "internal_note" is not part of the bug mapping and was not exported'));
    assert.ok(r.warnings.includes('bug BP-001: field "requirement_link.extra" is not part of the bug mapping and was not exported'));
    assert.equal("internal_note" in bug, false);
  });

  it("puts the evidence a bug cites into bugs[].evidence and manifest.files[], with the hash and size of the copies", () => {
    const { p, r, bug, manifest } = run();
    assert.deepEqual(bug.evidence.map((e: any) => e.path), ["evidence/shot.png", "evidence/dom.txt"]);
    assert.deepEqual(bug.evidence.map((e: any) => e.label.slice(0, 7)), ["EV-001:", "EV-002:"]);
    for (const e of bug.evidence) {
      const f = manifest.files.find((x: any) => x.path === e.path);
      assert.ok(f, `${e.path} is in manifest.files[]`);
      const bytes = readFileSync(join(p.out, e.path));
      assert.deepEqual([f.sha256, f.size], [createHash("sha256").update(bytes).digest("hex"), bytes.length]);
    }
    assert.equal(checkPackageDir(p.out).ok, true, "the importer opens every evidence file the bug cites and compares it with the manifest");
    assert.deepEqual(r.warnings, []);
  });

  it("does not export evidence that is a link, and says so", () => {
    const { r, bug, rep } = run((b, m) => {
      m.evidence.push({ evidence_id: "EV-003", type: "design-reference", source: "user-supplied", location: "https://example.test/design", related: ["BP-001"], captured_at: T, description: "design", viewport: VP, redacted: false });
      b.evidence_ids.push("EV-003");
    });
    assert.equal(bug.evidence.length, 2);
    assert.ok(r.warnings.some((w) => /^bug BP-001: evidence EV-003 is not a file in evidence\/ .*so it is not exported as bugs\[\]\.evidence$/.test(w)));
    assert.ok(rep.notes.some((n: string) => n.includes("EV-003 is a link")));
  });

  it("stops before writing anything when a bug has no title, a blank title or no valid id", () => {
    const noTitle = contractPackage((_m, bugs) => { delete bugs[0].title; });
    assert.throws(() => exportToTestbench({ input: noTitle.dir, output: noTitle.out, project: "RS" }),
      (e: unknown) => e instanceof ExportError && /BP-001/.test(e.message) && /no title/.test(e.message) && /nothing was written/.test(e.message));
    assert.equal(existsSync(join(noTitle.root, "export")), false);
    const blankTitle = contractPackage((_m, bugs) => { bugs[0].title = "   "; });
    assert.throws(() => exportToTestbench({ input: blankTitle.dir, output: blankTitle.out, project: "RS" }), /no title/);
    assert.equal(existsSync(join(blankTitle.root, "export")), false);
    const badId = contractPackage((_m, bugs) => { bugs[0].bug_proposal_id = "bug-1"; });
    assert.throws(() => exportToTestbench({ input: badId.dir, output: badId.out, project: "RS" }), (e: unknown) => e instanceof ExportError && /V-03/.test(e.message));
    assert.equal(existsSync(join(badId.root, "export")), false);
  });
});

describe("the Test plan section of the exported report.md", () => {
  const sha = (t: string) => createHash("sha256").update(t).digest("hex");
  const run = (reportEdit?: (text: string) => string) => {
    const p = contractPackage();
    if (reportEdit) writeFileSync(join(p.dir, "report.md"), reportEdit(readFileSync(join(p.dir, "report.md"), "utf8")));
    const before = hashTree(p.dir);
    const r = exportToTestbench({ input: p.dir, output: p.out, project: "RS" });
    return { p, r, before, canonical: readFileSync(join(p.dir, "report.md"), "utf8"), exported: readFileSync(join(p.out, "report.md"), "utf8"), prov: json(join(p.out, "provenance.json")), manifest: json(join(p.dir, "manifest.json")) };
  };

  it("lists every plan item with all its fields and every coverage gap, before Execution results", () => {
    const { r, exported, canonical, prov, manifest, p, before } = run();
    const lines = exported.split("\n");
    for (const line of [
      "## Test plan",
      "2 plan items for 2 requirements. Generated from the manifest of the audit package (test_plan_items and coverage_gaps) when it was exported for Testbench; the report.md of the package itself is unchanged.",
      "- TPI-001 | REQ-1 | Functional | risk: High | priority: High | readiness: ready", "  Complete one",
      "- TPI-002 | REQ-2 | Accessibility | risk: Low | priority: Low | readiness: ready", "  Names",
      "### Coverage gaps (from the manifest)", "- CG-001 | REQ-2", "  no screen reader",
    ]) assert.ok(lines.includes(line), `has the line: ${line.slice(0, 60)}`);
    const at = (h: string) => lines.indexOf(h);
    assert.ok(at("## Requirements and readiness") < at("## Test plan") && at("## Test plan") < at("## Execution results"), "between Requirements and Execution results");
    assert.equal(exported, canonical.replace("## Execution results", `${testPlanSection(manifest, 2)}\n## Execution results`), "the canonical text plus the section, nothing else");
    assert.doesNotMatch(canonical, /Test plan/, "the canonical report has no Test plan section");
    assert.deepEqual(hashTree(p.dir), before, "the canonical package is unchanged");
    assert.deepEqual(prov.report, { canonicalSha256: sha(canonical), exportedSha256: sha(exported), generatedSections: ["Test plan"], placement: "before Execution results" });
    assert.deepEqual(r.report, { generated: true, where: "before Execution results" });
    assert.equal(r.testbench.ok, true, r.testbench.errors.join("; "));
  });

  it("does not add a second plan when the report already has one", () => {
    const { r, exported, canonical, prov } = run((t) => t.replace("## Execution results", "## Test plan\nmy own plan\n\n## Execution results"));
    assert.equal(exported, canonical);
    assert.equal(exported.match(/^## Test plan$/gm)?.length, 1);
    assert.deepEqual([prov.report.generatedSections, r.report.generated], [[], false]);
    assert.match(prov.report.placement, /already has a Test plan section/);
  });

  it("puts the section at the end when there is no Execution results heading, and follows the heading level and the line ending", () => {
    const m = { test_plan_items: [{ test_plan_item_id: "TPI-001", requirement_id: "REQ-1", type: "Functional", risk: "High", priority: "High", readiness: "ready", title: "T" }], coverage_gaps: [] };
    const end = withTestPlan("# R\n\n## Summary\ntext\n", m);
    assert.equal(end.generated, true);
    assert.match(end.where, /end of the report/);
    assert.equal(end.text, `# R\n\n## Summary\ntext\n\n${testPlanSection(m, 2)}`);
    assert.match(end.text, /### Coverage gaps \(from the manifest\)\n\nNone recorded\.\n$/);

    const deeper = withTestPlan("# R\n\n### Summary\ntext\n\n### Execution results\nrows\n", m);
    assert.match(deeper.text, /\n### Test plan\n/);
    assert.match(deeper.text, /\n#### Coverage gaps \(from the manifest\)\n/);
    assert.ok(deeper.text.indexOf("### Test plan") < deeper.text.indexOf("### Execution results"));

    const crlf = withTestPlan("# R\r\n\r\n## Summary\r\ntext\r\n\r\n## Execution results\r\nrows\r\n", m);
    assert.equal(crlf.text.replace(/\r\n/g, "").includes("\n"), false, "every line ending is still CRLF");
    assert.match(crlf.text, /## Test plan\r\n/);
  });

  it("leaves the report alone when the manifest has no plan items and no coverage gaps, and says '(not stated)' for a missing field", () => {
    const none = withTestPlan("# R\n\n## Execution results\nrows\n", { test_plan_items: [], coverage_gaps: [] });
    assert.deepEqual([none.generated, none.text], [false, "# R\n\n## Execution results\nrows\n"]);
    assert.match(none.where, /no plan items or coverage gaps/);
    const thin = testPlanSection({ test_plan_items: [{ test_plan_item_id: "TPI-009" }], coverage_gaps: [{ coverage_gap_id: "CG-009" }] });
    assert.match(thin, /- TPI-009 \| \(not stated\) \| \(not stated\) \| risk: \(not stated\) \| priority: \(not stated\) \| readiness: \(not stated\)\n  \(not stated\)\n/);
    assert.match(thin, /- CG-009 \| \(not stated\)\n  \(not stated\)\n$/);
  });
});
