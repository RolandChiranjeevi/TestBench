import "./env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { db, UPLOAD_DIR } from "../server/db.ts";
import { makeProject } from "./helpers.ts";
import { bagFromFiles } from "../server/importers/bag.ts";
import { AuditError, deleteAudit, getBugReport, importAuditPackage, linkExternalIssue, listBugReports, reviewBugReport, updateBugReport } from "../server/audits.ts";

const PNG = Buffer.from("89504e470d0a1a0a00000000", "hex");
let n = 0;
const proj = () => makeProject(`MF${++n}`, `Missing findings ${n}`);
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

/** One run of the audit "w45": a package with the given reports (id -> title) and, optionally, evidence for some of them. */
function run(p: { id: number; key: string }, reports: Record<string, string>, evidence: Record<string, Buffer> = {}) {
  const files = new Map<string, Uint8Array>();
  const bugs = Object.entries(reports).map(([sourceId, title]) => {
    const ev = evidence[sourceId];
    if (ev) files.set(`evidence/${sourceId}.png`, ev);
    return { sourceId, title, description: `About ${sourceId}`, evidence: ev ? [{ path: `evidence/${sourceId}.png`, label: "shot" }] : [] };
  });
  files.set("manifest.json", Buffer.from(JSON.stringify({
    format: "testbench-audit-package", version: 1, audit: { id: "w45", title: "Checkout audit", project: p.key, agent: { name: "agent", version: "1" } },
    files: [...files].map(([path, b]) => ({ path, sha256: createHash("sha256").update(b).digest("hex"), size: b.length })), parts: {},
  })));
  files.set("bugs.json", Buffer.from(JSON.stringify({ version: 1, bugs })));
  return importAuditPackage(bagFromFiles(files), { projectId: p.id, source: "upload" });
}
const id = (p: { id: number }, sourceId: string) => (db.prepare("SELECT id FROM bug_reports WHERE project_id = ? AND source_id = ?").get(p.id, sourceId) as { id: number }).id;
const standing = (p: { id: number }, sourceId: string) => getBugReport(id(p, sourceId)).latestRun;
const listed = (p: { id: number }, presence?: string, status?: string) => listBugReports(p.id, { presence, status });
const files = () => readdirSync(UPLOAD_DIR).length;

describe("reports that are missing from the latest audit run", () => {
  it("a report that is in the latest run is still present, once there is an earlier run to compare with", () => {
    const p = proj();
    run(p, { a: "A", b: "B" });
    assert.equal(standing(p, "a").presence, "no_later_run", "one run only: nothing to compare with yet");
    assert.match(standing(p, "a").reason, /one run so far/);
    run(p, { a: "A", b: "B" });
    for (const s of ["a", "b"]) {
      const r = standing(p, s);
      assert.deepEqual([r.presence, r.runs, r.latest?.run, r.lastSeen?.run], ["present", 2, 2, 2], s);
    }
    assert.deepEqual(listed(p).presenceCounts, { present: 2, missing: 0, no_later_run: 0 });
  });

  it("a report that disappears is shown as missing with the run and date it was last seen, and is otherwise left exactly as it was", () => {
    const p = proj();
    run(p, { a: "A", b: "B", c: "C" });
    run(p, { a: "A", b: "B" });
    const r = standing(p, "c");
    assert.deepEqual([r.presence, r.runs, r.lastSeen?.run, r.latest?.run], ["missing", 2, 1, 2]);
    assert.ok(r.lastSeen?.importedAt, "the date of the last sighting");
    assert.equal(r.lastSeen?.source, "upload");
    assert.equal(r.lastSeen?.recorded, true);
    const d = getBugReport(id(p, "c"));
    assert.deepEqual([d.status, d.title, d.editedAt, d.reviewedAt], ["proposed", "C", null, null], "not closed, archived, rejected or edited");
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), 3, "not removed");
    assert.deepEqual(listed(p, "missing").items.map((i) => i.sourceId), ["c"]);
    assert.deepEqual(listed(p).presenceCounts, { present: 2, missing: 1, no_later_run: 0 });
  });

  it("a report that comes back is present again, as the same report", () => {
    const p = proj();
    run(p, { a: "A", c: "C" });
    run(p, { a: "A" });
    assert.equal(standing(p, "c").presence, "missing");
    const before = id(p, "c");
    run(p, { a: "A", c: "C" });
    const r = standing(p, "c");
    assert.deepEqual([r.presence, r.lastSeen?.run, r.latest?.run], ["present", 3, 3]);
    assert.equal(id(p, "c"), before, "no duplicate");
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ? AND source_id = 'c'", p.id), 1);
    assert.deepEqual(db.prepare("SELECT audit_import_id FROM bug_sightings WHERE bug_report_id = ? ORDER BY 1").all(before).length, 2, "seen in the first and the third run, not the second");
  });

  it("keeps a missing report's external link, review and publication untouched", () => {
    const p = proj();
    run(p, { a: "A", c: "C" });
    run(p, { a: "A", c: "C" });
    const c = id(p, "c");
    reviewBugReport(c, "accepted", "real");
    linkExternalIssue(c, { destination: "linear", url: "https://linear.app/acme/issue/ENG-5", externalId: "ENG-5" });
    db.prepare("INSERT INTO bug_publications (bug_report_id, destination, destination_ref, mode, state, idempotency_key, external_id, external_url, completed_at) VALUES (?, 'linear', 'team-1', 'created', 'sent', 'k1', 'ENG-9', 'https://linear.app/acme/issue/ENG-9', datetime('now'))").run(c);
    const snapshot = () => ({
      row: db.prepare("SELECT * FROM bug_reports WHERE id = ?").get(c),
      pubs: db.prepare("SELECT * FROM bug_publications WHERE bug_report_id = ? ORDER BY id").all(c),
      revs: db.prepare("SELECT * FROM bug_revisions WHERE bug_report_id = ? ORDER BY rev").all(c),
      atts: db.prepare("SELECT * FROM bug_attachments WHERE bug_report_id = ? ORDER BY id").all(c),
    });
    const before = snapshot();
    run(p, { a: "A" });
    assert.equal(standing(p, "c").presence, "missing");
    assert.deepEqual(snapshot(), before, "status, links, publications, revisions and evidence are all as they were");
    assert.equal(getBugReport(c).publications.length, 2);
    assert.equal(getBugReport(c).status, "accepted");
    assert.equal(listed(p, "missing", "accepted").items.length, 1, "it can still be found, filtered by presence and by status");
  });

  it("keeps a missing report's revisions and evidence files", () => {
    const p = proj();
    run(p, { a: "A", c: "C" }, { c: PNG });
    run(p, { a: "A", c: "C, newer" }, { c: PNG });
    const c = id(p, "c");
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_revisions WHERE bug_report_id = ?", c), 2);
    const att = db.prepare("SELECT stored_name FROM bug_attachments WHERE bug_report_id = ? AND state = 'stored'").get(c) as { stored_name: string };
    const filesBefore = files();
    run(p, { a: "A" });
    assert.equal(standing(p, "c").presence, "missing");
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_revisions WHERE bug_report_id = ?", c), 2);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_attachments WHERE bug_report_id = ? AND active = 1 AND state = 'stored'", c), 1);
    assert.ok(existsSync(join(UPLOAD_DIR, att.stored_name)), "the evidence file is still there");
    assert.equal(files(), filesBefore);
    assert.equal(getBugReport(c).title, "C, newer");
  });

  it("applies the usual rules when a missing report returns in a new version: untouched is updated, reviewed or edited waits as a revision", () => {
    const p = proj();
    run(p, { a: "A", plain: "Plain", reviewed: "Reviewed", edited: "Edited" });
    run(p, { a: "A" });
    reviewBugReport(id(p, "reviewed"), "accepted");
    updateBugReport(id(p, "edited"), { title: "Edited by a person" });
    run(p, { a: "A", plain: "Plain v2", reviewed: "Reviewed v2", edited: "Edited v2" });
    const row = (s: string) => db.prepare("SELECT title, applied_rev, latest_rev, review_status FROM bug_reports WHERE id = ?").get(id(p, s)) as Record<string, any>;
    assert.deepEqual(row("plain"), { title: "Plain v2", applied_rev: 2, latest_rev: 2, review_status: "proposed" }, "an untouched report is updated directly");
    assert.deepEqual(row("reviewed"), { title: "Reviewed", applied_rev: 1, latest_rev: 2, review_status: "accepted" }, "a reviewed one waits");
    assert.deepEqual(row("edited"), { title: "Edited by a person", applied_rev: 1, latest_rev: 2, review_status: "proposed" }, "an edited one waits");
    for (const s of ["plain", "reviewed", "edited"]) assert.equal(standing(p, s).presence, "present", `${s} is in the latest run again`);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), 4, "no duplicates");
    assert.equal(getBugReport(id(p, "reviewed")).pendingUpdate?.rev, 2);
  });

  it("says there is no later run to compare with when the audit was deleted or its latest run was imported before runs were recorded", () => {
    const p = proj();
    run(p, { a: "A", c: "C" });
    run(p, { a: "A" });
    assert.equal(standing(p, "c").presence, "missing");
    // A run imported by an older version of Testbench: no record of what it contained.
    db.prepare("UPDATE audit_imports SET sightings_recorded = 0 WHERE id = (SELECT MAX(id) FROM audit_imports WHERE audit_id = (SELECT audit_id FROM bug_reports WHERE id = ?))").run(id(p, "c"));
    const old = standing(p, "c");
    assert.equal(old.presence, "no_later_run");
    assert.match(old.reason, /before Testbench recorded/);
    assert.equal(standing(p, "a").presence, "no_later_run", "nothing is claimed about a run that was not recorded");
    assert.deepEqual(listed(p, "no_later_run").items.map((i) => i.sourceId).sort(), ["a", "c"]);

    const q = proj();
    run(q, { a: "A", c: "C" });
    const audit = (db.prepare("SELECT audit_id FROM bug_reports WHERE id = ?").get(id(q, "c")) as { audit_id: number }).audit_id;
    reviewBugReport(id(q, "c"), "accepted"); // an untouched proposal would be removed with its audit; a reviewed report is kept
    deleteAudit(audit);
    const gone = standing(q, "c");
    assert.deepEqual([gone.presence, gone.runs, gone.latest], ["no_later_run", 0, null]);
    assert.match(gone.reason, /deleted/);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", q.id), 1, "the reviewed report is kept");
  });

  it("filters the list by presence, together with the status and the search, and says how many there are of each", () => {
    const p = proj();
    run(p, { a: "Alpha", b: "Beta", c: "Gamma", d: "Delta" });
    run(p, { a: "Alpha", b: "Beta" });
    reviewBugReport(id(p, "d"), "rejected");
    assert.deepEqual(listed(p, "present").items.map((i) => i.sourceId).sort(), ["a", "b"]);
    assert.deepEqual(listed(p, "missing").items.map((i) => i.sourceId).sort(), ["c", "d"]);
    assert.deepEqual(listed(p, "no_later_run").items, []);
    assert.deepEqual(listed(p, "missing", "rejected").items.map((i) => i.sourceId), ["d"]);
    assert.deepEqual(listed(p, undefined, "proposed").presenceCounts, { present: 2, missing: 1, no_later_run: 0 }, "counts follow the status filter");
    assert.deepEqual(listed(p, "missing").presenceCounts, { present: 2, missing: 2, no_later_run: 0 }, "and not the presence filter itself");
    assert.deepEqual(listBugReports(p.id, { presence: "missing", q: "Gam" }).items.map((i) => i.sourceId), ["c"]);
    assert.deepEqual(listed(p).items.map((i) => [i.sourceId, i.presence]).sort(), [["a", "present"], ["b", "present"], ["c", "missing"], ["d", "missing"]]);
    assert.throws(() => listed(p, "gone"), (e: unknown) => e instanceof AuditError && e.status === 400 && /presence must be one of/.test(e.message));
  });

  it("shows the same standing in the list and on the report, and refers to the GitHub run when the run came from one", () => {
    const p = proj();
    run(p, { a: "A", c: "C" });
    importAuditPackage(bagFromFiles(new Map<string, Uint8Array>([
      ["manifest.json", Buffer.from(JSON.stringify({ format: "testbench-audit-package", version: 1, audit: { id: "w45", title: "Checkout audit", project: p.key, agent: { name: "agent", version: "1" } }, files: [], parts: {} }))],
      ["bugs.json", Buffer.from(JSON.stringify({ version: 1, bugs: [{ sourceId: "a", title: "A", description: "About a" }] }))],
    ])), { projectId: p.id, source: "github", github: { repo: "o/r", runId: 4242, artifactId: 9 } });
    for (const i of listed(p).items) assert.equal(getBugReport(i.id).latestRun.presence, i.presence, i.sourceId);
    const c = standing(p, "c");
    assert.equal(c.latest?.github?.url, "https://github.com/o/r/actions/runs/4242");
    assert.equal(c.latest?.source, "github");
    assert.equal(c.lastSeen?.github, null, "the first run was an upload");
  });
});
