import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, db } from "./db.ts";
import { getDisplayName } from "./actor.ts";
import type { AccountUser } from "./accountcontext.ts";

/**
 * Accounts: people who sign in, with a password of their own.
 *
 * Three states, decided by what is in the database and one marker file next to it:
 *  - open:     no account exists. Testbench works as it always has (no login, or the one shared password if TESTBENCH_PASSWORD is set).
 *  - accounts: at least one account exists. Everything needs a login. There is no way back to open from inside Testbench.
 *  - locked:   the marker file says accounts were on, but no account exists (an older backup was restored over the database). Everything is refused until an owner is
 *              made on the server (`npm run accounts -- create-owner`). Restoring a backup can therefore never silently reopen an installation.
 *
 * Passwords are hashed with scrypt (node:crypto, no extra package), each with its own salt. Sessions and links are random values of which only a sha256 is stored.
 * Nothing here reads a request: auth.ts and accountroutes.ts do that, and call these functions.
 */

export class AccountError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 410 | 429, message: string) {
    super(message);
  }
}

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 1024;
export const NAME_MAX = 80;
export const EMAIL_MAX = 254;
export const MAX_SESSIONS_PER_USER = 20;
export const SESSION_DAYS = (() => { const d = Number(process.env.TESTBENCH_SESSION_DAYS); return d > 0 ? d : 7; })();
export const LINK_DAYS = 7;

// ---------- Passwords ----------

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

/** `scrypt$N$r$p$salt$hash`. The parameters are in the string so they can be raised later without locking anybody out. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.slice(0, PASSWORD_MAX), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, n, r, p, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const N = Number(n), R = Number(r), P = Number(p);
  if (![N, R, P].every(Number.isInteger) || N < 1024 || N > 1 << 20 || R < 1 || R > 16 || P < 1 || P > 4) return false;
  const expected = Buffer.from(hash, "base64url");
  const got = scryptSync(password.slice(0, PASSWORD_MAX), Buffer.from(salt, "base64url"), expected.length, { N, r: R, p: P, maxmem: 128 * 1024 * 1024 });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

let dummyHash: string | null = null;
/** Checked against when the email is unknown, so an unknown email takes as long as a wrong password and does not give itself away. */
const dummy = () => (dummyHash ??= hashPassword("not a real password, only for timing"));

/** Why this password is not allowed, or null. */
export function passwordProblem(password: unknown, who: { email?: string; name?: string } = {}): string | null {
  if (typeof password !== "string") return "The password must be text";
  if (password.length < PASSWORD_MIN) return `The password must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `The password can be at most ${PASSWORD_MAX} characters`;
  if (!password.trim()) return "The password cannot be only spaces";
  if (new Set(password).size < 3) return "The password is too simple: use more than two different characters";
  const lower = password.toLowerCase();
  if ((who.email && lower === who.email.toLowerCase()) || (who.name && lower === who.name.trim().toLowerCase())) return "The password cannot be your email or your name";
  return null;
}

export const normalizeEmail = (email: unknown): string => (typeof email === "string" ? email.trim().toLowerCase() : "");
export function emailProblem(email: string): string | null {
  if (!email) return "An email address is needed";
  if (email.length > EMAIL_MAX) return `The email address can be at most ${EMAIL_MAX} characters`;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "That does not look like an email address";
  return null;
}
export function nameProblem(name: unknown): string | null {
  if (typeof name !== "string" || !name.trim()) return "A name is needed";
  if (name.trim().length > NAME_MAX) return `The name can be at most ${NAME_MAX} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "The name cannot contain control characters";
  return null;
}

// ---------- The three states ----------

const marker = () => join(DATA_DIR, ".accounts-enabled");

export type AccountsState = "open" | "accounts" | "locked";
export function accountsState(): AccountsState {
  const n = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  if (n > 0) {
    // Checked every time (a stat is cheap), so a marker that was removed is written again.
    if (!existsSync(marker())) writeFileSync(marker(), "accounts are on for this installation; see server/accounts.ts\n", { mode: 0o600 });
    return "accounts";
  }
  return existsSync(marker()) ? "locked" : "open";
}

// ---------- Users ----------

const toUser = (r: Record<string, any>): AccountUser => ({ id: r.id, email: r.email, name: r.name, isOwner: !!r.is_owner, disabledAt: r.disabled_at, createdAt: r.created_at, lastLoginAt: r.last_login_at });
export const getUser = (id: number): AccountUser | null => { const r = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, any> | undefined; return r ? toUser(r) : null; };
export const listUsers = () => (db.prepare("SELECT * FROM users ORDER BY id").all() as Record<string, any>[]).map(toUser);

function insertUser(input: { email: string; name: string; password: string; isOwner?: boolean }): AccountUser {
  const email = normalizeEmail(input.email);
  const problem = emailProblem(email) ?? nameProblem(input.name) ?? passwordProblem(input.password, { email, name: input.name });
  if (problem) throw new AccountError(400, problem);
  try {
    const r = db.prepare("INSERT INTO users (email, name, password_hash, is_owner, password_changed_at) VALUES (?, ?, ?, ?, datetime('now')) RETURNING *")
      .get(email, input.name.trim(), hashPassword(input.password), input.isOwner ? 1 : 0) as Record<string, any>;
    return toUser(r);
  } catch (e) {
    if (e instanceof Error && /UNIQUE/.test(e.message)) throw new AccountError(409, "An account with this email address already exists");
    throw e;
  }
}

// ---------- The audit log: what happened to accounts and permissions. Append-only (see migrateAccounts). ----------

export interface AuditCtx { userId?: number | null; label: string; ip?: string }
const SECRET_KEY = /pass|token|secret|hash|cookie/i;

export function audit(ctx: AuditCtx, action: string, opts: { targetUserId?: number | null; projectId?: number | null; detail?: Record<string, unknown> } = {}) {
  const detail = Object.fromEntries(Object.entries(opts.detail ?? {}).filter(([k]) => !SECRET_KEY.test(k)));
  db.prepare("INSERT INTO audit_log (actor_user_id, actor_label, action, target_user_id, project_id, ip, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(ctx.userId ?? null, ctx.label, action, opts.targetUserId ?? null, opts.projectId ?? null, ctx.ip ?? "", JSON.stringify(detail));
}
export const ctxOf = (user: AccountUser | null, ip = ""): AuditCtx => ({ userId: user?.id ?? null, label: user?.name ?? "anonymous", ip });

export function listAudit(opts: { limit?: number; before?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = db.prepare(`SELECT * FROM audit_log ${opts.before ? "WHERE id < ?" : ""} ORDER BY id DESC LIMIT ?`).all(...(opts.before ? [opts.before, limit] : [limit])) as Record<string, any>[];
  return rows.map((r) => ({ id: r.id, at: r.at, actorUserId: r.actor_user_id, actor: r.actor_label, action: r.action, targetUserId: r.target_user_id, projectId: r.project_id, ip: r.ip, detail: JSON.parse(r.detail) as Record<string, unknown> }));
}

// ---------- The first account ----------

/**
 * Makes the owner: the first account. Only while the installation is open, or (from the command line, which is the way back) locked. The name defaults to the display
 * name that was set in Settings before there were accounts, so what was recorded under it keeps its author.
 */
export function createFirstOwner(input: { email: string; name?: string; password: string }, ctx: AuditCtx, opts: { allowLocked?: boolean } = {}): AccountUser {
  return db.transaction(() => {
    const state = accountsState();
    if (state === "accounts") throw new AccountError(409, "Accounts are already on. Sign in, or ask the owner for an invitation.");
    if (state === "locked" && !opts.allowLocked) throw new AccountError(409, "Accounts are on but no account exists. Make the owner on the server: npm run accounts -- create-owner");
    const user = insertUser({ email: input.email, name: input.name?.trim() || getDisplayName() || "Owner", password: input.password, isOwner: true });
    audit({ ...ctx, userId: user.id, label: user.name }, "account.setup", { targetUserId: user.id });
    accountsState(); // writes the marker
    return user;
  }).immediate();
}

// ---------- Signing in ----------

/** The user for this email and password, or null. Unknown email, wrong password and a disabled account all look the same, and take as long. */
export function checkLogin(email: unknown, password: unknown): AccountUser | null {
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email)) as Record<string, any> | undefined;
  const ok = verifyPassword(typeof password === "string" ? password : "", row?.password_hash ?? dummy());
  if (!row || !ok || row.disabled_at) return null;
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(row.id);
  return toUser({ ...row, last_login_at: new Date().toISOString().slice(0, 19).replace("T", " ") });
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function createSession(userId: number, meta: { ip?: string; userAgent?: string } = {}): { token: string; id: number } {
  const token = randomBytes(32).toString("base64url");
  const id = (db.prepare("INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent) VALUES (?, ?, datetime('now', ?), ?, ?) RETURNING id")
    .get(userId, sha256(token), `+${SESSION_DAYS} days`, (meta.ip ?? "").slice(0, 64), (meta.userAgent ?? "").slice(0, 200)) as { id: number }).id;
  // A person has at most so many open sessions: the oldest go first.
  db.prepare(`DELETE FROM sessions WHERE user_id = ? AND id NOT IN (SELECT id FROM sessions WHERE user_id = ? ORDER BY id DESC LIMIT ?)`).run(userId, userId, MAX_SESSIONS_PER_USER);
  return { token, id };
}

/** Who a cookie value belongs to, or null (unknown, revoked, expired, or the user is disabled). */
export function sessionFromToken(token: string | undefined): { user: AccountUser; sessionId: number } | null {
  if (!token || token.length > 200) return null;
  const r = db.prepare(`SELECT s.id AS sid, u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > datetime('now') AND u.disabled_at IS NULL`).get(sha256(token)) as Record<string, any> | undefined;
  if (!r) return null;
  db.prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-5 minutes'))").run(r.sid);
  return { user: toUser(r), sessionId: r.sid };
}

export const revokeSessionToken = (token: string | undefined) => { if (token) db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE token_hash = ? AND revoked_at IS NULL").run(sha256(token)); };
/** Every session of a user, except one that is kept (the one making the change). */
export const revokeUserSessions = (userId: number, exceptId?: number) =>
  db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL AND id != ?").run(userId, exceptId ?? -1).changes;
/** After a backup is restored: sessions in it may be older than what was revoked since, so nobody stays signed in. */
export const revokeAllSessions = () => db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE revoked_at IS NULL").run().changes;

export function listSessions(userId: number, currentId?: number) {
  return (db.prepare("SELECT id, created_at, expires_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now') ORDER BY id DESC").all(userId) as Record<string, any>[])
    .map((s) => ({ id: s.id, createdAt: s.created_at, expiresAt: s.expires_at, lastSeenAt: s.last_seen_at, ip: s.ip, userAgent: s.user_agent, current: s.id === currentId }));
}
export function revokeSessionById(userId: number, sessionId: number) {
  const r = db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(sessionId, userId);
  if (!r.changes) throw new AccountError(404, "Session not found");
}

// ---------- Invitation and reset links ----------

export interface LinkInfo { id: number; kind: "invite" | "reset"; email: string; note: string; userId: number | null; createdBy: string; expiresAt: string; projectId: number | null; role: string | null }

/** An invitation may name a project and a role: whoever accepts it becomes a member of that project with that role. The caller has checked that the maker may grant it. */
export function createLink(input: { kind: "invite" | "reset"; createdBy: AccountUser; userId?: number; email?: string; note?: string; projectId?: number | null; role?: string | null }): { id: number; token: string; expiresAt: string } {
  const email = input.email ? normalizeEmail(input.email) : "";
  if (email && emailProblem(email)) throw new AccountError(400, emailProblem(email)!);
  if ((input.note ?? "").length > 200) throw new AccountError(400, "The note can be at most 200 characters");
  const token = randomBytes(32).toString("base64url");
  const row = db.prepare("INSERT INTO account_links (kind, token_hash, user_id, email, note, project_id, role, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?)) RETURNING id, expires_at")
    .get(input.kind, sha256(token), input.userId ?? null, email, input.note ?? "", input.projectId ?? null, input.projectId ? (input.role ?? "tester") : null, input.createdBy.id, `+${LINK_DAYS} days`) as { id: number; expires_at: string };
  return { id: row.id, token, expiresAt: row.expires_at };
}

/** What a link says, if it can still be used; null when it is unknown, used, revoked or expired. */
export function peekLink(token: string | undefined, kind: "invite" | "reset"): LinkInfo | null {
  if (!token || token.length > 200) return null;
  const r = db.prepare(`SELECT l.*, u.name AS creator FROM account_links l LEFT JOIN users u ON u.id = l.created_by
    WHERE l.token_hash = ? AND l.kind = ? AND l.used_at IS NULL AND l.revoked_at IS NULL AND l.expires_at > datetime('now')`).get(sha256(token), kind) as Record<string, any> | undefined;
  return r ? { id: r.id, kind: r.kind, email: r.email, note: r.note, userId: r.user_id, createdBy: r.creator ?? "", expiresAt: r.expires_at, projectId: r.project_id ?? null, role: r.role ?? null } : null;
}

const GONE = "This link has already been used, was revoked, or has expired. Ask for a new one.";
function consumeLink(token: string, kind: "invite" | "reset", usedBy: number | null): LinkInfo {
  const info = peekLink(token, kind);
  if (!info) throw new AccountError(410, GONE);
  const r = db.prepare("UPDATE account_links SET used_at = datetime('now'), used_by = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL").run(usedBy, info.id);
  if (!r.changes) throw new AccountError(410, GONE);
  return info;
}

/** A new password makes every reset link still open for that person pointless, and a risk: whoever holds one could undo it. */
export function revokeOpenResetLinks(userId: number): number {
  return db.prepare("UPDATE account_links SET revoked_at = datetime('now') WHERE kind = 'reset' AND user_id = ? AND used_at IS NULL AND revoked_at IS NULL").run(userId).changes;
}

export function listLinks(only?: { projectIds: number[] }) {
  const rows = db.prepare(`SELECT l.id, l.kind, l.email, l.note, l.created_at, l.expires_at, l.used_at, l.revoked_at, l.project_id, l.role, p.name AS project_name, p.key AS project_key, c.name AS creator, t.email AS target,
      CASE WHEN l.used_at IS NOT NULL THEN 'used' WHEN l.revoked_at IS NOT NULL THEN 'revoked' WHEN l.expires_at <= datetime('now') THEN 'expired' ELSE 'open' END AS status
    FROM account_links l LEFT JOIN users c ON c.id = l.created_by LEFT JOIN users t ON t.id = l.user_id LEFT JOIN projects p ON p.id = l.project_id ORDER BY l.id DESC LIMIT 500`).all() as Record<string, any>[];
  const scope = only ? new Set(only.projectIds) : null;
  return rows
    .filter((l) => !scope || (l.kind === "invite" && l.project_id !== null && scope.has(l.project_id)))
    .slice(0, 200)
    .map((l) => ({ id: l.id, kind: l.kind as "invite" | "reset", email: l.email || l.target || "", note: l.note, createdBy: l.creator ?? "", createdAt: l.created_at, expiresAt: l.expires_at, status: l.status as "open" | "used" | "revoked" | "expired",
      project: l.project_id !== null ? { id: l.project_id as number, name: l.project_name as string, key: l.project_key as string } : null, role: (l.role ?? null) as string | null }));
}
export function linkProjectId(id: number): number | null {
  return (db.prepare("SELECT project_id FROM account_links WHERE id = ? AND kind = 'invite'").get(id) as { project_id: number | null } | undefined)?.project_id ?? null;
}
export function revokeLink(id: number) {
  const r = db.prepare("UPDATE account_links SET revoked_at = datetime('now') WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL").run(id);
  if (!r.changes) throw new AccountError(404, "There is no open link with that id");
}

/** Someone with an invitation makes their own account. The link is used up in the same step, so a failure (an email already taken) leaves it usable. */
export function acceptInvite(token: string, input: { email: string; name: string; password: string }, ip = ""): AccountUser {
  return db.transaction(() => {
    const info = peekLink(token, "invite");
    if (!info) throw new AccountError(410, GONE);
    if (info.email && normalizeEmail(input.email) !== info.email) throw new AccountError(400, "This invitation is for another email address");
    const user = insertUser({ email: input.email, name: input.name, password: input.password });
    consumeLink(token, "invite", user.id);
    if (info.projectId && info.role) {
      // The project may have been deleted since the invitation was made: then the account is made and has no project (the cascade removed the link's project, not the link).
      db.prepare("INSERT OR IGNORE INTO project_members (project_id, user_id, role, added_by) SELECT p.id, ?, ?, l.created_by FROM projects p, account_links l WHERE p.id = ? AND l.id = ?").run(user.id, info.role, info.projectId, info.id);
      audit({ userId: user.id, label: user.name, ip }, "member.added", { targetUserId: user.id, projectId: info.projectId, detail: { role: info.role, via: "invitation" } });
    }
    audit({ userId: user.id, label: user.name, ip }, "account.created", { targetUserId: user.id, detail: { via: "invitation", invitedBy: info.createdBy } });
    audit({ userId: user.id, label: user.name, ip }, "invitation.used", { targetUserId: user.id, detail: { linkId: info.id } });
    return user;
  }).immediate();
}

/** A person with a reset link sets a new password. Every session of theirs ends, because whoever had the old password may have one. */
export function acceptReset(token: string, password: string, ip = ""): AccountUser {
  return db.transaction(() => {
    const info = peekLink(token, "reset");
    if (!info || !info.userId) throw new AccountError(410, GONE);
    const user = getUser(info.userId);
    if (!user || user.disabledAt) throw new AccountError(410, GONE);
    const problem = passwordProblem(password, { email: user.email, name: user.name });
    if (problem) throw new AccountError(400, problem);
    consumeLink(token, "reset", user.id);
    db.prepare("UPDATE users SET password_hash = ?, password_changed_at = datetime('now') WHERE id = ?").run(hashPassword(password), user.id);
    const ended = revokeUserSessions(user.id);
    const links = revokeOpenResetLinks(user.id);
    audit({ userId: user.id, label: user.name, ip }, "password.reset", { targetUserId: user.id, detail: { sessionsEnded: ended, otherResetLinksRevoked: links } });
    return user;
  }).immediate();
}

// ---------- A person's own account ----------

export function changePassword(user: AccountUser, current: unknown, next: unknown, keepSessionId: number | undefined, ip = "") {
  const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id) as { password_hash: string };
  if (typeof current !== "string" || !verifyPassword(current, row.password_hash)) throw new AccountError(400, "The current password is wrong");
  const problem = passwordProblem(next, { email: user.email, name: user.name });
  if (problem) throw new AccountError(400, problem);
  db.prepare("UPDATE users SET password_hash = ?, password_changed_at = datetime('now') WHERE id = ?").run(hashPassword(next as string), user.id);
  const ended = revokeUserSessions(user.id, keepSessionId);
  const links = revokeOpenResetLinks(user.id);
  audit(ctxOf(user, ip), "password.changed", { targetUserId: user.id, detail: { otherSessionsEnded: ended, resetLinksRevoked: links } });
}

/** The email address is what signs a person in and where a reset goes, so changing it takes the current password, like changing the password does. The name does not. */
export function updateProfile(user: AccountUser, patch: { name?: unknown; email?: unknown; currentPassword?: unknown }, ip = ""): AccountUser {
  const changed: string[] = [];
  let name = user.name, email = user.email;
  if (patch.name !== undefined) { const p = nameProblem(patch.name); if (p) throw new AccountError(400, p); name = (patch.name as string).trim(); if (name !== user.name) changed.push("name"); }
  if (patch.email !== undefined) { email = normalizeEmail(patch.email); const p = emailProblem(email); if (p) throw new AccountError(400, p); if (email !== user.email) changed.push("email"); }
  if (!changed.length) return user;
  if (changed.includes("email")) {
    const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id) as { password_hash: string };
    if (typeof patch.currentPassword !== "string" || !verifyPassword(patch.currentPassword, row.password_hash)) throw new AccountError(400, "Changing the email address takes your current password");
  }
  try {
    db.prepare("UPDATE users SET name = ?, email = ? WHERE id = ?").run(name, email, user.id);
  } catch (e) {
    if (e instanceof Error && /UNIQUE/.test(e.message)) throw new AccountError(409, "Another account already uses this email address");
    throw e;
  }
  audit(ctxOf(user, ip), "profile.changed", { targetUserId: user.id, detail: { fields: changed } });
  return getUser(user.id)!;
}

// ---------- The owner looks after the accounts ----------

/** Turns an account off or on. A disabled account cannot sign in and its sessions end at once; it is never deleted, so what it did stays attributed. */
export function setDisabled(actor: AccountUser, targetId: number, disabled: boolean, ip = ""): AccountUser {
  const target = getUser(targetId);
  if (!target) throw new AccountError(404, "Account not found");
  if (disabled) {
    if (target.id === actor.id) throw new AccountError(409, "You cannot turn off your own account");
    const owners = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_owner = 1 AND disabled_at IS NULL").get() as { n: number }).n;
    if (target.isOwner && owners <= 1) throw new AccountError(409, "The last owner cannot be turned off");
  }
  if (!!target.disabledAt === disabled) return target;
  db.prepare(`UPDATE users SET disabled_at = ${disabled ? "datetime('now')" : "NULL"} WHERE id = ?`).run(target.id);
  const ended = disabled ? revokeUserSessions(target.id) : 0;
  audit(ctxOf(actor, ip), disabled ? "account.disabled" : "account.enabled", { targetUserId: target.id, detail: { sessionsEnded: ended } });
  return getUser(target.id)!;
}

/** Sets a password from the server's command line (the way back when nobody can sign in). Every session of that user ends. */
export function resetPasswordFromCli(email: string, password: string): AccountUser {
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email)) as Record<string, any> | undefined;
  if (!row) throw new AccountError(404, "There is no account with that email address");
  const user = toUser(row);
  const problem = passwordProblem(password, { email: user.email, name: user.name });
  if (problem) throw new AccountError(400, problem);
  db.prepare("UPDATE users SET password_hash = ?, password_changed_at = datetime('now') WHERE id = ?").run(hashPassword(password), user.id);
  const ended = revokeUserSessions(user.id);
  const links = revokeOpenResetLinks(user.id);
  audit({ userId: null, label: "cli" }, "password.reset", { targetUserId: user.id, detail: { via: "command line", sessionsEnded: ended, resetLinksRevoked: links } });
  return user;
}
