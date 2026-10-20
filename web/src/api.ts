export type Status = "untested" | "passed" | "failed" | "blocked" | "skipped";
export type Priority = "low" | "medium" | "high" | "critical";

export interface Project { id: number; name: string; key: string; case_count: number; run_count: number }
export interface Suite { id: number; project_id: number; parent_id: number | null; name: string; description: string; position: number; case_count: number }
export interface Step { id?: number; action: string; expected: string }
export interface CaseSummary {
  id: number; project_id: number; suite_id: number | null; number: number; title: string; priority: Priority;
  status: "draft" | "ready" | "deprecated"; tags: string[]; suite_name: string | null; automated_count: number;
  step_count: number; last_status: Status | null; updated_at: string; requirement_count?: number;
}
export type CoverageState = "uncovered" | "failing" | "passing" | "partial" | "untested";
export interface Coverage { state: CoverageState; cases: number; passing: number; failing: number; notRun: number }
export type RequirementStatus = "draft" | "approved" | "deprecated";
export interface RequirementRef { id: number; number: number; title: string; status: RequirementStatus; priority: Priority; review_needed: boolean }
export interface RequirementAttachment { id: number; filename: string; stored_name: string; mime: string; size: number; created_at: string }
export interface RevisionChange { field: string; from?: string; to?: string; added?: number[]; removed?: number[] }
export interface RequirementRevision { id: number; at: string; material: boolean; changes: RevisionChange[] }
export interface Requirement {
  id: number; project_id: number; number: number; title: string; description: string; priority: Priority; status: RequirementStatus;
  source: string; created_at: string; updated_at: string; caseIds: number[]; activeCaseIds: number[]; coverage: Coverage; reviewCount: number; attachmentCount: number;
}
export interface RequirementDetail extends Omit<Requirement, "caseIds" | "activeCaseIds" | "reviewCount"> {
  cases: { id: number; number: number; title: string; priority: Priority; status: CaseSummary["status"]; suite_name: string | null; last_status: Status | null; review_needed: boolean }[];
  history: RequirementRevision[];
  attachments: RequirementAttachment[];
}
export interface AutomatedTest {
  id: number; framework: string; file: string; suite_path: string; title: string; full_name: string; case_id: number | null;
  last_status: Status | null; last_seen: string; case_number?: number | null; case_title?: string | null;
  run_count?: number; fail_count?: number; flaky_count?: number; avg_duration_ms?: number | null;
}
export interface HistoryEntry { id: number; status: Status; flaky: number; duration_ms: number | null; executed_at: string | null; run_id: number; run_title: string; kind: string; started_at: string }
export interface CaseDetail extends CaseSummary {
  description: string; preconditions: string; project_key: string; steps: Required<Step>[]; automated: AutomatedTest[]; history: HistoryEntry[];
  edited_since?: boolean; requirements: RequirementRef[];
}
export interface Counts { total: number; passed: number; failed: number; blocked: number; skipped: number; untested: number; flaky: number; duration_ms: number }
export interface RunSummary extends Counts {
  id: number; title: string; kind: "manual" | "automated"; source: "manual" | "upload" | "github"; status: "in_progress" | "completed";
  environment: string; milestone: string; framework: string | null; meta: Record<string, any>; started_at: string; finished_at: string | null;
}
export interface RunResult {
  id: number; case_id: number | null; automated_test_id: number | null; status: Status; flaky: number; duration_ms: number | null;
  error: string; notes: string; jira_key: string | null; attachment_count: number; has_detail: number; executed_at: string | null; case_number: number | null; case_title: string | null; case_priority: Priority | null;
  suite_name: string | null; test_title: string | null; test_file: string | null; test_suite_path: string | null; test_full_name: string | null; step_count: number;
}
export interface RunDetail extends Omit<RunSummary, keyof Counts> { project_key: string; counts: Counts; results: RunResult[] }
export interface Attachment { id: number; filename: string; stored_name: string; mime: string }
export interface ResultDetail extends RunResult {
  case: CaseDetail | null;
  stepResults: { step_id: number; status: Status; actual: string }[];
  attachments: Attachment[];
}
export interface SourceLocation { file: string; line: number; column: number }
export interface AttemptDetail {
  retry: number; status: string; durationMs: number | null; startTime: string | null;
  errors: { message: string; location?: SourceLocation }[]; stdout: string; stderr: string;
}
export interface EvidenceFile { id: number; filename: string; stored_name: string; mime: string; attempt: number | null; label: string | null }
/** Everything known about one automated result: attempts, evidence files and how the same test did in earlier runs. */
export interface AutomatedResultDetail {
  id: number; run_id: number; case_id: number | null; case_number: number | null; automated_test_id: number | null; status: Status; flaky: number;
  duration_ms: number | null; error: string; jira_key: string | null; project_key: string;
  test_title: string | null; test_full_name: string | null; test_file: string | null; test_suite_path: string | null; framework: string | null;
  run_title: string; environment: string; milestone: string; started_at: string; meta: Record<string, any>;
  detail: { attempts: AttemptDetail[]; annotations: { type: string; description?: string }[]; location?: SourceLocation; projectName?: string } | null;
  attachments: EvidenceFile[];
  history: { id: number; status: Status; flaky: number; duration_ms: number | null; run_id: number; run_title: string; started_at: string }[];
}
export interface GithubSource {
  id: number; owner: string; repo: string; workflow: string; artifact_pattern: string;
  auto_import: number; auto_since: string | null; branch_filter: string; default_milestone: string; last_checked_at: string | null; last_error: string;
  imported_count?: number; skipped_count?: number; last_skip_note?: string | null;
}
export interface CheckResult { imported: number; skipped: number; waiting: number; error: string | null; source: GithubSource }
export interface WorkflowRun {
  id: number; name: string; display_title: string; run_number: number; head_branch: string; event: string;
  status: string; conclusion: string | null; created_at: string; html_url: string; imported_run_id: number | null;
  /** Test artifacts this run uploaded (null = unknown). 0 means there is nothing to import. */
  artifact_count: number | null;
}
export interface BackupInfo {
  projects: number; cases: number; runs: number; dbBytes: number; uploadFiles: number; uploadBytes: number;
  lastBackupAt: string | null; previousCopies: string[];
}
export interface RestoreSummary { projects: number; cases: number; runs: number; uploadFiles: number; previous: string }
export interface ImportResult { runId: number; duplicate: boolean; total: number; linked: number; attachments: number; artifacts?: string[] }

export interface Milestone {
  id: number; project_id: number; name: string; kind: "sprint" | "release"; start_date: string | null; end_date: string | null; run_count: number;
}
export interface ChecklistItem { id: number; milestone_id: number; position: number; title: string; done_at: string | null; source: string }
export interface RunTemplate {
  id: number; project_id: number; name: string; environment: string; created_at: string; updated_at: string;
  run_count: number; last_used: string | null; caseIds: number[];
}
export interface DashboardRun extends Counts {
  id: number; title: string; started_at: string; framework: string | null; milestone: string; run_status: string; rate: number | null;
}
export interface TestStat { id: number; title: string; file: string; framework: string; last_status: Status | null; case_number: number | null; runs: number; failures: number; flaky: number; avg_ms: number | null }
export interface FlakyTest {
  testId: number; title: string; file: string; framework: string; caseNumber: number | null;
  runs: number; failures: number; retries: number; flips: number; events: number; failingNow: boolean; lastEventRunId: number;
  strip: { status: Status; flaky: boolean; runId: number; runTitle: string; startedAt: string }[];
}
export interface Slowdown { testId: number; title: string; file: string; caseNumber: number | null; beforeMs: number; recentMs: number; deltaMs: number; pct: number; runId: number }
/** A manual case with no automated test, ranked by how much automating it would pay off. */
export interface Candidate {
  id: number; number: number; title: string; priority: Priority; suite: string | null; executions: number; fails: number; lastManual: string | null; score: number; reasons: string[];
}
export interface Insights {
  window: number;
  runs: { id: number; title: string; started_at: string; duration_ms: number; tests: number; failed: number }[];
  flaky: FlakyTest[]; flakyTotal: number; slowdowns: Slowdown[]; candidates: Candidate[]; candidatesTotal: number;
}
export interface Dashboard {
  requirements: { total: number; covered: number; passing: number; failing: number; uncovered: number };
  candidates: Candidate[];
  candidatesTotal: number;
  project: { id: number; name: string; key: string };
  summary: {
    cases: number; automatedCases: number; coverage: number; automatedTests: number; unlinkedTests: number; latestRate: number | null;
    previousRate: number | null; flakyTests: number; failingCases: number; openManualRuns: number;
  };
  automatedRuns: DashboardRun[];
  manualRuns: DashboardRun[];
  mostFailing: TestStat[];
  flaky: TestStat[];
  slowest: TestStat[];
  failingCases: { id: number; number: number; title: string; priority: Priority; suite_name: string | null; status: Status; executed_at: string; run_title: string }[];
  bySuite: { name: string; cases: number; automated: number }[];
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "X-Testbench": "1" };
  const init: RequestInit = { method, headers };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  patch: <T>(url: string, body: unknown) => request<T>("PATCH", url, body),
  put: <T>(url: string, body: unknown) => request<T>("PUT", url, body),
  del: <T>(url: string) => request<T>("DELETE", url),
};

// ---------- formatting ----------

/** SQLite datetime('now') strings are UTC without a zone marker. */
export function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

export function timeAgo(s: string | null | undefined): string {
  const d = parseDate(s);
  if (!d) return "—";
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export function formatDateTime(s: string | null | undefined): string {
  const d = parseDate(s);
  return d ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${Math.round(s % 60)}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const passRate = (c: Pick<Counts, "passed" | "failed" | "blocked">) => {
  const executed = c.passed + c.failed + c.blocked;
  return executed ? Math.round((c.passed / executed) * 100) : null;
};
