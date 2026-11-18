import "./env.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import Database from "better-sqlite3";

// The real server, started as a separate process with a password set. AG5a: an agent that took a run request reports a result for each test case. Who may (the token that took it, a
// run request, while it is taken, and only when a person has switched agent results on), what a batch does and does not do, what a person can still do to the results, what `complete`
// asks for, the limits, the audit and that no token is ever shown.

const ROOT = join(import.meta.dirname, "..");
const PORT = 56000 + Math.floor(Math.random() * 1000); // its own range: the other server tests use 41000 to 55999
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "a long test passphrase";
const JSON_H = { "Content-Type": "application/json" };
const DATA = mkdtempSync(join(tmpdir(), "tb-agent-case-results-"));
let server: ChildProcess;
let output = "";
let cookie = "";

const call = (path: string, init: RequestInit = {}) => fetch(`${BASE}${path}`, init);
const person = (path: string, body?: unknown, method = "POST") =>
  call(path, { method, headers: { ...JSON_H, "X-Testbench": "1", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const agent = (authorization: string | undefined, path: string, method = "GET", body?: unknown) =>
  call(path, { method, headers: { ...(authorization === undefined ? {} : { Authorization: authorization }), ...(body === undefined ? {} : JSON_H) }, body: body === undefined ? undefined : JSON.stringify(body) });
const ok = async <T>(res: Response) => { const raw = await res.text(); assert.ok(res.ok, raw); return JSON.parse(raw) as T; };
const rows = <T>(sql: string, ...args: unknown[]) => { const d = new Database(join(DATA, "testbench.db"), { readonly: true }); try { return d.prepare(sql).all(...args) as T[]; } finally { d.close(); } };

type Req = { id: number; kind: string; status: string; runId: number | null; progress: { total: number; reported: number; missing: number } | null };
type Res = { id: number; case_id: number; status: string; notes: string; error: string; duration_ms: number | null; executed_at: string | null; reported_by_agent_token_id: number | null; reported_by_agent: string | null };
type Run = { id: number; status: string; agentRequest: { id: number; status: string; claimedBy: string | null; progress: { total: number; reported: number; missing: number } } | null; results: Res[] };
const URL_OK = "https://staging.example.com/";
const askRun = (projectId: number, caseIds: number[]) => person(`/api/projects/${projectId}/agent-requests`, { kind: "run", targetUrl: URL_OK, caseIds });
const makeCase = async (projectId: number, title: string, extra: Record<string, unknown> = {}) =>
  (await ok<{ id: number }>(await person(`/api/projects/${projectId}/cases`, { title, status: "ready", ...extra }))).id;
const runOf = async (id: number) => ok<Run>(await person(`/api/runs/${id}`, undefined, "GET"));
const bearer = (t: string) => `Bearer ${t}`;
const take = (token: string, projectId: number, rid: number) => agent(bearer(token), `/api/agent/projects/${projectId}/requests/${rid}/claim`, "POST");
const finish = (token: string, projectId: number, rid: number, what: "complete" | "release", body: unknown = {}) => agent(bearer(token), `/api/agent/projects/${projectId}/requests/${rid}/${what}`, "POST", body);
const caseResults = (token: string | undefined, projectId: number, rid: number, body: unknown) =>
  agent(token === undefined ? undefined : bearer(token), `/api/agent/projects/${projectId}/requests/${rid}/case-results`, "POST", body);
const issued: string[] = [];
const mk = async (projectId: number, kind: "request" | "agent" | "ci", name: string) => {
  const path = { request: "request-tokens", agent: "agent/tokens", ci: "ci/tokens" }[kind];
  const t = await ok<{ token: string; id: number }>(await person(`/api/projects/${projectId}/${path}`, { name }));
  issued.push(t.token);
  return t;
};
const tokenId = (name: string) => rows<{ id: number }>("SELECT id FROM request_tokens WHERE name = ?", name)[0].id;
const switchResults = async (enabled: boolean) => ok(await person("/api/settings/agent-results", { enabled }, "PUT"));

let a = 0;
let b = 0;
let tokenA = "";
let tokenA2 = "";
let tokenBusy = "";
let tokenB = "";
let readTokenA = "";
let ciTokenA = "";
let revoked = "";
let c1 = 0;
let c2 = 0;
let c3 = 0;
let step1 = 0;
let step2 = 0;

/** A run request for the three cases, asked by a person and taken by `token`. */
async function taken(token = tokenA, caseIds = [c1, c2, c3]) {
  const r = await ok<Req>(await askRun(a, caseIds));
  await ok(await take(token, a, r.id));
  return r;
}
const stepIdsOf = (caseId: number) => rows<{ id: number }>("SELECT id FROM case_steps WHERE case_id = ? ORDER BY position", caseId).map((s) => s.id);

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
  a = (await ok<{ id: number }>(await person("/api/projects", { name: "Results A", key: "RSA" }))).id;
  b = (await ok<{ id: number }>(await person("/api/projects", { name: "Results B", key: "RSB" }))).id;
  // A project can have 3 active request tokens: the revoked one is made and revoked first, so that its slot is free again.
  const dead = await mk(a, "request", "to-revoke");
  revoked = dead.token;
  assert.equal((await person(`/api/request-tokens/${dead.id}/revoke`, {})).status, 200);
  tokenA = (await mk(a, "request", "claude-a")).token;
  tokenA2 = (await mk(a, "request", "second-agent")).token;
  tokenBusy = (await mk(a, "request", "busy-agent")).token;
  tokenB = (await mk(b, "request", "claude-b")).token;
  readTokenA = (await mk(a, "agent", "reader")).token;
  ciTokenA = (await mk(a, "ci", "ci")).token;
  c1 = await makeCase(a, "Sign in", { steps: [{ action: "Open /login", expected: "A form" }, { action: "Submit", expected: "Signed in" }] });
  c2 = await makeCase(a, "Pay", { steps: [{ action: "Open /pay", expected: "A form" }] });
  c3 = await makeCase(a, "Log out", { steps: [{ action: "Click log out", expected: "Signed out" }] });
  [step1, step2] = stepIdsOf(c1);
});
after(() => server?.kill());

const written = () => rows("SELECT 1 FROM results WHERE reported_by_agent_token_id IS NOT NULL").length;
const auditRows = () => rows<{ actor_label: string; detail: string }>("SELECT actor_label, detail FROM audit_log WHERE action = 'agent_request.results_reported' ORDER BY id");

describe("who may report results", () => {
  it("is off until a person switches agent results on: 409 and nothing written, then it works", async () => {
    const r = await taken();
    const body = { results: [{ caseId: c1, status: "passed" }] };
    assert.deepEqual(await ok(await person("/api/settings/agent-results", undefined, "GET")), { enabled: false }, "off by default");
    const off = await caseResults(tokenA, a, r.id, body);
    assert.equal(off.status, 409);
    assert.match((await off.json()).error, /Agent results are switched off.*Agent results must be enabled before an agent can report results for a run/);
    assert.deepEqual([written(), auditRows().length], [0, 0], "nothing written and nothing in the audit log");
    await switchResults(true);
    assert.equal((await caseResults(tokenA, a, r.id, body)).status, 200);
    assert.equal(written(), 1);
    await ok(await finish(tokenA, a, r.id, "release")); // keep the next tests simple: the request waits again
  });

  it("refuses a missing, malformed, unknown, revoked, read or CI token with the same 401, and a person's login without a token", async () => {
    const r = await taken();
    const bodies = new Set<string>();
    const before = written();
    for (const header of [undefined, "Bearer", "Basic abc", `Bearer ${tokenA}x`, `Bearer ${revoked}`, `Bearer ${readTokenA}`, `Bearer ${ciTokenA}`]) {
      const res = await agent(header, `/api/agent/projects/${a}/requests/${r.id}/case-results`, "POST", { results: [{ caseId: c1, status: "passed" }] });
      assert.equal(res.status, 401, String(header));
      bodies.add(await res.text());
    }
    assert.equal(bodies.size, 1, "one neutral answer for every kind of refusal");
    assert.equal([...bodies][0].includes("revoked"), false);
    const byPerson = await person(`/api/agent/projects/${a}/requests/${r.id}/case-results`, { results: [{ caseId: c1, status: "passed" }] });
    assert.equal(byPerson.status, 401, "a person's login is not a request token");
    assert.equal(written(), before);
    await ok(await finish(tokenA, a, r.id, "release"));
  });

  it("answers 403 to a valid token of another project, and leaks nothing about that project", async () => {
    const r = await taken();
    const res = await caseResults(tokenB, a, r.id, { results: [{ caseId: c1, status: "passed" }] });
    assert.equal(res.status, 403);
    assert.equal(/RSA|RSB|Results/.test(await res.text()), false);
    assert.equal((await caseResults(tokenA, b, r.id, { results: [{ caseId: c1, status: "passed" }] })).status, 403);
    await ok(await finish(tokenA, a, r.id, "release"));
  });

  it("takes only a run request that this token took and that is still taken: 409 for a discover, a request nobody took, another token's, and a cancelled one", async () => {
    const body = { results: [{ caseId: c1, status: "passed" }] };
    const before = written();
    const discover = await ok<{ id: number }>(await person(`/api/projects/${a}/agent-requests`, { kind: "discover", targetUrl: "http://localhost:3000/" }));
    await ok(await take(tokenA, a, discover.id));
    const d = await caseResults(tokenA, a, discover.id, body);
    assert.equal(d.status, 409);
    assert.match((await d.json()).error, /only taken for a run request/);

    const pending = await ok<Req>(await askRun(a, [c1]));
    const p = await caseResults(tokenA, a, pending.id, body);
    assert.equal(p.status, 409);
    assert.match((await p.json()).error, /not taken/);

    const mine = await taken(tokenA);
    const other = await caseResults(tokenA2, a, mine.id, body);
    assert.equal(other.status, 409);
    assert.match((await other.json()).error, /Another token took this request/);

    assert.equal((await person(`/api/agent-requests/${mine.id}/cancel`, {})).status, 200);
    const cancelled = await caseResults(tokenA, a, mine.id, body);
    assert.equal(cancelled.status, 409);
    assert.match((await cancelled.json()).error, /already done or cancelled/);

    assert.equal((await caseResults(tokenA, a, 999999, body)).status, 404);
    assert.equal(written(), before, "nothing was written");
    await ok(await finish(tokenA, a, discover.id, "release"));
  });
});

describe("what a batch does", () => {
  it("writes each result and marks it, shows the mark and the progress on the run and in the agent's list, and does not finish the request or the run", async () => {
    const r = await taken();
    const res = await caseResults(tokenA, a, r.id, { results: [
      { caseId: c1, status: "failed", error: "Expected 'Signed in'", note: "saw a spinner", durationMs: 4200, steps: [{ stepId: step1, status: "passed", actual: "A form" }, { stepId: step2, status: "failed", actual: "Spinner" }] },
      { caseId: c2, status: "blocked", note: "payment sandbox down" },
    ] });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { reported: 2, counts: { passed: 0, failed: 1, blocked: 1, skipped: 0 }, progress: { total: 3, reported: 2, missing: 1 } });
    const run = await runOf(r.runId!);
    const by = (id: number) => run.results.find((x) => x.case_id === id)!;
    assert.deepEqual([by(c1).status, by(c1).error, by(c1).notes, by(c1).duration_ms, by(c1).reported_by_agent, by(c1).reported_by_agent_token_id], ["failed", "Expected 'Signed in'", "saw a spinner", 4200, "claude-a", tokenId("claude-a")]);
    assert.ok(by(c1).executed_at, "the time is set");
    const detail = await ok<{ error: string; reported_by_agent: string | null; reported_by_agent_token_id: number | null; stepResults: { step_id: number; actual: string }[] }>(await person(`/api/results/${by(c1).id}`, undefined, "GET"));
    assert.deepEqual([detail.reported_by_agent, detail.reported_by_agent_token_id, detail.error], ["claude-a", tokenId("claude-a"), "Expected 'Signed in'"], "the page of one result shows who reported it, and the error");
    assert.equal(detail.stepResults.find((s) => s.step_id === step2)!.actual, "Spinner");
    const human = await ok<{ reported_by_agent: string | null }>(await person(`/api/results/${by(c3).id}`, undefined, "GET"));
    assert.equal(human.reported_by_agent, null, "a result nobody reported has no name");
    assert.deepEqual([by(c2).status, by(c2).reported_by_agent], ["blocked", "claude-a"]);
    assert.deepEqual([by(c3).status, by(c3).reported_by_agent, by(c3).reported_by_agent_token_id], ["untested", null, null], "a case that was not reported has no mark");
    assert.deepEqual(rows("SELECT step_id, status, actual FROM step_results WHERE result_id = ? ORDER BY step_id", by(c1).id), [{ step_id: step1, status: "passed", actual: "A form" }, { step_id: step2, status: "failed", actual: "Spinner" }]);
    assert.deepEqual([run.status, run.agentRequest?.status, run.agentRequest?.progress], ["in_progress", "claimed", { total: 3, reported: 2, missing: 1 }]);
    const list = await ok<Req[]>(await agent(bearer(tokenA), `/api/agent/projects/${a}/requests`));
    assert.equal(list.find((x) => x.id === r.id), undefined, "a request that is taken is not in the waiting list");
    await ok(await finish(tokenA, a, r.id, "release"));
    const waiting = await ok<Req[]>(await agent(bearer(tokenA), `/api/agent/projects/${a}/requests`));
    assert.deepEqual(waiting.find((x) => x.id === r.id)!.progress, { total: 3, reported: 2, missing: 1 }, "an agent that takes it again sees what is left");
    const again = await ok<Req>(await take(tokenA2, a, r.id));
    assert.deepEqual(again.progress, { total: 3, reported: 2, missing: 1 });
    await ok(await finish(tokenA2, a, r.id, "release"));
  });

  it("refuses a bad batch with 400 and writes nothing: untested, inconclusive, an extra field, too long a text, no results, too many, a case twice, a case that is not in the request, a step of another case", async () => {
    const r = await taken();
    const before = written();
    const bad: [string, unknown, RegExp][] = [
      ["untested", { results: [{ caseId: c1, status: "untested" }] }, /passed, failed, blocked or skipped/],
      ["inconclusive", { results: [{ caseId: c1, status: "inconclusive" }] }, /report a result you are not sure of as blocked/],
      ["an extra field", { results: [{ caseId: c1, status: "passed", screenshot: "x" }] }, /screenshot|Unrecognized/i],
      ["an extra field on the batch", { results: [{ caseId: c1, status: "passed" }], extra: 1 }, /extra|Unrecognized/i],
      ["a note that is too long", { results: [{ caseId: c1, status: "passed", note: "x".repeat(2001) }] }, /2000/],
      ["no results", { results: [] }, /results/i],
      ["201 results", { results: Array.from({ length: 201 }, (_, i) => ({ caseId: i + 1, status: "passed" })) }, /200/],
      ["a case twice", { results: [{ caseId: c1, status: "passed" }, { caseId: c1, status: "failed" }] }, /once/],
      ["a case that is not in the request", { results: [{ caseId: c1, status: "passed" }, { caseId: 999999, status: "passed" }] }, /not part of this request/],
      ["a step of another case", { results: [{ caseId: c2, status: "passed", steps: [{ stepId: step1, status: "passed" }] }] }, /is not a step of test case/],
    ];
    for (const [what, body, re] of bad) {
      const res = await caseResults(tokenA, a, r.id, body);
      assert.equal(res.status, 400, what);
      assert.match(JSON.stringify(await res.json()), re, what);
    }
    const notJson = await agent(bearer(tokenA), `/api/agent/projects/${a}/requests/${r.id}/case-results`, "POST");
    assert.equal(notJson.status, 400, "no body");
    assert.equal(written(), before, "nothing was written");
    await ok(await finish(tokenA, a, r.id, "release"));
  });

  it("answers 413 for a body over 256 kB, and writes nothing", async () => {
    const r = await taken();
    const before = written();
    const huge = await caseResults(tokenA, a, r.id, { results: [{ caseId: c1, status: "passed", note: "y".repeat(300_000) }] });
    assert.equal(huge.status, 413);
    assert.equal(written(), before);
    await ok(await finish(tokenA, a, r.id, "release"));
  });
});

describe("what a person can still do", () => {
  it("changes an agent's result like any other, and the mark stays; the agent cannot report it again; a result a person set cannot be written over; a reset does not free it", async () => {
    const r = await taken(tokenA2);
    await ok(await caseResults(tokenA2, a, r.id, { results: [{ caseId: c1, status: "passed", note: "agent says fine" }] }));
    let run = await runOf(r.runId!);
    const agentResult = run.results.find((x) => x.case_id === c1)!;
    // A person changes it.
    const changed = await ok<{ status: string; notes: string }>(await person(`/api/results/${agentResult.id}`, { status: "failed", notes: "I looked, it is broken" }, "PATCH"));
    assert.deepEqual([changed.status, changed.notes], ["failed", "I looked, it is broken"]);
    run = await runOf(r.runId!);
    assert.deepEqual([run.results.find((x) => x.case_id === c1)!.status, run.results.find((x) => x.case_id === c1)!.reported_by_agent], ["failed", "second-agent"], "the mark stays when a person changes it");
    // A person sets another case by hand, then puts it back.
    const other = run.results.find((x) => x.case_id === c2)!;
    await ok(await person(`/api/results/${other.id}`, { status: "passed" }, "PATCH"));
    const written1 = written();
    const over = await caseResults(tokenA2, a, r.id, { results: [{ caseId: c2, status: "failed" }, { caseId: c3, status: "passed" }] });
    assert.equal(over.status, 409);
    assert.match((await over.json()).error, /1 of these test cases already have a result/);
    assert.equal(written(), written1, "nothing of that batch was written, not even the case nobody touched");
    await ok(await person(`/api/results/${other.id}`, { status: "untested" }, "PATCH"));
    assert.equal((await caseResults(tokenA2, a, r.id, { results: [{ caseId: c2, status: "failed" }] })).status, 409, "put back to untested, it is still a person's");
    assert.equal((await caseResults(tokenA2, a, r.id, { results: [{ caseId: c1, status: "passed" }] })).status, 409, "an agent's result is not reported twice");
    assert.equal((await caseResults(tokenA2, a, r.id, { results: [{ caseId: c3, status: "skipped" }] })).status, 200, "the case nobody touched can be");
    // A person can delete the run, and with it the results.
    assert.equal((await call(`/api/runs/${r.runId}`, { method: "DELETE", headers: { "X-Testbench": "1", Cookie: cookie } })).status, 200); // no content type: a DELETE has no body
    assert.equal(rows("SELECT 1 FROM results WHERE run_id = ?", r.runId).length, 0);
  });
});

describe("complete", () => {
  it("is refused with the number of cases that have no result; then it finishes the request and leaves the run in progress for a person to finish", async () => {
    const r = await taken();
    const missing = async (re: RegExp) => { const res = await finish(tokenA, a, r.id, "complete", { note: "done" }); assert.equal(res.status, 409); assert.match((await res.json()).error, re); };
    await missing(/^3 of 3 test cases have no result yet/);
    await ok(await caseResults(tokenA, a, r.id, { results: [{ caseId: c1, status: "passed" }] }));
    await missing(/^2 of 3 test cases have no result yet/);
    await ok(await caseResults(tokenA, a, r.id, { results: [{ caseId: c2, status: "failed" }, { caseId: c3, status: "blocked", note: "no data" }] }));
    const done = await ok<Req & { resultNote: string; resultRunId: number }>(await finish(tokenA, a, r.id, "complete", { note: "all three run" }));
    assert.deepEqual([done.status, done.resultRunId, done.resultNote, done.progress], ["done", r.runId, "all three run", { total: 3, reported: 3, missing: 0 }]);
    const run = await runOf(r.runId!);
    assert.deepEqual([run.status, run.agentRequest?.status], ["in_progress", "done"], "the agent never finishes the run");
    assert.equal((await person(`/api/runs/${r.runId}`, { status: "completed" }, "PATCH")).status, 200, "a person reviews and finishes it");
    assert.equal((await caseResults(tokenA, a, r.id, { results: [{ caseId: c1, status: "passed" }] })).status, 409, "nothing more is taken once it is done");
  });

  it("can be released with some results reported: they stay, and another token reports the rest", async () => {
    const r = await taken(tokenA);
    await ok(await caseResults(tokenA, a, r.id, { results: [{ caseId: c1, status: "passed", note: "kept" }] }));
    const back = await ok<Req>(await finish(tokenA, a, r.id, "release", { note: "out of time" }));
    assert.deepEqual([back.status, back.progress], ["pending", { total: 3, reported: 1, missing: 2 }]);
    const run = await runOf(r.runId!);
    assert.deepEqual([run.results.find((x) => x.case_id === c1)!.status, run.results.find((x) => x.case_id === c1)!.notes], ["passed", "kept"]);
    await ok(await take(tokenA2, a, r.id));
    await ok(await caseResults(tokenA2, a, r.id, { results: [{ caseId: c2, status: "passed" }, { caseId: c3, status: "passed" }] }));
    assert.equal((await finish(tokenA2, a, r.id, "complete")).status, 200);
    const done = await runOf(r.runId!);
    assert.deepEqual(done.results.map((x) => x.reported_by_agent).sort(), ["claude-a", "second-agent", "second-agent"], "each result keeps the mark of the token that reported it");
  });
});

describe("the audit log and the rate limit", () => {
  it("has one entry for each batch that was taken, by 'agent: <name>', with the counts and the credential id, and never a token or a hash", () => {
    const log = auditRows();
    assert.ok(log.length >= 6, "the batches above");
    for (const row of log) {
      assert.match(row.actor_label, /^agent: (claude-a|second-agent)$/);
      const d = JSON.parse(row.detail) as Record<string, unknown>;
      assert.deepEqual(Object.keys(d).sort(), ["blocked", "credential_id", "failed", "kind", "passed", "reported", "request", "run", "skipped"]);
      assert.equal(d.kind, "run");
      assert.equal(d.reported, (d.passed as number) + (d.failed as number) + (d.blocked as number) + (d.skipped as number));
    }
    const first = JSON.parse(log.find((x) => x.actor_label === "agent: claude-a" && JSON.parse(x.detail).failed === 1)!.detail);
    assert.equal(first.credential_id, tokenId("claude-a"));
    const all = JSON.stringify(rows("SELECT * FROM audit_log"));
    for (const t of issued) assert.equal(all.includes(t), false, "a token is in the audit log");
    for (const h of rows<{ token_hash: string }>("SELECT token_hash FROM request_tokens").map((x) => x.token_hash)) assert.equal(all.includes(h), false, "a token hash is in the audit log");
  });

  it("answers 429 after 60 reports a minute from one token, counting the refused ones too, and does not slow another token", async () => {
    const busy = await taken(tokenBusy);
    const other = await taken(tokenA);
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++) statuses.push((await caseResults(tokenBusy, a, busy.id, { results: [] })).status); // each is refused as a bad batch, and still counts
    assert.equal(statuses.filter((s) => s === 400).length, 60);
    assert.deepEqual(statuses.slice(60), [429, 429]);
    const limited = await caseResults(tokenBusy, a, busy.id, { results: [{ caseId: c1, status: "passed" }] });
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).error, /at most 60 a minute/);
    assert.equal(rows("SELECT 1 FROM results WHERE run_id = ? AND status != 'untested'", busy.runId).length, 0, "nothing was written while it was limited");
    assert.equal((await caseResults(tokenA, a, other.id, { results: [{ caseId: c1, status: "passed" }] })).status, 200, "another token is not slowed down");
  });

  it("never prints a token to the server's output", () => {
    for (const t of issued) assert.equal(output.includes(t), false, "a token reached the server's output");
  });
});
