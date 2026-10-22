import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify from "fastify";
import {
  authConfigFromEnv, COOKIE, createSessionToken, deriveSessionKey, makeLimiter, makePasswordChecker, readCookie, registerAuth, verifySessionToken,
} from "../server/auth.ts";

const PASSWORD = "correct horse battery";

describe("authConfigFromEnv", () => {
  it("is off without a password, and rejects short ones", () => {
    assert.equal(authConfigFromEnv({}), null);
    assert.throws(() => authConfigFromEnv({ TESTBENCH_PASSWORD: "short" }), /at least 8/);
  });
  it("defaults sessions to 7 days and honours TESTBENCH_SESSION_DAYS", () => {
    assert.equal(authConfigFromEnv({ TESTBENCH_PASSWORD: PASSWORD })?.sessionDays, 7);
    assert.equal(authConfigFromEnv({ TESTBENCH_PASSWORD: PASSWORD, TESTBENCH_SESSION_DAYS: "30" })?.sessionDays, 30);
    assert.equal(authConfigFromEnv({ TESTBENCH_PASSWORD: PASSWORD, TESTBENCH_SESSION_DAYS: "nonsense" })?.sessionDays, 7);
  });
});

describe("session tokens", () => {
  const key = deriveSessionKey(PASSWORD);
  const now = 1_800_000_000_000;

  it("verify while valid and fail once expired", () => {
    const t = createSessionToken(key, 1000, now);
    assert.equal(verifySessionToken(key, t, now + 999), true);
    assert.equal(verifySessionToken(key, t, now + 1001), false);
  });

  it("fail when tampered with, truncated, empty or signed with another password", () => {
    const t = createSessionToken(key, 60_000, now);
    const [exp, nonce, sig] = t.split(".");
    assert.equal(verifySessionToken(key, `${Number(exp) + 99999}.${nonce}.${sig}`, now), false); // extended expiry
    assert.equal(verifySessionToken(key, `${exp}.${nonce}.${sig.slice(0, -2)}`, now), false);
    assert.equal(verifySessionToken(key, `${exp}.${nonce}`, now), false);
    assert.equal(verifySessionToken(key, "", now), false);
    assert.equal(verifySessionToken(key, undefined, now), false);
    assert.equal(verifySessionToken(deriveSessionKey("another password!"), t, now), false);
  });

  it("are different every time", () => {
    assert.notEqual(createSessionToken(key, 1000, now), createSessionToken(key, 1000, now));
  });
});

describe("password checker", () => {
  it("accepts only the exact password", () => {
    const check = makePasswordChecker(PASSWORD);
    assert.equal(check(PASSWORD), true);
    assert.equal(check(PASSWORD + " "), false);
    assert.equal(check("wrong"), false);
    assert.equal(check(""), false);
  });
});

describe("login limiter", () => {
  it("blocks an address after the limit, only that address, and lets it back in after the window", () => {
    const l = makeLimiter({ max: 3, windowMs: 1000 });
    for (let i = 0; i < 2; i++) l.fail("a", 0);
    assert.equal(l.blockedFor("a", 10), 0);
    l.fail("a", 20);
    assert.ok(l.blockedFor("a", 30) > 0);
    assert.equal(l.blockedFor("b", 30), 0);
    assert.equal(l.blockedFor("a", 1001), 0);
  });
  it("forgets an address after a success", () => {
    const l = makeLimiter({ max: 2, windowMs: 1000 });
    l.fail("a", 0);
    l.fail("a", 1);
    l.reset("a");
    assert.equal(l.blockedFor("a", 2), 0);
  });
});

describe("readCookie", () => {
  it("finds a cookie among several", () => {
    assert.equal(readCookie("a=1; tb_session=abc.def; b=2", "tb_session"), "abc.def");
    assert.equal(readCookie("a=1", "tb_session"), undefined);
    assert.equal(readCookie(undefined, "tb_session"), undefined);
  });
});

async function makeApp(opts: { password?: string; trustProxy?: boolean } = {}) {
  const app = Fastify({ trustProxy: opts.trustProxy ?? false });
  registerAuth(app, opts.password ? authConfigFromEnv({ TESTBENCH_PASSWORD: opts.password }) : null);
  app.get("/api/ping", async () => ({ pong: true }));
  app.get("/", async (_req, reply) => reply.type("text/html").send("<p>app</p>"));
  app.get("/uploads/secret.txt", async () => "evidence");
  await app.ready();
  return app;
}

const H = { "x-testbench": "1" };
const login = (app: Awaited<ReturnType<typeof makeApp>>, password: string, extra: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: "/api/login", headers: H, payload: { password }, ...extra });
const sessionCookie = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"]).split(";")[0];

describe("with a password", async () => {
  const app = await makeApp({ password: PASSWORD });

  it("keeps the API, the app and uploaded files behind the login", async () => {
    const api = await app.inject({ url: "/api/ping" });
    assert.equal(api.statusCode, 401);
    assert.deepEqual(api.json(), { error: "Sign in required" });
    const page = await app.inject({ url: "/" });
    assert.equal(page.statusCode, 302);
    assert.equal(page.headers.location, "/login");
    assert.equal((await app.inject({ url: "/uploads/secret.txt" })).statusCode, 302);
    assert.equal((await app.inject({ method: "POST", url: "/api/anything", headers: H })).statusCode, 401);
  });

  it("serves the login page with strict headers, and reports who is signed in", async () => {
    const page = await app.inject({ url: "/login" });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-type"] as string, /text\/html/);
    assert.match(page.headers["content-security-policy"] as string, /default-src 'none'/);
    assert.equal(page.headers["x-frame-options"], "DENY");
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.deepEqual((await app.inject({ url: "/api/auth/status" })).json(), { enabled: true, authenticated: false });
  });

  it("rejects a wrong password without setting a cookie", async () => {
    const res = await login(app, "nope nope nope");
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers["set-cookie"], undefined);
    assert.equal((await login(app, undefined as unknown as string)).statusCode, 401);
  });

  it("signs in with the right password and sets a locked-down cookie", async () => {
    const res = await login(app, PASSWORD);
    assert.equal(res.statusCode, 200);
    const setCookie = String(res.headers["set-cookie"]);
    assert.match(setCookie, new RegExp(`^${COOKIE}=`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Max-Age=604800/);
    assert.doesNotMatch(setCookie, /Secure/); // plain http in this test
  });

  it("lets a signed-in browser through, and sends it away from the login page", async () => {
    const cookie = sessionCookie(await login(app, PASSWORD));
    assert.equal((await app.inject({ url: "/api/ping", headers: { cookie } })).statusCode, 200);
    assert.equal((await app.inject({ url: "/uploads/secret.txt", headers: { cookie } })).statusCode, 200);
    assert.equal((await app.inject({ url: "/login", headers: { cookie } })).headers.location, "/");
    assert.deepEqual((await app.inject({ url: "/api/auth/status", headers: { cookie } })).json(), { enabled: true, authenticated: true });
  });

  it("rejects a forged, tampered or expired cookie", async () => {
    const good = sessionCookie(await login(app, PASSWORD));
    const tampered = good.slice(0, -3) + "AAA";
    assert.equal((await app.inject({ url: "/api/ping", headers: { cookie: tampered } })).statusCode, 401);
    assert.equal((await app.inject({ url: "/api/ping", headers: { cookie: `${COOKIE}=1.2.3` } })).statusCode, 401);
    const expired = createSessionToken(deriveSessionKey(PASSWORD), 1000, Date.now() - 10_000);
    assert.equal((await app.inject({ url: "/api/ping", headers: { cookie: `${COOKIE}=${expired}` } })).statusCode, 401);
  });

  it("signs out by clearing the cookie", async () => {
    const cookie = sessionCookie(await login(app, PASSWORD));
    const res = await app.inject({ method: "POST", url: "/api/logout", headers: { ...H, cookie } });
    assert.match(String(res.headers["set-cookie"]), /Max-Age=0/);
  });

  it("blocks an address after five wrong passwords, even for the right one", async () => {
    const ip = "10.9.9.9";
    for (let i = 0; i < 5; i++) assert.equal((await login(app, "wrong wrong", { remoteAddress: ip })).statusCode, 401);
    const blocked = await login(app, PASSWORD, { remoteAddress: ip });
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers["retry-after"]) > 0);
    // another address is not affected
    assert.equal((await login(app, PASSWORD, { remoteAddress: "10.1.1.1" })).statusCode, 200);
  });
});

describe("behind an HTTPS proxy", async () => {
  it("marks the cookie Secure when the proxy says the request was https", async () => {
    const app = await makeApp({ password: PASSWORD, trustProxy: true });
    const res = await login(app, PASSWORD, { headers: { ...H, "x-forwarded-proto": "https" } });
    assert.match(String(res.headers["set-cookie"]), /; Secure/);
  });
});

describe("without a password", async () => {
  const app = await makeApp();
  it("leaves everything open and says so", async () => {
    assert.equal((await app.inject({ url: "/api/ping" })).statusCode, 200);
    assert.deepEqual((await app.inject({ url: "/api/auth/status" })).json(), { enabled: false, authenticated: true });
    assert.equal((await app.inject({ url: "/login" })).statusCode, 404);
  });
  it("still adds the basic hardening headers", async () => {
    assert.equal((await app.inject({ url: "/api/ping" })).headers["x-content-type-options"], "nosniff");
  });
});
