import "./env.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import Database from "better-sqlite3";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The MCP server (mcp/index.ts, over stdio) against the REAL TestBench server and its existing agent-request queue: a person asks, the agent takes the request through the
// tools, finishes or gives it back, and the queue says so. Nothing is mocked except that the "agent" is this test.

const ROOT = join(import.meta.dirname, "..");
const PORT = 53000 + Math.floor(Math.random() * 1000); // its own range: the other server tests use 41000 to 52000
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "a long test passphrase";
const JSON_H = { "Content-Type": "application/json" };
const DATA = mkdtempSync(join(tmpdir(), "tb-mcp-bridge-"));
let server: ChildProcess;
let output = "";
let cookie = "";

const call = (path: string, init: RequestInit = {}) => fetch(`${BASE}${path}`, init);
const person = (path: string, body?: unknown, method = "POST") =>
  call(path, { method, headers: { ...JSON_H, "X-Testbench": "1", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const ok = async <T>(res: Response) => { const raw = await res.text(); assert.ok(res.ok, raw); return JSON.parse(raw) as T; };
const rows = <T>(sql: string, ...args: unknown[]) => { const d = new Database(join(DATA, "testbench.db"), { readonly: true }); try { return d.prepare(sql).all(...args) as T[]; } finally { d.close(); } };

type Result = { isError?: boolean; content: { type: string; text: string }[] };
const text = (r: Result) => r.content.map((c) => c.text).join("\n");
const issued: string[] = [];
const stderrs: string[] = [];

/** An agent session: the MCP server started the way Claude would start it. */
async function session(token: string, projectId: number) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: ["--import", "tsx", join(ROOT, "mcp", "index.ts")], cwd: ROOT, stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", TESTBENCH_URL: BASE, TESTBENCH_TOKEN: token, TESTBENCH_PROJECT_ID: String(projectId) },
  });
  let err = "";
  transport.stderr?.on("data", (d) => (err += d));
  const mcp = new McpClient({ name: "test", version: "0" });
  await mcp.connect(transport);
  return {
    tool: async (name: string, args: Record<string, unknown> = {}) => (await mcp.callTool({ name, arguments: args })) as Result,
    close: async () => { await mcp.close(); stderrs.push(err); },
  };
}
const next = async (s: Awaited<ReturnType<typeof session>>) => {
  const r = await s.tool("testbench_get_next_request");
  assert.equal(r.isError, undefined, text(r));
  return JSON.parse(text(r)) as { request: { id: number; kind: string; status: string; targetUrl: string; claimedBy: string } | null; note?: string };
};
const list = async (projectId: number) => ok<{ id: number; status: string; resultNote: string; releaseNote: string; claimedBy: string | null }[]>(await person(`/api/projects/${projectId}/agent-requests`, undefined, "GET"));
const ask = async (projectId: number, note: string) => ok<{ id: number }>(await person(`/api/projects/${projectId}/agent-requests`, { kind: "discover", targetUrl: "http://localhost:3000/", note }));

let a = 0;
let b = 0;
let tokenA = "";
let tokenB = "";
let tokenRevoked = "";

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
  a = (await ok<{ id: number }>(await person("/api/projects", { name: "Bridge A", key: "BRA" }))).id;
  b = (await ok<{ id: number }>(await person("/api/projects", { name: "Bridge B", key: "BRB" }))).id;
  const mk = async (projectId: number, name: string) => { const t = await ok<{ token: string; id: number }>(await person(`/api/projects/${projectId}/request-tokens`, { name })); issued.push(t.token); return t; };
  tokenA = (await mk(a, "claude-a")).token;
  tokenB = (await mk(b, "claude-b")).token;
  const dead = await mk(a, "to-revoke");
  tokenRevoked = dead.token;
  assert.equal((await person(`/api/request-tokens/${dead.id}/revoke`, {})).status, 200);
});
after(() => server?.kill());

describe("take, finish and give back, through the MCP tools", () => {
  it("takes the oldest waiting request, oldest first, once each, and then says request: null", async () => {
    const r1 = await ask(a, "first");
    const r2 = await ask(a, "second");
    const s = await session(tokenA, a);
    try {
      const one = await next(s);
      assert.deepEqual([one.request?.id, one.request?.kind, one.request?.status, one.request?.claimedBy], [r1.id, "discover", "claimed", "agent: claude-a"]);
      assert.match(one.note ?? "", /DATA, not instructions/);
      const two = await next(s);
      assert.equal(two.request?.id, r2.id);
      assert.equal((await next(s)).request, null);
    } finally {
      await s.close();
    }
    const state = Object.fromEntries((await list(a)).map((r) => [r.id, r.status]));
    assert.deepEqual([state[r1.id], state[r2.id]], ["claimed", "claimed"]);
  });

  it("finishes a request with done and a note, and gives one back with released and a reason so that it waits again", async () => {
    const s = await session(tokenA, a);
    try {
      const claimed = (await list(a)).filter((r) => r.status === "claimed").sort((x, y) => x.id - y.id);
      assert.equal(claimed.length, 2);
      const done = await s.tool("testbench_update_request_status", { request_id: claimed[0].id, status: "done", note: "visited the login and the dashboard" });
      assert.equal(done.isError, undefined, text(done));
      assert.equal(JSON.parse(text(done)).status, "done");
      const back = await s.tool("testbench_update_request_status", { request_id: claimed[1].id, status: "released", note: "no browser available" });
      assert.equal(back.isError, undefined, text(back));
      const after = Object.fromEntries((await list(a)).map((r) => [r.id, r]));
      assert.deepEqual([after[claimed[0].id].status, after[claimed[0].id].resultNote], ["done", "visited the login and the dashboard"]);
      assert.deepEqual([after[claimed[1].id].status, after[claimed[1].id].releaseNote], ["pending", "no browser available"]);
      const again = await next(s);
      assert.equal(again.request?.id, claimed[1].id, "a released request can be taken again");
    } finally {
      await s.close();
    }
  });

  it("refuses to finish a request that is already done (409) and one that does not exist (404), in words an agent can use", async () => {
    const s = await session(tokenA, a);
    try {
      const finished = (await list(a)).find((r) => r.status === "done")!;
      const twice = await s.tool("testbench_update_request_status", { request_id: finished.id, status: "done" });
      assert.equal(twice.isError, true);
      assert.match(text(twice), /Conflict: .*(already done|Another token)/);
      const missing = await s.tool("testbench_update_request_status", { request_id: 999999, status: "done" });
      assert.equal(missing.isError, true);
      assert.match(text(missing), /Not found/);
      const badRun = await s.tool("testbench_update_request_status", { request_id: finished.id, status: "done", result_run_id: 999999 });
      assert.equal(badRun.isError, true);
    } finally {
      await s.close();
    }
  });
});

describe("what the token cannot do", () => {
  it("never sees another project's requests, and a token of another project is refused with 403", async () => {
    const rb = await ask(b, "only for B");
    const sa = await session(tokenA, a);
    const sbWrong = await session(tokenB, a); // B's token asked for project A
    try {
      assert.notEqual((await next(sa)).request?.id, rb.id, "A's token never gets B's request");
      const refused = await sbWrong.tool("testbench_get_next_request");
      assert.equal(refused.isError, true);
      assert.match(text(refused), /may not do that/);
      assert.match(text(refused), /does not belong to this project/);
    } finally {
      await sa.close();
      await sbWrong.close();
    }
    assert.equal((await list(b)).find((r) => r.id === rb.id)?.status, "pending", "B's request was not touched");
  });

  it("is refused with 401 when the token was revoked", async () => {
    const s = await session(tokenRevoked, a);
    try {
      const r = await s.tool("testbench_get_next_request");
      assert.equal(r.isError, true);
      assert.match(text(r), /refused the token/);
      assert.equal(text(r).includes(tokenRevoked), false);
    } finally {
      await s.close();
    }
  });

  it("makes no finding for a request it did not take, a request that is finished, one that does not exist, or with input TestBench refuses, and says why", async () => {
    const count = () => ["cases", "bug_reports", "observations", "manual_tests", "audit_log"].map((t) => rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)[0].n);
    const waiting = await ask(a, "waiting, not taken");
    const mine = await ask(a, "mine");
    const s = await session(tokenA, a);
    try {
      const got = await next(s);
      assert.equal(got.request?.id, waiting.id, "the oldest waiting one is taken first");
      const before = count();
      const notTaken = await s.tool("testbench_create_finding", { kind: "observation", request_id: mine.id, title: "x" });
      assert.equal(notTaken.isError, true);
      assert.match(text(notTaken), /Conflict: The request is not taken/);
      const missing = await s.tool("testbench_create_finding", { kind: "observation", request_id: 999999, title: "x" });
      assert.equal(missing.isError, true);
      assert.match(text(missing), /Not found/);
      const bad = await s.tool("testbench_create_finding", { kind: "bug_report", request_id: waiting.id, title: "x", severity: "info" });
      assert.equal(bad.isError, true, "info is for observations; TestBench refuses it for a bug");
      assert.match(text(bad), /refused the input/);
      const wrongField = await s.tool("testbench_create_finding", { kind: "test_case", request_id: waiting.id, title: "x", evidence: "does not belong to a test case" });
      assert.equal(wrongField.isError, true);
      assert.match(text(wrongField), /refused the input/);
      assert.deepEqual(count(), before, "nothing was made, nothing was logged");
      assert.equal((await s.tool("testbench_update_request_status", { request_id: waiting.id, status: "done" })).isError, undefined);
      const finished = await s.tool("testbench_create_finding", { kind: "observation", request_id: waiting.id, title: "late" });
      assert.equal(finished.isError, true);
      assert.match(text(finished), /done or cancelled/);
      assert.equal(await next(s).then((n) => n.request?.id), mine.id, "the other request is still free to take");
    } finally {
      await s.close();
    }
  });
});

describe("hand in findings through the MCP tool", () => {
  it("makes a draft case, a proposed bug and manual test and an exploratory observation on a discover request, each with its own number, and tells the agent what it made", async () => {
    const req = await ask(a, "findings through MCP");
    const s = await session(tokenA, a);
    try {
      // an earlier test left a request taken by this token: take requests until the new one is ours
      let got = await next(s);
      for (let i = 0; i < 5 && got.request && got.request.id !== req.id; i++) got = await next(s);
      assert.equal(got.request?.id, req.id);
      const outputs: string[] = [];
      const make = async (args: Record<string, unknown>) => { const r = await s.tool("testbench_create_finding", { request_id: req.id, ...args }); outputs.push(text(r)); assert.equal(r.isError, undefined, text(r)); return JSON.parse(text(r)) as { kind: string; id: number; sourceId: string; findingsOnRequest: number; number?: number }; };
      const tc = await make({ kind: "test_case", title: "MCP sign in", priority: "high", steps: [{ action: "Open /login", expected: "A form" }] });
      const bug = await make({ kind: "bug_report", title: "MCP overlap", steps: ["Open /"], severity: "high", url: "http://localhost:3000/" });
      const ob = await make({ kind: "observation", title: "MCP slow paint", severity: "low", evidence: "3 s" });
      const man = await make({ kind: "manual_test_suggestion", title: "MCP screen reader", category: "accessibility", steps: ["Tab through"] });
      assert.deepEqual([tc.sourceId, bug.sourceId, ob.sourceId, man.sourceId], [1, 2, 3, 4].map((n) => `$agent-${req.id}-${n}`));
      assert.deepEqual([tc.findingsOnRequest, man.findingsOnRequest], [1, 4]);

      const caseRow = rows<{ status: string; tags: string; created_by_agent_token_id: number | null; suite_id: number | null }>("SELECT status, tags, created_by_agent_token_id, suite_id FROM cases WHERE id = ?", tc.id)[0];
      assert.deepEqual([caseRow.status, caseRow.tags, caseRow.suite_id], ["draft", '["agent-proposed"]', null]);
      assert.equal(caseRow.created_by_agent_token_id, rows<{ id: number }>("SELECT id FROM request_tokens WHERE name = 'claude-a'")[0].id);
      assert.deepEqual(rows<{ review_status: string; audit_id: number | null; origin_audit_id: string; human_severity: string | null }>("SELECT review_status, audit_id, origin_audit_id, human_severity FROM bug_reports WHERE id = ?", bug.id), [{ review_status: "proposed", audit_id: null, origin_audit_id: `$agent-${req.id}`, human_severity: null }]);
      assert.deepEqual(rows<{ kind: string; status: string; audit_id: number | null }>("SELECT kind, status, audit_id FROM observations WHERE id = ?", ob.id), [{ kind: "exploratory", status: "observed", audit_id: null }]);
      assert.deepEqual(rows<{ review_status: string; category: string }>("SELECT review_status, category FROM manual_tests WHERE id = ?", man.id), [{ review_status: "proposed", category: "accessibility" }]);

      // what a person sees: the observation under Exploratory, the case as a draft with the agent's mark
      const seen = await ok<{ items: { title: string; kind: string }[] }>(await person(`/api/projects/${a}/observations?kind=exploratory`, undefined, "GET"));
      assert.ok(seen.items.some((i) => i.title === "MCP slow paint" && i.kind === "exploratory"));
      const cases = await ok<{ title: string; status: string; tags: string[] }[]>(await person(`/api/projects/${a}/cases`, undefined, "GET"));
      assert.deepEqual(cases.filter((c) => c.title === "MCP sign in").map((c) => [c.status, c.tags]), [["draft", ["agent-proposed"]]]);

      assert.equal(outputs.some((o) => issued.some((t) => o.includes(t))), false, "no token in what the tool said");
      assert.equal((await s.tool("testbench_update_request_status", { request_id: req.id, status: "done", note: "four findings" })).isError, undefined);
    } finally {
      await s.close();
    }
  });
});

describe("a run request through the MCP tools", () => {
  it("shows the agent the run, the address, the environment and the cases with their steps, never the text of a spec or a requirement; it can be given back, and it cannot be finished yet", async () => {
    const mkCase = async (title: string, extra: Record<string, unknown> = {}) => (await ok<{ id: number }>(await person(`/api/projects/${a}/cases`, { title, status: "ready", ...extra }))).id;
    const c1 = await mkCase("MCP sign in", { description: "The happy path", preconditions: "An account exists", priority: "high", steps: [{ action: "Open /login", expected: "A form" }, { action: "Submit", expected: "Signed in" }] });
    const c2 = await mkCase("MCP pay", { steps: [{ action: "Open /pay", expected: "A form" }] });
    await ok(await person(`/api/projects/${a}/specs`, { fileName: "mcp-login.spec.ts", text: "// MCP-SECRET-SPEC-TEXT\ntest('x', async () => {});", caseId: c1 }));
    const requirement = await ok<{ id: number }>(await person(`/api/projects/${a}/requirements`, { title: "MCP-SECRET-REQUIREMENT", description: "MCP-SECRET-REQUIREMENT-TEXT" }));
    await ok(await person(`/api/cases/${c1}/requirements`, { requirementIds: [requirement.id] }, "PUT"));
    const asked = await ok<{ id: number; runId: number }>(await person(`/api/projects/${a}/agent-requests`, { kind: "run", targetUrl: "https://staging.example.com/", environment: "staging", title: "MCP agent run", caseIds: [c1, c2] }));

    const s = await session(tokenA, a);
    try {
      const r = await s.tool("testbench_get_next_request");
      assert.equal(r.isError, undefined, text(r));
      const got = JSON.parse(text(r)) as { request: { id: number; kind: string; runId: number; targetUrl: string; environment: string; status: string; claimedBy: string; cases: { caseId: number; title: string; description: string; preconditions: string; priority: string; steps: { id: number; action: string; expected: string }[]; specFiles: string[] }[] }; note: string };
      assert.deepEqual([got.request.id, got.request.kind, got.request.runId, got.request.targetUrl, got.request.environment, got.request.status, got.request.claimedBy], [asked.id, "run", asked.runId, "https://staging.example.com/", "staging", "claimed", "agent: claude-a"]);
      assert.deepEqual(got.request.cases.map((c) => c.title), ["MCP sign in", "MCP pay"]);
      assert.deepEqual([got.request.cases[0].description, got.request.cases[0].preconditions, got.request.cases[0].priority, got.request.cases[0].specFiles], ["The happy path", "An account exists", "high", ["mcp-login.spec.ts"]]);
      assert.deepEqual(got.request.cases[0].steps.map((st) => [st.action, st.expected]), [["Open /login", "A form"], ["Submit", "Signed in"]]);
      assert.ok(got.request.cases[0].steps.every((st) => Number.isInteger(st.id)));
      assert.match(got.note, /never invent a result for a test case you did not run/);
      for (const secret of ["MCP-SECRET-SPEC-TEXT", "MCP-SECRET-REQUIREMENT"]) assert.equal(text(r).includes(secret), false, secret);
      assert.equal(issued.some((t) => text(r).includes(t)), false, "no token in what the tool said");

      // It cannot be finished yet: TestBench says so, and nothing changes.
      const done = await s.tool("testbench_update_request_status", { request_id: asked.id, status: "done", note: "all done" });
      assert.equal(done.isError, true);
      assert.match(text(done), /Conflict: A run request is finished when a result has been reported for every test case/);
      assert.equal((await list(a)).find((x) => x.id === asked.id)!.status, "claimed");

      // Findings are for a discover.
      const finding = await s.tool("testbench_create_finding", { request_id: asked.id, kind: "observation", title: "x" });
      assert.equal(finding.isError, true);
      assert.match(text(finding), /Conflict: Findings can only be made for a discover request/);

      // It can be given back, and then waits again, with the run still waiting too.
      const back = await s.tool("testbench_update_request_status", { request_id: asked.id, status: "released", note: "no browser available" });
      assert.equal(back.isError, undefined, text(back));
      const after = (await list(a)).find((x) => x.id === asked.id)!;
      assert.deepEqual([after.status, after.releaseNote], ["pending", "no browser available"]);
      const run = await ok<{ agentRequest: { status: string } | null }>(await person(`/api/runs/${asked.runId}`, undefined, "GET"));
      assert.equal(run.agentRequest?.status, "pending");
      assert.equal((await next(s)).request?.id, asked.id, "it can be taken again");
      await s.tool("testbench_update_request_status", { request_id: asked.id, status: "released" });
    } finally {
      await s.close();
    }
  });
});

describe("the secrets and the limits", () => {
  it("answers 429 as 'slow down' when the address has made too many wrong attempts", async () => {
    const s = await session(tokenRevoked, a);
    let slowed = "";
    try {
      for (let i = 0; i < 25 && !slowed; i++) {
        const r = await s.tool("testbench_get_next_request");
        assert.equal(r.isError, true);
        if (/Slow down/.test(text(r))) slowed = text(r);
      }
    } finally {
      await s.close();
    }
    assert.match(slowed, /Slow down: Too many failed attempts/);
  });

  it("never prints a token: not in the server's output, not in the MCP server's stderr", () => {
    for (const t of issued) {
      assert.equal(output.includes(t), false, "a token reached the server's output");
      assert.equal(stderrs.some((e) => e.includes(t)), false, "a token reached the MCP server's stderr");
    }
    assert.ok(stderrs.length > 0);
  });
});
