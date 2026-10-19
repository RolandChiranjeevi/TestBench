export type Status = "untested" | "passed" | "failed" | "blocked" | "skipped";
export type Priority = "low" | "medium" | "high" | "critical";

export interface Project { id: number; name: string; key: string; case_count: number; run_count: number }
export interface Suite { id: number; project_id: number; parent_id: number | null; name: string; description: string; position: number; case_count: number }
export interface Step { id?: number; action: string; expected: string }
export interface CaseSummary {
  id: number; project_id: number; suite_id: number | null; number: number; title: string; priority: Priority;
  status: "draft" | "ready" | "deprecated"; tags: string[]; suite_name: string | null; automated_count: number;
  step_count: number; last_status: Status | null; updated_at: string;
}
export interface AutomatedTest {
  id: number; framework: string; file: string; suite_path: string; title: string; full_name: string; case_id: number | null;
  last_status: Status | null; last_seen: string; case_number?: number | null; case_title?: string | null;
  run_count?: number; fail_count?: number; flaky_count?: number; avg_duration_ms?: number | null;
}
export interface HistoryEntry { id: number; status: Status; flaky: number; duration_ms: number | null; executed_at: string | null; run_id: number; run_title: string; kind: string; started_at: string }
export interface CaseDetail extends CaseSummary {
  description: string; preconditions: string; project_key: string; steps: Required<Step>[]; automated: AutomatedTest[]; history: HistoryEntry[];
}
export interface Counts { total: number; passed: number; failed: number; blocked: number; skipped: number; untested: number; flaky: number; duration_ms: number }
export interface RunSummary extends Counts {
  id: number; title: string; kind: "manual" | "automated"; source: "manual" | "upload" | "github"; status: "in_progress" | "completed";
  environment: string; milestone: string; framework: string | null; meta: Record<string, any>; started_at: string; finished_at: string | null;
}
export interface RunResult {
  id: number; case_id: number | null; automated_test_id: number | null; status: Status; flaky: number; duration_ms: number | null;
  error: string; notes: string; executed_at: string | null; case_number: number | null; case_title: string | null; case_priority: Priority | null;
  suite_name: string | null; test_title: string | null; test_file: string | null; test_suite_path: string | null; test_full_name: string | null; step_count: number;
}
export interface RunDetail extends Omit<RunSummary, keyof Counts> { project_key: string; counts: Counts; results: RunResult[] }
export interface Attachment { id: number; filename: string; stored_name: string; mime: string }
export interface ResultDetail extends RunResult {
  case: CaseDetail | null;
  stepResults: { step_id: number; status: Status; actual: string }[];
  attachments: Attachment[];
}
export interface GithubSource { id: number; owner: string; repo: string; workflow: string; artifact_pattern: string }
export interface WorkflowRun {
  id: number; name: string; display_title: string; run_number: number; head_branch: string; event: string;
  status: string; conclusion: string | null; created_at: string; html_url: string; imported_run_id: number | null;
}
export interface ImportResult { runId: number; duplicate: boolean; total: number; linked: number; artifacts?: string[] }

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
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
