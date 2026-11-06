import { createHash } from "node:crypto";
import { extname } from "node:path";
import { z } from "zod";
import { MAX_FILE_BYTES, type FileBag } from "./bag.ts";
import { idText, normViewports, normWcag, PRIORITIES, str, viewportSchema, wcagCriterion } from "../shapes.ts";

/**
 * Audit package: what a test agent leaves behind after an exploratory audit. A folder or zip with
 *   manifest.json   the audit (id, agent, project key), and every file with its sha256 and size
 *   bugs.json       { "version": 1, "bugs": [ ... ] }
 *   manual-tests.json  optional, { "version": 1, "tests": [ ... ] }: manual test cases for a person to review and run
 *   report.md       optional, the agent's readable audit (stored and shown as text, never interpreted)
 *   evidence/...    files the bug reports point to
 * It is read the same way whether it arrives as a GitHub artifact or as a manual upload.
 */

/** GitHub artifacts with this name pattern are audit packages (not test reports). */
export const AUDIT_ARTIFACT_PATTERN = "testbench-audit-*";
export const isAuditArtifactName = (name: string) => /^testbench-audit-/i.test(name);

export const LIMITS = {
  files: 1000, // entries in the package
  totalBytes: 500 * 1024 * 1024, // all entries together, unpacked
  fileBytes: MAX_FILE_BYTES, // one file
  bugs: 200,
  manualTests: 200,
  manualTestsBytes: 10 * 1024 * 1024,
  planItems: 500,
  coverageGaps: 500,
  testPlanBytes: 10 * 1024 * 1024,
  manifestBytes: 1024 * 1024,
  bugsBytes: 20 * 1024 * 1024,
  narrativeBytes: 5 * 1024 * 1024,
};

/** The package itself is unusable (bad structure, unsafe, too big). Permanent: retrying the same package never helps. */
export class PackageError extends Error {}

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A relative path inside the package, or null when it could escape it (absolute, drive letter, `..`, empty parts). */
export function safeRelPath(p: string): string | null {
  const n = p.replace(/\\/g, "/");
  if (!n || n.length > 300 || n.startsWith("/") || /^[A-Za-z]:/.test(n) || n.includes("\0")) return null;
  const parts = n.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) return null;
  return parts.join("/");
}

/** Evidence types worth keeping. SVG and HTML are left out: they would run scripts when opened from /uploads. */
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf", ".txt": "text/plain", ".log": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
  ".json": "application/json", ".zip": "application/zip", ".mp4": "video/mp4", ".webm": "video/webm",
};
export const EVIDENCE_EXT = new Set(Object.keys(MIME));
export const mimeFor = (ext: string) => MIME[ext.toLowerCase()] ?? "application/octet-stream";

const SEVERITY = ["low", "medium", "high", "critical"] as const;
const isoLike = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "not a date");
const refList = z.array(str(300)).max(50).default([]);

const manifestSchema = z.object({
  format: z.literal("testbench-audit-package"),
  version: z.literal(1),
  audit: z.object({
    id: idText,
    title: str(200).default(""),
    startedAt: isoLike.optional(),
    finishedAt: isoLike.optional(),
    project: z.string().min(1).max(40),
    agent: z.object({ name: str(100).default(""), version: str(50).default(""), model: str(100).default("") }).default({ name: "", version: "", model: "" }),
    review: z.object({ status: str(50).default(""), method: str(500).default(""), reviewer: str(100).default("") }).optional(),
    github: z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), runId: z.number().int().positive() }).optional(),
  }),
  files: z.array(z.object({ path: z.string().min(1).max(300), sha256: z.string().regex(/^[a-fA-F0-9]{64}$/), size: z.number().int().min(0) })).max(LIMITS.files).default([]),
  parts: z.object({ bugs: str(300).optional(), manualTests: str(300).optional(), testPlan: str(300).optional(), narrative: str(300).optional(), results: z.array(str(300)).optional() }).default({}),
});

const bugSchema = z.object({
  sourceId: idText,
  title: z.string().trim().min(1).max(200),
  description: str(20000).default(""),
  steps: z.array(str(1000)).max(50).default([]),
  expected: str(5000).default(""),
  actual: str(5000).default(""),
  environment: str(200).default(""),
  url: str(2000).default(""),
  toolImpact: z.object({ tool: str(100), value: str(100), ruleId: str(200).optional() }).optional(),
  agentSeverity: z.enum(SEVERITY).optional(),
  confidence: z.number().min(0).max(1).optional(),
  foundAt: isoLike.optional(),
  // The agent's own review is source information only. It never sets the status of the report in Testbench.
  agentReview: z.object({ status: str(50).default(""), method: str(500).default(""), notes: str(5000).default("") }).optional(),
  fingerprint: str(200).default(""),
  recurrenceOf: str(120).default(""),
  refs: z.object({ requirements: refList, cases: refList, tests: refList }).default({ requirements: [], cases: [], tests: [] }),
  evidence: z.array(z.object({ path: z.string().min(1).max(300), label: str(200).default("") })).max(20).default([]),
});
const bugsFileSchema = z.object({ version: z.literal(1), bugs: z.array(z.unknown()).max(LIMITS.bugs) });

export const MANUAL_CATEGORIES = ["functional", "accessibility", "responsive", "usability", "security", "other"] as const;
export type ManualCategory = (typeof MANUAL_CATEGORIES)[number];

/**
 * A manual test case the agent proposes: something a person has to check, because an automatic run cannot decide it. The agent describes
 * the test; it never gives a result or a status.
 */
const manualTestSchema = z
  .object({
    sourceId: idText,
    title: z.string().trim().min(1).max(200),
    description: str(20000).default(""),
    preconditions: str(5000).default(""),
    steps: z.array(z.string().trim().min(1).max(1000)).min(1, "at least one step").max(50),
    expected: z.string().trim().min(1, "say what should happen").max(5000),
    priority: z.enum(PRIORITIES),
    category: z.enum(MANUAL_CATEGORIES),
    wcag: z.array(wcagCriterion).max(20).default([]),
    viewports: z.array(viewportSchema).max(10).default([]),
    refs: z.object({ requirements: refList, cases: refList, tests: refList }).default({ requirements: [], cases: [], tests: [] }),
  })
  .refine((t) => t.category !== "responsive" || t.viewports.length > 0, { message: "a responsive test names at least one viewport, device or breakpoint", path: ["viewports"] })
  .transform((t) => ({ ...t, wcag: normWcag(t.wcag), viewports: normViewports(t.viewports) }));
const manualTestsFileSchema = z.object({ version: z.literal(1), tests: z.array(z.unknown()).max(LIMITS.manualTests) });

export const PLAN_READINESS = ["ready", "needs-clarification"] as const;
/**
 * The status vocabulary of an execution. Reserved for a later step: nothing imports executions yet, and a plan item carries no result.
 * `inconclusive` is a status of its own: it is neither skipped nor untested.
 */
export const RESULT_STATUSES = ["pass", "fail", "blocked", "skipped", "inconclusive"] as const;
/** What a plan item or a coverage gap says about requirements. Only requirements, matched against the project's own by number (REQ-3) or stable id when they are shown. */
const planRefs = z.object({ requirements: refList }).default({ requirements: [] });

/**
 * One planned check of an audit (test-plan.json). Everything but `sourceId` and `title` is optional, so a plan with only the basics imports, and
 * so does one with all of it. It is a plan, not a test case: nothing here says that the check was run.
 */
const planItemSchema = z.object({
  sourceId: idText,
  title: z.string().trim().min(1).max(200),
  type: str(50).default(""),
  risk: str(200).default(""),
  priority: str(50).default(""),
  readiness: z.enum(PLAN_READINESS).optional(),
  preconditions: str(5000).default(""),
  testData: str(2000).default(""),
  steps: z.array(str(1000)).max(50).default([]),
  acceptanceCriteria: str(5000).default(""),
  automation: str(200).default(""),
  refs: planRefs,
});
/** Something the audit did not verify, and why. */
const coverageGapSchema = z.object({ sourceId: idText, description: z.string().trim().min(1).max(5000), refs: planRefs });
const testPlanFileSchema = z.object({
  version: z.literal(1),
  planItems: z.array(z.unknown()).max(LIMITS.planItems).default([]),
  coverageGaps: z.array(z.unknown()).max(LIMITS.coverageGaps).default([]),
});

const PLAN_FILE_KEYS = ["version", "planItems", "coverageGaps"];
const PLAN_ITEM_KEYS = Object.keys(planItemSchema.shape);
const GAP_KEYS = Object.keys(coverageGapSchema.shape);
const REF_KEYS = ["requirements"];
const camel = (k: string) => k.replace(/[_-]+([a-z0-9])/gi, (_, c: string) => c.toUpperCase());

/**
 * The names in test-plan.json that the import does not know. The schemas strip an unknown name, so a plan item written with `test_data`
 * instead of `testData` would import without that field and without a message. This lists them instead, with the likely intended name
 * ("test_data" -> "testData"). It only reports: what the import ignores is still ignored.
 */
function unknownNames(value: unknown, known: string[], label: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const out: string[] = [];
  for (const k of Object.keys(value)) {
    if (known.includes(k)) continue;
    const guess = camel(k);
    out.push(known.includes(guess) ? `${label}: "${k}" is not a name the import knows and was ignored; did you mean "${guess}"?` : `${label}: "${k}" is not a name the import knows and was ignored`);
  }
  return out;
}

export type Manifest = z.infer<typeof manifestSchema>;
export type BugItem = z.infer<typeof bugSchema>;
export type ManualTestItem = z.infer<typeof manualTestSchema>;
export type PlanItem = z.infer<typeof planItemSchema>;
export type CoverageGapItem = z.infer<typeof coverageGapSchema>;

export interface ParsedPackage {
  manifest: Manifest;
  bugs: BugItem[];
  /** The manual tests of the package; null when it has no manual-tests.json at all (which says nothing about earlier manual tests). */
  manualTests: ManualTestItem[] | null;
  /** The test plan of the package; null when it has no test-plan.json at all (which says nothing about an earlier plan of the same audit). */
  testPlan: { planItems: PlanItem[]; coverageGaps: CoverageGapItem[] } | null;
  /** Prefix of the package inside the bag: "" for the root, "folder/" when everything sits in one folder. */
  root: string;
  bag: FileBag;
  packageSha256: string;
  narrative: Uint8Array | null;
  /** manifest.files by normalised path. */
  declared: Map<string, { sha256: string; size: number }>;
  warnings: string[];
}

const issues = (e: z.ZodError) =>
  e.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") + (e.issues.length > 5 ? ` (+${e.issues.length - 5} more)` : "");

function readJson(bag: FileBag, name: string, max: number, what: string): { value: unknown; bytes: Uint8Array } {
  if (!bag.names.includes(name)) throw new PackageError(`${what} not found in the package (${name})`);
  if (bag.size(name) > max) throw new PackageError(`${what} is larger than ${Math.round(max / 1024 / 1024)} MB`);
  const bytes = bag.read(name);
  if (!bytes || bytes.length > max) throw new PackageError(`${what} could not be read`);
  try {
    return { value: JSON.parse(Buffer.from(bytes).toString("utf8")), bytes };
  } catch {
    throw new PackageError(`${what} is not valid JSON`);
  }
}

/** Looks for a manifest at the root or one folder down (a picked folder arrives as "folder/manifest.json"). */
function findManifest(bag: FileBag): string | null {
  const names = bag.names.filter((n) => /(^|\/)manifest\.json$/i.test(n) && n.split("/").length <= 2).sort((a, b) => a.split("/").length - b.split("/").length);
  for (const n of names) {
    if (bag.size(n) > LIMITS.manifestBytes) continue;
    const bytes = bag.read(n);
    if (!bytes) continue;
    try {
      if ((JSON.parse(Buffer.from(bytes).toString("utf8")) as { format?: string }).format === "testbench-audit-package") return n;
    } catch {
      /* some other manifest.json */
    }
  }
  return null;
}

export function isAuditPackage(bag: FileBag): boolean {
  return findManifest(bag) !== null;
}

/** Reads and validates everything except the evidence files themselves. Throws PackageError with a message the user can act on. */
export function parsePackage(bag: FileBag): ParsedPackage {
  // Size and count are checked from the zip's table of contents, before anything is unpacked.
  if (bag.names.length > LIMITS.files) throw new PackageError(`The package has ${bag.names.length} files; the limit is ${LIMITS.files}`);
  const total = bag.names.reduce((sum, n) => sum + bag.size(n), 0);
  if (total > LIMITS.totalBytes) throw new PackageError(`The package is ${Math.round(total / 1024 / 1024)} MB unpacked; the limit is ${LIMITS.totalBytes / 1024 / 1024} MB`);

  const manifestPath = findManifest(bag);
  if (!manifestPath) throw new PackageError('No audit package found: expected a manifest.json with "format": "testbench-audit-package"');
  const root = manifestPath.includes("/") ? manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1) : "";

  const m = readJson(bag, manifestPath, LIMITS.manifestBytes, "manifest.json");
  const parsedManifest = manifestSchema.safeParse(m.value);
  if (!parsedManifest.success) throw new PackageError(`manifest.json: ${issues(parsedManifest.error)}`);
  const manifest = parsedManifest.data;

  const declared = new Map<string, { sha256: string; size: number }>();
  for (const f of manifest.files) {
    const p = safeRelPath(f.path);
    if (!p) throw new PackageError(`manifest.json lists an unsafe path: ${JSON.stringify(f.path.slice(0, 80))}`);
    if (declared.has(p)) throw new PackageError(`manifest.json lists ${p} twice`);
    declared.set(p, { sha256: f.sha256.toLowerCase(), size: f.size });
  }

  const bugsPath = safeRelPath(manifest.parts.bugs ?? "bugs.json");
  if (!bugsPath) throw new PackageError("parts.bugs is not a safe path");
  const b = readJson(bag, root + bugsPath, LIMITS.bugsBytes, bugsPath);
  const bugsFile = bugsFileSchema.safeParse(b.value);
  if (!bugsFile.success) throw new PackageError(`${bugsPath}: ${issues(bugsFile.error)}`);
  const bugs: BugItem[] = [];
  const seen = new Set<string>();
  bugsFile.data.bugs.forEach((raw, i) => {
    const r = bugSchema.safeParse(raw);
    if (!r.success) throw new PackageError(`${bugsPath}: bug #${i + 1}: ${issues(r.error)}`);
    if (seen.has(r.data.sourceId)) throw new PackageError(`${bugsPath}: sourceId "${r.data.sourceId}" appears twice`);
    seen.add(r.data.sourceId);
    bugs.push(r.data);
  });

  let manualTests: ManualTestItem[] | null = null;
  let manualPath: string | null = null;
  let manualBytes: Uint8Array | null = null;
  const declaredManual = manifest.parts.manualTests;
  if (declaredManual !== undefined && !safeRelPath(declaredManual)) throw new PackageError("parts.manualTests is not a safe path");
  const manualName = safeRelPath(declaredManual ?? "manual-tests.json");
  if (manualName && (declaredManual !== undefined || bag.names.includes(root + manualName))) {
    manualPath = manualName;
    const mt = readJson(bag, root + manualName, LIMITS.manualTestsBytes, manualName);
    manualBytes = mt.bytes;
    const file = manualTestsFileSchema.safeParse(mt.value);
    if (!file.success) throw new PackageError(`${manualName}: ${issues(file.error)}`);
    manualTests = [];
    const seenManual = new Set<string>();
    file.data.tests.forEach((raw, i) => {
      const r = manualTestSchema.safeParse(raw);
      if (!r.success) throw new PackageError(`${manualName}: test #${i + 1}${typeof (raw as { sourceId?: unknown })?.sourceId === "string" ? ` (${(raw as { sourceId: string }).sourceId})` : ""}: ${issues(r.error)}`);
      if (seenManual.has(r.data.sourceId)) throw new PackageError(`${manualName}: sourceId "${r.data.sourceId}" appears twice`);
      seenManual.add(r.data.sourceId);
      manualTests!.push(r.data);
    });
  }

  const warnings: string[] = [];
  let testPlan: ParsedPackage["testPlan"] = null;
  let testPlanPath: string | null = null;
  let testPlanBytes: Uint8Array | null = null;
  const declaredPlan = manifest.parts.testPlan;
  if (declaredPlan !== undefined && !safeRelPath(declaredPlan)) throw new PackageError("parts.testPlan is not a safe path");
  const planName = safeRelPath(declaredPlan ?? "test-plan.json");
  if (planName && (declaredPlan !== undefined || bag.names.includes(root + planName))) {
    testPlanPath = planName;
    const tp = readJson(bag, root + planName, LIMITS.testPlanBytes, planName);
    testPlanBytes = tp.bytes;
    const file = testPlanFileSchema.safeParse(tp.value);
    if (!file.success) throw new PackageError(`${planName}: ${issues(file.error)}`);
    const named = (raw: unknown) => (typeof (raw as { sourceId?: unknown })?.sourceId === "string" ? ` (${(raw as { sourceId: string }).sourceId})` : "");
    warnings.push(...unknownNames(tp.value, PLAN_FILE_KEYS, planName));
    const plan = { planItems: [] as PlanItem[], coverageGaps: [] as CoverageGapItem[] };
    const seenItems = new Set<string>();
    file.data.planItems.forEach((raw, i) => {
      const r = planItemSchema.safeParse(raw);
      if (!r.success) throw new PackageError(`${planName}: plan item #${i + 1}${named(raw)}: ${issues(r.error)}`);
      if (seenItems.has(r.data.sourceId)) throw new PackageError(`${planName}: plan item sourceId "${r.data.sourceId}" appears twice`);
      seenItems.add(r.data.sourceId);
      const at = `${planName}: plan item ${r.data.sourceId}`;
      warnings.push(...unknownNames(raw, PLAN_ITEM_KEYS, at), ...unknownNames((raw as { refs?: unknown }).refs, REF_KEYS, `${at} refs`));
      plan.planItems.push(r.data);
    });
    const seenGaps = new Set<string>();
    file.data.coverageGaps.forEach((raw, i) => {
      const r = coverageGapSchema.safeParse(raw);
      if (!r.success) throw new PackageError(`${planName}: coverage gap #${i + 1}${named(raw)}: ${issues(r.error)}`);
      if (seenGaps.has(r.data.sourceId)) throw new PackageError(`${planName}: coverage gap sourceId "${r.data.sourceId}" appears twice`);
      seenGaps.add(r.data.sourceId);
      const at = `${planName}: coverage gap ${r.data.sourceId}`;
      warnings.push(...unknownNames(raw, GAP_KEYS, at), ...unknownNames((raw as { refs?: unknown }).refs, REF_KEYS, `${at} refs`));
      plan.coverageGaps.push(r.data);
    });
    testPlan = plan;
  }

  let narrative: Uint8Array | null = null;
  const narrativePath = manifest.parts.narrative ? safeRelPath(manifest.parts.narrative) : bag.names.includes(root + "report.md") ? "report.md" : null;
  if (manifest.parts.narrative && !narrativePath) warnings.push("parts.narrative is not a safe path; the audit report was not stored");
  else if (narrativePath) {
    const name = root + narrativePath;
    if (!bag.names.includes(name)) warnings.push(`The audit report ${narrativePath} is missing from the package`);
    else if (bag.size(name) > LIMITS.narrativeBytes) warnings.push(`The audit report ${narrativePath} is larger than ${LIMITS.narrativeBytes / 1024 / 1024} MB and was not stored`);
    else narrative = bag.read(name);
  }
  if (manifest.parts.results?.length) warnings.push("The package lists test results. Test results are not imported from an audit package in this version; use the normal import for them.");
  if (bag.names.includes(root + "cases.json")) warnings.push("cases.json is present but test cases are not imported from an audit package in this version.");
  const listed = new Set([...declared.keys(), manifestPath.slice(root.length), bugsPath, ...(manualPath ? [manualPath] : []), ...(testPlanPath ? [testPlanPath] : []), ...(narrativePath ? [narrativePath] : [])]);
  const unlisted = bag.names.filter((n) => n.startsWith(root) && !listed.has(n.slice(root.length))).length;
  if (unlisted) warnings.push(`${unlisted} file${unlisted === 1 ? "" : "s"} in the package ${unlisted === 1 ? "is" : "are"} not listed in the manifest and ${unlisted === 1 ? "was" : "were"} ignored`);

  return { manifest, bugs, manualTests, testPlan, root, bag, packageSha256: sha256(Buffer.concat([m.bytes, b.bytes, ...(manualBytes ? [manualBytes] : []), ...(testPlanBytes ? [testPlanBytes] : [])])), narrative, declared, warnings };
}

export interface EvidenceCheck {
  path: string;
  /** ok = can be stored; the others are shown to the user with `reason`. */
  state: "ok" | "rejected" | "missing" | "checksum_mismatch";
  reason: string;
  filename: string;
  ext: string;
  mime: string;
  size: number;
  sha256: string | null;
}

/** Decides whether one piece of evidence can be stored, reading and hashing the file. Nothing is written. */
export function inspectEvidence(pkg: ParsedPackage, rawPath: string, budget: { used: number }): EvidenceCheck {
  const path = safeRelPath(rawPath);
  const base = (rawPath.replace(/\\/g, "/").split("/").pop() ?? "file").slice(0, 200) || "file";
  const out = (state: EvidenceCheck["state"], reason: string, extra: Partial<EvidenceCheck> = {}): EvidenceCheck => ({
    path: path ?? rawPath.slice(0, 300), state, reason, filename: base, ext: extname(base).toLowerCase(), mime: "application/octet-stream", size: 0, sha256: null, ...extra,
  });
  if (!path) return out("rejected", "unsafe path");
  const ext = extname(path).toLowerCase();
  if (!EVIDENCE_EXT.has(ext)) return out("rejected", `file type ${ext || "(none)"} is not allowed`);
  const decl = pkg.declared.get(path);
  if (!decl) return out("rejected", "not listed in the manifest");
  const name = pkg.root + path;
  if (!pkg.bag.names.includes(name)) return out("missing", "the file is not in the package", { sha256: decl.sha256 });
  if (decl.size > LIMITS.fileBytes || pkg.bag.size(name) > LIMITS.fileBytes) return out("rejected", `larger than ${LIMITS.fileBytes / 1024 / 1024} MB`, { sha256: decl.sha256 });
  if (budget.used + pkg.bag.size(name) > LIMITS.totalBytes) return out("rejected", "the package's evidence is over the total size limit", { sha256: decl.sha256 });
  const bytes = pkg.bag.read(name);
  if (!bytes) return out("missing", "the file could not be read", { sha256: decl.sha256 });
  if (bytes.length !== decl.size || sha256(bytes) !== decl.sha256) return out("checksum_mismatch", "size or sha256 differs from the manifest", { sha256: decl.sha256 });
  budget.used += bytes.length;
  return out("ok", "", { ext, mime: mimeFor(ext), size: bytes.length, sha256: decl.sha256 });
}

/** The evidence file's bytes, read again right before it is stored. */
export function readEvidence(pkg: ParsedPackage, path: string): Uint8Array | null {
  const p = safeRelPath(path);
  return p ? pkg.bag.read(pkg.root + p) : null;
}
