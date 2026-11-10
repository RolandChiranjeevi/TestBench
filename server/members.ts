import { db } from "./db.ts";
import type { AccountUser } from "./accountcontext.ts";
import { LEVELS, levelRank, type Level } from "./access.ts";
import { AccountError, audit, ctxOf, getUser, normalizeEmail } from "./accounts.ts";

/** The role a person has in a project, or null. The owner of the installation is an admin of every project. Asked on every request: a change takes effect at once. */
export function roleOf(user: Pick<AccountUser, "id" | "isOwner">, projectId: number): Level | null {
  if (user.isOwner) return "admin";
  const row = db.prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?").get(projectId, user.id) as { role: Level } | undefined;
  return row?.role ?? null;
}
export const allows = (role: Level | null, needed: Level) => role !== null && levelRank(role) >= levelRank(needed);

/** The ids of the projects a person is a member of (all of them for the owner). */
export function projectIdsOf(user: Pick<AccountUser, "id" | "isOwner">): number[] {
  const rows = user.isOwner
    ? (db.prepare("SELECT id FROM projects").all() as { id: number }[]).map((r) => r.id)
    : (db.prepare("SELECT project_id AS id FROM project_members WHERE user_id = ?").all(user.id) as { id: number }[]).map((r) => r.id);
  return rows;
}

// ---------- Looking after the members of a project (the routes check that the caller is an admin of it, or the owner) ----------

export interface Member { userId: number; name: string; email: string; role: Level; addedAt: string; disabled: boolean }

export function roleProblem(role: unknown): Level {
  if (typeof role !== "string" || !(LEVELS as readonly string[]).includes(role)) throw new AccountError(400, "The role must be admin, tester or viewer");
  return role as Level;
}

export function listMembers(projectId: number): Member[] {
  return (db.prepare(`SELECT u.id, u.name, u.email, u.disabled_at, m.role, m.added_at FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ?
    ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'tester' THEN 1 ELSE 2 END, u.name`).all(projectId) as Record<string, any>[])
    .map((r) => ({ userId: r.id, name: r.name, email: r.email, role: r.role, addedAt: r.added_at, disabled: !!r.disabled_at }));
}

const adminCount = (projectId: number) => (db.prepare("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND role = 'admin'").get(projectId) as { n: number }).n;
/** The last admin among the members cannot be removed or lowered by an admin (it would lock the project's admins out); the owner can, since the owner is an admin everywhere. */
function keepAnAdmin(actor: AccountUser, projectId: number, target: number) {
  if (actor.isOwner) return;
  const targetIsAdmin = (db.prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?").get(projectId, target) as { role: Level } | undefined)?.role === "admin";
  if (targetIsAdmin && adminCount(projectId) <= 1) throw new AccountError(409, "A project needs at least one admin. Make someone else an admin first (the owner can always do this).");
}

/** Adds an existing account by email. The answer says whether the address has an account (an admin may learn that: accepted). */
export function addMember(actor: AccountUser, projectId: number, email: unknown, role: unknown, ip = ""): Member {
  const level = roleProblem(role);
  const user = db.transaction(() => {
    const row = db.prepare("SELECT id FROM users WHERE email = ?").get(normalizeEmail(email)) as { id: number } | undefined;
    const u = row ? getUser(row.id) : null;
    if (!u) throw new AccountError(404, "There is no account with that email address. Invite the person with a link instead.");
    if (u.isOwner) throw new AccountError(400, "The owner is an admin of every project already");
    if (u.disabledAt) throw new AccountError(409, "That account is switched off");
    if (db.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?").get(projectId, u.id)) throw new AccountError(409, "That account is a member already. Change its role instead.");
    db.prepare("INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (?, ?, ?, ?)").run(projectId, u.id, level, actor.id);
    audit(ctxOf(actor, ip), "member.added", { targetUserId: u.id, projectId, detail: { role: level } });
    return u;
  }).immediate();
  return listMembers(projectId).find((m) => m.userId === user.id)!;
}

export function setMemberRole(actor: AccountUser, projectId: number, userId: number, role: unknown, ip = ""): Member {
  const level = roleProblem(role);
  db.transaction(() => {
    const cur = db.prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?").get(projectId, userId) as { role: Level } | undefined;
    if (!cur) throw new AccountError(404, "That account is not a member of this project");
    if (cur.role === level) return;
    if (level !== "admin") keepAnAdmin(actor, projectId, userId);
    db.prepare("UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?").run(level, projectId, userId);
    audit(ctxOf(actor, ip), "member.role_changed", { targetUserId: userId, projectId, detail: { from: cur.role, to: level } });
  }).immediate();
  return listMembers(projectId).find((m) => m.userId === userId)!;
}

export function removeMember(actor: AccountUser, projectId: number, userId: number, ip = ""): void {
  db.transaction(() => {
    const cur = db.prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?").get(projectId, userId) as { role: Level } | undefined;
    if (!cur) throw new AccountError(404, "That account is not a member of this project");
    keepAnAdmin(actor, projectId, userId);
    db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(projectId, userId);
    audit(ctxOf(actor, ip), "member.removed", { targetUserId: userId, projectId, detail: { role: cur.role } });
  }).immediate();
}

/** The projects a person is an admin of (all of them for the owner). */
export const adminProjectIds = (user: Pick<AccountUser, "id" | "isOwner">): number[] =>
  user.isOwner ? projectIdsOf(user) : (db.prepare("SELECT project_id AS id FROM project_members WHERE user_id = ? AND role = 'admin'").all(user.id) as { id: number }[]).map((r) => r.id);
