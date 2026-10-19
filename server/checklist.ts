import { db } from "./db.ts";

export interface ChecklistItem { id: number; milestone_id: number; position: number; title: string; done_at: string | null; source: string; created_at: string }

export const listChecklist = (milestoneId: number) =>
  db.prepare("SELECT * FROM milestone_checklist WHERE milestone_id = ? ORDER BY position, id").all(milestoneId) as ChecklistItem[];

export function addChecklistItem(milestoneId: number, title: string) {
  const pos = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM milestone_checklist WHERE milestone_id = ?").get(milestoneId) as { p: number }).p;
  return db.prepare("INSERT INTO milestone_checklist (milestone_id, position, title) VALUES (?, ?, ?) RETURNING *").get(milestoneId, pos, title) as ChecklistItem;
}

/** Copy the tasks (not their done state) from another sprint/release of the same project, skipping titles already present. */
export function copyChecklist(toId: number, fromId: number) {
  const have = new Set(listChecklist(toId).map((i) => i.title.toLowerCase()));
  let added = 0;
  db.transaction(() => {
    for (const i of listChecklist(fromId)) {
      if (have.has(i.title.toLowerCase())) continue;
      addChecklistItem(toId, i.title);
      added++;
    }
  })();
  return added;
}

/** What the report and exports show: tasks in order with when they were done, plus the tally. */
export function checklistSummary(milestoneId: number) {
  const items = listChecklist(milestoneId).map((i) => ({ title: i.title, doneAt: i.done_at, source: i.source }));
  return { items, total: items.length, done: items.filter((i) => i.doneAt).length };
}
