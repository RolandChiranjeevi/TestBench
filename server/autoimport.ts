import { db } from "./db.ts";
import { importRun, listRuns, type GithubSource } from "./importers/github.ts";

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
  error: string | null;
}

const markSeen = (sourceId: number, runId: number, outcome: string, note: string) =>
  db.prepare("INSERT OR REPLACE INTO github_seen (source_id, run_id, outcome, note) VALUES (?, ?, ?, ?)").run(sourceId, runId, outcome, note);

/** Imports the source's finished workflow runs that appeared since automatic import was switched on. */
export async function checkSource(src: GithubSource): Promise<CheckResult> {
  const result: CheckResult = { imported: 0, skipped: 0, waiting: 0, error: null };
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
  db.prepare("UPDATE github_sources SET last_checked_at = datetime('now'), last_error = ? WHERE id = ?").run(result.error ?? "", src.id);
  return result;
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
