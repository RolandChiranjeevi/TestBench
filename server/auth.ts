import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isCiIngest } from "./ci.ts";
import { isAgentRead } from "./agenttokens.ts";
import { isAgentPropose } from "./proposetokens.ts";
import { accountsState, sessionFromToken } from "./accounts.ts";
import { enterAs } from "./accountcontext.ts";
import { ACCOUNT_COOKIE, cookieValue, makeAccountSession, registerAccountRoutes, type AuthMode } from "./accountroutes.ts";
import { loginPage, PAGE_CSP } from "./accountpages.ts";

/**
 * Who may use this Testbench. Four modes, by what exists (see accounts.ts):
 *  - open:     nothing is set up. No login. The way Testbench has always run on one computer.
 *  - password: TESTBENCH_PASSWORD is set and no account exists. The shared-password login described below.
 *  - accounts: at least one account exists. Everyone signs in with their own email and password; sessions are kept on the server and can be ended. Permanent.
 *  - locked:   accounts were on but none exist (an old backup was restored). Everything is refused until an owner is made on the server.
 *
 * The shared-password login: off unless TESTBENCH_PASSWORD is set.
 *
 * - The password is only kept as a scrypt hash in memory and compared in constant time.
 * - A session is a signed, expiring cookie (HttpOnly, SameSite=Strict, Secure over HTTPS). Its key is derived from the password,
 *   so changing the password signs everyone out. Nothing is stored on disk.
 * - Wrong passwords are slowed down and, after a few, blocked per address for a while.
 */

export const COOKIE = "tb_session";
const SESSION_KEY_SALT = "testbench-session-v1";

export interface AuthConfig {
  password: string;
  sessionDays: number;
}

export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig | null {
  const password = env.TESTBENCH_PASSWORD;
  if (!password) return null;
  if (password.length < 8) throw new Error("TESTBENCH_PASSWORD must be at least 8 characters long.");
  const days = Number(env.TESTBENCH_SESSION_DAYS);
  return { password, sessionDays: days > 0 ? days : 7 };
}

// ---------- Tokens ----------

const sign = (key: Buffer, body: string) => createHmac("sha256", key).update(body).digest("base64url");

export const deriveSessionKey = (password: string) => scryptSync(password, SESSION_KEY_SALT, 32);

export function createSessionToken(key: Buffer, ttlMs: number, now = Date.now()): string {
  const body = `${now + ttlMs}.${randomBytes(12).toString("base64url")}`;
  return `${body}.${sign(key, body)}`;
}

export function verifySessionToken(key: Buffer, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [exp, nonce, sig] = parts;
  const given = Buffer.from(sig);
  const expected = Buffer.from(sign(key, `${exp}.${nonce}`));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  return Number(exp) > now;
}

// ---------- Password ----------

export function makePasswordChecker(password: string): (input: string) => boolean {
  const salt = randomBytes(16);
  const expected = scryptSync(password, salt, 32);
  return (input) => timingSafeEqual(scryptSync(input.slice(0, 1024), salt, 32), expected);
}

// ---------- Brute-force limit ----------

export function makeLimiter({ max = 5, windowMs = 15 * 60_000 }: { max?: number; windowMs?: number } = {}) {
  const hits = new Map<string, { n: number; first: number }>();
  return {
    /** Milliseconds this address must wait, or 0. */
    blockedFor(ip: string, now = Date.now()): number {
      const h = hits.get(ip);
      if (!h) return 0;
      if (now - h.first >= windowMs) {
        hits.delete(ip);
        return 0;
      }
      return h.n >= max ? h.first + windowMs - now : 0;
    },
    fail(ip: string, now = Date.now()) {
      const h = hits.get(ip);
      if (!h || now - h.first >= windowMs) hits.set(ip, { n: 1, first: now });
      else h.n++;
      if (hits.size > 5000) for (const [k, v] of hits) if (now - v.first >= windowMs) hits.delete(k);
    },
    reset(ip: string) {
      hits.delete(ip);
    },
  };
}

// ---------- Cookies ----------

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

const cookie = (value: string, maxAgeSeconds: number, secure: boolean) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;

// ---------- Login page ----------

const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Testbench</title>
<style>
  :root { color-scheme: dark light; --bg:#0b121a; --card:#111b26; --text:#eaf0f5; --muted:#9aaaba; --border:#25374a; --accent:#e78548; --on-accent:#0b121a; --err:#fb8383; }
  @media (prefers-color-scheme: light) { :root { --bg:#f1f0ea; --card:#fff; --text:#14202c; --muted:#485b6d; --border:#dddbd2; --accent:#b04a14; --on-accent:#fff; --err:#b42323; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text); font:14px/1.45 -apple-system, "Helvetica Neue", Arial, sans-serif; }
  form { width:min(340px, calc(100vw - 32px)); background:var(--card); border:1px solid var(--border); border-radius:10px; padding:24px; }
  h1 { margin:0 0 4px; font-size:18px; letter-spacing:-0.01em; }
  p { margin:0 0 16px; color:var(--muted); }
  label { display:block; margin-bottom:6px; font-weight:500; }
  input { width:100%; height:36px; padding:0 10px; border-radius:6px; border:1px solid var(--border); background:var(--bg); color:var(--text); font:inherit; }
  input:focus { outline:2px solid var(--accent); outline-offset:-1px; }
  button { margin-top:14px; width:100%; height:36px; border:0; border-radius:6px; background:var(--accent); color:var(--on-accent); font:inherit; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.6; cursor:default; }
  #err { min-height:20px; margin-top:10px; color:var(--err); font-size:13px; }
</style></head>
<body>
<form id="f" method="post" action="/api/login">
  <h1>Testbench</h1>
  <p>Enter the password to continue.</p>
  <label for="p">Password</label>
  <input id="p" name="password" type="password" autocomplete="current-password" autofocus required>
  <button id="b" type="submit">Sign in</button>
  <div id="err" role="alert"></div>
</form>
<script>
  const f = document.getElementById("f"), err = document.getElementById("err"), b = document.getElementById("b");
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = ""; b.disabled = true;
    try {
      const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Testbench": "1" }, body: JSON.stringify({ password: document.getElementById("p").value }) });
      if (res.ok) { location.href = "/"; return; }
      const body = await res.json().catch(() => ({}));
      err.textContent = body.error || "Could not sign in.";
    } catch { err.textContent = "Could not reach the server."; }
    b.disabled = false;
  });
</script>
</body></html>`;

// ---------- Wiring ----------

const PUBLIC_PATHS = new Set(["/login", "/api/login", "/api/auth/status", "/setup", "/api/setup", "/api/setup/status"]);
const PUBLIC_PREFIXES = ["/join/", "/api/join/", "/reset/", "/api/reset/"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The gate in front of everything, and the login routes. The mode is worked out on every request, because it changes while the server runs: the first account turns
 * "open" or "password" into "accounts" for good.
 */
export function registerAuth(app: FastifyInstance, cfg: AuthConfig | null) {
  // Cheap hardening for every response (a route may set a stricter value itself).
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    if (!reply.getHeader("Referrer-Policy")) reply.header("Referrer-Policy", "same-origin");
  });
  app.decorateRequest("user", null);
  app.decorateRequest("sessionId", null);

  const legacy = cfg ? { key: deriveSessionKey(cfg.password), check: makePasswordChecker(cfg.password), limiter: makeLimiter(), ttlMs: cfg.sessionDays * 24 * 60 * 60 * 1000 } : null;
  const mode = (): AuthMode => { const s = accountsState(); return s !== "open" ? s : cfg ? "password" : "open"; };
  const isHttps = (req: FastifyRequest) => req.protocol === "https";
  const legacyAuthed = (req: FastifyRequest) => !!legacy && verifySessionToken(legacy.key, readCookie(req.headers.cookie, COOKIE));
  const accountUser = (req: FastifyRequest) => sessionFromToken(cookieValue(req.headers.cookie, ACCOUNT_COOKIE));
  const session = makeAccountSession({ makeLimiter });
  const LOCKED = "Accounts are on but no account exists (was an older backup restored?). Make the owner on the server: npm run accounts -- create-owner";

  app.addHook("onRequest", async (req, reply: FastifyReply) => {
    const m = mode();
    if (m === "open") return;
    const path = req.url.split("?")[0];
    if (m === "locked") {
      if (path === "/api/auth/status") return;
      return reply.code(503).send(path.startsWith("/api/") ? { error: LOCKED } : LOCKED);
    }
    // CI's route, the agent's read route and the agent's proposal route skip the login only because their handlers require their own API token on every call.
    const tokenRoute = isCiIngest(req.method, req.url) || isAgentRead(req.method, req.url) || isAgentPropose(req.method, req.url);
    let allowed = tokenRoute || PUBLIC_PATHS.has(path) || (m === "accounts" && PUBLIC_PREFIXES.some((x) => path.startsWith(x)));
    if (m === "accounts") {
      const found = accountUser(req);
      if (found) {
        req.user = found.user;
        req.sessionId = found.sessionId;
        enterAs(found.user); // from here on, whatever this request records as "who" is this person
        allowed = true;
      }
    } else if (legacyAuthed(req)) allowed = true;
    if (allowed) return;
    if (path.startsWith("/api/") || (req.method !== "GET" && req.method !== "HEAD")) return reply.code(401).send({ error: "Sign in required" });
    return reply.code(302).header("Location", "/login").send();
  });

  app.get("/api/auth/status", async (req) => {
    const m = mode();
    if (m === "open") return { enabled: false, authenticated: true };
    if (m === "password") return { enabled: true, authenticated: legacyAuthed(req) };
    if (m === "locked") return { enabled: true, authenticated: false, mode: "locked" };
    const found = accountUser(req);
    return { enabled: true, authenticated: !!found, mode: "accounts", ...(found ? { user: { id: found.user.id, email: found.user.email, name: found.user.name, isOwner: found.user.isOwner } } : {}) };
  });

  app.get("/login", async (req, reply) => {
    const m = mode();
    if (m === "open") return reply.callNotFound();
    if (m === "locked") return reply.code(503).type("text/plain; charset=utf-8").send(LOCKED);
    if (m === "accounts" ? !!accountUser(req) : legacyAuthed(req)) return reply.code(302).header("Location", "/").send();
    return reply
      .type("text/html; charset=utf-8")
      .header("Cache-Control", "no-store")
      .header("X-Frame-Options", "DENY")
      .header("Content-Security-Policy", PAGE_CSP)
      .send(m === "accounts" ? loginPage() : LOGIN_PAGE);
  });

  app.post("/api/login", async (req, reply) => {
    const m = mode();
    if (m === "open" || m === "locked") return reply.callNotFound();
    if (m === "accounts") return session.login(req, reply);
    const limiter = legacy!.limiter;
    const wait = limiter.blockedFor(req.ip);
    if (wait > 0) {
      return reply.code(429).header("Retry-After", String(Math.ceil(wait / 1000))).send({ error: `Too many wrong passwords. Try again in ${Math.ceil(wait / 60_000)} minutes.` });
    }
    const password = (req.body as { password?: unknown } | null)?.password;
    if (typeof password !== "string" || !legacy!.check(password)) {
      limiter.fail(req.ip);
      await sleep(400); // slows guessing even before the limit is reached
      return reply.code(401).send({ error: "Wrong password" });
    }
    limiter.reset(req.ip);
    return reply
      .header("Set-Cookie", cookie(createSessionToken(legacy!.key, legacy!.ttlMs), Math.floor(legacy!.ttlMs / 1000), isHttps(req)))
      .header("Cache-Control", "no-store")
      .send({ ok: true });
  });

  app.post("/api/logout", async (req, reply) => {
    const m = mode();
    if (m === "open" || m === "locked") return reply.callNotFound();
    if (m === "accounts") return session.logout(req, reply);
    return reply.header("Set-Cookie", cookie("", 0, isHttps(req))).send({ ok: true });
  });

  registerAccountRoutes(app, { mode, legacyPasswordOk: legacy ? legacy.check : null, makeLimiter });
}
