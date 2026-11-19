import "./env.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import Database from "better-sqlite3";

// The real server, started as a separate process with a password set. AG4: a person asks an agent to run chosen test cases from the route that already makes requests. The run is made
// at once and says it waits; a request token sees the request, takes it, can give it back, and cannot finish it while a test case has no result (the results are in agent-case-results-http.test.ts); a person can cancel it and still run the cases by hand.

const ROOT = join(import.meta.dirname, "..");
const PORT = 55000 + Math.floor(Math.random() * 1000); // its own range: the other server tests use 41000 to 54999
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "a long test passphrase";
const JSON_H = { "Content-Type": "application/json" };
const DATA = mkdtempSync(join(tmpdir(), "tb-agent-run-requests-"));
let server: ChildProcess;
let output = "";
let cookie = "";

const call = (path: string, init: RequestInit = {}) => fetch(`${BASE}${path}`, init);
const person = (path: string, body?: unknown, method = "POST") =>
  call(path, { method, headers: { ...JSON_H, "X-Testbench": "1", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const agent = (token: string | undefined, path: string, method = "GET", body?: unknown) =>
  call(path, { method, headers: { ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }), ...(body === undefined ? {} : JSON_H) }, body: body === undefined ? undefined : JSON.stringify(body) });
const ok = async <T>(res: Response) => { const raw = await res.text(); assert.ok(res.ok, raw); return JSON.parse(raw) as T; };
const rows = <T>(sql: string, ...args: unknown[]) => { const d = new Database(join(DATA, "testbench.db"), { readonly: true }); try { return d.prepare(sql).all(...args) as T[]; } finally { d.close(); } };

type Req = { id: number; kind: string; status: string; runId: number | null; caseCount: number; cases: Record<string, any>[]; targetUrl: string; environment: string; releaseNote: string; claimedBy: string | null };
const URL_OK = "https://staging.example.com/";
const askRun = (projectId: number, caseIds: number[], extra: Record<string, unknown> = {}) => person(`/api/projects/${projectId}/agent-requests`, { kind: "run", targetUrl: URL_OK, caseIds, ...extra });
const makeCase = async (projectId: number, title: string, extra: Record<string, unknown> = {}) =>
  (await ok<{ id: number }>(await person(`/api/projects/${projectId}/cases`, { title, status: "ready", ...extra }))).id;
const runOf = async (id: number) => ok<{ id: number; kind: string; source: string; status: string; meta: Record<string, any>; agentRequest: { id: number; status: string; claimedBy: string | null } | null; results: { id: number; case_id: number; status: string }[] }>(await person(`/api/runs/${id}`, undefined, "GET"));
const listFor = async (token: string, projectId: number) => ok<Req[]>(await agent(token, `/api/agent/projects/${projectId}/requests`));
const claim = (token: string, projectId: number, id: number) => agent(token, `/api/agent/projects/${projectId}/requests/${id}/claim`, "POST");
const issued: string[] = [];
const mk = async (projectId: number, name: string) => { const t = await ok<{ token: string }>(await person(`/api/projects/${projectId}/request-tokens`, { name })); issued.push(t.token); return t.token; };

let a = 0;
let b = 0;
let tokenA = "";
let tokenA2 = "";
let tokenB = "";
let c1 = 0;
let c2 = 0;
let deprecated = 0;
let foreign = 0;

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
  a = (await ok<{ id: number }>(await person("/api/projects", { name: "Run A", key: "RNA" }))).id;
  b = (await ok<{ id: number }>(await person("/api/projects", { name: "Run B", key: "RNB" }))).id;
  tokenA = await mk(a, "claude-a");
  tokenA2 = await mk(a, "second-agent");
  tokenB = await mk(b, "claude-b");
  c1 = await makeCase(a, "Sign in", { description: "The happy path", preconditions: "An account exists", priority: "high", steps: [{ action: "Open /login", expected: "A form" }, { action: "Submit", expected: "Signed in" }] });
  c2 = await makeCase(a, "Pay", { steps: [{ action: "Open /pay", expected: "A form" }] });
  deprecated = await makeCase(a, "Old", { status: "deprecated" });
  foreign = await makeCase(b, "Theirs");
  // What must never reach the agent: the text of a spec and of a requirement that are linked to a chosen case.
  await ok(await person(`/api/projects/${a}/specs`, { fileName: "login.spec.ts", text: "// SECRET-SPEC-TEXT\ntest('signs in', async () => {});", caseId: c1 }));
  const req = await ok<{ id: number }>(await person(`/api/projects/${a}/requirements`, { title: "SECRET-REQUIREMENT-TITLE", description: "SECRET-REQUIREMENT-TEXT" }));
  await ok(await person(`/api/cases/${c1}/requirements`, { requirementIds: [req.id] }, "PUT"));
});
after(() => server?.kill());

describe("a person asks an agent to run test cases", () => {
  it("makes the run and the request together: a manual run with an empty result per case that says it waits for an agent, in the list and on its page", async () => {
    const r = await ok<Req>(await askRun(a, [c1, c2], { environment: "staging", title: "Agent run · smoke", note: "look at the login" }));
    assert.deepEqual([r.kind, r.status, r.caseCount, r.targetUrl, r.environment], ["run", "pending", 2, URL_OK, "staging"]);
    assert.ok(r.runId);
    const run = await runOf(r.runId!);
    assert.deepEqual([run.kind, run.source, run.status, run.meta.agentRequest], ["manual", "manual", "in_progress", r.id]);
    assert.deepEqual(run.agentRequest, { id: r.id, status: "pending", claimedBy: null, progress: { total: 2, reported: 0, missing: 2 } });
    assert.deepEqual(run.results.map((x) => [x.case_id, x.status]), [[c1, "untested"], [c2, "untested"]]);
    const list = await ok<{ id: number; source: string; agentRequest: { id: number; status: string } | null }[]>(await person(`/api/projects/${a}/runs`, undefined, "GET"));
    const inList = list.find((x) => x.id === r.runId)!;
    assert.deepEqual([inList.source, inList.agentRequest?.id, inList.agentRequest?.status], ["manual", r.id, "pending"]);
    assert.equal("agent_request" in inList, false, "the raw column is not part of the answer");
    const byHand = await ok<{ id: number }>(await person(`/api/projects/${a}/runs`, { title: "By hand", caseIds: [c1] }));
    assert.equal((await runOf(byHand.id)).agentRequest, null, "a run nobody asked an agent about says nothing");
  });

  it("writes who asked, which run was made and how many cases it holds to the audit log", async () => {
    const r = await ok<Req>(await askRun(a, [c1]));
    const log = rows<{ actor_label: string; actor_user_id: number | null; detail: string; project_id: number }>("SELECT actor_label, actor_user_id, detail, project_id FROM audit_log WHERE action = 'agent_request.created' AND detail LIKE ?", `%"request":${r.id},%`);
    assert.equal(log.length, 1);
    assert.deepEqual(JSON.parse(log[0].detail), { request: r.id, kind: "run", run: r.runId, cases: 1 });
    assert.equal(log[0].project_id, a);
    assert.equal(log[0].actor_label.startsWith("agent:"), false, "a person asked, not an agent");
  });

  it("answers 400 for no cases, no address, a bad address, a case of another project and a deprecated case, and makes no run", async () => {
    const runs = () => rows<{ n: number }>("SELECT COUNT(*) AS n FROM runs")[0].n;
    const requests = () => rows<{ n: number }>("SELECT COUNT(*) AS n FROM agent_requests")[0].n;
    const before = [runs(), requests()];
    for (const body of [
      { kind: "run", targetUrl: URL_OK, caseIds: [] }, { kind: "run", targetUrl: URL_OK }, { kind: "run", caseIds: [c1] }, { kind: "run", targetUrl: "ftp://x", caseIds: [c1] },
      { kind: "run", targetUrl: "https://u:p@x.example.com", caseIds: [c1] }, { kind: "run", targetUrl: URL_OK, caseIds: [c1, foreign] }, { kind: "run", targetUrl: URL_OK, caseIds: [deprecated] },
      { kind: "run", targetUrl: URL_OK, caseIds: ["1"] }, { kind: "run", targetUrl: URL_OK, caseIds: [c1], templateId: "x" },
    ]) {
      const res = await person(`/api/projects/${a}/agent-requests`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.deepEqual([runs(), requests()], before);
    assert.equal((await call(`/api/projects/${a}/agent-requests`, { method: "POST", headers: { ...JSON_H, "X-Testbench": "1" }, body: JSON.stringify({ kind: "run", targetUrl: URL_OK, caseIds: [c1] }) })).status, 401, "nobody who is not signed in");
  });
});

describe("what the agent sees", () => {
  it("lists the request without the text of the cases, and gives the approved structure when it takes it: never the text of a spec or of a requirement", async () => {
    const r = await ok<Req>(await askRun(a, [c1, c2], { environment: "staging" }));
    const waiting = (await listFor(tokenA, a)).find((x) => x.id === r.id)!;
    assert.deepEqual([waiting.kind, waiting.caseCount, waiting.cases], ["run", 2, []]);
    const res = await claim(tokenA, a, r.id);
    const raw = await res.text();
    assert.equal(res.status, 200, raw);
    const taken = JSON.parse(raw) as Req;
    assert.deepEqual([taken.kind, taken.status, taken.runId, taken.targetUrl, taken.environment, taken.claimedBy], ["run", "claimed", r.runId, URL_OK, "staging", "agent: claude-a"]);
    assert.equal(taken.cases.length, 2);
    const k = taken.cases[0];
    assert.deepEqual(Object.keys(k), ["caseId", "key", "number", "title", "description", "preconditions", "priority", "steps", "automatedTests", "specFiles"]);
    assert.deepEqual([k.caseId, k.title, k.description, k.preconditions, k.priority, k.specFiles], [c1, "Sign in", "The happy path", "An account exists", "high", ["login.spec.ts"]]);
    assert.deepEqual(k.steps.map((s: { action: string; expected: string }) => [s.action, s.expected]), [["Open /login", "A form"], ["Submit", "Signed in"]]);
    assert.ok(k.steps.every((s: { id: unknown }) => Number.isInteger(s.id)));
    for (const text of [JSON.stringify(waiting), raw]) for (const secret of ["SECRET-SPEC-TEXT", "SECRET-REQUIREMENT-TITLE", "SECRET-REQUIREMENT-TEXT"]) assert.equal(text.includes(secret), false, secret);
    await ok(await agent(tokenA, `/api/agent/projects/${a}/requests/${r.id}/release`, "POST", {}));
  });

  it("never lists a request of another project, and a token of another project cannot take it", async () => {
    const r = await ok<Req>(await askRun(a, [c1]));
    assert.equal((await listFor(tokenB, b)).some((x) => x.id === r.id), false);
    assert.equal((await claim(tokenB, a, r.id)).status, 403);
    assert.equal((await claim(tokenB, b, r.id)).status, 404, "inside its own project it does not exist");
  });
});

describe("take, give back, cannot finish without results, cancel", () => {
  it("shows the state on the run as it changes; complete answers 409 while a test case has no result, release works, a person cancels, and the cases can still be run by hand", async () => {
    const r = await ok<Req>(await askRun(a, [c1, c2], { title: "State walk" }));
    const state = async () => (await runOf(r.runId!)).agentRequest;
    const progress = { total: 2, reported: 0, missing: 2 };
    assert.deepEqual(await state(), { id: r.id, status: "pending", claimedBy: null, progress });

    assert.equal((await claim(tokenA, a, r.id)).status, 200);
    assert.deepEqual(await state(), { id: r.id, status: "claimed", claimedBy: "agent: claude-a", progress });
    assert.equal((await claim(tokenA2, a, r.id)).status, 409, "only one agent takes it");

    const complete = await agent(tokenA, `/api/agent/projects/${a}/requests/${r.id}/complete`, "POST", { note: "done" });
    assert.equal(complete.status, 409);
    assert.match((await complete.json()).error, /^2 of 2 test cases have no result yet/);
    assert.deepEqual(await state(), { id: r.id, status: "claimed", claimedBy: "agent: claude-a", progress }, "nothing changed");

    const back = await ok<Req>(await agent(tokenA, `/api/agent/projects/${a}/requests/${r.id}/release`, "POST", { note: "no browser here" }));
    assert.deepEqual([back.status, back.releaseNote], ["pending", "no browser here"]);
    assert.deepEqual(await state(), { id: r.id, status: "pending", claimedBy: null, progress });
    assert.equal((await claim(tokenA2, a, r.id)).status, 200, "another agent can take it now");
    assert.equal((await agent(tokenA, `/api/agent/projects/${a}/requests/${r.id}/complete`, "POST", {})).status, 409, "and the first one no longer can");

    const cancelled = await ok<Req>(await person(`/api/agent-requests/${r.id}/cancel`, {}));
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(await state(), { id: r.id, status: "cancelled", claimedBy: "agent: second-agent", progress });

    const run = await runOf(r.runId!);
    assert.equal(run.status, "in_progress", "the run is kept");
    assert.deepEqual(run.results.map((x) => x.status), ["untested", "untested"]);
    const set = await ok<{ status: string }>(await person(`/api/results/${run.results[0].id}`, { status: "passed" }, "PATCH"));
    assert.equal(set.status, "passed", "a person can still run the cases by hand");
  });

  it("refuses findings and the report of a re-run for a run request, and makes nothing", async () => {
    const r = await ok<Req>(await askRun(a, [c1]));
    await ok(await claim(tokenA, a, r.id));
    const runsBefore = rows<{ n: number }>("SELECT COUNT(*) AS n FROM runs")[0].n;
    const finding = await agent(tokenA, `/api/agent/projects/${a}/requests/${r.id}/findings`, "POST", { kind: "observation", title: "x" });
    assert.equal(finding.status, 409);
    assert.match((await finding.json()).error, /discover request/);
    const report = await agent(tokenA, `/api/agent/projects/${a}/requests/${r.id}/result`, "POST", { suites: [] });
    assert.ok([400, 409].includes(report.status), String(report.status));
    assert.equal(rows<{ n: number }>("SELECT COUNT(*) AS n FROM runs")[0].n, runsBefore, "no run was made");
    assert.equal(rows<{ n: number }>("SELECT COUNT(*) AS n FROM observations WHERE origin_audit_id = ?", `$agent-${r.id}`)[0].n, 0);
    await ok(await agent(tokenA, `/api/agent/projects/${a}/requests/${r.id}/release`, "POST", {}));
  });

  it("a request whose run was deleted is not offered, cannot be taken, shows no run to a person, and can be cancelled", async () => {
    const gone = await ok<Req>(await askRun(a, [c1]));
    assert.equal((await call(`/api/runs/${gone.runId}`, { method: "DELETE", headers: { "X-Testbench": "1", Cookie: cookie } })).status, 200, "a person deletes the run");
    assert.equal((await listFor(tokenA, a)).some((x) => x.id === gone.id), false, "not offered");
    const res = await claim(tokenA, a, gone.id);
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /run of this request was deleted/);
    const mine = (await ok<Req[]>(await person(`/api/projects/${a}/agent-requests`, undefined, "GET"))).find((x) => x.id === gone.id)!;
    assert.deepEqual([mine.runId, mine.status, mine.caseCount], [null, "pending", 1]);
    assert.equal((await ok<Req>(await person(`/api/agent-requests/${gone.id}/cancel`, {}))).status, "cancelled");
  });

  it("counts a run request among the 20 that can wait", async () => {
    const p = (await ok<{ id: number }>(await person("/api/projects", { name: "Run C", key: "RNC" }))).id;
    const c = await makeCase(p, "One");
    for (let i = 0; i < 20; i++) await ok(await askRun(p, [c]));
    const res = await askRun(p, [c]);
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /At most 20/);
  });
});

describe("the log and the secrets", () => {
  it("logs that a person put a request first, as that person and with the request and its kind", async () => {
    const p = (await ok<{ id: number }>(await person("/api/projects", { name: "Put first", key: "PTF" }))).id;
    const r = await ok<{ id: number }>(await person(`/api/projects/${p}/agent-requests`, { kind: "discover", targetUrl: "https://first.example.com" }));
    assert.equal((await person(`/api/agent-requests/${r.id}/run-next`, {})).status, 200);
    const mine = rows<{ actor_label: string; detail: string }>("SELECT actor_label, detail FROM audit_log WHERE action = 'agent_request.put_first'").find((l) => JSON.parse(l.detail).request === r.id);
    assert.ok(mine, "an entry for this request");
    assert.equal(JSON.parse(mine.detail).kind, "discover");
    assert.equal(mine.actor_label.startsWith("agent: "), false, "it is a person's act, never an agent's");
  });

  it("logs taking, giving back and cancelling a run request with the run and the number of cases, and never holds a token or a hash", () => {
    const log = rows<{ action: string; actor_label: string; detail: string }>("SELECT action, actor_label, detail FROM audit_log WHERE action IN ('agent_request.claimed', 'agent_request.released', 'agent_request.cancelled') AND detail LIKE '%\"kind\":\"run\"%'");
    for (const action of ["agent_request.claimed", "agent_request.released", "agent_request.cancelled"]) assert.ok(log.some((l) => l.action === action), action);
    assert.ok(log.every((l) => "run" in JSON.parse(l.detail) && "cases" in JSON.parse(l.detail)), "each entry names the run and the number of cases");
    assert.ok(log.filter((l) => l.action !== "agent_request.cancelled").every((l) => l.actor_label.startsWith("agent: ")));
    const all = JSON.stringify(rows("SELECT * FROM audit_log"));
    for (const t of issued) assert.equal(all.includes(t), false, "a token is in the audit log");
    for (const h of rows<{ token_hash: string }>("SELECT token_hash FROM request_tokens").map((x) => x.token_hash)) assert.equal(all.includes(h), false, "a token hash is in the audit log");
  });

  it("never prints a token to the server's output", () => {
    for (const t of issued) assert.equal(output.includes(t), false, "a token reached the server's output");
  });
});
