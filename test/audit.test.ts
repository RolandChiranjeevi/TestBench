import "./env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Fastify from "fastify";
import { zipSync } from "fflate";
import { db, UPLOAD_DIR } from "../server/db.ts";
import { makeCase, makeProject } from "./helpers.ts";
import { bagFromFiles, bagFromZip, type FileBag } from "../server/importers/bag.ts";
import { isAuditArtifactName, LIMITS, PackageError, parsePackage, safeRelPath } from "../server/importers/auditpackage.ts";
import {
  applyPendingUpdate, auditReportText, AuditError, deleteAudit, deleteBugReport, getBugReport, ignorePendingUpdate, importAuditPackage, linkAuditsToRun, linkExternalIssue,
  listAudits, listBugReports, listRejectedPackages, markDuplicate, previewAuditDeletion, relinkBugRefs, reviewBugReport, unlinkExternalIssue, updateBugReport,
} from "../server/audits.ts";
import { deleteProject } from "../server/deletion.ts";
import { checkSource } from "../server/autoimport.ts";
import { parseWorkflowList } from "../server/importers/github.ts";
import { registerAuth } from "../server/auth.ts";
import { seedDemo } from "../server/demo.ts";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const PNG = Buffer.from("89504e470d0a1a0a00000000", "hex");

let n = 0;
/** A fresh project per test, so tests never see each other's reports. */
const proj = () => makeProject(`AU${++n}`, `Audit project ${n}`);
const files = () => readdirSync(UPLOAD_DIR).length;
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

interface PkgOpts {
  project: string;
  audit?: Record<string, unknown>;
  bugs?: unknown[];
  files?: Record<string, string | Uint8Array>;
  /** Declared in the manifest but not present in the package. */
  declareOnly?: { path: string; sha256: string; size: number }[];
  /** Paths whose declared sha256 is wrong. */
  badSha?: string[];
  /** Files in the package that the manifest does not list. */
  unlisted?: Record<string, string | Uint8Array>;
  manifest?: Record<string, unknown>;
  narrative?: string;
  prefix?: string;
}
function makePackage(o: PkgOpts): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const declared: { path: string; sha256: string; size: number }[] = [];
  for (const [path, content] of Object.entries(o.files ?? {})) {
    const b = typeof content === "string" ? Buffer.from(content) : content;
    out.set(path, b);
    declared.push({ path, sha256: o.badSha?.includes(path) ? sha("wrong") : sha(b), size: b.length });
  }
  for (const [path, content] of Object.entries(o.unlisted ?? {})) out.set(path, typeof content === "string" ? Buffer.from(content) : content);
  const manifest = {
    format: "testbench-audit-package", version: 1,
    audit: { id: "audit-1", title: "Checkout audit", project: o.project, agent: { name: "test-agent", version: "1.0" }, ...o.audit },
    files: [...declared, ...(o.declareOnly ?? [])], parts: {}, ...o.manifest,
  };
  out.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  out.set("bugs.json", Buffer.from(JSON.stringify({ version: 1, bugs: o.bugs ?? [] })));
  if (o.narrative) out.set("report.md", Buffer.from(o.narrative));
  if (!o.prefix) return out;
  return new Map([...out].map(([k, v]) => [o.prefix + k, v]));
}
const bag = (o: PkgOpts) => bagFromFiles(makePackage(o));
const bug = (id: string, extra: Record<string, unknown> = {}) => ({ sourceId: id, title: `Bug ${id}`, ...extra });
const upload = (p: { id: number }, o: PkgOpts, dryRun = false) => importAuditPackage(bag(o), { projectId: p.id, source: "upload" }, { dryRun });
const bugId = (p: { id: number }, sourceId: string) => (db.prepare("SELECT id FROM bug_reports WHERE project_id = ? AND source_id = ?").get(p.id, sourceId) as { id: number }).id;
const row = (id: number) => db.prepare("SELECT * FROM bug_reports WHERE id = ?").get(id) as Record<string, any>;

describe("audit package: what is imported", () => {
  it("creates every report as proposed, whatever the agent says, and keeps the agent's own review as source information", () => {
    const p = proj();
    const s = upload(p, {
      project: p.key,
      narrative: "# Audit\nAll good.",
      bugs: [bug("B1", { status: "accepted", reviewStatus: "accepted", review_status: "accepted", agentSeverity: "high", toolImpact: { tool: "axe-core", value: "serious", ruleId: "color-contrast" }, agentReview: { status: "confirmed", method: "re-ran twice", notes: "reproduced" }, confidence: 0.8 })],
    });
    assert.deepEqual(s.counts, { new: 1, unchanged: 0, updated: 0, pending: 0 });
    const r = row(bugId(p, "B1"));
    assert.equal(r.review_status, "proposed");
    assert.equal(r.reviewed_at, null);
    assert.equal(JSON.parse(r.agent_review).status, "confirmed");
    // Three separate judgements.
    assert.equal(r.agent_severity, "high");
    assert.equal(r.human_severity, null);
    assert.equal(JSON.parse(r.tool_impact).value, "serious");
    assert.equal(auditReportText(listAudits(p.id)[0].id), "# Audit\nAll good.");
  });

  it("keeps the agent's audit id apart from GitHub's run id", () => {
    const p = proj();
    importAuditPackage(bag({ project: p.key, audit: { id: "agent-audit-77" }, bugs: [bug("B1")] }), { projectId: p.id, source: "github", github: { repo: "o/r", runId: 5551, artifactId: 9 } });
    const a = db.prepare("SELECT * FROM audits WHERE project_id = ?").get(p.id) as Record<string, any>;
    assert.equal(a.agent_audit_id, "agent-audit-77");
    assert.equal(a.github_run_id, 5551);
    assert.equal(a.github_artifact_id, 9);
  });

  it("accepts a zip, and a picked folder (everything one level down)", () => {
    const p = proj();
    const zip = bagFromZip(zipSync(Object.fromEntries(makePackage({ project: p.key, bugs: [bug("Z1")] }))));
    assert.equal(importAuditPackage(zip, { projectId: p.id, source: "upload" }).counts.new, 1);
    const q = proj();
    assert.equal(importAuditPackage(bagFromFiles(makePackage({ project: q.key, bugs: [bug("F1")], prefix: "audit-001/" })), { projectId: q.id, source: "upload" }).counts.new, 1);
  });

  it("stores text as given: markup is data, shown as text by the app", () => {
    const p = proj();
    upload(p, { project: p.key, bugs: [bug("X1", { title: "<script>alert(1)</script> broken", description: "<img src=x onerror=alert(1)>" })] });
    assert.equal(row(bugId(p, "X1")).title, "<script>alert(1)</script> broken");
  });
});

describe("audit package: refusing a package", () => {
  const cases: [string, (project: string) => PkgOpts][] = [
    ["wrong format", (project) => ({ project, manifest: { format: "something-else" } })],
    ["unknown version", (project) => ({ project, manifest: { version: 2 } })],
    ["a bug without title", (project) => ({ project, bugs: [{ sourceId: "B1" }] })],
    ["a severity that is not low/medium/high/critical", (project) => ({ project, bugs: [bug("B1", { agentSeverity: "major" })] })],
    ["the same sourceId twice", (project) => ({ project, bugs: [bug("B1"), bug("B1")] })],
    ["more bugs than allowed", (project) => ({ project, bugs: Array.from({ length: LIMITS.bugs + 1 }, (_, i) => bug(`B${i}`)) })],
    ["a package for another project", () => ({ project: "OTHERPROJECT", bugs: [bug("B1")] })],
    ["an unsafe path in the manifest", (project) => ({ project, bugs: [bug("B1")], declareOnly: [{ path: "../x.png", sha256: sha("x"), size: 1 }] })],
    ["a file listed twice", (project) => ({ project, bugs: [bug("B1")], declareOnly: [{ path: "a.png", sha256: sha("x"), size: 1 }, { path: "a.png", sha256: sha("x"), size: 1 }] })],
  ];
  for (const [name, build] of cases) {
    it(`refuses ${name} and writes nothing`, () => {
      const p = proj();
      const before = { f: files(), bugs: count("SELECT COUNT(*) AS n FROM bug_reports"), audits: count("SELECT COUNT(*) AS n FROM audits") };
      assert.throws(() => upload(p, build(p.key)), PackageError);
      assert.equal(files(), before.f);
      assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports"), before.bugs);
      assert.equal(count("SELECT COUNT(*) AS n FROM audits"), before.audits);
    });
  }

  it("says there is no package when there is no manifest", () => {
    assert.throws(() => parsePackage(bagFromFiles(new Map([["bugs.json", Buffer.from("{}")]]))), /No audit package found/);
  });

  it("checks file count and unpacked size from the table of contents before reading anything", () => {
    let reads = 0;
    const fake = (names: string[], size: (n: string) => number): FileBag => ({ names, size, read: () => (reads++, null) });
    assert.throws(() => parsePackage(fake(Array.from({ length: LIMITS.files + 1 }, (_, i) => `f${i}`), () => 1)), /1001 files/);
    assert.throws(() => parsePackage(fake(["a", "b"], () => 300 * 1024 * 1024)), /unpacked/);
    assert.equal(reads, 0);
  });

  it("refuses a package that came from another project's key, with a message that names both", () => {
    const p = proj();
    assert.throws(() => upload(p, { project: "NOPE", bugs: [bug("B1")] }), /for project "NOPE".*into "AU/);
  });

  it("recognises audit artifacts by name, and only paths that stay inside the package", () => {
    assert.equal(isAuditArtifactName("testbench-audit-2026-11-02"), true);
    assert.equal(isAuditArtifactName("test-results"), false);
    for (const bad of ["../a", "/a", "a/../b", "C:\\a", "a//b", "", "a/./b"]) assert.equal(safeRelPath(bad), null, bad);
    assert.equal(safeRelPath("evidence\\a.png"), "evidence/a.png");
  });
});

describe("audit package: evidence", () => {
  it("stores what is safe and shows what was not, with a reason for each", () => {
    const p = proj();
    const before = files();
    const s = upload(p, {
      project: p.key,
      files: { "evidence/ok.png": PNG, "evidence/script.svg": "<svg onload=alert(1)/>", "evidence/tampered.png": PNG, "evidence/small.png": Buffer.concat([PNG, PNG]) },
      badSha: ["evidence/tampered.png"],
      unlisted: { "evidence/unlisted.png": PNG },
      declareOnly: [{ path: "evidence/gone.png", sha256: sha("g"), size: 5 }],
      bugs: [bug("E1", { evidence: ["evidence/ok.png", "evidence/script.svg", "evidence/tampered.png", "evidence/unlisted.png", "evidence/gone.png", "../escape.png", "/etc/passwd", "C:\\x.png", "evidence/small.png"].map((path) => ({ path, label: path })) })],
    });
    const att = db.prepare("SELECT declared_path, state, reason, stored_name FROM bug_attachments WHERE bug_report_id = ?").all(bugId(p, "E1")) as Record<string, any>[];
    const by = (path: string) => att.find((a) => a.declared_path === path || a.declared_path.endsWith(path))!;
    assert.equal(by("evidence/ok.png").state, "stored");
    assert.match(by("evidence/script.svg").reason, /file type \.svg is not allowed/);
    assert.equal(by("evidence/tampered.png").state, "checksum_mismatch");
    assert.match(by("evidence/unlisted.png").reason, /not listed in the manifest/);
    assert.equal(by("evidence/gone.png").state, "missing");
    assert.match(by("../escape.png").reason, /unsafe path/);
    assert.match(by("/etc/passwd").reason, /unsafe path/);
    assert.match(by("C:\\x.png").reason, /unsafe path/);
    assert.equal(att.filter((a) => a.stored_name).length, 2); // ok.png and small.png
    assert.equal(files(), before + 2);
    assert.ok(s.evidence.problems >= 6);
    // Only files inside the uploads folder were written.
    for (const a of att.filter((x) => x.stored_name)) assert.ok(existsSync(join(UPLOAD_DIR, a.stored_name)));
  });

  it("refuses a file larger than the per-file limit without reading it", () => {
    const p = proj();
    const inner = bag({ project: p.key, declareOnly: [{ path: "evidence/huge.png", sha256: sha("h"), size: 1 }], bugs: [bug("L1", { evidence: [{ path: "evidence/huge.png" }] })] });
    let readHuge = false;
    // The zip's table of contents says this entry is bigger than the limit; the entry itself is never opened.
    const wrapped: FileBag = {
      names: [...inner.names, "evidence/huge.png"],
      size: (n) => (n === "evidence/huge.png" ? LIMITS.fileBytes + 1 : inner.size(n)),
      read: (n) => (n === "evidence/huge.png" ? ((readHuge = true), null) : inner.read(n)),
    };
    importAuditPackage(wrapped, { projectId: p.id, source: "upload" });
    assert.match((db.prepare("SELECT reason FROM bug_attachments WHERE bug_report_id = ?").get(bugId(p, "L1")) as { reason: string }).reason, /larger than 50 MB/);
    assert.equal(readHuge, false);
  });

  it("removes the files it already wrote, and rolls everything back, when the import fails half way", () => {
    const p = proj();
    const before = files();
    db.exec(`CREATE TRIGGER tb_test_fail BEFORE INSERT ON bug_revisions WHEN (SELECT COUNT(*) FROM bug_reports WHERE project_id = ${p.id}) >= 1 BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    try {
      assert.throws(() => upload(p, { project: p.key, files: { "evidence/a.png": PNG, "evidence/b.png": Buffer.concat([PNG, PNG]) }, narrative: "# r", bugs: [bug("F1", { evidence: [{ path: "evidence/a.png" }] }), bug("F2", { evidence: [{ path: "evidence/b.png" }] })] }), /boom/);
    } finally {
      db.exec("DROP TRIGGER tb_test_fail");
    }
    assert.equal(files(), before);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM audits WHERE project_id = ?", p.id), 0);
  });

  it("fills in evidence that was missing the first time when the same report comes again", () => {
    const p = proj();
    const base = { project: p.key, bugs: [bug("M1", { evidence: [{ path: "evidence/late.png" }] })] };
    upload(p, { ...base, declareOnly: [{ path: "evidence/late.png", sha256: sha(PNG), size: PNG.length }] });
    assert.equal((db.prepare("SELECT state FROM bug_attachments WHERE bug_report_id = ?").get(bugId(p, "M1")) as { state: string }).state, "missing");
    const s = upload(p, { ...base, files: { "evidence/late.png": PNG } });
    assert.equal(s.counts.unchanged, 1);
    assert.equal((db.prepare("SELECT state FROM bug_attachments WHERE bug_report_id = ?").get(bugId(p, "M1")) as { state: string }).state, "stored");
  });
});

describe("audit package: a preview changes nothing", () => {
  it("reports the same numbers as the real import and writes nothing", () => {
    const p = proj();
    const o: PkgOpts = { project: p.key, narrative: "# r", files: { "evidence/a.png": PNG }, bugs: [bug("D1", { evidence: [{ path: "evidence/a.png" }], refs: { cases: ["NOPE-1"] } }), bug("D2")] };
    const before = { f: files(), a: count("SELECT COUNT(*) AS n FROM audits") };
    const preview = upload(p, o, true);
    assert.equal(files(), before.f);
    assert.equal(count("SELECT COUNT(*) AS n FROM audits"), before.a);
    assert.equal(preview.dryRun, true);
    const real = upload(p, o);
    assert.deepEqual({ ...real, dryRun: true, auditId: null }, { ...preview, auditId: null });
    assert.equal(real.unresolvedRefs, 1);
  });
});

describe("audit package: the same report, again, and a changed one", () => {
  const v = (title: string, extra: Record<string, unknown> = {}) => [bug("B1", { title, description: `about ${title}`, ...extra })];

  it("is the same report when the package arrives twice, from an upload and from GitHub", () => {
    const p = proj();
    const o = { project: p.key, bugs: v("first"), audit: { id: "same-audit" } };
    assert.equal(upload(p, o).counts.new, 1);
    assert.equal(upload(p, o).counts.unchanged, 1);
    const g = importAuditPackage(bag(o), { projectId: p.id, source: "github", github: { repo: "o/r", runId: 4, artifactId: 8 } });
    assert.equal(g.counts.unchanged, 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_revisions WHERE bug_report_id = ?", bugId(p, "B1")), 1, "no new revision for an unchanged report");
  });

  it("updates an untouched proposal, but never a report a human has reviewed, edited or linked", () => {
    const p = proj();
    const o = (title: string) => ({ project: p.key, bugs: v(title) });
    upload(p, o("one"));
    const id = bugId(p, "B1");
    // untouched proposal: replaced, with the old version kept as a revision
    assert.equal(upload(p, o("two")).counts.updated, 1);
    assert.equal(row(id).title, "two");
    assert.equal(row(id).applied_rev, 2);
    // a human accepts: the next change waits
    reviewBugReport(id, "accepted", "looks real");
    updateBugReport(id, { humanSeverity: "critical" });
    assert.equal(upload(p, o("three")).counts.pending, 1);
    assert.equal(row(id).title, "two");
    assert.equal(row(id).review_status, "accepted");
    assert.equal(row(id).latest_rev, 3);
    const d = getBugReport(id);
    assert.deepEqual(d.pendingUpdate?.changes.map((c) => c.field).sort(), ["Description", "Title"]);
    // the same version again is not a new event
    assert.equal(upload(p, o("three")).counts.unchanged, 1);
    assert.equal(row(id).latest_rev, 3);
    // ignoring keeps the working copy and silences that version only
    ignorePendingUpdate(id);
    assert.equal(getBugReport(id).pendingUpdate, null);
    assert.equal(upload(p, o("three")).counts.unchanged, 1);
    assert.equal(upload(p, o("four")).counts.pending, 1);
    // applying takes the agent's version and leaves the human's decisions alone
    applyPendingUpdate(id);
    assert.equal(row(id).title, "four");
    assert.equal(row(id).review_status, "accepted");
    assert.equal(row(id).human_severity, "critical");
    assert.equal(getBugReport(id).pendingUpdate, null);
  });

  it("treats a human edit, or a link to an external issue, the same as a review", () => {
    const p = proj();
    upload(p, { project: p.key, bugs: [bug("E", { title: "e1" }), bug("L", { title: "l1" })] });
    updateBugReport(bugId(p, "E"), { title: "my wording" });
    linkExternalIssue(bugId(p, "L"), { destination: "jira", url: "https://acme.atlassian.net/browse/SHOP-1" });
    const s = upload(p, { project: p.key, bugs: [bug("E", { title: "e2" }), bug("L", { title: "l2" })] });
    assert.equal(s.counts.pending, 2);
    assert.equal(row(bugId(p, "E")).title, "my wording");
    assert.equal(row(bugId(p, "L")).title, "l1");
  });

  it("applying an update also swaps the evidence that belongs to the new version", () => {
    const p = proj();
    const f = { "evidence/old.png": PNG, "evidence/new.png": Buffer.concat([PNG, PNG]) };
    upload(p, { project: p.key, files: f, bugs: [bug("B1", { evidence: [{ path: "evidence/old.png" }] })] });
    const id = bugId(p, "B1");
    reviewBugReport(id, "accepted");
    upload(p, { project: p.key, files: f, bugs: [bug("B1", { evidence: [{ path: "evidence/new.png" }] })] });
    const d = getBugReport(id);
    assert.equal(d.pendingUpdate?.evidenceAdded, 1);
    assert.equal(d.pendingUpdate?.evidenceRemoved, 1);
    assert.deepEqual(d.attachments.filter((a) => a.active).map((a) => a.declared_path), ["evidence/old.png"]);
    applyPendingUpdate(id);
    assert.deepEqual(getBugReport(id).attachments.map((a) => a.declared_path), ["evidence/new.png"]);
  });

  it("a recurrence in a new audit is a new report, with the similar one pointed out", () => {
    const p = proj();
    upload(p, { project: p.key, audit: { id: "audit-a" }, bugs: [bug("B1", { fingerprint: "checkout-total-zero", title: "Total is 0" })] });
    upload(p, { project: p.key, audit: { id: "audit-b" }, bugs: [bug("B1", { fingerprint: "checkout-total-zero", title: "Total is 0 again" })] });
    const all = listBugReports(p.id).items;
    assert.equal(all.length, 2);
    const newer = getBugReport(all[0].id);
    assert.equal(newer.similar.length, 1);
    markDuplicate(newer.id, newer.similar[0].id, "same bug");
    assert.equal(getBugReport(newer.id).status, "duplicate");
    assert.equal(getBugReport(newer.id).duplicateOf?.id, newer.similar[0].id);
  });
});

describe("audit package: links to requirements, test cases and tests", () => {
  const req = (projectId: number, number: number, title: string) => db.prepare("INSERT INTO requirements (project_id, number, title) VALUES (?, ?, ?) RETURNING id").get(projectId, number, title) as { id: number };

  it("resolves references in the right project only, and shows the rest as unresolved", () => {
    const p = proj();
    const other = proj();
    makeCase(other.id, "belongs to the other project"); // number 1 there
    const c = makeCase(p.id, "Checkout works");
    req(p.id, 3, "Pay by card");
    for (const i of [1, 2]) db.prepare("INSERT INTO automated_tests (project_id, framework, title, full_name) VALUES (?, 'junit', 'dup', ?)").run(p.id, `suite${i} › dup`);
    upload(p, { project: p.key, bugs: [bug("R1", { refs: { cases: [`${p.key}-${c.number}`, `${other.key}-1`, `${p.key}-2`, "nonsense"], requirements: ["REQ-3", "REQ-9"], tests: ["dup", "no such test"] } })] });
    const refs = getBugReport(bugId(p, "R1")).refs;
    const state = (raw: string) => refs.find((r) => r.raw === raw)!;
    assert.equal(state(`${p.key}-1`).state, "resolved");
    assert.equal(state(`${other.key}-1`).state, "wrong_project");
    assert.equal(state(`${p.key}-2`).state, "unresolved");
    assert.equal(state("nonsense").state, "unresolved");
    assert.equal(state("REQ-3").state, "resolved");
    assert.equal(state("REQ-9").state, "unresolved");
    assert.equal(state("dup").state, "ambiguous");
    assert.equal(state("no such test").state, "unresolved");
    assert.equal(listBugReports(p.id).items[0].unresolvedRefs, 6);
  });

  it("does not resolve a number that exists only in another project, until it exists here", () => {
    const q = proj();
    makeCase(proj().id, "elsewhere");
    upload(q, { project: q.key, bugs: [bug("S1", { refs: { cases: [`${q.key}-1`] } })] });
    assert.equal(getBugReport(bugId(q, "S1")).refs[0].state, "unresolved");
    makeCase(q.id, "now it exists");
    assert.equal(relinkBugRefs(q.id), 1);
    assert.equal(getBugReport(bugId(q, "S1")).refs[0].state, "resolved");
  });

  it("shows a reference whose target was deleted later as such, not as if nothing had happened", () => {
    const p = proj();
    const c = makeCase(p.id, "to be deleted");
    upload(p, { project: p.key, bugs: [bug("T1", { refs: { cases: [`${p.key}-${c.number}`] } })] });
    db.prepare("DELETE FROM cases WHERE id = ?").run(c.id);
    assert.equal(getBugReport(bugId(p, "T1")).refs[0].state, "target_deleted");
  });

  it("a report can be linked to several requirements and cases, and needs no run or result", () => {
    const p = proj();
    makeCase(p.id, "a");
    makeCase(p.id, "b");
    req(p.id, 1, "r1");
    req(p.id, 2, "r2");
    upload(p, { project: p.key, bugs: [bug("M1", { refs: { cases: [`${p.key}-1`, `${p.key}-2`], requirements: ["REQ-1", "REQ-2"] } })] });
    const d = getBugReport(bugId(p, "M1"));
    assert.equal(d.refs.filter((r) => r.state === "resolved").length, 4);
    assert.equal(d.runId, null);
    assert.equal(d.audit?.run_state, "none");
  });
});

describe("audit package: link to the GitHub run", () => {
  const run = (projectId: number, externalId: string) =>
    (db.prepare("INSERT INTO runs (project_id, title, kind, source, status, external_id) VALUES (?, 'CI', 'automated', 'github', 'completed', ?) RETURNING id").get(projectId, externalId) as { id: number }).id;

  it("links to a run that is already imported when the match is exact", () => {
    const p = proj();
    const r = run(p.id, "o/r#7");
    const s = upload(p, { project: p.key, audit: { github: { repo: "o/r", runId: 7 } }, bugs: [bug("G1")] });
    assert.equal(s.audit.runState, "linked");
    assert.equal(row(bugId(p, "G1")).run_id, r);
  });

  it("stays unlinked, with a clear status, when the run is not imported yet or none is named — and links when it arrives", () => {
    const p = proj();
    assert.equal(upload(p, { project: p.key, audit: { id: "a-none" }, bugs: [bug("N1")] }).audit.runState, "none");
    assert.equal(upload(p, { project: p.key, audit: { id: "a-wait", github: { repo: "o/r", runId: 8 } }, bugs: [bug("W1")] }).audit.runState, "pending");
    assert.equal(row(bugId(p, "W1")).run_id, null);
    assert.deepEqual(listAudits(p.id).map((a) => a.runState).sort(), ["none", "pending"]);
    const r = run(p.id, "o/r#8");
    assert.equal(linkAuditsToRun(p.id, "o/r#8", r), 1);
    assert.equal(row(bugId(p, "W1")).run_id, r);
    assert.equal(listAudits(p.id).find((a) => a.agentAuditId === "a-wait")?.runState, "linked");
  });

  it("uses the real GitHub run, not the one the manifest claims, and says so", () => {
    const p = proj();
    const real = run(p.id, "o/r#10");
    const s = importAuditPackage(bag({ project: p.key, audit: { github: { repo: "o/r", runId: 99 } }, bugs: [bug("C1")] }), { projectId: p.id, source: "github", github: { repo: "o/r", runId: 10, artifactId: 1 } });
    assert.equal(row(bugId(p, "C1")).run_id, real);
    assert.ok(s.warnings.some((w) => /real run is used/.test(w)));
  });

  it("links to a result only when exactly one result matches a named test", () => {
    const p = proj();
    const r = run(p.id, "o/r#11");
    const t = db.prepare("INSERT INTO automated_tests (project_id, framework, title, full_name) VALUES (?, 'junit', 't', 'suite › t') RETURNING id").get(p.id) as { id: number };
    const res = db.prepare("INSERT INTO results (run_id, automated_test_id, status) VALUES (?, ?, 'failed') RETURNING id").get(r, t.id) as { id: number };
    upload(p, { project: p.key, audit: { github: { repo: "o/r", runId: 11 } }, bugs: [bug("R1", { refs: { tests: ["suite › t"] } })] });
    assert.equal(row(bugId(p, "R1")).result_id, res.id);
    // two results for that test in one run: no guess
    db.prepare("INSERT INTO results (run_id, automated_test_id, status) VALUES (?, ?, 'failed')").run(r, t.id);
    upload(p, { project: p.key, audit: { id: "audit-2", github: { repo: "o/r", runId: 11 } }, bugs: [bug("R2", { refs: { tests: ["suite › t"] } })] });
    assert.equal(row(bugId(p, "R2")).result_id, null);
    assert.equal(row(bugId(p, "R2")).run_id, r);
  });
});

describe("audit package: deleting", () => {
  const evidence = { "evidence/a.png": PNG, "evidence/b.png": Buffer.concat([PNG, PNG]) };

  it("keeps reviewed reports when their audit is deleted: audit_id becomes NULL, origin and evidence stay, nothing is left dangling", () => {
    const p = proj();
    const o: PkgOpts = { project: p.key, narrative: "# report", files: evidence, bugs: [bug("KEEP", { evidence: [{ path: "evidence/a.png", label: "shot" }] }), bug("GONE", { evidence: [{ path: "evidence/b.png" }] })] };
    upload(p, o);
    const keep = bugId(p, "KEEP");
    const gone = bugId(p, "GONE");
    reviewBugReport(keep, "accepted");
    const auditId = listAudits(p.id)[0].id;
    const keptFile = (db.prepare("SELECT stored_name FROM bug_attachments WHERE bug_report_id = ?").get(keep) as { stored_name: string }).stored_name;
    const goneFile = (db.prepare("SELECT stored_name FROM bug_attachments WHERE bug_report_id = ?").get(gone) as { stored_name: string }).stored_name;
    const narrative = (db.prepare("SELECT narrative_stored_name AS n FROM audits WHERE id = ?").get(auditId) as { n: string }).n;

    const preview = previewAuditDeletion(auditId);
    assert.equal(preview.deleted, 1);
    assert.equal(preview.kept, 1);
    assert.deepEqual(deleteAudit(auditId), { deleted: 1, kept: 1 });

    assert.equal(row(gone), undefined);
    assert.ok(!existsSync(join(UPLOAD_DIR, goneFile)), "an untouched proposal's evidence goes with it");
    assert.ok(!existsSync(join(UPLOAD_DIR, narrative)), "the audit's own report goes with the audit");
    const k = getBugReport(keep);
    assert.equal(k.audit, null);
    assert.equal(k.origin.title, "Checkout audit");
    assert.equal(k.origin.agent.name, "test-agent");
    assert.equal(k.originAuditId, "audit-1");
    assert.equal(k.attachments.length, 1);
    assert.ok(existsSync(join(UPLOAD_DIR, keptFile)), "the kept report keeps its evidence");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(count("SELECT COUNT(*) AS n FROM audit_imports WHERE audit_id = ?", auditId), 0);

    // the same package later finds its report again instead of making a second one
    upload(p, o);
    assert.notEqual(row(keep).audit_id, null);
    assert.equal(row(keep).review_status, "accepted");
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ? AND source_id = 'KEEP'", p.id), 1);
  });

  it("also keeps proposals a human has edited or linked, and tells the preview so", () => {
    const p = proj();
    upload(p, { project: p.key, bugs: [bug("E"), bug("L"), bug("U")] });
    updateBugReport(bugId(p, "E"), { description: "mine" });
    linkExternalIssue(bugId(p, "L"), { destination: "linear", url: "https://linear.app/x/issue/ENG-1" });
    const a = listAudits(p.id)[0].id;
    const prev = previewAuditDeletion(a);
    assert.deepEqual([prev.deleted, prev.kept], [1, 2]);
    deleteAudit(a);
    assert.deepEqual((db.prepare("SELECT source_id FROM bug_reports WHERE project_id = ? ORDER BY source_id").all(p.id) as { source_id: string }[]).map((r) => r.source_id), ["E", "L"]);
  });

  it("deleting a run keeps the reports linked to it", () => {
    const p = proj();
    const r = (db.prepare("INSERT INTO runs (project_id, title, kind, source, status, external_id) VALUES (?, 'CI', 'automated', 'github', 'completed', 'o/r#21') RETURNING id").get(p.id) as { id: number }).id;
    upload(p, { project: p.key, audit: { github: { repo: "o/r", runId: 21 } }, bugs: [bug("RUN")] });
    assert.equal(row(bugId(p, "RUN")).run_id, r);
    db.prepare("DELETE FROM runs WHERE id = ?").run(r);
    assert.equal(row(bugId(p, "RUN")).run_id, null);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), 1);
    assert.equal(listAudits(p.id)[0].runState, "deleted");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  });

  it("deleting a project removes its reports and hands back every file to remove", () => {
    const p = proj();
    upload(p, { project: p.key, narrative: "# r", files: evidence, bugs: [bug("P1", { evidence: [{ path: "evidence/a.png" }] })] });
    const stored = [
      (db.prepare("SELECT stored_name FROM bug_attachments WHERE bug_report_id = ?").get(bugId(p, "P1")) as { stored_name: string }).stored_name,
      (db.prepare("SELECT narrative_stored_name AS s FROM audits WHERE project_id = ?").get(p.id) as { s: string }).s,
    ];
    const res = deleteProject(p.id, p.key);
    assert.equal(res.counts.bugReports, 1);
    for (const f of stored) assert.ok(res.files.includes(f), f);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM audits WHERE project_id = ?", p.id), 0);
  });
});

describe("bug reports: review is a person's decision", () => {
  it("lets a person accept, reject and reopen, and never publishes anything", () => {
    const p = proj();
    upload(p, { project: p.key, bugs: [bug("A")] });
    const id = bugId(p, "A");
    reviewBugReport(id, "accepted", "ok");
    assert.equal(getBugReport(id).status, "accepted");
    assert.equal(getBugReport(id).publications.length, 0);
    reviewBugReport(id, "rejected");
    reviewBugReport(id, "proposed");
    assert.equal(getBugReport(id).reviewedAt, null);
    assert.equal(listBugReports(p.id, { status: "proposed" }).items.length, 1);
    assert.equal(listBugReports(p.id).counts.proposed, 1);
  });

  it("refuses nonsense duplicates: itself, another project, or a loop", () => {
    const p = proj();
    const q = proj();
    upload(p, { project: p.key, bugs: [bug("A"), bug("B")] });
    upload(q, { project: q.key, bugs: [bug("X")] });
    const [a, b] = [bugId(p, "A"), bugId(p, "B")];
    assert.throws(() => markDuplicate(a, a), AuditError);
    assert.throws(() => markDuplicate(a, bugId(q, "X")), /another project/);
    markDuplicate(a, b);
    assert.throws(() => markDuplicate(b, a), /already marked/);
    reviewBugReport(a, "proposed");
    assert.equal(row(a).duplicate_of_id, null);
  });

  it("links an existing external issue once per destination, without calling anything", () => {
    const p = proj();
    upload(p, { project: p.key, bugs: [bug("A")] });
    const id = bugId(p, "A");
    assert.throws(() => linkExternalIssue(id, { destination: "jira", url: "javascript:alert(1)" }), /web address/);
    const { id: pubId } = linkExternalIssue(id, { destination: "jira", url: "https://acme.atlassian.net/browse/SHOP-9", externalId: "SHOP-9" });
    assert.throws(() => linkExternalIssue(id, { destination: "jira", url: "https://acme.atlassian.net/browse/SHOP-10" }), /already linked/);
    linkExternalIssue(id, { destination: "linear", url: "https://linear.app/x/issue/ENG-1" });
    assert.equal(getBugReport(id).publications.length, 2);
    unlinkExternalIssue(pubId);
    assert.equal(getBugReport(id).publications.length, 1);
  });

  it("asks for confirmation before deleting an accepted or linked report, and not for an ordinary proposal", () => {
    const p = proj();
    upload(p, { project: p.key, files: { "evidence/a.png": PNG }, bugs: [bug("A", { evidence: [{ path: "evidence/a.png" }] }), bug("B"), bug("C")] });
    reviewBugReport(bugId(p, "B"), "accepted");
    linkExternalIssue(bugId(p, "C"), { destination: "other", url: "https://tracker.example/1" });
    const file = (db.prepare("SELECT stored_name FROM bug_attachments WHERE bug_report_id = ?").get(bugId(p, "A")) as { stored_name: string }).stored_name;
    deleteBugReport(bugId(p, "A"));
    assert.ok(!existsSync(join(UPLOAD_DIR, file)));
    assert.throws(() => deleteBugReport(bugId(p, "B")), /Confirm to delete/);
    assert.throws(() => deleteBugReport(bugId(p, "C")), /Confirm to delete/);
    deleteBugReport(bugId(p, "B"), true);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), 1);
  });
});

describe("audit packages from GitHub", () => {
  const realFetch = globalThis.fetch;
  process.env.GITHUB_TOKEN = "test-token-not-real";
  after(() => { globalThis.fetch = realFetch; });

  interface FakeArtifact { id: number; name: string; size_in_bytes: number; expired: boolean; created_at: string; workflow_run: { id: number; head_branch: string } }
  function fakeGithub(state: { runs: Record<string, unknown>[]; artifacts: FakeArtifact[]; zips: Record<number, Uint8Array>; failing?: Set<number>; runInfo?: Record<number, Record<string, unknown>>; lookupFails?: Set<number> }) {
    const calls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
      let m: RegExpMatchArray | null;
      if (/\/actions\/runs$/.test(url.pathname)) return json({ workflow_runs: state.runs });
      if (/\/actions\/artifacts$/.test(url.pathname)) return json({ artifacts: state.artifacts });
      if ((m = url.pathname.match(/\/actions\/runs\/(\d+)\/artifacts$/))) return json({ artifacts: state.artifacts.filter((a) => a.workflow_run.id === Number(m![1])) });
      if ((m = url.pathname.match(/\/actions\/runs\/(\d+)$/))) {
        const id = Number(m[1]);
        if (state.lookupFails?.has(id)) return new Response("rate limited", { status: 403 });
        // Unless a test says otherwise, every run belongs to workflow 1 (audit.yml) of o/r.
        return json({ workflow_id: 1, path: ".github/workflows/audit.yml", head_repository: { full_name: "o/r" }, ...(state.runs.find((r) => r.id === id) ?? { id }), ...state.runInfo?.[id] });
      }
      if ((m = url.pathname.match(/\/actions\/artifacts\/(\d+)\/zip$/))) {
        const id = Number(m[1]);
        if (state.failing?.has(id)) return new Response("nope", { status: 500 });
        return new Response(state.zips[id] as unknown as BodyInit, { status: 200 });
      }
      return new Response("unexpected " + url.pathname, { status: 404 });
    }) as typeof fetch;
    return calls;
  }
  const run = (id: number, status = "completed") => ({ id, name: "CI", display_title: "t", run_number: id, head_branch: "main", head_sha: "abc1234", event: "push", status, conclusion: status === "completed" ? "success" : null, created_at: "2026-11-01T10:00:00Z", html_url: "https://github.com/o/r/actions/runs/" + id });
  const artifact = (id: number, name: string, runId: number, extra: Partial<FakeArtifact> = {}): FakeArtifact => ({ id, name, size_in_bytes: 1000, expired: false, created_at: "2026-11-01T11:00:00Z", workflow_run: { id: runId, head_branch: "main" }, ...extra });
  const junit = zipSync({ "results.xml": Buffer.from('<testsuites><testsuite name="s" timestamp="2026-11-01T10:00:00"><testcase name="login works" classname="a.B" time="0.1"/></testsuite></testsuites>') });
  const auditZip = (project: string, bugs: unknown[] = [bug("G1")], audit: Record<string, unknown> = {}) => zipSync(Object.fromEntries(makePackage({ project, bugs, audit: { github: { repo: "o/r", runId: 7 }, ...audit } })));
  const source = (projectId: number, branchFilter = "", auditWorkflows = "audit.yml") => {
    db.prepare("INSERT INTO github_sources (project_id, owner, repo, auto_import, auto_since, branch_filter, audit_workflows) VALUES (?, 'o', 'r', 1, '2000-01-01 00:00:00', ?, ?)").run(projectId, branchFilter, auditWorkflows);
    return db.prepare("SELECT * FROM github_sources WHERE project_id = ?").get(projectId) as any;
  };
  const zipCalls = (calls: string[], id: number) => calls.filter((c) => c.endsWith(`/artifacts/${id}/zip`)).length;

  it("fetches a package that appears after its run's test report was imported, once, and does not turn it into a test run", async () => {
    const p = proj();
    const state = { runs: [run(7)], artifacts: [artifact(101, "test-results", 7)], zips: { 101: junit } as Record<number, Uint8Array> };
    const calls = fakeGithub(state);
    const src = source(p.id);
    const first = await checkSource(src);
    assert.equal(first.imported, 1);
    assert.equal(first.audits, 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM runs WHERE project_id = ?", p.id), 1);

    // later: the agent's package becomes available for the same, already imported, run
    state.artifacts.push(artifact(102, "testbench-audit-2026-11-02", 7));
    state.zips[102] = auditZip(p.key);
    const second = await checkSource(src);
    assert.equal(second.audits, 1);
    assert.equal(second.error, null);
    assert.equal(count("SELECT COUNT(*) AS n FROM runs WHERE project_id = ?", p.id), 1, "the package adds no extra run");
    assert.equal(zipCalls(calls, 102), 1);
    assert.equal(zipCalls(calls, 101), 1, "the test artifact is read once, and the audit artifact is not read as a test report");
    const b = row(bugId(p, "G1"));
    assert.equal(b.review_status, "proposed");
    assert.ok(b.run_id, "linked to the existing run");
    assert.equal(listAudits(p.id)[0].source, "github");

    // a third look does not download it again
    await checkSource(src);
    assert.equal(zipCalls(calls, 102), 1);
  });

  it("imports a package that is there before the run is, and links it when the run is imported", async () => {
    const p = proj();
    const state = { runs: [run(7, "in_progress")], artifacts: [artifact(201, "testbench-audit-x", 7)], zips: { 201: auditZip(p.key) } as Record<number, Uint8Array> };
    fakeGithub(state);
    const src = source(p.id);
    const first = await checkSource(src);
    assert.equal(first.audits, 1);
    assert.equal(first.waiting, 1);
    assert.equal(listAudits(p.id)[0].runState, "pending");
    assert.equal(row(bugId(p, "G1")).run_id, null);
    // the run finishes and its test artifact arrives
    state.runs = [run(7)];
    state.artifacts.push(artifact(202, "test-results", 7));
    state.zips[202] = junit;
    const second = await checkSource(src);
    assert.equal(second.imported, 1);
    assert.equal(listAudits(p.id)[0].runState, "linked");
    assert.ok(row(bugId(p, "G1")).run_id);
  });

  it("remembers a package it refused and does not download it again; the reason is shown", async () => {
    const p = proj();
    const state = { runs: [], artifacts: [artifact(301, "testbench-audit-bad", 7)], zips: { 301: zipSync({ "manifest.json": Buffer.from("not json at all") }) } as Record<number, Uint8Array> };
    const calls = fakeGithub(state);
    const src = source(p.id);
    const first = await checkSource(src);
    assert.equal(first.auditsRejected, 1);
    await checkSource(src);
    assert.equal(zipCalls(calls, 301), 1);
    const rejected = listRejectedPackages(p.id) as { name: string; note: string; repo: string }[];
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].note, /No audit package found/);
  });

  it("tries again after a temporary failure, and refuses a package for another project", async () => {
    const p = proj();
    const state = { runs: [], artifacts: [artifact(401, "testbench-audit-t", 7), artifact(402, "testbench-audit-other", 7)], zips: { 401: auditZip(p.key), 402: auditZip("SOMEOTHERKEY", [bug("Z")], { id: "other" }) } as Record<number, Uint8Array>, failing: new Set([401]) };
    const calls = fakeGithub(state);
    const src = source(p.id);
    const first = await checkSource(src);
    assert.match(first.error ?? "", /testbench-audit-t.*500/);
    assert.equal(first.auditsRejected, 1, "the other project's package");
    assert.equal(first.audits, 0);
    state.failing.clear();
    const second = await checkSource(src);
    assert.equal(second.audits, 1);
    assert.equal(zipCalls(calls, 401), 2);
    assert.equal(zipCalls(calls, 402), 1);
  });

  it("ignores packages from before automatic import was switched on, from other branches, and expired ones", async () => {
    const p = proj();
    const state = {
      runs: [],
      artifacts: [
        artifact(501, "testbench-audit-old", 7, { created_at: "1999-01-01T00:00:00Z" }),
        artifact(502, "testbench-audit-dev", 7, { workflow_run: { id: 7, head_branch: "dev" } }),
        artifact(503, "testbench-audit-expired", 7, { expired: true }),
      ],
      zips: { 501: auditZip(p.key), 502: auditZip(p.key), 503: auditZip(p.key) } as Record<number, Uint8Array>,
    };
    const calls = fakeGithub(state);
    const src = source(p.id, "main");
    const r = await checkSource(src);
    assert.deepEqual([r.audits, r.auditsRejected], [0, 0]);
    for (const id of [501, 502, 503]) assert.equal(zipCalls(calls, id), 0, String(id));
  });

  it("treats only artifacts named testbench-audit-* as audit packages, and never reads a package's files as test results", async () => {
    const p = proj();
    const resultsXml = '<testsuites><testsuite name="from-package"><testcase name="must not become a test" classname="x.Y" time="0.1"/></testsuite></testsuites>';
    const withResults = zipSync(Object.fromEntries(makePackage({ project: p.key, bugs: [bug("W1")], audit: { id: "with-results" }, files: { "results/junit.xml": resultsXml }, manifest: { parts: { results: ["results/junit.xml"] } } })));
    const state = {
      runs: [run(7)],
      artifacts: [
        artifact(601, "xtestbench-audit-1", 7), // looks similar, is not an audit package
        artifact(602, "audit-testbench-1", 7),
        artifact(603, "testbench-audit-with-results", 7),
        artifact(604, "test-results", 7),
      ],
      zips: { 601: auditZip(p.key, [bug("N1")], { id: "n1" }), 602: auditZip(p.key, [bug("N2")], { id: "n2" }), 603: withResults, 604: junit } as Record<number, Uint8Array>,
    };
    const calls = fakeGithub(state);
    const r = await checkSource(source(p.id));
    assert.equal(r.audits, 1, "only the artifact with the right name is an audit package");
    assert.deepEqual((db.prepare("SELECT agent_audit_id FROM audits WHERE project_id = ?").all(p.id) as { agent_audit_id: string }[]).map((a) => a.agent_audit_id), ["with-results"]);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), 1);
    // The test import ran for the run, and only test artifacts fed it: one test, not the one inside the package.
    assert.equal(count("SELECT COUNT(*) AS n FROM runs WHERE project_id = ?", p.id), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM results r JOIN runs ru ON ru.id = r.run_id WHERE ru.project_id = ?", p.id), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM automated_tests WHERE project_id = ? AND title LIKE '%must not become%'", p.id), 0);
    assert.equal(zipCalls(calls, 603), 1, "downloaded once, by the audit path only");
  });

  it("leaves no half-imported files when a GitHub import fails, does not remember it as done, and imports it on the next check", async () => {
    const p = proj();
    const pkg = zipSync(Object.fromEntries(makePackage({ project: p.key, narrative: "# r", files: { "evidence/a.png": PNG, "evidence/b.png": Buffer.concat([PNG, PNG]) }, bugs: [bug("F1", { evidence: [{ path: "evidence/a.png" }] }), bug("F2", { evidence: [{ path: "evidence/b.png" }] })] })));
    fakeGithub({ runs: [], artifacts: [artifact(701, "testbench-audit-fail", 7)], zips: { 701: pkg } });
    const src = source(p.id);
    const before = files();
    db.exec(`CREATE TRIGGER tb_test_fail_gh BEFORE INSERT ON bug_revisions WHEN (SELECT COUNT(*) FROM bug_reports WHERE project_id = ${p.id}) >= 1 BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    let failed;
    try {
      failed = await checkSource(src);
    } finally {
      db.exec("DROP TRIGGER tb_test_fail_gh");
    }
    assert.match(failed.error ?? "", /boom/);
    assert.equal(failed.audits, 0);
    assert.equal(files(), before, "the narrative and the evidence written before the failure are gone");
    assert.equal(count("SELECT COUNT(*) AS n FROM github_artifacts WHERE source_id = ?", src.id), 0, "a failure that may be temporary is not remembered");
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), 0);
    const ok = await checkSource(src);
    assert.equal(ok.audits, 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM github_artifacts WHERE source_id = ? AND outcome = 'imported'", src.id), 1);
  });

  it("a package found by one project's source cannot create or link anything in another project", async () => {
    const a = proj();
    const b = proj();
    const runInA = (db.prepare("INSERT INTO runs (project_id, title, kind, source, status, external_id) VALUES (?, 'CI', 'automated', 'github', 'completed', 'o/r#7') RETURNING id").get(a.id) as { id: number }).id;
    // The artifact belongs to repo o/r and names project B's key, but it is found through project A's source.
    fakeGithub({ runs: [], artifacts: [artifact(801, "testbench-audit-b", 7)], zips: { 801: auditZip(b.key, [bug("X1")], { id: "for-b" }) } });
    const r = await checkSource(source(a.id));
    assert.equal(r.auditsRejected, 1);
    assert.equal(r.audits, 0);
    for (const t of ["bug_reports", "audits"]) {
      assert.equal(count(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id IN (?, ?)`, a.id, b.id), 0, t);
    }
    assert.equal(runInA > 0, true);
  });

  describe("workflow allow-list", () => {
    const wf = (file: string, id: number, repo = "o/r") => ({ workflow_id: id, path: `.github/workflows/${file}`, head_repository: { full_name: repo } });
    const setAllowed = (src: { id: number }, list: string) => {
      db.prepare("UPDATE github_sources SET audit_workflows = ? WHERE id = ?").run(list, src.id);
      return db.prepare("SELECT * FROM github_sources WHERE id = ?").get(src.id) as any;
    };
    const auditIds = (p: { id: number }) => (db.prepare("SELECT agent_audit_id FROM audits WHERE project_id = ? ORDER BY agent_audit_id").all(p.id) as { agent_audit_id: string }[]).map((a) => a.agent_audit_id);

    it("takes packages only from the allowed workflow when the repository has several workflow files", async () => {
      const p = proj();
      const state = {
        runs: [], runInfo: { 7: wf("audit.yml", 11), 8: wf("e2e.yml", 12), 9: wf("nightly.yml", 13) },
        artifacts: [artifact(1001, "testbench-audit-a", 7), artifact(1002, "testbench-audit-b", 8), artifact(1003, "testbench-audit-c", 9)],
        zips: { 1001: auditZip(p.key, [bug("A1")], { id: "from-audit" }), 1002: auditZip(p.key, [bug("B1")], { id: "from-e2e" }), 1003: auditZip(p.key, [bug("C1")], { id: "from-nightly" }) } as Record<number, Uint8Array>,
      };
      const calls = fakeGithub(state);
      const r = await checkSource(source(p.id, "", "audit.yml"));
      assert.deepEqual([r.audits, r.auditsBlocked, r.auditsRejected, r.error], [1, 2, 0, null]);
      assert.deepEqual(auditIds(p), ["from-audit"]);
      assert.equal(zipCalls(calls, 1001), 1);
      assert.equal(zipCalls(calls, 1002) + zipCalls(calls, 1003), 0, "a package from another workflow is never even downloaded");
    });

    it("accepts a workflow by numeric id, by file name in any case, or with its path, and several at once", async () => {
      const p = proj();
      const state = {
        runs: [], runInfo: { 7: wf("audit.yml", 11), 8: wf("e2e.yml", 12), 9: wf("nightly.yml", 13) },
        artifacts: [artifact(1101, "testbench-audit-a", 7), artifact(1102, "testbench-audit-b", 8), artifact(1103, "testbench-audit-c", 9)],
        zips: { 1101: auditZip(p.key, [bug("A1")], { id: "a" }), 1102: auditZip(p.key, [bug("B1")], { id: "b" }), 1103: auditZip(p.key, [bug("C1")], { id: "c" }) } as Record<number, Uint8Array>,
      };
      fakeGithub(state);
      const r = await checkSource(source(p.id, "", "11, .github/workflows/E2E.YML"));
      assert.deepEqual([r.audits, r.auditsBlocked], [2, 1]);
      assert.deepEqual(auditIds(p), ["a", "b"]);
    });

    it("leaves a package from the wrong workflow alone even with the right name, without remembering it, and imports it once that workflow is allowed", async () => {
      const p = proj();
      const state = { runs: [], runInfo: { 7: wf("e2e.yml", 12) }, artifacts: [artifact(1201, "testbench-audit-x", 7)], zips: { 1201: auditZip(p.key) } as Record<number, Uint8Array> };
      const calls = fakeGithub(state);
      let src = source(p.id, "", "audit.yml");
      const first = await checkSource(src);
      assert.deepEqual([first.audits, first.auditsBlocked, first.error], [0, 1, null]);
      assert.equal(zipCalls(calls, 1201), 0);
      assert.equal(count("SELECT COUNT(*) AS n FROM github_artifacts WHERE source_id = ?", src.id), 0, "blocked is not remembered as done");
      assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), 0);
      src = setAllowed(src, "audit.yml, e2e.yml");
      assert.equal((await checkSource(src)).audits, 1);
      assert.equal(count("SELECT COUNT(*) AS n FROM github_artifacts WHERE source_id = ? AND outcome = 'imported'", src.id), 1);
    });

    it("does not read a blocked workflow's package as a test report either", async () => {
      const p = proj();
      const withResults = zipSync(Object.fromEntries(makePackage({ project: p.key, bugs: [bug("W1")], files: { "results/junit.xml": '<testsuites><testsuite name="x"><testcase name="must not become a test" classname="x.Y" time="0.1"/></testsuite></testsuites>' }, manifest: { parts: { results: ["results/junit.xml"] } } })));
      const state = {
        runs: [run(8)], runInfo: { 8: wf("e2e.yml", 12) },
        artifacts: [artifact(1301, "testbench-audit-other", 8), artifact(1302, "test-results", 8)],
        zips: { 1301: withResults, 1302: junit } as Record<number, Uint8Array>,
      };
      const calls = fakeGithub(state);
      const r = await checkSource(source(p.id, "", "audit.yml"));
      assert.deepEqual([r.imported, r.audits, r.auditsBlocked], [1, 0, 1]);
      assert.equal(count("SELECT COUNT(*) AS n FROM results r JOIN runs ru ON ru.id = r.run_id WHERE ru.project_id = ?", p.id), 1, "only the test artifact became test results");
      assert.equal(count("SELECT COUNT(*) AS n FROM automated_tests WHERE project_id = ? AND title LIKE '%must not become%'", p.id), 0);
      assert.equal(zipCalls(calls, 1301), 0);
    });

    it("does not treat other artifacts with audit in the name as packages, even from the allowed workflow", async () => {
      const p = proj();
      const state = {
        runs: [], artifacts: [artifact(1401, "audit-report", 7), artifact(1402, "testbench-audit", 7), artifact(1403, "my-testbench-audit-1", 7), artifact(1404, "Audit-results", 7)],
        zips: { 1401: auditZip(p.key, [bug("N1")], { id: "n1" }), 1402: auditZip(p.key, [bug("N2")], { id: "n2" }), 1403: auditZip(p.key, [bug("N3")], { id: "n3" }), 1404: auditZip(p.key, [bug("N4")], { id: "n4" }) } as Record<number, Uint8Array>,
      };
      const calls = fakeGithub(state);
      const r = await checkSource(source(p.id));
      assert.deepEqual([r.audits, r.auditsBlocked, r.auditsRejected, r.error], [0, 0, 0, null]);
      assert.equal(auditIds(p).length, 0);
      for (const id of [1401, 1402, 1403, 1404]) assert.equal(zipCalls(calls, id), 0, String(id));
    });

    it("gives a clear configuration error and imports nothing when no workflow is allowed", async () => {
      const p = proj();
      const state = { runs: [], artifacts: [artifact(1501, "testbench-audit-x", 7)], zips: { 1501: auditZip(p.key) } as Record<number, Uint8Array> };
      const calls = fakeGithub(state);
      const before = files();
      for (const empty of ["", "   ", " , ,"]) {
        const src = source(p.id, "", empty);
        const r = await checkSource(src);
        assert.match(r.error ?? "", /no workflow is allowed to deliver audit packages/, JSON.stringify(empty));
        assert.deepEqual([r.audits, r.auditsBlocked], [0, 1]);
        assert.match((db.prepare("SELECT last_error FROM github_sources WHERE id = ?").get(src.id) as { last_error: string }).last_error, /no workflow is allowed/, "the error is kept on the source for the page");
        assert.equal(count("SELECT COUNT(*) AS n FROM github_artifacts WHERE source_id = ?", src.id), 0);
        db.prepare("DELETE FROM github_sources WHERE id = ?").run(src.id);
      }
      assert.equal(zipCalls(calls, 1501), 0);
      assert.equal(calls.filter((c) => /\/actions\/runs\/\d+$/.test(c)).length, 0, "not even the run is looked up");
      assert.equal(files(), before);
      assert.equal(count("SELECT COUNT(*) AS n FROM audits WHERE project_id = ?", p.id), 0);
    });

    it("stays quiet about an empty list for a repository that has no audit packages", async () => {
      const p = proj();
      fakeGithub({ runs: [], artifacts: [artifact(1601, "test-results", 7)], zips: {} });
      const r = await checkSource(source(p.id, "", ""));
      assert.deepEqual([r.error, r.auditsBlocked], [null, 0]);
    });

    it("reports a malformed workflow entry instead of treating it as no restriction", async () => {
      const p = proj();
      const state = { runs: [], artifacts: [artifact(1701, "testbench-audit-x", 7)], zips: { 1701: auditZip(p.key) } as Record<number, Uint8Array> };
      const calls = fakeGithub(state);
      const r = await checkSource(source(p.id, "", "audit"));
      assert.match(r.error ?? "", /"audit" is not a workflow id or a workflow file name/);
      assert.equal(r.audits, 0);
      assert.equal(zipCalls(calls, 1701), 0);
    });

    it("rejects a package for another project from the allowed workflow, whole, and writes nothing", async () => {
      const a = proj();
      const b = proj();
      const pkg = zipSync(Object.fromEntries(makePackage({ project: b.key, narrative: "# r", files: { "evidence/a.png": PNG }, bugs: [bug("X1", { evidence: [{ path: "evidence/a.png" }] }), bug("X2")], audit: { id: "for-b" } })));
      fakeGithub({ runs: [], artifacts: [artifact(1801, "testbench-audit-b", 7)], zips: { 1801: pkg } });
      const before = files();
      const src = source(a.id);
      const r = await checkSource(src);
      assert.deepEqual([r.audits, r.auditsRejected], [0, 1]);
      assert.equal(files(), before);
      for (const t of ["bug_reports", "audits"]) assert.equal(count(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id IN (?, ?)`, a.id, b.id), 0, t);
      assert.equal(count("SELECT COUNT(*) AS n FROM bug_attachments WHERE bug_report_id IN (SELECT id FROM bug_reports WHERE project_id IN (?, ?))", a.id, b.id), 0);
      assert.match((db.prepare("SELECT note FROM github_artifacts WHERE source_id = ?").get(src.id) as { note: string }).note, /for project/);
    });

    it("does not trust a run from a fork, nor one whose workflow cannot be looked up, and tries the latter again", async () => {
      const p = proj();
      const state = {
        runs: [], runInfo: { 7: wf("audit.yml", 11, "someone/r"), 8: wf("audit.yml", 11) },
        artifacts: [artifact(1901, "testbench-audit-fork", 7), artifact(1902, "testbench-audit-ok", 8)],
        zips: { 1901: auditZip(p.key, [bug("F1")], { id: "fork" }), 1902: auditZip(p.key, [bug("O1")], { id: "ok" }) } as Record<number, Uint8Array>,
        lookupFails: new Set([8]),
      };
      const calls = fakeGithub(state);
      const src = source(p.id);
      const first = await checkSource(src);
      assert.match(first.error ?? "", /could not look up its workflow run/);
      assert.deepEqual([first.audits, first.auditsBlocked], [0, 2]);
      assert.equal(zipCalls(calls, 1901) + zipCalls(calls, 1902), 0, "nothing is downloaded when its origin is unknown or foreign");
      state.lookupFails.clear();
      const second = await checkSource(src);
      assert.deepEqual([second.audits, second.auditsBlocked], [1, 1]);
      assert.deepEqual(auditIds(p), ["ok"]);
    });

    it("leaves no files and no 'done' mark when validation or the download fails", async () => {
      const p = proj();
      const invalid = zipSync(Object.fromEntries(makePackage({ project: p.key, narrative: "# r", files: { "evidence/a.png": PNG }, bugs: [bug("V1", { evidence: [{ path: "evidence/a.png" }] }), bug("V1")], audit: { id: "invalid" } })));
      const state = {
        runs: [], artifacts: [artifact(2001, "testbench-audit-bad", 7), artifact(2002, "testbench-audit-down", 7)],
        zips: { 2001: invalid, 2002: auditZip(p.key, [bug("D1")], { id: "down" }) } as Record<number, Uint8Array>, failing: new Set([2002]),
      };
      fakeGithub(state);
      const before = files();
      const src = source(p.id);
      const r = await checkSource(src);
      assert.deepEqual([r.audits, r.auditsRejected], [0, 1], "the invalid package is refused");
      assert.match(r.error ?? "", /testbench-audit-down.*500/, "the failed download");
      assert.equal(files(), before);
      assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), 0);
      assert.equal(count("SELECT COUNT(*) AS n FROM audits WHERE project_id = ?", p.id), 0);
      assert.equal(count("SELECT COUNT(*) AS n FROM github_artifacts WHERE source_id = ? AND outcome = 'imported'", src.id), 0, "neither is marked as imported");
      assert.equal(count("SELECT COUNT(*) AS n FROM github_artifacts WHERE source_id = ? AND artifact_id = 2002", src.id), 0, "the failed download is tried again");
    });

    it("parses the workflow list, drops duplicates and refuses entries that are neither an id nor a yml file name", () => {
      assert.deepEqual(parseWorkflowList("audit.yml, 123\n.github/workflows/e2e.yaml audit.yml"), ["audit.yml", "123", "e2e.yaml"]);
      assert.deepEqual(parseWorkflowList(""), []);
      for (const bad of ["audit", "../x.yml", "a/b.yml", "audit.yml;x", "*"]) assert.throws(() => parseWorkflowList(bad), /not a workflow id or a workflow file name/, bad);
    });
  });
});

describe("isolation between projects", () => {
  it("refuses a package for another project, in both directions, and writes nothing", () => {
    const a = proj();
    const b = proj();
    const before = { f: files(), bugs: count("SELECT COUNT(*) AS n FROM bug_reports"), audits: count("SELECT COUNT(*) AS n FROM audits") };
    assert.throws(() => upload(b, { project: a.key, bugs: [bug("X")] }), /for project "AU\d+", but it is being imported into "AU\d+"/);
    assert.throws(() => upload(a, { project: b.key, bugs: [bug("X")] }), PackageError);
    assert.deepEqual({ f: files(), bugs: count("SELECT COUNT(*) AS n FROM bug_reports"), audits: count("SELECT COUNT(*) AS n FROM audits") }, before);
  });

  it("keeps the same audit id and bug id in two projects as two separate reports that never touch each other", () => {
    const a = proj();
    const b = proj();
    upload(a, { project: a.key, audit: { id: "shared-id" }, bugs: [bug("B1", { title: "in A" })] });
    upload(b, { project: b.key, audit: { id: "shared-id" }, bugs: [bug("B1", { title: "in B" })] });
    reviewBugReport(bugId(a, "B1"), "accepted");
    upload(b, { project: b.key, audit: { id: "shared-id" }, bugs: [bug("B1", { title: "in B, changed" })] });
    assert.equal(row(bugId(a, "B1")).title, "in A");
    assert.equal(row(bugId(a, "B1")).review_status, "accepted");
    assert.equal(row(bugId(b, "B1")).title, "in B, changed");
    assert.equal(row(bugId(b, "B1")).review_status, "proposed");
    assert.notEqual(bugId(a, "B1"), bugId(b, "B1"));
    assert.equal(listBugReports(a.id).items.length, 1);
    assert.equal(listBugReports(b.id).items.length, 1);
  });

  it("does not link to another project's run, and linking a run in one project leaves the other project's audit alone", () => {
    const a = proj();
    const b = proj();
    const runA = (db.prepare("INSERT INTO runs (project_id, title, kind, source, status, external_id) VALUES (?, 'CI', 'automated', 'github', 'completed', 'o/r#7') RETURNING id").get(a.id) as { id: number }).id;
    // B names the same GitHub run, which exists only in A.
    assert.equal(upload(b, { project: b.key, audit: { github: { repo: "o/r", runId: 7 } }, bugs: [bug("B1")] }).audit.runState, "pending");
    assert.equal(row(bugId(b, "B1")).run_id, null);
    upload(a, { project: a.key, audit: { github: { repo: "o/r", runId: 7 } }, bugs: [bug("A1")] });
    assert.equal(row(bugId(a, "A1")).run_id, runA);
    assert.equal(linkAuditsToRun(a.id, "o/r#7", runA), 0);
    assert.equal(row(bugId(b, "B1")).run_id, null);
    assert.equal(listAudits(b.id)[0].runState, "pending");
  });

  it("looks up requirements, cases and tests only in the project of the package", () => {
    const a = proj();
    const b = proj();
    makeCase(a.id, "A's case");
    db.prepare("INSERT INTO requirements (project_id, number, title) VALUES (?, 1, 'A requirement')").run(a.id);
    db.prepare("INSERT INTO automated_tests (project_id, framework, title, full_name) VALUES (?, 'junit', 'only in A', 'only in A')").run(a.id);
    upload(b, { project: b.key, bugs: [bug("B1", { refs: { cases: [`${b.key}-1`, `${a.key}-1`], requirements: ["REQ-1"], tests: ["only in A"] } })] });
    assert.deepEqual(getBugReport(bugId(b, "B1")).refs.map((r) => r.state), ["unresolved", "unresolved", "wrong_project", "unresolved"]);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_refs WHERE bug_report_id = ? AND state = 'resolved'", bugId(b, "B1")), 0);
  });
});

describe("re-importing against a report a person has already dealt with", () => {
  const evidence = { "evidence/old.png": PNG, "evidence/new.png": Buffer.concat([PNG, PNG]) };
  const v1 = (project: string): PkgOpts => ({ project, files: evidence, bugs: [bug("B1", { title: "v1 title", description: "v1 text", agentSeverity: "low", evidence: [{ path: "evidence/old.png", label: "old" }] })] });
  const v2 = (project: string): PkgOpts => ({ project, files: evidence, bugs: [bug("B1", { title: "v2 title", description: "v2 text", agentSeverity: "critical", evidence: [{ path: "evidence/new.png", label: "new" }] })] });

  const humanActions: [string, (id: number) => void, Record<string, unknown>][] = [
    ["accepted", (id) => reviewBugReport(id, "accepted", "confirmed by me"), { review_status: "accepted", review_note: "confirmed by me" }],
    ["edited", (id) => updateBugReport(id, { title: "my own wording", humanSeverity: "high" }), { title: "my own wording", human_severity: "high" }],
    ["linked to an external issue", (id) => linkExternalIssue(id, { destination: "jira", url: "https://acme.atlassian.net/browse/SHOP-5", externalId: "SHOP-5" }), {}],
  ];
  for (const [name, act, expectFields] of humanActions) {
    it(`does not overwrite a report that is ${name}: the new version waits, its origin and evidence stay`, () => {
      const p = proj();
      upload(p, v1(p.key));
      const id = bugId(p, "B1");
      act(id);
      const before = getBugReport(id);
      const originBefore = JSON.stringify(row(id).origin);
      const oldFile = before.attachments.find((a) => a.declared_path === "evidence/old.png")!.stored_name!;

      const s = upload(p, v2(p.key));
      assert.deepEqual(s.counts, { new: 0, unchanged: 0, updated: 0, pending: 1 });

      const after = getBugReport(id);
      // nothing the person or the first import decided was touched
      for (const f of ["title", "description", "status", "reviewNote", "editedAt", "reviewedAt"] as const) assert.equal(after[f], before[f], f);
      assert.deepEqual(after.severity, before.severity);
      assert.deepEqual(after.publications, before.publications);
      for (const [col, v] of Object.entries(expectFields)) assert.equal(row(id)[col], v, col);
      assert.equal(JSON.stringify(row(id).origin), originBefore, "where it came from is unchanged");
      assert.equal(after.originAuditId, before.originAuditId);
      // the current evidence is still active and its file is still there
      const active = after.attachments.filter((a) => a.active);
      assert.deepEqual(active.map((a) => a.declared_path), ["evidence/old.png"]);
      assert.ok(existsSync(join(UPLOAD_DIR, oldFile)));
      // the new version is waiting, with its own evidence staged but not active
      assert.equal(after.pendingUpdate?.rev, 2);
      assert.ok(after.pendingUpdate?.changes.some((c) => c.field === "Title" && c.to === "v2 title"));
      assert.deepEqual([after.pendingUpdate?.evidenceAdded, after.pendingUpdate?.evidenceRemoved], [1, 1]);
      assert.equal(after.attachments.filter((a) => !a.active).length, 1);
      assert.equal(after.revisions.length, 2);

      // "keep mine" drops the staged files and keeps everything else
      const stagedFile = after.attachments.find((a) => !a.active)!.stored_name!;
      ignorePendingUpdate(id);
      assert.ok(!existsSync(join(UPLOAD_DIR, stagedFile)));
      assert.ok(existsSync(join(UPLOAD_DIR, oldFile)));
      assert.equal(getBugReport(id).pendingUpdate, null);
      assert.equal(row(id).title, before.title);
    });
  }
});

describe("the demo and the example package", () => {
  it("the demo project has proposals from an agent, with one reference left unresolved on purpose", () => {
    const demo = seedDemo() as { id: number };
    const list = listBugReports(demo.id);
    assert.equal(list.counts.proposed, 3);
    const refs = getBugReport(list.items.find((b) => b.sourceId === "BUG-002")!.id).refs;
    assert.deepEqual(refs.map((r) => [r.raw, r.state]), [["REQ-3", "resolved"], ["SHOP-99", "unresolved"]]);
    assert.equal(getBugReport(list.items.find((b) => b.sourceId === "BUG-001")!.id).refs.every((r) => r.state === "resolved"), true);
  });

  it("examples/audit-package imports without any problem, and the same package zipped is the same audit", () => {
    const demo = seedDemo() as { id: number };
    const root = join(import.meta.dirname, "..", "examples", "audit-package");
    const names = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => statSync(join(root, f)).isFile());
    assert.ok(names.includes("manifest.json") && names.includes("bugs.json") && names.includes("report.md"));
    const fromDisk = bagFromFiles(new Map(names.map((f) => [`audit-package/${f}`, readFileSync(join(root, f))])));
    const first = importAuditPackage(fromDisk, { projectId: demo.id, source: "upload" });
    assert.deepEqual(first.counts, { new: 3, unchanged: 0, updated: 0, pending: 0 });
    assert.deepEqual(first.evidence, { ok: 2, problems: 0 });
    assert.deepEqual(first.warnings, []);
    assert.equal(first.unresolvedRefs, 1, "SHOP-99 on purpose");
    const zipped = bagFromZip(zipSync(Object.fromEntries(names.map((f) => [`audit-package/${f}`, readFileSync(join(root, f))]))));
    assert.deepEqual(importAuditPackage(zipped, { projectId: demo.id, source: "upload" }).counts, { new: 0, unchanged: 3, updated: 0, pending: 0 });
  });
});

describe("the sign-in gate covers the new routes", () => {
  it("answers 401 to every audit and bug report route without a session", async () => {
    const app = Fastify();
    registerAuth(app, { password: "correct horse battery", sessionDays: 7 });
    const routes = [["GET", "/api/projects/1/bug-reports"], ["POST", "/api/projects/1/audit-import"], ["POST", "/api/bug-reports/1/review"], ["GET", "/api/audits/1/report"], ["DELETE", "/api/audits/1"], ["GET", "/api/projects/1/destination"], ["PUT", "/api/projects/1/destination"], ["POST", "/api/projects/1/destination/teams"], ["POST", "/api/bug-reports/1/publish-preview"], ["POST", "/api/bug-reports/1/publish"], ["POST", "/api/bug-publications/1/check"], ["POST", "/api/bug-publications/1/retry-attachments"]] as const;
    for (const [m, u] of routes) app.route({ method: m, url: u, handler: async () => ({ leaked: true }) });
    for (const [m, u] of routes) {
      const res = await app.inject({ method: m, url: u });
      assert.equal(res.statusCode, 401, `${m} ${u}`);
    }
    await app.close();
  });
});
