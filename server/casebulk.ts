import { db, parseJson } from "./db.ts";

export class CaseBulkError extends Error {
  constructor(public status: 400 | 404, message: string) {
    super(message);
  }
}

export interface BulkPatch {
  /** undefined = leave as is, null = no suite, number = move there. */
  suiteId?: number | null;
  priority?: "low" | "medium" | "high" | "critical";
  status?: "draft" | "ready" | "deprecated";
  addTags?: string[];
  removeTags?: string[];
}

const cleanTags = (tags: string[] | undefined) => [...new Set((tags ?? []).map((t) => t.trim()).filter(Boolean))];

/**
 * Apply one change to many cases at once. Only cases of this project are touched; ids from elsewhere are ignored.
 * Tags are added and removed (case-insensitively for removal), never replaced, so cases keep the tags they already have.
 */
export function bulkUpdateCases(projectId: number, ids: number[], patch: BulkPatch): { updated: number } {
  if (!ids.length) throw new CaseBulkError(400, "Select at least one case");
  if (patch.suiteId != null) {
    const suite = db.prepare("SELECT project_id FROM suites WHERE id = ?").get(patch.suiteId) as { project_id: number } | undefined;
    if (!suite || suite.project_id !== projectId) throw new CaseBulkError(400, "That suite is in another project");
  }
  const add = cleanTags(patch.addTags);
  const remove = new Set(cleanTags(patch.removeTags).map((t) => t.toLowerCase()));
  const touchesTags = add.length > 0 || remove.size > 0;
  if (patch.suiteId === undefined && !patch.priority && !patch.status && !touchesTags) throw new CaseBulkError(400, "Nothing to change");

  const rows = db
    .prepare(`SELECT id, tags FROM cases WHERE project_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
    .all(projectId, ...ids) as { id: number; tags: string }[];
  const update = db.prepare(`
    UPDATE cases SET
      suite_id = CASE WHEN @moveSuite = 1 THEN @suiteId ELSE suite_id END,
      priority = COALESCE(@priority, priority),
      status = COALESCE(@status, status),
      tags = @tags,
      updated_at = datetime('now')
    WHERE id = @id`);
  db.transaction(() => {
    for (const r of rows) {
      let tags = parseJson<string[]>(r.tags, []);
      if (touchesTags) {
        tags = tags.filter((t) => !remove.has(t.toLowerCase()));
        for (const t of add) if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
      }
      update.run({
        id: r.id,
        moveSuite: patch.suiteId === undefined ? 0 : 1,
        suiteId: patch.suiteId ?? null,
        priority: patch.priority ?? null,
        status: patch.status ?? null,
        tags: JSON.stringify(tags),
      });
    }
  })();
  return { updated: rows.length };
}

/**
 * A new draft case with the same suite, text, priority, tags and steps, placed right after the original. It does not inherit links to
 * requirements or automated tests: a copy is usually a variation, and those links say what the original covers.
 */
export function duplicateCase(caseId: number): number {
  const src = db.prepare("SELECT * FROM cases WHERE id = ?").get(caseId) as Record<string, any> | undefined;
  if (!src) throw new CaseBulkError(404, "Case not found");
  return db.transaction(() => {
    const n = (db.prepare("UPDATE projects SET next_case_number = next_case_number + 1 WHERE id = ? RETURNING next_case_number - 1 AS n").get(src.project_id) as { n: number }).n;
    const copy = db
      .prepare(`
        INSERT INTO cases (project_id, suite_id, number, title, description, preconditions, priority, status, tags, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?) RETURNING id`)
      .get(src.project_id, src.suite_id, n, `${src.title} (copy)`.slice(0, 500), src.description, src.preconditions, src.priority, src.tags, src.position) as { id: number };
    db.prepare("INSERT INTO case_steps (case_id, position, action, expected) SELECT ?, position, action, expected FROM case_steps WHERE case_id = ? ORDER BY position").run(copy.id, caseId);
    return copy.id;
  })();
}
