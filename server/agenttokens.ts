import { createHash, randomBytes } from "node:crypto";
import { db } from "./db.ts";
import { AuditError } from "./auditcommon.ts";

/**
 * Tokens for a test agent. They are made to read the active requirements of one project and nothing else.
 *
 *  - A separate table (agent_tokens) and a separate prefix (tbag_) from the CI tokens. A CI token (tbci_) is refused before any lookup, and an agent
 *    token is never looked up in ci_tokens, so neither kind can stand in for the other.
 *  - Only a hash is stored. The token is returned once, when it is made, and never again (the list holds the prefix and dates only).
 *  - A token works for GET on one route, the one below. Every other route asks for the login as before.
 *  - Roles do not exist in Testbench: whoever is signed in can make and revoke agent tokens.
 */

export const AGENT_TOKEN_PREFIX = "tbag_";
export const AGENT_LIMITS = { tokensPerProject: 5, nameMax: 80, tokenMax: 200 };

/** The one route an agent token opens. Like the CI route it skips the login cookie, because its handler requires the token on every call. */
export const isAgentRead = (method: string, url: string) => method === "GET" && /^\/api\/agent\/projects\/\d+\/requirements\/?(\?.*)?$/.test(url);

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function createAgentToken(projectId: number, name: string) {
  const n = name.trim();
  if (!n || n.length > AGENT_LIMITS.nameMax) throw new AuditError(400, `Give the token a name of at most ${AGENT_LIMITS.nameMax} characters`);
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new AuditError(404, "Project not found");
  const live = (db.prepare("SELECT COUNT(*) AS n FROM agent_tokens WHERE project_id = ? AND revoked_at IS NULL").get(projectId) as { n: number }).n;
  if (live >= AGENT_LIMITS.tokensPerProject) throw new AuditError(409, `A project can have ${AGENT_LIMITS.tokensPerProject} active agent tokens. Revoke one first.`);
  const token = `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const row = db.prepare("INSERT INTO agent_tokens (project_id, name, prefix, token_hash) VALUES (?, ?, ?, ?) RETURNING id, created_at")
    .get(projectId, n, token.slice(0, 9), sha256(token)) as { id: number; created_at: string };
  // The token is returned this once. Only its hash is stored.
  return { id: row.id, name: n, prefix: token.slice(0, 9), createdAt: row.created_at, token };
}

export function listAgentTokens(projectId: number) {
  return (db.prepare("SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM agent_tokens WHERE project_id = ? ORDER BY id DESC").all(projectId) as Record<string, any>[])
    .map((t) => ({ id: t.id, name: t.name, prefix: t.prefix, createdAt: t.created_at, lastUsedAt: t.last_used_at, revokedAt: t.revoked_at }));
}

export function revokeAgentToken(id: number) {
  const r = db.prepare("UPDATE agent_tokens SET revoked_at = COALESCE(revoked_at, datetime('now')) WHERE id = ?").run(id);
  if (!r.changes) throw new AuditError(404, "Token not found");
}

export type AgentAuth = "ok" | "invalid" | "other_project";

/**
 * What an Authorization header says about a request for this project. `invalid`: missing, malformed, not an agent token, unknown or revoked.
 * `other_project`: a live agent token, but it belongs to another project. The prefix is checked first, so anything else (a CI token, a login) never reaches the database.
 */
export function authenticateAgentToken(header: string | undefined, projectId: number): AgentAuth {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!m) return "invalid";
  const token = m[1];
  if (!token.startsWith(AGENT_TOKEN_PREFIX) || token.length > AGENT_LIMITS.tokenMax || !/^[A-Za-z0-9_-]+$/.test(token)) return "invalid";
  const row = db.prepare("SELECT id, project_id FROM agent_tokens WHERE token_hash = ? AND revoked_at IS NULL").get(sha256(token)) as { id: number; project_id: number } | undefined;
  if (!row) return "invalid";
  if (row.project_id !== projectId) return "other_project";
  db.prepare("UPDATE agent_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  return "ok";
}
