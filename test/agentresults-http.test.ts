import "./env.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// The real server, as a separate process. A request token may hand in the Playwright report of a re-run, and only when a person has switched that on. It makes one run, marked
// source `agent`, for the request this very token took, once, with tests that request named. Anything else is refused whole and leaves nothing behind.

const ROOT = join(import.meta.dirname, "..");
const PORT = 47000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "a long test passphrase";
const JSON_H = { "Content-Type": "application/json" };
let server: ChildProcess;
let output = "";
let cookie = "";

const call = (path: string, init: RequestInit = {}) => fetch(`${BASE}${path}`, init);
const person = (path: string, body?: unknown, method = "POST") =>
  call(path, { method, headers: { ...JSON_H, "X-Testbench": "1", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const agent = (token: string, path: string, method = "GET", body?: unknown) =>
  call(path, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : JSON_H) }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const ok = async <T>(res: Response) => { const raw = await res.text(); assert.ok(res.ok, raw); return JSON.parse(raw) as T; };

/** A Playwright JSON report: one spec per name, each a test of project "chromium", passed or failed. */
const report = (specs: Record<string, "passed" | "failed">) => ({
  config: { rootDir: "/repo" }, stats: { startTime: "2026-01-02T03:04:05.000Z" },
  suites: [{
    title: "shop.spec.ts", file: "shop.spec.ts",
    specs: Object.entries(specs).map(([title, s]) => ({
      title, file: "shop.spec.ts", line: 3, column: 1,
      tests: [{ projectName: "chromium", status: s === "passed" ? "expected" : "unexpected", results: [{ status: s, duration: 12, retry: 0, ...(s === "failed" ? { error: { message: "boom" } } : {}) }] }],
    })),
  }],
});

let a = 0;
let b = 0;
let tokenA = "";
let tokenA2 = "";
let tokenB = "";
let readTokenA = "";
let ciTokenA = "";

const runsOf = async (projectId: number) => ok<{ id: number; source: string; environment: string; meta: Record<string, unknown> }[]>(await person(`/api/projects/${projectId}/runs`, undefined, "GET"));
const tests = async (projectId: number) => ok<{ full_name: string; last_status: string; case_id: number | null }[]>(await person(`/api/projects/${projectId}/automated`, undefined, "GET"));
const view = async (projectId: number, id: number) => (await ok<{ id: number; status: string; resultRunId: number | null; resultDeliveredAt: string | null }[]>(await person(`/api/projects/${projectId}/agent-requests`, undefined, "GET"))).find((x) => x.id === id)!;

/** A person imports a run of failed tests, then asks for a re-run of it. */
async function rerunRequest(projectId: number, specs: Record<string, "passed" | "failed">, environment = "staging") {
  const form = new FormData();
  form.set("environment", "from-import");
  form.set("file", new Blob([JSON.stringify(report(specs))], { type: "application/json" }), "report.json");
  const imp = await call(`/api/projects/${projectId}/import`, { method: "POST", headers: { "X-Testbench": "1", Cookie: cookie }, body: form });
  const { runId } = await ok<{ runId: number }>(imp);
  const r = await ok<{ id: number }>(await person(`/api/projects/${projectId}/agent-requests`, { kind: "rerun", runId, environment }));
  return { runId, id: r.id };
}
const take = (token: string, projectId: number, id: number) => agent(token, `/api/agent/projects/${projectId}/requests/${id}/claim`, "POST");
const hand = (token: string, projectId: number, id: number, body: unknown) => agent(token, `/api/agent/projects/${projectId}/requests/${id}/result`, "POST", body);
const switchResults = async (on: boolean) => ok(await person("/api/settings/agent-results", { enabled: on }, "PUT"));

before(async () => {
  server = spawn(process.execPath, ["--import", "tsx", join(ROOT, "server", "index.ts")], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TESTBENCH_DATA: mkdtempSync(join(tmpdir(), "tb-agent-results-")), TESTBENCH_PORT: String(PORT), TESTBENCH_PASSWORD: PASSWORD, NODE_ENV: "production", TESTBENCH_AUTO_BACKUP: "0" },
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
  a = (await ok<{ id: number }>(await person("/api/projects", { name: "Res A", key: "RSA" }))).id;
  b = (await ok<{ id: number }>(await person("/api/projects", { name: "Res B", key: "RSB" }))).id;
  const mk = async (projectId: number, path: string, name: string) => (await ok<{ token: string }>(await person(`/api/projects/${projectId}/${path}`, { name }))).token;
  tokenA = await mk(a, "request-tokens", "qa-agent");
  tokenA2 = await mk(a, "request-tokens", "second-agent");
  tokenB = await mk(b, "request-tokens", "b-agent");
  readTokenA = await mk(a, "agent/tokens", "reader");
  ciTokenA = await mk(a, "ci/tokens", "ci");
});
after(() => server?.kill());

describe("a report is refused while a person has not switched agent results on", () => {
  it("is off by default, and the route refuses and writes nothing", async () => {
    assert.deepEqual(await ok(await person("/api/settings/agent-results", undefined, "GET")), { enabled: false });
    const r = await rerunRequest(a, { "login works": "failed", "cart works": "failed" });
    assert.equal((await take(tokenA, a, r.id)).status, 200);
    const n = (await runsOf(a)).length;
    const res = await hand(tokenA, a, r.id, report({ "login works": "passed" }));
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /switched off/);
    assert.equal((await runsOf(a)).length, n, "no run was made");
    assert.equal((await view(a, r.id)).resultDeliveredAt, null);
  });
});

describe("a report that is taken", () => {
  before(async () => { await switchResults(true); });
  after(async () => { await switchResults(false); });

  it("makes one run marked as the agent's, in the request's environment, linked to the request, and the results count like any others", async () => {
    const r = await rerunRequest(a, { "pay works": "failed", "ship works": "failed" }, "staging");
    await take(tokenA, a, r.id);
    // Only one of the two failed tests is in the report, which is fine.
    const res = await hand(tokenA, a, r.id, report({ "pay works": "passed" }));
    assert.equal(res.headers.get("cache-control"), "no-store");
    const out = await ok<{ runId: number; total: number }>(res);
    assert.equal(out.total, 1);
    const run = (await runsOf(a)).find((x) => x.id === out.runId)!;
    assert.deepEqual([run.source, run.environment], ["agent", "staging"]);
    assert.equal(run.meta.agentRequest, r.id);
    assert.equal(run.meta.deliveredBy, "qa-agent");
    const mine = await view(a, r.id);
    assert.equal(mine.resultRunId, out.runId);
    assert.ok(mine.resultDeliveredAt);
    assert.equal(mine.status, "claimed", "handing in is not finishing: the agent still says it is done");
    assert.equal((await tests(a)).find((t) => t.full_name.startsWith("shop.spec.ts › pay works"))?.last_status, "passed", "last status follows the agent's run");
    // finishing keeps the delivered run, and cannot name another
    assert.equal((await agent(tokenA, `/api/agent/projects/${a}/requests/${r.id}/complete`, "POST", { resultRunId: r.runId })).status, 400);
    const done = await ok<{ status: string; resultRunId: number }>(await agent(tokenA, `/api/agent/projects/${a}/requests/${r.id}/complete`, "POST", { note: "1 of 2 passed now" }));
    assert.deepEqual([done.status, done.resultRunId], ["done", out.runId]);
  });

  it("is taken once, even after a person deleted the run it made", async () => {
    const r = await rerunRequest(a, { "once works": "failed" });
    await take(tokenA, a, r.id);
    const first = await ok<{ runId: number }>(await hand(tokenA, a, r.id, report({ "once works": "passed" })));
    assert.equal((await hand(tokenA, a, r.id, report({ "once works": "failed" }))).status, 409);
    assert.equal((await call(`/api/runs/${first.runId}`, { method: "DELETE", headers: { "X-Testbench": "1", Cookie: cookie } })).status, 200);
    const n = (await runsOf(a)).length;
    assert.equal((await hand(tokenA, a, r.id, report({ "once works": "failed" }))).status, 409, "a deleted run does not open the door again");
    assert.equal((await runsOf(a)).length, n);
    const done = await ok<{ status: string; resultRunId: number | null }>(await agent(tokenA, `/api/agent/projects/${a}/requests/${r.id}/complete`, "POST", {}));
    assert.deepEqual([done.status, done.resultRunId], ["done", null]);
  });

  it("touches only the tests it carries: another unlinked test is not linked to a case by the ID in its name", async () => {
    // an automated test whose name holds a case ID, imported before that case existed, so it is unlinked
    await rerunRequest(b, { "orphan RSB-1 works": "failed" });
    const orphan = () => tests(b).then((all) => all.find((t) => t.full_name.includes("orphan RSB-1 works"))!);
    assert.equal((await orphan()).case_id, null);
    const r = await rerunRequest(b, { "carried works": "failed" }); // a person's import, before the case exists
    await take(tokenB, b, r.id);
    await ok(await person(`/api/projects/${b}/cases`, { title: "The case it names" }));
    await ok(await hand(tokenB, b, r.id, report({ "carried works": "passed" })));
    assert.equal((await orphan()).case_id, null, "the agent's report did not link it");
    // the same project, the same test, a person's relink does link it: so the check above proves something
    await ok(await person(`/api/projects/${b}/automated/relink`, {}));
    assert.notEqual((await orphan()).case_id, null);
  });

  it("two reports at once make one run", async () => {
    const r = await rerunRequest(a, { "race works": "failed" });
    await take(tokenA, a, r.id);
    const n = (await runsOf(a)).length;
    const codes = (await Promise.all([1, 2, 3].map(() => hand(tokenA, a, r.id, report({ "race works": "passed" }))))).map((x) => x.status).sort();
    assert.deepEqual(codes, [200, 409, 409]);
    assert.equal((await runsOf(a)).length, n + 1);
  });
});

describe("a report that is refused whole, with nothing left behind", () => {
  before(async () => { await switchResults(true); });
  after(async () => { await switchResults(false); });

  it("a test the request did not name, a test twice, an empty report, something that is not a Playwright report", async () => {
    const r = await rerunRequest(a, { "named works": "failed" });
    await take(tokenA, a, r.id);
    const n = (await runsOf(a)).length;
    const known = (await tests(a)).length;
    for (const [what, body, pattern] of [
      ["a stranger beside a named test", report({ "named works": "passed", "stranger works": "passed" }), /did not name/],
      ["only a stranger", report({ "stranger works": "passed" }), /did not name/],
      ["empty", report({}), /no tests/],
      ["not a report", { hello: "world" }, /not a Playwright/],
      ["a list", [1, 2], /request body/],
    ] as const) {
      const res = await hand(tokenA, a, r.id, body);
      assert.equal(res.status, 400, what);
      assert.match(((await res.json()) as { error: string }).error, pattern, what);
    }
    const twice = report({ "named works": "passed" });
    twice.suites[0].specs.push(twice.suites[0].specs[0]);
    assert.equal((await hand(tokenA, a, r.id, twice)).status, 400);
    assert.equal((await tests(a)).length, known, "the stranger was not added as a test");
    assert.equal((await runsOf(a)).length, n, "no run was made");
    assert.equal((await view(a, r.id)).resultDeliveredAt, null, "nothing is marked as delivered");
  });

  it("a request that is not taken, taken by another token, not a re-run, or already finished", async () => {
    const pending = await rerunRequest(a, { "pending works": "failed" });
    const theirs = await rerunRequest(a, { "theirs works": "failed" });
    await take(tokenA2, a, theirs.id);
    const done = await rerunRequest(a, { "done works": "failed" });
    await take(tokenA, a, done.id);
    await agent(tokenA, `/api/agent/projects/${a}/requests/${done.id}/complete`, "POST", {});
    const discover = await ok<{ id: number }>(await person(`/api/projects/${a}/agent-requests`, { kind: "discover", targetUrl: "https://x.example.com" }));
    await take(tokenA, a, discover.id);
    const n = (await runsOf(a)).length;
    assert.equal((await hand(tokenA, a, pending.id, report({ "pending works": "passed" }))).status, 409);
    assert.equal((await hand(tokenA, a, theirs.id, report({ "theirs works": "passed" }))).status, 409);
    assert.equal((await hand(tokenA, a, done.id, report({ "done works": "passed" }))).status, 409);
    assert.equal((await hand(tokenA, a, discover.id, report({ x: "passed" }))).status, 400);
    assert.equal((await hand(tokenA, a, 999999, report({ x: "passed" }))).status, 404);
    assert.equal((await runsOf(a)).length, n);
  });

  it("a person cancelled the request in the meantime", async () => {
    const r = await rerunRequest(a, { "cancelled works": "failed" });
    await take(tokenA, a, r.id);
    await person(`/api/agent-requests/${r.id}/cancel`, {});
    const n = (await runsOf(a)).length;
    assert.equal((await hand(tokenA, a, r.id, report({ "cancelled works": "passed" }))).status, 409);
    assert.equal((await runsOf(a)).length, n);
  });

  it("is too large (over 5 MB)", async () => {
    const r = await rerunRequest(a, { "big works": "failed" });
    await take(tokenA, a, r.id);
    const n = (await runsOf(a)).length;
    const big = JSON.stringify({ ...report({ "big works": "passed" }), pad: "x".repeat(5 * 1024 * 1024 + 10) });
    const res = await hand(tokenA, a, r.id, big).catch(() => null); // the server may also drop the connection
    if (res) assert.equal(res.status, 413);
    assert.equal((await runsOf(a)).length, n);
  });
});

describe("who may hand in a report", () => {
  before(async () => { await switchResults(true); });
  after(async () => { await switchResults(false); });

  it("only a request token of the project: not another project's, not the other kinds of token, not a login alone", async () => {
    const r = await rerunRequest(a, { "who works": "failed" });
    await take(tokenA, a, r.id);
    const n = (await runsOf(a)).length;
    assert.equal((await hand(tokenB, a, r.id, report({ "who works": "passed" }))).status, 403);
    assert.equal((await hand(readTokenA, a, r.id, report({ "who works": "passed" }))).status, 401);
    assert.equal((await hand(ciTokenA, a, r.id, report({ "who works": "passed" }))).status, 401);
    assert.equal((await call(`/api/agent/projects/${a}/requests/${r.id}/result`, { method: "POST", headers: JSON_H, body: JSON.stringify(report({ "who works": "passed" })) })).status, 401);
    assert.equal((await person(`/api/agent/projects/${a}/requests/${r.id}/result`, report({ "who works": "passed" }))).status, 401);
    assert.equal((await runsOf(a)).length, n);
  });

  it("no agent token can switch it on", async () => {
    for (const t of [tokenA, ciTokenA, readTokenA]) {
      const res = await call("/api/settings/agent-results", { method: "PUT", headers: { ...JSON_H, Authorization: `Bearer ${t}`, "X-Testbench": "1", Cookie: cookie }, body: JSON.stringify({ enabled: true }) });
      assert.equal(res.status, 403);
    }
  });
});
