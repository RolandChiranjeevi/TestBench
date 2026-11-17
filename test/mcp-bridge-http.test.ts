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
const PORT = 47000 + Math.floor(Math.random() * 2000);
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

  it("creates no finding: testbench_create_finding says 'not supported yet' and nothing in TestBench changes", async () => {
    const count = () => ["cases", "bug_reports", "observations", "manual_tests", "agent_requests"].map((t) => rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)[0].n);
    const before = count();
    const s = await session(tokenA, a);
    try {
      for (const kind of ["test_case", "bug_report", "observation", "manual_test_suggestion"]) {
        const r = await s.tool("testbench_create_finding", { kind, request_id: 1, title: "A finding" });
        assert.equal(r.isError, true);
        assert.match(text(r), /Not supported yet/);
      }
    } finally {
      await s.close();
    }
    assert.deepEqual(count(), before);
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
