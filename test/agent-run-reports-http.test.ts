import "./env.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";

// The real server, started as a separate process with a password set. AG5b: the agent that took a run request hands in the Playwright report of the automated tests of its test cases.
// Who may (a request token, a run request or a re-run, taken by that token, once, when a person has switched agent results on), what a refused report leaves behind (nothing), what the
// report does and does not touch, how it reaches a spec and a test case, the limits and the audit log.

const ROOT = join(import.meta.dirname, "..");
const PORT = 58000 + Math.floor(Math.random() * 1000); // its own range: the other server tests use 41000 to 57999
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "a long test passphrase";
const JSON_H = { "Content-Type": "application/json" };
const DATA = mkdtempSync(join(tmpdir(), "tb-agent-run-reports-"));
let server: ChildProcess;
let output = "";
let cookie = "";

const call = (path: string, init: RequestInit = {}) => fetch(`${BASE}${path}`, init);
const person = (path: string, body?: unknown, method = "POST") =>
  call(path, { method, headers: { ...JSON_H, "X-Testbench": "1", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const agent = (authorization: string | undefined, path: string, method = "GET", body?: unknown) =>
  call(path, { method, headers: { ...(authorization === undefined ? {} : { Authorization: authorization }), ...(body === undefined ? {} : JSON_H) }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const ok = async <T>(res: Response) => { const raw = await res.text(); assert.ok(res.ok, raw); return JSON.parse(raw) as T; };
const rows = <T>(sql: string, ...args: unknown[]) => { const d = new Database(join(DATA, "testbench.db"), { readonly: true }); try { return d.prepare(sql).all(...args) as T[]; } finally { d.close(); } };

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
const bearer = (t: string) => `Bearer ${t}`;
const issued: string[] = [];
const mk = async (projectId: number, path: string, name: string) => { const t = await ok<{ token: string; id: number }>(await person(`/api/projects/${projectId}/${path}`, { name })); issued.push(t.token); return t; };

let n = 0;
let key = "";
let a = 0;
let b = 0;
let tokenA = "";
let tokenAId = 0;
let tokenA2 = "";
let tokenB = "";
let readTokenA = "";
let ciTokenA = "";
let revoked = "";
let signIn = 0;
let pay = 0;
let loginTest = ""; // the title of the test a person's import linked to Sign in
let rid = 0; // the run request of this test, taken by tokenA
let manualRun = 0;
const URL_OK = "https://staging.example.com/";

const importReport = async (projectId: number, report: unknown) => {
  const form = new FormData();
  form.set("environment", "from-import");
  form.set("file", new Blob([JSON.stringify(report)], { type: "application/json" }), "report.json");
  return ok<{ runId: number }>(await call(`/api/projects/${projectId}/import`, { method: "POST", headers: { "X-Testbench": "1", Cookie: cookie }, body: form }));
};
const makeCase = async (projectId: number, title: string) => (await ok<{ id: number }>(await person(`/api/projects/${projectId}/cases`, { title, status: "ready", steps: [{ action: "Open it", expected: "It opens" }] }))).id;
const askRun = async (projectId: number, caseIds: number[]) => ok<{ id: number; runId: number }>(await person(`/api/projects/${projectId}/agent-requests`, { kind: "run", targetUrl: URL_OK, environment: "staging", caseIds }));
const take = (token: string, projectId: number, id: number) => agent(bearer(token), `/api/agent/projects/${projectId}/requests/${id}/claim`, "POST");
const handIn = (token: string, projectId: number, id: number, body: unknown) => agent(bearer(token), `/api/agent/projects/${projectId}/requests/${id}/result`, "POST", body);
const finish = (token: string, projectId: number, id: number, what: "complete" | "release", body: unknown = {}) => agent(bearer(token), `/api/agent/projects/${projectId}/requests/${id}/${what}`, "POST", body);
const caseResults = (token: string, projectId: number, id: number, results: unknown[]) => agent(bearer(token), `/api/agent/projects/${projectId}/requests/${id}/case-results`, "POST", { results });
const switchResults = async (on: boolean) => ok(await person("/api/settings/agent-results", { enabled: on }, "PUT"));
const runsOf = async (projectId: number) => ok<{ id: number; title: string; source: string; kind: string; environment: string; meta: Record<string, any> }[]>(await person(`/api/projects/${projectId}/runs`, undefined, "GET"));
const runOf = async (id: number) => ok<{ id: number; status: string; agentRequest: { status: string; reportRunId?: number } | null; results: Record<string, any>[] }>(await person(`/api/runs/${id}`, undefined, "GET"));
const automated = async (projectId: number) => ok<{ full_name: string; last_status: string; case_id: number | null }[]>(await person(`/api/projects/${projectId}/automated`, undefined, "GET"));
const specs = async (projectId: number) => ok<{ fileName: string; results: { tests: number; passed: number; failed: number; skipped: number; lastSeen: string | null; ambiguous: boolean } }[]>(await person(`/api/projects/${projectId}/specs`, undefined, "GET"));
const requestOf = async (projectId: number, id: number) => (await ok<{ id: number; status: string; resultRunId: number | null; resultDeliveredAt: string | null }[]>(await person(`/api/projects/${projectId}/agent-requests`, undefined, "GET"))).find((r) => r.id === id)!;
const audits = (projectId = a) => rows<{ actor_label: string; ip: string; detail: string }>("SELECT actor_label, ip, detail FROM audit_log WHERE action = 'agent_request.result_delivered' AND project_id = ? ORDER BY id", projectId);
/** What a refused report must leave alone. */
const trace = async () => JSON.stringify([(await runsOf(a)).length, (await automated(a)).length, audits().length, (await requestOf(a, rid)).resultDeliveredAt]);
const good = () => pw([{ file: "e2e/login.spec.ts", title: loginTest }, { file: "e2e/pay.spec.ts", title: "pays", status: "failed" }]);

// A report may be handed in at most 10 times a minute per token, and every attempt counts, so each test gets its own projects and tokens. They are made before every test.
beforeEach(async () => {
  n++;
  key = `RH${n}`;
  a = (await ok<{ id: number }>(await person("/api/projects", { name: `Reports A${n}`, key }))).id;
  b = (await ok<{ id: number }>(await person("/api/projects", { name: `Reports B${n}`, key: `RI${n}` }))).id;
  const dead = await mk(a, "request-tokens", "to-revoke"); // a project has 3 active request tokens: this one is revoked first, so that its place is free again
  revoked = dead.token;
  assert.equal((await person(`/api/request-tokens/${dead.id}/revoke`, {})).status, 200);
  const ta = await mk(a, "request-tokens", "claude-a");
  tokenA = ta.token;
  tokenAId = ta.id;
  tokenA2 = (await mk(a, "request-tokens", "second-agent")).token;
  tokenB = (await mk(b, "request-tokens", "claude-b")).token;
  readTokenA = (await mk(a, "agent/tokens", "reader")).token;
  ciTokenA = (await mk(a, "ci/tokens", "ci")).token;
  signIn = await makeCase(a, "Sign in");
  pay = await makeCase(a, "Pay");
  loginTest = `signs in @${key}-1`; // a person's import links this test to Sign in by the case ID in its name
  await importReport(a, pw([{ file: "e2e/login.spec.ts", title: loginTest }]));
  for (const [fileName, caseId] of [["login.spec.ts", signIn], ["pay.spec.ts", pay]] as const) await ok(await person(`/api/projects/${a}/specs`, { fileName, text: "test('x', async () => {})", caseId }));
  const asked = await askRun(a, [signIn, pay]);
  rid = asked.id;
  manualRun = asked.runId;
  await ok(await take(tokenA, a, rid));
});

before(async () => {
  server = spawn(process.execPath, ["--import", "tsx", join(ROOT, "server", "index.ts")], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TESTBENCH_DATA: DATA, TESTBENCH_PORT: String(PORT), TESTBENCH_PASSWORD: PASSWORD, NODE_ENV: "production", TESTBENCH_AUTO_BACKUP: "0" },
  });
  server.stdout?.on("data", (d) => (output += d));
  server.stderr?.on("data", (d) => (output += d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await call("/api/auth/status")).ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  const login = await call("/api/login", { method: "POST", headers: { ...JSON_H, "X-Testbench": "1" }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(login.status, 200, output);
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
});
after(() => server?.kill());

describe("who may hand in a report", () => {
  it("is off until a person switches agent results on: 409 and nothing is made; then it is taken", async () => {
    await switchResults(false);
    const before = await trace();
    const off = await handIn(tokenA, a, rid, good());
    assert.equal(off.status, 409);
    assert.match((await off.json()).error, /Agent results are switched off/);
    assert.equal(await trace(), before);
    await switchResults(true);
    assert.equal((await handIn(tokenA, a, rid, good())).status, 200);
  });

  it("refuses a missing, malformed, unknown, revoked, read or CI token with the same 401, and a person's login without a token; a token of another project gets 403 and learns nothing", async () => {
    await switchResults(true);
    const before = await trace();
    const bodies = new Set<string>();
    for (const header of [undefined, "Bearer", "Basic abc", `Bearer ${tokenA}x`, `Bearer ${revoked}`, `Bearer ${readTokenA}`, `Bearer ${ciTokenA}`]) {
      const res = await agent(header, `/api/agent/projects/${a}/requests/${rid}/result`, "POST", good());
      assert.equal(res.status, 401, String(header));
      bodies.add(await res.text());
    }
    assert.equal(bodies.size, 1, "one neutral answer for every kind of refusal");
    const byPerson = await person(`/api/agent/projects/${a}/requests/${rid}/result`, good());
    assert.equal(byPerson.status, 401, "a person's login is not a request token");
    const other = await handIn(tokenB, a, rid, good());
    assert.equal(other.status, 403);
    assert.equal(/RH\d|RI\d|Reports/.test(await other.text()), false, "nothing about the other project");
    assert.equal((await handIn(tokenA, b, rid, good())).status, 403);
    assert.equal(await trace(), before);
  });

  it("takes only a run request or a re-run that this token took and that is still taken: 400 for a discover, 409 for a request nobody took, another token's, a cancelled one; 404 for one that is not there", async () => {
    await switchResults(true);
    const discover = await ok<{ id: number }>(await person(`/api/projects/${a}/agent-requests`, { kind: "discover", targetUrl: "http://localhost:3000/" }));
    await ok(await take(tokenA, a, discover.id));
    const d = await handIn(tokenA, a, discover.id, good());
    assert.equal(d.status, 400);
    assert.match((await d.json()).error, /Only a re-run or a run request takes a report/);

    const waiting = await askRun(a, [pay]);
    assert.equal((await handIn(tokenA, a, waiting.id, good())).status, 409, "nobody took it");
    assert.equal((await handIn(tokenA2, a, rid, good())).status, 409, "another token took it");
    assert.equal((await person(`/api/agent-requests/${rid}/cancel`, {})).status, 200);
    assert.equal((await handIn(tokenA, a, rid, good())).status, 409, "cancelled");
    assert.equal((await handIn(tokenA, a, 999999, good())).status, 404);
    assert.equal(audits().length, 0);
  });
});

describe("what a report does", () => {
  it("makes one automated run marked as the agent's that names the manual run and the request, and links it from both; the manual run and its results are not touched", async () => {
    await switchResults(true);
    await ok(await caseResults(tokenA, a, rid, [{ caseId: signIn, status: "passed", note: "by the agent" }]));
    const manualBefore = await runOf(manualRun);
    const res = await handIn(tokenA, a, rid, good());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const out = (await res.json()) as { runId: number; total: number; linked: number };
    assert.deepEqual([out.total, out.linked], [2, 2]);
    const runs = await runsOf(a);
    const made = runs.find((r) => r.id === out.runId)!;
    assert.deepEqual([made.source, made.kind, made.environment, made.title], ["agent", "automated", "staging", `Automated tests of run #${manualRun} (request #${rid})`]);
    assert.deepEqual(made.meta, { agentRequest: rid, runOf: { id: manualRun, title: runs.find((r) => r.id === manualRun)!.title }, deliveredBy: "claude-a" });
    const req = await requestOf(a, rid);
    assert.deepEqual([req.status, req.resultRunId, !!req.resultDeliveredAt], ["claimed", out.runId, true]);
    const manualAfter = await runOf(manualRun);
    assert.equal(manualAfter.agentRequest?.reportRunId, out.runId, "the manual run links to the report");
    // What the page says about automation (last automated) may change; the results themselves may not.
    const results = (r: { results: Record<string, any>[] }) => JSON.stringify(r.results.map(({ last_automated: _l, automation: _a, automated_tests: _t, ...rest }) => rest));
    assert.equal(results(manualAfter), results(manualBefore), "every result of the manual run is as it was, the agent's and the person's");
  });

  it("reaches a spec by its file name and a test case by its link: the spec shows its results, the new test is linked to the case of its spec, and the case shows 'last automated'", async () => {
    await switchResults(true);
    const out = (await (await handIn(tokenA, a, rid, good())).json()) as { runId: number };
    const byName = Object.fromEntries((await specs(a)).map((s) => [s.fileName, s.results]));
    assert.deepEqual([byName["login.spec.ts"].tests, byName["login.spec.ts"].passed, byName["login.spec.ts"].lastSeen !== null], [1, 1, true]);
    assert.deepEqual([byName["pay.spec.ts"].tests, byName["pay.spec.ts"].failed], [1, 1], "a spec that had no test known gets its first result");
    const all = await automated(a);
    assert.equal(all.find((t) => t.full_name.includes("pays"))!.case_id, pay, "linked to the case of its spec");
    assert.equal(all.find((t) => t.full_name.includes(loginTest))!.case_id, signIn, "a known test keeps its case");
    const panel = (await runOf(manualRun)).results.find((r) => r.case_id === pay)!;
    assert.deepEqual([panel.last_automated?.status, panel.last_automated?.runId], ["failed", out.runId], "information on the manual run's page");
    assert.equal(panel.status, "untested", "which the report does not turn into a result of the manual run");
  });

  it("links nothing by the text of the report: tags that name another case or a requirement move no link", async () => {
    await switchResults(true);
    const other = await makeCase(a, "Other");
    await ok(await person(`/api/projects/${a}/requirements`, { title: "Checkout works", description: "d" }));
    const before = rows<{ n: number }>("SELECT COUNT(*) AS n FROM requirement_cases")[0].n;
    const aim = `${key}-3`; // the case "Other"
    await ok(await handIn(tokenA, a, rid, pw([{ file: "e2e/login.spec.ts", title: loginTest, tags: [`@${aim}`, "@REQ-1"] }, { file: "e2e/pay.spec.ts", title: `pays ${aim} @REQ-1`, tags: [`@${aim}`, "@REQ-1"] }])));
    const all = await automated(a);
    assert.equal(all.find((t) => t.full_name.includes(loginTest))!.case_id, signIn);
    assert.equal(all.find((t) => t.full_name.includes("pays"))!.case_id, pay);
    assert.equal(all.filter((t) => t.case_id === other).length, 0);
    assert.equal(rows<{ n: number }>("SELECT COUNT(*) AS n FROM requirement_cases")[0].n, before, "no requirement was covered");
  });

  it("refuses the whole report, and leaves no run, no test, no audit entry and no mark, for: a test that is not named, a test twice, an empty report, not a Playwright report, bad JSON, over 1000 tests, over 5 MB", async () => {
    await switchResults(true);
    const before = await trace();
    const twice = good();
    twice.suites[0].specs.push(twice.suites[0].specs[0]);
    const bad: [string, unknown, number, RegExp][] = [
      ["a stranger beside a good test", pw([{ file: "e2e/login.spec.ts", title: loginTest }, { file: "e2e/other.spec.ts", title: "stranger" }]), 400, /did not name/],
      ["only a stranger", pw([{ file: "e2e/other.spec.ts", title: "stranger" }]), 400, /did not name/],
      ["a test twice", twice, 400, /appear twice/],
      ["empty", emptyReport, 400, /no tests/],
      ["not a report", { hello: "world" }, 400, /not a Playwright/],
      ["a list", [1, 2], 400, /request body/],
      ["bad JSON", "{not json", 400, /./],
      ["1001 tests", pw(Array.from({ length: 1001 }, (_, i) => ({ file: "e2e/pay.spec.ts", title: `t${i}` }))), 400, /at most 1000 are taken/],
    ];
    for (const [what, body, status, re] of bad) {
      const res = await handIn(tokenA, a, rid, body);
      assert.equal(res.status, status, what);
      assert.match(await res.text(), re, what);
    }
    assert.equal(await trace(), before);
    const big = JSON.stringify({ ...good(), pad: "x".repeat(5 * 1024 * 1024 + 10) });
    const huge = await handIn(tokenA, a, rid, big).catch(() => null); // the server may also drop the connection
    if (huge) assert.equal(huge.status, 413);
    assert.equal(await trace(), before);
  });

  it("is handed in once per request: a second report is refused, also after the request was given back and taken by another token", async () => {
    await switchResults(true);
    assert.equal((await handIn(tokenA, a, rid, good())).status, 200);
    const again = await handIn(tokenA, a, rid, good());
    assert.equal(again.status, 409);
    assert.match((await again.json()).error, /already handed in/);
    assert.equal((await finish(tokenA, a, rid, "release", { note: "ran out of time" })).status, 200);
    await ok(await take(tokenA2, a, rid));
    assert.equal((await handIn(tokenA2, a, rid, good())).status, 409);
    assert.equal((await runsOf(a)).filter((r) => r.source === "agent").length, 1);
  });
});

describe("release and complete after a report", () => {
  it("a run request can be given back after its report (the report stays), and another token finishes it once every test case has a result; the run stays in progress", async () => {
    await switchResults(true);
    const out = (await (await handIn(tokenA, a, rid, good())).json()) as { runId: number };
    const back = await ok<{ status: string; resultRunId: number; resultDeliveredAt: string }>(await finish(tokenA, a, rid, "release", { note: "no time for the manual cases" }));
    assert.deepEqual([back.status, back.resultRunId, !!back.resultDeliveredAt], ["pending", out.runId, true]);
    assert.ok((await runsOf(a)).some((r) => r.id === out.runId), "the report is still there");
    await ok(await take(tokenA2, a, rid));
    const early = await finish(tokenA2, a, rid, "complete");
    assert.equal(early.status, 409, "complete is as it was: the test cases need results");
    assert.match((await early.json()).error, /^2 of 2 test cases have no result yet/);
    await ok(await caseResults(tokenA2, a, rid, [{ caseId: signIn, status: "passed", note: "as the report says" }, { caseId: pay, status: "failed", note: "as the report says" }]));
    const done = await ok<{ status: string; resultRunId: number }>(await finish(tokenA2, a, rid, "complete", { note: "done" }));
    assert.deepEqual([done.status, done.resultRunId], ["done", out.runId]);
    assert.equal((await runOf(manualRun)).status, "in_progress", "a person reviews and finishes the run");
  });

  it("a re-run is finished by its report as before: giving it back is refused", async () => {
    await switchResults(true);
    const failed = await importReport(a, pw([{ file: "e2e/shop.spec.ts", title: "breaks", status: "failed" }]));
    const rerun = await ok<{ id: number }>(await person(`/api/projects/${a}/agent-requests`, { kind: "rerun", runId: failed.runId }));
    await ok(await take(tokenA2, a, rerun.id));
    assert.equal((await handIn(tokenA2, a, rerun.id, pw([{ file: "e2e/shop.spec.ts", title: "breaks" }]))).status, 200);
    const refused = await finish(tokenA2, a, rerun.id, "release");
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /already handed in.*Finish it with complete instead/);
    assert.equal((await finish(tokenA2, a, rerun.id, "complete")).status, 200);
  });
});

describe("the audit log, the rate limit and the token", () => {
  it("has one entry for each report that was taken, by 'agent: <name>', with what came in and the credential id, and never a token or a hash", async () => {
    await switchResults(true);
    await ok(await handIn(tokenA, a, rid, good()));
    const mine = audits().filter((x) => x.actor_label === "agent: claude-a");
    assert.equal(mine.length, 1);
    const d = JSON.parse(mine[0].detail) as Record<string, unknown>;
    assert.deepEqual(Object.keys(d).sort(), ["credential_id", "failed", "kind", "linked", "new_tests", "passed", "request", "result_run", "run", "skipped", "tests"]);
    assert.deepEqual([d.request, d.kind, d.run, d.tests, d.new_tests, d.linked, d.passed, d.failed, d.skipped, d.credential_id], [rid, "run", manualRun, 2, 1, 2, 1, 1, 0, tokenAId]);
    const all = JSON.stringify(rows("SELECT * FROM audit_log"));
    for (const t of issued) assert.equal(all.includes(t), false, "a token is in the audit log");
    for (const h of rows<{ token_hash: string }>("SELECT token_hash FROM request_tokens").map((x) => x.token_hash)) assert.equal(all.includes(h), false, "a token hash is in the audit log");
  });

  it("answers 429 after 10 reports a minute from one token, counting the refused ones too, and does not slow another token", async () => {
    await switchResults(true);
    const stranger = pw([{ file: "e2e/other.spec.ts", title: "stranger" }]);
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await handIn(tokenA, a, rid, stranger)).status);
    assert.deepEqual(codes, Array(10).fill(400), "each is refused as a bad report, and each counts");
    const limited = await handIn(tokenA, a, rid, good());
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).error, /at most 10 a minute/);
    assert.equal((await requestOf(a, rid)).resultDeliveredAt, null, "nothing was taken while it was limited");
    const other = await askRun(a, [pay]);
    await ok(await take(tokenA2, a, other.id));
    assert.equal((await handIn(tokenA2, a, other.id, pw([{ file: "e2e/pay.spec.ts", title: "pays" }]))).status, 200, "another token is not slowed down");
  });

  it("never prints a token to the server's output", () => {
    for (const t of issued) assert.equal(output.includes(t), false, "a token reached the server's output");
  });
});
