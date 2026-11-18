import { db } from "./db.ts";
import { AuditError } from "./auditcommon.ts";

/**
 * What the four kinds of machine token (a read token tbag_, a proposal token tbpr_, a CI token tbci_ and a request token tbrq_) have in common, so that it is written once: which table
 * holds a kind, who made a token, and how a token is revoked. Each kind keeps its own module for making, listing and authenticating (agenttokens.ts, proposetokens.ts, ci.ts, requesttokens.ts).
 */

/** The names the audit log uses for the kinds. */
export const TOKEN_TABLES = { request: "request_tokens", agent_read: "agent_tokens", propose: "propose_tokens", ci: "ci_tokens" } as const;
export type TokenKind = keyof typeof TOKEN_TABLES;

/** Who makes a token: the name as it is now, and the account when there is one (null when nobody has signed in). */
export type TokenMaker = { name: string; userId: number | null };

/** A token as the audit log describes it: which one, in which project, and the same name and prefix the list shows. Never the token and never its hash. */
export type TokenInfo = { id: number; projectId: number; name: string; prefix: string };

/**
 * Revokes a token. `changed` is false when it was revoked already: the call is harmless, and the caller leaves no second entry in the audit log. An unknown id is a 404.
 * The table name comes from TOKEN_TABLES only, never from the request.
 */
export function revokeToken(kind: TokenKind, id: number): TokenInfo & { changed: boolean } {
  const table = TOKEN_TABLES[kind];
  const t = db.prepare(`SELECT id, project_id, name, prefix, revoked_at FROM ${table} WHERE id = ?`).get(id) as
    { id: number; project_id: number; name: string; prefix: string; revoked_at: string | null } | undefined;
  if (!t) throw new AuditError(404, "Token not found");
  db.prepare(`UPDATE ${table} SET revoked_at = COALESCE(revoked_at, datetime('now')) WHERE id = ?`).run(id);
  return { id: t.id, projectId: t.project_id, name: t.name, prefix: t.prefix, changed: t.revoked_at === null };
}
