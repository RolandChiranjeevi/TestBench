import { getSetting, setSetting } from "./db.ts";
import { AuditError } from "./auditcommon.ts";

/**
 * Who made a change. Testbench has no accounts yet (one shared password at most), so the name is the display name a person entered in Settings, kept as typed.
 * It is recorded on requirements (created_by, approved_by) and in their change log, and it is NOT verified: anyone who can use the installation can type any
 * name. When accounts arrive this is where the signed-in user's name comes from instead.
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
export const actorName = (): string => getDisplayName() || UNNAMED;
