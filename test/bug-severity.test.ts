import "./env.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { runAs, type AccountUser } from "../server/accountcontext.ts";
import { db } from "../server/db.ts";
import { getBugReport, listBugReports, reviewBugReport, updateBugReport } from "../server/audits.ts";
import { ingestCiResults } from "../server/ci.ts";
import { convertToBug, importObservations, listObservations } from "../server/observations.ts";
import { buildPreview } from "../server/publish.ts";
import { makeProject } from "./helpers.ts";

// A bug's severity: the AI (or a rule in CI) suggests it, a person decides it. The suggestion never becomes the decision by itself, the decision says who made it and
// why, and every change is logged. The stored value for "Major" stays "high".

let n = 0;
const proj = () => makeProject(`SV${++n}`, `Severity ${n}`);
let bn = 0;
const bug = (p: { id: number }, over: { agent?: string | null; source?: string } = {}) =>
  (db.prepare("INSERT INTO bug_reports (project_id, origin_audit_id, source_id, title, agent_severity, source) VALUES (?, 'a1', ?, 'A bug', ?, ?) RETURNING id")
    .get(p.id, `S-${++bn}`, over.agent === undefined ? "high" : over.agent, over.source ?? "agent_audit") as { id: number }).id;
const row = (id: number) => db.prepare("SELECT human_severity, agent_severity, severity_by, severity_by_user_id, severity_at, severity_reason, edited_at, review_status FROM bug_reports WHERE id = ?").get(id) as Record<string, any>;
const events = (id: number) => (db.prepare("SELECT actor, kind, detail FROM bug_events WHERE bug_report_id = ? ORDER BY id").all(id) as { actor: string; kind: string; detail: string }[]).filter((e) => e.kind === "severity");
const user = (name: string): AccountUser => {
  const id = (db.prepare("INSERT INTO users (email, name, password_hash) VALUES (?, ?, 'h') RETURNING id").get(`${name.toLowerCase().replace(/\W/g, "")}@x.io`, name) as { id: number }).id;
  return { id, email: "", name, isOwner: false, disabledAt: null, createdAt: "", lastLoginAt: null };
};

// First on purpose: no account exists yet, so this is a single-person install.
describe("without accounts (nothing changes for a single-person install)", () => {
  it("a person can still decide a severity; it is logged and does not count as an edit of the text", () => {
    const p = proj(); const id = bug(p);
    updateBugReport(id, { humanSeverity: "critical" });
    assert.deepEqual([row(id).human_severity, row(id).severity_by_user_id, row(id).edited_at], ["critical", null, null]);
    assert.ok(row(id).severity_at);
    assert.equal(events(id).length, 1);
  });
});

describe("a suggestion and a decision", () => {
  let anna!: AccountUser; let sam!: AccountUser;
  before(() => { anna = user("Anna Berg"); sam = user("Sam Lund"); });

  it("a bug from an agent has an AI suggestion and no decision; the detail and the list say so", () => {
    const p = proj(); const id = bug(p);
    const d = getBugReport(id).severity;
    assert.deepEqual([d.agent, d.human, d.effective, d.source, d.decidedBy], ["high", null, "high", "ai", null]);
    const item = listBugReports(p.id).items.find((b) => b.id === id)!;
    assert.deepEqual([item.severity, item.severitySource, item.severityBy], ["high", "ai", null]);
  });

  it("a person sets it and then changes it: who, account, time and reason are saved, and each change is logged by name", () => {
    const p = proj(); const id = bug(p, { agent: "medium" });
    runAs(anna, () => updateBugReport(id, { humanSeverity: "high", severityReason: "affects checkout" }));
    assert.deepEqual([row(id).human_severity, row(id).severity_by, row(id).severity_by_user_id, row(id).severity_reason, row(id).edited_at], ["high", "Anna Berg", anna.id, "affects checkout", null]);
    assert.ok(row(id).severity_at);
    runAs(sam, () => updateBugReport(id, { humanSeverity: "critical" }));
    assert.deepEqual([row(id).human_severity, row(id).severity_by, row(id).severity_by_user_id, row(id).severity_reason], ["critical", "Sam Lund", sam.id, ""]);
    assert.deepEqual(events(id).map((e) => e.detail), ["Severity Medium → Major, Anna Berg: affects checkout", "Severity Major → Critical, Sam Lund"]);
    const d = getBugReport(id).severity;
    assert.deepEqual([d.source, d.decidedBy, d.human, d.agent], ["human", "Sam Lund", "critical", "medium"], "the suggestion is kept next to the decision");
  });

  it("the same value again is nothing: no new decision, no log", () => {
    const p = proj(); const id = bug(p);
    runAs(anna, () => updateBugReport(id, { humanSeverity: "low" }));
    runAs(sam, () => updateBugReport(id, { humanSeverity: "low", severityReason: "again" }));
    assert.equal(events(id).length, 1);
    assert.equal(row(id).severity_by, "Anna Berg");
  });

  it("'Not set' takes the decision back, falls back to the suggestion, and is logged", () => {
    const p = proj(); const id = bug(p, { agent: "medium" });
    runAs(anna, () => updateBugReport(id, { humanSeverity: "critical" }));
    runAs(sam, () => updateBugReport(id, { humanSeverity: null, severityReason: "not important" }));
    const d = getBugReport(id).severity;
    assert.deepEqual([d.human, d.effective, d.source, d.decidedBy, d.reason], [null, "medium", "ai", null, ""]);
    assert.equal(events(id).at(-1)?.detail, "Severity decision removed (back to the suggestion Medium), Sam Lund: not important", "the reason of taking it back is in the log");
  });

  it("changing the severity after the bug is confirmed works and is logged", () => {
    const p = proj(); const id = bug(p);
    runAs(anna, () => reviewBugReport(id, "accepted"));
    runAs(sam, () => updateBugReport(id, { humanSeverity: "low", severityReason: "cosmetic" }));
    assert.deepEqual([row(id).review_status, row(id).human_severity], ["accepted", "low"]);
    assert.equal(events(id).at(-1)?.detail, "Severity Major → Low, Sam Lund: cosmetic");
  });

  it("editing the text alone does not decide a severity", () => {
    const p = proj(); const id = bug(p);
    runAs(anna, () => updateBugReport(id, { title: "New title" }));
    assert.deepEqual([row(id).human_severity, row(id).severity_by, events(id).length], [null, "", 0]);
    assert.ok(row(id).edited_at, "but it is an edit of the text");
  });
});

describe("Confirm bug with a severity", () => {
  let cia!: AccountUser; let dan!: AccountUser;
  before(() => { cia = user("Cia Cole"); dan = user("Dan Dahl"); });

  it("confirming what the screen showed saves it as the person's decision, with the confirmation", () => {
    const p = proj(); const id = bug(p, { agent: "medium" });
    runAs(cia, () => reviewBugReport(id, "accepted", undefined, { value: "medium" }));
    assert.deepEqual([row(id).review_status, row(id).human_severity, row(id).severity_by, row(id).severity_by_user_id], ["accepted", "medium", "Cia Cole", cia.id]);
    assert.equal(events(id).at(-1)?.detail, "Severity Medium (AI suggestion) confirmed, Cia Cole");
  });

  it("confirming with a changed severity and a reason", () => {
    const p = proj(); const id = bug(p, { agent: "medium" });
    runAs(cia, () => reviewBugReport(id, "accepted", undefined, { value: "critical", reason: "data loss" }));
    assert.deepEqual([row(id).human_severity, row(id).severity_reason], ["critical", "data loss"]);
    assert.equal(events(id).at(-1)?.detail, "Severity Medium → Critical, Cia Cole: data loss");
  });

  it("a CI bug's default is called a default from CI when it is confirmed, and never AI", () => {
    const p = proj(); const id = bug(p, { agent: "medium", source: "ci" });
    assert.equal(getBugReport(id).severity.source, "ci_default");
    runAs(cia, () => reviewBugReport(id, "accepted", undefined, { value: "medium" }));
    assert.equal(events(id).at(-1)?.detail, "Severity Medium (default from CI) confirmed, Cia Cole");
    assert.equal(getBugReport(id).severity.source, "human");
  });

  it("confirming without a severity (the list row) confirms the bug and leaves the severity a suggestion", () => {
    const p = proj(); const id = bug(p);
    runAs(cia, () => reviewBugReport(id, "accepted"));
    assert.deepEqual([row(id).review_status, row(id).human_severity, row(id).severity_by, events(id).length], ["accepted", null, "", 0]);
    assert.equal(getBugReport(id).severity.source, "ai");
  });

  it("is all or nothing: if the severity cannot be saved, the confirmation is not saved either, and nothing is logged", () => {
    const p = proj(); const id = bug(p);
    db.exec("CREATE TRIGGER zz_severity_fails BEFORE UPDATE OF human_severity ON bug_reports BEGIN SELECT RAISE(ABORT, 'boom'); END");
    try {
      assert.throws(() => runAs(cia, () => reviewBugReport(id, "accepted", undefined, { value: "low" })), /boom/);
    } finally {
      db.exec("DROP TRIGGER zz_severity_fails");
    }
    assert.deepEqual([row(id).review_status, row(id).human_severity, row(id).severity_by, events(id).length], ["proposed", null, "", 0]);
    assert.equal((db.prepare("SELECT reviewed_by FROM bug_reports WHERE id = ?").get(id) as { reviewed_by: string }).reviewed_by, "");
  });

  it("a severity can only come with a confirmation", () => {
    const p = proj(); const id = bug(p);
    assert.throws(() => runAs(dan, () => reviewBugReport(id, "rejected", undefined, { value: "low" })), /decided when the bug is confirmed/);
    assert.equal(row(id).review_status, "proposed");
  });
});

describe("with accounts, the database refuses a severity decision without an account", () => {
  it("however it is made", () => {
    const p = proj(); const id = bug(p);
    assert.throws(() => db.prepare("UPDATE bug_reports SET human_severity = 'low' WHERE id = ?").run(id), /needs a person with an account/);
    assert.throws(() => updateBugReport(id, { humanSeverity: "low" }), /needs a person with an account/, "the function, run without a person");
    assert.throws(() => db.prepare("INSERT INTO bug_reports (project_id, origin_audit_id, source_id, title, human_severity) VALUES (?, 'a1', 'Z', 't', 'low')").run(p.id), /needs a person with an account/);
    assert.equal(row(id).human_severity, null);
  });

  it("a decision made before accounts existed stays, and the bug can still be edited", () => {
    const p = proj(); const id = bug(p);
    db.exec("DROP TRIGGER bug_reports_severity_needs_account_update");
    db.prepare("UPDATE bug_reports SET human_severity = 'high' WHERE id = ?").run(id);
    db.exec(`CREATE TRIGGER bug_reports_severity_needs_account_update BEFORE UPDATE OF human_severity ON bug_reports
      WHEN NEW.human_severity IS NOT OLD.human_severity AND NEW.severity_by_user_id IS NULL AND EXISTS (SELECT 1 FROM users)
      BEGIN SELECT RAISE(ABORT, 'A severity decision on a bug report needs a person with an account'); END;`);
    assert.doesNotThrow(() => db.prepare("UPDATE bug_reports SET title = 'Edited', workflow_status = 'closed' WHERE id = ?").run(id));
    assert.equal(row(id).human_severity, "high");
  });
});

describe("nothing but a person decides a severity", () => {
  it("a CI failure suggests by rule and leaves the decision empty, also after a person has decided and the test fails again", () => {
    const p = proj();
    const result = { testKey: "e2e-s", title: "S fails", status: "failed", durationMs: 1, error: "boom", steps: [], attachments: [], tags: [] };
    const send = (runId: string) => ingestCiResults(p.id, { runId, commitSha: "abc1234567", branch: "main", repository: "o/r", pipelineUrl: "https://github.com/o/r/actions/runs/1", startedAt: "2026-11-04T07:00:00Z", finishedAt: "2026-11-04T07:04:00Z", results: [result] });
    send("r1");
    const b = db.prepare("SELECT id FROM bug_reports WHERE project_id = ?").get(p.id) as { id: number };
    assert.deepEqual([row(b.id).human_severity, row(b.id).severity_by, getBugReport(b.id).severity.source], [null, "", "ci_default"]);
    runAs(user("Eva Ek"), () => updateBugReport(b.id, { humanSeverity: "critical" }));
    send("r2");
    assert.deepEqual([row(b.id).human_severity, row(b.id).severity_by], ["critical", "Eva Ek"]);
  });

  it("turning an observation into a bug makes an AI suggestion, never a decision", () => {
    const p = proj();
    db.prepare("INSERT INTO audits (project_id, agent_audit_id, title, source) VALUES (?, 'a1', 'Audit', 'upload')").run(p.id);
    importObservations(p.id, [{ id: "LT-1", auditId: "a1", kind: "load_test", title: "p95 latency", severity: "high", status: "observed", metric: "p95_ms", value: 840, threshold: 500, evidence: "k6", evidenceIds: [], recommendation: "Add an index", source: "k6 run" }]);
    const { bugId } = convertToBug(listObservations(p.id).items[0].id);
    assert.deepEqual([row(bugId).agent_severity, row(bugId).human_severity, row(bugId).severity_by], ["high", null, ""]);
    assert.equal(getBugReport(bugId).severity.source, "ai");
  });

  it("no server code but the severity decision writes human_severity", () => {
    const dir = join(import.meta.dirname, "..", "server");
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.name.endsWith(".ts")) {
          const text = readFileSync(f, "utf8");
          if (/UPDATE bug_reports SET[^;`]*human_severity\s*=/.test(text) || /INSERT INTO bug_reports[^;`]*human_severity/.test(text)) hits.push(f.slice(dir.length + 1));
        }
      }
    };
    walk(dir);
    assert.deepEqual(hits, ["audits.ts"], "only decideSeverity in audits.ts");
  });
});

describe("what a publication says", () => {
  it("warns, without blocking, when the severity is only a suggestion; and not when a person decided it", () => {
    const p = proj(); const id = bug(p, { agent: "high" });
    const warn = (w: string[]) => w.filter((x) => /severity/i.test(x));
    assert.match(warn(buildPreview(id).warnings)[0] ?? "", /Major\) is only an AI suggestion/);
    const ci = bug(p, { agent: "medium", source: "ci" });
    assert.match(warn(buildPreview(ci).warnings)[0] ?? "", /Medium\) is only a default from CI/);
    runAs(user("Fay Fors"), () => updateBugReport(id, { humanSeverity: "high" }));
    assert.deepEqual(warn(buildPreview(id).warnings), []);
  });
});
