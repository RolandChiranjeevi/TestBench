import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { zipSync } from "fflate";
import { bagFromFiles } from "./bag.ts";
import { EVIDENCE_EXT, inspectEvidence, PackageError, parsePackage, sha256, type ParsedPackage } from "./auditpackage.ts";

/**
 * Helps a test agent leave a valid audit package behind: fills in the file list of the manifest (sha256 and size of every evidence file),
 * then checks the folder with the same code the import uses. The contract is docs/audit-package.md; nothing here adds to it.
 */

export interface BuildReport {
  ok: boolean;
  /** Reasons the import would refuse the package or drop a file. */
  errors: string[];
  /** Things the import accepts but that a person will notice, among them ids that are unlikely to stay the same between runs. */
  warnings: string[];
  auditId: string | null;
  project: string | null;
  sourceIds: string[];
  /** Compared with --previous: ids in both packages, ids only in this one, and ids only in the previous one. */
  compared: { previousAuditId: string; same: string[]; added: string[]; missing: string[] } | null;
  filesWritten: boolean;
}

function walk(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(root, p));
    else out.push(relative(root, p).split("\\").join("/"));
  }
  return out;
}

/** Every file of the folder, by path inside it. Dot files (.DS_Store and such) are not part of a package. */
export function readPackageDir(dir: string): Map<string, Uint8Array> {
  return new Map(walk(dir).filter((f) => !f.split("/").some((part) => part.startsWith("."))).map((f) => [f, readFileSync(join(dir, f))]));
}

const SEQUENTIAL = /^(bug|issue|finding|defect|f)?[-_ #:]*\d+$/i;

function idWarnings(pkg: ParsedPackage): string[] {
  const w: string[] = [];
  const { id, github } = pkg.manifest.audit;
  if (github && id.includes(String(github.runId))) w.push(`audit.id "${id}" contains the GitHub run id. A new run would then be a new audit and nothing would be recognised again.`);
  if (/\d{1,2}[:.]\d{2}([:.]\d{2})?|T\d{2}|\d{10,}/.test(id)) w.push(`audit.id "${id}" looks like it contains a time or a counter. Use the same id each time the same audit is repeated.`);
  const sequential = pkg.bugs.filter((b) => SEQUENTIAL.test(b.sourceId)).map((b) => b.sourceId);
  if (sequential.length) {
    w.push(`${sequential.length} sourceId${sequential.length === 1 ? " is" : "s are"} a plain number (${sequential.slice(0, 3).join(", ")}${sequential.length > 3 ? ", …" : ""}). Numbers change when the order of findings changes; derive the id from what the finding is about.`);
  }
  const noFingerprint = pkg.bugs.filter((b) => !b.fingerprint).length;
  if (noFingerprint) w.push(`${noFingerprint} finding${noFingerprint === 1 ? " has" : "s have"} no fingerprint, so a later audit cannot point out that it is the same bug again.`);
  return w;
}

/**
 * Checks (and, with write, completes) the package in `dir`. `manifest.json` must exist with the audit section; its `files` and `parts`
 * are what this fills in. `previousDir` is an earlier package of the same audit, to compare ids with.
 */
export function checkPackageDir(dir: string, opts: { write?: boolean; previousDir?: string } = {}): BuildReport {
  const report: BuildReport = { ok: false, errors: [], warnings: [], auditId: null, project: null, sourceIds: [], compared: null, filesWritten: false };
  if (!existsSync(join(dir, "manifest.json"))) {
    report.errors.push("manifest.json is missing. Write the audit section first (see docs/agent-audit-guide.md), then run this again to fill in the file list.");
    return report;
  }
  const files = readPackageDir(dir);
  let manifest: Record<string, any>;
  try {
    manifest = JSON.parse(Buffer.from(files.get("manifest.json")!).toString("utf8"));
  } catch {
    report.errors.push("manifest.json is not valid JSON");
    return report;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    report.errors.push("manifest.json must be a JSON object");
    return report;
  }

  // The file list is derived from the folder, so it can never disagree with it.
  const allowed = (p: string) => EVIDENCE_EXT.has(p.slice(p.lastIndexOf(".")).toLowerCase());
  const evidence = [...files].filter(([p]) => p.startsWith("evidence/") && allowed(p));
  for (const p of files.keys()) if (p.startsWith("evidence/") && !allowed(p)) report.warnings.push(`${p}: this file type is not allowed as evidence and is left out of the manifest`);
  manifest.format = "testbench-audit-package";
  manifest.version = 1;
  manifest.files = evidence.map(([path, bytes]) => ({ path, sha256: sha256(bytes), size: bytes.length }));
  manifest.parts = { bugs: "bugs.json", ...(files.has("report.md") ? { narrative: "report.md" } : {}) };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  files.set("manifest.json", manifestBytes);

  let pkg: ParsedPackage | null = null;
  try {
    pkg = parsePackage(bagFromFiles(files));
  } catch (e) {
    report.errors.push(e instanceof PackageError ? e.message : String(e));
  }
  if (pkg) {
    report.auditId = pkg.manifest.audit.id;
    report.project = pkg.manifest.audit.project;
    report.sourceIds = pkg.bugs.map((b) => b.sourceId);
    report.warnings.push(...pkg.warnings.filter((x) => !/not listed in the manifest/.test(x)));
    const budget = { used: 0 };
    for (const b of pkg.bugs) {
      for (const ev of b.evidence) {
        const c = inspectEvidence(pkg, ev.path, budget);
        if (c.state !== "ok") report.errors.push(`${b.sourceId}: evidence ${ev.path}: ${c.reason}`);
      }
    }
    if (!files.has("report.md")) report.warnings.push("There is no report.md; a person then sees the findings but not your own account of the audit.");
    report.warnings.push(...idWarnings(pkg));

    if (opts.previousDir) {
      try {
        const prev = parsePackage(bagFromFiles(readPackageDir(opts.previousDir)));
        const now = new Set(report.sourceIds);
        const before = new Set(prev.bugs.map((b) => b.sourceId));
        report.compared = {
          previousAuditId: prev.manifest.audit.id,
          same: report.sourceIds.filter((i) => before.has(i)),
          added: report.sourceIds.filter((i) => !before.has(i)),
          missing: [...before].filter((i) => !now.has(i)),
        };
        if (prev.manifest.audit.id !== report.auditId) {
          report.warnings.push(`The previous package has audit.id "${prev.manifest.audit.id}", this one "${report.auditId}". If this is a repeat of the same audit the ids must be equal; otherwise every finding becomes a new report.`);
        }
        if (prev.manifest.audit.project !== report.project) report.errors.push(`The previous package is for project ${prev.manifest.audit.project}, this one for ${report.project}.`);
        if (report.compared.missing.length) report.warnings.push(`Not in this package any more: ${report.compared.missing.join(", ")}. Importing does not remove the earlier reports; if a finding is fixed, say so in report.md.`);
      } catch (e) {
        report.warnings.push(`The previous package could not be read: ${e instanceof PackageError ? e.message : String(e)}`);
      }
    }
  }

  report.ok = report.errors.length === 0;
  if (opts.write && report.ok) {
    writeFileSync(join(dir, "manifest.json"), manifestBytes);
    report.filesWritten = true;
  }
  return report;
}

/** The package as a zip (everything in the folder except dot files), for uploading by hand. */
export function zipPackageDir(dir: string, out: string): number {
  const zipped = zipSync(Object.fromEntries(readPackageDir(dir)));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, zipped);
  return zipped.length;
}
