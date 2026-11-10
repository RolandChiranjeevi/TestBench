import { getSetting, setSetting } from "./db.ts";
import { AuditError } from "./auditcommon.ts";
import { currentUser } from "./accountcontext.ts";

/**
 * Who made a change. With accounts on it is the name of the account that is signed in. That ties the entry to an account, not to a verified person: the name was
 * chosen by whoever made the account, the email address is not checked, and one account can be shared. Without accounts (one shared password at most) it is the display
 * name a person entered in Settings, kept as typed: anyone who can use the installation can type any name.
 * It is recorded on requirements (created_by, approved_by) and in their change log.
 */
export const DISPLAY_NAME_KEY = "display_name";
export const UNNAMED = "unnamed user";
export const NAME_MAX = 80;

export const getDisplayName = (): string => getSetting(DISPLAY_NAME_KEY) ?? "";

/** An empty name clears it. */
export function setDisplayName(name: unknown): string {
  if (typeof name !== "string") throw new AuditError(400, "name must be text");
  const n = name.trim();
  if (n.length > NAME_MAX) throw new AuditError(400, `The name can be at most ${NAME_MAX} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(n)) throw new AuditError(400, "The name cannot contain control characters");
  setSetting(DISPLAY_NAME_KEY, n);
  return n;
}

/** The name to record for a change a person makes now. Never empty, so "approved by" always says something. */
export const actorName = (): string => currentUser()?.name || getDisplayName() || UNNAMED;
/** The account behind actorName(), written next to the name (created_by_user_id and the like) so that "who" can be traced to an account and not only to a name. Null without accounts. */
export const actorUserId = (): number | null => currentUser()?.id ?? null;
