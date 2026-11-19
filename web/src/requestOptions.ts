// The choices a person makes when asking for a discover. They mirror server/agentrequests.ts (REQUEST_OPTIONS, DEFAULT_REQUEST_OPTIONS, optionsNeedAdmin): the test
// test/web-requestoptions.test.ts keeps the two in step. They are a PRESELECTION for the agent's one confirmation, never a permission: the agent shows them, the user
// confirms in a message of their own, and the agent stays under its own limits.

export const TARGET_MODES = [
  { value: "observe_only", label: "Only read", title: "The agent looks at the target and changes nothing in it (observe-only)." },
  { value: "full", label: "Act on the target", title: "The agent may also change the state of the target, each action only after you confirm it (full)." },
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

export type TargetMode = (typeof TARGET_MODES)[number]["value"];
export type GitMode = (typeof GIT_MODES)[number]["value"];
export type Deliverable = (typeof DELIVERABLES)[number]["value"];
export type Viewport = (typeof VIEWPORTS)[number]["value"];
export interface RequestOptions { targetMode: TargetMode; gitMode: GitMode; deliverables: Deliverable[]; viewports: Viewport[]; production: boolean }

export const DEFAULT_OPTIONS: RequestOptions = { targetMode: "observe_only", gitMode: "local", deliverables: ["plan", "cases", "observations", "bugs"], viewports: ["desktop", "tablet", "mobile"], production: false };

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
export const withProduction = (o: RequestOptions, production: boolean): RequestOptions => (production ? { ...o, production, targetMode: "observe_only" } : { ...o, production });

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
  return [label(TARGET_MODES, o.targetMode), label(GIT_MODES, o.gitMode), list(DELIVERABLES, o.deliverables), list(VIEWPORTS, o.viewports), ...(o.production ? ["production"] : [])].join(" · ");
}

/** What to run and say to start the agent on a request. The set-up steps are in docs/agent-quickstart.md. */
export const START_COMMAND = "claude --permission-mode default";
export const START_PROMPT = "Use testbench_get_next_request to fetch the next request from Testbench and work on it.";
