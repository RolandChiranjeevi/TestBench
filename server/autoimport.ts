import { db } from "./db.ts";
import { auditRunBlockedReason, downloadArtifactBag, getRunInfo, importRun, listAuditArtifacts, listRuns, MAX_AUDIT_ARTIFACT_BYTES, parseWorkflowList, type GithubSource, type RunInfo } from "./importers/github.ts";
import { PackageError } from "./importers/auditpackage.ts";
import { importAuditPackage } from "./audits.ts";

/** Errors that will never go away for a given run (it simply has no test artifacts), so it is remembered and not retried. */
const PERMANENT = [/no matching, unexpired artifacts/i, /No JUnit XML or Playwright JSON reports found/i];
const IGNORED_CONCLUSIONS = new Set(["cancelled", "skipped", "stale"]);

/** Branch names or patterns such as `main, release/*`. An empty filter allows every branch. */
export function branchMatches(branch: string, filter: string): boolean {
  const patterns = filter.split(",").map((s) => s.trim()).filter(Boolean);
  if (!patterns.length) return true;
  return patterns.some((p) => new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(branch));
}

export interface CheckResult {
  imported: number;
  /** Runs that were looked at but not imported (other branch, cancelled, or no test artifacts). */
  skipped: number;
  /** Runs still in progress, picked up on a later check. */
  waiting: number;
  /** Audit packages imported / refused (a refused one is not tried again; the reason is shown on the Bug reports page). */
  audits: number;
  auditsRejected: number;
  /** Audit packages left alone because their workflow is not allowed. They are not remembered, so allowing the workflow later imports them. */
  auditsBlocked: number;
  error: string | null;
}

const markSeen = (sourceId: number, runId: number, outcome: string, note: string) =>
  db.prepare("INSERT OR REPLACE INTO github_seen (source_id, run_id, outcome, note) VALUES (?, ?, ?, ?)").run(sourceId, runId, outcome, note);

/** Imports the source's finished workflow runs that appeared since automatic import was switched on. */
export async function checkSource(src: GithubSource): Promise<CheckResult> {
  const result: CheckResult = { imported: 0, skipped: 0, waiting: 0, audits: 0, auditsRejected: 0, auditsBlocked: 0, error: null };
  try {
    const since = src.auto_since ? Date.parse(src.auto_since.replace(" ", "T") + "Z") : 0;
    const seen = new Set((db.prepare("SELECT run_id FROM github_seen WHERE source_id = ?").all(src.id) as { run_id: number }[]).map((r) => r.run_id));
    const imported = new Set(
      (db.prepare("SELECT external_id FROM runs WHERE project_id = ? AND source = 'github' AND external_id LIKE ?").all(src.project_id, `${src.owner}/${src.repo}#%`) as { external_id: string }[]).map((r) => r.external_id),
    );

    const runs = (await listRuns(src)).sort((a, b) => a.id - b.id); // oldest first, so runs appear in order
    for (const run of runs) {
      if (seen.has(run.id) || imported.has(`${src.owner}/${src.repo}#${run.id}`)) continue;
      if (Date.parse(run.created_at) < since) continue;
      if (run.status !== "completed") { result.waiting++; continue; }
      if ((run.conclusion && IGNORED_CONCLUSIONS.has(run.conclusion)) || !branchMatches(run.head_branch, src.branch_filter)) { result.skipped++; continue; }
      try {
        await importRun(src, run.id);
        markSeen(src.id, run.id, "imported", "");
        result.imported++;
      } catch (e) {
        const message = (e as Error).message;
        if (PERMANENT.some((re) => re.test(message))) {
          markSeen(src.id, run.id, "skipped", message);
          result.skipped++;
        } else {
          result.error = `Run #${run.run_number}: ${message}`; // possibly temporary (network, rate limit): tried again next time
        }
      }
    }
  } catch (e) {
    result.error = (e as Error).message;
  }
  try {
    await checkAuditPackages(src, result);
  } catch (e) {
    result.error ??= (e as Error).message;
  }
  db.prepare("UPDATE github_sources SET last_checked_at = datetime('now'), last_error = ? WHERE id = ?").run(result.error ?? "", src.id);
  return result;
}

/**
 * Audit packages are followed artifact by artifact (artifact ids never change), not run by run. So a package that shows up after its
 * workflow run was imported, or after the run was skipped for having no test reports, is still fetched. Only the repository's 100 newest
 * artifacts are looked at, so after a long pause older packages are not found. They become importable by uploading them by hand.
 *
 * Which workflow made an artifact is not in the artifact list, so it is looked up from the artifact's run before anything is downloaded.
 * Only workflows listed in the source's audit_workflows may deliver packages; an empty list allows none.
 */
async function checkAuditPackages(src: GithubSource, result: CheckResult) {
  const since = src.auto_since ? Date.parse(src.auto_since.replace(" ", "T") + "Z") : 0;
  const done = new Set((db.prepare("SELECT artifact_id FROM github_artifacts WHERE source_id = ?").all(src.id) as { artifact_id: number }[]).map((r) => r.artifact_id));
  const record = (a: { id: number; name: string; workflow_run: { id: number } }, outcome: "imported" | "rejected", note: string) =>
    db.prepare("INSERT OR REPLACE INTO github_artifacts (source_id, artifact_id, run_id, name, outcome, note) VALUES (?, ?, ?, ?, ?, ?)").run(src.id, a.id, a.workflow_run.id, a.name, outcome, note.slice(0, 500));
  const fresh = (await listAuditArtifacts(src))
    .filter((a) => !done.has(a.id) && !a.expired && Date.parse(a.created_at) >= since && branchMatches(a.workflow_run.head_branch ?? "", src.branch_filter))
    .sort((x, y) => x.id - y.id);
  if (!fresh.length) return;

  let allowed: string[];
  try {
    allowed = parseWorkflowList(src.audit_workflows ?? "");
  } catch (e) {
    result.error ??= `Audit workflows: ${(e as Error).message}. ${fresh.length} audit package${fresh.length === 1 ? "" : "s"} not imported.`;
    result.auditsBlocked += fresh.length;
    return;
  }
  if (!allowed.length) {
    result.error ??= `${fresh.length} audit package${fresh.length === 1 ? "" : "s"} (testbench-audit-*) found in ${src.owner}/${src.repo}, but no workflow is allowed to deliver audit packages for this source. Nothing was imported. Add the workflow file name or id under "Workflows allowed to deliver audit packages".`;
    result.auditsBlocked += fresh.length;
    return;
  }

  const runs = new Map<number, RunInfo | Error>();
  for (const a of fresh) {
    if (a.size_in_bytes > MAX_AUDIT_ARTIFACT_BYTES) { record(a, "rejected", `The artifact is larger than ${MAX_AUDIT_ARTIFACT_BYTES / 1024 / 1024} MB`); result.auditsRejected++; continue; }
    if (!runs.has(a.workflow_run.id)) runs.set(a.workflow_run.id, await getRunInfo(src, a.workflow_run.id).catch((e: Error) => e));
    const run = runs.get(a.workflow_run.id)!;
    if (run instanceof Error) { // cannot tell where it came from, so it is not trusted; tried again next time
      result.error ??= `Audit package ${a.name}: could not look up its workflow run: ${run.message}`;
      result.auditsBlocked++;
      continue;
    }
    if (auditRunBlockedReason(src, run, allowed)) { result.auditsBlocked++; continue; }
    try {
      const bag = await downloadArtifactBag(src, a);
      importAuditPackage(bag, { projectId: src.project_id, source: "github", github: { repo: `${src.owner}/${src.repo}`, runId: a.workflow_run.id, artifactId: a.id } });
      record(a, "imported", "");
      result.audits++;
    } catch (e) {
      if (e instanceof PackageError) { record(a, "rejected", e.message); result.auditsRejected++; } // never importable as it is: not retried
      else result.error ??= `Audit package ${a.name}: ${(e as Error).message}`; // possibly temporary: tried again next time
    }
  }
}

let running = false;

/** Checks every source that has automatic import switched on. Overlapping calls are ignored. */
export async function checkAll(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const src of db.prepare("SELECT * FROM github_sources WHERE auto_import = 1").all() as GithubSource[]) await checkSource(src);
  } finally {
    running = false;
  }
}

/** Starts the background check: every TESTBENCH_POLL_MINUTES (default 5; 0 turns it off), and once shortly after start. */
export function startAutoImport() {
  const minutes = Number(process.env.TESTBENCH_POLL_MINUTES ?? 5);
  if (!(minutes > 0)) return;
  setTimeout(() => void checkAll(), 15_000).unref();
  setInterval(() => void checkAll(), Math.max(0.1, minutes) * 60_000).unref();
}
