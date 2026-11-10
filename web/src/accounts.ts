/**
 * Small helpers for the account screens (/account and, later, /admin): plain functions with no React, so they can be tested on their own.
 * The server decides in the end. What is here only helps a person on the way: a readable name for a device, and the password rules told before the form is sent.
 */

/** "Chrome on macOS", read out of a browser's user-agent text. Anything not recognised is said plainly, never guessed at. */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").trim();
  if (!ua) return "Unknown device";
  const tool = /^(curl|wget|node|python-requests|okhttp)\b/i.exec(ua);
  if (tool) return tool[1].toLowerCase() === "node" ? "Node.js" : tool[1].toLowerCase();
  const browser =
    /\bEdg(?:e|A|iOS)?\//.test(ua) ? "Edge"
    : /\bOPR\//.test(ua) ? "Opera"
    : /\b(?:Chrome|CriOS)\//.test(ua) ? "Chrome"
    : /\b(?:Firefox|FxiOS)\//.test(ua) ? "Firefox"
    : /\bSafari\//.test(ua) ? "Safari"
    : null;
  const system =
    /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /CrOS/.test(ua) ? "ChromeOS"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /Linux|X11/.test(ua) ? "Linux"
    : null;
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? "Unknown device";
}

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 1024;

/** The rules, as a list a person can read before typing. They are the server's rules (test/web-accounts.test.ts keeps the two from drifting apart). */
export const PASSWORD_RULES = [
  `At least ${PASSWORD_MIN} characters`,
  "Not only spaces, and more than two different characters",
  "Not your email address or your name",
] as const;

/** The first rule a new password breaks, in the server's words, or null. Only a hint: the server checks again. */
export function passwordProblem(password: string, who: { email?: string; name?: string } = {}): string | null {
  if (password.length < PASSWORD_MIN) return `The password must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `The password can be at most ${PASSWORD_MAX} characters`;
  if (!password.trim()) return "The password cannot be only spaces";
  if (new Set(password).size < 3) return "The password is too simple: use more than two different characters";
  const lower = password.toLowerCase();
  if ((who.email && lower === who.email.toLowerCase()) || (who.name && lower === who.name.trim().toLowerCase())) return "The password cannot be your email or your name";
  return null;
}

/** What the form needs to know before it sends: the problem to show, or null when it can go. */
export function passwordFormProblem(f: { current: string; next: string; again: string }, who: { email?: string; name?: string }): string | null {
  if (!f.current) return "Type your current password";
  if (f.next !== f.again) return "The two new passwords are not the same";
  if (f.next === f.current) return "The new password is the same as the current one";
  return passwordProblem(f.next, who);
}

// ---------- The audit log, in words ----------

/** One entry of the audit log, as the server sends it. */
export interface AuditEntry {
  id: number; at: string; actorUserId: number | null; actor: string; action: string;
  targetUserId: number | null; projectId: number | null; ip: string; detail: Record<string, unknown>;
}

/** Every action the server writes to the audit log (test/web-accounts.test.ts checks this list against the server's source, so a new action cannot be left without words). */
export const AUDIT_ACTIONS = [
  "account.created", "account.disabled", "account.enabled", "account.setup", "invitation.created", "invitation.revoked", "invitation.used", "login.failed", "login.succeeded",
  "member.added", "member.removed", "member.role_changed", "members.migrated", "password.changed", "password.reset", "password.reset_link_created", "profile.changed", "sessions.revoked_others",
] as const;

/** The filter choices on the audit log page: a label, and the start of the action it keeps (what `?action=` takes). */
export const AUDIT_FILTERS: readonly { label: string; prefix: string }[] = [
  { label: "Everything", prefix: "" },
  { label: "Sign-ins", prefix: "login." },
  { label: "Accounts", prefix: "account." },
  { label: "Passwords", prefix: "password." },
  { label: "Profiles", prefix: "profile." },
  { label: "Sessions", prefix: "sessions." },
  { label: "Invitations", prefix: "invitation." },
  { label: "Members and roles", prefix: "member" },
];

/** How to turn the ids in an entry into names. A name that is not known (an account or a project that no longer exists) is said as such, never left as a bare number. */
export interface NameLookup { user: (id: number | null) => string | undefined; project: (id: number | null) => string | undefined }
const plural = (n: unknown, one: string, many = one + "s") => `${Number(n) || 0} ${Number(n) === 1 ? one : many}`;

/** One line of plain words for an entry. */
export function describeAudit(e: Pick<AuditEntry, "action" | "actor" | "targetUserId" | "projectId" | "detail">, names: NameLookup): string {
  const d = e.detail ?? {};
  const who = e.actor || "Someone";
  const target = names.user(e.targetUserId) ?? (e.targetUserId === null ? "an account" : "an account that no longer exists");
  const project = names.project(e.projectId) ?? (e.projectId === null ? "a project" : "a project that no longer exists");
  switch (e.action) {
    case "account.setup": return `${who} made the first account, the owner`;
    case "account.created": return `${who} made an account${d.via === "invitation" ? ` with an invitation from ${String(d.invitedBy ?? "someone")}` : ""}`;
    case "account.disabled": return `${who} switched off ${target}'s account${d.sessionsEnded ? `, which ended ${plural(d.sessionsEnded, "session")}` : ""}`;
    case "account.enabled": return `${who} switched on ${target}'s account`;
    case "invitation.created": return `${who} made an invitation link${d.email ? ` for ${String(d.email)}` : ""}${e.projectId !== null ? ` to ${project}${d.role ? ` as ${String(d.role)}` : ""}` : ", for an account with no project"}`;
    case "invitation.used": return `${who} joined with an invitation`;
    case "invitation.revoked": return `${who} revoked an invitation${e.projectId !== null ? ` to ${project}` : ""}`;
    case "login.succeeded": return `${who} signed in`;
    case "login.failed": return "A sign-in failed (a wrong email address or password; what was typed is not kept)";
    case "member.added": return `${who} added ${target} to ${project} as ${String(d.role ?? "a member")}${d.via === "invitation" ? " (with an invitation)" : ""}`;
    case "member.removed": return `${who} removed ${target} from ${project}`;
    case "member.role_changed": return `${who} changed ${target}'s role in ${project} from ${String(d.from ?? "?")} to ${String(d.to ?? "?")}`;
    case "members.migrated": return `When roles were introduced, existing accounts became ${String(d.role ?? "testers")} in ${plural(d.memberships, "project membership")}`;
    case "password.changed": return `${who} changed their password${d.otherSessionsEnded ? `, which signed out ${plural(d.otherSessionsEnded, "other session")}` : ""}`;
    case "password.reset": return `${target} set a new password${d.via === "command line" ? " (set on the server)" : " with a reset link"}${d.sessionsEnded ? `, which ended ${plural(d.sessionsEnded, "session")}` : ""}`;
    case "password.reset_link_created": return `${who} made a password reset link for ${target}`;
    case "profile.changed": return `${who} changed their ${Array.isArray(d.fields) && d.fields.length ? d.fields.join(" and ") : "profile"}`;
    case "sessions.revoked_others": return `${who} signed out of ${plural(d.sessionsEnded, "other session")}`;
    default: return `${who}: ${e.action}`;
  }
}
