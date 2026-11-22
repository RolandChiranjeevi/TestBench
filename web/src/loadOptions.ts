// The choices of a load test request and the result an agent hands in. They mirror server/loadtest.ts (LOAD_LIMITS, DEFAULT_LOAD_OPTIONS, isLocalHost, the shape of the result): the
// test test/web-loadoptions.test.ts keeps the two in step. The choices are a PRESELECTION for the agent's one confirmation and a ceiling for what it may report, never a permission.

export const LOAD_VUS = [5, 10, 25, 50] as const;
export const LOAD_DURATIONS = [30, 60, 120] as const;
export const LOAD_RAMPS = [0, 10, 30] as const;
export const LOAD_ERROR_RATES = [1, 5, 10] as const;
export const LOAD_P95S = [1000, 2000, 5000] as const;
export const LOAD_PATHS_MAX = 10;

export interface LoadOptions {
  vus: number; durationSeconds: number; rampUpSeconds: number; paths: string[]; maxErrorRatePercent: number; maxP95Ms: number | null;
}
export const DEFAULT_LOAD: LoadOptions = { vus: 10, durationSeconds: 60, rampUpSeconds: 10, paths: ["/"], maxErrorRatePercent: 5, maxP95Ms: null };

export interface LoadTotals { requests: number; errors: number; errorRate: number; rps: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number }
export interface LoadPathResult extends LoadTotals { path: string; statuses: Record<string, number> }
export interface LoadResult {
  version: 1;
  outcome: "completed" | "stopped_error_rate" | "stopped_p95" | "stopped_by_agent";
  startedAt: string; endedAt: string;
  params: { vus: number; durationSeconds: number; rampUpSeconds: number; paths: string[] };
  totals: LoadTotals; paths: LoadPathResult[];
  timeline: { t: number; vus: number; requests: number; errors: number; p95Ms: number }[];
  verdict: "pass" | "warning" | "fail"; verdictReason: string;
}

/** One path to a line in the box, the way a person types them: blanks and repeats left out. */
export const parsePaths = (text: string): string[] => [...new Set(text.split("\n").map((l) => l.trim()).filter(Boolean))];

/** The same list as the server's: localhost, *.localhost, *.local, ::1, 127/8, 10/8, 172.16/12 and 192.168/16. Only a hint on screen: the server decides. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
/** null while the address is empty or not an address yet (the form says nothing then); otherwise whether it is one the server accepts. */
export function addressIsLocal(address: string): boolean | null {
  try {
    return isLocalHost(new URL(address.trim()).hostname);
  } catch {
    return null;
  }
}

/** What stops the request from being made, or null. The server checks the same things. */
export function loadProblem(o: LoadOptions, address: string): string | null {
  if (!address.trim()) return "Give the address to test";
  if (addressIsLocal(address) === false) return "A load test can only be asked for a local or private address for now (localhost, 127.x, 10.x, 172.16-31.x, 192.168.x or a .local name)";
  if (o.paths.length === 0) return "Give at least one path";
  if (o.paths.length > LOAD_PATHS_MAX) return `At most ${LOAD_PATHS_MAX} paths`;
  const bad = o.paths.find((p) => !p.startsWith("/") || p.startsWith("//") || /[\s\\#]/.test(p) || p.length > 200);
  if (bad !== undefined) return `The path "${bad.slice(0, 40)}" must start with a single / and have no spaces or #`;
  if (o.rampUpSeconds > o.durationSeconds / 2) return "The ramp-up can be at most half of the duration";
  return null;
}

/** The choices on one line, for the request card. */
export const loadSummary = (o: LoadOptions): string =>
  `${o.vus} users · ${o.durationSeconds} s (ramp-up ${o.rampUpSeconds} s) · ${o.paths.length} ${o.paths.length === 1 ? "path" : "paths"} · stop at ${o.maxErrorRatePercent} % errors${o.maxP95Ms ? ` or p95 ${o.maxP95Ms} ms` : ""}`;

export const VERDICT: Record<LoadResult["verdict"], { tone: "ok" | "warn" | "fail"; label: string }> = {
  pass: { tone: "ok", label: "Pass" }, warning: { tone: "warn", label: "Warning" }, fail: { tone: "fail", label: "Fail" },
};
export const OUTCOME: Record<LoadResult["outcome"], string> = {
  completed: "Ran to the end", stopped_error_rate: "Stopped: too many errors", stopped_p95: "Stopped: too slow (p95)", stopped_by_agent: "Stopped by the agent",
};

/** Seconds of a test that ran, from its own timestamps (0 if they cannot be read). */
export const ranSeconds = (r: Pick<LoadResult, "startedAt" | "endedAt">): number => Math.max(0, Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000)) || 0;

const ms = (n: number) => `${Math.round(n)} ms`;
const pct = (n: number) => `${Math.round(n * 100) / 100} %`;
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The report as Markdown, to paste into a bug or a message. Text from the agent (the reason, the paths) is escaped for a table and kept to one line. */
export function loadReportMarkdown(request: { id: number; name: string; targetUrl: string; environment: string }, r: LoadResult): string {
  const v = VERDICT[r.verdict];
  const rows = r.paths.map((p) => `| ${cell(p.path)} | ${p.requests} | ${pct(p.errorRate)} | ${ms(p.p50Ms)} | ${ms(p.p95Ms)} | ${ms(p.p99Ms)} | ${Math.round(p.rps * 10) / 10} |`);
  return [
    `# Load test, request #${request.id}${request.name ? ` · ${cell(request.name)}` : ""}`,
    "",
    `**${v.label}**: ${cell(r.verdictReason)}`,
    "",
    `- Address: ${request.targetUrl}${request.environment ? ` (${cell(request.environment)})` : ""}`,
    `- Result: ${OUTCOME[r.outcome]}, ran ${ranSeconds(r)} s of ${r.params.durationSeconds} s`,
    `- Load: ${r.params.vus} users, ramp-up ${r.params.rampUpSeconds} s`,
    `- Total: ${r.totals.requests} requests, ${pct(r.totals.errorRate)} errors, ${Math.round(r.totals.rps * 10) / 10} requests/s`,
    `- Response time: p50 ${ms(r.totals.p50Ms)}, p95 ${ms(r.totals.p95Ms)}, p99 ${ms(r.totals.p99Ms)}, max ${ms(r.totals.maxMs)}`,
    "",
    "| Path | Requests | Errors | p50 | p95 | p99 | Req/s |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
  ].join("\n");
}
