import "./env.ts";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { unzipSync } from "fflate";
import { db } from "../server/db.ts";
import { makeProject } from "./helpers.ts";
import { bagFromFiles, bagFromZip } from "../server/importers/bag.ts";
import { checkPackageDir, readPackageDir, zipPackageDir } from "../server/importers/auditbuild.ts";
import { getBugReport, importAuditPackage, listBugReports, reviewBugReport } from "../server/audits.ts";
import { seedDemo } from "../server/demo.ts";

const ROOT = join(import.meta.dirname, "..");
const RUNS = join(ROOT, "examples", "agent-audit-run");
const scratch = mkdtempSync(join(tmpdir(), "testbench-agent-pkg-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
/** A private copy of an example run that a test may change. */
function copyRun(run: string): string {
  const dir = join(scratch, `${run}-${++n}`);
  cpSync(join(RUNS, run), dir, { recursive: true });
  return dir;
}
const readJson = (dir: string, f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
const writeJson = (dir: string, f: string, v: unknown) => writeFileSync(join(dir, f), JSON.stringify(v, null, 2));
const bagOf = (dir: string) => bagFromFiles(readPackageDir(dir));
const fresh = () => makeProject(`AG${++n}`, "Agent project");
/** An example run whose manifest names the given project key, so that it can be imported into a project of its own. */
function runFor(run: string, key: string) {
  const dir = copyRun(run);
  const m = readJson(dir, "manifest.json");
  m.audit.project = key;
  writeJson(dir, "manifest.json", m);
  return dir;
}
const reports = (projectId: number) => (db.prepare("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?").get(projectId) as { n: number }).n;
const rev = (projectId: number, sourceId: string) =>
  db.prepare("SELECT id, title, review_status, latest_rev, applied_rev FROM bug_reports WHERE project_id = ? AND source_id = ?").get(projectId, sourceId) as
    { id: number; title: string; review_status: string; latest_rev: number; applied_rev: number };
const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "audit-package.ts"), ...args], { cwd: ROOT, encoding: "utf8" });
const upload = (p: { id: number }, dir: string) => importAuditPackage(bagOf(dir), { projectId: p.id, source: "upload" });

describe("agent run example: a valid package", () => {
  for (const run of ["run-1", "run-2"]) {
    it(`${run} is already complete and passes the check without changing anything`, () => {
      const r = checkPackageDir(join(RUNS, run));
      assert.deepEqual(r.errors, []);
      assert.equal(r.ok, true);
      assert.equal(r.project, "SHOP");
      assert.equal(r.auditId, "shop-checkout-2026-w45");
      // the manifest on disk is exactly what --write would produce
      const dir = copyRun(run);
      assert.equal(checkPackageDir(dir, { write: true }).filesWritten, true);
      assert.equal(readFileSync(join(dir, "manifest.json"), "utf8"), readFileSync(join(RUNS, run, "manifest.json"), "utf8"));
    });
  }

  it("has no warnings about its ids: they are slugs, the audit id has no time or run id, and every finding has a fingerprint", () => {
    assert.deepEqual(checkPackageDir(join(RUNS, "run-1")).warnings, []);
    assert.deepEqual(checkPackageDir(join(RUNS, "run-2")).warnings, []);
  });

  it("fills in the file list itself, from the folder, and leaves the agent's own audit fields alone", () => {
    const dir = copyRun("run-1");
    writeJson(dir, "manifest.json", { audit: readJson(dir, "manifest.json").audit });
    const r = checkPackageDir(dir, { write: true });
    assert.equal(r.ok, true);
    const m = readJson(dir, "manifest.json");
    assert.deepEqual(m.files.map((f: { path: string }) => f.path), ["evidence/card-field-axe.json", "evidence/discount-total.png"]);
    assert.ok(m.files.every((f: { sha256: string; size: number }) => /^[a-f0-9]{64}$/.test(f.sha256) && f.size > 0));
    assert.deepEqual(m.parts, { bugs: "bugs.json", narrative: "report.md" });
    assert.equal(m.audit.id, "shop-checkout-2026-w45");
  });

  it("imports into the demo project as three proposals with every reference found and every file stored", () => {
    const demo = seedDemo() as { id: number };
    const r = upload(demo, join(RUNS, "run-1"));
    assert.deepEqual(r.counts, { new: 3, unchanged: 0, updated: 0, pending: 0 });
    assert.deepEqual(r.evidence, { ok: 2, problems: 0 });
    assert.deepEqual(r.warnings, []);
    assert.equal(r.unresolvedRefs, 0);
    const mine = listBugReports(demo.id).items.filter((b) => ["cart-discount-total-zero", "checkout-card-field-no-label", "confirmation-email-subject-typo"].includes(b.sourceId));
    assert.equal(mine.length, 3);
    assert.ok(mine.every((b) => b.status === "proposed"));
  });

  it("a zip made by the tool is the same package as the folder", () => {
    const p = fresh();
    const dir = runFor("run-1", p.key);
    assert.equal(checkPackageDir(dir, { write: true }).ok, true);
    const out = join(scratch, "run-1.zip");
    assert.ok(zipPackageDir(dir, out) > 0);
    const names = Object.keys(unzipSync(new Uint8Array(readFileSync(out)))).sort();
    assert.deepEqual(names, ["bugs.json", "evidence/card-field-axe.json", "evidence/discount-total.png", "manifest.json", "report.md"]);
    const viaZip = importAuditPackage(bagFromZip(new Uint8Array(readFileSync(out))), { projectId: p.id, source: "upload" });
    assert.deepEqual(viaZip.counts, { new: 3, unchanged: 0, updated: 0, pending: 0 });
    assert.deepEqual(upload(p, dir).counts, { new: 0, unchanged: 3, updated: 0, pending: 0 });
  });
});

describe("agent run example: an invalid package", () => {
  it("is reported when manifest.json is missing, not an object, or not JSON", () => {
    const dir = copyRun("run-1");
    rmSync(join(dir, "manifest.json"));
    assert.match(checkPackageDir(dir).errors[0], /manifest\.json is missing/);
    writeFileSync(join(dir, "manifest.json"), "[]");
    assert.match(checkPackageDir(dir).errors[0], /must be a JSON object/);
    writeFileSync(join(dir, "manifest.json"), "{ not json");
    assert.match(checkPackageDir(dir).errors[0], /not valid JSON/);
  });

  it("is reported for a repeated sourceId, a missing title, and an unusable audit id", () => {
    const dup = copyRun("run-1");
    const b = readJson(dup, "bugs.json");
    b.bugs[1].sourceId = b.bugs[0].sourceId;
    writeJson(dup, "bugs.json", b);
    assert.match(checkPackageDir(dup).errors.join(" "), /appears twice/);

    const untitled = copyRun("run-1");
    const u = readJson(untitled, "bugs.json");
    delete u.bugs[0].title;
    writeJson(untitled, "bugs.json", u);
    assert.match(checkPackageDir(untitled).errors.join(" "), /bug #1/);

    const badId = copyRun("run-1");
    const m = readJson(badId, "manifest.json");
    m.audit.id = "week 45 / checkout";
    writeJson(badId, "manifest.json", m);
    assert.match(checkPackageDir(badId).errors.join(" "), /audit\.id/);
  });

  it("is reported when a finding points to evidence that is missing, not allowed, or outside the package", () => {
    const missing = copyRun("run-1");
    rmSync(join(missing, "evidence", "discount-total.png"));
    assert.match(checkPackageDir(missing).errors.join(" "), /cart-discount-total-zero: evidence evidence\/discount-total\.png/);

    const svg = copyRun("run-1");
    writeFileSync(join(svg, "evidence", "shot.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    const b = readJson(svg, "bugs.json");
    b.bugs[0].evidence = [{ path: "evidence/shot.svg", label: "svg" }];
    writeJson(svg, "bugs.json", b);
    const r = checkPackageDir(svg);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(" "), /evidence\/shot\.svg/);
    assert.match(r.warnings.join(" "), /evidence\/shot\.svg: this file type is not allowed/);

    const outside = copyRun("run-1");
    const o = readJson(outside, "bugs.json");
    o.bugs[0].evidence = [{ path: "../secrets.txt", label: "x" }];
    writeJson(outside, "bugs.json", o);
    assert.match(checkPackageDir(outside).errors.join(" "), /unsafe path/);
  });

  it("exits with 0 for a valid package and 1 for an invalid one, and writes nothing for a package that fails", () => {
    const ok = cli(join(RUNS, "run-1"));
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /would be accepted/);
    assert.match(ok.stdout, /Audit shop-checkout-2026-w45 for project SHOP: 3 findings/);

    const dir = copyRun("run-1");
    rmSync(join(dir, "evidence", "discount-total.png"));
    const before = readFileSync(join(dir, "manifest.json"), "utf8");
    const bad = cli(dir, "--write");
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /error: cart-discount-total-zero/);
    assert.match(bad.stdout, /would NOT be accepted/);
    assert.equal(readFileSync(join(dir, "manifest.json"), "utf8"), before);

    assert.equal(cli().status, 2);
    assert.equal(cli(join(RUNS, "run-1"), "--zip", join(scratch, "x.zip")).status, 2, "--zip without --write is a mistake");
  });

  it("is refused whole by the import when it names another project, and nothing is stored", () => {
    const p = fresh();
    const dir = runFor("run-1", "NOPE");
    assert.equal(checkPackageDir(dir).ok, true, "the check cannot know which project you import into");
    assert.throws(() => upload(p, dir), /NOPE/);
    assert.equal(reports(p.id), 0);
  });

  it("is caught by the import, file by file, when evidence is changed after the manifest was written", () => {
    const p = fresh();
    const dir = runFor("run-1", p.key);
    writeFileSync(join(dir, "evidence", "card-field-axe.json"), '{"rule":"changed afterwards"}\n');
    const r = upload(p, dir);
    assert.deepEqual(r.evidence, { ok: 1, problems: 1 });
    assert.equal(reports(p.id), 3, "the findings are still imported; the file is shown as a problem");
  });

  it("warns about ids that will not survive a repeat: numbered findings, a run id or a time in the audit id, no fingerprint", () => {
    const dir = copyRun("run-1");
    const b = readJson(dir, "bugs.json");
    b.bugs[0].sourceId = "BUG-001";
    b.bugs[1].sourceId = "2";
    delete b.bugs[2].fingerprint;
    writeJson(dir, "bugs.json", b);
    const m = readJson(dir, "manifest.json");
    m.audit.id = "shop-checkout-run-1234567890";
    m.audit.github = { repo: "o/r", runId: 1234567890 };
    writeJson(dir, "manifest.json", m);
    const w = checkPackageDir(dir).warnings.join("\n");
    assert.match(w, /2 sourceIds are a plain number \(BUG-001, 2\)/);
    assert.match(w, /contains the GitHub run id/);
    assert.match(w, /looks like it contains a time or a counter/);
    assert.match(w, /1 finding has no fingerprint/);
  });
});

describe("agent run example: the same package again", () => {
  it("is nothing new: the second import changes no report, no revision and no file", () => {
    const p = fresh();
    const dir = runFor("run-1", p.key);
    assert.deepEqual(upload(p, dir).counts, { new: 3, unchanged: 0, updated: 0, pending: 0 });
    const revisions = () => (db.prepare("SELECT COUNT(*) AS n FROM bug_revisions WHERE bug_report_id IN (SELECT id FROM bug_reports WHERE project_id = ?)").get(p.id) as { n: number }).n;
    const attachments = () => (db.prepare("SELECT COUNT(*) AS n FROM bug_attachments WHERE bug_report_id IN (SELECT id FROM bug_reports WHERE project_id = ?)").get(p.id) as { n: number }).n;
    const [rv, at] = [revisions(), attachments()];
    assert.deepEqual(upload(p, dir).counts, { new: 0, unchanged: 3, updated: 0, pending: 0 });
    assert.equal(reports(p.id), 3);
    assert.equal(revisions(), rv);
    assert.equal(attachments(), at);
  });

  it("is also nothing new when only the audit's own report or finishing time change: they are not part of any finding", () => {
    const p = fresh();
    const dir = runFor("run-1", p.key);
    upload(p, dir);
    writeFileSync(join(dir, "report.md"), "# A rewritten account of the same audit\n");
    const m = readJson(dir, "manifest.json");
    m.audit.finishedAt = "2026-11-02T10:05:00Z";
    writeJson(dir, "manifest.json", m);
    assert.deepEqual(upload(p, dir).counts, { new: 0, unchanged: 3, updated: 0, pending: 0 });
    assert.equal(reports(p.id), 3);
  });
});

describe("agent run example: a changed report, in a repeated audit", () => {
  it("run 2 updates the finding it changed, keeps the one it did not touch, adds the new one, and duplicates nothing", () => {
    const p = fresh();
    upload(p, runFor("run-1", p.key));
    const before = rev(p.id, "cart-discount-total-zero");
    assert.equal(before.applied_rev, 1);
    const kept = rev(p.id, "checkout-card-field-no-label");

    const r = upload(p, runFor("run-2", p.key));
    assert.deepEqual(r.counts, { new: 1, unchanged: 1, updated: 1, pending: 0 });

    // one report per sourceId: the changed finding is the same report with a second revision, not another row
    assert.equal(reports(p.id), 4, "three from run 1 plus the new one; the fixed typo is not removed");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ? AND source_id = 'cart-discount-total-zero'").get(p.id) as { n: number }).n, 1);
    const after = rev(p.id, "cart-discount-total-zero");
    assert.equal(after.id, before.id);
    assert.equal(after.applied_rev, 2);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM bug_revisions WHERE bug_report_id = ?").get(after.id) as { n: number }).n, 2, "the older version stays as a revision");
    assert.match(String(getBugReport(after.id).description), /more than one product/);

    assert.deepEqual(rev(p.id, "checkout-card-field-no-label"), kept);
    assert.equal(rev(p.id, "confirmation-email-subject-typo").review_status, "proposed");
    assert.equal(rev(p.id, "checkout-coupon-field-clears-on-error").applied_rev, 1);
    assert.equal(listBugReports(p.id).counts.proposed, 4);
  });

  it("run 2 never overwrites a finding a person has already accepted: the new version waits next to it", () => {
    const p = fresh();
    upload(p, runFor("run-1", p.key));
    const id = rev(p.id, "cart-discount-total-zero").id;
    reviewBugReport(id, "accepted", "confirmed by hand");

    const r = upload(p, runFor("run-2", p.key));
    assert.deepEqual(r.counts, { new: 1, unchanged: 1, updated: 0, pending: 1 });
    const now = rev(p.id, "cart-discount-total-zero");
    assert.equal(now.review_status, "accepted");
    assert.equal(now.applied_rev, 1, "the working copy is still the one the person accepted");
    assert.equal(now.latest_rev, 2);
    const d = getBugReport(id);
    assert.doesNotMatch(String(d.description), /more than one product/);
    assert.ok(d.pendingUpdate);
    assert.ok(d.pendingUpdate.changes.some((c) => c.field === "Description"));
    assert.equal(reports(p.id), 4);
  });

  it("the tool's comparison says the same thing before anything is imported", () => {
    const r = checkPackageDir(join(RUNS, "run-2"), { previousDir: join(RUNS, "run-1") });
    assert.equal(r.ok, true);
    assert.deepEqual(r.compared, {
      previousAuditId: "shop-checkout-2026-w45",
      same: ["cart-discount-total-zero", "checkout-card-field-no-label"],
      added: ["checkout-coupon-field-clears-on-error"],
      missing: ["confirmation-email-subject-typo"],
      manual: { same: [], added: [], missing: [] },
    });
    assert.match(r.warnings.join(" "), /Not in this package any more: confirmation-email-subject-typo/);

    const other = copyRun("run-2");
    const m = readJson(other, "manifest.json");
    m.audit.id = "shop-checkout-2026-w46";
    writeJson(other, "manifest.json", m);
    assert.match(checkPackageDir(other, { previousDir: join(RUNS, "run-1") }).warnings.join(" "), /every finding becomes a new report/);

    const wrongProject = copyRun("run-2");
    const w = readJson(wrongProject, "manifest.json");
    w.audit.project = "ELSE";
    writeJson(wrongProject, "manifest.json", w);
    assert.match(checkPackageDir(wrongProject, { previousDir: join(RUNS, "run-1") }).errors.join(" "), /previous package is for project SHOP/);
  });

  it("a renamed sourceId is a new report and the old one stays, which is why the guide forbids renaming", () => {
    const p = fresh();
    const dir = runFor("run-1", p.key);
    upload(p, dir);
    const b = readJson(dir, "bugs.json");
    b.bugs[0].sourceId = "BUG-001";
    writeJson(dir, "bugs.json", b);
    assert.deepEqual(upload(p, dir).counts, { new: 1, unchanged: 2, updated: 0, pending: 0 });
    assert.equal(reports(p.id), 4);
  });
});
