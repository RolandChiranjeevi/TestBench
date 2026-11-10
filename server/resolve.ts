import { db } from "./db.ts";
import type { Kind } from "./access.ts";

/**
 * From the id of a thing to the project it belongs to. One question per kind (the kinds are listed in access.ts), each answering with the project's id or nothing.
 * Nothing means "no such thing": the caller answers 404, the same as for a thing the person may not see, so a stranger cannot tell the two apart.
 */
const PROJECT_OF: Record<Exclude<Kind, "file">, string> = {
  project: "SELECT id FROM projects WHERE id = ?",
  case: "SELECT project_id FROM cases WHERE id = ?",
  run: "SELECT project_id FROM runs WHERE id = ?",
  result: "SELECT ru.project_id FROM results r JOIN runs ru ON ru.id = r.run_id WHERE r.id = ?",
  attachment: "SELECT ru.project_id FROM attachments a JOIN results r ON r.id = a.result_id JOIN runs ru ON ru.id = r.run_id WHERE a.id = ?",
  automated: "SELECT project_id FROM automated_tests WHERE id = ?",
  requirement: "SELECT project_id FROM requirements WHERE id = ?",
  reqattachment: "SELECT q.project_id FROM requirement_attachments a JOIN requirements q ON q.id = a.requirement_id WHERE a.id = ?",
  proposal: "SELECT project_id FROM requirement_proposals WHERE id = ?",
  observation: "SELECT project_id FROM observations WHERE id = ?",
  bug: "SELECT project_id FROM bug_reports WHERE id = ?",
  bugpublication: "SELECT b.project_id FROM bug_publications p JOIN bug_reports b ON b.id = p.bug_report_id WHERE p.id = ?",
  manualtest: "SELECT project_id FROM manual_tests WHERE id = ?",
  audit: "SELECT project_id FROM audits WHERE id = ?",
  milestone: "SELECT project_id FROM milestones WHERE id = ?",
  checklist: "SELECT m.project_id FROM milestone_checklist c JOIN milestones m ON m.id = c.milestone_id WHERE c.id = ?",
  suite: "SELECT project_id FROM suites WHERE id = ?",
  template: "SELECT project_id FROM run_templates WHERE id = ?",
  githubsource: "SELECT project_id FROM github_sources WHERE id = ?",
  agenttoken: "SELECT project_id FROM agent_tokens WHERE id = ?",
  citoken: "SELECT project_id FROM ci_tokens WHERE id = ?",
  proposetoken: "SELECT project_id FROM propose_tokens WHERE id = ?",
};
export const RESOLVER_KINDS = Object.keys(PROJECT_OF) as Exclude<Kind, "file">[];

/** The project a thing belongs to, or null when there is no such thing (or the id is not a whole number). */
export function projectOf(kind: Exclude<Kind, "file">, id: unknown): number | null {
  const n = typeof id === "number" ? id : typeof id === "string" && /^\d{1,15}$/.test(id) ? Number(id) : NaN;
  if (!Number.isSafeInteger(n)) return null;
  const row = db.prepare(PROJECT_OF[kind]).get(n) as Record<string, number> | undefined;
  return row ? Object.values(row)[0] : null;
}

/** The project a stored file belongs to: a result's attachment, a requirement's, a bug report's evidence, or an audit's narrative. Null for a name no table knows. */
export function projectOfFile(storedName: string): number | null {
  const row = db.prepare(`
    SELECT ru.project_id AS p FROM attachments a JOIN results r ON r.id = a.result_id JOIN runs ru ON ru.id = r.run_id WHERE a.stored_name = @n
    UNION ALL SELECT q.project_id FROM requirement_attachments a JOIN requirements q ON q.id = a.requirement_id WHERE a.stored_name = @n
    UNION ALL SELECT b.project_id FROM bug_attachments a JOIN bug_reports b ON b.id = a.bug_report_id WHERE a.stored_name = @n
    UNION ALL SELECT project_id FROM audits WHERE narrative_stored_name = @n
    LIMIT 1`).get({ n: storedName }) as { p: number } | undefined;
  return row ? row.p : null;
}
