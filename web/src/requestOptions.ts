// The choices a person makes when asking for a discover. They mirror server/agentrequests.ts (REQUEST_OPTIONS, DEFAULT_REQUEST_OPTIONS, optionsNeedAdmin): the test
// test/web-requestoptions.test.ts keeps the two in step. They are a PRESELECTION for the agent's one confirmation, never a permission: the agent shows them, the user
// confirms in a message of their own, and the agent stays under its own limits.

export const TARGET_MODES = [
  { value: "observe_only", label: "Only read", title: "The agent looks at the target and changes nothing in it (observe-only)." },
  { value: "full", label: "Act on the target", title: "The agent may click and fill in forms with made-up data on this address (reading and writing), after the one confirmation in its own session. Never for a production address, and only if its profile allows it (full)." },
] as const;
export const GIT_MODES = [
  { value: "off", label: "Nothing in git", title: "The agent writes nothing to git." },
  { value: "local", label: "Commit on a local branch", title: "The agent commits on a branch in its own copy of the repository. You push it." },
  { value: "pr", label: "Push and open a pull request", title: "The agent pushes its branch and opens a pull request. It never merges." },
] as const;
export const DELIVERABLES = [
  { value: "plan", label: "Test plan" },
  { value: "cases", label: "Test cases" },
  { value: "observations", label: "Observations" },
  { value: "bugs", label: "Bug proposals" },
  { value: "specs", label: "Spec files" },
] as const;
export const VIEWPORTS = [
  { value: "desktop", label: "Desktop" },
  { value: "tablet", label: "Tablet" },
  { value: "mobile", label: "Mobile" },
] as const;

export const CHECKS = [
  { value: "visual", label: "Visual review", title: "The layout at the chosen screen sizes: cut-off text, horizontal scroll, overlapping content, landscape, images without a size. Reads only." },
  { value: "accessibility", label: "Accessibility", title: "What the page snapshot and HTML show: headings, alt text, labels, landmarks, link text, small targets. Not an automated scan, and not WCAG conformance. Reads only." },
  { value: "api", label: "API checks", title: "The calls the pages make: which fail, which hosts they go to, and their headers. Never what the answers contain. Not for a production address." },
  { value: "security", label: "Security review", title: "Headers, cookie flags, scripts and keys in the page, and a few probes with a purpose (an error page, /admin, /.git/HEAD). Not a penetration test. Not for a production address." },
  { value: "privacy", label: "Privacy and consent", title: "The consent banner, and tracking calls and cookies before any choice. Never establishes that the site meets the law. Reads only." },
] as const;

export const DEPTHS = [
  { value: "quick", label: "Quick", title: "A short look: few pages and few actions. For a first impression or a small change." },
  { value: "normal", label: "Normal", title: "The usual amount of work for a page or a small site." },
  { value: "deep", label: "Deep", title: "As far as it can go: every page, flow and form it can reach, with a very high ceiling. It takes the longest. It never gives the agent more permissions." },
] as const;

export type TargetMode = (typeof TARGET_MODES)[number]["value"];
export type GitMode = (typeof GIT_MODES)[number]["value"];
export type Deliverable = (typeof DELIVERABLES)[number]["value"];
export type Viewport = (typeof VIEWPORTS)[number]["value"];
export type Check = (typeof CHECKS)[number]["value"];
export type Depth = (typeof DEPTHS)[number]["value"];
export interface RequestOptions { targetMode: TargetMode; gitMode: GitMode; deliverables: Deliverable[]; viewports: Viewport[]; checks: Check[]; depth: Depth; production: boolean }

/** The checks allowed on a production address: they only read what the pages show (the server checks the same list). */
export const PRODUCTION_CHECKS: readonly string[] = ["visual", "accessibility", "privacy"];

export const DEFAULT_OPTIONS: RequestOptions = { targetMode: "observe_only", gitMode: "local", deliverables: ["plan", "cases", "observations", "bugs"], viewports: ["desktop", "tablet", "mobile"], checks: ["visual", "accessibility", "api", "security", "privacy"], depth: "normal", production: false };

/** Choosing to act on the target moves the depth to deep, and choosing to only read moves it back to normal, but only if the person has not picked another depth (a convenience: the depth is always theirs to change). */
export function withTargetMode(o: RequestOptions, targetMode: TargetMode): RequestOptions {
  const depth: Depth = targetMode === "full" && o.depth === "normal" ? "deep" : targetMode === "observe_only" && o.depth === "deep" ? "normal" : o.depth;
  return { ...o, targetMode, depth };
}

/** Acting on the target, or pushing and opening a pull request: with accounts on, only an admin of the project can ask for these (the server refuses anyone else). */
export const optionsNeedAdmin = (o: Pick<RequestOptions, "targetMode" | "gitMode">) => o.targetMode === "full" || o.gitMode === "pr";

/** Adds or removes `value`, keeping the order of `all`. */
export function toggled<T extends string>(all: readonly { value: T }[], list: readonly T[], value: T): T[] {
  const next = new Set<T>(list);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return all.map((a) => a.value).filter((v) => next.has(v));
}

/** A production address can only be read: saying it is production takes the choice to act on it away. */
export const withProduction = (o: RequestOptions, production: boolean): RequestOptions =>
  production ? { ...o, production, targetMode: "observe_only", checks: o.checks.filter((c) => PRODUCTION_CHECKS.includes(c)) } : { ...o, production };

/** What stops the request from being made, or null. The server checks the same things. */
export function optionsProblem(o: RequestOptions): string | null {
  if (o.deliverables.length === 0) return "Pick at least one thing for the agent to deliver";
  if (o.viewports.length === 0) return "Pick at least one screen size to look at";
  return null;
}

/** The choices on one line, for the request card. */
export function optionsSummary(o: RequestOptions): string {
  const label = <T extends string>(all: readonly { value: T; label: string }[], v: T) => all.find((a) => a.value === v)?.label ?? v;
  const list = <T extends string>(all: readonly { value: T; label: string }[], vs: readonly T[]) => vs.map((v) => label(all, v).toLowerCase()).join(", ");
  return [label(TARGET_MODES, o.targetMode), label(GIT_MODES, o.gitMode), list(DELIVERABLES, o.deliverables), list(VIEWPORTS, o.viewports), ...(o.checks.length ? [`checks: ${list(CHECKS, o.checks)}`] : []), `depth: ${label(DEPTHS, o.depth).toLowerCase()}`, ...(o.production ? ["production"] : [])].join(" · ");
}

/** What to run to start the agent on a request, and the skill command to run in that session (it lists what waits, and a discover from it needs one confirmation). The set-up steps are in docs/agent-quickstart.md. */
export const START_COMMAND = "claude --permission-mode default";
export const START_SKILL = "/testpilot-requests";
