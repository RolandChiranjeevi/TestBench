/**
 * What a person may do in the web app, as far as the screens are concerned. This only decides what to show (a button that is off and says why, a tab that is left out):
 * the server decides what is allowed (server/access.ts) and answers 403 or 404 either way. No React in here, so it can be tested on its own.
 */
export type Level = "viewer" | "tester" | "admin";
export const LEVELS: readonly Level[] = ["viewer", "tester", "admin"];
/** What something needs: a role in the project, or being the owner of the installation. */
export type Needs = Level | "owner";

export interface Access {
  /** Whether accounts are on. Without accounts there are no roles and everything is allowed, as it always was. */
  accounts: boolean;
  /** The person's role in the project at hand, or null (not a member, or not in a project). */
  role: Level | null;
  isOwner: boolean;
}

/** Everything allowed: no accounts. */
export const OPEN: Access = { accounts: false, role: "admin", isOwner: true };

const rank = (l: Level) => LEVELS.indexOf(l);

export function can(a: Access, needs: Needs): boolean {
  if (!a.accounts || a.isOwner) return true; // the owner is an admin of every project
  if (needs === "owner") return false;
  return a.role !== null && rank(a.role) >= rank(needs);
}

/** The badge beside the project name: "Owner" for the owner (an admin everywhere), else the role. Null without accounts, where there are no roles to show. */
export function roleLabel(a: Access): "Owner" | "Admin" | "Tester" | "Viewer" | null {
  if (!a.accounts) return null;
  if (a.isOwner) return "Owner";
  return a.role === "admin" ? "Admin" : a.role === "tester" ? "Tester" : a.role === "viewer" ? "Viewer" : null;
}

/** Why something is off, in words a person can act on. */
export function needsText(needs: Needs): string {
  return needs === "owner" ? "Only the owner of this Testbench can do this" : `Needs the ${needs} role in this project`;
}

/** What each tab of the settings needs to be of any use (the routes behind it refuse less). Tabs that are not usable are left out. */
export const SETTINGS_NEEDS = {
  agent: "admin", // tokens for CI and agents
  project: "admin", // name, destination, GitHub sources, deleting the project
  members: "viewer", // everyone in the project sees who is in it; an admin looks after it
  data: "owner", // backup and restore of the whole installation
  shortcuts: "viewer",
  account: "viewer",
} as const satisfies Record<string, Needs>;
export type SettingsSection = keyof typeof SETTINGS_NEEDS;

export const visibleSettings = <T extends string>(sections: readonly (readonly [T, string])[], a: Access) =>
  sections.filter(([id]) => can(a, (SETTINGS_NEEDS as Record<string, Needs>)[id] ?? "viewer"));

/** A viewer can read but not change. Used for the banner on project pages. */
export const isReadOnly = (a: Access) => a.accounts && !a.isOwner && a.role === "viewer";

/**
 * What the server's answer to a request means for the screen. A 404 on a project route means the person is no longer a member (or the project is gone); a 403 carries
 * the server's own words, which name the role that is needed.
 */
export function explainStatus(status: number, message: string): { kind: "lost-access" | "forbidden" | "other"; text: string } {
  if (status === 404 && message === "Not found") return { kind: "lost-access", text: "You no longer have access to this project." };
  if (status === 403) return { kind: "forbidden", text: message || "You are not allowed to do that." };
  return { kind: "other", text: message };
}
