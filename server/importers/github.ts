import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { bagFromZip, dedupeReports, mergeBags, readReports, type FileBag } from "./bag.ts";
import { importReport, mergeReports, type ImportResult } from "./import.ts";
import type { ParsedReport } from "./parse.ts";

const MAX_ARTIFACT_BYTES = 200 * 1024 * 1024;

/** `owner/repo` as written on GitHub. "." and ".." segments are rejected: URL resolution would turn them into other API paths. */
export const REPO_SLUG = /^(?!\.{1,2}\/)[\w.-]+\/(?!\.{1,2}$)[\w.-]+$/;

export interface GithubSource {
  id: number;
  project_id: number;
  owner: string;
  repo: string;
  workflow: string;
  artifact_pattern: string;
  /** Automatic import: 1 when on, and the moment it was switched on (older runs are left alone). */
  auto_import: number;
  auto_since: string | null;
  /** Comma-separated branch names or patterns such as `main, release/*`; empty means all branches. */
  branch_filter: string;
  /** Sprint or release given to runs imported from this source. */
  default_milestone: string;
  last_checked_at: string | null;
  last_error: string;
}

let cachedToken: string | null = null;

/** GITHUB_TOKEN if set, otherwise the token from a logged-in `gh` CLI. Never persisted. */
export async function getToken(): Promise<string | null> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (cachedToken) return cachedToken;
  try {
    const { stdout } = await promisify(execFile)("gh", ["auth", "token"], { timeout: 5000 });
    cachedToken = stdout.trim() || null;
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

async function gh<T>(path: string): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error("No GitHub token: set GITHUB_TOKEN or run `gh auth login`");
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

const repoPath = (s: GithubSource) => `/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}`;

export interface WorkflowRun {
  id: number;
  name: string;
  display_title: string;
  run_number: number;
  head_branch: string;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  html_url: string;
}

export async function listRuns(src: GithubSource): Promise<WorkflowRun[]> {
  const base = src.workflow
    ? `${repoPath(src)}/actions/workflows/${encodeURIComponent(src.workflow)}/runs`
    : `${repoPath(src)}/actions/runs`;
  const data = await gh<{ workflow_runs: WorkflowRun[] }>(`${base}?per_page=25`);
  return data.workflow_runs;
}

interface Artifact { id: number; name: string; size_in_bytes: number; expired: boolean }

function matchesPattern(name: string, pattern: string) {
  if (!pattern.trim()) return true;
  return pattern.split(",").some((p) => {
    const re = new RegExp("^" + p.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
    return re.test(name);
  });
}

/**
 * How many usable (unexpired, matching the artifact pattern) artifacts each recent workflow run uploaded, keyed by run id.
 * One API call covers the latest 100 artifacts, which is enough for the runs the Import page lists.
 */
export async function artifactsByRun(src: GithubSource): Promise<Map<number, number>> {
  const { artifacts } = await gh<{ artifacts: (Artifact & { workflow_run?: { id: number } })[] }>(`${repoPath(src)}/actions/artifacts?per_page=100`);
  const counts = new Map<number, number>();
  for (const a of artifacts) {
    if (a.expired || !a.workflow_run || !matchesPattern(a.name, src.artifact_pattern)) continue;
    counts.set(a.workflow_run.id, (counts.get(a.workflow_run.id) ?? 0) + 1);
  }
  return counts;
}

export async function importRun(src: GithubSource, runId: number): Promise<ImportResult & { artifacts: string[] }> {
  const run = await gh<WorkflowRun>(`${repoPath(src)}/actions/runs/${runId}`);
  const { artifacts } = await gh<{ artifacts: Artifact[] }>(`${repoPath(src)}/actions/runs/${runId}/artifacts?per_page=100`);
  const usable = artifacts.filter((a) => !a.expired && a.size_in_bytes <= MAX_ARTIFACT_BYTES && matchesPattern(a.name, src.artifact_pattern));
  if (!usable.length) throw new Error("This run has no matching, unexpired artifacts");

  const token = await getToken();
  const reports: ParsedReport[] = [];
  const bags: FileBag[] = [];
  for (const artifact of usable) {
    // GitHub redirects to a signed blob URL; fetch drops the auth header on the cross-origin hop.
    const res = await fetch(`https://api.github.com${repoPath(src)}/actions/artifacts/${artifact.id}/zip`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`Downloading artifact "${artifact.name}" failed: ${res.status}`);
    // Keep the whole artifact (lazily read) so screenshots, videos and traces can be matched to their tests.
    const bag = bagFromZip(new Uint8Array(await res.arrayBuffer()));
    bags.push(bag);
    reports.push(...readReports(bag));
  }
  if (!reports.length) {
    throw new Error("No JUnit XML or Playwright JSON reports found in the artifacts. Upload them with actions/upload-artifact.");
  }

  const result = importReport(
    mergeReports(dedupeReports(reports)),
    {
      projectId: src.project_id,
      source: "github",
      externalId: `${src.owner}/${src.repo}#${run.id}`,
      title: `${run.name} #${run.run_number}`,
      environment: run.head_branch,
      milestone: src.default_milestone,
      meta: {
        url: run.html_url,
        repo: `${src.owner}/${src.repo}`,
        branch: run.head_branch,
        sha: run.head_sha,
        event: run.event,
        conclusion: run.conclusion,
        commit: run.display_title,
      },
    },
    mergeBags(bags),
  );
  return { ...result, artifacts: usable.map((a) => a.name) };
}
