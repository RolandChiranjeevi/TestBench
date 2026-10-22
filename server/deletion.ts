import { db } from "./db.ts";

export class DeletionError extends Error {
  constructor(public status: 400 | 404, message: string) {
    super(message);
  }
}

/**
 * Deletes test cases of one project. Ids from other projects are ignored.
 * What happens around them: steps, requirement links, template entries and link suggestions go with the case; results that were
 * recorded for it stay in their runs (manual results keep a frozen copy of the case); automated tests that were linked to it become
 * unlinked. Past runs and reports keep their numbers.
 */
export function deleteCases(projectId: number, ids: number[]): { deleted: number } {
  const unique = [...new Set(ids)];
  if (!unique.length) throw new DeletionError(400, "Select at least one case");
  const res = db.prepare(`DELETE FROM cases WHERE project_id = ? AND id IN (${unique.map(() => "?").join(",")})`).run(projectId, ...unique);
  return { deleted: res.changes };
}

export interface ProjectDeletion {
  name: string;
  key: string;
  counts: { cases: number; runs: number; requirements: number; automatedTests: number };
  /** Stored names of uploaded files (evidence, requirement attachments) that no longer belong to anything. The caller removes them. */
  files: string[];
}

/** The numbers shown in the confirmation, and what deleting would remove. */
export function describeProject(projectId: number) {
  const project = db.prepare("SELECT id, name, key FROM projects WHERE id = ?").get(projectId) as { id: number; name: string; key: string } | undefined;
  if (!project) throw new DeletionError(404, "Project not found");
  const n = (sql: string) => (db.prepare(sql).get(projectId) as { n: number }).n;
  return {
    ...project,
    counts: {
      cases: n("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?"),
      runs: n("SELECT COUNT(*) AS n FROM runs WHERE project_id = ?"),
      requirements: n("SELECT COUNT(*) AS n FROM requirements WHERE project_id = ?"),
      automatedTests: n("SELECT COUNT(*) AS n FROM automated_tests WHERE project_id = ?"),
    },
  };
}

/**
 * Deletes a whole project with everything in it. The caller must pass the project's key as `confirmKey`: a request that does not know
 * which project it is deleting is refused. The database part is one transaction; files are returned for the caller to remove.
 */
export function deleteProject(projectId: number, confirmKey: string): ProjectDeletion {
  const info = describeProject(projectId);
  if (confirmKey !== info.key) throw new DeletionError(400, `To delete "${info.name}", confirm with its key ${info.key}.`);

  const files = [
    ...(db
      .prepare("SELECT a.stored_name FROM attachments a JOIN results r ON r.id = a.result_id JOIN runs ru ON ru.id = r.run_id WHERE ru.project_id = ?")
      .all(projectId) as { stored_name: string }[]),
    ...(db
      .prepare("SELECT a.stored_name FROM requirement_attachments a JOIN requirements q ON q.id = a.requirement_id WHERE q.project_id = ?")
      .all(projectId) as { stored_name: string }[]),
  ].map((f) => f.stored_name);

  db.transaction(() => {
    db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  })();
  return { name: info.name, key: info.key, counts: info.counts, files };
}
