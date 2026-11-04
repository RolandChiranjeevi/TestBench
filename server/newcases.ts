import { db, parseJson } from "./db.ts";

/**
 * "New" test cases are the ones created in the last NEW_CASE_WINDOW_DAYS days. Unlike bugs and agent proposals this is about time, not about a
 * run or an import: a case is made by a person (by hand, as a copy, or from an accepted agent proposal) and never by a CI run, so there is no
 * run it could first have appeared in. Only `cases.created_at` counts; editing a case (`updated_at`) never makes it new. Nothing is stored.
 */
export const NEW_CASE_WINDOW_DAYS = 7;
const WINDOW_MS = NEW_CASE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** SQLite's datetime('now') is UTC without a zone marker. */
const asUtc = (s: string): number => Date.parse(s.replace(" ", "T") + "Z");

/** True when the case was created at most NEW_CASE_WINDOW_DAYS days before `now` (exactly on the boundary still counts). A clock in the future counts too. */
export function isNewCase(createdAt: string, now: Date = new Date()): boolean {
  const t = asUtc(createdAt);
  return Number.isFinite(t) && now.getTime() - t <= WINDOW_MS;
}

/** The test cases of a project, in the order the list shows them, each with `is_new` and `from_proposal` (made from an agent proposal). */
export type CaseListRow = Record<string, any> & { tags: string[]; from_proposal: boolean; is_new: boolean };
export function listCases(projectId: number, now: Date = new Date()): CaseListRow[] {
  const rows = db
    .prepare(`
      SELECT c.*, s.name AS suite_name,
        (SELECT COUNT(*) FROM automated_tests a WHERE a.case_id = c.id) AS automated_count,
        (SELECT COUNT(*) FROM case_steps st WHERE st.case_id = c.id) AS step_count,
        (SELECT COUNT(*) FROM requirement_cases rc WHERE rc.case_id = c.id) AS requirement_count,
        (SELECT r.status FROM results r JOIN runs ru ON ru.id = r.run_id
          WHERE r.case_id = c.id AND r.status != 'untested'
          ORDER BY COALESCE(r.executed_at, ru.started_at) DESC, r.id DESC LIMIT 1) AS last_status,
        EXISTS (SELECT 1 FROM manual_tests m WHERE m.case_id = c.id) AS from_proposal
      FROM cases c LEFT JOIN suites s ON s.id = c.suite_id
      WHERE c.project_id = ? ORDER BY c.position, c.number`)
    .all(projectId) as Record<string, any>[];
  return rows.map((row) => ({ ...row, tags: parseJson<string[]>(row.tags, []), from_proposal: !!row.from_proposal, is_new: isNewCase(row.created_at, now) }));
}
