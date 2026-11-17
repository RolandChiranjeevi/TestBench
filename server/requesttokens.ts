import { createHash, randomBytes } from "node:crypto";
import { db } from "./db.ts";
import { AuditError } from "./auditcommon.ts";

/**
 * Tokens for a test agent to work through the requests people make of it (server/agentrequests.ts): fetch the waiting ones, take one, give it back, hand in a re-run's report, say it is done.
 *
 *  - A fourth kind (tbrq_), apart from the read token (tbag_), the proposal token (tbpr_) and the CI token (tbci_), in its own table. Each kind is refused by its
 *    prefix before any lookup, so none can stand in for another.
 *  - Only a hash is stored. The token is returned once, when it is made, and never again (the list holds the prefix and dates only).
 *  - It opens five routes of one project and nothing else (below). It cannot make or cancel a request, read requirements, or decide anything. Taking, releasing or finishing a
 *    request only changes that request's status (and a release adds a note, and a finished discover the audit it made). The one route that writes test results (`result`) is off until a person switches it on, takes only the report of the
 *    request this very token took, only once, and only for tests that request named (see submitResult in server/agentrequests.ts). Every other route refuses any agent credential (see the guard in server/index.ts).
 *  - Made and revoked by an admin of the project, like the other tokens.
 */

export const REQUEST_TOKEN_PREFIX = "tbrq_";
export const REQUEST_TOKEN_LIMITS = { tokensPerProject: 3, nameMax: 80, tokenMax: 200 };

/** The six routes a request token opens: the waiting requests, taking one, giving one back (release), handing in the report of a re-run, finishing it, and (for a discover only) reporting a finding (server/agentfindings.ts). Like the other token routes they skip the login cookie and the X-Testbench header, because each handler requires the token on every call. */
export const isAgentRequestRoute = (method: string, url: string) =>
  (method === "GET" && /^\/api\/agent\/projects\/\d+\/requests\/?(\?.*)?$/.test(url)) ||
  (method === "POST" && /^\/api\/agent\/projects\/\d+\/requests\/\d+\/(claim|release|complete|result|findings)\/?(\?.*)?$/.test(url));

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function createRequestToken(projectId: number, name: string) {
  const n = name.trim();
  if (!n || n.length > REQUEST_TOKEN_LIMITS.nameMax) throw new AuditError(400, `Give the token a name of at most ${REQUEST_TOKEN_LIMITS.nameMax} characters`);
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new AuditError(404, "Project not found");
  const live = (db.prepare("SELECT COUNT(*) AS n FROM request_tokens WHERE project_id = ? AND revoked_at IS NULL").get(projectId) as { n: number }).n;
  if (live >= REQUEST_TOKEN_LIMITS.tokensPerProject) throw new AuditError(409, `A project can have ${REQUEST_TOKEN_LIMITS.tokensPerProject} active request tokens. Revoke one first.`);
  const token = `${REQUEST_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const row = db.prepare("INSERT INTO request_tokens (project_id, name, prefix, token_hash) VALUES (?, ?, ?, ?) RETURNING id, created_at")
    .get(projectId, n, token.slice(0, 9), sha256(token)) as { id: number; created_at: string };
  // The token is returned this once. Only its hash is stored.
  return { id: row.id, name: n, prefix: token.slice(0, 9), createdAt: row.created_at, token };
}

export function listRequestTokens(projectId: number) {
  return (db.prepare("SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM request_tokens WHERE project_id = ? ORDER BY id DESC").all(projectId) as Record<string, any>[])
    .map((t) => ({ id: t.id, name: t.name, prefix: t.prefix, createdAt: t.created_at, lastUsedAt: t.last_used_at, revokedAt: t.revoked_at }));
}

export function revokeRequestToken(id: number) {
  const r = db.prepare("UPDATE request_tokens SET revoked_at = COALESCE(revoked_at, datetime('now')) WHERE id = ?").run(id);
  if (!r.changes) throw new AuditError(404, "Token not found");
}

export type RequestAuth = { state: "ok"; id: number; name: string } | { state: "invalid" | "other_project" };

/** What an Authorization header says about a request for this project. The prefix is checked first, so any other credential never reaches the database. */
export function authenticateRequestToken(header: string | undefined, projectId: number): RequestAuth {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!m) return { state: "invalid" };
  const token = m[1];
  if (!token.startsWith(REQUEST_TOKEN_PREFIX) || token.length > REQUEST_TOKEN_LIMITS.tokenMax || !/^[A-Za-z0-9_-]+$/.test(token)) return { state: "invalid" };
  const row = db.prepare("SELECT id, project_id, name FROM request_tokens WHERE token_hash = ? AND revoked_at IS NULL").get(sha256(token)) as { id: number; project_id: number; name: string } | undefined;
  if (!row) return { state: "invalid" };
  if (row.project_id !== projectId) return { state: "other_project" };
  db.prepare("UPDATE request_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  return { state: "ok", id: row.id, name: row.name };
}
