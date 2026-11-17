import type { CaseSummary } from "./api";

/**
 * Which cases the picker takes in bulk. A case an AI agent proposed (the tag `agent-proposed`: a finding of a discover request, or a case made from an agent's manual-test
 * suggestion) starts as a `draft` that nobody has reviewed. It stays visible and can be ticked by hand, but "Select all", "Select shown" and a folder's checkbox leave it out, so
 * that an unreviewed AI draft never lands in a run by accident. A person who has reviewed it sets it to `ready`, and then it is an ordinary case again.
 */
export const AGENT_PROPOSED_TAG = "agent-proposed";

type Pickable = Pick<CaseSummary, "status" | "tags">;

/** An agent-proposed case that is still a draft. */
export const isUnreviewedAgentDraft = (c: Pickable) => c.status === "draft" && c.tags.includes(AGENT_PROPOSED_TAG);

/** What a bulk action (select all, select shown, a folder's checkbox) may take. */
export const bulkSelectable = <T extends Pickable>(cases: T[]): T[] => cases.filter((c) => !isUnreviewedAgentDraft(c));

/** The ids "Select all" / "Select shown" take. */
export const selectAllIds = (shown: (Pickable & { id: number })[]): number[] => bulkSelectable(shown).map((c) => c.id);

/** A folder's checkbox: the ids it toggles (never an unreviewed agent draft), whether they are all or some ticked, and whether it is disabled (nothing in it may be ticked in bulk). */
export function groupState(items: (Pickable & { id: number })[], selected: ReadonlySet<number>) {
  const ids = selectAllIds(items);
  const all = ids.length > 0 && ids.every((id) => selected.has(id));
  const some = !all && ids.some((id) => selected.has(id));
  return { ids, all, some, disabled: ids.length === 0 };
}

/** What a bulk action leaves out: shown to the person, so they know why a case was not ticked. */
export const heldBack = <T extends Pickable>(cases: T[]): T[] => cases.filter(isUnreviewedAgentDraft);

export const HELD_BACK_HINT = "Made by an AI agent and not reviewed yet. It is not ticked by Select all. Tick it yourself when you want it in the run.";
