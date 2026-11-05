import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";

/**
 * Read-only check of an audit package written by the qa-run skill against its own contract
 * (`.claude/skills/references/audit-contract.md`, version 1.2). This is NOT Testbench's import format: that is
 * server/importers/auditpackage.ts, and server/importers/testbenchexport.ts converts the one into the other.
 *
 * Nothing here writes. Rule V-32 (an evidence file was not changed after registration) cannot be checked from the
 * package alone, because the contract stores no hash for evidence; it is reported as a warning, not as a pass.
 */

export const CONTRACT_VERSION = "1.2";

// The package is free-form JSON written by an agent; every field is checked before it is used.
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface CanonicalPackage {
  dir: string;
  manifest: Json;
  bugs: Json[];
  manualTests: Json[];
  report: string;
  evidenceFiles: string[];
}

export interface ContractReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  counts: Record<string, number>;
}

export class ContractError extends Error {}

const EXEC_STATUSES = ["pass", "fail", "blocked", "skipped", "inconclusive"] as const;
const REASONS: Record<string, string[]> = {
  blocked: ["environment", "access", "test-data", "dependency", "tooling"],
  skipped: ["needs-clarification", "manual-only", "out-of-scope", "not-applicable"],
  inconclusive: ["tooling", "insufficient-evidence", "needs-design-reference"],
};
const EVIDENCE_TYPES = ["screenshot", "video", "console-log", "network-trace", "dom-excerpt", "axe-result", "design-reference", "test-output"];
const ID_FORMATS: Record<string, RegExp> = {
  test_plan_item_id: /^TPI-\d{3,}$/,
  execution_id: /^EX-\d{3,}$/,
  evidence_id: /^EV-\d{3,}$/,
  bug_proposal_id: /^BP-\d{3,}$/,
  manual_test_proposal_id: /^MTP-\d{3,}$/,
  testbench_backlog_id: /^TBB-\d{3,}$/,
  coverage_gap_id: /^CG-\d{3,}$/,
  action_id: /^ACT-\d{3,}$/,
};
const REQUIREMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const REPORT_HEADINGS = ["Summary", "Scope and environment", "Requirements and readiness", "Execution results", "Bug proposals", "Manual test proposals",
  "Coverage gaps and not verified", "Limitations", "TestBench backlog", "Evidence index", "Human review handover"];
const SCOPE_FIELDS = ["objective", "target", "included_requirement_ids", "excluded_requirement_ids", "allowed_check_types", "viewports", "state_changes",
  "test_data_constraints", "out_of_scope", "stop_conditions", "confirmed_at", "confirmed_by"];
/** Secrets and personal data that must never be in a package (V-17). Binary evidence (images, video) is not searched. */
const SECRET = /tbci_|tbag_|bearer\s+\S|authorization:|api[_-]?key|password\s*[:=]|set-cookie|cookie\s*[:=]|[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
const BINARY = /\.(png|jpe?g|gif|webp|mp4|webm|pdf|zip)$/i;

const readJson = (path: string, name: string): Json => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ContractError(`${name} is missing or not valid JSON: ${(e as Error).message}`);
  }
};

/** Reads the four package files. Throws ContractError when one is missing or not JSON; the shape is checked by validateContract. */
export function readCanonicalPackage(dir: string): CanonicalPackage {
  for (const f of ["manifest.json", "report.md", "bugs.json", "manual-tests.json", "evidence"]) {
    if (!existsSync(join(dir, f))) throw new ContractError(`V-01: ${f} is missing in ${dir}`);
  }
  if (!statSync(join(dir, "evidence")).isDirectory()) throw new ContractError("V-01: evidence is not a folder");
  return {
    dir,
    manifest: readJson(join(dir, "manifest.json"), "manifest.json"),
    bugs: readJson(join(dir, "bugs.json"), "bugs.json"),
    manualTests: readJson(join(dir, "manual-tests.json"), "manual-tests.json"),
    report: readFileSync(join(dir, "report.md"), "utf8"),
    evidenceFiles: readdirSync(join(dir, "evidence")).filter((f) => !f.startsWith(".")).sort(),
  };
}

export const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Checks the rules of contract section 6. With `complete`, every viewport in the scope must also have executions:
 * an export to Testbench is only made from a finished audit.
 */
export function validateContract(pkg: CanonicalPackage, opts: { complete?: boolean } = {}): ContractReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (rule: string, msg: string) => errors.push(`${rule}: ${msg}`);
  const m = pkg.manifest;
  const counts: Record<string, number> = Object.fromEntries(EXEC_STATUSES.map((s) => [s, 0]));

  if (!m || typeof m !== "object" || Array.isArray(m)) return { ok: false, errors: ["V-02: manifest.json is not an object"], warnings, counts };
  if (!Array.isArray(pkg.bugs)) err("V-02", "bugs.json must be an array");
  if (!Array.isArray(pkg.manualTests)) err("V-02", "manual-tests.json must be an array");
  if (m.audit_id !== basename(pkg.dir) || !/^AUD-\d{8}-\d{2}$/.test(m.audit_id ?? "")) err("V-02", `audit_id ${JSON.stringify(m.audit_id)} must be AUD-YYYYMMDD-nn and match the folder name`);
  if (m.contract_version !== CONTRACT_VERSION) err("V-02", `contract_version is ${JSON.stringify(m.contract_version)}, expected ${CONTRACT_VERSION}`);
  const arrays = ["requirements", "test_plan_items", "executions", "actions", "evidence", "coverage_gaps", "testbench_backlog", "limitations"];
  for (const k of arrays) if (!Array.isArray(m[k])) err("V-02", `manifest.${k} must be an array`);
  if (errors.length) return { ok: false, errors, warnings, counts };
  const bugs: Json[] = pkg.bugs;
  const mtps: Json[] = pkg.manualTests;

  // V-03 identifiers: format and uniqueness
  const collections: Record<string, Json[]> = {
    test_plan_item_id: m.test_plan_items, execution_id: m.executions, evidence_id: m.evidence, bug_proposal_id: bugs,
    manual_test_proposal_id: mtps, testbench_backlog_id: m.testbench_backlog, coverage_gap_id: m.coverage_gaps, action_id: m.actions,
  };
  const all = new Set<string>();
  for (const [key, items] of Object.entries(collections)) {
    const seen = new Set<string>();
    for (const it of items) {
      const v = it?.[key];
      if (typeof v !== "string" || !ID_FORMATS[key].test(v)) err("V-03", `${key} ${JSON.stringify(v)}`);
      else if (seen.has(v)) err("V-03", `duplicate ${v}`);
      seen.add(v);
      all.add(v);
    }
  }
  const reqs = new Map<string, Json>();
  for (const r of m.requirements) {
    if (typeof r?.requirement_id !== "string" || !REQUIREMENT_ID.test(r.requirement_id)) err("V-03", `requirement_id ${JSON.stringify(r?.requirement_id)}`);
    else reqs.set(r.requirement_id, r);
  }
  const tpis = new Map<string, Json>(m.test_plan_items.map((t: Json) => [t.test_plan_item_id, t]));
  const exs = new Map<string, Json>(m.executions.map((x: Json) => [x.execution_id, x]));
  const evs = new Map<string, Json>(m.evidence.map((e: Json) => [e.evidence_id, e]));

  // V-04, V-05 references
  for (const t of m.test_plan_items) if (!reqs.has(t.requirement_id)) err("V-05", `${t.test_plan_item_id} has no known requirement_id`);
  for (const x of m.executions) {
    const t = tpis.get(x.test_plan_item_id);
    if (!t) err("V-04", `${x.execution_id} -> unknown ${x.test_plan_item_id}`);
    else if (t.requirement_id !== x.requirement_id) err("V-05", `${x.execution_id} requirement differs from its test plan item`);
    for (const e of x.evidence_ids ?? []) if (!evs.has(e)) err("V-04", `${x.execution_id} -> unknown ${e}`);
    if (!["mcp-exploration", "saved-test"].includes(x.mode)) err("V-05", `${x.execution_id} mode ${JSON.stringify(x.mode)}`);
  }
  for (const e of m.evidence) for (const r of e.related ?? []) if (!all.has(r)) err("V-04", `${e.evidence_id} related -> unknown ${r}`);
  for (const g of m.coverage_gaps) if (!reqs.has(g.requirement_id)) err("V-04", `${g.coverage_gap_id} has no known requirement_id`);
  for (const p of mtps) {
    const o = p?.origin ?? {};
    if (!["execution", "bug_proposal", "coverage_gap"].includes(o.type) || !all.has(o.id)) err("V-04", `${p?.manual_test_proposal_id} origin`);
    if (!reqs.has(p?.requirement_id)) err("V-04", `${p?.manual_test_proposal_id} has no known requirement_id`);
    for (const e of p?.evidence_ids ?? []) if (!evs.has(e)) err("V-04", `${p.manual_test_proposal_id} -> unknown ${e}`);
  }

  // V-06 to V-09 execution statuses
  for (const x of m.executions) {
    const s = x.status;
    if (!(EXEC_STATUSES as readonly string[]).includes(s)) { err("V-07", `${x.execution_id} status ${JSON.stringify(s)}`); continue; }
    counts[s]++;
    if (REASONS[s] && !REASONS[s].includes(x.reason)) err("V-08", `${x.execution_id} reason ${JSON.stringify(x.reason)}`);
    if ((s === "pass" || s === "fail") && !(x.evidence_ids ?? []).length) err("V-09", `${x.execution_id} has no evidence`);
    if ((s === "pass" || s === "fail") && reqs.get(x.requirement_id)?.readiness === "needs-clarification") err("V-06", x.execution_id);
    for (const k of ["started_at", "finished_at"]) if (!ISO_UTC.test(x[k] ?? "")) err("V-16", `${x.execution_id} ${k}`);
  }

  // V-10, V-14, V-29 bug proposals
  for (const b of bugs) {
    if (!(b.execution_ids ?? []).some((e: string) => exs.get(e)?.status === "fail")) err("V-10", `${b.bug_proposal_id} rests on no fail execution`);
    if (!(b.evidence_ids ?? []).length) err("V-14", `${b.bug_proposal_id} has no evidence`);
    for (const e of b.evidence_ids ?? []) if (!evs.has(e)) err("V-14", `${b.bug_proposal_id} -> unknown ${e}`);
    const dc = b.duplicate_check;
    if (!["not_available", "no_match", "possible_match", "uncertain_match"].includes(dc)) err("V-29", `${b.bug_proposal_id} duplicate_check`);
    if ((dc === "not_available" || dc === "no_match") && b.possible_duplicate_of != null) err("V-29", `${b.bug_proposal_id} possible_duplicate_of must be null`);
  }

  // V-12 proposal status
  for (const [key, items] of [["bug_proposal_id", bugs], ["manual_test_proposal_id", mtps], ["testbench_backlog_id", m.testbench_backlog]] as const) {
    for (const it of items) if (it?.status !== "proposed") err("V-12", `${it?.[key]} status must be proposed`);
  }

  // V-13, V-15, V-16 evidence
  const files = new Set(pkg.evidenceFiles);
  const referenced = new Set<string>();
  for (const e of m.evidence) {
    for (const f of ["evidence_id", "type", "source", "location", "related", "description", "redacted"]) if (!(f in e)) err("V-13", `${e.evidence_id} misses ${f}`);
    if (!EVIDENCE_TYPES.includes(e.type)) err("V-13", `${e.evidence_id} type ${JSON.stringify(e.type)}`);
    if (!(e.related ?? []).length) err("V-13", `${e.evidence_id} related is empty`);
    const loc: string = e.location ?? "";
    if (/^https?:\/\//.test(loc)) continue;
    if (!loc.startsWith("evidence/") || loc.includes("..") || loc.slice(9).includes("/")) { err("V-15", `${e.evidence_id} location ${JSON.stringify(loc)}`); continue; }
    const name = loc.slice("evidence/".length);
    referenced.add(name);
    if (!files.has(name)) err("V-15", `${e.evidence_id} points to a missing file ${loc}`);
    if (!ISO_UTC.test(e.captured_at ?? "")) err("V-16", `${e.evidence_id} captured_at`);
  }
  for (const f of files) if (!referenced.has(f)) err("V-15", `evidence/${f} is not referenced by any evidence object`);
  warnings.push("V-32 cannot be checked from the package alone: contract 1.2 stores no hash for evidence files.");

  // V-17 secrets and personal data in text files
  const textFiles = ["manifest.json", "bugs.json", "manual-tests.json", "report.md", ...pkg.evidenceFiles.map((f) => `evidence/${f}`)];
  for (const f of textFiles) {
    if (BINARY.test(f)) continue;
    if (SECRET.test(readFileSync(join(pkg.dir, f), "utf8"))) err("V-17", `a secret or personal-data pattern is in ${f}`);
  }

  // V-18, V-19 content
  for (const p of mtps) if (!p.objective || !(p.steps ?? []).length || !p.expected_result) err("V-19", `${p.manual_test_proposal_id} needs objective, steps and expected_result`);

  // V-20, V-11 counts and headings in report.md
  for (const s of EXEC_STATUSES) if (!new RegExp(`\\*\\*${counts[s]} ${s}\\*\\*`).test(pkg.report)) err("V-20", `report.md does not state **${counts[s]} ${s}**`);
  if (!new RegExp(`Bug proposals: \\*\\*${bugs.length}\\*\\*`).test(pkg.report)) err("V-20", "report.md bug proposal count");
  if (!new RegExp(`Manual test proposals: \\*\\*${mtps.length}\\*\\*`).test(pkg.report)) err("V-20", "report.md manual test proposal count");
  if (!new RegExp(`Coverage gaps: \\*\\*${m.coverage_gaps.length}\\*\\*`).test(pkg.report)) err("V-20", "report.md coverage gap count");
  const pos = REPORT_HEADINGS.map((h) => pkg.report.indexOf(`## ${h}\n`));
  if (pos.includes(-1) || pos.some((p, i) => i > 0 && p < pos[i - 1])) err("V-20", "report.md headings are missing or out of order");

  // V-21 boundaries
  if (!Array.isArray(m.external_actions) || m.external_actions.length) err("V-21", "external_actions must be []");
  if (m.human_review?.status !== "pending") err("V-21", "human_review.status must be pending");

  // V-23, V-24 scope
  const sc = m.scope ?? {};
  for (const f of SCOPE_FIELDS) if (!(f in sc)) err("V-23", `scope.${f} is missing`);
  const included: string[] = sc.included_requirement_ids ?? [];
  const viewports: Json[] = sc.viewports ?? [];
  const sameVp = (a: Json, b: Json) => a?.width === b?.width && a?.height === b?.height;
  for (const t of m.test_plan_items) {
    if (!included.includes(t.requirement_id)) err("V-24", `${t.test_plan_item_id} requirement is not in scope`);
    if (!(sc.allowed_check_types ?? []).includes(t.type)) err("V-24", `${t.test_plan_item_id} type ${t.type} is not allowed`);
  }
  for (const x of m.executions) {
    if (!included.includes(x.requirement_id)) err("V-24", `${x.execution_id} requirement is not in scope`);
    if (!viewports.some((v) => sameVp(v, x.viewport))) err("V-24", `${x.execution_id} viewport is not in scope`);
  }

  // V-25, V-30, V-31 state-changing actions and their limits
  const allowed = new Map<string, Json>((sc.state_changes?.allowed_actions ?? []).map((a: Json) => [a.action, a]));
  const perViewport = new Map<string, number>();
  for (const a of m.actions) {
    for (const f of ["action_id", "execution_id", "action", "target", "allowed_by_scope", "performed_at", "evidence_ids"]) if (!(f in a)) err("V-30", `${a.action_id} misses ${f}`);
    if (a.allowed_by_scope !== true || !allowed.has(a.action)) err("V-25", `${a.action_id} is not an allowed action`);
    if (!exs.has(a.execution_id)) err("V-04", `${a.action_id} -> unknown ${a.execution_id}`);
    for (const e of a.evidence_ids ?? []) if (!evs.has(e)) err("V-04", `${a.action_id} -> unknown ${e}`);
    if (!ISO_UTC.test(a.performed_at ?? "")) err("V-16", `${a.action_id} performed_at`);
    const vp = exs.get(a.execution_id)?.viewport ?? {};
    const key = `${a.action}@${vp.width}x${vp.height}`;
    perViewport.set(key, (perViewport.get(key) ?? 0) + 1);
  }
  for (const [key, n] of perViewport) {
    const action = key.slice(0, key.indexOf("@"));
    if (allowed.get(action)?.limit === "one per viewport" && n > 1) err("V-31", `${action} done ${n} times at ${key.slice(key.indexOf("@") + 1)}`);
  }

  // V-27, V-28 delivery
  const d = m.delivery ?? {};
  if (!["not_delivered", "delivered", "failed", "not_configured"].includes(d.status)) err("V-27", `delivery.status ${JSON.stringify(d.status)}`);
  if (d.status === "delivered" && !(d.request_reference || d.response_reference)) err("V-28", "delivered without a reference");

  // A finished audit: every viewport in the scope has executions.
  const missing = viewports.filter((v) => !m.executions.some((x: Json) => sameVp(v, x.viewport))).map((v) => `${v.width}x${v.height}`);
  if (missing.length) (opts.complete ? errors : warnings).push(`COMPLETE: no executions at ${missing.join(", ")}`);
  if (m.validation?.result !== "pass") warnings.push(`manifest.validation.result is ${JSON.stringify(m.validation?.result)}; this check is run again here and does not rely on it`);

  return { ok: errors.length === 0, errors, warnings, counts };
}
