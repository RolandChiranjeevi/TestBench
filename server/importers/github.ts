import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { bagFromZip, dedupeReports, mergeBags, readReports, type FileBag } from "./bag.ts";
import { importReport, mergeReports, type ImportResult } from "./import.ts";
import { isAuditArtifactName, PackageError } from "./auditpackage.ts";
import { linkAuditsToRun } from "../audits.ts";
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
  /** Workflow ids or file names (comma separated) that may deliver audit packages. Empty means none, never "all". */
  audit_workflows: string;
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
export interface AuditArtifact extends Artifact { created_at: string; workflow_run: { id: number; head_branch?: string } }

/**
 * Audit packages (artifacts named testbench-audit-*) among the repository's 100 most recent artifacts. GitHub lists artifacts newest first
 * and this does not page further, so a package older than the newest 100 artifacts is not found. Expired ones cannot be downloaded.
 */
export async function listAuditArtifacts(src: GithubSource): Promise<AuditArtifact[]> {
  const { artifacts } = await gh<{ artifacts: (Artifact & { created_at: string; workflow_run?: { id: number; head_branch?: string } })[] }>(`${repoPath(src)}/actions/artifacts?per_page=100`);
  return artifacts.filter((a) => isAuditArtifactName(a.name) && a.workflow_run).map((a) => ({ ...a, workflow_run: a.workflow_run! }));
}

export const MAX_AUDIT_ARTIFACT_BYTES = MAX_ARTIFACT_BYTES;

/** A workflow given by id (`12345`) or by file name (`audit.yml`; a leading `.github/workflows/` is accepted and dropped). */
const WORKFLOW_ENTRY = /^(\d+|[\w.-]+\.ya?ml)$/i;

/** Splits the stored list. Throws on an entry that is neither an id nor a file name, so a typo is not silently "no workflow". */
export function parseWorkflowList(text: string): string[] {
  const entries = text.split(/[,\s]+/).map((s) => s.trim().replace(/^\.github\/workflows\//, "")).filter(Boolean);
  for (const e of entries) if (!WORKFLOW_ENTRY.test(e)) throw new Error(`"${e}" is not a workflow id or a workflow file name such as audit.yml`);
  return [...new Set(entries)];
}

/** What the audit check needs to know about the run an artifact came from. */
export interface RunInfo { id: number; workflowId: number; workflowFile: string; repo: string }

/** The run that uploaded an artifact. The artifact list does not say which workflow that was, so it is asked for here. */
export async function getRunInfo(src: GithubSource, runId: number): Promise<RunInfo> {
  const r = await gh<{ id: number; workflow_id?: number; path?: string; head_repository?: { full_name?: string } | null }>(`${repoPath(src)}/actions/runs/${runId}`);
  // `path` is `.github/workflows/audit.yml`, and can carry an `@ref` suffix.
  const file = (r.path ?? "").split("@")[0].split("/").pop() ?? "";
  return { id: r.id, workflowId: Number(r.workflow_id ?? 0), workflowFile: file, repo: r.head_repository?.full_name ?? "" };
}

/** Why the run may not deliver audit packages for this source, or null when it may. */
export function auditRunBlockedReason(src: GithubSource, run: RunInfo, allowed: string[]): string | null {
  if (run.repo.toLowerCase() !== `${src.owner}/${src.repo}`.toLowerCase()) return `run ${run.id} comes from ${run.repo || "an unknown repository"}, not ${src.owner}/${src.repo}`;
  const ok = allowed.some((w) => (/^\d+$/.test(w) ? Number(w) === run.workflowId : w.toLowerCase() === run.workflowFile.toLowerCase()));
  return ok ? null : `run ${run.id} belongs to workflow ${run.workflowFile || run.workflowId}, which is not in the allowed list (${allowed.join(", ")})`;
}

/** Downloads one artifact. A zip that cannot be read is the package's fault (PackageError); any other failure may be temporary. */
export async function downloadArtifactBag(src: GithubSource, artifact: { id: number; name: string }): Promise<FileBag> {
  const token = await getToken();
  const res = await fetch(`https://api.github.com${repoPath(src)}/actions/artifacts/${artifact.id}/zip`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`Downloading artifact "${artifact.name}" failed: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  try {
    return bagFromZip(bytes);
  } catch {
    throw new PackageError(`Artifact "${artifact.name}" is not a readable zip file`);
  }
}

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
    if (a.expired || !a.workflow_run || isAuditArtifactName(a.name) || !matchesPattern(a.name, src.artifact_pattern)) continue;
    counts.set(a.workflow_run.id, (counts.get(a.workflow_run.id) ?? 0) + 1);
  }
  return counts;
}

export async function importRun(src: GithubSource, runId: number): Promise<ImportResult & { artifacts: string[] }> {
  const run = await gh<WorkflowRun>(`${repoPath(src)}/actions/runs/${runId}`);
  const { artifacts } = await gh<{ artifacts: Artifact[] }>(`${repoPath(src)}/actions/runs/${runId}/artifacts?per_page=100`);
  // Audit packages are read separately (see autoimport.ts); their files must not be taken for test reports.
  const usable = artifacts.filter((a) => !a.expired && !isAuditArtifactName(a.name) && a.size_in_bytes <= MAX_ARTIFACT_BYTES && matchesPattern(a.name, src.artifact_pattern));
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
  // Audit packages that arrived before this run was imported can be linked to it now.
  linkAuditsToRun(src.project_id, `${src.owner}/${src.repo}#${run.id}`, result.runId);
  return { ...result, artifacts: usable.map((a) => a.name) };
}
