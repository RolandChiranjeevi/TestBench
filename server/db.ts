import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const DATA_DIR = process.env.TESTBENCH_DATA ?? join(process.cwd(), "data");
export const UPLOAD_DIR = join(DATA_DIR, "uploads");
mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new Database(join(DATA_DIR, "testbench.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  next_case_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suites (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES suites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suite_id INTEGER REFERENCES suites(id) ON DELETE SET NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  preconditions TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'ready',
  tags TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, number)
);

CREATE TABLE IF NOT EXISTS case_steps (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  action TEXT NOT NULL DEFAULT '',
  expected TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS automated_tests (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  framework TEXT NOT NULL,
  file TEXT NOT NULL DEFAULT '',
  suite_path TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  full_name TEXT NOT NULL,
  case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
  last_status TEXT,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, framework, full_name)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,              -- manual | automated
  source TEXT NOT NULL,            -- manual | upload | github
  status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | completed
  environment TEXT NOT NULL DEFAULT '',
  milestone TEXT NOT NULL DEFAULT '',
  framework TEXT,
  external_id TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  UNIQUE (project_id, source, external_id)
);

CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
  automated_test_id INTEGER REFERENCES automated_tests(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'untested', -- untested | passed | failed | blocked | skipped
  flaky INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  error TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  executed_at TEXT
);
CREATE INDEX IF NOT EXISTS results_run ON results(run_id);
CREATE INDEX IF NOT EXISTS results_case ON results(case_id);

CREATE TABLE IF NOT EXISTS step_results (
  result_id INTEGER NOT NULL REFERENCES results(id) ON DELETE CASCADE,
  step_id INTEGER NOT NULL REFERENCES case_steps(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  actual TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (result_id, step_id)
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  result_id INTEGER NOT NULL REFERENCES results(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS github_sources (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  workflow TEXT NOT NULL DEFAULT '',
  artifact_pattern TEXT NOT NULL DEFAULT '',
  UNIQUE (project_id, owner, repo, workflow)
);
`);

// ---------- Migrations ----------

const hasColumn = (table: string, col: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);

db.exec(`
CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'sprint',   -- sprint | release
  start_date TEXT,
  end_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, name)
);`);

// Freeze what a manual result looked like when the run started, so later case edits don't rewrite history.
if (!hasColumn("results", "snapshot")) db.exec("ALTER TABLE results ADD COLUMN snapshot TEXT");

// step_results used to cascade-delete with case_steps, losing history when a step was removed from a case.
const stepFks = db.prepare("PRAGMA foreign_key_list(step_results)").all() as { table: string }[];
if (stepFks.some((f) => f.table === "case_steps")) {
  db.pragma("foreign_keys = OFF");
  db.transaction(() => {
    db.exec(`
      CREATE TABLE step_results_new (
        result_id INTEGER NOT NULL REFERENCES results(id) ON DELETE CASCADE,
        step_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        actual TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (result_id, step_id)
      );
      INSERT INTO step_results_new SELECT result_id, step_id, status, actual FROM step_results;
      DROP TABLE step_results;
      ALTER TABLE step_results_new RENAME TO step_results;`);
  })();
  db.pragma("foreign_keys = ON");
}

export interface CaseSnapshot {
  number: number;
  title: string;
  priority: string;
  description: string;
  preconditions: string;
  steps: { id: number; action: string; expected: string }[];
}

export function snapshotCase(caseId: number): CaseSnapshot | null {
  const c = db.prepare("SELECT number, title, priority, description, preconditions FROM cases WHERE id = ?").get(caseId) as
    | Omit<CaseSnapshot, "steps">
    | undefined;
  if (!c) return null;
  const steps = db.prepare("SELECT id, action, expected FROM case_steps WHERE case_id = ? ORDER BY position").all(caseId) as CaseSnapshot["steps"];
  return { ...c, steps };
}

// Backfill snapshots for manual results created before this existed (best effort: current state).
{
  const rows = db
    .prepare(`SELECT r.id, r.case_id FROM results r JOIN runs ru ON ru.id = r.run_id
              WHERE ru.kind = 'manual' AND r.snapshot IS NULL AND r.case_id IS NOT NULL`)
    .all() as { id: number; case_id: number }[];
  const set = db.prepare("UPDATE results SET snapshot = ? WHERE id = ?");
  db.transaction(() => {
    for (const r of rows) {
      const s = snapshotCase(r.case_id);
      if (s) set.run(JSON.stringify(s), r.id);
    }
  })();
}

// A Jira issue (key like PROJ-123, or a pasted URL) linked to a failed result.
if (!hasColumn("results", "jira_key")) db.exec("ALTER TABLE results ADD COLUMN jira_key TEXT");

// Run templates: a named, reusable selection of cases. Deleting a case or template removes it from the link table.
db.exec(`
CREATE TABLE IF NOT EXISTS run_templates (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, name)
);
CREATE TABLE IF NOT EXISTS run_template_cases (
  template_id INTEGER NOT NULL REFERENCES run_templates(id) ON DELETE CASCADE,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  PRIMARY KEY (template_id, case_id)
);`);
if (!hasColumn("runs", "template_id")) db.exec("ALTER TABLE runs ADD COLUMN template_id INTEGER REFERENCES run_templates(id) ON DELETE SET NULL");

/** Sprints/releases are created on first use; dates and kind are edited afterwards. */
export function ensureMilestone(projectId: number, name: string) {
  const n = name.trim();
  if (n) db.prepare("INSERT OR IGNORE INTO milestones (project_id, name) VALUES (?, ?)").run(projectId, n);
}
{
  const rows = db.prepare("SELECT DISTINCT project_id, milestone FROM runs WHERE milestone != ''").all() as { project_id: number; milestone: string }[];
  for (const r of rows) ensureMilestone(r.project_id, r.milestone);
}

export const parseJson =<T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
