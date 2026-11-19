import "./env.ts";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { agentRequestOfRun, cancelRequest, claimRequest, completeRequest, createRequest, releaseRequest, RESULT_LIMITS, setAgentResultsEnabled, submitResult } from "../server/agentrequests.ts";
import { caseResultsBody, reportCaseResults } from "../server/agentresults.ts";
import { AuditError } from "../server/auditcommon.ts";
import { db } from "../server/db.ts";
import { importReport } from "../server/importers/import.ts";
import { parseReport } from "../server/importers/parse.ts";
import { createRequirement, latestStatusByCase } from "../server/requirements.ts";
import { createRequestToken } from "../server/requesttokens.ts";
import { createSpec, listSpecs } from "../server/specs.ts";
import { makeCase, makeProject } from "./helpers.ts";

// AG5b: the agent that took a run request (or a re-run) hands in the Playwright report. These are the rules of the report itself (the route, the limits and the page are in
// agent-run-reports-http.test.ts): which tests it may hold, that TestBench decides which case a test belongs to and the text of the report decides nothing, that the report is a new
// automated run that touches neither the manual run nor the results reported for it, that it reaches a spec by file name and a case by link, that a refused report leaves no trace, and
// what happens to release, complete and the audit log.

const me = { name: "Tess Tester", userId: null };
const URL_OK = "https://staging.example.com";
const IP = "10.0.0.1";
before(() => setAgentResultsEnabled(true));
after(() => setAgentResultsEnabled(false));

const refused = (fn: () => unknown, status: number, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof AuditError && e.status === status && re.test(e.message), String(re));
const n = (sql: string, ...args: unknown[]) => db.prepare(sql).pluck().get(...args) as number;
const one = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as Record<string, any> | undefined;
const agent = (projectId: number, name = "claude-a") => { const t = createRequestToken(projectId, name); return { id: t.id, name, secret: t.token }; };

type T = { file: string; title: string; status?: "passed" | "failed" | "skipped"; tags?: string[] };
const HEAD = { config: { rootDir: "/repo" }, stats: { startTime: "2026-01-02T03:04:05.000Z" } };
/** A Playwright JSON report: one spec per test, each a test of project "chromium". */
const pw = (tests: T[]) => ({
  ...HEAD,
  suites: [...new Set(tests.map((t) => t.file))].map((file) => ({
    title: file, file,
    specs: tests.filter((t) => t.file === file).map((t) => {
      const s = t.status ?? "passed";
      return {
        title: t.title, file, line: 3, column: 1, ...(t.tags ? { tags: t.tags } : {}),
        tests: [{ projectName: "chromium", status: s === "passed" ? "expected" : s === "failed" ? "unexpected" : "skipped", results: [{ status: s, duration: 12, retry: 0, ...(s === "failed" ? { error: { message: "boom" } } : {}) }] }],
      };
    }),
  })),
});
const emptyReport = { ...HEAD, suites: [{ title: "x.spec.ts", file: "x.spec.ts", specs: [] }] };
/** What TestBench calls a test of such a report. */
const fullName = (file: string, title: string) => `${file} › ${title} [chromium]`;
const known = (projectId: number, file: string, title: string, caseId: number | null) =>
  db.prepare("INSERT INTO automated_tests (project_id, framework, file, title, full_name, case_id) VALUES (?, 'playwright', ?, ?, ?, ?) RETURNING id").pluck().get(projectId, file, `${title} [chromium]`, fullName(file, title), caseId) as number;
const testRow = (projectId: number, file: string, title: string) => one("SELECT * FROM automated_tests WHERE project_id = ? AND full_name = ?", projectId, fullName(file, title));
/** An automated run with one failed test per title, as a person's import leaves it, and a re-run request for it taken by a new token. */
function rerunOf(key: string, tests: [title: string, caseId: number | null][]) {
  const p = makeProject(key, key);
  const run = db.prepare("INSERT INTO runs (project_id, title, kind, source, status, environment) VALUES (?, 'CI', 'automated', 'upload', 'completed', 'ci') RETURNING id").pluck().get(p.id) as number;
  tests.forEach(([title, caseId], i) => db.prepare("INSERT INTO results (run_id, case_id, automated_test_id, status, position) VALUES (?, ?, ?, 'failed', ?)").run(run, caseId, known(p.id, "e2e/shop.spec.ts", title, caseId), i));
  const t = agent(p.id);
  const r = createRequest(p.id, { kind: "rerun", runId: run }, me);
  claimRequest(p.id, r.id, t);
  return { p, run, t, r };
}

/**
 * A project with two test cases. Sign in has an automated test that is linked to it (e2e/login.spec.ts "signs in") and a spec, login.spec.ts. Pay has a spec, pay.spec.ts, and no test is
 * known for it yet. A run request for both, taken by claude-a.
 */
function setup(key: string) {
  const p = makeProject(key, key);
  const signIn = makeCase(p.id, "Sign in", { steps: [["Open /login", "A form"]] });
  const pay = makeCase(p.id, "Pay", { steps: [["Open /pay", "A form"]] });
  known(p.id, "e2e/login.spec.ts", "signs in", signIn.id);
  createSpec(p.id, { fileName: "login.spec.ts", text: "test('signs in', async () => {})", caseId: signIn.id });
  createSpec(p.id, { fileName: "pay.spec.ts", text: "test('pays', async () => {})", caseId: pay.id });
  const t = agent(p.id);
  const r = createRequest(p.id, { kind: "run", targetUrl: URL_OK, caseIds: [signIn.id, pay.id], environment: "staging" }, me);
  claimRequest(p.id, r.id, t);
  const deliver = (body: unknown, token = t) => submitResult(p.id, r.id, token, body, IP);
  return { p, signIn, pay, t, r, deliver };
}
const good = (extra: T[] = []) => pw([{ file: "e2e/login.spec.ts", title: "signs in" }, { file: "e2e/pay.spec.ts", title: "pays", status: "failed" }, ...extra]);
/** Everything a refused report must leave alone. */
const trace = (s: { p: { id: number }; r: { id: number } }) => JSON.stringify([
  n("SELECT COUNT(*) FROM runs WHERE project_id = ?", s.p.id), n("SELECT COUNT(*) FROM automated_tests WHERE project_id = ?", s.p.id), n("SELECT COUNT(*) FROM results r JOIN runs ru ON ru.id = r.run_id WHERE ru.project_id = ?", s.p.id),
  n("SELECT COUNT(*) FROM audit_log WHERE action = 'agent_request.result_delivered' AND project_id = ?", s.p.id), one("SELECT status, result_run_id, result_delivered_at FROM agent_requests WHERE id = ?", s.r.id),
]);

describe("a report for a run request", () => {
  it("makes a NEW automated run marked as the agent's, in the request's environment, that names the manual run and the request, and marks the request as delivered", () => {
    const s = setup("RPA");
    const out = s.deliver(good());
    assert.deepEqual([out.total, out.linked], [2, 2]);
    const run = one("SELECT kind, source, status, environment, title, meta FROM runs WHERE id = ?", out.runId)!;
    assert.deepEqual([run.kind, run.source, run.status, run.environment], ["automated", "agent", "completed", "staging"]);
    assert.equal(run.title, `Automated tests of run #${s.r.runId} (request #${s.r.id})`);
    const manual = one("SELECT id, title FROM runs WHERE id = ?", s.r.runId)!;
    assert.deepEqual(JSON.parse(run.meta), { agentRequest: s.r.id, runOf: { id: manual.id, title: manual.title }, deliveredBy: "claude-a" });
    const req = one("SELECT status, result_run_id, result_delivered_at FROM agent_requests WHERE id = ?", s.r.id)!;
    assert.deepEqual([req.status, req.result_run_id, !!req.result_delivered_at], ["claimed", out.runId, true], "still taken: the agent has test cases to report and finishes it");
    assert.equal(agentRequestOfRun(s.r.runId!)!.reportRunId, out.runId, "the manual run can link to the report");
    assert.equal("reportRunId" in agentRequestOfRun(setup("RPB").r.runId!)!, false, "no link before there is a report");
  });

  it("does not touch the manual run, the results a person set there, or the results the agent reported for it: row by row", () => {
    const s = setup("RPC");
    const run = s.r.runId!;
    reportCaseResults(s.p.id, s.r.id, s.t, IP, caseResultsBody.parse({ results: [{ caseId: s.signIn.id, status: "passed", note: "by the agent" }] }));
    db.prepare("UPDATE results SET status = 'failed', notes = 'a person', executed_at = datetime('now') WHERE run_id = ? AND case_id = ?").run(run, s.pay.id);
    const rows = () => JSON.stringify([db.prepare("SELECT * FROM results WHERE run_id = ? ORDER BY id").all(run), db.prepare("SELECT * FROM step_results").all(), db.prepare("SELECT status, title, meta FROM runs WHERE id = ?").get(run)]);
    const before = rows();
    s.deliver(good());
    assert.equal(rows(), before);
  });

  it("lets in a test linked to one of its test cases, a new test in one of its spec files, and a known test in one of its spec files; a new test is linked to the case of its spec", () => {
    const s = setup("RPD");
    const stray = known(s.p.id, "e2e/pay.spec.ts", "old unlinked", null); // known, in a spec file of the request, linked to nothing
    const out = s.deliver(pw([{ file: "e2e/login.spec.ts", title: "signs in" }, { file: "e2e/pay.spec.ts", title: "pays" }, { file: "e2e/pay.spec.ts", title: "old unlinked" }]));
    assert.equal(out.total, 3);
    assert.equal(testRow(s.p.id, "e2e/login.spec.ts", "signs in")!.case_id, s.signIn.id, "a known test keeps its case");
    assert.equal(testRow(s.p.id, "e2e/pay.spec.ts", "pays")!.case_id, s.pay.id, "a new test in the spec file of Pay is Pay's");
    assert.equal(db.prepare("SELECT case_id FROM automated_tests WHERE id = ?").pluck().get(stray), null, "a known test with no case stays without one");
    assert.equal(n("SELECT COUNT(*) FROM results WHERE run_id = ? AND case_id IS NOT NULL", out.runId), 2);
  });

  it("refuses the whole report when one test is not named: another file, a test twice, an empty report, something that is not a Playwright report, more than 1000 tests; nothing is left", () => {
    const s = setup("RPE");
    const before = trace(s);
    refused(() => s.deliver(good([{ file: "e2e/other.spec.ts", title: "stranger" }])), 400, /1 test\(s\) that this request did not name \(a test linked to one of its test cases, or a test in one of its spec files\)/);
    refused(() => s.deliver(pw([{ file: "e2e/other.spec.ts", title: "stranger" }])), 400, /did not name/);
    const twice = good();
    twice.suites[0].specs.push(twice.suites[0].specs[0]);
    refused(() => s.deliver(twice), 400, /appear twice/);
    refused(() => s.deliver(emptyReport), 400, /no tests/);
    refused(() => s.deliver({ hello: "world" }), 400, /not a Playwright/);
    refused(() => s.deliver([1, 2]), 400, /request body/);
    refused(() => s.deliver(pw(Array.from({ length: RESULT_LIMITS.testsMax + 1 }, (_, i) => ({ file: "e2e/pay.spec.ts", title: `t${i}` })))), 400, /at most 1000 are taken/);
    assert.equal(trace(s), before, "no run, no test, no result, no audit entry, not marked");
    assert.equal(s.deliver(good()).total, 2, "and the request can still be given its report");
  });

  it("takes exactly 1000 tests", () => {
    const s = setup("RPF");
    const out = s.deliver(pw(Array.from({ length: RESULT_LIMITS.testsMax }, (_, i) => ({ file: "e2e/pay.spec.ts", title: `t${i}` }))));
    assert.equal(out.total, 1000);
    assert.equal(RESULT_LIMITS.testsMax, 1000);
  });
});

describe("a report reaches a spec by its file name and a test case by its link", () => {
  it("shows in the results of the spec whose name is the last part of the file, whatever the case of the letters and the kind of slash; and in the status of the case; other specs are untouched", () => {
    const s = setup("RPG");
    s.deliver(pw([{ file: "E2E/Pay.SPEC.ts", title: "a", status: "passed" }, { file: "e2e/pay.spec.ts", title: "b", status: "skipped" }, { file: "e2e\\PAY.spec.ts", title: "c", status: "failed" }]));
    const specs = Object.fromEntries(listSpecs(s.p.id).map((x) => [x.fileName, x.results]));
    assert.deepEqual([specs["pay.spec.ts"].tests, specs["pay.spec.ts"].passed, specs["pay.spec.ts"].skipped, specs["pay.spec.ts"].failed, specs["pay.spec.ts"].lastSeen !== null], [3, 1, 1, 1, true]);
    assert.deepEqual([specs["login.spec.ts"].tests, specs["login.spec.ts"].passed], [1, 0], "login.spec.ts still has only the test that was known, with no result from this report");
    assert.equal(latestStatusByCase(s.p.id).get(s.pay.id), "failed", "the new tests are linked to Pay, so Pay is failing");
  });

  it("gives a spec its first results from tests TestBench did not know", () => {
    const s = setup("RPH");
    assert.equal(listSpecs(s.p.id).find((x) => x.fileName === "pay.spec.ts")!.results.tests, 0, "nothing known before");
    s.deliver(pw([{ file: "e2e/pay.spec.ts", title: "pays" }]));
    const pay = listSpecs(s.p.id).find((x) => x.fileName === "pay.spec.ts")!.results;
    assert.deepEqual([pay.tests, pay.passed], [1, 1]);
  });

  it("marks a spec as ambiguous when two files in the report have its name", () => {
    const s = setup("RPI");
    s.deliver(pw([{ file: "a/pay.spec.ts", title: "pays" }, { file: "b/pay.spec.ts", title: "pays too" }]));
    const pay = listSpecs(s.p.id).find((x) => x.fileName === "pay.spec.ts")!.results;
    assert.deepEqual([pay.tests, pay.ambiguous, pay.files], [2, true, ["a/pay.spec.ts", "b/pay.spec.ts"]]);
  });
});

describe("TestBench decides which case a test belongs to, never the text of the report", () => {
  it("a tag, a title or a suite that names a case or a requirement links nothing: a known test keeps its case, and a new test gets the case of its spec", () => {
    const s = setup("RPJ");
    const req = createRequirement(s.p.id, { title: "Checkout works", description: "d", acceptanceCriteria: "c" });
    const reqNumber = n("SELECT number FROM requirements WHERE id = ?", req);
    const other = makeCase(s.p.id, "Other");
    const aim = `RPJ-${other.number}`;
    const before = n("SELECT COUNT(*) FROM requirement_cases");
    s.deliver(pw([
      { file: "e2e/login.spec.ts", title: "signs in", tags: [`@${aim}`, `@REQ-${reqNumber}`] }, // the known test, with tags that point somewhere else
      { file: "e2e/pay.spec.ts", title: `pays ${aim} @REQ-${reqNumber}`, tags: [`@${aim}`, `@REQ-${reqNumber}`] }, // a new test whose text names another case and a requirement
    ]));
    assert.equal(testRow(s.p.id, "e2e/login.spec.ts", "signs in")!.case_id, s.signIn.id, "the tag did not move the link");
    assert.equal(testRow(s.p.id, "e2e/pay.spec.ts", `pays ${aim} @REQ-${reqNumber}`)!.case_id, s.pay.id, "the case of the spec, not the one the title names");
    assert.equal(n("SELECT COUNT(*) FROM requirement_cases"), before, "@REQ-n linked no requirement");
    assert.equal(n("SELECT COUNT(*) FROM automated_tests WHERE case_id = ?", other.id), 0);
  });

  it("a link a person made is kept: a known test of a spec file of the request that is linked to another case stays linked to that case", () => {
    const s = setup("RPK");
    const elsewhere = makeCase(s.p.id, "Linked by a person");
    known(s.p.id, "e2e/pay.spec.ts", "linked by hand", elsewhere.id);
    s.deliver(pw([{ file: "e2e/pay.spec.ts", title: "linked by hand", tags: [`@RPK-${s.pay.number}`] }]));
    assert.equal(testRow(s.p.id, "e2e/pay.spec.ts", "linked by hand")!.case_id, elsewhere.id);
  });

  it("a re-run gets the same rule: a named test keeps its case (also none) whatever its tags say, and a test that was deleted in the meantime comes back without a case", () => {
    const p0 = makeProject("RPZ", "RPZ");
    const c1 = makeCase(p0.id, "One");
    const x = rerunOf("RPL", [["linked", null], ["unlinked", null], ["deleted later", null]]);
    const c2 = makeCase(x.p.id, "Two");
    const keep = makeCase(x.p.id, "Kept");
    db.prepare("UPDATE automated_tests SET case_id = ? WHERE project_id = ? AND title = 'linked [chromium]'").run(keep.id, x.p.id);
    db.prepare("DELETE FROM automated_tests WHERE project_id = ? AND title = 'deleted later [chromium]'").run(x.p.id);
    const req = createRequirement(x.p.id, { title: "R", description: "d", acceptanceCriteria: "c" });
    const tags = [`@RPL-${c2.number}`, `@REQ-${n("SELECT number FROM requirements WHERE id = ?", req)}`];
    const out = submitResult(x.p.id, x.r.id, x.t, pw(["linked", "unlinked", "deleted later"].map((title) => ({ file: "e2e/shop.spec.ts", title, tags }))), IP);
    assert.equal(out.total, 3);
    assert.equal(testRow(x.p.id, "e2e/shop.spec.ts", "linked")!.case_id, keep.id, "not moved to the case the tag names");
    assert.equal(testRow(x.p.id, "e2e/shop.spec.ts", "unlinked")!.case_id, null, "not linked to the case the tag names");
    assert.equal(testRow(x.p.id, "e2e/shop.spec.ts", "deleted later")!.case_id, null, "made again, without a case: the report does not decide");
    assert.equal(n("SELECT COUNT(*) FROM requirement_cases WHERE requirement_id = ?", req), 0, "no requirement was covered by a tag in the report");
    assert.equal(one("SELECT source, title FROM runs WHERE id = ?", out.runId)!.source, "agent");
    assert.ok(c1.id);
  });

  it("the importer takes only a case of this project from the function that decides, and a person's own import still reads the case ID in the name", () => {
    const p = makeProject("RPM", "RPM");
    const mine = makeCase(p.id, "Mine");
    const theirs = makeCase(makeProject("RPN", "RPN").id, "Theirs");
    const report = parseReport(JSON.stringify(pw([{ file: "e2e/a.spec.ts", title: `a RPM-${mine.number}` }, { file: "e2e/b.spec.ts", title: "b" }])), "playwright");
    importReport(report, { projectId: p.id, source: "agent", title: "x", relinkOthers: false, resolveLink: (t) => (t.file === "e2e/a.spec.ts" ? theirs.id : mine.id) });
    assert.equal(testRow(p.id, "e2e/a.spec.ts", `a RPM-${mine.number}`)!.case_id, null, "a case of another project is no link, whatever the name says");
    assert.equal(testRow(p.id, "e2e/b.spec.ts", "b")!.case_id, mine.id);
    const p2 = makeProject("RPO", "RPO");
    const c = makeCase(p2.id, "Named");
    importReport(parseReport(JSON.stringify(pw([{ file: "e2e/c.spec.ts", title: `c RPO-${c.number}` }])), "playwright"), { projectId: p2.id, source: "upload", title: "by a person" });
    assert.equal(testRow(p2.id, "e2e/c.spec.ts", `c RPO-${c.number}`)!.case_id, c.id, "a person's import is as it was");
  });
});

describe("who may hand in a report, and when", () => {
  it("only a run request or a re-run, only the token that took it, only while it is taken, only when a person has switched agent results on", () => {
    const s = setup("RPP");
    // One request runs at a time in a project: the run request is given back while a discover is taken (then cancelled), and taken again.
    releaseRequest(s.p.id, s.r.id, s.t, { note: "to try a discover first" });
    const discover = createRequest(s.p.id, { kind: "discover", targetUrl: URL_OK }, me);
    claimRequest(s.p.id, discover.id, s.t);
    refused(() => submitResult(s.p.id, discover.id, s.t, good(), IP), 400, /Only a re-run or a run request takes a report/);
    cancelRequest(discover.id);
    claimRequest(s.p.id, s.r.id, s.t);

    const fresh = createRequest(s.p.id, { kind: "run", targetUrl: URL_OK, caseIds: [s.pay.id] }, me);
    refused(() => submitResult(s.p.id, fresh.id, s.t, good(), IP), 409, /Take the request first/);
    const other = agent(s.p.id, "claude-b");
    refused(() => s.deliver(good(), other), 409, /Another token took this request/);
    const before = trace(s);
    setAgentResultsEnabled(false);
    refused(() => s.deliver(good()), 409, /Agent results are switched off/);
    setAgentResultsEnabled(true);
    assert.equal(trace(s), before, "nothing was made while it was off");

    cancelRequest(s.r.id);
    refused(() => s.deliver(good()), 409, /already done or cancelled/);
    refused(() => submitResult(s.p.id, 999999, s.t, good(), IP), 404, /not found/i);
    refused(() => submitResult(makeProject("RPQ", "RPQ").id, s.r.id, s.t, good(), IP), 404, /not found/i);
  });

  it("a finished request takes no report, and neither does a run request whose run was deleted", () => {
    const s = setup("RPR");
    for (const c of [s.signIn, s.pay]) reportCaseResults(s.p.id, s.r.id, s.t, IP, caseResultsBody.parse({ results: [{ caseId: c.id, status: "passed" }] }));
    completeRequest(s.p.id, s.r.id, s.t, {});
    refused(() => s.deliver(good()), 409, /already done or cancelled/);
    const t = setup("RPS");
    db.prepare("DELETE FROM runs WHERE id = ?").run(t.r.runId);
    refused(() => t.deliver(good()), 409, /The run of this request was deleted/);
  });

  it("is handed in once per request: not again, not after the request was given back and taken by another token", () => {
    const s = setup("RPT");
    s.deliver(good());
    refused(() => s.deliver(good()), 409, /already handed in/);
    releaseRequest(s.p.id, s.r.id, s.t, { note: "ran out of time" });
    const b = agent(s.p.id, "claude-b");
    claimRequest(s.p.id, s.r.id, b);
    refused(() => s.deliver(good(), b), 409, /already handed in/);
    assert.equal(n("SELECT COUNT(*) FROM runs WHERE project_id = ? AND source = 'agent'", s.p.id), 1);
  });
});

describe("release and complete after a report", () => {
  it("a run request can be given back after its report: the report stays, the request waits again, and the next agent reports the test cases and finishes it", () => {
    const s = setup("RPU");
    const out = s.deliver(good());
    const back = releaseRequest(s.p.id, s.r.id, s.t, { note: "no time for the manual cases" });
    assert.deepEqual([back.status, back.resultRunId, !!back.resultDeliveredAt], ["pending", out.runId, true]);
    assert.equal(n("SELECT COUNT(*) FROM runs WHERE id = ?", out.runId), 1, "the report is still there");
    const b = agent(s.p.id, "claude-b");
    claimRequest(s.p.id, s.r.id, b);
    reportCaseResults(s.p.id, s.r.id, b, IP, caseResultsBody.parse({ results: [{ caseId: s.signIn.id, status: "passed" }, { caseId: s.pay.id, status: "failed", note: "from the report" }] }));
    const done = completeRequest(s.p.id, s.r.id, b, {});
    assert.deepEqual([done.status, done.resultRunId], ["done", out.runId], "the request keeps the run the report made");
  });

  it("complete is as it was: it still needs a result for every test case, whatever the report said", () => {
    const s = setup("RPV");
    s.deliver(good());
    refused(() => completeRequest(s.p.id, s.r.id, s.t, {}), 409, /^2 of 2 test cases have no result yet/);
    assert.equal(agentRequestOfRun(s.r.runId!)!.progress.missing, 2, "an automated result is not a result of the manual run: the agent reports the test cases itself");
  });

  it("a re-run is still finished by its report: giving it back is refused, as before", () => {
    const x = rerunOf("RPW", [["breaks", null]]);
    submitResult(x.p.id, x.r.id, x.t, pw([{ file: "e2e/shop.spec.ts", title: "breaks" }]), IP);
    refused(() => releaseRequest(x.p.id, x.r.id, x.t, {}), 409, /already handed in.*Finish it with complete instead/);
    assert.equal(completeRequest(x.p.id, x.r.id, x.t, {}).status, "done");
  });
});

describe("complete when no report was handed in", () => {
  const WARNING = (names: string) => `No Playwright report was handed in, and this request names ${names}. A report can no longer be handed in now that the request is done. If you ran those tests, tell the user, who can import the report file under Import results. If you did not run them, ignore this.`;
  const resultFor = (p: { id: number }, r: { id: number }, t: ReturnType<typeof agent>, ...cases: { id: number }[]) =>
    reportCaseResults(p.id, r.id, t, IP, caseResultsBody.parse({ results: cases.map((c) => ({ caseId: c.id, status: "passed" })) }));

  it("is not blocked: the request is done, and the answer warns that a report can no longer be handed in, naming the tests and spec files the request names; nothing about it is stored", () => {
    const s = setup("RWA");
    resultFor(s.p, s.r, s.t, s.signIn, s.pay);
    const done = completeRequest(s.p.id, s.r.id, s.t, { note: "by hand" });
    assert.equal(done.status, "done");
    assert.equal(done.warning, WARNING("1 automated test and 2 spec files"));
    refused(() => s.deliver(good()), 409, /already done or cancelled/);
    assert.equal(one("SELECT result_delivered_at FROM agent_requests WHERE id = ?", s.r.id)!.result_delivered_at, null);
    assert.equal("warning" in agentRequestOfRun(s.r.runId!)!, false, "the warning is told once, not kept");
  });

  it("has no warning after a report, and none when the test cases name no tests and no spec files", () => {
    const s = setup("RWB");
    s.deliver(good());
    resultFor(s.p, s.r, s.t, s.signIn, s.pay);
    assert.equal("warning" in completeRequest(s.p.id, s.r.id, s.t, {}), false);

    const p = makeProject("RWC", "RWC");
    const plain = makeCase(p.id, "Plain", { steps: [["Open /", "A page"]] });
    const t = agent(p.id);
    const r = createRequest(p.id, { kind: "run", targetUrl: URL_OK, caseIds: [plain.id] }, me);
    claimRequest(p.id, r.id, t);
    resultFor(p, r, t, plain);
    assert.equal("warning" in completeRequest(p.id, r.id, t, {}), false);
  });

  it("counts a spec file and an automated test each on its own, in the singular and the plural", () => {
    const run = (key: string, setupCase: (p: { id: number }, c: { id: number }) => void) => {
      const p = makeProject(key, key);
      const c = makeCase(p.id, "One", { steps: [["Open /", "A page"]] });
      setupCase(p, c);
      const t = agent(p.id);
      const r = createRequest(p.id, { kind: "run", targetUrl: URL_OK, caseIds: [c.id] }, me);
      claimRequest(p.id, r.id, t);
      resultFor(p, r, t, c);
      return completeRequest(p.id, r.id, t, {}).warning;
    };
    assert.equal(run("RWD", (p, c) => createSpec(p.id, { fileName: "a.spec.ts", text: "test('a', async () => {})", caseId: c.id })), WARNING("1 spec file"));
    assert.equal(run("RWE", (p, c) => { known(p.id, "e2e/a.spec.ts", "a", c.id); }), WARNING("1 automated test"));
    assert.equal(run("RWF", (p, c) => { known(p.id, "e2e/a.spec.ts", "a", c.id); known(p.id, "e2e/b.spec.ts", "b", c.id); createSpec(p.id, { fileName: "a.spec.ts", text: "test('a', async () => {})", caseId: c.id }); }), WARNING("2 automated tests and 1 spec file"));
  });

  it("is only said for a run request: a re-run and a discover are finished as before", () => {
    const x = rerunOf("RWG", [["breaks", null]]);
    assert.equal("warning" in completeRequest(x.p.id, x.r.id, x.t, {}), false);
    const p = makeProject("RWH", "RWH");
    const t = agent(p.id);
    const d = createRequest(p.id, { kind: "discover", targetUrl: URL_OK }, me);
    claimRequest(p.id, d.id, t);
    assert.equal("warning" in completeRequest(p.id, d.id, t, {}), false);
  });
});

describe("the audit entry", () => {
  it("is written with the run, by 'agent: <name>', with what came in and the credential id, and never a token or a hash", () => {
    const s = setup("RPX");
    known(s.p.id, "e2e/pay.spec.ts", "old", null);
    const out = s.deliver(pw([{ file: "e2e/login.spec.ts", title: "signs in" }, { file: "e2e/pay.spec.ts", title: "pays", status: "failed" }, { file: "e2e/pay.spec.ts", title: "old", status: "skipped" }]));
    const row = one("SELECT actor_user_id, actor_label, ip, project_id, detail FROM audit_log WHERE action = 'agent_request.result_delivered' AND project_id = ?", s.p.id)!;
    assert.deepEqual([row.actor_user_id, row.actor_label, row.ip, row.project_id], [null, "agent: claude-a", IP, s.p.id]);
    assert.deepEqual(JSON.parse(row.detail), { request: s.r.id, kind: "run", run: s.r.runId, result_run: out.runId, credential_id: s.t.id, tests: 3, new_tests: 1, linked: 2, passed: 1, failed: 1, skipped: 1 });
    const all = JSON.stringify(db.prepare("SELECT * FROM audit_log").all());
    assert.equal(all.includes(s.t.secret), false);
    assert.doesNotMatch(all, /token_hash|"hash"|tbrq_/);
  });

  it("is written for a re-run too, with kind rerun", () => {
    const x = rerunOf("RPY", [["breaks", null]]);
    const out = submitResult(x.p.id, x.r.id, x.t, pw([{ file: "e2e/shop.spec.ts", title: "breaks", status: "failed" }]), IP);
    const row = one("SELECT detail FROM audit_log WHERE action = 'agent_request.result_delivered' AND project_id = ?", x.p.id)!;
    assert.deepEqual(JSON.parse(row.detail), { request: x.r.id, kind: "rerun", run: x.run, result_run: out.runId, credential_id: x.t.id, tests: 1, new_tests: 0, linked: 0, passed: 0, failed: 1, skipped: 0 });
  });
});
