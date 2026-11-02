import { createHash } from "node:crypto";
import { extname } from "node:path";
import { z } from "zod";
import { MAX_FILE_BYTES, type FileBag } from "./bag.ts";

/**
 * Audit package: what a test agent leaves behind after an exploratory audit. A folder or zip with
 *   manifest.json   the audit (id, agent, project key), and every file with its sha256 and size
 *   bugs.json       { "version": 1, "bugs": [ ... ] }
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
const idText = z.string().min(1).max(120).regex(/^[\w.:\-/]+$/, "use letters, digits and . _ : - /");
const str = (max: number) => z.string().max(max);
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
  parts: z.object({ bugs: str(300).optional(), narrative: str(300).optional(), results: z.array(str(300)).optional() }).default({}),
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

export type Manifest = z.infer<typeof manifestSchema>;
export type BugItem = z.infer<typeof bugSchema>;

export interface ParsedPackage {
  manifest: Manifest;
  bugs: BugItem[];
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

  const warnings: string[] = [];
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
  const listed = new Set([...declared.keys(), manifestPath.slice(root.length), bugsPath, ...(narrativePath ? [narrativePath] : [])]);
  const unlisted = bag.names.filter((n) => n.startsWith(root) && !listed.has(n.slice(root.length))).length;
  if (unlisted) warnings.push(`${unlisted} file${unlisted === 1 ? "" : "s"} in the package ${unlisted === 1 ? "is" : "are"} not listed in the manifest and ${unlisted === 1 ? "was" : "were"} ignored`);

  return { manifest, bugs, root, bag, packageSha256: sha256(Buffer.concat([m.bytes, b.bytes])), narrative, declared, warnings };
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
