import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { CONTRACT_VERSION, readCanonicalPackage, sha256File, validateContract, type CanonicalPackage, type ContractReport } from "./auditcontract.ts";
import { EVIDENCE_EXT, MANUAL_CATEGORIES } from "./auditpackage.ts";
import { checkPackageDir, type BuildReport } from "./auditbuild.ts";
import { PRIORITIES } from "../shapes.ts";

/**
 * Export adapter: turns a finished audit package of the qa-run audit contract (version 1.2) into the package format that
 * Testbench imports (server/importers/auditpackage.ts). The contract package stays the canonical record and is only read;
 * everything is written to a separate output folder, together with provenance.json, which says where every value came
 * from, which values the adapter generated, and which contract fields have no place in the import format.
 *
 *   npm run audit:export:testbench -- --input audits/AUD-20261105-01 --output .testbench-export/AUD-20261105-01 --project RS
 *
 * The adapter never delivers anything: the person imports the output folder (or a zip of it) in Testbench.
 *
 * Known limitation: Testbench stores only evidence that a bug report points to (docs/agent-audit-guide.md: "A file that no finding points
 * to is not stored"), and a manual test has no evidence list. An audit without bug proposals therefore exports its evidence files and
 * lists them in manifest.files[], but an import does not keep them; they stay in the canonical package. NOT_MAPPED and provenance.json
 * record this, and the other contract fields that the import format has no place for.
 */

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export const ADAPTER = { name: "audit-export-testbench", version: "1" } as const;
export const PROVENANCE_FORMAT = "testbench-export-provenance";

export class ExportError extends Error {}

export interface ExportOptions {
  input: string;
  output: string;
  /** Testbench project key (for example RS). Contract 1.2 has no field for it, so the person running the export names it. */
  project: string;
  /** Replace an output folder that an earlier run of this adapter wrote. Any other existing folder is refused. */
  overwrite?: boolean;
  now?: Date;
}

export interface ExportResult {
  output: string;
  files: string[];
  contract: ContractReport;
  testbench: BuildReport;
  provenance: Json;
}

/** How a plan item's test type becomes a manual-test category of the import format. Documented in provenance.json. */
export const TYPE_TO_CATEGORY: Record<string, (typeof MANUAL_CATEGORIES)[number]> = {
  Functional: "functional", Validation: "functional", State: "functional", Concurrency: "functional",
  Authorization: "security", Responsive: "responsive", Accessibility: "accessibility", Visual: "usability",
  Internationalisation: "other", Performance: "other",
};
const PRIORITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const SEVERITY = ["low", "medium", "high", "critical"];

/** Field mapping from contract 1.2 to the import format, written into provenance.json as is. */
export const FIELD_MAP = [
  { from: "manifest.audit_id", to: "manifest.audit.id", how: "copied" },
  { from: "--project", to: "manifest.audit.project", how: "operator-supplied: contract 1.2 has no Testbench project key" },
  { from: "report.md first heading", to: "manifest.audit.title", how: "copied, cut to 200 characters" },
  { from: "min(executions[].started_at)", to: "manifest.audit.startedAt", how: "derived" },
  { from: "max(executions[].finished_at)", to: "manifest.audit.finishedAt", how: "derived" },
  { from: "manifest.agent.name / .model", to: "manifest.audit.agent.name / .model", how: "copied; agent.version is empty (not in the contract)" },
  { from: "evidence/* files", to: "evidence/* and manifest.files[] {path, sha256, size}", how: "copied byte for byte; sha256 and size computed from the copy" },
  { from: "report.md", to: "report.md (parts.narrative)", how: "copied byte for byte" },
  { from: "bugs.json [array]", to: "bugs.json {version: 1, bugs: [...]}", how: "wrapped" },
  { from: "bug_proposal_id", to: "bugs[].sourceId", how: "copied" },
  { from: "title", to: "bugs[].title", how: "copied" },
  { from: "steps_to_reproduce", to: "bugs[].steps", how: "copied" },
  { from: "expected_result / actual_result", to: "bugs[].expected / .actual", how: "copied" },
  { from: "environment.url / environment.test_environment", to: "bugs[].url / .environment", how: "copied" },
  { from: "severity", to: "bugs[].agentSeverity", how: "lower-cased when it is low, medium, high or critical" },
  { from: "finished_at of the first fail execution", to: "bugs[].foundAt", how: "derived" },
  { from: "requirement_link.requirement_id or requirement_id", to: "bugs[].refs.requirements", how: "copied as a one-item list" },
  { from: "evidence_ids", to: "bugs[].evidence[] {path, label}", how: "resolved to the evidence file; label is 'EV-nnn: description'" },
  { from: "finding_category, requirement link, executions, reproduction rate, confidence, duplicate check", to: "bugs[].description", how: "written as text lines" },
  { from: "manual-tests.json [array]", to: "manual-tests.json {version: 1, tests: [...]}", how: "wrapped" },
  { from: "manual_test_proposal_id", to: "tests[].sourceId", how: "copied" },
  { from: "title / steps", to: "tests[].title / .steps", how: "copied" },
  { from: "expected_result", to: "tests[].expected", how: "copied" },
  { from: "requirement_id", to: "tests[].refs.requirements", how: "copied as a one-item list" },
  { from: "objective, reason_manual, origin, evidence_ids", to: "tests[].description", how: "written as text lines" },
  { from: "(none)", to: "tests[].priority", how: "adapter-generated, see generated[]" },
  { from: "(none)", to: "tests[].category", how: "adapter-generated, see generated[]" },
  { from: "scope.viewports", to: "tests[].viewports", how: "only for a responsive test, which the import format requires to name a viewport" },
];

/** Contract fields with no place in the import format. They stay in the canonical package; report.md (copied) describes them for a person. */
export const NOT_MAPPED = [
  { field: "manifest.scope", reason: "the import format has no audit scope" },
  { field: "manifest.requirements[] (readiness, acceptance_criteria)", reason: "Testbench holds the requirements itself; only the ids travel, as refs.requirements" },
  { field: "manifest.test_plan_items[]", reason: "no test plan in the import format" },
  { field: "manifest.executions[] (status, reason, times, viewport, summary)", reason: "the import format carries findings and manual tests, not execution results" },
  { field: "manifest.actions[]", reason: "no record of state-changing actions in the import format" },
  { field: "manifest.evidence[] (evidence_id, type, source, related, captured_at, description, viewport, redacted)", reason: "manifest.files[] holds only path, sha256 and size" },
  { field: "manifest.coverage_gaps[]", reason: "no coverage gaps in the import format" },
  { field: "manifest.testbench_backlog[]", reason: "no backlog in the import format" },
  { field: "manifest.limitations[]", reason: "no limitations field" },
  { field: "manifest.target, contract_version, created_at, external_actions", reason: "no matching fields" },
  { field: "manifest.validation", reason: "the contract validation result is recorded in provenance.json, not in the import manifest" },
  { field: "manifest.delivery", reason: "delivery is a Testbench-side fact; the export is not a delivery" },
  { field: "manifest.human_review", reason: "Testbench starts every proposal as proposed and keeps its own review state" },
  { field: "bugs[].status, tests[].status", reason: "the importer ignores any status; everything arrives as proposed" },
  { field: "bugs[].agent_confidence", reason: "the import format wants a number from 0 to 1; High/Medium/Low is not converted to an invented number, it goes into the description" },
  { field: "bugs[].duplicate_check, possible_duplicate_of, duplicate_check_notes", reason: "no duplicate-check fields; written into the description" },
  { field: "bugs[].execution_ids, tests[].origin, tests[].evidence_ids", reason: "no links to executions or origins; written into the description as text" },
  { field: "tests[].evidence_ids as files", reason: "a manual test in the import format has no evidence list, so evidence only cited by a manual test is not stored by Testbench" },
];

const text = (v: unknown): string => (v == null ? "" : Array.isArray(v) ? v.map(text).filter(Boolean).join("\n") : typeof v === "object" ? JSON.stringify(v) : String(v));
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(text).filter(Boolean) : v == null || v === "" ? [] : [text(v)]);

function within(child: string, parent: string) {
  return child === parent || child.startsWith(parent + sep);
}

/** Priority and category for a manual test, which contract 1.2 does not have. The rule is the same for every test and is recorded. */
export function manualDefaults(t: Json, m: Json, bugs: Json[]) {
  const tpis = new Map<string, Json>(m.test_plan_items.map((x: Json) => [x.test_plan_item_id, x]));
  const exs = new Map<string, Json>(m.executions.map((x: Json) => [x.execution_id, x]));
  let basis: Json[] = [];
  let rule: string;
  const origin = t.origin ?? {};
  if (origin.type === "execution" && exs.has(origin.id)) {
    basis = [tpis.get(exs.get(origin.id).test_plan_item_id)].filter(Boolean);
    rule = `from the test plan item of its origin execution ${origin.id}`;
  } else if (origin.type === "bug_proposal") {
    const b = bugs.find((x) => x.bug_proposal_id === origin.id);
    basis = (b?.execution_ids ?? []).map((e: string) => tpis.get(exs.get(e)?.test_plan_item_id)).filter(Boolean);
    rule = `from the test plan items of the executions of its origin ${origin.id}`;
  } else {
    rule = `from the test plan items of its requirement ${t.requirement_id} (origin ${origin.type ?? "unknown"} ${origin.id ?? ""})`.trim();
  }
  if (!basis.length) basis = m.test_plan_items.filter((x: Json) => x.requirement_id === t.requirement_id);
  // The highest planned priority of those items: the audit already judged how important checking this requirement is.
  const best = [...basis].sort((a, b) => (PRIORITY_RANK[String(b.priority).toLowerCase()] ?? -1) - (PRIORITY_RANK[String(a.priority).toLowerCase()] ?? -1))[0];
  const p = String(best?.priority ?? "").toLowerCase();
  const priority = (PRIORITIES as readonly string[]).includes(p) ? (p as (typeof PRIORITIES)[number]) : "medium";
  const category = TYPE_TO_CATEGORY[best?.type] ?? "other";
  return {
    priority,
    category,
    basis: best?.test_plan_item_id ?? null,
    rule: best
      ? `${rule}: priority is the plan item's priority (${best.priority}) lower-cased; category maps its test type ${best.type} with TYPE_TO_CATEGORY`
      : `${rule}: no plan item found, so the fallbacks medium and other are used`,
  };
}

function convertBug(b: Json, m: Json, evById: Map<string, Json>) {
  const exs = new Map<string, Json>(m.executions.map((x: Json) => [x.execution_id, x]));
  const firstFail = (b.execution_ids ?? []).map((e: string) => exs.get(e)).find((x: Json) => x?.status === "fail");
  const env = b.environment ?? {};
  const link = b.requirement_link ?? {};
  const reqId = link.requirement_id ?? b.requirement_id;
  const severity = String(b.severity?.level ?? b.severity ?? "").toLowerCase();
  const lines = [
    `Converted from audit contract ${CONTRACT_VERSION} bug proposal ${b.bug_proposal_id} in audit ${m.audit_id}.`,
    b.finding_category && `Finding category: ${b.finding_category}`,
    reqId && `Requirement: ${reqId}${link.acceptance_criterion ? `, criterion: ${link.acceptance_criterion}` : ""}`,
    link.test_plan_item_id && `Test plan item: ${link.test_plan_item_id}`,
    (b.execution_ids ?? []).length && `Executions: ${b.execution_ids.join(", ")}`,
    b.preconditions && `Preconditions: ${text(b.preconditions)}`,
    (env.browser || env.viewport) && `Browser / viewport: ${text(env.browser)} ${text(env.viewport)}`.trim(),
    b.reproduction_rate && `Reproduction rate: ${text(b.reproduction_rate)}`,
    b.agent_confidence && `Agent confidence: ${text(b.agent_confidence)}`,
    `Duplicate check: ${b.duplicate_check ?? "not stated"}${b.possible_duplicate_of ? `, possible duplicate of ${b.possible_duplicate_of}` : ""}${b.duplicate_check_notes ? ` (${b.duplicate_check_notes})` : ""}`,
  ].filter(Boolean);
  return {
    sourceId: b.bug_proposal_id,
    title: text(b.title),
    description: lines.join("\n"),
    steps: list(b.steps_to_reproduce ?? b.steps),
    expected: text(b.expected_result),
    actual: text(b.actual_result),
    environment: typeof env === "string" ? env : text(env.test_environment),
    url: text(typeof env === "object" ? env.url ?? b.url : b.url),
    ...(SEVERITY.includes(severity) ? { agentSeverity: severity } : {}),
    ...(firstFail?.finished_at ? { foundAt: firstFail.finished_at } : {}),
    refs: { requirements: reqId ? [reqId] : [], cases: [], tests: [] },
    evidence: (b.evidence_ids ?? [])
      .map((id: string) => evById.get(id))
      .filter((e: Json) => e && String(e.location).startsWith("evidence/"))
      .slice(0, 20)
      .map((e: Json) => ({ path: e.location, label: `${e.evidence_id}: ${text(e.description)}`.slice(0, 200) })),
  };
}

function convertManualTest(t: Json, m: Json, bugs: Json[], generated: Json[]) {
  const d = manualDefaults(t, m, bugs);
  generated.push(
    { target: `manual-tests.json tests[${t.manual_test_proposal_id}].priority`, value: d.priority, basis: d.basis, rule: d.rule, adapterGenerated: true },
    { target: `manual-tests.json tests[${t.manual_test_proposal_id}].category`, value: d.category, basis: d.basis, rule: d.rule, adapterGenerated: true },
  );
  const lines = [
    text(t.objective),
    t.reason_manual && `Why a person is needed: ${text(t.reason_manual)}`,
    `Converted from audit contract ${CONTRACT_VERSION} manual test proposal ${t.manual_test_proposal_id} in audit ${m.audit_id}; origin: ${t.origin?.type} ${t.origin?.id}.`,
    (t.evidence_ids ?? []).length && `Evidence in the audit: ${t.evidence_ids.join(", ")}`,
    `Priority and category were set by the export adapter (${d.rule}).`,
  ].filter(Boolean);
  return {
    sourceId: t.manual_test_proposal_id,
    title: text(t.title),
    description: lines.join("\n\n"),
    preconditions: "",
    steps: list(t.steps),
    expected: text(t.expected_result),
    priority: d.priority,
    category: d.category,
    wcag: [],
    viewports: d.category === "responsive" ? (m.scope?.viewports ?? []).map((v: Json) => ({ width: v.width, height: v.height })) : [],
    refs: { requirements: t.requirement_id ? [t.requirement_id] : [], cases: [], tests: [] },
  };
}

const writeJson = (path: string, v: unknown) => writeFileSync(path, JSON.stringify(v, null, 2) + "\n");

/** Converts, checks with Testbench's own package check, and returns what was done. Throws ExportError before writing anything when the input is not a valid finished contract package. */
export function exportToTestbench(opts: ExportOptions): ExportResult {
  const input = resolve(opts.input);
  const output = resolve(opts.output);
  if (within(output, input) || within(input, output)) throw new ExportError("The output folder must be outside the input package, and the other way round.");
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(opts.project ?? "")) throw new ExportError("--project must be the Testbench project key, for example RS (letters, digits, _ and -, at most 40).");
  if (existsSync(output)) {
    const prov = join(output, "provenance.json");
    let ours = false;
    try { ours = JSON.parse(readFileSync(prov, "utf8")).format === PROVENANCE_FORMAT; } catch { ours = false; }
    if (!ours) throw new ExportError(`${output} exists and was not written by this adapter; choose another output folder.`);
    if (!opts.overwrite) throw new ExportError(`${output} exists; add --overwrite to replace this earlier export.`);
  }

  // 1. Read and validate the canonical package first. Nothing is written when it fails.
  const pkg: CanonicalPackage = readCanonicalPackage(input);
  const contract = validateContract(pkg, { complete: true });
  if (!contract.ok) throw Object.assign(new ExportError(`The input is not a valid finished audit contract ${CONTRACT_VERSION} package:\n  ${contract.errors.join("\n  ")}`), { contract });
  const m = pkg.manifest;

  // 2. Build in a staging folder next to the output, and move it into place only when complete.
  const staging = `${output}.partial-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, "evidence"), { recursive: true });
  const evById = new Map<string, Json>(m.evidence.map((e: Json) => [e.evidence_id, e]));
  const generated: Json[] = [];
  const notMapped = [...NOT_MAPPED];

  // 4, 5. Evidence: byte-for-byte copies, sha256 and size taken from the copy and compared with the original.
  const files: { path: string; sha256: string; size: number }[] = [];
  const evidenceProv: Json[] = [];
  for (const name of pkg.evidenceFiles) {
    const rel = `evidence/${name}`;
    const ev = m.evidence.find((e: Json) => e.location === rel);
    if (!EVIDENCE_EXT.has(extname(name).toLowerCase())) {
      notMapped.push({ field: rel, reason: `file type ${extname(name)} is not accepted as evidence by Testbench, so it is not exported` });
      continue;
    }
    const src = join(input, rel);
    const dst = join(staging, rel);
    copyFileSync(src, dst);
    const st = statSync(src);
    utimesSync(dst, st.atime, st.mtime);
    const hash = sha256File(dst);
    if (hash !== sha256File(src)) throw new ExportError(`Copy of ${rel} differs from the original`);
    const size = statSync(dst).size;
    files.push({ path: rel, sha256: hash, size });
    evidenceProv.push({ path: rel, evidence_id: ev?.evidence_id ?? null, type: ev?.type ?? null, captured_at: ev?.captured_at ?? null, sha256: hash, size });
  }

  // report.md travels unchanged as the narrative.
  copyFileSync(join(input, "report.md"), join(staging, "report.md"));

  // 6. bugs.json
  const bugs = pkg.bugs.map((b) => convertBug(b, m, evById));
  writeJson(join(staging, "bugs.json"), { version: 1, bugs });

  // 7, 9. manual-tests.json, with generated priority and category.
  const tests = pkg.manualTests.map((t) => convertManualTest(t, m, pkg.bugs, generated));
  writeJson(join(staging, "manual-tests.json"), { version: 1, tests });

  // 3. manifest.json in the import format.
  const title = (/^#\s+(.+)$/m.exec(pkg.report)?.[1] ?? `Audit ${m.audit_id}`).trim().slice(0, 200);
  const starts = m.executions.map((x: Json) => x.started_at).filter(Boolean).sort();
  const ends = m.executions.map((x: Json) => x.finished_at).filter(Boolean).sort();
  const manifest = {
    format: "testbench-audit-package",
    version: 1,
    audit: {
      id: m.audit_id,
      title,
      ...(starts.length ? { startedAt: starts[0] } : {}),
      ...(ends.length ? { finishedAt: ends[ends.length - 1] } : {}),
      project: opts.project,
      agent: { name: text(m.agent?.name), version: "", model: text(m.agent?.model) },
    },
    files,
    parts: { bugs: "bugs.json", manualTests: "manual-tests.json", narrative: "report.md" },
  };
  writeJson(join(staging, "manifest.json"), manifest);

  // 10. provenance.json: where everything came from. Not part of the import format; Testbench ignores it.
  const provenance = {
    format: PROVENANCE_FORMAT,
    version: 1,
    adapter: ADAPTER,
    generatedAt: (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    source: {
      path: relative(dirname(output), input) || ".",
      auditId: m.audit_id,
      contractVersion: CONTRACT_VERSION,
      contractValidation: { ok: contract.ok, errors: contract.errors, warnings: contract.warnings, counts: contract.counts },
      files: Object.fromEntries(["manifest.json", "bugs.json", "manual-tests.json", "report.md"].map((f) => [f, sha256File(join(input, f))])),
    },
    target: { importer: "server/importers/auditpackage.ts", format: "testbench-audit-package", version: 1 },
    project: { key: opts.project, origin: "operator-supplied --project; contract 1.2 has no Testbench project key" },
    idMap: {
      audit: [{ contract: "audit_id", value: m.audit_id, testbench: "audit.id" }],
      bugs: pkg.bugs.map((b) => ({ bug_proposal_id: b.bug_proposal_id, sourceId: b.bug_proposal_id })),
      manualTests: pkg.manualTests.map((t) => ({ manual_test_proposal_id: t.manual_test_proposal_id, sourceId: t.manual_test_proposal_id, requirement_id: t.requirement_id, refsRequirements: t.requirement_id ? [t.requirement_id] : [] })),
    },
    fieldMap: FIELD_MAP,
    categoryMap: TYPE_TO_CATEGORY,
    generated,
    notMapped,
    evidence: evidenceProv,
    delivery: "none: this export is a local folder; nothing was sent to Testbench",
  };
  writeJson(join(staging, "provenance.json"), provenance);

  if (existsSync(output)) rmSync(output, { recursive: true, force: true }); // only reached for an earlier export of this adapter with --overwrite
  mkdirSync(dirname(output), { recursive: true });
  renameSync(staging, output);

  // 11. Testbench's own package check, the same code the import uses, without writing.
  const testbench = checkPackageDir(output, { write: false });
  const written = ["manifest.json", "bugs.json", "manual-tests.json", "report.md", "provenance.json", ...files.map((f) => f.path)];
  return { output, files: written, contract, testbench, provenance };
}
