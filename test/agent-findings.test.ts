import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { claimRequest, completeRequest, createRequest, listRequests } from "../server/agentrequests.ts";
import { AuditError } from "../server/auditcommon.ts";
import { createFinding, FINDING_LIMITS, findingBody, PLAN_LIMITS } from "../server/agentfindings.ts";
import { db, migrate } from "../server/db.ts";
import { createRequestToken } from "../server/requesttokens.ts";
import { makeProject } from "./helpers.ts";

// The parts of AG-B that cannot be shown over HTTP in a reasonable time or need a database of their own: the cap of findings per request, that a finding that fails halfway
// leaves nothing (not the count, not a row, not an audit entry), and the step from a database that has no `exploratory` kind and no marks yet.

const asDiscover = (projectId: number, name: string) => {
  const token = createRequestToken(projectId, name);
  const t = { id: token.id, name };
  const take = () => {
    const req = createRequest(projectId, { kind: "discover", targetUrl: "http://localhost:3000/" }, { name: "a person", userId: null });
    claimRequest(projectId, req.id, t);
    return req.id;
  };
  return { token: t, take };
};
const obs = (title: string) => findingBody.parse({ kind: "observation", title });
const refusal = (e: unknown, status: number, re: RegExp) => e instanceof AuditError && e.status === status && re.test(e.message);
const n = (sql: string, ...args: unknown[]) => (db.prepare(sql).pluck().get(...args) as number);

describe("the cap: at most 200 findings per request", () => {
  it("lets one request make 200 findings and refuses the 201st with 409, and the count is per request, not global", () => {
    const p = makeProject("CAP", "Cap");
    const { token, take } = asDiscover(p.id, "cap-agent");
    const first = take();
    for (let i = 1; i <= FINDING_LIMITS.perRequest; i++) {
      const made = createFinding(p.id, first, token, "127.0.0.1", obs(`finding ${i}`));
      assert.equal(made.sourceId, `$agent-${first}-${i}`);
    }
    assert.equal(FINDING_LIMITS.perRequest, 200);
    assert.throws(() => createFinding(p.id, first, token, "127.0.0.1", obs("one too many")), (e) => refusal(e, 409, /already has 200 findings/));
    assert.equal(n("SELECT findings_count FROM agent_requests WHERE id = ?", first), 200);
    assert.equal(n("SELECT COUNT(*) FROM observations WHERE origin_audit_id = ?", `$agent-${first}`), 200, "the refused one was not made");
    assert.equal(n("SELECT COUNT(*) FROM audit_log WHERE action = 'agent_request.finding_created' AND detail LIKE ?", `%"request":${first},%`), 200, "and not logged");

    completeRequest(p.id, first, token, {}); // one request runs at a time in a project: the first is finished before the second is taken
    const second = take();
    assert.equal(createFinding(p.id, second, token, "127.0.0.1", obs("a fresh request has its own count")).sourceId, `$agent-${second}-1`);
    assert.equal(n("SELECT findings_count FROM agent_requests WHERE id = ?", first), 200, "the first is still full");
  });

  it("counts every kind of finding, not only one", () => {
    const p = makeProject("MIX", "Mix");
    const { token, take } = asDiscover(p.id, "mix-agent");
    const rid = take();
    for (const body of [{ kind: "test_case", title: "a" }, { kind: "bug_report", title: "b" }, { kind: "observation", title: "c" }, { kind: "manual_test_suggestion", title: "d" }]) {
      createFinding(p.id, rid, token, "127.0.0.1", findingBody.parse(body));
    }
    assert.equal(n("SELECT findings_count FROM agent_requests WHERE id = ?", rid), 4);
  });
});

describe("a finding that fails halfway leaves nothing", () => {
  const traces = (rid: number) => [
    n("SELECT findings_count FROM agent_requests WHERE id = ?", rid),
    n("SELECT COUNT(*) FROM observations"), n("SELECT COUNT(*) FROM bug_reports"), n("SELECT COUNT(*) FROM manual_tests"), n("SELECT COUNT(*) FROM cases"), n("SELECT COUNT(*) FROM case_steps"),
    n("SELECT COUNT(*) FROM audit_log WHERE action = 'agent_request.finding_created'"), n("SELECT next_case_number FROM projects WHERE key = 'RB'"),
  ];

  it("rolls back the count, the row, the revision, the case number and the audit entry when the write fails after the count was bumped", () => {
    const p = makeProject("RB", "Rollback");
    const { token, take } = asDiscover(p.id, "rb-agent");
    const rid = take();
    const before = traces(rid);
    const breaks: [string, unknown][] = [
      ["observations", { kind: "observation", title: "x" }],
      ["bug_revisions", { kind: "bug_report", title: "x" }],
      ["manual_test_revisions", { kind: "manual_test_suggestion", title: "x" }],
      ["case_steps", { kind: "test_case", title: "x", steps: [{ action: "a" }] }],
      ["audit_log", { kind: "observation", title: "x" }],
    ];
    for (const [table, body] of breaks) {
      db.exec(`DROP TRIGGER IF EXISTS fail_${table}`);
      db.exec(`CREATE TRIGGER fail_${table} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'boom ${table}'); END`);
      try {
        assert.throws(() => createFinding(p.id, rid, token, "127.0.0.1", findingBody.parse(body)), new RegExp(`boom ${table}`));
        assert.deepEqual(traces(rid), before, `a failure in ${table} left a trace`);
      } finally {
        db.exec(`DROP TRIGGER fail_${table}`);
      }
    }
    // and afterwards the request works as if nothing had happened, with no gap in the numbers
    assert.equal(createFinding(p.id, rid, token, "127.0.0.1", obs("fine")).sourceId, `$agent-${rid}-1`);
  });
});

describe("the audit entry", () => {
  it("is written by the finding, as 'agent: <name>', with the token's id, and holds no token, hash or text of the finding", () => {
    const p = makeProject("AUD", "Audit");
    const { token, take } = asDiscover(p.id, "audit-agent");
    const rid = take();
    const made = createFinding(p.id, rid, token, "10.1.2.3", findingBody.parse({ kind: "bug_report", title: "A secret-looking title tbag_123", description: "password: hunter2" }));
    const row = db.prepare("SELECT actor_label, actor_user_id, ip, project_id, detail FROM audit_log WHERE action = 'agent_request.finding_created' AND detail LIKE ?").get(`%"request":${rid},%`) as
      { actor_label: string; actor_user_id: number | null; ip: string; project_id: number; detail: string };
    assert.deepEqual([row.actor_label, row.actor_user_id, row.ip, row.project_id], ["agent: audit-agent", null, "10.1.2.3", p.id]);
    assert.deepEqual(JSON.parse(row.detail), { request: rid, kind: "discover", finding_kind: "bug_report", id: made.id, n: 1, credential_id: token.id });
    assert.equal(/hunter2|tbag_|token_hash/.test(row.detail), false, "the finding's text is not copied into the log");
    const hash = db.prepare("SELECT token_hash FROM request_tokens WHERE id = ?").pluck().get(token.id) as string;
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM audit_log").all()).includes(hash), false);
  });
});

describe("a database from before agent findings", () => {
  /** A database as it was before: the observations table with the old CHECK, and no mark and no count. */
  const old = () => {
    const d = new Database(":memory:");
    d.pragma("foreign_keys = ON");
    migrate(d);
    d.exec("INSERT INTO projects (name, key) VALUES ('Old', 'OLD')");
    d.prepare(`INSERT INTO observations (project_id, number, source_id, audit_id, origin_audit_id, kind, title, severity, status, content_hash)
      VALUES (1, 1, 'S-1', NULL, 'AUD-1', 'security_review', 'Missing header', 'high', 'confirmed', 'h1'), (1, 2, 'L-1', NULL, 'AUD-1', 'load_test', 'Slow', 'low', 'observed', 'h2')`).run();
    d.prepare("INSERT INTO observation_evidence (observation_id, ref, path, state, reason) VALUES (1, 'EV-1', 'a.png', 'ok', '')").run();
    d.exec("INSERT INTO cases (project_id, number, title) VALUES (1, 1, 'A case')");
    d.exec("INSERT INTO agent_requests (project_id, kind, target_url) VALUES (1, 'discover', 'http://localhost:3000/')");
    d.pragma("foreign_keys = OFF");
    const ddl = d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'observations'").pluck().get() as string;
    const oldDdl = ddl.replace(", 'exploratory'", "");
    assert.notEqual(oldDdl, ddl, "the test builds an old table");
    d.exec("ALTER TABLE observations RENAME TO observations_now");
    d.exec(oldDdl.replace(/CREATE TABLE "?observations"?/, "CREATE TABLE observations"));
    d.exec("INSERT INTO observations SELECT * FROM observations_now");
    d.exec("DROP TABLE observations_now");
    d.exec("ALTER TABLE cases DROP COLUMN created_by_agent_token_id");
    d.exec("ALTER TABLE agent_requests DROP COLUMN findings_count");
    d.pragma("foreign_keys = ON");
    return d;
  };
  const ddlOf = (d: Database.Database) => d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'observations'").pluck().get() as string;
  const cols = (d: Database.Database, t: string) => (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

  it("gets the exploratory kind with every observation and its evidence kept, the mark on cases and the count on requests", () => {
    const d = old();
    assert.throws(() => d.prepare("INSERT INTO observations (project_id, number, source_id, origin_audit_id, kind, title, severity, content_hash) VALUES (1, 3, 'E-1', 'x', 'exploratory', 't', 'low', 'h')").run(), /CHECK/);
    migrate(d);
    assert.match(ddlOf(d), /'exploratory'/);
    assert.deepEqual(d.prepare("SELECT id, number, kind, title, severity, status FROM observations ORDER BY id").all(), [
      { id: 1, number: 1, kind: "security_review", title: "Missing header", severity: "high", status: "confirmed" },
      { id: 2, number: 2, kind: "load_test", title: "Slow", severity: "low", status: "observed" },
    ]);
    assert.equal(d.prepare("SELECT COUNT(*) FROM observation_evidence WHERE observation_id = 1").pluck().get(), 1, "the evidence still points at its observation");
    d.prepare("INSERT INTO observations (project_id, number, source_id, origin_audit_id, kind, title, severity, content_hash) VALUES (1, 3, 'E-1', '$agent-1', 'exploratory', 't', 'low', 'h')").run();
    assert.throws(() => d.prepare("INSERT INTO observations (project_id, number, source_id, origin_audit_id, kind, title, severity, content_hash) VALUES (1, 4, 'N-1', 'x', 'nonsense', 't', 'low', 'h')").run(), /CHECK/, "the CHECK still refuses what it should");
    assert.ok(cols(d, "cases").includes("created_by_agent_token_id"));
    assert.ok(cols(d, "agent_requests").includes("findings_count"));
    assert.deepEqual(d.prepare("SELECT created_by_agent_token_id AS m FROM cases").pluck().all(), [null], "an existing case was made by a person");
    assert.deepEqual(d.prepare("SELECT findings_count AS c FROM agent_requests").pluck().all(), [0]);
  });

  it("does it once: another start changes nothing", () => {
    const d = old();
    migrate(d);
    const once = ddlOf(d);
    const rows = JSON.stringify(d.prepare("SELECT * FROM observations ORDER BY id").all());
    migrate(d);
    migrate(d);
    assert.equal(ddlOf(d), once);
    assert.equal(JSON.stringify(d.prepare("SELECT * FROM observations ORDER BY id").all()), rows);
    assert.equal(d.prepare("PRAGMA foreign_keys").pluck().get(), 1, "foreign keys are back on");
  });

  it("a new database has all of it from the start", () => {
    const d = new Database(":memory:");
    migrate(d);
    assert.match(ddlOf(d), /'exploratory'/);
    assert.ok(cols(d, "cases").includes("created_by_agent_token_id") && cols(d, "agent_requests").includes("findings_count"));
  });
});

describe("the plan of a request: plan items and coverage gaps", () => {
  const IP = "127.0.0.1";
  const item = (title: string, more: Record<string, unknown> = {}) => findingBody.parse({ kind: "plan_item", title, ...more });
  const gap = (description: string, more: Record<string, unknown> = {}) => findingBody.parse({ kind: "coverage_gap", description, ...more });
  const caseOf = (title: string, planItem?: string) => findingBody.parse({ kind: "test_case", title, ...(planItem === undefined ? {} : { planItem }) });
  const planned = (r: unknown) => r as { id: number; sourceId: string; auditId: number; planItem?: string };
  const caseLink = (id: number) => db.prepare("SELECT plan_item_id AS l FROM cases WHERE id = ?").pluck().get(id) as number | null;

  it("the first plan item makes the audit of the request and links it from the request; the next ones use it", () => {
    const p = makeProject("PL1", "Plan one");
    const { token, take } = asDiscover(p.id, "plan-agent");
    const rid = take();
    const one = planned(createFinding(p.id, rid, token, IP, item("Sign in works")));
    assert.equal(one.sourceId, "P-1");
    const audits = db.prepare("SELECT * FROM audits WHERE project_id = ?").all(p.id) as Record<string, any>[];
    assert.equal(audits.length, 1);
    assert.deepEqual([audits[0].agent_audit_id, audits[0].source, audits[0].title, audits[0].agent_name], [`$agent-${rid}`, "request", "Discover http://localhost:3000/", "plan-agent"]);
    assert.equal(one.auditId, audits[0].id);
    assert.equal(n("SELECT result_audit_id FROM agent_requests WHERE id = ?", rid), audits[0].id, "the request links its audit");
    assert.equal(planned(createFinding(p.id, rid, token, IP, item("Sign out works"))).sourceId, "P-2");
    assert.equal(n("SELECT COUNT(*) FROM audits WHERE project_id = ?", p.id), 1, "one audit for the request");
    assert.equal(n("SELECT findings_count FROM agent_requests WHERE id = ?", rid), 0, "a plan item is not a finding");
  });

  it("keeps what the agent gave, with the fields of a package's plan item, as a proposal in the plan tables, with an entry in the history", () => {
    const p = makeProject("PL2", "Plan fields");
    const { token, take } = asDiscover(p.id, "plan-agent");
    const rid = take();
    const made = planned(createFinding(p.id, rid, token, IP, item("Pay", {
      type: "functional", risk: "money", priority: "high", readiness: "ready", preconditions: "A cart", testData: "a test card", steps: ["Open /pay", "Pay"],
      acceptanceCriteria: "A receipt", automation: "playwright", requirements: ["REQ-3", " REQ-3 ", "REQ-4"],
    })));
    const row = db.prepare("SELECT * FROM audit_plan_items WHERE id = ?").get(made.id) as Record<string, any>;
    assert.deepEqual([row.source_id, row.origin, row.review_status, row.title, row.test_type, row.risk, row.priority, row.readiness, row.preconditions, row.test_data, row.acceptance_criteria, row.automation],
      ["P-1", "agent", "proposed", "Pay", "functional", "money", "high", "ready", "A cart", "a test card", "A receipt", "playwright"]);
    assert.deepEqual(JSON.parse(row.steps), ["Open /pay", "Pay"]);
    assert.deepEqual(JSON.parse(row.requirement_refs), ["REQ-3", "REQ-4"], "trimmed, and each once");
    assert.deepEqual(db.prepare("SELECT kind, actor, actor_user_id FROM audit_plan_revisions WHERE audit_id = ?").all(made.auditId), [{ kind: "agent_import", actor: "agent: plan-agent", actor_user_id: null }]);
    const bare = planned(createFinding(p.id, rid, token, IP, item("Only a title")));
    assert.deepEqual(db.prepare("SELECT priority, readiness, test_type FROM audit_plan_items WHERE id = ?").get(bare.id), { priority: "", readiness: "", test_type: "" }, "what was not given stays empty");
    const g = planned(createFinding(p.id, rid, token, IP, gap("Password reset was not tried", { requirements: ["REQ-9"] })));
    const grow = db.prepare("SELECT * FROM audit_coverage_gaps WHERE id = ?").get(g.id) as Record<string, any>;
    assert.deepEqual([grow.source_id, grow.origin, grow.review_status, grow.description, JSON.parse(grow.requirement_refs)], ["GAP-1", "agent", "proposed", "Password reset was not tried", ["REQ-9"]]);
    assert.equal(n("SELECT COUNT(*) FROM audit_gap_revisions WHERE audit_id = ?", made.auditId), 1);
  });

  it("has caps of its own (100 plan items, 50 coverage gaps), and the plan neither uses up the findings nor is stopped by them", () => {
    const p = makeProject("PL3", "Plan caps");
    const { token, take } = asDiscover(p.id, "cap-plan");
    const rid = take();
    for (let i = 1; i <= PLAN_LIMITS.planItems; i++) createFinding(p.id, rid, token, IP, item(`Item ${i}`));
    assert.throws(() => createFinding(p.id, rid, token, IP, item("one too many")), (e) => refusal(e, 409, /already has 100 plan items/));
    for (let i = 1; i <= PLAN_LIMITS.coverageGaps; i++) createFinding(p.id, rid, token, IP, gap(`Gap ${i}`));
    assert.throws(() => createFinding(p.id, rid, token, IP, gap("one too many")), (e) => refusal(e, 409, /already has 50 coverage gaps/));
    assert.equal(n("SELECT COUNT(*) FROM audit_plan_items WHERE audit_id = (SELECT result_audit_id FROM agent_requests WHERE id = ?)", rid), 100, "the refused one was not made");
    assert.equal(n("SELECT findings_count FROM agent_requests WHERE id = ?", rid), 0);
    assert.equal(createFinding(p.id, rid, token, IP, obs("the findings are untouched")).findingsOnRequest, 1);

    const q = makeProject("PL4", "Findings full");
    const full = asDiscover(q.id, "full-agent");
    const rid2 = full.take();
    for (let i = 1; i <= FINDING_LIMITS.perRequest; i++) createFinding(q.id, rid2, full.token, IP, obs(`finding ${i}`));
    assert.equal(planned(createFinding(q.id, rid2, full.token, IP, item("the plan is not stopped by 200 findings"))).sourceId, "P-1");
  });

  it("links a draft case to a plan item the agent made in this request: cases.plan_item_id is that item, and a case without planItem has none", () => {
    const p = makeProject("PL5", "Plan link");
    const { token, take } = asDiscover(p.id, "link-agent");
    const rid = take();
    const item1 = planned(createFinding(p.id, rid, token, IP, item("Sign in works")));
    const linked = planned(createFinding(p.id, rid, token, IP, caseOf("Sign in with a good password", "P-1")));
    assert.equal(linked.planItem, "P-1", "the answer says which");
    assert.equal(caseLink(linked.id), item1.id);
    assert.equal(caseLink(planned(createFinding(p.id, rid, token, IP, caseOf("A loose case"))).id), null);
    db.prepare("DELETE FROM audit_plan_items WHERE id = ?").run(item1.id);
    assert.equal(caseLink(linked.id), null, "the link goes with the item, and the case stays");
  });

  it("refuses a link to a plan item that is not the agent's own in this request, makes nothing and counts nothing", () => {
    const p = makeProject("PL6", "Plan link refused");
    const { token, take } = asDiscover(p.id, "link-agent");
    const first = take();
    createFinding(p.id, first, token, IP, item("A"));
    createFinding(p.id, first, token, IP, item("B"));
    completeRequest(p.id, first, token, {}); // one request runs at a time in a project
    const second = take();
    const own = planned(createFinding(p.id, second, token, IP, item("C"))); // its own P-1
    db.prepare("INSERT INTO audit_plan_items (audit_id, source_id, position, title, origin, review_status) VALUES (?, 'H-1', 99, 'A person''s item', 'human', 'draft')").run(own.auditId);
    const counts = () => [n("SELECT COUNT(*) FROM cases"), n("SELECT findings_count FROM agent_requests WHERE id = ?", second), n("SELECT COUNT(*) FROM audit_log WHERE action = 'agent_request.finding_created'")];
    const before = counts();
    for (const bad of ["P-2", "P-9", "H-1"]) {
      assert.throws(() => createFinding(p.id, second, token, IP, caseOf(`Link to ${bad}`, bad)), (e) => refusal(e, 400, /not a plan item of this request/), bad);
    }
    assert.deepEqual(counts(), before, "nothing was made, counted or logged");
    const ok = planned(createFinding(p.id, second, token, IP, caseOf("Link to its own P-1", "P-1")));
    assert.equal(caseLink(ok.id), own.id, "its own P-1, not the first request's");
    const noPlan = asDiscover(makeProject("PL7", "No plan").id, "x");
    assert.equal(n("SELECT COUNT(*) FROM audits WHERE agent_audit_id = ?", `$agent-${noPlan.take()}`), 0, "a request without a plan has no audit");
  });

  it("follows the rules of every finding: only the token that took it, and only while it is taken, and a refused one leaves no audit behind", () => {
    const p = makeProject("PL8", "Plan rules");
    const { token, take } = asDiscover(p.id, "plan-agent");
    const rid = take();
    const other = { id: createRequestToken(p.id, "other").id, name: "other" };
    assert.throws(() => createFinding(p.id, rid, other, IP, item("not yours")), (e) => refusal(e, 409, /Another token took this request/));
    assert.equal(n("SELECT COUNT(*) FROM audits WHERE project_id = ?", p.id), 0, "nothing was made");
    createFinding(p.id, rid, token, IP, item("mine"));
    completeRequest(p.id, rid, token, {});
    assert.throws(() => createFinding(p.id, rid, token, IP, item("too late")), (e) => refusal(e, 409, /done or cancelled/));
    assert.equal(n("SELECT COUNT(*) FROM audit_plan_items WHERE audit_id = (SELECT result_audit_id FROM agent_requests WHERE id = ?)", rid), 1);
  });

  it("finishing the request keeps the audit its plan made", () => {
    const p = makeProject("PL9", "Plan done");
    const { token, take } = asDiscover(p.id, "plan-agent");
    const rid = take();
    const made = planned(createFinding(p.id, rid, token, IP, item("Sign in works")));
    assert.equal(completeRequest(p.id, rid, token, { note: "done" }).resultAuditId, made.auditId);
    assert.equal(n("SELECT result_audit_id FROM agent_requests WHERE id = ?", rid), made.auditId);
  });

  it("refuses a field that does not belong, a title or text that is too long, an unknown readiness or priority, and a gap without its description", () => {
    for (const bad of [
      { kind: "plan_item", title: "x", severity: "high" }, { kind: "plan_item", title: "x".repeat(201) }, { kind: "plan_item", title: "x", readiness: "maybe" },
      { kind: "plan_item", title: "x", priority: "urgent" }, { kind: "plan_item", title: "x", requirements: Array(51).fill("REQ-1") }, { kind: "plan_item", title: "x", steps: Array(51).fill("s") },
      { kind: "coverage_gap" }, { kind: "coverage_gap", description: "x", title: "a gap has no title" }, { kind: "coverage_gap", description: "x".repeat(5001) },
      { kind: "test_case", title: "x", planItem: "" }, { kind: "observation", title: "x", planItem: "P-1" }, { kind: "plan_item", title: "x", planItem: "P-1" },
    ]) assert.throws(() => findingBody.parse(bad), JSON.stringify(bad));
  });
});

describe("what a request delivered, counted for a person's list", () => {
  const IP = "127.0.0.1";
  const make = (p: { id: number }, rid: number, token: { id: number; name: string }, body: Record<string, unknown>) => createFinding(p.id, rid, token, IP, findingBody.parse(body)) as { id: number; auditId?: number };
  const delivered = (projectId: number, rid: number) => listRequests(projectId).find((r) => r.id === rid)!.delivered;

  it("counts what the discover made and what is still there, and says nothing for one that made nothing", () => {
    const p = makeProject("DLV1", "Delivered");
    const { token, take } = asDiscover(p.id, "deliver-agent");
    const rid = take();
    assert.equal(delivered(p.id, rid), null, "nothing made yet");
    const first = make(p, rid, token, { kind: "plan_item", title: "A" });
    make(p, rid, token, { kind: "plan_item", title: "B" });
    make(p, rid, token, { kind: "coverage_gap", description: "G" });
    const linked = make(p, rid, token, { kind: "test_case", title: "C1", planItem: "P-1" });
    make(p, rid, token, { kind: "test_case", title: "C2" });
    make(p, rid, token, { kind: "bug_report", title: "Bug" });
    make(p, rid, token, { kind: "observation", title: "Obs" });
    make(p, rid, token, { kind: "manual_test_suggestion", title: "Man" });
    assert.deepEqual(delivered(p.id, rid), { planItems: 2, coverageGaps: 1, cases: 2, bugs: 1, observations: 1, manualTests: 1 });

    db.prepare("INSERT INTO audit_plan_items (audit_id, source_id, position, title, origin, review_status) VALUES (?, 'H-1', 99, 'A person''s item', 'human', 'draft')").run(first.auditId);
    assert.equal(delivered(p.id, rid)!.planItems, 2, "a person's own plan item is not the agent's");
    db.prepare("DELETE FROM cases WHERE id = ?").run(linked.id);
    db.prepare("DELETE FROM audit_plan_items WHERE audit_id = ? AND source_id = 'P-2'").run(first.auditId);
    assert.deepEqual([delivered(p.id, rid)!.cases, delivered(p.id, rid)!.planItems], [1, 1], "what a person removed is not counted");

    completeRequest(p.id, rid, token, {});
    const other = asDiscover(p.id, "other-agent");
    assert.equal(delivered(p.id, other.take()), null, "another request that made nothing");
    assert.equal(delivered(p.id, rid)!.cases, 1, "and the first one still has its own");
  });

  it("records the request on every draft case the agent makes, linked to a plan item or not", () => {
    const p = makeProject("DLV2", "Delivered cases");
    const { token, take } = asDiscover(p.id, "case-agent");
    const rid = take();
    make(p, rid, token, { kind: "plan_item", title: "A" });
    const a = make(p, rid, token, { kind: "test_case", title: "Linked", planItem: "P-1" });
    const b = make(p, rid, token, { kind: "test_case", title: "Loose" });
    assert.deepEqual([a.id, b.id].map((id) => n("SELECT agent_request_id FROM cases WHERE id = ?", id)), [rid, rid]);
    const mine = db.prepare("INSERT INTO cases (project_id, number, title) VALUES (?, 99, 'A person''s case') RETURNING id").pluck().get(p.id) as number;
    assert.equal(db.prepare("SELECT agent_request_id AS r FROM cases WHERE id = ?").pluck().get(mine), null, "a person's case has none");
  });
});
