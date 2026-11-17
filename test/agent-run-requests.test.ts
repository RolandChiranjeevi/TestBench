import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { agentRequestOfRun, cancelRequest, claimRequest, completeRequest, createRequest, listRequests, pendingForAgent, releaseRequest, REQUEST_LIMITS } from "../server/agentrequests.ts";
import { AuditError } from "../server/auditcommon.ts";
import { db, migrate } from "../server/db.ts";
import { createRequirement, addRequirementCases } from "../server/requirements.ts";
import { createRequestToken } from "../server/requesttokens.ts";
import { createSpec } from "../server/specs.ts";
import { makeCase, makeProject } from "./helpers.ts";

// AG4: a person asks an agent to run chosen test cases. The run is made at once, with an empty result for each case, and the request points at it. These are the rules of the
// request itself (the route, the page and the audit are in agent-run-requests-http.test.ts): what is made, what the payload holds and never holds, the limits, that it is
// all or nothing, what an agent can do with it (take it, give it back, not finish it yet), and the step from a database that does not know the kind.

const me = { name: "Tess Tester", userId: null };
const URL_OK = "https://staging.example.com";
const refused = (fn: () => unknown, status: number, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof AuditError && e.status === status && re.test(e.message), String(re));
const n = (sql: string, ...args: unknown[]) => db.prepare(sql).pluck().get(...args) as number;
const ask = (projectId: number, caseIds: number[], extra: Record<string, unknown> = {}) => createRequest(projectId, { kind: "run", targetUrl: URL_OK, caseIds, ...extra }, me);
const agent = (projectId: number, name = "claude-a") => { const t = createRequestToken(projectId, name); return { id: t.id, name }; };

describe("asking for a run", () => {
  it("makes the run and the request together: a manual run with an empty result for each case, in the order of the case list, that says which request it was asked by", () => {
    const p = makeProject("RUN", "Run");
    const second = makeCase(p.id, "Second", { steps: [["Open /pay", "A form"]] });
    const first = makeCase(p.id, "First", { steps: [["Open /login", "A form"], ["Submit", "In"]] });
    const r = ask(p.id, [first.id, second.id], { environment: " staging ", note: " look at the checkout " }); // chosen in the other order
    assert.deepEqual([r.kind, r.status, r.targetUrl, r.environment, r.note, r.caseCount], ["run", "pending", "https://staging.example.com/", "staging", "look at the checkout", 2]);
    assert.ok(r.runId);
    const run = db.prepare("SELECT kind, source, status, environment, title, meta, template_id FROM runs WHERE id = ?").get(r.runId) as Record<string, any>;
    assert.deepEqual([run.kind, run.source, run.status, run.environment, run.template_id], ["manual", "manual", "in_progress", "staging", null]);
    assert.match(run.title, /^Agent run · \d{4}-\d{2}-\d{2}$/, "a default name when none is given");
    assert.deepEqual(JSON.parse(run.meta), { agentRequest: r.id }, "the run says which request it was asked by, and is not 'handed in by an agent'");
    const results = db.prepare("SELECT case_id, status FROM results WHERE run_id = ? ORDER BY position").all(r.runId) as { case_id: number; status: string }[];
    assert.deepEqual(results.map((x) => [x.case_id, x.status]), [[second.id, "untested"], [first.id, "untested"]], "untested, in the order of the case list");
    assert.deepEqual(agentRequestOfRun(r.runId!), { id: r.id, status: "pending", claimedBy: null });
    assert.equal(agentRequestOfRun(999999), null);
  });

  it("holds exactly the approved structure: the run, the address, the environment, the note and, for each case, its text, steps, test names and spec file names", () => {
    const p = makeProject("PLD", "Payload");
    const c = makeCase(p.id, "Sign in", { steps: [["Open /login", "A form"], ["Submit", "Signed in"]] });
    db.prepare("UPDATE cases SET description = 'The happy path', preconditions = 'An account exists', priority = 'high' WHERE id = ?").run(c.id);
    db.prepare("INSERT INTO automated_tests (project_id, framework, file, title, full_name, case_id) VALUES (?, 'playwright', 'tests/login.spec.ts', 'signs in', 'login > signs in', ?)").run(p.id, c.id);
    createSpec(p.id, { fileName: "login.spec.ts", text: "test('signs in', async () => {})", caseId: c.id });
    const r = ask(p.id, [c.id], { environment: "staging", title: "My agent run" });
    const payload = JSON.parse(db.prepare("SELECT payload FROM agent_requests WHERE id = ?").pluck().get(r.id) as string);
    assert.deepEqual(Object.keys(payload), ["runId", "targetUrl", "environment", "note", "cases"]);
    assert.deepEqual([payload.runId, payload.targetUrl, payload.environment, payload.note], [r.runId, "https://staging.example.com/", "staging", ""]);
    assert.equal(payload.cases.length, 1);
    const k = payload.cases[0];
    assert.deepEqual(Object.keys(k), ["caseId", "key", "number", "title", "description", "preconditions", "priority", "steps", "automatedTests", "specFiles"]);
    assert.deepEqual([k.caseId, k.key, k.number, k.title, k.description, k.preconditions, k.priority], [c.id, `PLD-${c.number}`, c.number, "Sign in", "The happy path", "An account exists", "high"]);
    assert.deepEqual(k.steps.map((s: Record<string, unknown>) => Object.keys(s)), [["id", "action", "expected"], ["id", "action", "expected"]]);
    assert.deepEqual(k.steps.map((s: { action: string; expected: string }) => [s.action, s.expected]), [["Open /login", "A form"], ["Submit", "Signed in"]]);
    assert.deepEqual(k.automatedTests, [{ framework: "playwright", file: "tests/login.spec.ts", fullName: "login > signs in" }]);
    assert.deepEqual(k.specFiles, ["login.spec.ts"]);
    assert.equal(db.prepare("SELECT title FROM runs WHERE id = ?").pluck().get(r.runId), "My agent run", "the name that was given");
  });

  it("never holds the text of a spec or of a requirement, and not the text of a case that was not chosen", () => {
    const p = makeProject("LEK", "Leak");
    const chosen = makeCase(p.id, "Chosen");
    makeCase(p.id, "Not chosen", { steps: [["SECRET-OTHER-CASE-STEP", ""]] });
    createSpec(p.id, { fileName: "chosen.spec.ts", text: "// SECRET-SPEC-TEXT\ntest('x', async () => {})", caseId: chosen.id });
    const req = createRequirement(p.id, { title: "SECRET-REQUIREMENT-TITLE", description: "SECRET-REQUIREMENT-TEXT", acceptanceCriteria: "SECRET-CRITERIA" });
    addRequirementCases(req, p.id, [chosen.id]);
    const r = ask(p.id, [chosen.id]);
    const everything = JSON.stringify(db.prepare("SELECT * FROM agent_requests WHERE id = ?").get(r.id)) + JSON.stringify(claimRequest(p.id, r.id, agent(p.id)));
    for (const secret of ["SECRET-SPEC-TEXT", "SECRET-REQUIREMENT-TITLE", "SECRET-REQUIREMENT-TEXT", "SECRET-CRITERIA", "SECRET-OTHER-CASE-STEP"]) assert.equal(everything.includes(secret), false, secret);
    assert.ok(everything.includes("chosen.spec.ts"), "the spec's file name is there, and only that");
  });

  it("makes the run in the suite it was asked from, and refuses another project's suite", () => {
    const p = makeProject("SUI", "Suite");
    const other = makeProject("SU2", "Suite two");
    const c = makeCase(p.id, "A case");
    const tpl = db.prepare("INSERT INTO run_templates (project_id, name, environment) VALUES (?, 'Smoke', '') RETURNING id").get(p.id) as { id: number };
    db.prepare("INSERT INTO run_template_cases (template_id, case_id) VALUES (?, ?)").run(tpl.id, c.id);
    const foreign = db.prepare("INSERT INTO run_templates (project_id, name, environment) VALUES (?, 'Theirs', '') RETURNING id").get(other.id) as { id: number };
    const r = ask(p.id, [c.id], { templateId: tpl.id });
    const run = db.prepare("SELECT template_id, meta FROM runs WHERE id = ?").get(r.runId) as { template_id: number; meta: string };
    assert.equal(run.template_id, tpl.id);
    assert.deepEqual(JSON.parse(run.meta), { suite: { id: tpl.id, name: "Smoke" }, agentRequest: r.id });
    refused(() => ask(p.id, [c.id], { templateId: foreign.id }), 400, /another project/);
    refused(() => ask(p.id, [c.id], { templateId: "x" }), 400, /by its id/);
  });
});

describe("what is refused, and that nothing is made then", () => {
  it("answers 400 for no cases, a case that is not in the project, a deprecated case, no address and a bad address, and makes neither a run nor a request", () => {
    const p = makeProject("REF", "Refuse");
    const other = makeProject("RE2", "Other");
    const ok = makeCase(p.id, "Fine");
    const old = makeCase(p.id, "Old", { status: "deprecated" });
    const foreign = makeCase(other.id, "Theirs");
    const counts = () => [n("SELECT COUNT(*) FROM runs"), n("SELECT COUNT(*) FROM results"), n("SELECT COUNT(*) FROM agent_requests")];
    const before = counts();
    refused(() => ask(p.id, []), 400, /needs the test cases/);
    refused(() => createRequest(p.id, { kind: "run", targetUrl: URL_OK }, me), 400, /needs the test cases/);
    refused(() => ask(p.id, "1" as unknown as number[]), 400, /needs the test cases/);
    refused(() => ask(p.id, [ok.id, 1.5]), 400, /by their ids/);
    refused(() => ask(p.id, [ok.id, "7" as unknown as number]), 400, /by their ids/);
    refused(() => ask(p.id, [ok.id, foreign.id]), 400, /not in this project/);
    refused(() => ask(p.id, [999999]), 400, /not in this project/);
    refused(() => ask(p.id, [ok.id, old.id]), 400, /1 of the test cases is deprecated and cannot be run: REF-\d+/);
    refused(() => createRequest(p.id, { kind: "run", caseIds: [ok.id] }, me), 400, /needs the address/);
    refused(() => createRequest(p.id, { kind: "run", targetUrl: "ftp://x.example.com", caseIds: [ok.id] }, me), 400, /http/);
    refused(() => createRequest(p.id, { kind: "run", targetUrl: "https://user:pw@x.example.com", caseIds: [ok.id] }, me), 400, /user name or password/);
    refused(() => createRequest(p.id, { kind: "run", targetUrl: "https://x.example.com/?api_key=1", caseIds: [ok.id] }, me), 400, /looks like a secret/);
    refused(() => ask(p.id, [ok.id], { title: "x".repeat(REQUEST_LIMITS.runTitleMax + 1) }), 400, /run name can be at most/);
    refused(() => ask(p.id, [ok.id], { environment: 7 }), 400, /must be text/);
    refused(() => ask(999999, [ok.id]), 404, /Project not found/);
    assert.deepEqual(counts(), before, "no run, no result and no request");
    ask(p.id, [ok.id, ok.id]); // the same case twice is one case
    assert.equal(n("SELECT COUNT(*) FROM results WHERE run_id = (SELECT MAX(id) FROM runs)"), 1);
  });

  it("takes 200 test cases and refuses 201: pick fewer", () => {
    const p = makeProject("CAP", "Cap");
    const ids = Array.from({ length: REQUEST_LIMITS.runCasesMax + 1 }, (_, i) => makeCase(p.id, `Case ${i}`).id);
    assert.equal(REQUEST_LIMITS.runCasesMax, 200);
    refused(() => ask(p.id, ids), 400, /At most 200 test cases .* Pick fewer/);
    assert.equal(ask(p.id, ids.slice(0, 200)).caseCount, 200);
  });

  it("refuses more than 1 MB of test case text with 'pick fewer', and does not cut anything off", () => {
    const p = makeProject("BIG", "Big");
    const ids = Array.from({ length: 25 }, (_, i) => {
      const c = makeCase(p.id, `Big ${i}`);
      db.prepare("UPDATE cases SET description = ? WHERE id = ?").run("d".repeat(50_000), c.id);
      return c.id;
    });
    assert.equal(REQUEST_LIMITS.runPayloadBytes, 1024 * 1024);
    refused(() => ask(p.id, ids), 400, /too much text for one request \(more than 1 MB\)\. Pick fewer/);
    const r = ask(p.id, ids.slice(0, 15));
    const kept = JSON.parse(db.prepare("SELECT payload FROM agent_requests WHERE id = ?").pluck().get(r.id) as string).cases as { description: string }[];
    assert.ok(kept.every((k) => k.description.length === 50_000), "whole text, never shortened");
  });

  it("is all or nothing: when the request cannot be written the run is not made either", () => {
    const p = makeProject("ATM", "Atomic");
    const c = makeCase(p.id, "One");
    db.exec("CREATE TRIGGER fail_run_request BEFORE INSERT ON agent_requests BEGIN SELECT RAISE(ABORT, 'boom'); END");
    try {
      const before = [n("SELECT COUNT(*) FROM runs"), n("SELECT COUNT(*) FROM results")];
      assert.throws(() => ask(p.id, [c.id]), /boom/);
      assert.deepEqual([n("SELECT COUNT(*) FROM runs"), n("SELECT COUNT(*) FROM results")], before);
    } finally {
      db.exec("DROP TRIGGER fail_run_request");
    }
  });

  it("counts a run request among the 20 that can wait", () => {
    const p = makeProject("PND", "Pending");
    const c = makeCase(p.id, "One");
    for (let i = 0; i < REQUEST_LIMITS.pendingPerProject; i++) ask(p.id, [c.id]);
    refused(() => ask(p.id, [c.id]), 409, /At most 20/);
    assert.equal(n("SELECT COUNT(*) FROM runs WHERE project_id = ?", p.id), 20, "the refused one made no run");
  });
});

describe("what an agent sees and can do", () => {
  it("a list carries the number of cases but not their text; taking the request gives the cases", () => {
    const p = makeProject("LST", "List");
    const c = makeCase(p.id, "Has steps", { steps: [["Do it", "Done"]] });
    const r = ask(p.id, [c.id]);
    const person = listRequests(p.id).find((x) => x.id === r.id)!;
    assert.deepEqual([person.caseCount, person.cases], [1, []]);
    const waiting = pendingForAgent(p.id).find((x) => x.id === r.id)!;
    assert.deepEqual([waiting.caseCount, waiting.cases], [1, []]);
    const taken = claimRequest(p.id, r.id, agent(p.id));
    assert.equal(taken.cases.length, 1);
    assert.deepEqual([taken.cases[0].title, taken.cases[0].steps.map((s) => s.action), taken.runId], ["Has steps", ["Do it"], r.runId]);
  });

  it("can be taken and given back, can be cancelled by a person, and cannot be finished: complete answers 409 in every state", () => {
    const p = makeProject("STA", "State");
    const c = makeCase(p.id, "One");
    const t = agent(p.id);
    const other = agent(p.id, "claude-b");
    const r = ask(p.id, [c.id]);
    refused(() => completeRequest(p.id, r.id, t, {}), 409, /not possible yet/);
    claimRequest(p.id, r.id, t);
    assert.deepEqual(agentRequestOfRun(r.runId!), { id: r.id, status: "claimed", claimedBy: "agent: claude-a" });
    refused(() => completeRequest(p.id, r.id, t, { note: "done" }), 409, /A run request is finished when a result has been reported for every test case/);
    refused(() => completeRequest(p.id, r.id, other, {}), 409, /not possible yet/);
    const back = releaseRequest(p.id, r.id, t, { note: "no browser here" });
    assert.deepEqual([back.status, back.releaseNote, back.cases.length], ["pending", "no browser here", 1]);
    assert.equal(agentRequestOfRun(r.runId!)!.status, "pending");
    refused(() => completeRequest(p.id, r.id, t, {}), 409, /not possible yet/);
    claimRequest(p.id, r.id, other);
    assert.equal(cancelRequest(r.id).status, "cancelled");
    assert.deepEqual(agentRequestOfRun(r.runId!), { id: r.id, status: "cancelled", claimedBy: "agent: claude-b" });
    assert.equal(n("SELECT COUNT(*) FROM runs WHERE id = ?", r.runId), 1, "the run is kept");
    assert.equal(n("SELECT COUNT(*) FROM results WHERE run_id = ? AND status = 'untested'", r.runId), 1, "and can be run by hand");
  });

  it("a request whose run was deleted is not offered, cannot be taken, and can be cancelled", () => {
    const p = makeProject("DEL", "Deleted");
    const c = makeCase(p.id, "One");
    const t = agent(p.id);
    const gone = ask(p.id, [c.id]);
    const kept = ask(p.id, [c.id]);
    db.prepare("DELETE FROM runs WHERE id = ?").run(gone.runId);
    assert.equal(db.prepare("SELECT run_id FROM agent_requests WHERE id = ?").pluck().get(gone.id), null);
    assert.deepEqual(pendingForAgent(p.id).map((x) => x.id), [kept.id]);
    refused(() => claimRequest(p.id, gone.id, t), 409, /run of this request was deleted/);
    assert.equal(listRequests(p.id).find((x) => x.id === gone.id)!.runId, null, "a person still sees it, with no run");
    assert.equal(cancelRequest(gone.id).status, "cancelled");
    assert.equal(claimRequest(p.id, kept.id, t).id, kept.id);
  });
});

describe("a database from before the run kind", () => {
  /** A database as it was: the agent_requests table with the old CHECK, and rows of the kinds that existed, every column filled. */
  const old = () => {
    const d = new Database(":memory:");
    d.pragma("foreign_keys = ON");
    migrate(d);
    d.exec("INSERT INTO projects (name, key) VALUES ('Old', 'OLD')");
    d.exec("INSERT INTO runs (project_id, title, kind, source) VALUES (1, 'CI', 'automated', 'upload')");
    d.prepare(`INSERT INTO agent_requests (project_id, kind, target_url, environment, note, run_id, payload, status, created_by, created_by_user_id, claimed_by, claimed_token_id, claimed_at,
        finished_at, result_run_id, result_note, result_delivered_at, release_note, released_by, released_at, findings_count)
      VALUES (1, 'discover', 'https://a.example/', 'staging', 'n1', NULL, '{"tests":[]}', 'claimed', 'Tess', 7, 'agent: x', 3, '2026-01-02 03:04:05', NULL, NULL, '', NULL, 'gave back once', 'agent: y', '2026-01-01 00:00:00', 5),
        (1, 'rerun', '', 'ci', '', 1, '{"tests":[{"id":1}]}', 'done', 'Tess', NULL, 'agent: x', 3, '2026-01-02 03:04:05', '2026-01-02 04:00:00', 1, 'ok', '2026-01-02 03:59:00', '', NULL, NULL, 0)`).run();
    d.pragma("foreign_keys = OFF");
    const ddl = d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_requests'").pluck().get() as string;
    const oldDdl = ddl.replace(", 'run'", "");
    assert.notEqual(oldDdl, ddl, "the test builds an old table");
    d.exec("ALTER TABLE agent_requests RENAME TO agent_requests_now");
    d.exec(oldDdl);
    d.exec("INSERT INTO agent_requests SELECT * FROM agent_requests_now");
    d.exec("DROP TABLE agent_requests_now");
    d.exec("CREATE INDEX agent_requests_project ON agent_requests(project_id, status)");
    d.pragma("foreign_keys = ON");
    return d;
  };
  const ddlOf = (d: Database.Database) => d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_requests'").pluck().get() as string;
  const insertRun = (d: Database.Database) => d.prepare("INSERT INTO agent_requests (project_id, kind, target_url, payload) VALUES (1, 'run', 'https://a.example/', '{}')").run();

  it("takes the run kind with every row and every column kept, and the index and the links to projects and runs back", () => {
    const d = old();
    assert.throws(() => insertRun(d), /CHECK/);
    const before = JSON.stringify(d.prepare("SELECT * FROM agent_requests ORDER BY id").all());
    migrate(d);
    assert.match(ddlOf(d), /'discover', 'rerun', 'run'/);
    assert.equal(JSON.stringify(d.prepare("SELECT * FROM agent_requests ORDER BY id").all()), before, "every column of every row is as it was");
    assert.equal(d.prepare("SELECT findings_count FROM agent_requests WHERE id = 1").pluck().get(), 5);
    assert.equal(d.prepare("SELECT release_note FROM agent_requests WHERE id = 1").pluck().get(), "gave back once");
    assert.doesNotThrow(() => insertRun(d));
    assert.throws(() => d.prepare("INSERT INTO agent_requests (project_id, kind, payload) VALUES (1, 'nonsense', '{}')").run(), /CHECK/, "the CHECK still refuses what it should");
    assert.ok(d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'agent_requests_project'").get(), "the index is back");
    const fks = (d.prepare("PRAGMA foreign_key_list(agent_requests)").all() as { table: string }[]).map((f) => f.table).sort();
    assert.deepEqual(fks, ["audits", "projects", "runs", "runs"]);
    d.exec("DELETE FROM runs WHERE id = 1");
    assert.equal(d.prepare("SELECT run_id FROM agent_requests WHERE id = 2").pluck().get(), null, "a deleted run still unlinks the request");
    assert.equal(d.prepare("PRAGMA foreign_keys").pluck().get(), 1, "foreign keys are back on");
  });

  it("does it once: another start changes nothing", () => {
    const d = old();
    migrate(d);
    const once = ddlOf(d);
    const rows = JSON.stringify(d.prepare("SELECT * FROM agent_requests ORDER BY id").all());
    migrate(d);
    migrate(d);
    assert.equal(ddlOf(d), once);
    assert.equal(JSON.stringify(d.prepare("SELECT * FROM agent_requests ORDER BY id").all()), rows);
  });

  it("a new database allows the run kind from the start", () => {
    const d = new Database(":memory:");
    migrate(d);
    assert.match(ddlOf(d), /'run'/);
  });
});
