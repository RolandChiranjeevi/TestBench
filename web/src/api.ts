import type { Automation, LastAutomated, RunSuiteInfo } from "./automation";

export type Status = "untested" | "passed" | "failed" | "blocked" | "skipped";
export type Priority = "low" | "medium" | "high" | "critical";

/** `role` is the person's role in the project (the owner is an admin everywhere); the server sends it with the list. */
export interface Project { id: number; name: string; key: string; case_count: number; run_count: number; role?: "admin" | "tester" | "viewer" }
/** A FOLDER of the test case tree (table `suites`). It only organises cases and cannot be run; a runnable group of cases is a RunTemplate, which the app calls a Suite. */
export interface Suite { id: number; project_id: number; parent_id: number | null; name: string; description: string; position: number; case_count: number }
/** Folders in the order the tree shows them: each folder followed by its children, siblings by position. */
export function orderSuites<T extends { id: number; parent_id: number | null }>(suites: T[]): T[] {
  const out: T[] = [];
  const walk = (parent: number | null) => {
    for (const s of suites) if (s.parent_id === parent) { out.push(s); walk(s.id); }
  };
  walk(null);
  for (const s of suites) if (!out.includes(s)) out.push(s);
  return out;
}
export interface Step { id?: number; action: string; expected: string }
export interface CaseSummary {
  id: number; project_id: number; suite_id: number | null; number: number; title: string; priority: Priority;
  status: "draft" | "ready" | "deprecated"; tags: string[]; suite_name: string | null; automated_count: number;
  step_count: number; last_status: Status | null; updated_at: string; requirement_count?: number;
  /** Created in the last 7 days, and made from an agent proposal. Only the list has them. */
  created_at?: string; is_new?: boolean; from_proposal?: boolean;
}
export type CoverageState = "uncovered" | "failing" | "passing" | "partial" | "untested";
export interface Coverage { state: CoverageState; cases: number; passing: number; failing: number; notRun: number }
export type RequirementStatus = "draft" | "approved" | "deprecated";
export interface RequirementRef { id: number; number: number; title: string; status: RequirementStatus; priority: Priority; review_needed: boolean }
export interface RequirementAttachment { id: number; filename: string; stored_name: string; mime: string; size: number; created_at: string }
export interface RevisionChange { field: string; from?: string; to?: string; added?: number[]; removed?: number[] }
/** `by` is the display name a person had set in Settings when they made the change: as typed (the name of the account, once there are accounts). */
export interface RequirementRevision { id: number; at: string; by: string; material: boolean; changes: RevisionChange[] }
export type RequirementKind = "functional" | "accessibility" | "responsive" | "security_privacy" | "business_rule" | "usability";
export interface Viewport { device?: string; width?: number; height?: number; breakpoint?: string }
/** What is linked to a requirement besides test cases, and whether the latest audit run touched it. Only a person's decisions count as coverage. */
export interface RequirementLinks {
  manualTests: { accepted: number; proposed: number }; bugs: { open: number; proposed: number }; cases: number; withoutTest: boolean;
  audit: "referenced" | "not_referenced" | "no_audit";
}
/** Where a requirement came from. Only a person makes a human one; an AI suggestion exists only after a person approved the proposal. */
export type RequirementOrigin = "human" | "import" | "ai_suggestion";
export interface Requirement {
  origin: RequirementOrigin; acceptance_criteria: string; created_by: string; approved_by: string; approved_at: string | null;
  id: number; project_id: number; number: number; title: string; description: string; priority: Priority; status: RequirementStatus;
  source: string; kind: RequirementKind; external_id: string | null; wcag: string[]; viewports: Viewport[]; links: RequirementLinks;
  created_at: string; updated_at: string; caseIds: number[]; activeCaseIds: number[]; coverage: Coverage; reviewCount: number; attachmentCount: number;
}
export interface RequirementDetail extends Omit<Requirement, "caseIds" | "activeCaseIds" | "reviewCount"> {
  linked: {
    manualTests: { id: number; sourceId: string; title: string; status: "proposed" | "accepted" | "rejected"; category: string; priority: Priority; testCase: string | null }[];
    bugs: { id: number; sourceId: string; title: string; status: "proposed" | "accepted" | "rejected" | "duplicate"; severity: Priority | null }[];
    /** Planned in the test plan of an audit. A plan, not a test: it never makes a requirement covered. */
    planItems: { sourceId: string; title: string; type: string; risk: string; priority: string; readiness: string; auditId: number; agentAuditId: string; auditTitle: string }[];
    /** What an audit did not verify about this requirement, and why. */
    coverageGaps: { sourceId: string; description: string; auditId: number; agentAuditId: string; auditTitle: string }[];
  };
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
  /** The agent proposal this case was made from, if any. */
  proposal?: { id: number; sourceId: string; title: string; status: string } | null;
}
export interface Counts { total: number; passed: number; failed: number; blocked: number; skipped: number; untested: number; flaky: number; duration_ms: number }
export interface RunSummary extends Counts {
  id: number; title: string; kind: "manual" | "automated"; source: "manual" | "upload" | "github"; status: "in_progress" | "completed";
  environment: string; milestone: string; framework: string | null; meta: Record<string, any>; started_at: string; finished_at: string | null;
  /** The suite (a run template) the run was started from; the name is the one it had when the run started if the suite has been deleted since. */
  template_id: number | null; template_name: string | null;
}
export interface RunResult {
  id: number; case_id: number | null; automated_test_id: number | null; status: Status; flaky: number; duration_ms: number | null;
  error: string; notes: string; jira_key: string | null; attachment_count: number; has_detail: number; executed_at: string | null; case_number: number | null; case_title: string | null; case_priority: Priority | null;
  /** The name of the FOLDER the case is in (the table is called suites; the app says folder). */
  suite_name: string | null; test_title: string | null; test_file: string | null; test_suite_path: string | null; test_full_name: string | null; step_count: number;
  /** Manual runs only: what the automated side knows about the case. Information; nothing is started. */
  automation?: Automation; automated_tests?: number; last_automated?: LastAutomated | null;
}
export interface RunDetail extends Omit<RunSummary, keyof Counts> { project_key: string; counts: Counts; results: RunResult[]; suite: RunSuiteInfo | null }
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
  id: number; owner: string; repo: string; workflow: string; artifact_pattern: string; audit_workflows: string;
  auto_import: number; auto_since: string | null; branch_filter: string; default_milestone: string; last_checked_at: string | null; last_error: string;
  imported_count?: number; skipped_count?: number; last_skip_note?: string | null;
}
export interface CheckResult { imported: number; skipped: number; waiting: number; audits: number; auditsRejected: number; auditsBlocked: number; error: string | null; source: GithubSource }
export interface WorkflowRun {
  id: number; name: string; display_title: string; run_number: number; head_branch: string; event: string;
  status: string; conclusion: string | null; created_at: string; html_url: string; imported_run_id: number | null;
  /** Test artifacts this run uploaded (null = unknown). 0 means there is nothing to import. */
  artifact_count: number | null;
}
export interface BackupInfo {
  projects: number; cases: number; runs: number; dbBytes: number; uploadFiles: number; uploadBytes: number;
  lastBackupAt: string | null; previousCopies: string[]; lastManualBackupAt: string | null;
  auto: { enabled: boolean; dir: string; keep: number; count: number; lastAt: string | null; lastName: string | null };
}
export interface RestoreSummary { projects: number; cases: number; runs: number; uploadFiles: number; previous: string }
export interface ImportResult { runId: number; duplicate: boolean; total: number; linked: number; attachments: number; artifacts?: string[] }

export interface Milestone {
  id: number; project_id: number; name: string; kind: "sprint" | "release"; start_date: string | null; end_date: string | null; run_count: number;
}
export interface ChecklistItem { id: number; milestone_id: number; position: number; title: string; done_at: string | null; source: string }
/** A run template is what the app calls a Suite: a saved list of cases that is run as a unit. (A folder, table `suites`, only organises cases.) */
export interface RunTemplate {
  id: number; project_id: number; name: string; description: string; environment: string; created_at: string; updated_at: string;
  run_count: number; last_used: string | null; caseIds: number[]; case_count: number; last_run: SuiteRun | null;
}
/** One run of a suite, with its counts. */
export interface SuiteRun { id: number; title: string; status: "in_progress" | "completed"; started_at: string; total: number; passed: number; failed: number; blocked: number; untested: number }
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
  // Signed out (or the session expired) on an instance with a password: go to the login page.
  if (res.status === 401 && !url.startsWith("/api/login")) window.location.href = "/login";
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `${res.status} ${res.statusText}`), { status: res.status, problems: Array.isArray(data.problems) ? (data.problems as string[]) : [] });
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

export const KIND_LABEL: Record<RequirementKind, string> = {
  functional: "Functional", accessibility: "Accessibility", responsive: "Responsive", security_privacy: "Security & privacy", business_rule: "Business rule", usability: "Usability",
};

/** "390x844 iPhone 13", "320", "bp:md" per line, in the form the editor shows them. */
export function formatViewport(v: Viewport): string {
  return [v.width ? `${v.width}${v.height ? `x${v.height}` : ""}` : "", v.breakpoint ? `bp:${v.breakpoint}` : "", v.device ?? ""].filter(Boolean).join(" ");
}
export function parseViewports(text: string): Viewport[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
    const out: Viewport = {};
    const rest: string[] = [];
    for (const tok of line.split(/\s+/)) {
      const size = /^(\d{3,5})(?:x(\d{3,5}))?$/i.exec(tok);
      if (size && !out.width) { out.width = Number(size[1]); if (size[2]) out.height = Number(size[2]); }
      else if (/^bp:/i.test(tok) && !out.breakpoint) out.breakpoint = tok.slice(3);
      else rest.push(tok);
    }
    if (rest.length) out.device = rest.join(" ");
    return out;
  });
}

// ---------- Requirement proposals, coverage gaps, who is recorded ----------

export type ProposalStatus = "proposed" | "approved" | "rejected";
/** What a test agent suggested. It is not a requirement until a person approves it; rejected ones are kept with their reason. */
export interface RequirementProposal {
  id: number; title: string; description: string; acceptanceCriteria: string; rationale: string; kind: RequirementKind; suggestedPriority: Priority;
  basis: "observation" | "coverage_gap" | "prompt" | "other"; status: ProposalStatus; rejectReason: string; proposedBy: string; decidedBy: string; decidedAt: string | null;
  requirementId: number | null; requirementLabel: string | null; edited: boolean; original: Record<string, unknown>; createdAt: string;
  observations: { id: number; label: string; title: string }[]; cases: { id: number; number: number; title: string }[];
}
export interface ProposalList { counts: Record<ProposalStatus, number>; items: RequirementProposal[] }
export interface CoverageGaps {
  counts: { requirementsWithoutCases: number; casesWithoutRequirement: number; observationsWithoutLink: number };
  requirementsWithoutCases: { id: number; number: number; title: string; priority: Priority; kind: RequirementKind; origin: RequirementOrigin }[];
  casesWithoutRequirement: { id: number; number: number; title: string; priority: Priority; status: CaseSummary["status"] }[];
  observationsWithoutLink: { id: number; label: string; title: string; kind: string; severity: string; status: string }[];
}
/** What "Generate proposals" made, or in a dry run would make. The rules are fixed (no model): see server/gapproposals.ts. */
export interface GenerateResult {
  dryRun: boolean; counts: { created: number; skipped: number; notGenerated: number; more: number };
  created: { id: number | null; gap: string; rule: string; title: string }[];
  skipped: { gap: string; label: string; reason: string }[];
  notGenerated: { gap: string; label: string; title: string; reason: string }[];
}
/** The name recorded on what a person does. `source`: "account" is the name of the account signed in, "typed" the name entered in Settings. Neither is verified. */
export interface DisplayName { name: string; recordedAs: string; source: "account" | "typed" }
