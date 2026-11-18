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
  "agent_request.cancelled", "agent_request.claimed", "agent_request.completed", "agent_request.created", "agent_request.finding_created", "agent_request.released", "agent_request.result_delivered", "agent_request.results_reported", "spec.created", "spec.deleted", "spec.edited", "spec.renamed", "account.created", "account.disabled", "account.enabled", "account.setup", "invitation.created", "invitation.revoked", "invitation.used", "login.failed", "login.succeeded",
  "member.added", "member.removed", "member.role_changed", "members.migrated", "password.changed", "password.reset", "password.reset_link_created", "profile.changed", "requirements.bulk_approved", "sessions.revoked_others",
  "settings.agent_proposals_changed", "settings.agent_results_changed",
  "token.created", "token.revoked",
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
  { label: "Requirements", prefix: "requirements." },
  { label: "Agent requests", prefix: "agent_request." },
  { label: "Specs", prefix: "spec." },
  { label: "Settings", prefix: "settings." },
  { label: "Tokens", prefix: "token." },
];

/** How to turn the ids in an entry into names. A name that is not known (an account or a project that no longer exists) is said as such, never left as a bare number. */
export interface NameLookup { user: (id: number | null) => string | undefined; project: (id: number | null) => string | undefined }
const plural = (n: unknown, one: string, many = one + "s") => `${Number(n) || 0} ${Number(n) === 1 ? one : many}`;

/** One line of plain words for an entry. */
/** A spec file name from an audit entry, as text only (it was checked when it was made, and is shown as it is). */
const specName = (v: unknown) => (typeof v === "string" && v ? v : "a spec");

/** What the kinds of machine token are called. A kind this page does not know is just "token". The name is what a person typed, shown as text; the prefix is the first characters the token list shows too. */
const TOKEN_KIND: Record<string, string> = { request: "request token", agent_read: "agent read token", propose: "agent proposal token", ci: "CI token" };
const tokenWords = (d: Record<string, unknown>) =>
  `${typeof d.kind === "string" ? (TOKEN_KIND[d.kind] ?? "token") : "token"}${typeof d.name === "string" && d.name ? ` "${d.name}"` : ""}${typeof d.prefix === "string" && d.prefix ? ` (${d.prefix}…)` : ""}`;

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
    case "agent_request.created": return `${who} asked an agent to ${d.kind === "rerun" ? "run failed automated tests again" : d.kind === "run" ? `run ${plural(d.cases ?? 0, "test case")}` : "look at a target"} in ${project}`;
    case "agent_request.cancelled": return `${who} cancelled a request to an agent in ${project}`;
    case "agent_request.claimed": return `${who} took a request in ${project}`;
    case "agent_request.released": return `${who} gave a request back in ${project}`;
    case "agent_request.result_delivered": {
      if (d.kind !== "run") return `${who} handed in the report of a re-run in ${project}`;
      const tests = Number(d.tests) || 0;
      const parts = (["passed", "failed", "skipped"] as const).map((s) => [Number(d[s]) || 0, s] as const).filter(([c]) => c > 0).map(([c, s]) => `${c} ${s}`);
      return `${who} handed in an automated test report for a run request (${tests} ${tests === 1 ? "test" : "tests"}${parts.length ? `: ${parts.join(", ")}` : ""}) in ${project}`;
    }
    case "agent_request.results_reported": {
      const n = Number(d.reported) || 0;
      const parts = (["passed", "failed", "blocked", "skipped"] as const).map((s) => [Number(d[s]) || 0, s] as const).filter(([c]) => c > 0).map(([c, s]) => `${c} ${s}`);
      return `${who} reported results for ${n} test ${n === 1 ? "case" : "cases"}${parts.length ? ` (${parts.join(", ")})` : ""} in ${project}`;
    }
    case "agent_request.completed": return `${who} finished a request in ${project}`;
    case "agent_request.finding_created": return `${who} reported ${({ test_case: "a test case (a draft)", bug_report: "a bug report (a proposal)", observation: "an observation", manual_test_suggestion: "a manual test suggestion (a proposal)" } as Record<string, string>)[String(d.finding_kind)] ?? "a finding"} for a discover request in ${project}`;
    case "spec.created": return `${who} added the spec ${specName(d.fileName)} in ${project}`;
    case "spec.edited": return `${who} changed the ${Array.isArray(d.changed) && d.changed.length ? d.changed.join(", ") : "text"} of the spec ${specName(d.fileName)} in ${project}`;
    case "spec.renamed": return `${who} renamed the spec ${specName(d.from)} to ${specName(d.to)} in ${project}`;
    case "spec.deleted": return `${who} deleted the spec ${specName(d.fileName)} in ${project}`;
    case "requirements.bulk_approved": return `${who} approved ${plural(d.count, "imported requirement")} in ${project}`;
    case "sessions.revoked_others": return `${who} signed out of ${plural(d.sessionsEnded, "other session")}`;
    case "settings.agent_results_changed": return `${who} switched agent results ${d.to ? "on" : "off"}`;
    case "settings.agent_proposals_changed": return `${who} switched agent proposals ${d.to ? "on" : "off"}`;
    case "token.created": return `${who} made the ${tokenWords(d)} in ${project}`;
    case "token.revoked": return `${who} revoked the ${tokenWords(d)} in ${project}`;
    default: return `${who}: ${e.action}`;
  }
}
