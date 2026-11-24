import "./env.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";

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

  it("the options of a discover reach the agent in the list and in the claim as the person chose them, and a wrong option is refused", async () => {
    const options = { targetMode: "observe_only", gitMode: "off", deliverables: ["cases", "bugs"], viewports: ["mobile"], checks: ["visual"], depth: "deep", production: true };
    const r = await ask(a, { kind: "discover", targetUrl: "https://options.example.com", options });
    const list = (await (await agent(`Bearer ${tokenA}`, `/api/agent/projects/${a}/requests`)).json()) as { id: number; options: unknown }[];
    assert.deepEqual(list.find((x) => x.id === r.id)?.options, options);
    const claimed = await ok<{ options: unknown }>(await agent(`Bearer ${tokenA}`, `/api/agent/projects/${a}/requests/${r.id}/claim`, "POST"));
    assert.deepEqual(claimed.options, options);
    const bad = await person(`/api/projects/${a}/agent-requests`, { kind: "discover", targetUrl: "https://bad.example.com", options: { targetMode: "write" } });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /targetMode must be one of/);
    assert.equal((await agent(`Bearer ${tokenA}`, `/api/agent/projects/${a}/requests/${r.id}/complete`, "POST", {})).status, 200, "tidy: the request is finished");
  });

  it("the name of a request reaches the agent in the list and in the claim as the person typed it, and a name that is too long or on two lines is refused", async () => {
    const r = await ask(a, { kind: "discover", targetUrl: "https://name.example.com", name: "  Login flow  " });
    const list = (await (await agent(`Bearer ${tokenA}`, `/api/agent/projects/${a}/requests`)).json()) as { id: number; name: string }[];
    assert.equal(list.find((x) => x.id === r.id)?.name, "Login flow");
    const claimed = await ok<{ name: string }>(await agent(`Bearer ${tokenA}`, `/api/agent/projects/${a}/requests/${r.id}/claim`, "POST"));
    assert.equal(claimed.name, "Login flow");
    const mine = await ok<{ id: number; name: string }[]>(await person(`/api/projects/${a}/agent-requests`, undefined, "GET"));
    assert.equal(mine.find((x) => x.id === r.id)?.name, "Login flow", "the person sees it in the list too");
    for (const [what, name, text] of [["too long", "x".repeat(61), /at most 60/], ["two lines", "a\nb", /one line/], ["not text", 7, /expected string|must be text/i]] as const) {
      const res = await person(`/api/projects/${a}/agent-requests`, { kind: "discover", targetUrl: "https://bad-name.example.com", name });
      assert.equal(res.status, 400, what);
      assert.match(await res.text(), text, what);
    }
    assert.equal((await agent(`Bearer ${tokenA}`, `/api/agent/projects/${a}/requests/${r.id}/complete`, "POST", {})).status, 200, "tidy: the request is finished");
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
      [`/api/agent-requests/${r.id}/run-next`, "POST", undefined],
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

  it("GET /login with it is refused (403) with a text that says the request is not allowed, and does not ask for a retry", async () => {
    const res = await agent(`Bearer ${tokenA}`, "/login");
    assert.equal(res.status, 403);
    const { error } = (await res.json()) as { error: string };
    assert.match(error, /not allowed/);
    assert.doesNotMatch(error, /try again|retry|later/i);
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

/** A real audit package (the one in examples/), made for this project, imported by a person with the login, as `deliver` does. Returns the id TestBench gave the audit. */
async function importAudit(projectId: number, projectKey: string) {
  const dir = join(ROOT, "examples", "audit-package");
  const files: Record<string, Uint8Array> = {};
  for (const rel of ["manifest.json", "bugs.json", "report.md", "manual-tests.json", "evidence/card-field.txt", "evidence/discount-total.png"]) files[rel] = new Uint8Array(readFileSync(join(dir, rel)));
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  manifest.audit.project = projectKey;
  manifest.audit.id = `link-${Math.random().toString(36).slice(2, 8)}`;
  files["manifest.json"] = strToU8(JSON.stringify(manifest));
  const form = new FormData();
  form.set("file", new Blob([Buffer.from(zipSync(files))], { type: "application/zip" }), "audit.zip");
  const res = await call(`/api/projects/${projectId}/audit-import`, { method: "POST", headers: { "X-Testbench": "1", Cookie: cookie }, body: form });
  return (await ok<{ auditId: number }>(res)).auditId;
}

describe("giving a request back, and linking the audit a discover made", () => {
  const release = (token: string, id: number, body?: unknown, projectId = a) => agent(`Bearer ${token}`, `/api/agent/projects/${projectId}/requests/${id}/release`, "POST", body ?? {});
  const claim = (token: string, id: number, projectId = a) => agent(`Bearer ${token}`, `/api/agent/projects/${projectId}/requests/${id}/claim`, "POST");
  const finish = (token: string, id: number, body: unknown) => agent(`Bearer ${token}`, `/api/agent/projects/${a}/requests/${id}/complete`, "POST", body);
  const mine = async (id: number) => (await ok<{ id: number; status: string; releaseNote: string; releasedBy: string | null; claimedBy: string | null; resultAuditId: number | null; resultAudit: { title: string } | null }[]>(await person(`/api/projects/${a}/agent-requests`, undefined, "GET"))).find((x) => x.id === id)!;

  it("the agent that took a request gives it back with a note, with its token alone, and another agent can take it", async () => {
    const r = await ask(a, { kind: "discover", targetUrl: "https://giveback.example.com" });
    assert.equal((await claim(tokenA, r.id)).status, 200);
    const res = await release(tokenA, r.id, { note: "the site needs a login I do not have" });
    assert.equal(res.headers.get("cache-control"), "no-store");
    const back = await ok<{ status: string; releaseNote: string; claimedBy: string | null }>(res);
    assert.deepEqual([back.status, back.releaseNote, back.claimedBy], ["pending", "the site needs a login I do not have", null]);
    assert.equal((await waiting(tokenA)).some((x) => x.id === r.id), true, "it waits again");
    const card = await mine(r.id);
    assert.deepEqual([card.status, card.releasedBy, card.releaseNote], ["pending", "agent: qa-agent", "the site needs a login I do not have"]);
    assert.equal((await claim(tokenA2, r.id)).status, 200);
    assert.equal((await release(tokenA, r.id)).status, 409, "the first agent no longer holds it");
    assert.equal((await release(tokenA2, r.id)).status, 200);
  });

  it("is refused for a request that is not taken, and for another project's token, and by every other kind of token", async () => {
    const r = await ask(a, { kind: "discover", targetUrl: "https://notmine.example.com" });
    assert.equal((await release(tokenA, r.id)).status, 409, "not taken yet");
    await claim(tokenA, r.id);
    assert.equal((await release(tokenB, r.id)).status, 403);
    for (const t of [readTokenA, ciTokenA]) assert.equal((await release(t, r.id)).status, 401);
    assert.equal((await call(`/api/agent/projects/${a}/requests/${r.id}/release`, { method: "POST", headers: JSON_H, body: "{}" })).status, 401);
    assert.equal((await person(`/api/agent/projects/${a}/requests/${r.id}/release`, {})).status, 401, "a login is not a token");
    assert.equal((await mine(r.id)).status, "claimed", "none of that gave it back");
    assert.equal((await person(`/api/agent-requests/${r.id}/cancel`, {})).status, 200, "a person can still withdraw it");
  });

  it("giving back and finishing at the same time leave one answer: either it waits or it is done, never both", async () => {
    const r = await ask(a, { kind: "discover", targetUrl: "https://race.example.com" });
    await claim(tokenA, r.id);
    const codes = (await Promise.all([release(tokenA, r.id), finish(tokenA, r.id, { note: "done" })])).map((x) => x.status).sort();
    assert.deepEqual(codes, [200, 409]);
    const end = await mine(r.id);
    assert.ok(["pending", "done"].includes(end.status));
  });

  it("a finished discover links the audit that came in after it was taken, and the person's list names it", async () => {
    const r = await ask(a, { kind: "discover", targetUrl: "https://audited.example.com" });
    await claim(tokenA, r.id);
    const auditId = await importAudit(a, "RQA");
    const done = await ok<{ status: string; resultAuditId: number }>(await finish(tokenA, r.id, { note: "audit delivered", resultAuditId: auditId }));
    assert.deepEqual([done.status, done.resultAuditId], ["done", auditId]);
    const card = await mine(r.id);
    assert.equal(card.resultAudit?.title, "Example checkout audit");
  });

  it("refuses an audit that was imported before the request was taken, or belongs to another project, and the request stays taken", async () => {
    const old = await importAudit(a, "RQA");
    const foreign = await importAudit(b, "RQB");
    await new Promise((r) => setTimeout(r, 1100)); // audits are stamped to the second
    const r = await ask(a, { kind: "discover", targetUrl: "https://stale.example.com" });
    await claim(tokenA, r.id);
    const tooOld = await finish(tokenA, r.id, { resultAuditId: old });
    assert.equal(tooOld.status, 400);
    assert.match(((await tooOld.json()) as { error: string }).error, /before this request was taken/);
    assert.equal((await finish(tokenA, r.id, { resultAuditId: foreign })).status, 400);
    assert.equal((await finish(tokenA, r.id, { resultAuditId: "7" })).status, 400);
    assert.equal((await mine(r.id)).status, "claimed");
    assert.equal((await finish(tokenA, r.id, { note: "no audit" })).status, 200);
  });
});

// Before "guessing": that block gets the address slowed down (429) on purpose, and these routes would be slowed with it.
describe("one request at a time, in the order a person chooses (the routes)", () => {
  // A project of its own: nothing else in this file leaves a request waiting or taken here.
  let q = 0;
  let t1 = "";
  let t2 = "";
  before(async () => {
    q = (await ok<{ id: number }>(await person("/api/projects", { name: "Req Q", key: "RQQ" }))).id;
    const mk = async (name: string) => { const t = (await ok<{ token: string }>(await person(`/api/projects/${q}/request-tokens`, { name }))).token; issued.push(t); return t; };
    t1 = await mk("first-agent");
    t2 = await mk("second-agent");
  });
  const make = (n: string) => ask(q, { kind: "discover", targetUrl: `https://${n}.example.com`, note: n });
  const claim = (token: string, id: number) => agent(`Bearer ${token}`, `/api/agent/projects/${q}/requests/${id}/claim`, "POST");
  const finish = (token: string, id: number) => agent(`Bearer ${token}`, `/api/agent/projects/${q}/requests/${id}/complete`, "POST", {});
  const withdraw = async (...ids: number[]) => { for (const id of ids) await person(`/api/agent-requests/${id}/cancel`, {}); };

  it("a second claim is refused (409) while one is taken, the one that runs is named, and it works once that one is done", async () => {
    const r1 = await make("one");
    const r2 = await make("two");
    assert.equal((await claim(t1, r1.id)).status, 200);
    const refused = await claim(t2, r2.id);
    assert.equal(refused.status, 409);
    assert.match(((await refused.json()) as { error: string }).error, new RegExp(`Request #${r1.id} is already being worked on \\(agent: first-agent\\)`));
    assert.equal((await claim(t1, r2.id)).status, 409, "the same token is held to it too");
    assert.equal((await finish(t1, r1.id)).status, 200);
    assert.equal((await claim(t2, r2.id)).status, 200, "free once the first is done");
    assert.equal((await finish(t2, r2.id)).status, 200);
  });

  it("a person puts a request first: the agent's list follows it, and the person's list says each place", async () => {
    const r1 = await make("one");
    const r2 = await make("two");
    const r3 = await make("three");
    assert.deepEqual((await waiting(t1, q)).map((x) => x.id), [r1.id, r2.id, r3.id], "oldest first until someone chooses");
    const put = await person(`/api/agent-requests/${r3.id}/run-next`, {});
    assert.equal(put.status, 200);
    const body = (await put.json()) as { id: number; status: string; priority: number; queuePosition: number };
    assert.deepEqual([body.id, body.status, body.priority, body.queuePosition], [r3.id, "pending", 1, 1]);
    assert.deepEqual((await waiting(t1, q)).map((x) => x.id), [r3.id, r1.id, r2.id]);
    const mine = await ok<{ id: number; queuePosition: number | null }[]>(await person(`/api/projects/${q}/agent-requests`, undefined, "GET"));
    assert.deepEqual([r3.id, r1.id, r2.id].map((id) => mine.find((x) => x.id === id)?.queuePosition), [1, 2, 3]);
    await withdraw(r1.id, r2.id, r3.id);
  });

  it("a request that is taken, or one that is not there, cannot be put first (409, 404), and a person needs no token for it", async () => {
    const r = await make("taken");
    assert.equal((await claim(t1, r.id)).status, 200);
    assert.equal((await person(`/api/agent-requests/${r.id}/run-next`, {})).status, 409);
    assert.equal((await person("/api/agent-requests/99999999/run-next", {})).status, 404);
    assert.equal((await person(`/api/agent-requests/${r.id}/run-next`, undefined, "GET")).status, 404, "it is a POST, nothing is read there");
    await withdraw(r.id);
  });
});

describe("guessing", () => {
  it("is slowed down: many wrong tokens from one address get 429", async () => {
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await agent(`Bearer tbrq_${"y".repeat(42)}${i}`, `/api/agent/projects/${a}/requests`)).status;
    assert.equal(last, 429);
  });
});
