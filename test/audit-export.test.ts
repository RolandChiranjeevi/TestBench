import "./env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readCanonicalPackage, validateContract } from "../server/importers/auditcontract.ts";
import { ExportError, exportToTestbench, PROVENANCE_FORMAT } from "../server/importers/testbenchexport.ts";
import { checkPackageDir } from "../server/importers/auditbuild.ts";

// A small but complete audit contract 1.2 package: one viewport, one failing check with a bug proposal, one manual test from a coverage gap.
const AID = "AUD-20260101-01";
const T = "2026-01-01T10:00:00Z";
const VP = { width: 375, height: 812 };

function contractPackage(edit: (m: any, bugs: any[], tests: any[]) => void = () => {}) {
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
  const report = [`# Audit ${AID}`, "", "## Summary", Object.entries(counts).map(([s, n]) => `**${n} ${s}**`).join(", "),
    `Bug proposals: **${bugs.length}**. Manual test proposals: **${tests.length}**. Coverage gaps: **${m.coverage_gaps.length}**.`, "",
    ...["Scope and environment", "Requirements and readiness", "Execution results", "Bug proposals", "Manual test proposals", "Coverage gaps and not verified",
      "Limitations", "TestBench backlog", "Evidence index", "Human review handover"].flatMap((h) => [`## ${h}`, "text", ""])].join("\n");
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
    assert.deepEqual(readFileSync(join(p.out, "report.md")), readFileSync(join(p.dir, "report.md")));
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
