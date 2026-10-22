import "./env.ts";
import { db } from "../server/db.ts";

export function makeProject(key = "D", name = "Dev") {
  return db.prepare("INSERT INTO projects (name, key) VALUES (?, ?) RETURNING *").get(name, key) as { id: number; key: string };
}

/** Creates a case with the next number in the project and returns its id and number. */
export function makeCase(projectId: number, title: string, opts: { status?: string; tags?: string[]; suiteId?: number | null; steps?: [string, string][] } = {}) {
  const n = (db.prepare("UPDATE projects SET next_case_number = next_case_number + 1 WHERE id = ? RETURNING next_case_number - 1 AS n").get(projectId) as { n: number }).n;
  const row = db
    .prepare("INSERT INTO cases (project_id, suite_id, number, title, status, tags, position) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
    .get(projectId, opts.suiteId ?? null, n, title, opts.status ?? "ready", JSON.stringify(opts.tags ?? []), n) as { id: number };
  (opts.steps ?? []).forEach(([action, expected], i) => db.prepare("INSERT INTO case_steps (case_id, position, action, expected) VALUES (?, ?, ?, ?)").run(row.id, i, action, expected));
  return { id: row.id, number: n };
}

export function makeSuite(projectId: number, name: string, parentId: number | null = null) {
  const pos = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM suites WHERE project_id = ?").get(projectId) as { p: number }).p;
  return (db.prepare("INSERT INTO suites (project_id, parent_id, name, position) VALUES (?, ?, ?, ?) RETURNING id").get(projectId, parentId, name, pos) as { id: number }).id;
}

/** A finished manual run with one result per [caseId, status]. */
export function makeManualRun(projectId: number, results: [number, string][], startedAt = "2026-10-20 10:00:00") {
  const run = db
    .prepare("INSERT INTO runs (project_id, title, kind, source, status, started_at) VALUES (?, 'run', 'manual', 'manual', 'completed', ?) RETURNING id")
    .get(projectId, startedAt) as { id: number };
  results.forEach(([caseId, status], i) =>
    db.prepare("INSERT INTO results (run_id, case_id, status, position, executed_at) VALUES (?, ?, ?, ?, ?)").run(run.id, caseId, status, i, startedAt),
  );
  return run.id;
}

/** Minimal Playwright JSON report with one passing test per title. */
export function playwrightJson(titles: string[], startTime = "2026-10-21T10:00:00.000Z") {
  return JSON.stringify({
    config: { rootDir: "/x" },
    stats: { startTime },
    suites: [
      {
        title: "app.spec.ts",
        file: "app.spec.ts",
        specs: titles.map((title, i) => ({
          title,
          file: "app.spec.ts",
          line: i + 1,
          column: 1,
          tags: [],
          tests: [
            {
              projectName: "chromium",
              status: "expected",
              annotations: [],
              results: [{ status: "passed", duration: 100, retry: 0, attachments: [], errors: [], stdout: [], stderr: [], startTime }],
            },
          ],
        })),
        suites: [],
      },
    ],
  });
}
