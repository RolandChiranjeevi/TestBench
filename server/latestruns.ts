import { db, parseJson } from "./db.ts";

/**
 * "New" bugs: the ones that came with the latest run of a source. Read-only and computed from what is already stored, nothing is added to the data.
 *
 *  - CI: a bug is new when its first occurrence belongs to the project's latest CI run (the latest row of ci_runs, in the order they were received).
 *    A bug that fails again in a later run is not new, and neither is one that was closed and reopened.
 *  - Agent audit: a bug is new when its first version (revision 1) came with the project's latest audit import, across all the project's audits.
 *    An import that adds nothing new makes the earlier import's bugs stop being new.
 *  - Manual: only the latest such bug is shown. The app does not create manual bugs yet, so there is usually none.
 */

export interface LatestCiRun {
  id: number; runId: string; receivedAt: string; finishedAt: string | null; branch: string; commit: string; repository: string; pipelineUrl: string;
  counts: { passed: number; failed: number; flaky: number; skipped: number }; newCount: number;
}
export interface LatestAuditImport { importId: number; auditId: number; auditTitle: string; importedAt: string; source: string; newCount: number }
export interface LatestManualBug { id: number; title: string; at: string }
export interface LatestRuns { ci: LatestCiRun | null; audit: LatestAuditImport | null; manual: LatestManualBug | null }

/** The ids of the bugs that are new in the latest CI run and in the latest audit import of the project. */
export function newBugIds(projectId: number): { ci: Set<number>; audit: Set<number>; latestCiRunId: number | null; latestImportId: number | null } {
  const run = db.prepare("SELECT id FROM ci_runs WHERE project_id = ? ORDER BY id DESC LIMIT 1").get(projectId) as { id: number } | undefined;
  const imp = db.prepare("SELECT i.id FROM audit_imports i JOIN audits a ON a.id = i.audit_id WHERE a.project_id = ? ORDER BY i.id DESC LIMIT 1").get(projectId) as { id: number } | undefined;
  const ci = run
    ? (db.prepare(`
        SELECT b.id FROM bug_reports b
        WHERE b.project_id = ? AND b.source = 'ci'
          AND (SELECT MIN(x.ci_run_id) FROM bug_occurrences o JOIN ci_results x ON x.id = o.ci_result_id WHERE o.bug_report_id = b.id) = ?`).all(projectId, run.id) as { id: number }[])
    : [];
  const audit = imp
    ? (db.prepare(`
        SELECT b.id FROM bug_reports b JOIN bug_revisions r ON r.bug_report_id = b.id AND r.rev = 1
        WHERE b.project_id = ? AND b.source = 'agent_audit' AND r.audit_import_id = ?`).all(projectId, imp.id) as { id: number }[])
    : [];
  return { ci: new Set(ci.map((r) => r.id)), audit: new Set(audit.map((r) => r.id)), latestCiRunId: run?.id ?? null, latestImportId: imp?.id ?? null };
}

/** What the "Latest runs" strip shows: the latest run or import of each source and how many bugs came with it. */
export function latestRuns(projectId: number, sets = newBugIds(projectId)): LatestRuns {
  const r = db.prepare("SELECT id, run_id, received_at, finished_at, branch, commit_sha, repository, pipeline_url, counts FROM ci_runs WHERE id = ?").get(sets.latestCiRunId ?? -1) as Record<string, any> | undefined;
  const i = db.prepare(`
    SELECT i.id, i.imported_at, i.source, a.id AS audit_id, a.title FROM audit_imports i JOIN audits a ON a.id = i.audit_id WHERE i.id = ?`).get(sets.latestImportId ?? -1) as Record<string, any> | undefined;
  const m = db.prepare("SELECT id, title, imported_at FROM bug_reports WHERE project_id = ? AND source = 'manual' ORDER BY id DESC LIMIT 1").get(projectId) as { id: number; title: string; imported_at: string } | undefined;
  return {
    ci: r ? {
      id: r.id, runId: r.run_id, receivedAt: r.received_at, finishedAt: r.finished_at, branch: r.branch, commit: r.commit_sha, repository: r.repository, pipelineUrl: r.pipeline_url,
      counts: parseJson(r.counts, { passed: 0, failed: 0, flaky: 0, skipped: 0 }), newCount: sets.ci.size,
    } : null,
    audit: i ? { importId: i.id, auditId: i.audit_id, auditTitle: i.title, importedAt: i.imported_at, source: i.source, newCount: sets.audit.size } : null,
    manual: m ? { id: m.id, title: m.title, at: m.imported_at } : null,
  };
}

/**
 * "New" agent proposals (manual tests): the ones whose first version (revision 1) came with the project's latest audit import that carried a
 * manual-tests.json. An import without that file says nothing about manual tests, so it does not make earlier proposals old.
 * Read-only, like the bugs above.
 */
export interface LatestManualImport { importId: number; auditId: number; auditTitle: string; importedAt: string; source: string; newCount: number }

export function newManualTests(projectId: number): { ids: Set<number>; latest: LatestManualImport | null } {
  const i = db.prepare(`
    SELECT i.id, i.imported_at, i.source, a.id AS audit_id, a.title FROM audit_imports i JOIN audits a ON a.id = i.audit_id
    WHERE a.project_id = ? AND i.manual_listed = 1 ORDER BY i.id DESC LIMIT 1`).get(projectId) as Record<string, any> | undefined;
  if (!i) return { ids: new Set(), latest: null };
  const rows = db.prepare(`
    SELECT m.id FROM manual_tests m JOIN manual_test_revisions r ON r.manual_test_id = m.id AND r.rev = 1
    WHERE m.project_id = ? AND r.audit_import_id = ?`).all(projectId, i.id) as { id: number }[];
  return { ids: new Set(rows.map((r) => r.id)), latest: { importId: i.id, auditId: i.audit_id, auditTitle: i.title, importedAt: i.imported_at, source: i.source, newCount: rows.length } };
}
