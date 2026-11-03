import "./env.ts";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { db } from "../server/db.ts";
import { makeProject } from "./helpers.ts";
import { importAuditPackage } from "../server/audits.ts";
import { checkPackageDir, readPackageDir } from "../server/importers/auditbuild.ts";
import { bagFromFiles } from "../server/importers/bag.ts";
import { getManualTest, listManualTests } from "../server/manualtests.ts";
import { importRequirements } from "../server/reqimport.ts";
import { agentRequirements } from "../server/agentexport.ts";

const EXAMPLE = join(import.meta.dirname, "..", "examples", "audit-package");
const REQUIREMENTS = join(import.meta.dirname, "..", "examples", "requirements", "shop-requirements.json");
const scratch = mkdtempSync(join(tmpdir(), "tb-manual-"));
let n = 0;
const copy = () => {
  const dir = join(scratch, `pkg-${++n}`);
  cpSync(EXAMPLE, dir, { recursive: true });
  return dir;
};
const project = () => makeProject(`EX${++n}`, "Example shop");
/** The example package, but for another project key (a package names the project it is for). */
const forProject = (key: string) => {
  const dir = copy();
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  m.audit.project = key;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
  return dir;
};
const requirementsFor = (key: string) => readFileSync(REQUIREMENTS, "utf8").replace('"project": "SHOP"', `"project": "${key}"`);

describe("the example package and the example requirements", () => {
  it("the example package checks out and carries functional, WCAG and responsive manual tests", () => {
    const r = checkPackageDir(EXAMPLE);
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.deepEqual(r.manualSourceIds, ["checkout-card-declined-message", "checkout-screen-reader-focus-order", "checkout-layout-phone-and-tablet"]);
  });

  it("imports after the example requirements, and every reference of the manual tests resolves", () => {
    const p = project();
    importRequirements(p.id, requirementsFor(p.key));
    const s = importAuditPackage(bagFromFiles(readPackageDir(forProject(p.key))), { projectId: p.id, source: "upload" });
    assert.deepEqual(s.manualTests.counts, { new: 3, unchanged: 0, updated: 0, pending: 0 });
    const tests = listManualTests(p.id, { status: "proposed" }).items;
    assert.deepEqual(tests.map((t) => t.category).sort(), ["accessibility", "functional", "responsive"]);
    const a11y = tests.find((t) => t.category === "accessibility")!;
    assert.deepEqual(a11y.wcag, ["1.3.2", "2.4.3", "4.1.2"]);
    assert.equal(tests.find((t) => t.category === "responsive")!.viewports.length, 2);
    for (const t of tests) {
      const d = getManualTest(t.id);
      assert.ok(d.refs.length > 0 && d.refs.every((r) => r.state === "resolved"), `${t.sourceId}: every reference resolves`);
      assert.equal(d.status, "proposed");
    }
    const agent = agentRequirements(p.id).requirements;
    const a = agent.find((r) => r.id === "CHECKOUT-A11Y-1")!;
    assert.deepEqual([a.coverage.manualTestsProposed, a.coverage.manualTestsAccepted, a.coverage.hasTest], [1, 0, false], "proposed by the agent, not covered until a person accepts");
    assert.equal(agent.some((r) => r.id === "CART-RULE-1"), false, "a draft is not active");
  });

  it("the example requirements import again without changes", () => {
    const p = project();
    const content = requirementsFor(p.key);
    assert.deepEqual(importRequirements(p.id, content).counts, { new: 5, unchanged: 0, updated: 0 });
    assert.deepEqual(importRequirements(p.id, content).counts, { new: 0, unchanged: 5, updated: 0 });
  });
});

describe("the package checker and manual tests", () => {
  it("fills in parts.manualTests, names the ids, and compares with an earlier package", () => {
    const dir = copy();
    const earlier = copy();
    const file = join(dir, "manual-tests.json");
    const j = JSON.parse(readFileSync(file, "utf8"));
    j.tests = j.tests.filter((t: { sourceId: string }) => t.sourceId !== "checkout-layout-phone-and-tablet").concat([{ ...j.tests[0], sourceId: "a-new-test" }]);
    writeFileSync(file, JSON.stringify(j));
    const r = checkPackageDir(dir, { write: true, previousDir: earlier });
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).parts.manualTests, "manual-tests.json");
    assert.deepEqual(r.compared?.manual, { same: ["checkout-card-declined-message", "checkout-screen-reader-focus-order"], added: ["a-new-test"], missing: ["checkout-layout-phone-and-tablet"] });
    assert.match(r.warnings.join(" "), /Manual tests not in this package any more: checkout-layout-phone-and-tablet/);
  });

  it("refuses an invalid manual-tests.json with a message that names the test, and warns about ids and missing WCAG criteria", () => {
    const dir = copy();
    const file = join(dir, "manual-tests.json");
    const j = JSON.parse(readFileSync(file, "utf8"));
    j.tests[0].steps = [];
    writeFileSync(file, JSON.stringify(j));
    const bad = checkPackageDir(dir);
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join(" "), /manual-tests\.json: test #1 \(checkout-card-declined-message\).*steps/);

    const ok = copy();
    const f2 = join(ok, "manual-tests.json");
    const k = JSON.parse(readFileSync(f2, "utf8"));
    k.tests[1].wcag = [];
    k.tests[2].sourceId = "TC-3";
    k.tests.forEach((t: { refs?: unknown }) => delete t.refs);
    writeFileSync(f2, JSON.stringify(k));
    const w = checkPackageDir(ok);
    assert.equal(w.ok, true);
    const text = w.warnings.join(" ");
    assert.match(text, /manual test sourceId is a plain number \(TC-3\)/);
    assert.match(text, /accessibility test names no WCAG criterion/);
    assert.match(text, /3 manual tests name no requirement/);
  });

  it("a package for another project is refused whole, manual tests included", () => {
    const p = project();
    const other = project();
    const dir = forProject(other.key);
    assert.throws(() => importAuditPackage(bagFromFiles(readPackageDir(dir)), { projectId: p.id, source: "upload" }), /is being imported into/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM manual_tests WHERE project_id IN (?, ?)").get(p.id, other.id) as { n: number }).n, 0);
    const ok = importAuditPackage(bagFromFiles(readPackageDir(dir)), { projectId: other.id, source: "upload" });
    assert.equal(ok.manualTests.counts.new, 3);
  });
});
