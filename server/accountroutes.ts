import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AccountError, acceptInvite, acceptReset, audit, changePassword, checkLogin, createFirstOwner, createLink, createSession, ctxOf, listAudit, listLinks, listSessions,
  linkProjectId, listUsers, normalizeEmail, peekLink, revokeLink, revokeSessionById, revokeSessionToken, SESSION_DAYS, setDisabled, updateProfile,
} from "./accounts.ts";
import type { AccountUser } from "./accountcontext.ts";
import { adminProjectIds, addMember, allows, listMembers, removeMember, roleOf, roleProblem, setMemberRole } from "./members.ts";
import { projectOf } from "./resolve.ts";
import { joinPage, PAGE_CSP, resetPage, setupPage } from "./accountpages.ts";

/**
 * The routes of the accounts: signing in and out, the first account, invitations, password links, a person's own profile and sessions, and what the owner does.
 * Every handler turns an AccountError into an answer with its status; anything else is a bug and is left to the server's error handler.
 *
 * Anyone signed in looks after their own account; the owner looks after the accounts; the admin of a project looks after its members and the invitations for it
 * (the project routes are guarded by server/accessguard.ts from the table in server/access.ts; the invitation routes check their own rule here).
 */

export const ACCOUNT_COOKIE = "tb_sid";
export type AuthMode = "open" | "password" | "accounts" | "locked";

export const accountCookie = (value: string, maxAgeSeconds: number, secure: boolean) =>
  `${ACCOUNT_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;

export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export const isLoopbackAddress = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

const hostName = (host: string | undefined) => { const h = (host ?? "").toLowerCase(); return h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0]; };
/**
 * Whether a request comes from the computer Testbench runs on. The address alone is not enough: a reverse proxy on the same computer makes every visitor look like
 * 127.0.0.1. So a request that carries proxy headers (X-Forwarded-*, Forwarded) only counts when it was also addressed to localhost, which a visitor through a public name was not.
 */
export function isLocalRequest(req: { ip: string; headers: Record<string, string | string[] | undefined> }): boolean {
  if (!isLoopbackAddress(req.ip)) return false;
  const proxied = Object.keys(req.headers).some((k) => k === "forwarded" || k.startsWith("x-forwarded-"));
  return !proxied || ["localhost", "127.0.0.1", "[::1]"].includes(hostName(req.headers.host as string | undefined));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAIL_DELAY_MS = 250;

interface Limiter { blockedFor(key: string): number; fail(key: string): void; reset(key: string): void }
export interface AccountRouteDeps {
  mode: () => AuthMode;
  /** The shared password's check, when TESTBENCH_PASSWORD is set: it is asked for once, to make the first account. */
  legacyPasswordOk: ((password: string) => boolean) | null;
  makeLimiter: (o?: { max?: number; windowMs?: number }) => Limiter;
}

const body = (req: FastifyRequest): Record<string, unknown> => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === "string" ? v : "");
const origin = (req: FastifyRequest) => `${req.protocol}://${req.headers.host ?? "localhost"}`;
const isHttps = (req: FastifyRequest) => req.protocol === "https";
const publicUser = (u: AccountUser) => ({ id: u.id, email: u.email, name: u.name, isOwner: u.isOwner, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt });

function sessionCookie(req: FastifyRequest, reply: FastifyReply, userId: number) {
  const s = createSession(userId, { ip: req.ip, userAgent: str(req.headers["user-agent"]) });
  reply.header("Set-Cookie", accountCookie(s.token, SESSION_DAYS * 24 * 3600, isHttps(req))).header("Cache-Control", "no-store");
  return s;
}

function page(reply: FastifyReply, html: string, opts: { token?: boolean } = {}) {
  return reply.type("text/html; charset=utf-8").header("Cache-Control", "no-store").header("X-Frame-Options", "DENY").header("Content-Security-Policy", PAGE_CSP)
    .header("Referrer-Policy", opts.token ? "no-referrer" : "same-origin").send(html);
}

export function registerAccountRoutes(app: FastifyInstance, deps: AccountRouteDeps) {
  const linkIp = deps.makeLimiter({ max: 20 });

  /** Runs a handler; an AccountError becomes its answer. */
  const wrap = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      if (e instanceof AccountError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  };
  const tooMany = (reply: FastifyReply, wait: number) => reply.code(429).header("Retry-After", String(Math.ceil(wait / 1000))).send({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60_000)} minutes.` });
  const needAccounts = () => { if (deps.mode() !== "accounts") throw new AccountError(409, "Accounts are not turned on"); };
  const needUser = (req: FastifyRequest): AccountUser => { needAccounts(); if (!req.user) throw new AccountError(401, "Sign in required"); return req.user; };
  const needOwner = (req: FastifyRequest): AccountUser => { const u = needUser(req); if (!u.isOwner) throw new AccountError(403, "Only the owner can do this"); return u; };
  const idOf = (req: FastifyRequest) => { const n = Number((req.params as { id?: string }).id); if (!Number.isInteger(n)) throw new AccountError(400, "Invalid id"); return n; };

  // ---------- Setup: the first account ----------

  app.get("/api/setup/status", wrap((req) => {
    const m = deps.mode();
    if (m === "accounts") return { available: false, needsSetupPassword: false, reason: "Accounts are already set up. Sign in." };
    if (m === "locked") return { available: false, needsSetupPassword: false, reason: "Accounts are on but no account exists. Make the owner on the server: npm run accounts -- create-owner" };
    if (m === "password") return { available: true, needsSetupPassword: true };
    return isLocalRequest(req)
      ? { available: true, needsSetupPassword: false }
      : { available: false, needsSetupPassword: false, reason: "Setup is only offered from the computer Testbench runs on. On the server: npm run accounts -- create-owner" };
  }));

  app.post("/api/setup", wrap(async (req, reply) => {
    const wait = linkIp.blockedFor(req.ip);
    if (wait > 0) return tooMany(reply, wait);
    const m = deps.mode();
    if (m === "accounts") throw new AccountError(409, "Accounts are already set up. Sign in.");
    if (m === "locked") throw new AccountError(409, "Accounts are on but no account exists. Make the owner on the server: npm run accounts -- create-owner");
    const b = body(req);
    if (m === "password") {
      if (!deps.legacyPasswordOk || !deps.legacyPasswordOk(str(b.setupPassword))) { linkIp.fail(req.ip); await sleep(FAIL_DELAY_MS); throw new AccountError(401, "The shared password is wrong"); }
    } else if (!isLocalRequest(req)) {
      throw new AccountError(403, "Setup is only offered from the computer Testbench runs on. On the server: npm run accounts -- create-owner");
    }
    const user = createFirstOwner({ email: str(b.email), name: str(b.name), password: str(b.password) }, { label: "setup", ip: req.ip });
    sessionCookie(req, reply, user.id);
    return { ok: true, user: publicUser(user) };
  }));

  // ---------- Setup, invitation and reset pages ----------

  app.get("/setup", async (req, reply) => {
    const m = deps.mode();
    if (m === "accounts") return reply.code(302).header("Location", "/login").send();
    if (m === "locked") return reply.code(503).type("text/plain; charset=utf-8").send("Accounts are on but no account exists. Make the owner on the server: npm run accounts -- create-owner");
    return page(reply, setupPage());
  });
  app.get("/join/:token", async (_req, reply) => page(reply, joinPage(), { token: true }));
  app.get("/reset/:token", async (_req, reply) => page(reply, resetPage(), { token: true }));

  // ---------- Joining with an invitation, and a password link ----------

  app.get("/api/join/:token", wrap((req, reply) => {
    const wait = linkIp.blockedFor(req.ip);
    if (wait > 0) return tooMany(reply, wait);
    needAccounts();
    const info = peekLink((req.params as { token: string }).token, "invite");
    if (!info) { linkIp.fail(req.ip); throw new AccountError(410, "This invitation has already been used, was revoked, or has expired. Ask for a new one."); }
    return reply.header("Cache-Control", "no-store").send({ invitedBy: info.createdBy, email: info.email, note: info.note });
  }));
  app.post("/api/join/:token", wrap(async (req, reply) => {
    const wait = linkIp.blockedFor(req.ip);
    if (wait > 0) return tooMany(reply, wait);
    needAccounts();
    const b = body(req);
    try {
      const user = acceptInvite((req.params as { token: string }).token, { email: str(b.email), name: str(b.name), password: str(b.password) }, req.ip);
      sessionCookie(req, reply, user.id);
      return { ok: true, user: publicUser(user) };
    } catch (e) {
      if (e instanceof AccountError && e.status === 410) linkIp.fail(req.ip);
      throw e;
    }
  }));
  app.get("/api/reset/:token", wrap((req, reply) => {
    const wait = linkIp.blockedFor(req.ip);
    if (wait > 0) return tooMany(reply, wait);
    needAccounts();
    const info = peekLink((req.params as { token: string }).token, "reset");
    if (!info) { linkIp.fail(req.ip); throw new AccountError(410, "This link has already been used, was revoked, or has expired. Ask for a new one."); }
    const u = listUsers().find((x) => x.id === info.userId);
    return reply.header("Cache-Control", "no-store").send({ email: u?.email ?? "" });
  }));
  app.post("/api/reset/:token", wrap((req, reply) => {
    const wait = linkIp.blockedFor(req.ip);
    if (wait > 0) return tooMany(reply, wait);
    needAccounts();
    try {
      acceptReset((req.params as { token: string }).token, str(body(req).password), req.ip);
      return { ok: true };
    } catch (e) {
      if (e instanceof AccountError && e.status === 410) linkIp.fail(req.ip);
      throw e;
    }
  }));

  // ---------- A person's own account ----------

  app.get("/api/me", wrap((req) => ({ user: publicUser(needUser(req)), sessionId: req.sessionId })));
  app.patch("/api/me", wrap((req) => ({ user: publicUser(updateProfile(needUser(req), { name: body(req).name, email: body(req).email, currentPassword: body(req).currentPassword }, req.ip)) })));
  app.post("/api/me/password", wrap((req) => {
    const u = needUser(req);
    changePassword(u, body(req).current, body(req).next, req.sessionId ?? undefined, req.ip);
    return { ok: true };
  }));
  app.get("/api/me/sessions", wrap((req) => listSessions(needUser(req).id, req.sessionId ?? undefined)));
  app.post("/api/me/sessions/:id/revoke", wrap((req) => { revokeSessionById(needUser(req).id, idOf(req)); return { ok: true }; }));

  // ---------- The owner looks after the accounts ----------

  app.get("/api/users", wrap((req) => { needOwner(req); return listUsers().map((u) => ({ ...publicUser(u), disabledAt: u.disabledAt })); }));
  app.post("/api/users/:id/disable", wrap((req) => { const u = setDisabled(needOwner(req), idOf(req), true, req.ip); return { ...publicUser(u), disabledAt: u.disabledAt }; }));
  app.post("/api/users/:id/enable", wrap((req) => { const u = setDisabled(needOwner(req), idOf(req), false, req.ip); return { ...publicUser(u), disabledAt: u.disabledAt }; }));
  // A link, not an email: Testbench sends nothing. The owner hands it over. It works once, for seven days, and is shown only here.
  app.post("/api/users/:id/reset-link", wrap((req, reply) => {
    const owner = needOwner(req);
    const target = listUsers().find((u) => u.id === idOf(req));
    if (!target) throw new AccountError(404, "Account not found");
    const link = createLink({ kind: "reset", createdBy: owner, userId: target.id });
    audit(ctxOf(owner, req.ip), "password.reset_link_created", { targetUserId: target.id, detail: { linkId: link.id } });
    return reply.header("Cache-Control", "no-store").send({ id: link.id, url: `${origin(req)}/reset/${link.token}`, expiresAt: link.expiresAt });
  }));
  // Invitations: the owner makes any; the admin of a project makes (and sees, and revokes) the ones for that project. Only the owner makes an account that belongs to no project.
  app.get("/api/invitations", wrap((req) => {
    const u = needUser(req);
    if (u.isOwner) return listLinks();
    const mine = adminProjectIds(u);
    if (!mine.length) throw new AccountError(403, "Only the owner or the admin of a project can do this");
    return listLinks({ projectIds: mine });
  }));
  app.post("/api/invitations", wrap((req, reply) => {
    const u = needUser(req);
    const b = body(req);
    const projectId = b.projectId === undefined || b.projectId === null || b.projectId === "" ? null : Number(b.projectId);
    if (projectId === null) needOwner(req);
    else {
      if (!Number.isInteger(projectId) || projectOf("project", projectId) === null || !allows(roleOf(u, projectId), "admin")) throw new AccountError(404, "Not found");
    }
    const role = projectId === null ? null : roleProblem(b.role ?? "tester");
    const link = createLink({ kind: "invite", createdBy: u, email: str(b.email), note: str(b.note), projectId, role });
    audit(ctxOf(u, req.ip), "invitation.created", { projectId, detail: { linkId: link.id, email: normalizeEmail(b.email) || undefined, role: role ?? undefined } });
    return reply.header("Cache-Control", "no-store").send({ id: link.id, url: `${origin(req)}/join/${link.token}`, expiresAt: link.expiresAt });
  }));
  app.post("/api/invitations/:id/revoke", wrap((req) => {
    const u = needUser(req);
    const id = idOf(req);
    const projectId = linkProjectId(id);
    if (!u.isOwner && (projectId === null || !allows(roleOf(u, projectId), "admin"))) throw new AccountError(404, "There is no open link with that id");
    revokeLink(id);
    audit(ctxOf(u, req.ip), "invitation.revoked", { projectId, detail: { linkId: id } });
    return { ok: true };
  }));

  // ---------- Members of a project (an admin of it, or the owner) ----------

  const projectIdOf = (req: FastifyRequest) => idOf(req);
  app.get("/api/projects/:id/members", wrap((req) => {
    const u = needUser(req);
    const pid = projectIdOf(req);
    const members = listMembers(pid);
    // Everyone in the project sees who is in it and with which role; only an admin sees email addresses.
    return roleOf(u, pid) === "admin" ? members : members.map(({ email: _email, ...rest }) => rest);
  }));
  app.get("/api/projects/:id/me", wrap((req) => { const u = needUser(req); return { role: roleOf(u, projectIdOf(req)), isOwner: u.isOwner }; }));
  app.post("/api/projects/:id/members", wrap((req) => ({ member: addMember(needUser(req), projectIdOf(req), body(req).email, body(req).role ?? "tester", req.ip) })));
  app.patch("/api/projects/:id/members/:userId", wrap((req) => ({ member: setMemberRole(needUser(req), projectIdOf(req), Number((req.params as { userId?: string }).userId), body(req).role, req.ip) })));
  app.delete("/api/projects/:id/members/:userId", wrap((req) => { removeMember(needUser(req), projectIdOf(req), Number((req.params as { userId?: string }).userId), req.ip); return { ok: true }; }));
  app.get("/api/audit-log", wrap((req) => {
    needOwner(req);
    const q = req.query as { limit?: string; before?: string };
    return listAudit({ limit: Number(q.limit) || undefined, before: Number(q.before) || undefined });
  }));
}

// ---------- Signing in and out, used by auth.ts for /api/login and /api/logout ----------

export function makeAccountSession(deps: Pick<AccountRouteDeps, "makeLimiter">) {
  const loginIp = deps.makeLimiter({ max: 5 });
  const loginAccount = deps.makeLimiter({ max: 10 });
  return {
    async login(req: FastifyRequest, reply: FastifyReply) {
      const b = body(req);
      const email = normalizeEmail(b.email);
      const wait = Math.max(loginIp.blockedFor(req.ip), loginAccount.blockedFor(email || "-"));
      if (wait > 0) return reply.code(429).header("Retry-After", String(Math.ceil(wait / 1000))).send({ error: `Too many wrong attempts. Try again in ${Math.ceil(wait / 60_000)} minutes.` });
      const user = checkLogin(email, b.password);
      if (!user) {
        loginIp.fail(req.ip);
        loginAccount.fail(email || "-");
        // What was typed is not stored (a password typed into the email field would end up in the log); only that a sign-in failed, and from where.
        audit({ label: "anonymous", ip: req.ip }, "login.failed");
        await sleep(FAIL_DELAY_MS); // slows guessing even before the limit
        return reply.code(401).send({ error: "Wrong email or password" });
      }
      loginIp.reset(req.ip);
      loginAccount.reset(email);
      sessionCookie(req, reply, user.id);
      audit(ctxOf(user, req.ip), "login.succeeded", { targetUserId: user.id });
      return reply.send({ ok: true, user: publicUser(user) });
    },
    logout(req: FastifyRequest, reply: FastifyReply) {
      revokeSessionToken(cookieValue(req.headers.cookie, ACCOUNT_COOKIE));
      return reply.header("Set-Cookie", accountCookie("", 0, isHttps(req))).send({ ok: true });
    },
  };
}

export { publicUser };
