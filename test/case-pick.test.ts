import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_PROPOSED_TAG, bulkSelectable, groupState, heldBack, isUnreviewedAgentDraft, selectAllIds } from "../web/src/casePick.ts";

// The guard in the case picker: an unreviewed AI draft (a draft with the tag `agent-proposed`) is shown and can be ticked by hand, but "Select all", "Select shown" and a folder's
// checkbox never take it, so it cannot land in a run by accident. These are the functions the picker (web/src/components/CasePicker.tsx) calls.

type C = { id: number; status: "draft" | "ready" | "deprecated"; tags: string[]; title: string };
const c = (id: number, status: C["status"], tags: string[] = [], title = `Case ${id}`): C => ({ id, status, tags, title });
const ordinary = c(1, "ready");
const ordinaryDraft = c(2, "draft", ["smoke"]);
const agentDraft = c(3, "draft", [AGENT_PROPOSED_TAG]);
const agentDraft2 = c(4, "draft", ["checkout", AGENT_PROPOSED_TAG]);
const reviewedAgent = c(5, "ready", [AGENT_PROPOSED_TAG]);
const all = [ordinary, ordinaryDraft, agentDraft, agentDraft2, reviewedAgent];

describe("which case is an unreviewed agent draft", () => {
  it("is a draft with the tag agent-proposed, and nothing else", () => {
    assert.equal(isUnreviewedAgentDraft(agentDraft), true);
    assert.equal(isUnreviewedAgentDraft(agentDraft2), true);
    assert.equal(isUnreviewedAgentDraft(ordinary), false, "an ordinary case");
    assert.equal(isUnreviewedAgentDraft(ordinaryDraft), false, "an ordinary draft is a person's own work");
    assert.equal(isUnreviewedAgentDraft(reviewedAgent), false, "once a person has set it to ready it is an ordinary case again");
    assert.equal(isUnreviewedAgentDraft(c(6, "deprecated", [AGENT_PROPOSED_TAG])), false);
    assert.equal(isUnreviewedAgentDraft(c(7, "draft", ["agent-proposed-ish"])), false, "the tag must be exactly agent-proposed");
  });
});

describe("select all and select shown", () => {
  it("takes every case except the unreviewed agent drafts, in the order given", () => {
    assert.deepEqual(selectAllIds(all), [1, 2, 5]);
    assert.deepEqual(bulkSelectable(all).map((x) => x.id), [1, 2, 5]);
  });

  it("leaves the agent drafts visible: they are the ones held back, and the list itself is not filtered", () => {
    assert.deepEqual(heldBack(all).map((x) => x.id), [3, 4]);
    assert.equal(all.length, 5, "nothing was removed from the list the picker shows");
  });

  it("takes nothing from a list of agent drafts only, and everything from a list without any", () => {
    assert.deepEqual(selectAllIds([agentDraft, agentDraft2]), []);
    assert.deepEqual(selectAllIds([ordinary, ordinaryDraft]), [1, 2]);
    assert.deepEqual(selectAllIds([]), []);
  });

  it("still lets a person tick an agent draft by hand: the guard is only on the bulk actions", () => {
    const selected = new Set<number>(selectAllIds(all));
    assert.equal(selected.has(agentDraft.id), false, "not ticked by default");
    selected.add(agentDraft.id); // the row's own checkbox adds the id of that row, with no guard in between
    assert.equal(selected.has(agentDraft.id), true);
    assert.deepEqual([...selected].sort(), [1, 2, 3, 5]);
  });
});

describe("a folder's checkbox", () => {
  it("toggles the same ids, so it never ticks an agent draft either", () => {
    const g = groupState(all, new Set());
    assert.deepEqual(g.ids, [1, 2, 5]);
    assert.deepEqual([g.all, g.some, g.disabled], [false, false, false]);
  });

  it("is ticked when everything it may take is ticked, even if the agent drafts are not", () => {
    const g = groupState(all, new Set([1, 2, 5]));
    assert.deepEqual([g.all, g.some], [true, false]);
  });

  it("is half ticked when only some are, and an agent draft ticked by hand does not make it more ticked", () => {
    assert.deepEqual([groupState(all, new Set([1])).all, groupState(all, new Set([1])).some], [false, true]);
    const onlyAgent = groupState(all, new Set([3]));
    assert.deepEqual([onlyAgent.all, onlyAgent.some], [false, false], "a hand-ticked agent draft is not what the folder's checkbox counts");
  });

  it("is disabled, and not ticked, for a folder that holds only agent drafts (an empty list is not 'all ticked')", () => {
    const g = groupState([agentDraft, agentDraft2], new Set());
    assert.deepEqual([g.ids, g.all, g.some, g.disabled], [[], false, false, true]);
    assert.equal(groupState([agentDraft], new Set([3])).all, false);
  });

  it("unticking the folder leaves an agent draft that was ticked by hand where it is", () => {
    const selected = new Set([1, 2, 5, 3]);
    const g = groupState(all, selected);
    for (const id of g.ids) selected.delete(id); // what the picker does when the folder's checkbox is unticked
    assert.deepEqual([...selected], [3]);
  });
});
