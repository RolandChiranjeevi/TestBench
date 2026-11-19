import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { claimRequest, completeRequest, createRequest } from "../server/agentrequests.ts";
import { AuditError } from "../server/auditcommon.ts";
import { createFinding, FINDING_LIMITS, findingBody } from "../server/agentfindings.ts";
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
