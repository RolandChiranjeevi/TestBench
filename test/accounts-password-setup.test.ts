import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify from "fastify";
import { authConfigFromEnv, registerAuth } from "../server/auth.ts";
import { accountsState } from "../server/accounts.ts";

// An installation that has the shared password (TESTBENCH_PASSWORD) and no account yet: the first account asks for that password, once. After it, accounts are on,
// the shared password logs nobody in, and the old shared-password cookie opens nothing. A small app with only the login in front of it, like auth.test.ts.

const SHARED = "correct horse battery";
const GOOD = "a long passphrase here";
const H = { "x-testbench": "1" };

const app = Fastify();
registerAuth(app, authConfigFromEnv({ TESTBENCH_PASSWORD: SHARED }));
app.get("/api/ping", async () => ({ pong: true }));
await app.ready();

const call = (method: "GET" | "POST", url: string, o: { cookie?: string; body?: unknown; ip?: string } = {}) =>
  app.inject({ method, url, remoteAddress: o.ip ?? "10.1.1.1", headers: { ...H, ...(o.cookie ? { cookie: o.cookie } : {}) }, payload: o.body as object | undefined });
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"]).split(";")[0];

describe("setting up the first account behind the shared password", () => {
  let legacyCookie = "";
  let accountCookie = "";

  it("is still the shared-password login until an account exists, and says that setup needs that password", async () => {
    assert.equal(accountsState(), "open");
    assert.equal((await call("GET", "/api/ping")).statusCode, 401);
    assert.deepEqual((await call("GET", "/api/auth/status")).json(), { enabled: true, authenticated: false });
    assert.deepEqual((await call("GET", "/api/setup/status")).json(), { available: true, needsSetupPassword: true });
    assert.equal((await call("GET", "/setup")).statusCode, 200, "the setup page is open: it asks for the password itself");
    const res = await call("POST", "/api/login", { body: { password: SHARED } });
    assert.equal(res.statusCode, 200);
    legacyCookie = cookieOf(res);
    assert.equal((await call("GET", "/api/ping", { cookie: legacyCookie })).statusCode, 200);
  });

  it("the wrong shared password, or none, makes no account, from anywhere", async () => {
    for (const setupPassword of ["wrong password!!", "", undefined]) {
      const r = await call("POST", "/api/setup", { body: { name: "Anna", email: "anna@example.com", password: GOOD, ...(setupPassword === undefined ? {} : { setupPassword }) } });
      assert.equal(r.statusCode, 401);
      assert.match(r.json().error, /shared password is wrong/);
      assert.equal(r.headers["set-cookie"], undefined);
    }
    assert.equal(accountsState(), "open");
  });

  it("the right shared password makes the owner, who is signed in", async () => {
    const r = await call("POST", "/api/setup", { body: { name: "Anna Owner", email: "anna@example.com", password: GOOD, setupPassword: SHARED } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().user.isOwner, true);
    accountCookie = cookieOf(r);
    assert.match(accountCookie, /^tb_sid=/);
    assert.equal(accountsState(), "accounts");
    assert.equal((await call("GET", "/api/ping", { cookie: accountCookie })).statusCode, 200);
  });

  it("from then on the shared password is nothing: it logs nobody in, its cookie opens nothing, and setup is closed", async () => {
    assert.equal((await call("GET", "/api/ping", { cookie: legacyCookie })).statusCode, 401, "the old shared-password session is dead");
    assert.equal((await call("POST", "/api/login", { body: { password: SHARED } })).statusCode, 401);
    assert.equal((await call("POST", "/api/login", { body: { email: "anna@example.com", password: SHARED } })).statusCode, 401, "the shared password is not Anna's password");
    assert.equal((await call("POST", "/api/login", { body: { email: "anna@example.com", password: GOOD } })).statusCode, 200);
    const again = await call("POST", "/api/setup", { body: { name: "X", email: "x@example.com", password: GOOD, setupPassword: SHARED } });
    assert.equal(again.statusCode, 409);
    assert.deepEqual((await call("GET", "/api/auth/status")).json(), { enabled: true, authenticated: false, mode: "accounts" });
  });
});
