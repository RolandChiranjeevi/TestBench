import "./env.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";

// The real server, started as a separate process with a password set. Plan step 3b: the request token that took a DISCOVER request hands in at most two screenshots for each
// bug report that request made, one `before` and one `bug`. Nothing else: no picture on another request's bug, on a bug that was seen again, or after the request is done.

const ROOT = join(import.meta.dirname, "..");
const PORT = 55000 + Math.floor(Math.random() * 1000); // its own range: the other server tests use 41000 to 54999
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "a long test passphrase";
const JSON_H = { "Content-Type": "application/json" };
const DATA = mkdtempSync(join(tmpdir(), "tb-agent-screenshots-"));
const UPLOADS = join(DATA, "uploads");
let server: ChildProcess;
let output = "";
let cookie = "";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const call = (path: string, init: RequestInit = {}) => fetch(`${BASE}${path}`, init);
const person = (path: string, body?: unknown, method = "POST") =>
  call(path, { method, headers: { ...JSON_H, "X-Testbench": "1", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const agent = (token: string, path: string, method = "GET", body?: unknown) =>
  call(path, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : JSON_H) }, body: body === undefined ? undefined : JSON.stringify(body) });
const ok = async <T>(res: Response) => { const raw = await res.text(); assert.ok(res.ok, raw); return JSON.parse(raw) as T; };
const rows = <T>(sql: string, ...args: unknown[]) => { const d = new Database(join(DATA, "testbench.db"), { readonly: true }); try { return d.prepare(sql).all(...args) as T[]; } finally { d.close(); } };

const shot = (token: string, projectId: number, rid: number, bugId: number, label: string, bytes: Buffer = PNG) => {
  const form = new FormData();
  form.set("label", label);
  form.set("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "shot.png");
  return call(`/api/agent/projects/${projectId}/requests/${rid}/bugs/${bugId}/screenshots`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
};
const ask = async (projectId: number) => ok<{ id: number }>(await person(`/api/projects/${projectId}/agent-requests`, { kind: "discover", targetUrl: "http://localhost:3000/", note: "look around" }));
const taken = async (projectId: number, token: string) => { const r = await ask(projectId); await ok(await agent(token, `/api/agent/projects/${projectId}/requests/${r.id}/claim`, "POST")); return r.id; };
const bug = (n: number, key?: string) => ({ kind: "bug_report", title: `Cart: total is wrong when item ${n} is removed`, actual: `total ${n}`, url: "http://localhost:3000/cart", ...(key ? { key } : {}) });
const makeBug = async (token: string, projectId: number, rid: number, body = bug(1)) =>
  ok<{ id: number; seenAgain?: boolean }>(await agent(token, `/api/agent/projects/${projectId}/requests/${rid}/findings`, "POST", body));
const files = () => (existsSync(UPLOADS) ? readdirSync(UPLOADS).filter((f) => f.startsWith("agent-")) : []);

let a = 0;
let b = 0;
let tokenA = "";
let tokenA2 = "";
let tokenB = "";
const mk = async (projectId: number, name: string) => (await ok<{ token: string }>(await person(`/api/projects/${projectId}/request-tokens`, { name }))).token;

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
  a = (await ok<{ id: number }>(await person("/api/projects", { name: "Shots A", key: "SHA" }))).id;
  b = (await ok<{ id: number }>(await person("/api/projects", { name: "Shots B", key: "SHB" }))).id;
  tokenA = await mk(a, "claude-a");
  tokenA2 = await mk(a, "second-agent");
  tokenB = await mk(b, "claude-b");
});
after(() => server?.kill());
beforeEach(async () => {
  for (const projectId of [a, b]) for (const r of await ok<{ id: number; status: string }[]>(await person(`/api/projects/${projectId}/agent-requests`, undefined, "GET"))) if (r.status === "pending" || r.status === "claimed") await person(`/api/agent-requests/${r.id}/cancel`, {});
});

describe("screenshots of a bug from a discover", () => {
  it("takes one `before` and one `bug` for a bug this request made, stores them as attachments with their labels, and refuses a third", async () => {
    const rid = await taken(a, tokenA);
    const made = await makeBug(tokenA, a, rid);
    const first = await shot(tokenA, a, rid, made.id, "before");
    assert.equal(first.status, 201, await first.clone().text());
    assert.equal((await shot(tokenA, a, rid, made.id, "bug")).status, 201);
    const again = await shot(tokenA, a, rid, made.id, "bug");
    assert.equal(again.status, 409);
    const att = rows<{ label: string; mime: string; state: string; stored_name: string }>("SELECT label, mime, state, stored_name FROM bug_attachments WHERE bug_report_id = ? ORDER BY id", made.id);
    assert.deepEqual(att.map((x) => x.label), ["Screenshot before", "Screenshot when the bug shows"]);
    assert.ok(att.every((x) => x.mime === "image/png" && x.state === "stored" && existsSync(join(UPLOADS, x.stored_name))));
    assert.equal(rows("SELECT 1 FROM audit_log WHERE action = 'agent_request.screenshot_added'").length >= 2, true);
  });

  it("refuses a file that is not a picture, a label that is not before or bug, and keeps no file of a refused call", async () => {
    const rid = await taken(a, tokenA);
    const made = await makeBug(tokenA, a, rid);
    const before = files().length;
    assert.equal((await shot(tokenA, a, rid, made.id, "before", Buffer.from("<html>not a picture</html>"))).status, 400);
    assert.equal((await shot(tokenA, a, rid, made.id, "after")).status, 400);
    assert.equal((await shot(tokenA, a, rid, made.id, "")).status, 400);
    assert.equal(rows("SELECT 1 FROM bug_attachments WHERE bug_report_id = ?", made.id).length, 0);
    assert.equal(files().length, before, "no file was left behind");
  });

  it("refuses a bug of another request, a bug that was seen again, another token and another project", async () => {
    const first = await taken(a, tokenA);
    const old = await makeBug(tokenA, a, first, bug(1, "cart:total-wrong"));
    await ok(await agent(tokenA, `/api/agent/projects/${a}/requests/${first}/complete`, "POST", {}));
    const second = await taken(a, tokenA);
    const seen = await makeBug(tokenA, a, second, bug(1, "cart:total-wrong"));
    assert.equal(seen.seenAgain, true);
    assert.equal(seen.id, old.id);
    assert.equal((await shot(tokenA, a, second, old.id, "before")).status, 404, "a bug seen again keeps the pictures it has");
    const own = await makeBug(tokenA, a, second, bug(2));
    assert.equal((await shot(tokenA2, a, second, own.id, "before")).status, 409, "another token did not take the request");
    assert.equal((await shot(tokenB, a, second, own.id, "before")).status, 403, "a valid token of another project");
    assert.equal(rows("SELECT 1 FROM bug_attachments WHERE bug_report_id IN (?, ?)", old.id, own.id).length, 0);
  });

  it("refuses once the request is done", async () => {
    const rid = await taken(a, tokenA);
    const made = await makeBug(tokenA, a, rid);
    await ok(await agent(tokenA, `/api/agent/projects/${a}/requests/${rid}/complete`, "POST", {}));
    assert.equal((await shot(tokenA, a, rid, made.id, "before")).status, 409);
  });
});
