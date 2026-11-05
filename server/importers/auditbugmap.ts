import { CONTRACT_VERSION } from "./auditcontract.ts";

/**
 * Explicit mapping of an audit contract 1.2 bug proposal to a Testbench bug report (server/importers/auditpackage.ts, bugSchema).
 *
 * Contract 1.2 says only that a bug proposal's fields are the sections of `.claude/skills/bug-reporting/templates/bug-report.md` in snake case, plus
 * a few named ones (section 5.2). The exact shape of each section is therefore declared here, in BUG_FIELD_SPEC, and every field of every bug is
 * read against it. Rules:
 *  - A field that is missing or has an unexpected shape gives a warning that names the bug_proposal_id and the field. The Testbench field it would
 *    have filled is left empty: no value is made up, and nothing is guessed from another field.
 *  - A field the mapping does not know is reported, never dropped silently.
 *  - Only two things stop the export: a bug without a valid bug_proposal_id (it has no sourceId) and a bug without a title (the importer
 *    requires one). Everything else degrades one field at a time, and the rest of the bug is still mapped.
 *  - Everything that was missing, deviating or not exported is returned in a BugMapReport, which provenance.json carries.
 */

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export class BugMappingError extends Error {}

export interface BugFieldSpec {
  field: string;
  /** Other places that are accepted for the same value, after `field`. */
  alternatives?: string[];
  /** The shape that is accepted. */
  accepts: string;
  mapsTo: string;
  /** required: the export stops without it. expected: a warning when missing or deviating. optional: no warning when absent, a warning when deviating. */
  need: "required" | "expected" | "optional";
}

export const BUG_FIELD_SPEC: BugFieldSpec[] = [
  { field: "bug_proposal_id", accepts: "string BP-nnn", mapsTo: "bugs[].sourceId", need: "required" },
  { field: "title", accepts: "non-empty string", mapsTo: "bugs[].title", need: "required" },
  { field: "finding_category", accepts: "functional | visual | accessibility", mapsTo: "bugs[].description (a line)", need: "expected" },
  { field: "requirement_link.requirement_id", alternatives: ["requirement_id"], accepts: "the id of a requirement in manifest.requirements", mapsTo: "bugs[].refs.requirements", need: "expected" },
  { field: "requirement_link.acceptance_criterion", accepts: "non-empty string", mapsTo: "bugs[].description (a line)", need: "expected" },
  { field: "requirement_link.test_plan_item_id", accepts: "the id of a test plan item in manifest.test_plan_items", mapsTo: "bugs[].description (a line)", need: "expected" },
  { field: "execution_ids", accepts: "array of EX-nnn that exist in manifest.executions", mapsTo: "bugs[].description (a line) and bugs[].foundAt (the first fail execution)", need: "expected" },
  { field: "preconditions", accepts: "array of non-empty strings", mapsTo: "bugs[].description (a line)", need: "expected" },
  { field: "environment", accepts: "object with url, test_environment, browser, viewport and optionally build", mapsTo: "the environment.* rows", need: "expected" },
  { field: "environment.url", accepts: "non-empty string", mapsTo: "bugs[].url", need: "expected" },
  { field: "environment.test_environment", accepts: "non-empty string", mapsTo: "bugs[].environment", need: "expected" },
  { field: "environment.browser", accepts: "non-empty string", mapsTo: "bugs[].description (a line)", need: "expected" },
  { field: "environment.viewport", accepts: "non-empty string", mapsTo: "bugs[].description (a line)", need: "expected" },
  { field: "environment.build", accepts: "non-empty string", mapsTo: "bugs[].description (a line)", need: "optional" },
  { field: "steps_to_reproduce", accepts: "array of non-empty strings", mapsTo: "bugs[].steps", need: "expected" },
  { field: "expected_result", accepts: "non-empty string", mapsTo: "bugs[].expected", need: "expected" },
  { field: "actual_result", accepts: "non-empty string", mapsTo: "bugs[].actual", need: "expected" },
  { field: "reproduction_rate", accepts: "non-empty string, or {rate: string, attempts?: string | number}", mapsTo: "bugs[].description (a line)", need: "expected" },
  { field: "severity", accepts: "critical | high | medium | low (any case), or {level: one of those, rationale?: string}", mapsTo: "bugs[].agentSeverity (and the rationale in description)", need: "expected" },
  { field: "agent_confidence", accepts: "high | medium | low (any case), or {level: one of those, basis?: string}", mapsTo: "bugs[].description (a line; never turned into a number)", need: "expected" },
  { field: "duplicate_check", accepts: "not_available | no_match | possible_match | uncertain_match", mapsTo: "bugs[].description (a line)", need: "expected" },
  { field: "possible_duplicate_of", accepts: "non-empty string", mapsTo: "bugs[].description (in the duplicate check line)", need: "optional" },
  { field: "duplicate_check_notes", accepts: "non-empty string", mapsTo: "bugs[].description (in the duplicate check line)", need: "optional" },
  { field: "evidence_ids", accepts: "array of EV-nnn that exist in manifest.evidence; at most 20 are exported", mapsTo: "bugs[].evidence[] (the files also go into manifest.files[])", need: "expected" },
];

/** Fields that exist in a bug proposal, are known, and are deliberately not exported. They are noted in the report, not warned about. */
const KNOWN_NOT_EXPORTED = ["status", "proposed_manual_test", "requirement_link.execution_ids"];
const TOP_KEYS = new Set([
  "bug_proposal_id", "title", "finding_category", "requirement_link", "requirement_id", "execution_ids", "preconditions", "environment", "steps_to_reproduce",
  "expected_result", "actual_result", "reproduction_rate", "severity", "agent_confidence", "duplicate_check", "possible_duplicate_of", "duplicate_check_notes",
  "evidence_ids", "status", "proposed_manual_test",
]);
const NESTED_KEYS: Record<string, Set<string>> = {
  requirement_link: new Set(["requirement_id", "acceptance_criterion", "test_plan_item_id", "execution_ids"]),
  environment: new Set(["url", "browser", "viewport", "build", "test_environment"]),
};

export interface BugMapReport {
  bug_proposal_id: string;
  mapped: { from: string; to: string }[];
  missing: { field: string; mapsTo: string; effect: string }[];
  unexpectedFormat: { field: string; accepts: string; found: string; valuePreview: string; effect: string }[];
  /** Fields in the bug that the mapping does not know. Not exported. */
  unmappedFields: string[];
  notes: string[];
}

export interface MappedBug {
  bug: Json;
  report: BugMapReport;
  warnings: string[];
}

type Read<T> = { ok: true; value: T } | { ok: false; why: "missing" } | { ok: false; why: "unexpected"; raw: unknown };
const MISSING = { ok: false, why: "missing" } as const;

const get = (o: Json, path: string): unknown => path.split(".").reduce((v: Json, k) => (v != null && typeof v === "object" ? v[k] : undefined), o);
const isBlank = (v: unknown) => v == null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
const foundType = (v: unknown) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
const preview = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
};
const unexpected = (raw: unknown): Read<never> => ({ ok: false, why: "unexpected", raw });

const readStr = (b: Json, path: string): Read<string> => {
  const v = get(b, path);
  if (isBlank(v)) return MISSING;
  return typeof v === "string" ? { ok: true, value: v.trim() } : unexpected(v);
};
const readStrList = (b: Json, path: string): Read<string[]> => {
  const v = get(b, path);
  if (isBlank(v)) return MISSING;
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim()) ? { ok: true, value: v.map((x: string) => x.trim()) } : unexpected(v);
};
const readEnum = (b: Json, path: string, allowed: readonly string[]): Read<string> => {
  const r = readStr(b, path);
  return r.ok && !allowed.includes(r.value) ? unexpected(get(b, path)) : r;
};
/** A level given as a string, or as an object {level, <extraKey>}. */
const readLevel = (b: Json, path: string, allowed: readonly string[], extraKey: string): Read<{ level: string; original: string; extra?: string }> => {
  const v = get(b, path);
  if (isBlank(v)) return MISSING;
  let original: string;
  let extra: string | undefined;
  if (typeof v === "string") original = v.trim();
  else if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as Json).level === "string") {
    original = (v as Json).level.trim();
    const e = (v as Json)[extraKey];
    if (typeof e === "string" && e.trim()) extra = e.trim();
  } else return unexpected(v);
  const level = original.toLowerCase();
  return allowed.includes(level) ? { ok: true, value: { level, original, extra } } : unexpected(v);
};
const readRate = (b: Json, path: string): Read<string> => {
  const v = get(b, path);
  if (isBlank(v)) return MISSING;
  if (typeof v === "string") return { ok: true, value: v.trim() };
  if (typeof v === "object" && !Array.isArray(v) && typeof (v as Json).rate === "string" && (v as Json).rate.trim()) {
    const a = (v as Json).attempts;
    if (a === undefined || typeof a === "string" || typeof a === "number") return { ok: true, value: `${(v as Json).rate.trim()}${a !== undefined ? ` (attempts: ${a})` : ""}` };
  }
  return unexpected(v);
};

const text = (v: unknown): string => (v == null ? "" : String(v));

/**
 * Maps one bug proposal. Throws BugMappingError only when the bug cannot be given a sourceId or a title; every other problem is a warning and
 * a record in the returned report.
 */
export function mapBug(b: Json, index: number, m: Json, evById: Map<string, Json>): MappedBug {
  const id = typeof b?.bug_proposal_id === "string" && /^BP-\d{3,}$/.test(b.bug_proposal_id) ? (b.bug_proposal_id as string) : null;
  if (!id) throw new BugMappingError(`bug #${index + 1} in bugs.json has no valid bug_proposal_id (BP-nnn), so it cannot be given a sourceId`);
  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title) throw new BugMappingError(`bug ${id} has no title (a non-empty string), which the Testbench import requires`);

  const report: BugMapReport = { bug_proposal_id: id, mapped: [], missing: [], unexpectedFormat: [], unmappedFields: [], notes: [] };
  const warnings: string[] = [];
  const spec = new Map(BUG_FIELD_SPEC.map((s) => [s.field, s]));
  const warn = (msg: string) => warnings.push(`bug ${id}: ${msg}`);
  const missing = (field: string, effect: string) => {
    report.missing.push({ field, mapsTo: spec.get(field)?.mapsTo ?? "", effect });
    warn(`field "${field}" is missing; ${effect}`);
  };
  const deviating = (field: string, raw: unknown, effect: string) => {
    const accepts = spec.get(field)?.accepts ?? "";
    report.unexpectedFormat.push({ field, accepts, found: foundType(raw), valuePreview: preview(raw), effect });
    warn(`field "${field}" has an unexpected format (accepts: ${accepts}; found: ${foundType(raw)}); ${effect}`);
  };
  /** Uses a field's value, or records why it could not be used. Returns the value when it was used. */
  const take = <T>(r: Read<T>, field: string, effect: string): T | undefined => {
    if (r.ok) {
      report.mapped.push({ from: field, to: spec.get(field)?.mapsTo ?? "" });
      return r.value;
    }
    if (r.why === "missing") {
      if (spec.get(field)?.need !== "optional") missing(field, effect);
    } else deviating(field, r.raw, effect);
    return undefined;
  };

  const lines: string[] = [`Converted from audit contract ${CONTRACT_VERSION} bug proposal ${id} in audit ${m.audit_id}.`];
  const line = (label: string, value: string | undefined) => value && lines.push(`${label}: ${value}`);
  const inDescription = "the line is left out of description";

  line("Finding category", take(readEnum(b, "finding_category", ["functional", "visual", "accessibility"]), "finding_category", inDescription));

  // Requirement link. The requirement id may be in requirement_link or at the top level; the link wins.
  const reqIds = new Set<string>((m.requirements ?? []).map((r: Json) => r.requirement_id));
  const tpiIds = new Set<string>((m.test_plan_items ?? []).map((t: Json) => t.test_plan_item_id));
  const reqLink = readStr(b, "requirement_link.requirement_id");
  const reqTop = readStr(b, "requirement_id");
  if (reqLink.ok && reqTop.ok && reqLink.value !== reqTop.value) warn(`requirement_link.requirement_id (${reqLink.value}) and requirement_id (${reqTop.value}) differ; ${reqLink.value} is used`);
  const reqRead: Read<string> = reqLink.ok || reqLink.why === "unexpected" ? reqLink : reqTop;
  let requirement: string | undefined;
  if (reqRead.ok && !reqIds.has(reqRead.value)) deviating("requirement_link.requirement_id", reqRead.value, "bugs[].refs.requirements is left empty (the id is not in manifest.requirements)");
  else requirement = take(reqRead, "requirement_link.requirement_id", "bugs[].refs.requirements is left empty");
  const criterion = take(readStr(b, "requirement_link.acceptance_criterion"), "requirement_link.acceptance_criterion", inDescription);
  const tpiRead = readStr(b, "requirement_link.test_plan_item_id");
  let tpi: string | undefined;
  if (tpiRead.ok && !tpiIds.has(tpiRead.value)) deviating("requirement_link.test_plan_item_id", tpiRead.value, `${inDescription} (the id is not in manifest.test_plan_items)`);
  else tpi = take(tpiRead, "requirement_link.test_plan_item_id", inDescription);
  if (requirement) lines.push(`Requirement: ${requirement}${criterion ? `, criterion: ${criterion}` : ""}`);
  else if (criterion) lines.push(`Criterion: ${criterion}`);
  line("Test plan item", tpi);

  // Executions: used for the description and for foundAt.
  const exs = new Map<string, Json>((m.executions ?? []).map((x: Json) => [x.execution_id, x]));
  const execRead = readStrList(b, "execution_ids");
  let executionIds: string[] | undefined;
  if (execRead.ok && execRead.value.some((e) => !exs.has(e))) deviating("execution_ids", execRead.value, `${inDescription}, and bugs[].foundAt is not set (an id is not in manifest.executions)`);
  else executionIds = take(execRead, "execution_ids", `${inDescription}, and bugs[].foundAt is not set`);
  if (executionIds) lines.push(`Executions: ${executionIds.join(", ")}`);
  const firstFail = (executionIds ?? []).map((e) => exs.get(e)).find((x) => x?.status === "fail");
  const foundAt: string | undefined = firstFail?.finished_at;

  const pre = take(readStrList(b, "preconditions"), "preconditions", inDescription);
  if (pre) lines.push(`Preconditions: ${pre.join("; ")}`);

  // Environment: an object. When it is not, its parts are not each reported as missing.
  const envRaw = get(b, "environment");
  const envEffect = "bugs[].url, bugs[].environment and the browser, viewport and build lines are left out";
  let url: string | undefined;
  let environment: string | undefined;
  if (isBlank(envRaw)) missing("environment", envEffect);
  else if (typeof envRaw !== "object" || Array.isArray(envRaw)) deviating("environment", envRaw, envEffect);
  else {
    url = take(readStr(b, "environment.url"), "environment.url", "bugs[].url is left empty");
    environment = take(readStr(b, "environment.test_environment"), "environment.test_environment", "bugs[].environment is left empty");
    line("Browser", take(readStr(b, "environment.browser"), "environment.browser", inDescription));
    line("Viewport", take(readStr(b, "environment.viewport"), "environment.viewport", inDescription));
    line("Build", take(readStr(b, "environment.build"), "environment.build", inDescription));
  }

  const steps = take(readStrList(b, "steps_to_reproduce"), "steps_to_reproduce", "bugs[].steps is left empty");
  const expected = take(readStr(b, "expected_result"), "expected_result", "bugs[].expected is left empty");
  const actual = take(readStr(b, "actual_result"), "actual_result", "bugs[].actual is left empty");
  line("Reproduction rate", take(readRate(b, "reproduction_rate"), "reproduction_rate", inDescription));

  const sev = take(readLevel(b, "severity", ["critical", "high", "medium", "low"], "rationale"), "severity", "bugs[].agentSeverity is not set");
  if (sev?.extra) lines.push(`Severity rationale: ${sev.extra}`);
  const conf = take(readLevel(b, "agent_confidence", ["high", "medium", "low"], "basis"), "agent_confidence", inDescription);
  if (conf) {
    lines.push(`Agent confidence: ${conf.original}${conf.extra ? ` (${conf.extra})` : ""}`);
    report.notes.push("agent_confidence is written into description as text; it is not turned into the number that bugs[].confidence needs");
  }

  const dup = take(readEnum(b, "duplicate_check", ["not_available", "no_match", "possible_match", "uncertain_match"]), "duplicate_check", inDescription);
  if (dup) {
    const of = take(readStr(b, "possible_duplicate_of"), "possible_duplicate_of", inDescription);
    const notes = take(readStr(b, "duplicate_check_notes"), "duplicate_check_notes", inDescription);
    lines.push(`Duplicate check: ${dup}${of ? `, possible duplicate of ${of}` : ""}${notes ? ` (${notes})` : ""}`);
  }

  // Evidence: every evidence id must be a known evidence object. Files become bugs[].evidence[]; the same files are in manifest.files[].
  const evidence: { path: string; label: string }[] = [];
  const evList = take(readStrList(b, "evidence_ids"), "evidence_ids", "bugs[].evidence is empty");
  for (const evId of evList ?? []) {
    const e = evById.get(evId);
    if (!e) throw new BugMappingError(`bug ${id} names evidence ${evId}, which is not in manifest.evidence`);
    const loc = text(e.location);
    if (!loc.startsWith("evidence/")) {
      warn(`evidence ${evId} is not a file in evidence/ (${preview(loc)}), so it is not exported as bugs[].evidence`);
      report.notes.push(`evidence ${evId} is a link, not a file; not exported`);
      continue;
    }
    evidence.push({ path: loc, label: `${evId}: ${text(e.description)}`.slice(0, 200) });
  }
  if (evidence.length > 20) {
    const omitted = evidence.slice(20).map((e) => e.path);
    evidence.length = 20;
    warn(`it cites more than 20 evidence files; the Testbench import accepts 20, so ${omitted.join(", ")} are not exported as bugs[].evidence`);
  }

  // Fields this mapping does not know are reported, never dropped silently.
  for (const key of Object.keys(b)) {
    if (!TOP_KEYS.has(key)) report.unmappedFields.push(key);
    else if (NESTED_KEYS[key] && b[key] && typeof b[key] === "object" && !Array.isArray(b[key])) {
      for (const sub of Object.keys(b[key])) if (!NESTED_KEYS[key].has(sub)) report.unmappedFields.push(`${key}.${sub}`);
    }
  }
  for (const f of report.unmappedFields) warn(`field "${f}" is not part of the bug mapping and was not exported`);
  for (const f of KNOWN_NOT_EXPORTED) if (get(b, f) !== undefined) report.notes.push(`"${f}" is known and deliberately not exported`);

  const bug = {
    sourceId: id,
    title,
    description: lines.join("\n"),
    steps: steps ?? [],
    expected: expected ?? "",
    actual: actual ?? "",
    environment: environment ?? "",
    url: url ?? "",
    ...(sev ? { agentSeverity: sev.level } : {}),
    ...(foundAt ? { foundAt } : {}),
    refs: { requirements: requirement ? [requirement] : [], cases: [], tests: [] },
    evidence,
  };
  return { bug, report, warnings };
}
