import "./env.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// The real server, started as a separate process with a password set, so that the rules of the CI route are tested where they apply:
// the browser guards (login cookie, X-Testbench header) do not apply to it, an API token always does.

const ROOT = join(import.meta.dirname, "..");
const PORT = 41000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "a long test passphrase";
const JSON_H = { "Content-Type": "application/json" };
let server: ChildProcess;
let output = "";

const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(`${BASE}${path}`, init);
const payload = (over: Record<string, unknown> = {}) => ({
  runId: `http-${Math.random().toString(36).slice(2)}`, commitSha: "abc1234567", branch: "main", repository: "org/repo",
  results: [{ testKey: "e2e-http", title: "Over HTTP", status: "failed", error: "boom" }], ...over,
});

let cookie = "";
const admin = (path: string, body?: unknown, method = "POST") =>
  call(path, { method, headers: { ...JSON_H, "X-Testbench": "1", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

before(async () => {
  server = spawn(process.execPath, ["--import", "tsx", join(ROOT, "server", "index.ts")], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TESTBENCH_DATA: mkdtempSync(join(tmpdir(), "tb-ci-http-")), TESTBENCH_PORT: String(PORT), TESTBENCH_PASSWORD: PASSWORD, NODE_ENV: "production", TESTBENCH_AUTO_BACKUP: "1" },
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

describe("POST /api/projects/:id/ci/test-results over HTTP", () => {
  let projectId = 0;
  let otherId = 0;
  let token = "";
  let otherToken = "";

  it("is authenticated by an API token, with no login cookie and no X-Testbench header", async () => {
    projectId = ((await (await admin("/api/projects", { name: "HTTP project", key: "HTP" })).json()) as { id: number }).id;
    otherId = ((await (await admin("/api/projects", { name: "Other", key: "OTH" })).json()) as { id: number }).id;
    token = ((await (await admin(`/api/projects/${projectId}/ci/tokens`, { name: "gha" })).json()) as { token: string }).token;
    otherToken = ((await (await admin(`/api/projects/${otherId}/ci/tokens`, { name: "gha" })).json()) as { token: string }).token;
    const res = await call(`/api/projects/${projectId}/ci/test-results`, { method: "POST", headers: { ...JSON_H, Authorization: `Bearer ${token}` }, body: JSON.stringify(payload()) });
    const raw = await res.text();
    assert.equal(res.status, 200, raw);
    const body = JSON.parse(raw) as { bugsCreated: number; replayed: boolean };
    assert.deepEqual([body.bugsCreated, body.replayed], [1, false]);
    const bugs = (await (await admin(`/api/projects/${projectId}/bug-reports?source=ci`, undefined, "GET")).json()) as { items: { testKey: string; source: string }[] };
    assert.deepEqual(bugs.items.map((b) => [b.testKey, b.source]), [["e2e-http", "ci"]]);
  });

  it("refuses a request without a token, with a wrong token, and with only a valid login session", async () => {
    const url = `/api/projects/${projectId}/ci/test-results`;
    const body = JSON.stringify(payload());
    assert.equal((await call(url, { method: "POST", headers: JSON_H, body })).status, 401);
    assert.equal((await call(url, { method: "POST", headers: { ...JSON_H, Authorization: "Bearer tbci_nottherealtoken" }, body })).status, 401);
    assert.equal((await call(url, { method: "POST", headers: { ...JSON_H, Authorization: `Basic ${token}` }, body })).status, 401);
    assert.equal((await call(url, { method: "POST", headers: { ...JSON_H, "X-Testbench": "1", Cookie: cookie }, body })).status, 401, "a person's session is not a CI token");
  });

  it("a token works for its own project only", async () => {
    const res = await call(`/api/projects/${projectId}/ci/test-results`, { method: "POST", headers: { ...JSON_H, Authorization: `Bearer ${otherToken}` }, body: JSON.stringify(payload()) });
    assert.equal(res.status, 401);
    assert.doesNotMatch(await res.text(), new RegExp(otherToken.slice(6)), "the token is never echoed back");
  });

  it("does not open any other route: a token without the browser guards is refused elsewhere", async () => {
    const h = { ...JSON_H, Authorization: `Bearer ${token}` };
    // Writes are stopped by the X-Testbench guard (403), reads by the login (401); either way the token gets nothing.
    assert.equal((await call(`/api/projects/${projectId}/ci/tokens`, { method: "POST", headers: h, body: JSON.stringify({ name: "x" }) })).status, 403);
    assert.equal((await call(`/api/projects`, { method: "POST", headers: h, body: JSON.stringify({ name: "x", key: "XXX" }) })).status, 403);
    assert.equal((await call(`/api/projects/${projectId}/ci/tokens`, { method: "POST", headers: { ...h, "X-Testbench": "1" }, body: JSON.stringify({ name: "x" }) })).status, 401);
    assert.equal((await call(`/api/projects/${projectId}/bug-reports`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  });

  it("answers the same run sent twice with the same result, and refuses invalid and oversized payloads", async () => {
    const url = `/api/projects/${projectId}/ci/test-results`;
    const h = { ...JSON_H, Authorization: `Bearer ${token}` };
    const same = payload({ runId: "twice" });
    type Answer = { replayed: boolean; bugsCreated: number; bugs: { action: string }[] };
    const a = (await (await call(url, { method: "POST", headers: h, body: JSON.stringify(same) })).json()) as Answer;
    const b = (await (await call(url, { method: "POST", headers: h, body: JSON.stringify(same) })).json()) as Answer;
    assert.deepEqual([a.replayed, b.replayed], [false, true]);
    // The first call updated the bug the earlier test made (same testKey), so it creates none; the replay must never claim one either.
    assert.deepEqual([a.bugsCreated, b.bugsCreated, a.bugs[0].action, b.bugs[0].action], [0, 0, "updated", "already_processed"]);
    const bad = await call(url, { method: "POST", headers: h, body: JSON.stringify({ runId: "no-results" }) });
    assert.equal(bad.status, 400);
    const huge = await call(url, { method: "POST", headers: h, body: JSON.stringify(payload({ runId: "huge", results: [{ testKey: "k", title: "t", status: "failed", error: "x".repeat(6 * 1024 * 1024) }] })) });
    assert.equal(huge.status, 413);
  });

  it("a revoked token stops working at once", async () => {
    const list = (await (await admin(`/api/projects/${projectId}/ci/tokens`, undefined, "GET")).json()) as { id: number; revokedAt: string | null; prefix: string }[];
    assert.ok(list.length >= 1 && list.every((t) => !JSON.stringify(t).includes(token.slice(10))), "the list never contains the token");
    assert.equal((await admin(`/api/ci-tokens/${list[0].id}/revoke`, {})).status, 200);
    const res = await call(`/api/projects/${projectId}/ci/test-results`, { method: "POST", headers: { ...JSON_H, Authorization: `Bearer ${token}` }, body: JSON.stringify(payload()) });
    assert.equal(res.status, 401);
  });

  it("the token never appears in the server's output", () => {
    assert.equal(output.includes(token), false);
    assert.equal(output.includes(otherToken), false);
  });
});
