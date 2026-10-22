import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db } from "../server/db.ts";
import { addChecklistItem, checklistSummary, copyChecklist, listChecklist } from "../server/checklist.ts";
import { makeProject } from "./helpers.ts";

const makeMilestone = (projectId: number, name: string) =>
  (db.prepare("INSERT INTO milestones (project_id, name) VALUES (?, ?) RETURNING id").get(projectId, name) as { id: number }).id;

describe("release checklist", () => {
  const p = makeProject("CL");
  const s1 = makeMilestone(p.id, "Sprint 1");
  const s2 = makeMilestone(p.id, "Sprint 2");

  it("keeps items in the order they were added", () => {
    addChecklistItem(s1, "Regression signed off");
    addChecklistItem(s1, "Release notes written");
    addChecklistItem(s1, "Changelog updated");
    assert.deepEqual(listChecklist(s1).map((i) => i.title), ["Regression signed off", "Release notes written", "Changelog updated"]);
    assert.deepEqual(listChecklist(s1).map((i) => i.position), [0, 1, 2]);
  });

  it("summarises what is done and when", () => {
    const [first] = listChecklist(s1);
    db.prepare("UPDATE milestone_checklist SET done_at = '2026-10-21 09:30:00' WHERE id = ?").run(first.id);
    const s = checklistSummary(s1);
    assert.equal(s.total, 3);
    assert.equal(s.done, 1);
    assert.equal(s.items[0].doneAt, "2026-10-21 09:30:00");
    assert.equal(s.items[1].doneAt, null);
    assert.ok(s.items.every((i) => i.source === "manual"));
  });

  it("copies the tasks but not their done state, and skips titles already there", () => {
    addChecklistItem(s2, "release notes written"); // same title, different case
    const added = copyChecklist(s2, s1);
    assert.equal(added, 2);
    assert.deepEqual(listChecklist(s2).map((i) => i.title), ["release notes written", "Regression signed off", "Changelog updated"]);
    assert.ok(listChecklist(s2).every((i) => i.done_at === null));
  });

  it("goes away with its sprint", () => {
    db.prepare("DELETE FROM milestones WHERE id = ?").run(s2);
    assert.equal(listChecklist(s2).length, 0);
  });
});
