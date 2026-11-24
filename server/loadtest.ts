import { AuditError } from "./auditcommon.ts";

/**
 * A load test as a request to a test agent (kind `loadtest`). A person chooses the parameters; they are a PRESELECTION for the agent's one confirmation and a CEILING for what the agent
 * may report: TestBench refuses a result that used more users, more time or other paths than were asked for. Nothing here is free text except the paths, which are checked.
 * Only GET, and only a local or private address for now (the skill's own default: never production or shared infrastructure).
 */
export const LOAD_LIMITS = {
  vus: [5, 10, 25, 50],
  durationSeconds: [30, 60, 120],
  rampUpSeconds: [0, 10, 30],
  maxErrorRatePercent: [1, 5, 10],
  maxP95Ms: [1000, 2000, 5000],
  pathsMax: 10,
  pathMax: 200,
  timelineMax: 300,
  /** The result handed in: at most 1 MB, and at most 10 a minute per token (every attempt counts). */
  bodyBytes: 1024 * 1024,
  perMinute: 10,
} as const;

export interface LoadOptions {
  vus: number;
  durationSeconds: number;
  rampUpSeconds: number;
  paths: string[];
  /** The test stops when this share of the requests fail. */
  maxErrorRatePercent: number;
  /** The test stops when p95 passes this many milliseconds; null = no such limit. */
  maxP95Ms: number | null;
}
export const DEFAULT_LOAD_OPTIONS: LoadOptions = { vus: 10, durationSeconds: 60, rampUpSeconds: 10, paths: ["/"], maxErrorRatePercent: 5, maxP95Ms: null };

const bad = (message: string) => new AuditError(400, message);
const SECRET_KEY = /pass|token|secret|key|auth|cookie|session/i;

/** localhost, *.localhost, *.local, ::1, 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16. A name that points somewhere else is refused: that is the safe side. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function cleanPath(v: unknown): string {
  if (typeof v !== "string") throw bad("Every path must be text");
  const p = v.trim();
  if (!p.startsWith("/") || p.startsWith("//")) throw bad(`The path "${p.slice(0, 40)}" must start with a single /`);
  if (p.length > LOAD_LIMITS.pathMax) throw bad(`A path can be at most ${LOAD_LIMITS.pathMax} characters`);
  if (/[\s\u0000-\u001f\\#]/.test(p)) throw bad(`The path "${p.slice(0, 40)}" cannot hold spaces, control characters, a backslash or #`);
  for (const k of new URL(p, "http://x").searchParams.keys()) if (SECRET_KEY.test(k)) throw bad(`The path "${p.slice(0, 40)}" has "${k}" in its query, which looks like a secret. Leave it out`);
  return p;
}

/** The parameters of a load test, checked and with the defaults filled in. Anything unknown or out of range is refused. */
export function cleanLoadOptions(input: unknown): LoadOptions {
  if (input === undefined || input === null) return { ...DEFAULT_LOAD_OPTIONS, paths: [...DEFAULT_LOAD_OPTIONS.paths] };
  if (typeof input !== "object" || Array.isArray(input)) throw bad("loadOptions must be an object");
  const o = input as Record<string, unknown>;
  const known = ["vus", "durationSeconds", "rampUpSeconds", "paths", "maxErrorRatePercent", "maxP95Ms"];
  const unknownKey = Object.keys(o).find((k) => !known.includes(k));
  if (unknownKey) throw bad(`Unknown load option "${unknownKey.slice(0, 40)}". The options are ${known.join(", ")}`);
  const one = (v: unknown, what: string, allowed: readonly number[], fallback: number): number => {
    if (v === undefined) return fallback;
    if (typeof v !== "number" || !allowed.includes(v)) throw bad(`${what} must be one of ${allowed.join(", ")}`);
    return v;
  };
  const vus = one(o.vus, "vus", LOAD_LIMITS.vus, DEFAULT_LOAD_OPTIONS.vus);
  const durationSeconds = one(o.durationSeconds, "durationSeconds", LOAD_LIMITS.durationSeconds, DEFAULT_LOAD_OPTIONS.durationSeconds);
  const rampUpSeconds = one(o.rampUpSeconds, "rampUpSeconds", LOAD_LIMITS.rampUpSeconds, DEFAULT_LOAD_OPTIONS.rampUpSeconds);
  if (rampUpSeconds > durationSeconds / 2) throw bad("rampUpSeconds can be at most half of durationSeconds");
  let paths = [...DEFAULT_LOAD_OPTIONS.paths];
  if (o.paths !== undefined) {
    if (!Array.isArray(o.paths) || o.paths.length === 0 || o.paths.length > LOAD_LIMITS.pathsMax) throw bad(`paths must be a list of 1 to ${LOAD_LIMITS.pathsMax} paths`);
    paths = [...new Set(o.paths.map(cleanPath))];
  }
  const maxP95Ms = o.maxP95Ms === undefined || o.maxP95Ms === null ? null : one(o.maxP95Ms, "maxP95Ms", LOAD_LIMITS.maxP95Ms, 0);
  return { vus, durationSeconds, rampUpSeconds, paths, maxErrorRatePercent: one(o.maxErrorRatePercent, "maxErrorRatePercent", LOAD_LIMITS.maxErrorRatePercent, DEFAULT_LOAD_OPTIONS.maxErrorRatePercent), maxP95Ms };
}

// ---------------- The result an agent hands in ----------------

export const LOAD_OUTCOMES = ["completed", "stopped_error_rate", "stopped_p95", "stopped_tool_limit", "stopped_by_agent"] as const;
export const LOAD_VERDICTS = ["pass", "warning", "fail"] as const;
export interface LoadTotals { requests: number; errors: number; errorRate: number; rps: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number }
export interface LoadPathResult extends LoadTotals { path: string; statuses: Record<string, number> }
export interface LoadResult {
  version: 1;
  outcome: (typeof LOAD_OUTCOMES)[number];
  startedAt: string;
  endedAt: string;
  params: { vus: number; durationSeconds: number; rampUpSeconds: number; paths: string[] };
  totals: LoadTotals;
  paths: LoadPathResult[];
  timeline: { t: number; vus: number; requests: number; errors: number; p95Ms: number }[];
  verdict: (typeof LOAD_VERDICTS)[number];
  verdictReason: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** An object with exactly these fields: an unknown or a missing one is refused. */
function exact(v: unknown, what: string, keys: string[]): Record<string, unknown> {
  if (!isObj(v)) throw bad(`${what} must be an object`);
  const extra = Object.keys(v).find((k) => !keys.includes(k));
  if (extra) throw bad(`${what} has an unknown field "${extra.slice(0, 40)}"`);
  const missing = keys.find((k) => v[k] === undefined);
  if (missing) throw bad(`${what} is missing "${missing}"`);
  return v;
}
function num(v: unknown, what: string, min: number, max: number, whole = false): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (whole && !Number.isInteger(v))) throw bad(`${what} must be ${whole ? "a whole number" : "a number"} from ${min} to ${max}`);
  return v;
}
function oneOf<T extends string>(v: unknown, what: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw bad(`${what} must be one of ${allowed.join(", ")}`);
  return v as T;
}
function when(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length > 40 || Number.isNaN(Date.parse(v))) throw bad(`${what} must be a date and time (ISO 8601)`);
  return v;
}
const TOTAL_KEYS = ["requests", "errors", "errorRate", "rps", "p50Ms", "p95Ms", "p99Ms", "maxMs"];
function totals(v: unknown, what: string, extra: string[] = []): { t: LoadTotals; o: Record<string, unknown> } {
  const o = exact(v, what, [...TOTAL_KEYS, ...extra]);
  const requests = num(o.requests, `${what}.requests`, 0, 10_000_000, true);
  return {
    o,
    t: {
      requests,
      errors: num(o.errors, `${what}.errors`, 0, requests, true),
      errorRate: num(o.errorRate, `${what}.errorRate`, 0, 100),
      rps: num(o.rps, `${what}.rps`, 0, 1_000_000),
      p50Ms: num(o.p50Ms, `${what}.p50Ms`, 0, 600_000),
      p95Ms: num(o.p95Ms, `${what}.p95Ms`, 0, 600_000),
      p99Ms: num(o.p99Ms, `${what}.p99Ms`, 0, 600_000),
      maxMs: num(o.maxMs, `${what}.maxMs`, 0, 600_000),
    },
  };
}
/** A map of a status code (or "timeout", "error") to a count, at most 20 entries. */
function statuses(v: unknown, what: string): Record<string, number> {
  if (!isObj(v)) throw bad(`${what} must be an object`);
  const entries = Object.entries(v);
  if (entries.length > 20) throw bad(`${what} can hold at most 20 entries`);
  return Object.fromEntries(entries.map(([k, n]) => {
    if (!/^(\d{3}|timeout|error)$/.test(k)) throw bad(`${what} has the key "${k.slice(0, 20)}", which is not a status code`);
    return [k, num(n, `${what}.${k}`, 0, 10_000_000, true)];
  }));
}

/**
 * Checks a load result and rebuilds it from the known fields (the raw body is never stored). The result can never claim more than was asked for: no more users, no longer a test, and no
 * path that the request did not name. A person reads it, so the one sentence of reasoning is data for them and never an instruction.
 */
export function cleanLoadResult(input: unknown, asked: LoadOptions): LoadResult {
  const o = exact(input, "The result", ["version", "outcome", "startedAt", "endedAt", "params", "totals", "paths", "timeline", "verdict", "verdictReason"]);
  if (o.version !== 1) throw bad("version must be 1");
  const p = exact(o.params, "params", ["vus", "durationSeconds", "rampUpSeconds", "paths"]);
  if (!Array.isArray(p.paths) || p.paths.length === 0 || p.paths.length > LOAD_LIMITS.pathsMax || !p.paths.every((x) => typeof x === "string")) throw bad("params.paths must be a list of paths");
  const stray = (p.paths as string[]).find((x) => !asked.paths.includes(x));
  if (stray !== undefined) throw bad(`params.paths has a path the request did not ask for: "${stray.slice(0, 40)}"`);
  if (!Array.isArray(o.paths) || o.paths.length > LOAD_LIMITS.pathsMax) throw bad(`paths must be a list of at most ${LOAD_LIMITS.pathsMax}`);
  const paths: LoadPathResult[] = o.paths.map((raw, i) => {
    const { t, o: po } = totals(raw, `paths[${i}]`, ["path", "statuses"]);
    if (typeof po.path !== "string" || !asked.paths.includes(po.path)) throw bad(`paths[${i}].path is not a path the request asked for`);
    return { path: po.path, ...t, statuses: statuses(po.statuses, `paths[${i}].statuses`) };
  });
  if (!Array.isArray(o.timeline) || o.timeline.length > LOAD_LIMITS.timelineMax) throw bad(`timeline must be a list of at most ${LOAD_LIMITS.timelineMax} points`);
  const timeline = o.timeline.map((raw, i) => {
    const t = exact(raw, `timeline[${i}]`, ["t", "vus", "requests", "errors", "p95Ms"]);
    const requests = num(t.requests, `timeline[${i}].requests`, 0, 10_000_000, true);
    return { t: num(t.t, `timeline[${i}].t`, 0, 3600, true), vus: num(t.vus, `timeline[${i}].vus`, 0, asked.vus, true), requests, errors: num(t.errors, `timeline[${i}].errors`, 0, requests, true), p95Ms: num(t.p95Ms, `timeline[${i}].p95Ms`, 0, 600_000) };
  });
  const reason = o.verdictReason;
  if (typeof reason !== "string" || reason.length > 300 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(reason)) throw bad("verdictReason must be one line of at most 300 characters");
  return {
    version: 1,
    outcome: oneOf(o.outcome, "outcome", LOAD_OUTCOMES),
    startedAt: when(o.startedAt, "startedAt"),
    endedAt: when(o.endedAt, "endedAt"),
    params: {
      vus: num(p.vus, "params.vus", 1, asked.vus, true),
      durationSeconds: num(p.durationSeconds, "params.durationSeconds", 1, asked.durationSeconds, true),
      rampUpSeconds: num(p.rampUpSeconds, "params.rampUpSeconds", 0, asked.durationSeconds, true),
      paths: [...new Set(p.paths as string[])],
    },
    totals: totals(o.totals, "totals").t,
    paths,
    timeline,
    verdict: oneOf(o.verdict, "verdict", LOAD_VERDICTS),
    verdictReason: reason,
  };
}
