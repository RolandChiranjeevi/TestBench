import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { cancelRequest, claimRequest, completeRequest, createRequest, listRequests, releaseRequest } from "../server/agentrequests.ts";
import { caseResultsBody, CASE_RESULT_LIMITS, reportCaseResults, type CaseResultsBody } from "../server/agentresults.ts";
import { AuditError } from "../server/auditcommon.ts";
import { db, migrate } from "../server/db.ts";
import { createRequestToken } from "../server/requesttokens.ts";
import { makeCase, makeProject } from "./helpers.ts";

// AG5a: an agent reports a result for each test case of a run request. These are the rules of the batch itself (the route, the switch, the rate limit and the page are in
// agent-case-results-http.test.ts): what is written and marked, that a batch is all or nothing, that nothing a person did is written over and nothing is reported twice, what
// the audit holds, and what `complete` asks for.

const me = { name: "Tess Tester", userId: null };
const refused = (fn: () => unknown, status: number, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof AuditError && e.status === status && re.test(e.message), String(re));
const n = (sql: string, ...args: unknown[]) => db.prepare(sql).pluck().get(...args) as number;
const agent = (projectId: number, name = "claude-a") => { const t = createRequestToken(projectId, name); return { id: t.id, name, secret: t.token }; };
const batch = (...results: Record<string, unknown>[]) => caseResultsBody.parse({ results });

/** A project with `titles.length` cases (the first with two steps), a run request for all of them, taken by `claude-a`. */
function setup(key: string, titles = ["One", "Two", "Three"]) {
  const p = makeProject(key, key);
  const cases = titles.map((t, i) => makeCase(p.id, t, { steps: i === 0 ? [["Open /login", "A form"], ["Submit", "Signed in"]] : [["Do it", "It is done"]] }));
  const t = agent(p.id);
  const r = createRequest(p.id, { kind: "run", targetUrl: "https://staging.example.com", caseIds: cases.map((c) => c.id) }, me);
  claimRequest(p.id, r.id, t);
  const stepsOf = (caseId: number) => (db.prepare("SELECT id FROM case_steps WHERE case_id = ? ORDER BY position").all(caseId) as { id: number }[]).map((s) => s.id);
  const resultOf = (caseId: number) => db.prepare("SELECT * FROM results WHERE run_id = ? AND case_id = ?").get(r.runId, caseId) as Record<string, any>;
  const report = (b: CaseResultsBody, token = t) => reportCaseResults(p.id, r.id, token, "10.0.0.1", b);
  return { p, cases, t, r, stepsOf, resultOf, report };
}
const auditCount = () => n("SELECT COUNT(*) FROM audit_log WHERE action = 'agent_request.results_reported'");

describe("what a batch writes", () => {
  it("writes status, note, error, time taken and steps for each case, marks them with the token, sets the time itself, and counts by status", () => {
    const s = setup("WRT", ["One", "Two", "Three", "Four"]);
    const [c1, c2, c3, c4] = s.cases;
    const [st1, st2] = s.stepsOf(c1.id);
    const out = s.report(batch(
      { caseId: c1.id, status: "passed", note: "worked", durationMs: 1234, steps: [{ stepId: st1, status: "passed", actual: "A form" }, { stepId: st2, status: "passed" }] },
      { caseId: c2.id, status: "failed", error: "Expected 'In', got 'Out'", note: "saw the wrong page" },
      { caseId: c3.id, status: "blocked", note: "the staging site was down" },
      { caseId: c4.id, status: "skipped" },
    ));
    assert.deepEqual(out, { reported: 4, counts: { passed: 1, failed: 1, blocked: 1, skipped: 1 }, progress: { total: 4, reported: 4, missing: 0 } });
    const r1 = s.resultOf(c1.id);
    assert.deepEqual([r1.status, r1.notes, r1.error, r1.duration_ms, r1.reported_by_agent_token_id], ["passed", "worked", "", 1234, s.t.id]);
    assert.match(r1.executed_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "the server's time");
    assert.deepEqual(db.prepare("SELECT step_id, status, actual FROM step_results WHERE result_id = ? ORDER BY step_id").all(r1.id), [{ step_id: st1, status: "passed", actual: "A form" }, { step_id: st2, status: "passed", actual: "" }]);
    const r2 = s.resultOf(c2.id);
    assert.deepEqual([r2.status, r2.error, r2.notes, r2.duration_ms], ["failed", "Expected 'In', got 'Out'", "saw the wrong page", null]);
    assert.deepEqual([s.resultOf(c3.id).status, s.resultOf(c4.id).status], ["blocked", "skipped"]);
    for (const c of s.cases) assert.equal(s.resultOf(c.id).reported_by_agent_token_id, s.t.id, "every result is marked");
  });

  it("leaves the request taken and the run in progress: only a person finishes the run", () => {
    const s = setup("STY");
    s.report(batch(...s.cases.map((c) => ({ caseId: c.id, status: "passed" }))));
    assert.equal(n("SELECT COUNT(*) FROM agent_requests WHERE id = ? AND status = 'claimed'", s.r.id), 1);
    assert.equal(db.prepare("SELECT status FROM runs WHERE id = ?").pluck().get(s.r.runId), "in_progress");
  });

  it("takes several batches, each case once: the second batch is for the cases that are left", () => {
    const s = setup("SEV");
    const before = auditCount();
    assert.deepEqual(s.report(batch({ caseId: s.cases[0].id, status: "passed" })).progress, { total: 3, reported: 1, missing: 2 });
    assert.deepEqual(s.report(batch({ caseId: s.cases[1].id, status: "failed" }, { caseId: s.cases[2].id, status: "blocked" })).progress, { total: 3, reported: 3, missing: 0 });
    assert.equal(auditCount(), before + 2, "one audit entry for each batch");
  });
});

describe("the batch is checked as a whole", () => {
  it("accepts only passed, failed, blocked and skipped; untested and inconclusive are not results; extra fields, long text, 0 or too many results are refused", () => {
    const good = { caseId: 1, status: "passed" };
    assert.ok(caseResultsBody.safeParse({ results: [good] }).success);
    for (const status of ["untested", "inconclusive", "PASSED", "", 1, null]) assert.equal(caseResultsBody.safeParse({ results: [{ caseId: 1, status }] }).success, false, String(status));
    assert.equal(caseResultsBody.safeParse({ results: [{ ...good, extra: 1 }] }).success, false, "a field that is not listed is refused, never ignored");
    assert.equal(caseResultsBody.safeParse({ results: [good], extra: 1 }).success, false);
    assert.equal(caseResultsBody.safeParse({ results: [{ ...good, steps: [{ stepId: 1, status: "passed", extra: 1 }] }] }).success, false);
    assert.equal(caseResultsBody.safeParse({ results: [{ ...good, steps: [{ stepId: 1, status: "untested" }] }] }).success, false);
    assert.equal(caseResultsBody.safeParse({ results: [{ ...good, note: "x".repeat(2001) }] }).success, false);
    assert.equal(caseResultsBody.safeParse({ results: [{ ...good, error: "x".repeat(2001) }] }).success, false);
    assert.equal(caseResultsBody.safeParse({ results: [{ ...good, steps: [{ stepId: 1, status: "failed", actual: "x".repeat(2001) }] }] }).success, false);
    assert.ok(caseResultsBody.safeParse({ results: [{ ...good, note: "x".repeat(2000), error: "x".repeat(2000) }] }).success, "2000 is allowed");
    assert.equal(caseResultsBody.safeParse({ results: [{ ...good, durationMs: -1 }] }).success, false);
    assert.equal(caseResultsBody.safeParse({ results: [{ ...good, durationMs: 1.5 }] }).success, false);
    assert.equal(caseResultsBody.safeParse({ results: [{ ...good, caseId: "1" }] }).success, false);
    assert.equal(caseResultsBody.safeParse({ results: [] }).success, false);
    assert.equal(caseResultsBody.safeParse({}).success, false);
    assert.ok(caseResultsBody.safeParse({ results: Array.from({ length: CASE_RESULT_LIMITS.resultsPerCall }, (_, i) => ({ caseId: i + 1, status: "passed" })) }).success);
    assert.equal(caseResultsBody.safeParse({ results: Array.from({ length: CASE_RESULT_LIMITS.resultsPerCall + 1 }, (_, i) => ({ caseId: i + 1, status: "passed" })) }).success, false);
  });

  it("is all or nothing: one case that is not in the request, one that is given twice, or one that already has a result takes the whole batch down, and leaves no trace", () => {
    const s = setup("ALL");
    const other = makeCase(s.p.id, "Not in the request");
    const [c1, c2] = s.cases;
    const before = auditCount();
    const untouched = () => assert.deepEqual([n("SELECT COUNT(*) FROM results WHERE run_id = ? AND status != 'untested'", s.r.runId), n("SELECT COUNT(*) FROM results WHERE run_id = ? AND reported_by_agent_token_id IS NOT NULL", s.r.runId), auditCount()], [0, 0, before]);
    refused(() => s.report(batch({ caseId: c1.id, status: "passed" }, { caseId: other.id, status: "passed" })), 400, /1 of these test cases are not part of this request, so none of the batch was taken/);
    untouched();
    refused(() => s.report(batch({ caseId: c1.id, status: "passed" }, { caseId: c1.id, status: "failed" })), 400, /Each test case can be in a batch once/);
    untouched();
    db.prepare("UPDATE results SET status = 'passed', executed_at = datetime('now') WHERE run_id = ? AND case_id = ?").run(s.r.runId, c2.id); // a person
    refused(() => s.report(batch({ caseId: c1.id, status: "passed" }, { caseId: c2.id, status: "failed" })), 409, /1 of these test cases already have a result/);
    assert.equal(s.resultOf(c1.id).status, "untested", "the good one was not written either");
    assert.equal(s.resultOf(c1.id).reported_by_agent_token_id, null);
    assert.equal(auditCount(), before);
  });

  it("refuses a step that is not a step of that case, a step given twice, and a step that was deleted after the request was made; nothing is written", () => {
    const s = setup("STP");
    const [c1, c2] = s.cases;
    const [st1] = s.stepsOf(c1.id);
    const [foreign] = s.stepsOf(c2.id);
    const before = auditCount();
    refused(() => s.report(batch({ caseId: c1.id, status: "passed", steps: [{ stepId: foreign, status: "passed" }] })), 400, /is not a step of test case/);
    refused(() => s.report(batch({ caseId: c1.id, status: "passed", steps: [{ stepId: 999999, status: "passed" }] })), 400, /is not a step of test case/);
    refused(() => s.report(batch({ caseId: c1.id, status: "passed", steps: [{ stepId: st1, status: "passed" }, { stepId: st1, status: "failed" }] })), 400, /is given twice/);
    db.prepare("DELETE FROM case_steps WHERE id = ?").run(st1); // the request still lists it: it was asked with it
    refused(() => s.report(batch({ caseId: c1.id, status: "passed", steps: [{ stepId: st1, status: "passed" }] })), 409, /have changed since the request was made/);
    assert.deepEqual([s.resultOf(c1.id).status, n("SELECT COUNT(*) FROM step_results WHERE result_id IN (SELECT id FROM results WHERE run_id = ?)", s.r.runId), auditCount()], ["untested", 0, before]);
  });

  it("refuses a case that was deleted after the request was made, with the batch", () => {
    const s = setup("GON");
    const [c1, c2] = s.cases;
    db.prepare("DELETE FROM cases WHERE id = ?").run(c2.id);
    refused(() => s.report(batch({ caseId: c1.id, status: "passed" }, { caseId: c2.id, status: "passed" })), 409, /1 of these test cases have no result in the run any more/);
    assert.equal(s.resultOf(c1.id).status, "untested");
  });
});

describe("only a run request, only the token that took it, only while it is taken", () => {
  it("refuses a discover, a request nobody took, one that another token took, one that was given back, finished or cancelled; and one in another project", () => {
    const s = setup("WHO");
    const c = s.cases[0];
    const b = batch({ caseId: c.id, status: "passed" });
    // One request runs at a time in a project: the run request is given back while a discover is taken (then cancelled), and taken again.
    releaseRequest(s.p.id, s.r.id, s.t, { note: "to try a discover first" });
    const discover = createRequest(s.p.id, { kind: "discover", targetUrl: "https://staging.example.com" }, me);
    claimRequest(s.p.id, discover.id, s.t);
    refused(() => reportCaseResults(s.p.id, discover.id, s.t, "", b), 409, /only taken for a run request/);
    cancelRequest(discover.id);
    claimRequest(s.p.id, s.r.id, s.t);

    const fresh = createRequest(s.p.id, { kind: "run", targetUrl: "https://staging.example.com", caseIds: [c.id] }, me);
    refused(() => reportCaseResults(s.p.id, fresh.id, s.t, "", b), 409, /not taken/);

    const other = agent(s.p.id, "claude-b");
    refused(() => s.report(b, other), 409, /Another token took this request/);

    releaseRequest(s.p.id, s.r.id, s.t, { note: "no browser" });
    refused(() => s.report(b), 409, /not taken/);
    claimRequest(s.p.id, s.r.id, other);
    refused(() => s.report(b), 409, /Another token took this request/);
    assert.equal(s.report(b, other).reported, 1, "the one that took it now can");

    cancelRequest(s.r.id);
    refused(() => s.report(batch({ caseId: s.cases[1].id, status: "passed" }), other), 409, /already done or cancelled/);

    const elsewhere = makeProject("OTH", "Other");
    refused(() => reportCaseResults(elsewhere.id, s.r.id, other, "", b), 404, /Request not found/);
    refused(() => reportCaseResults(s.p.id, 999999, other, "", b), 404, /Request not found/);
    assert.equal(n("SELECT COUNT(*) FROM results WHERE run_id = ? AND status != 'untested'", s.r.runId), 1, "only the one report was written");
  });

  it("refuses a report for a request whose run was deleted", () => {
    const s = setup("RUN");
    db.prepare("DELETE FROM runs WHERE id = ?").run(s.r.runId);
    refused(() => s.report(batch({ caseId: s.cases[0].id, status: "passed" })), 409, /run of this request was deleted/);
  });
});

describe("nothing a person did is written over, and nothing is reported twice", () => {
  /** What a person can do to a result, one way each: the same writes the routes make. */
  const byPerson: [string, (resultId: number, stepId: number) => void][] = [
    ["set it", (id) => db.prepare("UPDATE results SET status = 'passed', executed_at = datetime('now') WHERE id = ?").run(id)],
    ["set it and put it back to untested", (id) => db.prepare("UPDATE results SET status = 'untested', executed_at = datetime('now') WHERE id = ?").run(id)],
    ["commented it", (id) => db.prepare("UPDATE results SET notes = 'my note' WHERE id = ?").run(id)],
    ["linked an issue to it", (id) => db.prepare("UPDATE results SET jira_key = 'PROJ-1' WHERE id = ?").run(id)],
    ["gave it a step result", (id, step) => db.prepare("INSERT INTO step_results (result_id, step_id, status, actual) VALUES (?, ?, 'passed', '')").run(id, step)],
    ["attached a file to it", (id) => db.prepare("INSERT INTO attachments (result_id, filename, stored_name, mime) VALUES (?, 'a.png', 'a.png', 'image/png')").run(id)],
  ];
  const state = (id: number) => JSON.stringify([db.prepare("SELECT * FROM results WHERE id = ?").get(id), db.prepare("SELECT * FROM step_results WHERE result_id = ?").all(id), db.prepare("SELECT filename FROM attachments WHERE result_id = ?").all(id)]);
  byPerson.forEach(([what, act], i) => {
    it(`a person ${what}: the agent cannot report it, and the person's work is as it was`, () => {
      const s = setup(`HU${i}`);
      const [c1, c2] = s.cases;
      const row = s.resultOf(c1.id);
      act(row.id, s.stepsOf(c1.id)[0]);
      const snapshot = state(row.id);
      const before = auditCount();
      refused(() => s.report(batch({ caseId: c1.id, status: "failed", note: "agent says failed" }, { caseId: c2.id, status: "passed" })), 409, /1 of these test cases already have a result/);
      assert.equal(state(row.id), snapshot);
      assert.equal(s.resultOf(c2.id).status, "untested", "and the rest of the batch was not taken");
      assert.equal(auditCount(), before);
      assert.equal(s.report(batch({ caseId: c2.id, status: "passed" })).reported, 1, "the case nobody touched can still be reported");
    });
  });

  it("a result the agent reported cannot be reported again, not even by a batch that is otherwise good; a person's later change stays, and so does the mark", () => {
    const s = setup("TWI");
    const [c1, c2] = s.cases;
    s.report(batch({ caseId: c1.id, status: "passed", note: "first" }));
    refused(() => s.report(batch({ caseId: c1.id, status: "failed", note: "second" }, { caseId: c2.id, status: "passed" })), 409, /already have a result/);
    assert.deepEqual([s.resultOf(c1.id).status, s.resultOf(c1.id).notes, s.resultOf(c2.id).status], ["passed", "first", "untested"]);
    db.prepare("UPDATE results SET status = 'failed', notes = 'a person changed this', executed_at = datetime('now') WHERE id = ?").run(s.resultOf(c1.id).id);
    assert.equal(s.resultOf(c1.id).reported_by_agent_token_id, s.t.id, "the mark stays when a person changes the result");
    refused(() => s.report(batch({ caseId: c1.id, status: "passed" })), 409, /already have a result/);
  });

  it("also refuses a result put back to untested after the agent reported it, even by a reset that left no other trace", () => {
    const s = setup("RST");
    const c = s.cases[0];
    s.report(batch({ caseId: c.id, status: "passed" }));
    db.prepare("UPDATE results SET status = 'untested', executed_at = NULL, notes = '' WHERE case_id = ? AND run_id = ?").run(c.id, s.r.runId);
    refused(() => s.report(batch({ caseId: c.id, status: "failed" })), 409, /already have a result/);
  });
});

describe("the audit entry", () => {
  it("is one entry per batch, by 'agent: <name>', with the counts and the credential id, and never a token or a hash", () => {
    const s = setup("AUD");
    const [c1, c2, c3] = s.cases;
    s.report(batch({ caseId: c1.id, status: "passed", note: "SECRET-NOTE" }, { caseId: c2.id, status: "failed", error: "SECRET-ERROR" }));
    s.report(batch({ caseId: c3.id, status: "blocked" }));
    const rows = db.prepare("SELECT actor_user_id, actor_label, action, project_id, ip, detail FROM audit_log WHERE action = 'agent_request.results_reported' AND project_id = ? ORDER BY id").all(s.p.id) as Record<string, any>[];
    assert.equal(rows.length, 2);
    assert.deepEqual([rows[0].actor_user_id, rows[0].actor_label, rows[0].ip], [null, "agent: claude-a", "10.0.0.1"], "'agent:' with a space, then the name");
    assert.deepEqual(JSON.parse(rows[0].detail), { request: s.r.id, kind: "run", run: s.r.runId, credential_id: s.t.id, reported: 2, passed: 1, failed: 1, blocked: 0, skipped: 0 });
    assert.deepEqual(JSON.parse(rows[1].detail), { request: s.r.id, kind: "run", run: s.r.runId, credential_id: s.t.id, reported: 1, passed: 0, failed: 0, blocked: 1, skipped: 0 });
    const all = JSON.stringify(db.prepare("SELECT * FROM audit_log").all());
    for (const leak of [s.t.secret, "SECRET-NOTE", "SECRET-ERROR"]) assert.equal(all.includes(leak), false, "not in the audit log");
    assert.doesNotMatch(all, /token_hash|"hash"|tbrq_/);
  });
});

describe("complete", () => {
  it("is refused with the number of cases that have no result, until every case has one; then it finishes the request, links the run, and leaves the run in progress", () => {
    const s = setup("CMP");
    const [c1, c2, c3] = s.cases;
    refused(() => completeRequest(s.p.id, s.r.id, s.t, {}), 409, /^3 of 3 test cases have no result yet/);
    s.report(batch({ caseId: c1.id, status: "passed" }));
    refused(() => completeRequest(s.p.id, s.r.id, s.t, {}), 409, /^2 of 3 test cases have no result yet/);
    s.report(batch({ caseId: c2.id, status: "failed" }));
    refused(() => completeRequest(s.p.id, s.r.id, s.t, { note: "x" }), 409, /^1 of 3 test cases have no result yet/);
    assert.equal(n("SELECT COUNT(*) FROM agent_requests WHERE id = ? AND status = 'claimed'", s.r.id), 1, "a refused complete changes nothing");
    s.report(batch({ caseId: c3.id, status: "blocked" }));
    const done = completeRequest(s.p.id, s.r.id, s.t, { note: "all run" });
    assert.deepEqual([done.status, done.resultRunId, done.resultNote, done.progress], ["done", s.r.runId, "all run", { total: 3, reported: 3, missing: 0 }]);
    assert.equal(db.prepare("SELECT status FROM runs WHERE id = ?").pluck().get(s.r.runId), "in_progress", "a person reviews the run and finishes it");
    refused(() => completeRequest(s.p.id, s.r.id, s.t, {}), 409, /already done or cancelled/);
  });

  it("counts a result a person set by hand as done, and a case that was deleted as not missing", () => {
    const s = setup("MAN");
    const [c1, c2, c3] = s.cases;
    db.prepare("UPDATE results SET status = 'passed', executed_at = datetime('now') WHERE run_id = ? AND case_id = ?").run(s.r.runId, c1.id);
    db.prepare("DELETE FROM cases WHERE id = ?").run(c3.id);
    refused(() => completeRequest(s.p.id, s.r.id, s.t, {}), 409, /^1 of 2 test cases have no result yet/);
    s.report(batch({ caseId: c2.id, status: "passed" }));
    assert.equal(completeRequest(s.p.id, s.r.id, s.t, {}).status, "done");
  });

  it("is for the token that took the request, and TestBench links the run itself: another run id is refused", () => {
    const s = setup("TOK");
    s.report(batch(...s.cases.map((c) => ({ caseId: c.id, status: "passed" }))));
    refused(() => completeRequest(s.p.id, s.r.id, agent(s.p.id, "claude-b"), {}), 409, /Another token took this request/);
    const another = createRequest(s.p.id, { kind: "run", targetUrl: "https://staging.example.com", caseIds: [s.cases[0].id] }, me);
    refused(() => completeRequest(s.p.id, s.r.id, s.t, { resultRunId: another.runId }), 400, /links the run of a run request itself/);
    refused(() => completeRequest(s.p.id, s.r.id, s.t, { resultRunId: 999999 }), 400, /not a run in this project/);
    assert.equal(completeRequest(s.p.id, s.r.id, s.t, { resultRunId: s.r.runId }).status, "done", "naming its own run is harmless");
  });

  it("can be released with some results reported: they stay, the request waits again, and another token reports the rest and finishes it", () => {
    const s = setup("REL");
    const [c1, c2, c3] = s.cases;
    s.report(batch({ caseId: c1.id, status: "passed", note: "kept" }));
    const back = releaseRequest(s.p.id, s.r.id, s.t, { note: "ran out of time" });
    assert.deepEqual([back.status, back.progress], ["pending", { total: 3, reported: 1, missing: 2 }], "a new agent sees what is left");
    assert.deepEqual([s.resultOf(c1.id).status, s.resultOf(c1.id).notes, s.resultOf(c1.id).reported_by_agent_token_id], ["passed", "kept", s.t.id]);
    const b = agent(s.p.id, "claude-b");
    const taken = claimRequest(s.p.id, s.r.id, b);
    assert.equal(taken.progress!.missing, 2);
    refused(() => s.report(batch({ caseId: c1.id, status: "failed" }), b), 409, /already have a result/);
    s.report(batch({ caseId: c2.id, status: "failed" }, { caseId: c3.id, status: "skipped" }), b);
    assert.equal(completeRequest(s.p.id, s.r.id, b, {}).status, "done");
    assert.deepEqual([s.resultOf(c1.id).reported_by_agent_token_id, s.resultOf(c2.id).reported_by_agent_token_id], [s.t.id, b.id], "each result keeps the mark of the token that reported it");
  });
});

describe("the view of a request", () => {
  it("has progress for a run request, in the list too, and null for a discover", () => {
    const s = setup("VEW");
    s.report(batch({ caseId: s.cases[0].id, status: "passed" }));
    const discover = createRequest(s.p.id, { kind: "discover", targetUrl: "https://staging.example.com" }, me);
    const list = listRequests(s.p.id);
    assert.deepEqual(list.find((x) => x.id === s.r.id)!.progress, { total: 3, reported: 1, missing: 2 });
    assert.equal(list.find((x) => x.id === discover.id)!.progress, null);
    assert.equal(discover.progress, null);
  });
});

describe("a database from before agent results", () => {
  it("gets the column, and every result is as it was, with no mark", () => {
    const d = new Database(":memory:");
    d.pragma("foreign_keys = ON");
    migrate(d);
    d.exec("INSERT INTO projects (name, key) VALUES ('Old', 'OLD')");
    d.exec("INSERT INTO runs (project_id, title, kind, source) VALUES (1, 'Old run', 'manual', 'manual')");
    d.exec("INSERT INTO results (run_id, status, notes, executed_at) VALUES (1, 'passed', 'kept', '2026-01-01 00:00:00'), (1, 'untested', '', NULL)");
    d.exec("ALTER TABLE results DROP COLUMN reported_by_agent_token_id");
    const has = () => (d.prepare("PRAGMA table_info(results)").all() as { name: string }[]).filter((c) => c.name === "reported_by_agent_token_id").length;
    assert.equal(has(), 0, "the test builds an old table");
    const before = JSON.stringify(d.prepare("SELECT id, run_id, status, notes, executed_at FROM results ORDER BY id").all());
    migrate(d);
    migrate(d); // and again: nothing to do
    assert.equal(has(), 1);
    assert.equal(JSON.stringify(d.prepare("SELECT id, run_id, status, notes, executed_at FROM results ORDER BY id").all()), before);
    assert.deepEqual(d.prepare("SELECT reported_by_agent_token_id AS m FROM results ORDER BY id").all(), [{ m: null }, { m: null }]);
  });
});
