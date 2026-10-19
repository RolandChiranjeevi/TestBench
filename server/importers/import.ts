import { linkCaseByText } from "../requirements.ts";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { db, ensureMilestone, UPLOAD_DIR } from "../db.ts";
import { resolveEntry, type FileBag } from "./bag.ts";
import { extractCaseRefs, type AttachmentRef, type ParsedReport } from "./parse.ts";

/** Evidence types worth keeping. Anything else in an artifact (html reports, node_modules...) is ignored. */
const ATTACHMENT_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".webm", ".mp4", ".zip", ".md", ".txt", ".log", ".pdf"]);
const MAX_TOTAL_ATTACHMENT_BYTES = 500 * 1024 * 1024;

export interface ImportOptions {
  projectId: number;
  source: "upload" | "github";
  title: string;
  externalId?: string | null;
  environment?: string;
  milestone?: string;
  meta?: Record<string, unknown>;
}

export interface ImportResult {
  runId: number;
  duplicate: boolean;
  total: number;
  linked: number;
  /** Evidence files (screenshots, videos, traces) stored with the results. */
  attachments: number;
}

/** Merge several reports (e.g. one JUnit file per browser) into a single report. */
export function mergeReports(reports: ParsedReport[]): ParsedReport {
  if (!reports.length) throw new Error("No test reports found");
  const startedAt = reports.map((r) => r.startedAt).filter((s): s is string => !!s).sort()[0] ?? null;
  return { ...reports[0], startedAt, tests: reports.flatMap((r) => r.tests) };
}

/** `files` holds the screenshots/videos/traces that came with the report; when given, they are stored and linked to their attempts. */
export function importReport(report: ParsedReport, opts: ImportOptions, files?: FileBag): ImportResult {
  const project = db.prepare("SELECT id, key FROM projects WHERE id = ?").get(opts.projectId) as
    | { id: number; key: string }
    | undefined;
  if (!project) throw new Error("Project not found");

  if (opts.externalId) {
    const existing = db
      .prepare("SELECT id FROM runs WHERE project_id = ? AND source = ? AND external_id = ?")
      .get(opts.projectId, opts.source, opts.externalId) as { id: number } | undefined;
    if (existing) return { runId: existing.id, duplicate: true, total: 0, linked: 0, attachments: 0 };
  }

  const findCase = db.prepare("SELECT id FROM cases WHERE project_id = ? AND number = ?");
  const upsertTest = db.prepare(`
    INSERT INTO automated_tests (project_id, framework, file, suite_path, title, full_name, case_id, last_status)
    VALUES (@projectId, @framework, @file, @suitePath, @title, @fullName, @caseId, @status)
    ON CONFLICT (project_id, framework, full_name) DO UPDATE SET
      file = excluded.file, suite_path = excluded.suite_path, title = excluded.title,
      case_id = COALESCE(excluded.case_id, automated_tests.case_id),
      last_status = excluded.last_status, last_seen = datetime('now')
    RETURNING id, case_id`);
  const insertResult = db.prepare(`
    INSERT INTO results (run_id, case_id, automated_test_id, status, flaky, duration_ms, error, position, executed_at, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`);
  const insertAttachment = db.prepare("INSERT INTO attachments (result_id, filename, stored_name, mime, attempt, label) VALUES (?, ?, ?, ?, ?, ?)");

  // Files are written as we go; if the import fails half way they are removed again.
  const written: string[] = [];
  let attachmentCount = 0;
  let attachmentBytes = 0;
  const storeAttachments = (resultId: number, refs: AttachmentRef[]) => {
    if (!files) return;
    for (const ref of refs) {
      const ext = extname(ref.path).toLowerCase();
      if (!ATTACHMENT_EXT.has(ext)) continue;
      const entry = resolveEntry(files, ref.path);
      const bytes = entry ? files.read(entry) : null;
      if (!bytes || attachmentBytes + bytes.length > MAX_TOTAL_ATTACHMENT_BYTES) continue;
      const stored = `${randomUUID()}${ext}`;
      writeFileSync(join(UPLOAD_DIR, stored), bytes);
      written.push(stored);
      attachmentBytes += bytes.length;
      insertAttachment.run(resultId, ref.path.replace(/\\/g, "/").split("/").pop(), stored, ref.contentType || "application/octet-stream", ref.attempt, ref.name);
      attachmentCount++;
    }
  };

  // A tag like @TC-42 links the test to case #42 of the project whose key is "TC".
  const resolveCase = (refs: string[]): number | null => {
    for (const ref of refs) {
      const dash = ref.lastIndexOf("-");
      if (ref.slice(0, dash) !== project.key) continue;
      const row = findCase.get(project.id, Number(ref.slice(dash + 1))) as { id: number } | undefined;
      if (row) return row.id;
    }
    return null;
  };

  const startedAt = toSqlDate(report.startedAt);
  try {
    return db.transaction((): ImportResult => {
    const run = db
      .prepare(`
        INSERT INTO runs (project_id, title, kind, source, status, environment, milestone, framework, external_id, meta, started_at, finished_at)
        VALUES (?, ?, 'automated', ?, 'completed', ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), datetime('now'))
        RETURNING id`)
      .get(
        project.id,
        opts.title,
        opts.source,
        opts.environment ?? "",
        opts.milestone ?? "",
        report.framework,
        opts.externalId ?? null,
        JSON.stringify(opts.meta ?? {}),
        startedAt,
      ) as { id: number };

    let linked = 0;
    report.tests.forEach((t, i) => {
      const test = upsertTest.get({
        projectId: project.id,
        framework: report.framework,
        file: t.file,
        suitePath: t.suitePath,
        title: t.title,
        fullName: t.fullName,
        caseId: resolveCase(extractCaseRefs(t.title, t.suitePath, ...t.tags)),
        status: t.status,
      }) as { id: number; case_id: number | null };
      if (test.case_id) {
        linked++;
        // `@REQ-n` on an automated test covers requirement n through the case it is linked to.
        linkCaseByText(test.case_id, project.id, [t.title, t.suitePath, ...t.tags].join("\n"));
      }
      const row = insertResult.get(
        run.id, test.case_id, test.id, t.status, t.flaky ? 1 : 0, t.durationMs, t.error, i, startedAt, t.detail ? JSON.stringify(t.detail) : null,
      ) as { id: number };
      if (t.attachments?.length) storeAttachments(row.id, t.attachments);
    });
    ensureMilestone(project.id, opts.milestone ?? "");
    return { runId: run.id, duplicate: false, total: report.tests.length, linked, attachments: attachmentCount };
    })();
  } catch (e) {
    for (const f of written) {
      try {
        unlinkSync(join(UPLOAD_DIR, f));
      } catch {
        /* already gone */
      }
    }
    throw e;
  }
}

function toSqlDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace("T", " ");
}
