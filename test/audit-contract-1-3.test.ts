import "./env.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readCanonicalPackage, validateContract } from "../server/importers/auditcontract.ts";
import { exportToTestbench, mapTestPlan } from "../server/importers/testbenchexport.ts";
import { checkPackageDir } from "../server/importers/auditbuild.ts";

// A small but complete audit contract package. 1.3 has a structured test plan, test-plan.md and the Test plan section of report.md; 1.2 has none of them.
const AID = "AUD-20260102-01";
const T = "2026-01-02T10:00:00Z";
const VP = { width: 375, height: 812 };

const PLAN_MD = (ids = ["TPI-001", "TPI-002", "CG-001"]) => ["# Test plan", "", ...ids.map((i) => `- ${i}`), ""].join("\n");

const reportText = (version: "1.2" | "1.3", plan: string[]) => {
  const planSection = version === "1.3" ? ["## Test plan", ...plan.map((i) => `- ${i}`), ""] : [];
  return [`# Audit ${AID}`, "", "## Summary", "**1 pass**, **0 fail**, **0 blocked**, **1 skipped**, **0 inconclusive**", "Bug proposals: **0**. Manual test proposals: **0**. Coverage gaps: **1**.", "",
    ...["Scope and environment", "Requirements and readiness"].flatMap((h) => [`## ${h}`, "text", ""]),
    ...planSection,
    ...["Execution results", "Bug proposals", "Manual test proposals", "Coverage gaps and not verified", "Limitations", "TestBench backlog", "Evidence index", "Human review handover"].flatMap((h) => [`## ${h}`, "text", ""])].join("\n");
};

interface Opts {
  version?: "1.2" | "1.3";
  edit?: (m: any) => void;
  planMd?: string | null;
  report?: string;
}

function contractPackage(o: Opts = {}) {
  const version = o.version ?? "1.3";
  const root = mkdtempSync(join(tmpdir(), "tb-c13-"));
  const dir = join(root, AID);
  mkdirSync(join(dir, "evidence"), { recursive: true });
  writeFileSync(join(dir, "evidence", "dom.txt"), "counter: 0 items left\n");
  const item = (id: string, req: string, ready: boolean) => ({
    test_plan_item_id: id, requirement_id: req, title: `Check ${req}`, risk: "High", priority: "High", type: "Functional", readiness: ready ? "ready" : "needs-clarification",
    ...(version === "1.3"
      ? ready
        ? { preconditions: "One todo exists", test_data: "Title: QA-AUDIT-1", steps: ["Add a todo", "Complete it"], acceptance_criteria: "The counter shows 0", automation: { suitable: true, mode: "saved-test" } }
        : { preconditions: "None", test_data: "None", steps: [], acceptance_criteria: "The requirement has no measurable criterion", automation: { suitable: false, reason: "no criterion to assert" } }
      : {}),
  });
  const m: any = {
    audit_id: AID, contract_version: version, created_at: T, agent: { name: "qa-run", model: "m" }, target: { url: "https://example.test", environment: "test", build: null },
    scope: {
      objective: "o", target: { url: "https://example.test", environment: "test", build: null }, included_requirement_ids: ["REQ-1", "REQ-LOCAL-002"], excluded_requirement_ids: [],
      allowed_check_types: ["Functional"], viewports: [VP], state_changes: { allowed: true, allowed_actions: [], constraints: "" },
      test_data_constraints: "", out_of_scope: [], stop_conditions: [], confirmed_at: T, confirmed_by: "tester",
    },
    requirements: [
      { requirement_id: "REQ-1", title: "Counter", source: "testbench", readiness: "ready", acceptance_criteria: ["The counter shows 0"] },
      { requirement_id: "REQ-LOCAL-002", title: "Vague", source: "local", readiness: "needs-clarification", acceptance_criteria: [] },
    ],
    test_plan_items: [item("TPI-001", "REQ-1", true), item("TPI-002", "REQ-LOCAL-002", false)],
    executions: [
      { execution_id: "EX-001", test_plan_item_id: "TPI-001", requirement_id: "REQ-1", status: "pass", reason: null, started_at: "2026-01-02T10:01:00Z", finished_at: "2026-01-02T10:02:00Z", url: "https://example.test", viewport: VP, mode: "mcp-exploration", evidence_ids: ["EV-001"], summary: "s" },
      { execution_id: "EX-002", test_plan_item_id: "TPI-002", requirement_id: "REQ-LOCAL-002", status: "skipped", reason: "needs-clarification", started_at: "2026-01-02T10:03:00Z", finished_at: "2026-01-02T10:03:30Z", url: "https://example.test", viewport: VP, mode: "mcp-exploration", evidence_ids: [], summary: "s" },
    ],
    actions: [],
    evidence: [{ evidence_id: "EV-001", type: "dom-excerpt", source: "playwright-mcp", location: "evidence/dom.txt", related: ["EX-001"], captured_at: T, description: "dom", viewport: VP, redacted: false }],
    coverage_gaps: [{ coverage_gap_id: "CG-001", requirement_id: "REQ-LOCAL-002", description: "no measurable criterion" }],
    testbench_backlog: [], limitations: [], external_actions: [],
    validation: { validated_at: T, contract_version: version, result: "pass", errors: [] },
    delivery: { status: "not_delivered", delivered_at: null, method: null, target: null, request_reference: null, response_reference: null, error: null },
    human_review: { required: true, status: "pending" },
  };
  o.edit?.(m);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2));
  writeFileSync(join(dir, "bugs.json"), "[]");
  writeFileSync(join(dir, "manual-tests.json"), "[]");
  writeFileSync(join(dir, "report.md"), o.report ?? reportText(version, ["TPI-001", "TPI-002", "CG-001"]));
  if (version === "1.3" && o.planMd !== null) writeFileSync(join(dir, "test-plan.md"), o.planMd ?? PLAN_MD());
  return { root, dir, out: join(root, "export", AID) };
}

const check = (o: Opts = {}) => validateContract(readCanonicalPackage(contractPackage(o).dir), { complete: true });
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const ruleErrors = (r: { errors: string[] }, rule: string) => r.errors.filter((e) => e.startsWith(rule));

describe("contract versions", () => {
  it("accepts 1.2 and 1.3 and refuses any other version, naming both", () => {
    assert.deepEqual(check({ version: "1.2" }).errors, []);
    assert.deepEqual(check({ version: "1.3" }).errors, []);
    const r = check({ edit: (m) => { m.contract_version = "1.1"; } });
    assert.match(r.errors.join("\n"), /contract_version is "1\.1", expected "1\.2" or "1\.3"/);
  });

  it("does not ask a 1.2 package for test-plan.md or the Test plan section", () => {
    const r = check({ version: "1.2" });
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.match(r.warnings.join("\n"), /contract 1\.2 stores no hash/);
  });

  it("reports the version of the package in the V-32 warning", () => {
    assert.match(check({ version: "1.3" }).warnings.join("\n"), /contract 1\.3 stores no hash/);
  });
});

describe("V-33: test-plan.md and the manifest name the same plan items and coverage gaps", () => {
  it("passes when they match", () => {
    const r = check();
    assert.equal(r.ok, true, r.errors.join("; "));
  });
  it("V-01: refuses a 1.3 package without test-plan.md", () => {
    const r = check({ planMd: null });
    assert.deepEqual(ruleErrors(r, "V-01"), ["V-01: test-plan.md is missing (required from contract 1.3)"]);
  });
  it("names a plan item or a coverage gap that test-plan.md leaves out, and one it adds", () => {
    const r = check({ planMd: PLAN_MD(["TPI-001", "TPI-009", "CG-007"]) });
    const e = ruleErrors(r, "V-33").join("\n");
    assert.match(e, /does not name the plan item\(s\) TPI-002/);
    assert.match(e, /names plan item\(s\) that are not in the manifest: TPI-009/);
    assert.match(e, /does not name the coverage gap\(s\) CG-001/);
    assert.match(e, /names coverage gap\(s\) that are not in the manifest: CG-007/);
  });
  it("does not take a longer id for a shorter one (TPI-0010 is not TPI-001)", () => {
    const r = check({ planMd: "TPI-0010 TPI-002 CG-001\n" });
    assert.match(ruleErrors(r, "V-33").join("\n"), /does not name the plan item\(s\) TPI-001/);
  });
});

describe("V-34: a plan item is complete", () => {
  const bad = (edit: (t: any) => void) => check({ edit: (m) => edit(m.test_plan_items[0]) });
  it("needs at least one non-empty step for a ready requirement", () => {
    assert.match(ruleErrors(bad((t) => { t.steps = []; }), "V-34").join(), /TPI-001 needs steps/);
    assert.match(ruleErrors(bad((t) => { t.steps = ["ok", " "]; }), "V-34").join(), /TPI-001 needs steps/);
    assert.match(ruleErrors(bad((t) => { t.steps = "Add a todo"; }), "V-34").join(), /TPI-001 needs steps/);
  });
  it("needs preconditions, test_data and acceptance_criteria (None is a value, empty is not)", () => {
    for (const f of ["preconditions", "test_data", "acceptance_criteria"]) {
      assert.match(ruleErrors(bad((t) => { t[f] = ""; }), "V-34").join(), new RegExp(`TPI-001 needs a non-empty ${f}`));
      assert.match(ruleErrors(bad((t) => { delete t[f]; }), "V-34").join(), new RegExp(`TPI-001 needs a non-empty ${f}`));
      assert.deepEqual(ruleErrors(bad((t) => { t[f] = "None"; }), "V-34"), []);
    }
  });
  it("needs automation as an object: a mode when suitable, a reason when not", () => {
    assert.match(ruleErrors(bad((t) => { t.automation = "Yes"; }), "V-34").join(), /automation as an object/);
    assert.match(ruleErrors(bad((t) => { delete t.automation; }), "V-34").join(), /automation as an object/);
    assert.match(ruleErrors(bad((t) => { t.automation = { suitable: "yes" }; }), "V-34").join(), /boolean suitable/);
    assert.match(ruleErrors(bad((t) => { t.automation = { suitable: true }; }), "V-34").join(), /automation\.mode must be one of mcp-exploration, saved-test, both/);
    assert.match(ruleErrors(bad((t) => { t.automation = { suitable: true, mode: "manual" }; }), "V-34").join(), /automation\.mode/);
    assert.match(ruleErrors(bad((t) => { t.automation = { suitable: false }; }), "V-34").join(), /automation\.reason is needed/);
    for (const mode of ["mcp-exploration", "saved-test", "both"]) assert.deepEqual(ruleErrors(bad((t) => { t.automation = { suitable: true, mode }; }), "V-34"), []);
  });
  it("a needs-clarification requirement has steps: [] and is not asked for the rest", () => {
    const r = check({ edit: (m) => { m.test_plan_items[1].steps = ["invented"]; } });
    assert.match(ruleErrors(r, "V-34").join(), /TPI-002 belongs to a needs-clarification requirement and must have steps: \[\]/);
    const ok = check({ edit: (m) => { for (const f of ["preconditions", "test_data", "automation"]) delete m.test_plan_items[1][f]; } });
    assert.deepEqual(ruleErrors(ok, "V-34"), []);
  });
  it("does not apply to a 1.2 package", () => {
    assert.deepEqual(ruleErrors(check({ version: "1.2", edit: (m) => { m.test_plan_items[0].steps = "x"; } }), "V-34"), []);
  });
});

describe("V-35 and the report headings of 1.3", () => {
  it("needs the Test plan section", () => {
    const r = check({ report: reportText("1.2", []) });
    assert.deepEqual(ruleErrors(r, "V-35"), ["V-35: report.md has no Test plan section"]);
    assert.deepEqual(ruleErrors(r, "5.4"), [], "a missing Test plan section is reported once, as V-35");
  });
  it("needs the plan items and coverage gaps of the manifest, in the manifest's order", () => {
    assert.match(ruleErrors(check({ report: reportText("1.3", ["TPI-002", "TPI-001", "CG-001"]) }), "V-35").join(), /lists the plan items TPI-002, TPI-001, the manifest has TPI-001, TPI-002/);
    assert.match(ruleErrors(check({ report: reportText("1.3", ["TPI-001", "TPI-002"]) }), "V-35").join(), /lists the coverage gaps \(none\), the manifest has CG-001/);
    assert.match(ruleErrors(check({ report: reportText("1.3", ["TPI-001", "TPI-002", "CG-001", "CG-002"]) }), "V-35").join(), /lists the coverage gaps CG-001, CG-002/);
  });
  it("the section ends at the next heading of its level, so an id under another heading does not count", () => {
    const r = check({ report: reportText("1.3", ["TPI-001", "TPI-002"]).replace("## Execution results\ntext", "## Execution results\nCG-001") });
    assert.match(ruleErrors(r, "V-35").join(), /lists the coverage gaps \(none\)/);
  });
  it("puts Test plan between Requirements and readiness and Execution results (5.4)", () => {
    const text = reportText("1.3", ["TPI-001", "TPI-002", "CG-001"]);
    const moved = text.replace(/## Test plan[^]*?(?=## Execution results)/, "").replace("## Bug proposals", "## Test plan\n- TPI-001\n- TPI-002\n- CG-001\n\n## Bug proposals");
    assert.deepEqual(ruleErrors(check({ report: moved }), "5.4"), ["5.4: the headings of report.md are out of order"]);
  });
  it("V-17 also searches test-plan.md for secrets", () => {
    const r = check({ planMd: PLAN_MD() + "token tbci_abc123\n" });
    assert.match(ruleErrors(r, "V-17").join(), /test-plan\.md/);
  });
});

describe("export of a 1.3 package: test-plan.json", () => {
  it("writes the plan in the import's names, as the mapping of contract section 9 says", () => {
    const p = contractPackage({ edit: (m) => { m.test_plan_items[0].automation = { suitable: true, mode: "both" }; } });
    const r = exportToTestbench({ input: p.dir, output: p.out, project: "RS" });
    assert.equal(r.testbench.ok, true, r.testbench.errors.join("; "));
    assert.deepEqual(r.testbench.warnings, []);
    assert.ok(r.files.includes("test-plan.json"));
    assert.deepEqual(json(join(p.out, "test-plan.json")), {
      version: 1,
      planItems: [
        { sourceId: "TPI-001", title: "Check REQ-1", type: "Functional", risk: "High", priority: "High", readiness: "ready", preconditions: "One todo exists", testData: "Title: QA-AUDIT-1",
          steps: ["Add a todo", "Complete it"], acceptanceCriteria: "The counter shows 0", automation: "Yes, both", refs: { requirements: ["REQ-1"] } },
        { sourceId: "TPI-002", title: "Check REQ-LOCAL-002", type: "Functional", risk: "High", priority: "High", readiness: "needs-clarification", preconditions: "None", testData: "None",
          steps: [], acceptanceCriteria: "The requirement has no measurable criterion", automation: "No: no criterion to assert", refs: { requirements: ["REQ-LOCAL-002"] } },
      ],
      coverageGaps: [{ sourceId: "CG-001", description: "no measurable criterion", refs: { requirements: ["REQ-LOCAL-002"] } }],
    });
    assert.equal(json(join(p.out, "manifest.json")).parts.testPlan, "test-plan.json");
    const prov = json(join(p.out, "provenance.json"));
    assert.equal(prov.source.contractVersion, "1.3");
    assert.equal(prov.testPlan.file, "test-plan.json");
    assert.equal(prov.testPlan.planItems, 2);
    assert.equal(prov.testPlan.coverageGaps, 1);
    assert.ok(prov.source.files["test-plan.md"], "the hash of test-plan.md is recorded");
    assert.deepEqual(prov.idMap.planItems[1], { test_plan_item_id: "TPI-002", sourceId: "TPI-002", requirement_id: "REQ-LOCAL-002" });
    assert.ok(!prov.notMapped.some((n: any) => /^manifest\.(test_plan_items|coverage_gaps)\[\]/.test(n.field)), "the plan is no longer listed as not mapped");
    // The report already has a Test plan section, so the adapter adds none.
    assert.deepEqual(r.report, { generated: false, where: "not added: the report already has a Test plan section" });
  });

  it("leaves a 1.2 package as it was: no test-plan.json, the report section is still generated", () => {
    const p = contractPackage({ version: "1.2" });
    const r = exportToTestbench({ input: p.dir, output: p.out, project: "RS" });
    assert.equal(r.testbench.ok, true, r.testbench.errors.join("; "));
    assert.ok(!r.files.includes("test-plan.json"));
    assert.equal(json(join(p.out, "manifest.json")).parts.testPlan, undefined);
    assert.equal(r.report.generated, true);
    const prov = json(join(p.out, "provenance.json"));
    assert.equal(prov.source.contractVersion, "1.2");
    assert.equal(prov.testPlan, undefined);
  });

  it("writes nothing for a 1.3 package that breaks V-33", () => {
    const p = contractPackage({ planMd: PLAN_MD(["TPI-001"]) });
    assert.throws(() => exportToTestbench({ input: p.dir, output: p.out, project: "RS" }), /V-33/);
  });

  it("leaves the value empty and warns when automation is not in the contract's form, and does not cut long values", () => {
    const m = json(join(contractPackage().dir, "manifest.json"));
    m.test_plan_items[0].automation = "Yes";
    m.test_plan_items[0].title = "x".repeat(250);
    const { file, warnings } = mapTestPlan(m);
    assert.equal(file.planItems[0].automation, "");
    assert.equal(file.planItems[0].title.length, 250);
    assert.deepEqual(warnings, ["plan item TPI-001: automation is not in the form of contract section 5.9, so it is left empty"]);
  });

  it("does not hide a plan that Testbench would refuse: the export is written and the check says no", () => {
    const p = contractPackage({ edit: (m) => { m.test_plan_items[0].title = "x".repeat(201); } });
    const r = exportToTestbench({ input: p.dir, output: p.out, project: "RS" });
    assert.equal(r.testbench.ok, false);
    assert.match(r.testbench.errors.join("\n"), /test-plan\.json: plan item #1 \(TPI-001\)/);
  });
});

describe("the import warns about names in test-plan.json it does not know", () => {
  const exported = () => {
    const p = contractPackage();
    exportToTestbench({ input: p.dir, output: p.out, project: "RS" });
    return p.out;
  };
  const plan = (out: string, edit: (f: any) => void) => {
    const f = json(join(out, "test-plan.json"));
    edit(f);
    writeFileSync(join(out, "test-plan.json"), JSON.stringify(f));
    return checkPackageDir(out, { write: false });
  };

  it("says nothing about a plan that uses only known names", () => {
    const r = checkPackageDir(exported(), { write: false });
    assert.equal(r.ok, true);
    assert.deepEqual(r.warnings, []);
  });

  it("names the plan item and the field, and suggests the Testbench name for a snake_case one", () => {
    const r = plan(exported(), (f) => {
      const t = f.planItems[0];
      t.test_data = t.testData; delete t.testData;
      t.acceptance_criteria = t.acceptanceCriteria; delete t.acceptanceCriteria;
      t.notes = "x";
    });
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.deepEqual(r.warnings, [
      'test-plan.json: plan item TPI-001: "test_data" is not a name the import knows and was ignored; did you mean "testData"?',
      'test-plan.json: plan item TPI-001: "acceptance_criteria" is not a name the import knows and was ignored; did you mean "acceptanceCriteria"?',
      'test-plan.json: plan item TPI-001: "notes" is not a name the import knows and was ignored',
    ]);
  });

  it("covers coverage gaps, refs and the top-level names", () => {
    const r = plan(exported(), (f) => {
      f.coverageGaps[0].requirement_id = "REQ-1";
      f.coverageGaps[0].refs.tests = ["T1"];
      f.planItems[1].refs.cases = ["C1"];
      f.plan_items = [];
    });
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.deepEqual([...r.warnings].sort(), [
      'test-plan.json: "plan_items" is not a name the import knows and was ignored; did you mean "planItems"?',
      'test-plan.json: coverage gap CG-001 refs: "tests" is not a name the import knows and was ignored',
      'test-plan.json: coverage gap CG-001: "requirement_id" is not a name the import knows and was ignored',
      'test-plan.json: plan item TPI-002 refs: "cases" is not a name the import knows and was ignored',
    ]);
  });
});
