import "./env.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// The real server, started as a separate process with a password set. A request token (tbrq_) opens three routes: the waiting requests, taking one and finishing it,
// with no login cookie and no X-Testbench header. It opens nothing else, no other kind of token opens these, and a person (with the login) is the only one who asks.

const ROOT = join(import.meta.dirname, "..");
const PORT = 45000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "a long test passphrase";
const JSON_H = { "Content-Type": "application/json" };
let server: ChildProcess;
let output = "";
let cookie = "";

const call = (path: string, init: RequestInit = {}) => fetch(`${BASE}${path}`, init);
/** A person: the login cookie and the X-Testbench header. */
const person = (path: string, body?: unknown, method = "POST") =>
  call(path, { method, headers: { ...JSON_H, "X-Testbench": "1", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
/** The agent: only the token. No cookie, no X-Testbench header. */
const agent = (token: string | undefined, path: string, method = "GET", body?: unknown) =>
  call(path, { method, headers: { ...(token === undefined ? {} : { Authorization: token }), ...(body === undefined ? {} : JSON_H) }, body: body === undefined ? undefined : JSON.stringify(body) });
const ok = async <T>(res: Response) => { const raw = await res.text(); assert.ok(res.ok, raw); return JSON.parse(raw) as T; };

const TOKEN_PATH = { request: "request-tokens", agent: "agent/tokens", ci: "ci/tokens" } as const;
let a = 0;
let b = 0;
let tokenA = "";
let tokenA2 = "";
let tokenB = "";
let readTokenA = "";
let ciTokenA = "";
const issued: string[] = [];

before(async () => {
  server = spawn(process.execPath, ["--import", "tsx", join(ROOT, "server", "index.ts")], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TESTBENCH_DATA: mkdtempSync(join(tmpdir(), "tb-agent-requests-")), TESTBENCH_PORT: String(PORT), TESTBENCH_PASSWORD: PASSWORD, NODE_ENV: "production", TESTBENCH_AUTO_BACKUP: "0" },
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
  a = (await ok<{ id: number }>(await person("/api/projects", { name: "Req A", key: "RQA" }))).id;
  b = (await ok<{ id: number }>(await person("/api/projects", { name: "Req B", key: "RQB" }))).id;
  const mk = async (projectId: number, kind: keyof typeof TOKEN_PATH, name: string) => {
    const t = (await ok<{ token: string }>(await person(`/api/projects/${projectId}/${TOKEN_PATH[kind]}`, { name }))).token;
    issued.push(t);
    return t;
  };
  tokenA = await mk(a, "request", "qa-agent");
  tokenA2 = await mk(a, "request", "second-agent");
  tokenB = await mk(b, "request", "qa-agent");
  readTokenA = await mk(a, "agent", "reader");
  ciTokenA = await mk(a, "ci", "ci");
});
after(() => server?.kill());

const ask = async (projectId: number, body: Record<string, unknown>) => ok<{ id: number; status: string }>(await person(`/api/projects/${projectId}/agent-requests`, body));
const waiting = async (token: string, projectId = a) => ok<{ id: number }[]>(await agent(`Bearer ${token}`, `/api/agent/projects/${projectId}/requests`));

describe("an agent works through a request with its token alone", () => {
  it("sees the waiting requests, takes one, and finishes it, with no login cookie and no X-Testbench header", async () => {
    const r = await ask(a, { kind: "discover", targetUrl: "https://staging.example.com", note: "the checkout is new" });
    const res = await agent(`Bearer ${tokenA}`, `/api/agent/projects/${a}/requests`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const list = (await res.json()) as { id: number; kind: string; targetUrl: string; note: string; status: string }[];
    assert.deepEqual(list.map((x) => [x.id, x.kind, x.targetUrl, x.note, x.status]), [[r.id, "discover", "https://staging.example.com/", "the checkout is new", "pending"]]);

    const taken = await agent(`Bearer ${tokenA}`, `/api/agent/projects/${a}/requests/${r.id}/claim`, "POST");
    assert.equal(taken.status, 200, await taken.clone().text());
    assert.equal((await taken.json() as { status: string }).status, "claimed");
    assert.deepEqual(await waiting(tokenA), [], "a taken request is no longer waiting");

    const done = await agent(`Bearer ${tokenA}`, `/api/agent/projects/${a}/requests/${r.id}/complete`, "POST", { note: "5 pages looked at" });
    const body = await ok<{ status: string; resultNote: string; claimedBy: string }>(done);
    assert.deepEqual([body.status, body.resultNote, body.claimedBy], ["done", "5 pages looked at", "agent: qa-agent"]);

    const mine = await ok<{ id: number; status: string }[]>(await person(`/api/projects/${a}/agent-requests`, undefined, "GET"));
    assert.equal(mine.find((x) => x.id === r.id)?.status, "done", "the person sees how it went");
  });

  it("two agents cannot take the same request, and only the one that took it can finish it", async () => {
    const r = await ask(a, { kind: "discover", targetUrl: "https://second.example.com" });
    assert.equal((await agent(`Bearer ${tokenA}`, `/api/agent/projects/${a}/requests/${r.id}/claim`, "POST")).status, 200);
    assert.equal((await agent(`Bearer ${tokenA2}`, `/api/agent/projects/${a}/requests/${r.id}/claim`, "POST")).status, 409);
    assert.equal((await agent(`Bearer ${tokenA2}`, `/api/agent/projects/${a}/requests/${r.id}/complete`, "POST", {})).status, 409);
    assert.equal((await agent(`Bearer ${tokenA}`, `/api/agent/projects/${a}/requests/${r.id}/complete`, "POST", {})).status, 200);
  });

  it("a request that a person withdrew is not waiting, and cannot be taken", async () => {
    const r = await ask(a, { kind: "discover", targetUrl: "https://withdrawn.example.com" });
    assert.equal((await person(`/api/agent-requests/${r.id}/cancel`, {})).status, 200);
    assert.equal((await waiting(tokenA)).some((x) => x.id === r.id), false);
    assert.equal((await agent(`Bearer ${tokenA}`, `/api/agent/projects/${a}/requests/${r.id}/claim`, "POST")).status, 409);
  });

  it("a request of another project is not shown, and is 404 when named", async () => {
    const r = await ask(b, { kind: "discover", targetUrl: "https://b-only.example.com" });
    assert.equal((await waiting(tokenA)).some((x) => x.id === r.id), false);
    assert.equal((await agent(`Bearer ${tokenA}`, `/api/agent/projects/${a}/requests/${r.id}/claim`, "POST")).status, 404);
    assert.deepEqual((await waiting(tokenB, b)).map((x) => x.id), [r.id]);
  });
});

describe("what a request token is, and is not", () => {
  it("is refused (401, the same for all) when missing, malformed, unknown, revoked, or another kind of token", async () => {
    const dead = await ok<{ token: string; id: number }>(await person(`/api/projects/${a}/request-tokens`, { name: "to revoke" }).then(async (res) => {
      if (res.status === 409) {
        // the project is at its three: revoke the second agent's token to make room, as a person would
        const all = await ok<{ id: number; name: string; revokedAt: string | null }[]>(await person(`/api/projects/${a}/request-tokens`, undefined, "GET"));
        await person(`/api/request-tokens/${all.find((t) => t.name === "second-agent" && !t.revokedAt)!.id}/revoke`, {});
        return person(`/api/projects/${a}/request-tokens`, { name: "to revoke" });
      }
      return res;
    }));
    issued.push(dead.token);
    assert.equal((await agent(`Bearer ${dead.token}`, `/api/agent/projects/${a}/requests`)).status, 200);
    assert.equal((await person(`/api/request-tokens/${dead.id}/revoke`, {})).status, 200);
    const bodies = new Set<string>();
    for (const header of [undefined, "Bearer", "Basic abc", `Bearer ${tokenA}x`, "Bearer tbrq_" + "z".repeat(43), `Bearer ${dead.token}`, `Bearer ${readTokenA}`, `Bearer ${ciTokenA}`, `Token ${tokenA}`]) {
      const res = await agent(header, `/api/agent/projects/${a}/requests`);
      assert.equal(res.status, 401, String(header));
      bodies.add(await res.text());
    }
    assert.equal(bodies.size, 1, "the answer does not say which of them it was");
  });

  it("is refused (403) for another project, on every one of its routes", async () => {
    const r = await ask(a, { kind: "discover", targetUrl: "https://mine.example.com" });
    assert.equal((await agent(`Bearer ${tokenB}`, `/api/agent/projects/${a}/requests`)).status, 403);
    assert.equal((await agent(`Bearer ${tokenB}`, `/api/agent/projects/${a}/requests/${r.id}/claim`, "POST")).status, 403);
    assert.equal((await agent(`Bearer ${tokenB}`, `/api/agent/projects/${a}/requests/${r.id}/complete`, "POST", {})).status, 403);
    assert.equal((await waiting(tokenA)).some((x) => x.id === r.id), true, "still waiting");
  });

  it("opens no other route: not the list a person sees, not asking, not withdrawing, not making tokens, not the projects, not the requirements", async () => {
    const r = await ask(a, { kind: "discover", targetUrl: "https://untouched.example.com" });
    // with the login cookie too, so that it is the guard for agent credentials that answers and not the login
    const as = (path: string, method = "GET", body?: unknown) =>
      call(path, { method, headers: { Authorization: `Bearer ${tokenA}`, Cookie: cookie, "X-Testbench": "1", ...(body === undefined ? {} : JSON_H) }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const [path, method, body] of [
      [`/api/projects/${a}/agent-requests`, "GET", undefined],
      [`/api/projects/${a}/agent-requests`, "POST", { kind: "discover", targetUrl: "https://made-by-agent.example.com" }],
      [`/api/agent-requests/${r.id}/cancel`, "POST", undefined],
      [`/api/projects/${a}/request-tokens`, "POST", { name: "more" }],
      ["/api/projects", "GET", undefined],
    ] as const) {
      const res = await as(path, method, body);
      assert.equal(res.status, 403, `${method} ${path}`);
    }
    // the read route is an agent route too, so the guard lets it through, and its own check says this is not a read token
    assert.equal((await as(`/api/agent/projects/${a}/requirements`)).status, 401);
    const mine = await ok<{ id: number; status: string; targetUrl: string }[]>(await person(`/api/projects/${a}/agent-requests`, undefined, "GET"));
    assert.equal(mine.find((x) => x.id === r.id)?.status, "pending", "it was not withdrawn");
    assert.equal(mine.some((x) => x.targetUrl.includes("made-by-agent")), false, "it did not ask for anything");
  });

  it("is not opened by the other kinds of token on its own routes, and does not open theirs", async () => {
    assert.equal((await agent(`Bearer ${readTokenA}`, `/api/agent/projects/${a}/requests`)).status, 401);
    assert.equal((await agent(`Bearer ${tokenA}`, `/api/agent/projects/${a}/requirements`)).status, 401);
  });

  it("a person has to be signed in to ask, to see the list, and to make or revoke a token", async () => {
    for (const [path, method] of [[`/api/projects/${a}/agent-requests`, "GET"], [`/api/projects/${a}/agent-requests`, "POST"], [`/api/projects/${a}/request-tokens`, "GET"], [`/api/projects/${a}/request-tokens`, "POST"]] as const) {
      const res = await call(path, { method, headers: { ...JSON_H, "X-Testbench": "1" }, body: method === "POST" ? "{}" : undefined });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  });

  it("a project can have only three active request tokens", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await person(`/api/projects/${a}/request-tokens`, { name: `extra ${i}` });
      if (res.status === 200) issued.push(((await res.json()) as { token: string }).token);
    }
    const over = await person(`/api/projects/${a}/request-tokens`, { name: "one too many" });
    assert.equal(over.status, 409, await over.text());
  });

  it("never reaches the server's output or its list of tokens", async () => {
    const list = await (await person(`/api/projects/${a}/request-tokens`, undefined, "GET")).text();
    for (const t of issued) {
      assert.equal(list.includes(t), false, "the list holds no token");
      assert.equal(output.includes(t), false, "the server did not print a token");
    }
  });
});

describe("guessing", () => {
  it("is slowed down: many wrong tokens from one address get 429", async () => {
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await agent(`Bearer tbrq_${"y".repeat(42)}${i}`, `/api/agent/projects/${a}/requests`)).status;
    assert.equal(last, 429);
  });
});
