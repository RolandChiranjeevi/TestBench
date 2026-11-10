import { createHash, randomBytes } from "node:crypto";
import { db, getSetting, setSetting } from "./db.ts";
import { AuditError } from "./auditcommon.ts";

/**
 * Tokens that let a test agent make requirement proposals, and nothing else.
 *
 *  - Off until a person switches it on (`agent_proposals_enabled`), per installation. While it is off no token can be made and the route refuses every call.
 *  - A separate table (propose_tokens) and prefix (tbpr_) from the read token (tbag_) and the CI token (tbci_). Each kind is refused by the prefix before any
 *    lookup, so none can stand in for another.
 *  - Only a hash is stored. The token is returned once, when it is made, and never again (the list holds the prefix and dates only).
 *  - A proposal token opens one route, POST of proposals. It cannot read requirements, edit one, approve or reject: those routes refuse any agent credential.
 *  - Roles do not exist yet: whoever is signed in can switch this on and make or revoke tokens.
 */

export const PROPOSE_TOKEN_PREFIX = "tbpr_";
export const PROPOSE_LIMITS = { tokensPerProject: 3, nameMax: 80, tokenMax: 200 };
const ENABLED_KEY = "agent_proposals_enabled";

export const agentProposalsEnabled = () => getSetting(ENABLED_KEY) === "1";
export const setAgentProposalsEnabled = (on: boolean) => setSetting(ENABLED_KEY, on ? "1" : "0");

/** The one route a proposal token opens. Like the CI route it skips the login cookie and the X-Testbench header, because its handler requires the token on every call. */
export const isAgentPropose = (method: string, url: string) => method === "POST" && /^\/api\/agent\/projects\/\d+\/requirement-proposals\/?(\?.*)?$/.test(url);

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Which kind of agent credential an Authorization header carries, judged by its prefix alone, or null. */
export function agentCredentialKind(header: string | undefined): "read" | "propose" | "ci" | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!m) return null;
  if (m[1].startsWith("tbag_")) return "read";
  if (m[1].startsWith(PROPOSE_TOKEN_PREFIX)) return "propose";
  if (m[1].startsWith("tbci_")) return "ci";
  return null;
}

export function createProposeToken(projectId: number, name: string) {
  const n = name.trim();
  if (!agentProposalsEnabled()) throw new AuditError(409, "Agent proposals are switched off. Switch them on first.");
  if (!n || n.length > PROPOSE_LIMITS.nameMax) throw new AuditError(400, `Give the token a name of at most ${PROPOSE_LIMITS.nameMax} characters`);
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new AuditError(404, "Project not found");
  const live = (db.prepare("SELECT COUNT(*) AS n FROM propose_tokens WHERE project_id = ? AND revoked_at IS NULL").get(projectId) as { n: number }).n;
  if (live >= PROPOSE_LIMITS.tokensPerProject) throw new AuditError(409, `A project can have ${PROPOSE_LIMITS.tokensPerProject} active proposal tokens. Revoke one first.`);
  const token = `${PROPOSE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const row = db.prepare("INSERT INTO propose_tokens (project_id, name, prefix, token_hash) VALUES (?, ?, ?, ?) RETURNING id, created_at")
    .get(projectId, n, token.slice(0, 9), sha256(token)) as { id: number; created_at: string };
  // The token is returned this once. Only its hash is stored.
  return { id: row.id, name: n, prefix: token.slice(0, 9), createdAt: row.created_at, token };
}

export function listProposeTokens(projectId: number) {
  return (db.prepare("SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM propose_tokens WHERE project_id = ? ORDER BY id DESC").all(projectId) as Record<string, any>[])
    .map((t) => ({ id: t.id, name: t.name, prefix: t.prefix, createdAt: t.created_at, lastUsedAt: t.last_used_at, revokedAt: t.revoked_at }));
}

export function revokeProposeToken(id: number) {
  const r = db.prepare("UPDATE propose_tokens SET revoked_at = COALESCE(revoked_at, datetime('now')) WHERE id = ?").run(id);
  if (!r.changes) throw new AuditError(404, "Token not found");
}

export type ProposeAuth = { state: "ok"; name: string } | { state: "invalid" | "other_project" | "off" };

/** What an Authorization header says about a request for this project. `off`: proposals are switched off (checked before the token is looked up). */
export function authenticateProposeToken(header: string | undefined, projectId: number): ProposeAuth {
  if (!agentProposalsEnabled()) return { state: "off" };
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!m) return { state: "invalid" };
  const token = m[1];
  if (!token.startsWith(PROPOSE_TOKEN_PREFIX) || token.length > PROPOSE_LIMITS.tokenMax || !/^[A-Za-z0-9_-]+$/.test(token)) return { state: "invalid" };
  const row = db.prepare("SELECT id, project_id, name FROM propose_tokens WHERE token_hash = ? AND revoked_at IS NULL").get(sha256(token)) as { id: number; project_id: number; name: string } | undefined;
  if (!row) return { state: "invalid" };
  if (row.project_id !== projectId) return { state: "other_project" };
  db.prepare("UPDATE propose_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  return { state: "ok", name: row.name };
}
