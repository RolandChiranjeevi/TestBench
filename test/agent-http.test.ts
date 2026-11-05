import "./env.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// The real server, started as a separate process with a password set. The agent route is read-only and authenticated by its own kind of token
// (tbag_), with no login cookie and no X-Testbench header; everything else keeps asking for the login.

const ROOT = join(import.meta.dirname, "..");
const PORT = 43000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "a long test passphrase";
const JSON_H = { "Content-Type": "application/json" };
let server: ChildProcess;
let output = "";
let cookie = "";

const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(`${BASE}${path}`, init);
const admin = (path: string, body?: unknown, method = "POST") =>
  call(path, { method, headers: { ...JSON_H, "X-Testbench": "1", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const agent = (projectId: number, token: string | undefined, query = "") =>
  call(`/api/agent/projects/${projectId}/requirements${query}`, { headers: token === undefined ? {} : { Authorization: token } });
const ok = async <T>(res: Response) => { const raw = await res.text(); assert.ok(res.ok, raw); return JSON.parse(raw) as T; };

let a = 0; // project A
let b = 0; // project B
let tokenA = "";
let tokenB = "";
let ciTokenA = "";
const issued: string[] = []; // every token this file made: none may reach the server's output

before(async () => {
  server = spawn(process.execPath, ["--import", "tsx", join(ROOT, "server", "index.ts")], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TESTBENCH_DATA: mkdtempSync(join(tmpdir(), "tb-agent-http-")), TESTBENCH_PORT: String(PORT), TESTBENCH_PASSWORD: PASSWORD, NODE_ENV: "production", TESTBENCH_AUTO_BACKUP: "1" },
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

  a = (await ok<{ id: number }>(await admin("/api/projects", { name: "Agent A", key: "AGA" }))).id;
  b = (await ok<{ id: number }>(await admin("/api/projects", { name: "Agent B", key: "AGB" }))).id;
  const req = (projectId: number, body: Record<string, unknown>) => admin(`/api/projects/${projectId}/requirements`, body).then(ok);
  await req(a, { title: "A one", description: "Users can sign in.\n\nAcceptance criteria:\n- With a password\n- With a link", source: "JIRA-1", externalId: "AUTH-1", kind: "functional" });
  await req(a, { title: "A two", description: "No criteria written yet", kind: "accessibility" });
  await req(a, { title: "A draft", status: "draft" });
  await req(a, { title: "A retired", status: "deprecated" });
  await req(b, { title: "B only", description: "Acceptance criteria: B secret detail" });
  const mk = async (projectId: number, name: string, kind: "agent" | "ci") => {
    const t = (await ok<{ token: string }>(await admin(`/api/projects/${projectId}/${kind === "agent" ? "agent" : "ci"}/tokens`, { name }))).token;
    issued.push(t);
    return t;
  };
  tokenA = await mk(a, "qa-agent", "agent");
  tokenB = await mk(b, "qa-agent", "agent");
  ciTokenA = await mk(a, "ci", "ci");
});
after(() => server?.kill());

describe("GET /api/agent/projects/:id/requirements with an agent token", () => {
  it("answers 200 for a valid token of that project, with no login cookie and no X-Testbench header", async () => {
    const res = await agent(a, `Bearer ${tokenA}`);
    const body = await ok<{ format: string; project: string; filter: { status: string }; note: string; requirements: Record<string, unknown>[] }>(res);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual([body.format, body.project, body.filter.status], ["testbench-agent-requirements", "AGA", "active"]);
    assert.deepEqual(body.requirements, [
      { requirement_id: "AUTH-1", title: "A one", source: "JIRA-1", readiness: "ready", acceptance_criteria: ["With a password", "With a link"] },
      { requirement_id: "REQ-2", title: "A two", source: "", readiness: "needs-clarification", acceptance_criteria: [] },
    ]);
    assert.ok(body.requirements.every((r) => Object.keys(r).length === 5), "exactly the five fields");
    assert.match(body.note, /measurable/);
  });

  it("returns only the active requirements of the token's project", async () => {
    const text = await (await agent(a, `Bearer ${tokenA}`)).text();
    assert.equal(/A draft|A retired|B only|B secret/.test(text), false);
    const other = await ok<{ requirements: { title: string }[] }>(await agent(b, `Bearer ${tokenB}`));
    assert.deepEqual(other.requirements.map((r) => r.title), ["B only"]);
  });

  it("refuses a missing, malformed, unknown, revoked or CI token with the same 401", async () => {
    const dead = (await ok<{ token: string; id: number }>(await admin(`/api/projects/${a}/agent/tokens`, { name: "to revoke" })));
    issued.push(dead.token);
    assert.equal((await agent(a, `Bearer ${dead.token}`)).status, 200);
    assert.equal((await admin(`/api/agent-tokens/${dead.id}/revoke`, {})).status, 200);
    const bodies = new Set<string>();
    for (const header of [undefined, "Bearer", "Basic abc", `Bearer ${tokenA}x`, "Bearer tbag_" + "z".repeat(43), `Bearer ${dead.token}`, `Bearer ${ciTokenA}`, `Token ${tokenA}`]) {
      const res = await agent(a, header);
      assert.equal(res.status, 401, String(header));
      bodies.add(await res.text());
    }
    assert.equal(bodies.size, 1, "one neutral answer for every kind of refusal");
    assert.equal([...bodies][0].includes("tbag") || [...bodies][0].includes("revoked"), false);
  });

  it("answers 403 for a valid token of another project, and leaks nothing about that project", async () => {
    const res = await agent(a, `Bearer ${tokenB}`);
    assert.equal(res.status, 403);
    const text = await res.text();
    assert.equal(/AUTH-1|A one|B only|AGA|AGB/.test(text), false, text);
    assert.equal((await agent(b, `Bearer ${tokenA}`)).status, 403);
  });

  it("refuses status=all with 400 and takes only status=active and a real kind", async () => {
    const auth = `Bearer ${tokenA}`;
    assert.equal((await agent(a, auth, "?status=all")).status, 400);
    assert.equal((await agent(a, auth, "?status=draft")).status, 400);
    assert.equal((await agent(a, auth, "?download=1")).status, 400);
    assert.equal((await agent(a, auth, "?kind=nonsense")).status, 400);
    assert.equal((await agent(a, auth, "?status=active")).status, 200);
    const kinds = await ok<{ requirements: { title: string }[] }>(await agent(a, auth, "?kind=accessibility"));
    assert.deepEqual(kinds.requirements.map((r) => r.title), ["A two"]);
    assert.equal((await agent(a, "Bearer nope", "?status=all")).status, 401, "a bad token is refused before the query is looked at");
  });
});

describe("what an agent token does not open", () => {
  const auth = () => ({ Authorization: `Bearer ${tokenA}` });
  const tries: [string, string][] = [
    ["GET", "/api/projects"], ["GET", "/api/projects/A/cases"], ["GET", "/api/projects/A/bug-reports"], ["GET", "/api/projects/A/requirements"],
    ["GET", "/api/projects/A/agent/requirements"], ["GET", "/api/projects/A/agent/requirements?status=all"], ["GET", "/api/projects/A/agent/tokens"], ["GET", "/api/projects/A/ci/tokens"],
    ["POST", "/api/projects/A/agent/tokens"], ["POST", "/api/agent-tokens/1/revoke"], ["POST", "/api/projects/A/requirements"], ["POST", "/api/projects/A/requirements/import"],
    ["POST", "/api/projects"], ["PATCH", "/api/projects/A"], ["DELETE", "/api/projects/A"], ["POST", "/api/projects/A/cases"],
    ["POST", "/api/agent/projects/A/requirements"], ["PUT", "/api/agent/projects/A/requirements"], ["DELETE", "/api/agent/projects/A/requirements"],
  ];

  it("is refused everywhere else, with and without the browser header", async () => {
    for (const withHeader of [false, true]) {
      for (const [method, path] of tries) {
        const res = await call(path.replace("/A", `/${a}`), {
          method, headers: { ...JSON_H, ...auth(), ...(withHeader ? { "X-Testbench": "1" } : {}) }, body: method === "GET" ? undefined : JSON.stringify({ name: "x", title: "x", key: "ZZ" }),
        });
        assert.ok(res.status === 401 || res.status === 403, `${method} ${path} (header ${withHeader}) answered ${res.status}`);
        assert.notEqual(res.status, 200);
      }
    }
  });

  it("makes no change: nothing was created, and the requirements are as they were", async () => {
    const list = await ok<{ title: string }[]>(await admin(`/api/projects/${a}/requirements`, undefined, "GET"));
    assert.equal(list.length, 4);
    assert.equal((await ok<unknown[]>(await admin("/api/projects", undefined, "GET"))).length, 2);
  });

  it("a CI token does not open the agent route, and an agent token does not open the CI route", async () => {
    assert.equal((await agent(a, `Bearer ${ciTokenA}`)).status, 401);
    const ci = await call(`/api/projects/${a}/ci/test-results`, {
      method: "POST", headers: { ...JSON_H, Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ runId: "agent-token-run", results: [{ testKey: "k", title: "k", status: "failed", error: "x" }] }),
    });
    assert.equal(ci.status, 401);
    assert.equal((await call(`/api/projects/${a}/ci/test-results`, { method: "POST", headers: { ...JSON_H, Authorization: `Bearer ${ciTokenA}` }, body: JSON.stringify({ runId: "ci-token-run", results: [] }) })).status, 200);
  });

  it("a login cookie does not open the agent route either", async () => {
    assert.equal((await call(`/api/agent/projects/${a}/requirements`, { headers: { Cookie: cookie } })).status, 401);
  });
});

describe("the login-protected export is unchanged", () => {
  it("still gives the full export to a signed-in user, with coverage, links and the status filter", async () => {
    const full = await ok<{ format: string; requirements: { id: string; coverage: object; links: object; description: string }[] }>(
      await call(`/api/projects/${a}/agent/requirements`, { headers: { Cookie: cookie } }));
    assert.equal(full.format, "testbench-requirements");
    assert.deepEqual(full.requirements.map((r) => r.id), ["AUTH-1", "REQ-2"], "active only, as before");
    assert.ok(full.requirements.every((r) => r.coverage && r.links && typeof r.description === "string"));
    const all = await ok<{ requirements: unknown[] }>(await call(`/api/projects/${a}/agent/requirements?status=all`, { headers: { Cookie: cookie } }));
    assert.equal(all.requirements.length, 4);
    assert.equal((await call(`/api/projects/${a}/agent/requirements`)).status, 401, "still needs the login");
  });
});

describe("making and revoking agent tokens", () => {
  it("needs the login and the browser header", async () => {
    assert.equal((await call(`/api/projects/${a}/agent/tokens`)).status, 401);
    assert.equal((await call(`/api/projects/${a}/agent/tokens`, { method: "POST", headers: { ...JSON_H, "X-Testbench": "1" }, body: JSON.stringify({ name: "x" }) })).status, 401);
    assert.equal((await call(`/api/projects/${a}/agent/tokens`, { method: "POST", headers: { ...JSON_H, Cookie: cookie }, body: JSON.stringify({ name: "x" }) })).status, 403);
    assert.equal((await call("/api/agent-tokens/1/revoke", { method: "POST", headers: { ...JSON_H, "X-Testbench": "1" }, body: "{}" })).status, 401);
  });

  it("shows the token once, and the list holds only the prefix and dates", async () => {
    const made = await ok<{ id: number; token: string; prefix: string }>(await admin(`/api/projects/${b}/agent/tokens`, { name: "shown once" }));
    issued.push(made.token);
    assert.match(made.token, /^tbag_/);
    const list = await admin(`/api/projects/${b}/agent/tokens`, undefined, "GET");
    const text = await list.text();
    assert.equal(text.includes(made.token), false);
    assert.equal(text.includes(made.token.slice(9)), false);
    assert.ok((JSON.parse(text) as { prefix: string }[]).some((t) => t.prefix === made.prefix));
  });

  it("stops at five active tokens per project and lets a revoked one go", async () => {
    const created: { id: number; token: string }[] = [];
    let refused = 0;
    for (let i = 0; i < 6; i++) {
      const res = await admin(`/api/projects/${b}/agent/tokens`, { name: `fill ${i}` });
      if (res.status === 409) refused++;
      else { const t = await ok<{ id: number; token: string }>(res); issued.push(t.token); created.push(t); }
    }
    assert.ok(refused >= 1, "the limit was reached");
    assert.equal((await admin(`/api/agent-tokens/${created[0].id}/revoke`, {})).status, 200);
    assert.equal((await admin(`/api/projects/${b}/agent/tokens`, { name: "fits again" })).status, 200);
    assert.equal((await admin("/api/agent-tokens/999999/revoke", {})).status, 404);
  });
});

describe("the server's output", () => {
  it("never holds a token", () => {
    assert.ok(issued.length >= 6);
    for (const t of issued) assert.equal(output.includes(t), false, `a token (${t.slice(0, 9)}…) is in the output`);
    assert.equal(/Bearer tbag_|Bearer tbci_/.test(output), false);
  });
});

// Last on purpose: it fills the failure counter of this address, so every request after it from here is refused.
describe("the agent route has its own limiter", () => {
  it("answers 429 after repeated wrong tokens, even for a valid token, and does not touch the CI limiter", async () => {
    let blockedAt = 0;
    for (let i = 1; i <= 40 && !blockedAt; i++) if ((await agent(a, `Bearer tbag_${"w".repeat(43)}`)).status === 429) blockedAt = i;
    assert.ok(blockedAt > 0 && blockedAt <= 25, `blocked after ${blockedAt} wrong tries`);
    assert.equal((await agent(a, `Bearer ${tokenA}`)).status, 429);
    const ci = await call(`/api/projects/${a}/ci/test-results`, { method: "POST", headers: { ...JSON_H, Authorization: `Bearer ${ciTokenA}` }, body: JSON.stringify({ runId: "after-agent-429", results: [] }) });
    assert.equal(ci.status, 200, "the CI route is not blocked by the agent limiter");
  });
});
