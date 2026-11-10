import "./env.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { runAs, type AccountUser } from "../server/accountcontext.ts";
import { db, migrateRoles } from "../server/db.ts";
import { getBugReport, listBugReports, markDuplicate, reviewBugReport } from "../server/audits.ts";
import { ingestCiResults } from "../server/ci.ts";
import { convertToBug, importObservations, listObservations } from "../server/observations.ts";
import { makeProject } from "./helpers.ts";

// Confirming a bug suggestion is a person's decision: the person, their account and the time are saved on every decision (confirm, dismiss, restore, duplicate),
// and once accounts exist the database itself refuses a decision without an account. Nothing but a person ever makes a bug "accepted".

let n = 0;
const proj = () => makeProject(`BC${++n}`, `Bug confirm ${n}`);
let bn = 0;
const bug = (p: { id: number }) =>
  (db.prepare("INSERT INTO bug_reports (project_id, origin_audit_id, source_id, title) VALUES (?, 'a1', ?, 'A bug') RETURNING id").get(p.id, `B-${++bn}`) as { id: number }).id;
const row = (id: number) => db.prepare("SELECT review_status, reviewed_by, reviewed_by_user_id, reviewed_at FROM bug_reports WHERE id = ?").get(id) as Record<string, any>;
const user = (name: string): AccountUser => {
  const id = (db.prepare("INSERT INTO users (email, name, password_hash) VALUES (?, ?, 'h') RETURNING id").get(`${name.toLowerCase().replace(/\W/g, "")}@x.io`, name) as { id: number }).id;
  return { id, email: "", name, isOwner: false, disabledAt: null, createdAt: "", lastLoginAt: null };
};

// This describe runs first on purpose: there is no account yet, so it shows what a single-person install does.
describe("without accounts (nothing changes for a single-person install)", () => {
  it("a decision works as before and saves no account", () => {
    const p = proj(); const id = bug(p);
    reviewBugReport(id, "accepted");
    assert.equal(row(id).review_status, "accepted");
    assert.equal(row(id).reviewed_by_user_id, null);
    assert.ok(row(id).reviewed_at);
  });
});

describe("a decision on a bug suggestion", () => {
  // Made when the first test of this suite runs, not when the file is read: the suite above must see an install without accounts.
  let anna!: AccountUser; let sam!: AccountUser;
  before(() => { anna = user("Anna Berg"); sam = user("Sam Lund"); });

  it("confirm saves the person, the account and the time, and the detail and the list show who", () => {
    const p = proj(); const id = bug(p);
    runAs(anna, () => reviewBugReport(id, "accepted"));
    assert.deepEqual([row(id).review_status, row(id).reviewed_by, row(id).reviewed_by_user_id], ["accepted", "Anna Berg", anna.id]);
    assert.ok(row(id).reviewed_at);
    assert.equal(getBugReport(id).reviewedBy, "Anna Berg");
    assert.equal(listBugReports(p.id).items.find((b) => b.id === id)?.reviewedBy, "Anna Berg");
  });

  it("dismiss saves the person and keeps the bug (it is not deleted); restore saves who restored it", () => {
    const p = proj(); const id = bug(p);
    runAs(anna, () => reviewBugReport(id, "rejected", "not a bug"));
    assert.deepEqual([row(id).review_status, row(id).reviewed_by, row(id).reviewed_by_user_id], ["rejected", "Anna Berg", anna.id]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM bug_reports WHERE id = ?").get(id) as { n: number }).n, 1);
    assert.equal(getBugReport(id).reviewNote, "not a bug");
    runAs(sam, () => reviewBugReport(id, "proposed"));
    assert.deepEqual([row(id).review_status, row(id).reviewed_by, row(id).reviewed_by_user_id, row(id).reviewed_at], ["proposed", "Sam Lund", sam.id, null]);
  });

  it("a confirmed bug cannot be restored to Suggested, and a dismissed one can", () => {
    const p = proj(); const id = bug(p); const dismissed = bug(p);
    runAs(anna, () => { reviewBugReport(id, "accepted"); reviewBugReport(dismissed, "rejected"); });
    assert.throws(() => runAs(sam, () => reviewBugReport(id, "proposed")), /confirmed bug/);
    assert.deepEqual([row(id).review_status, row(id).reviewed_by], ["accepted", "Anna Berg"], "nothing changed");
    runAs(sam, () => reviewBugReport(dismissed, "proposed"));
    assert.equal(row(dismissed).review_status, "proposed");
  });

  it("duplicate saves the person and the account", () => {
    const p = proj(); const a = bug(p); const b = bug(p);
    runAs(sam, () => markDuplicate(a, b));
    assert.deepEqual([row(a).review_status, row(a).reviewed_by, row(a).reviewed_by_user_id], ["duplicate", "Sam Lund", sam.id]);
  });

  it("with accounts, the database refuses a decision that has no account, however it is made", () => {
    const p = proj(); const id = bug(p); const other = bug(p);
    for (const to of ["accepted", "rejected", "duplicate"]) {
      assert.throws(() => db.prepare("UPDATE bug_reports SET review_status = ? WHERE id = ?").run(to, id), /needs a person with an account/, to);
    }
    assert.throws(() => reviewBugReport(id, "accepted"), /needs a person with an account/, "the function, run without a person");
    assert.throws(() => markDuplicate(id, other), /needs a person with an account/);
    assert.throws(() => db.prepare("INSERT INTO bug_reports (project_id, origin_audit_id, source_id, title, review_status) VALUES (?, 'a1', 'X', 't', 'accepted')").run(p.id), /needs a person with an account/);
    assert.equal(row(id).review_status, "proposed");
  });

  it("a bug accepted before accounts existed stays accepted, and can still be edited and triaged", () => {
    const p = proj(); const id = bug(p);
    db.exec("DROP TRIGGER bug_reports_decision_needs_account_update");
    db.prepare("UPDATE bug_reports SET review_status = 'accepted' WHERE id = ?").run(id);
    migrateRoles(db); // puts the guard back exactly as the migration makes it
    assert.doesNotThrow(() => db.prepare("UPDATE bug_reports SET title = 'Edited', workflow_status = 'in_progress' WHERE id = ?").run(id));
    assert.equal(row(id).review_status, "accepted");
    assert.throws(() => db.prepare("UPDATE bug_reports SET review_status = 'rejected' WHERE id = ?").run(id), /needs a person with an account/, "but a new decision needs a person");
  });
});

describe("nothing but a person makes a bug accepted", () => {
  it("CI results create or leave proposed bugs, and a repeat failure does not undo a decision", () => {
    const p = proj();
    const result = { testKey: "e2e-a", title: "A fails", status: "failed", durationMs: 1, error: "boom", steps: [], attachments: [], tags: [] };
    const send = (runId: string) => ingestCiResults(p.id, { runId, commitSha: "abc1234567", branch: "main", repository: "o/r", pipelineUrl: "https://github.com/o/r/actions/runs/1", startedAt: "2026-11-04T07:00:00Z", finishedAt: "2026-11-04T07:04:00Z", results: [result] });
    send("r1");
    const b = db.prepare("SELECT id, review_status, source FROM bug_reports WHERE project_id = ?").get(p.id) as { id: number; review_status: string; source: string };
    assert.deepEqual([b.source, b.review_status], ["ci", "proposed"]);
    send("r2");
    assert.equal(row(b.id).review_status, "proposed");
    runAs(user("Cia Cole"), () => reviewBugReport(b.id, "rejected"));
    send("r3");
    assert.equal(row(b.id).review_status, "rejected");
  });

  it("turning an observation into a bug makes a proposal, never an accepted bug", () => {
    const p = proj();
    db.prepare("INSERT INTO audits (project_id, agent_audit_id, title, source) VALUES (?, 'a1', 'Audit', 'upload')").run(p.id);
    importObservations(p.id, [{ id: "LT-1", auditId: "a1", kind: "load_test", title: "p95 latency", severity: "high", status: "observed", metric: "p95_ms", value: 840, threshold: 500, evidence: "k6", evidenceIds: [], recommendation: "Add an index", source: "k6 run" }]);
    const o = listObservations(p.id).items[0];
    const { bugId } = convertToBug(o.id);
    assert.deepEqual([row(bugId).review_status, row(bugId).reviewed_by, row(bugId).reviewed_by_user_id], ["proposed", "", null]);
    assert.equal(getBugReport(bugId).source, "manual");
  });

  it("no server code writes the literal 'accepted' for a bug: only reviewBugReport, which takes the status from a person's request", () => {
    const dir = join(import.meta.dirname, "..", "server");
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.name.endsWith(".ts") && /SET[^;`]*review_status\s*=\s*'accepted'/.test(readFileSync(f, "utf8"))) hits.push(f.slice(dir.length + 1));
      }
    };
    walk(dir);
    assert.deepEqual(hits, []);
  });
});
