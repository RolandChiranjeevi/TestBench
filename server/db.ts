import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const DATA_DIR = process.env.TESTBENCH_DATA ?? join(process.cwd(), "data");
export const UPLOAD_DIR = join(DATA_DIR, "uploads");
export const DB_FILE = join(DATA_DIR, "testbench.db");
// The data folder holds every test, requirement, attachment and backup: only the account that runs Testbench may read it.
// The umask makes everything created later (database, uploads, backup zips) private too; the chmod fixes a folder made earlier.
process.umask(0o077);
mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
try {
  chmodSync(DATA_DIR, 0o700);
} catch {
  /* a mounted volume we don't own: leave it as it is */
}

function open(): Database.Database {
  const d = new Database(DB_FILE);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  return d;
}

/**
 * The open database. This is a live binding: a restore swaps in a different connection (see reopenDatabase),
 * so always import `db` and use it at call time rather than keeping a reference to it.
 */
export let db = open();

export function closeDatabase() {
  db.close();
}

/** Opens DB_FILE again (after its file was replaced by a restore) and brings it up to the current schema. */
export function reopenDatabase() {
  db = open();
  migrate(db);
}

const SCHEMA = `
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
`;

export interface CaseSnapshot {
  number: number;
  title: string;
  priority: string;
  description: string;
  preconditions: string;
  steps: { id: number; action: string; expected: string }[];
}

export function snapshotCase(caseId: number, d: Database.Database = db): CaseSnapshot | null {
  const c = d.prepare("SELECT number, title, priority, description, preconditions FROM cases WHERE id = ?").get(caseId) as
    | Omit<CaseSnapshot, "steps">
    | undefined;
  if (!c) return null;
  const steps = d.prepare("SELECT id, action, expected FROM case_steps WHERE case_id = ? ORDER BY position").all(caseId) as CaseSnapshot["steps"];
  return { ...c, steps };
}

/** Sprints/releases are created on first use; dates and kind are edited afterwards. */
export function ensureMilestone(projectId: number, name: string, d: Database.Database = db) {
  const n = name.trim();
  if (n) d.prepare("INSERT OR IGNORE INTO milestones (project_id, name) VALUES (?, ?)").run(projectId, n);
}

/** Small key/value store for app state such as when the last backup was made. */
export function getSetting(key: string): string | null {
  return (db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
}
export function setSetting(key: string, value: string) {
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** Creates missing tables and columns, and fills in data for features added later. Safe to run on every start. */
export function migrate(d: Database.Database) {
  const hasColumn = (table: string, col: string) =>
    (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);

  d.exec(SCHEMA);

  d.exec(`
CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'sprint',   -- sprint | release
  start_date TEXT,
  end_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, name)
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`);

  // Freeze what a manual result looked like when the run started, so later case edits don't rewrite history.
  if (!hasColumn("results", "snapshot")) d.exec("ALTER TABLE results ADD COLUMN snapshot TEXT");

  // step_results used to cascade-delete with case_steps, losing history when a step was removed from a case.
  const stepFks = d.prepare("PRAGMA foreign_key_list(step_results)").all() as { table: string }[];
  if (stepFks.some((f) => f.table === "case_steps")) {
    d.pragma("foreign_keys = OFF");
    d.transaction(() => {
      d.exec(`
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
    d.pragma("foreign_keys = ON");
  }

  // Backfill snapshots for manual results created before this existed (best effort: current state).
  {
    const rows = d
      .prepare(`SELECT r.id, r.case_id FROM results r JOIN runs ru ON ru.id = r.run_id
              WHERE ru.kind = 'manual' AND r.snapshot IS NULL AND r.case_id IS NOT NULL`)
      .all() as { id: number; case_id: number }[];
    const set = d.prepare("UPDATE results SET snapshot = ? WHERE id = ?");
    d.transaction(() => {
      for (const r of rows) {
        const s = snapshotCase(r.case_id, d);
        if (s) set.run(JSON.stringify(s), r.id);
      }
    })();
  }

  // Playwright evidence: per-attempt details on an automated result, and which attempt/kind each attachment belongs to.
  if (!hasColumn("results", "detail")) d.exec("ALTER TABLE results ADD COLUMN detail TEXT");
  if (!hasColumn("attachments", "attempt")) d.exec("ALTER TABLE attachments ADD COLUMN attempt INTEGER");
  if (!hasColumn("attachments", "label")) d.exec("ALTER TABLE attachments ADD COLUMN label TEXT");

  // A Jira issue (key like PROJ-123, or a pasted URL) linked to a failed result.
  if (!hasColumn("results", "jira_key")) d.exec("ALTER TABLE results ADD COLUMN jira_key TEXT");

  // Run templates: a named, reusable selection of cases. Deleting a case or template removes it from the link table.
  d.exec(`
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
  if (!hasColumn("runs", "template_id")) d.exec("ALTER TABLE runs ADD COLUMN template_id INTEGER REFERENCES run_templates(id) ON DELETE SET NULL");

  // Requirements, linked many-to-many to test cases. Numbers (REQ-1, REQ-2...) are per project.
  d.exec(`
CREATE TABLE IF NOT EXISTS requirements (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'approved',   -- draft | approved | deprecated
  source TEXT NOT NULL DEFAULT '',            -- free text, e.g. a Jira story key or link
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, number)
);
CREATE TABLE IF NOT EXISTS requirement_cases (
  requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  PRIMARY KEY (requirement_id, case_id)
);
CREATE INDEX IF NOT EXISTS requirement_cases_case ON requirement_cases(case_id);`);
  // Indexes for lookups that grow with CI imports: results per automated test, attachments per result, rows per project.
  d.exec(`
CREATE INDEX IF NOT EXISTS results_automated_test ON results(automated_test_id);
CREATE INDEX IF NOT EXISTS attachments_result ON attachments(result_id);
CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id, started_at);
CREATE INDEX IF NOT EXISTS cases_project ON cases(project_id);
CREATE INDEX IF NOT EXISTS cases_suite ON cases(suite_id);
CREATE INDEX IF NOT EXISTS automated_project_case ON automated_tests(project_id, case_id);
CREATE INDEX IF NOT EXISTS suites_project ON suites(project_id, parent_id);`);

  // Optional AI link suggestions (see linksuggest.ts): one row per judged (test, case) pair, so a pair is never judged twice,
  // and a marker per test so tests with no candidates are not retried on every click.
  d.exec(`
CREATE TABLE IF NOT EXISTS link_suggestions (
  automated_test_id INTEGER NOT NULL REFERENCES automated_tests(id) ON DELETE CASCADE,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  probability REAL NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (automated_test_id, case_id)
);
CREATE TABLE IF NOT EXISTS link_judged (
  automated_test_id INTEGER PRIMARY KEY REFERENCES automated_tests(id) ON DELETE CASCADE,
  judged_at TEXT NOT NULL DEFAULT (datetime('now')),
  candidates INTEGER NOT NULL DEFAULT 0
);`);

  // Release checklist: manual tasks per sprint/release, ticked off with a timestamp. `source` leaves room for automatic checks later
  // (e.g. 'auto:pass-rate'); today every item is 'manual'.
  d.exec(`
CREATE TABLE IF NOT EXISTS milestone_checklist (
  id INTEGER PRIMARY KEY,
  milestone_id INTEGER NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  done_at TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS milestone_checklist_ms ON milestone_checklist(milestone_id);`);

  // Edits to a requirement, newest last. `material` marks a change to the title or description: linked cases then need a second look.
  d.exec(`
CREATE TABLE IF NOT EXISTS requirement_revisions (
  id INTEGER PRIMARY KEY,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  material INTEGER NOT NULL DEFAULT 0,
  changes TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS requirement_revisions_req ON requirement_revisions(requirement_id);`);
  // Files attached to a requirement (specs, mockups, emails). Stored in the uploads folder like result attachments.
  d.exec(`
CREATE TABLE IF NOT EXISTS requirement_attachments (
  id INTEGER PRIMARY KEY,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS requirement_attachments_req ON requirement_attachments(requirement_id);`);
  // The newest material revision a case was linked or last confirmed against; a later one means the case may be out of date.
  if (!hasColumn("requirement_cases", "reviewed_rev")) d.exec("ALTER TABLE requirement_cases ADD COLUMN reviewed_rev INTEGER NOT NULL DEFAULT 0");
  if (!hasColumn("projects", "next_requirement_number")) d.exec("ALTER TABLE projects ADD COLUMN next_requirement_number INTEGER NOT NULL DEFAULT 1");

  // Automatic import of new GitHub workflow runs. auto_since is when it was switched on: older runs are never pulled in.
  for (const [col, def] of [
    ["auto_import", "INTEGER NOT NULL DEFAULT 0"],
    ["auto_since", "TEXT"],
    ["branch_filter", "TEXT NOT NULL DEFAULT ''"],
    ["default_milestone", "TEXT NOT NULL DEFAULT ''"],
    ["last_checked_at", "TEXT"],
    ["last_error", "TEXT NOT NULL DEFAULT ''"],
    // Workflows (ids or file names, comma separated) allowed to deliver audit packages. Empty allows none.
    ["audit_workflows", "TEXT NOT NULL DEFAULT ''"],
  ] as const) {
    if (!hasColumn("github_sources", col)) d.exec(`ALTER TABLE github_sources ADD COLUMN ${col} ${def}`);
  }
  // Runs the checker has dealt with, so ones that can never be imported (no test artifacts) aren't retried forever.
  d.exec(`
CREATE TABLE IF NOT EXISTS github_seen (
  source_id INTEGER NOT NULL REFERENCES github_sources(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL,
  outcome TEXT NOT NULL,            -- imported | skipped
  note TEXT NOT NULL DEFAULT '',
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_id, run_id)
);`);

  // Audit packages from a test agent: the audit, its bug reports (proposed until a human decides), their evidence and links.
  // A bug report outlives its audit: audit_id can become NULL, so what the audit said about it is kept on the report (origin).
  d.exec(`
CREATE TABLE IF NOT EXISTS audits (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_audit_id TEXT NOT NULL,              -- the agent's own id, not GitHub's run id
  title TEXT NOT NULL DEFAULT '',
  agent_name TEXT NOT NULL DEFAULT '', agent_version TEXT NOT NULL DEFAULT '', agent_model TEXT NOT NULL DEFAULT '',
  started_at TEXT, finished_at TEXT,
  review_status TEXT NOT NULL DEFAULT '', review_method TEXT NOT NULL DEFAULT '', review_reviewer TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,                      -- upload | github
  github_repo TEXT, github_run_id INTEGER, github_artifact_id INTEGER,
  run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  run_state TEXT NOT NULL DEFAULT 'none',    -- linked | pending (run not imported yet) | none (no GitHub run named)
  package_sha256 TEXT,
  narrative_stored_name TEXT,
  first_imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, agent_audit_id)
);
CREATE TABLE IF NOT EXISTS audit_imports (
  id INTEGER PRIMARY KEY,
  audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL,
  artifact_id INTEGER,
  new_count INTEGER NOT NULL DEFAULT 0, unchanged_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0, pending_count INTEGER NOT NULL DEFAULT 0,
  warnings TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS bug_reports (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  audit_id INTEGER REFERENCES audits(id) ON DELETE SET NULL,
  origin_audit_id TEXT NOT NULL,             -- the agent's audit id, kept when the audit row is deleted
  origin TEXT NOT NULL DEFAULT '{}',         -- audit title, agent, review method, times, source and GitHub ids as first imported
  source_id TEXT NOT NULL,
  -- working copy (a human may edit it)
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', steps TEXT NOT NULL DEFAULT '[]',
  expected TEXT NOT NULL DEFAULT '', actual TEXT NOT NULL DEFAULT '', environment TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
  -- three separate judgements
  tool_impact TEXT, agent_severity TEXT, human_severity TEXT,
  confidence REAL, agent_review TEXT,
  found_at TEXT, imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  fingerprint TEXT NOT NULL DEFAULT '', recurrence_hint TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT 'proposed',   -- proposed | accepted | rejected | duplicate; only a human sets this
  reviewed_at TEXT, review_note TEXT NOT NULL DEFAULT '',
  duplicate_of_id INTEGER REFERENCES bug_reports(id) ON DELETE SET NULL,
  edited_at TEXT,
  applied_rev INTEGER NOT NULL DEFAULT 1, latest_rev INTEGER NOT NULL DEFAULT 1, ignored_rev INTEGER NOT NULL DEFAULT 0,
  run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  result_id INTEGER REFERENCES results(id) ON DELETE SET NULL,
  UNIQUE (project_id, origin_audit_id, source_id)
);
CREATE INDEX IF NOT EXISTS bug_reports_project ON bug_reports(project_id, review_status);
CREATE INDEX IF NOT EXISTS bug_reports_audit ON bug_reports(audit_id);
CREATE TABLE IF NOT EXISTS bug_revisions (
  id INTEGER PRIMARY KEY,
  bug_report_id INTEGER NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  payload TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  audit_import_id INTEGER REFERENCES audit_imports(id) ON DELETE SET NULL,
  UNIQUE (bug_report_id, rev)
);
CREATE TABLE IF NOT EXISTS bug_refs (
  id INTEGER PRIMARY KEY,
  bug_report_id INTEGER NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                        -- requirement | case | test
  raw TEXT NOT NULL,
  case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
  requirement_id INTEGER REFERENCES requirements(id) ON DELETE SET NULL,
  automated_test_id INTEGER REFERENCES automated_tests(id) ON DELETE SET NULL,
  state TEXT NOT NULL,                       -- resolved | unresolved | wrong_project | ambiguous
  reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS bug_refs_bug ON bug_refs(bug_report_id);
CREATE TABLE IF NOT EXISTS bug_attachments (
  id INTEGER PRIMARY KEY,
  bug_report_id INTEGER NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
  declared_path TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT, label TEXT NOT NULL DEFAULT '',
  stored_name TEXT,                          -- NULL when the file was rejected, missing or failed its checksum
  state TEXT NOT NULL,                       -- stored | rejected | missing | checksum_mismatch
  reason TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,         -- 0 = belongs to a pending update that nobody applied yet
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bug_attachments_bug ON bug_attachments(bug_report_id);
-- Where a report went (or already was). Delivery 1 only records links to existing external issues; publishing comes later.
CREATE TABLE IF NOT EXISTS bug_publications (
  id INTEGER PRIMARY KEY,
  bug_report_id INTEGER NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
  destination TEXT NOT NULL,                 -- jira | linear | other
  destination_ref TEXT NOT NULL DEFAULT '',  -- Jira site + project, or Linear team; later set per Testbench project
  mode TEXT NOT NULL,                        -- created | linked_existing
  state TEXT NOT NULL,                       -- pending | sent | unknown | failed
  idempotency_key TEXT,
  preview_hash TEXT,
  external_id TEXT NOT NULL DEFAULT '', external_url TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  attachments_state TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS bug_publications_active ON bug_publications(bug_report_id, destination, destination_ref) WHERE state IN ('pending', 'sent', 'unknown');
-- Artifacts the GitHub checker has dealt with. Keyed by artifact, not by run, so a package that appears after its run was imported is still fetched.
CREATE TABLE IF NOT EXISTS github_artifacts (
  source_id INTEGER NOT NULL REFERENCES github_sources(id) ON DELETE CASCADE,
  artifact_id INTEGER NOT NULL,
  run_id INTEGER, name TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL,                     -- imported | rejected
  note TEXT NOT NULL DEFAULT '',
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_id, artifact_id)
);`);

  // Which reports each audit run (import) contained, so a report that is missing from the latest run can be told apart from one that is in it.
  // Imports made before this was recorded have sightings_recorded = 0: only the runs that changed a report are known for them.
  d.exec(`
CREATE TABLE IF NOT EXISTS bug_sightings (
  bug_report_id INTEGER NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
  audit_import_id INTEGER NOT NULL REFERENCES audit_imports(id) ON DELETE CASCADE,
  PRIMARY KEY (bug_report_id, audit_import_id)
);
CREATE INDEX IF NOT EXISTS bug_sightings_import ON bug_sightings(audit_import_id);`);
  if (!hasColumn("audit_imports", "sightings_recorded")) {
    d.exec("ALTER TABLE audit_imports ADD COLUMN sightings_recorded INTEGER NOT NULL DEFAULT 0");
    d.exec("INSERT OR IGNORE INTO bug_sightings (bug_report_id, audit_import_id) SELECT bug_report_id, audit_import_id FROM bug_revisions WHERE audit_import_id IS NOT NULL");
  }
  if (!hasColumn("audit_imports", "github_repo")) d.exec("ALTER TABLE audit_imports ADD COLUMN github_repo TEXT");
  if (!hasColumn("audit_imports", "github_run_id")) d.exec("ALTER TABLE audit_imports ADD COLUMN github_run_id INTEGER");

  // Requirements that a test agent can use as a basis: a kind, the stable id they were imported with, and (for accessibility and
  // responsive requirements) the WCAG criteria and viewports. external_id is unique within a project, never across projects.
  if (!hasColumn("requirements", "kind")) d.exec("ALTER TABLE requirements ADD COLUMN kind TEXT NOT NULL DEFAULT 'functional'");
  if (!hasColumn("requirements", "external_id")) d.exec("ALTER TABLE requirements ADD COLUMN external_id TEXT");
  if (!hasColumn("requirements", "wcag")) d.exec("ALTER TABLE requirements ADD COLUMN wcag TEXT NOT NULL DEFAULT '[]'");
  if (!hasColumn("requirements", "viewports")) d.exec("ALTER TABLE requirements ADD COLUMN viewports TEXT NOT NULL DEFAULT '[]'");
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS requirements_external ON requirements(project_id, external_id) WHERE external_id IS NOT NULL");

  // Manual test cases proposed by a test agent in an audit package (manual-tests.json). They are kept apart from the project's own test cases,
  // from automated results and from bug reports, and start as proposals. Same shape as bug reports: a working copy a person may edit, the
  // agent's versions as revisions, and which audit runs contained the test.
  d.exec(`
CREATE TABLE IF NOT EXISTS manual_tests (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  audit_id INTEGER REFERENCES audits(id) ON DELETE SET NULL,
  origin_audit_id TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT '{}',
  source_id TEXT NOT NULL,
  -- working copy (a person may edit it)
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', preconditions TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]', expected TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL, wcag TEXT NOT NULL DEFAULT '[]', viewports TEXT NOT NULL DEFAULT '[]',
  -- two separate judgements of priority
  agent_priority TEXT NOT NULL, human_priority TEXT,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  review_status TEXT NOT NULL DEFAULT 'proposed',   -- proposed | accepted | rejected; only a person sets this
  reviewed_at TEXT, review_note TEXT NOT NULL DEFAULT '',
  edited_at TEXT,
  applied_rev INTEGER NOT NULL DEFAULT 1, latest_rev INTEGER NOT NULL DEFAULT 1, ignored_rev INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_id, origin_audit_id, source_id)
);
CREATE INDEX IF NOT EXISTS manual_tests_project ON manual_tests(project_id, review_status);
CREATE INDEX IF NOT EXISTS manual_tests_audit ON manual_tests(audit_id);
CREATE TABLE IF NOT EXISTS manual_test_revisions (
  id INTEGER PRIMARY KEY,
  manual_test_id INTEGER NOT NULL REFERENCES manual_tests(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  payload TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  audit_import_id INTEGER REFERENCES audit_imports(id) ON DELETE SET NULL,
  UNIQUE (manual_test_id, rev)
);
CREATE TABLE IF NOT EXISTS manual_test_refs (
  id INTEGER PRIMARY KEY,
  manual_test_id INTEGER NOT NULL REFERENCES manual_tests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                        -- requirement | case | test
  raw TEXT NOT NULL,
  case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
  requirement_id INTEGER REFERENCES requirements(id) ON DELETE SET NULL,
  automated_test_id INTEGER REFERENCES automated_tests(id) ON DELETE SET NULL,
  state TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS manual_test_refs_test ON manual_test_refs(manual_test_id);
CREATE INDEX IF NOT EXISTS manual_test_refs_req ON manual_test_refs(requirement_id);
CREATE TABLE IF NOT EXISTS manual_test_sightings (
  manual_test_id INTEGER NOT NULL REFERENCES manual_tests(id) ON DELETE CASCADE,
  audit_import_id INTEGER NOT NULL REFERENCES audit_imports(id) ON DELETE CASCADE,
  PRIMARY KEY (manual_test_id, audit_import_id)
);
CREATE INDEX IF NOT EXISTS manual_test_sightings_import ON manual_test_sightings(audit_import_id);`);
  // The test case a person made from an accepted proposal. Cleared if that case is removed, so a new one can be made.
  if (!hasColumn("manual_tests", "case_id")) d.exec("ALTER TABLE manual_tests ADD COLUMN case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL");
  d.exec("CREATE INDEX IF NOT EXISTS manual_tests_case ON manual_tests(case_id)");
  // 1 when the package of that run had a manual-tests.json (even an empty one). Only then does a run say anything about manual tests.
  if (!hasColumn("audit_imports", "manual_listed")) d.exec("ALTER TABLE audit_imports ADD COLUMN manual_listed INTEGER NOT NULL DEFAULT 0");
  d.exec("CREATE INDEX IF NOT EXISTS bug_refs_req ON bug_refs(requirement_id)");

  // Where a project's accepted bug reports are published. One per project. The token is stored sealed (see secrets.ts) and never returned;
  // no token means the server's own key (LINEAR_API_KEY) is used.
  d.exec(`
CREATE TABLE IF NOT EXISTS project_destinations (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                        -- linear (Jira later)
  base_url TEXT NOT NULL,
  team_id TEXT NOT NULL, team_key TEXT NOT NULL DEFAULT '', team_name TEXT NOT NULL DEFAULT '',
  token_enc TEXT,
  token_hint TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
  // The exact content that was sent, as JSON (title, description, priority, team, attachments).
  if (!hasColumn("bug_publications", "content_sent")) d.exec("ALTER TABLE bug_publications ADD COLUMN content_sent TEXT NOT NULL DEFAULT ''");

  // CI results as bug history. A bug has a place in a workflow (open, resolved_suspected, closed) and an assignee, whatever its source;
  // review_status stays the separate "is this a real bug" decision. CI bugs are keyed by test_key (origin_audit_id '$ci', source_id = the key),
  // so the existing unique index gives one bug per test and project.
  if (!hasColumn("bug_reports", "source")) d.exec("ALTER TABLE bug_reports ADD COLUMN source TEXT NOT NULL DEFAULT 'agent_audit'");   // ci | agent_audit | manual
  if (!hasColumn("bug_reports", "test_key")) d.exec("ALTER TABLE bug_reports ADD COLUMN test_key TEXT");
  if (!hasColumn("bug_reports", "tags")) d.exec("ALTER TABLE bug_reports ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
  if (!hasColumn("bug_reports", "workflow_status")) d.exec("ALTER TABLE bug_reports ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'open'");
  if (!hasColumn("bug_reports", "assignee")) d.exec("ALTER TABLE bug_reports ADD COLUMN assignee TEXT NOT NULL DEFAULT ''");
  if (!hasColumn("bug_reports", "last_ci_status")) d.exec("ALTER TABLE bug_reports ADD COLUMN last_ci_status TEXT");
  if (!hasColumn("bug_reports", "last_ci_at")) d.exec("ALTER TABLE bug_reports ADD COLUMN last_ci_at TEXT");
  if (!hasColumn("bug_reports", "ci_flaky")) d.exec("ALTER TABLE bug_reports ADD COLUMN ci_flaky INTEGER NOT NULL DEFAULT 0");
  if (!hasColumn("bug_reports", "resolved_suspected_at")) d.exec("ALTER TABLE bug_reports ADD COLUMN resolved_suspected_at TEXT");
  if (!hasColumn("bug_reports", "closed_at")) d.exec("ALTER TABLE bug_reports ADD COLUMN closed_at TEXT");
  d.exec(`
CREATE INDEX IF NOT EXISTS bug_reports_triage ON bug_reports(project_id, source, workflow_status);
CREATE INDEX IF NOT EXISTS bug_reports_test_key ON bug_reports(project_id, test_key) WHERE test_key IS NOT NULL;
-- API tokens for CI. Only a hash is kept; the token itself is shown once, when it is made. A token belongs to one project.
CREATE TABLE IF NOT EXISTS ci_tokens (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
);
-- One row per CI run received. run_id is the CI's own id; sending the same run again is recognised by it.
CREATE TABLE IF NOT EXISTS ci_runs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '', repository TEXT NOT NULL DEFAULT '', pipeline_url TEXT NOT NULL DEFAULT '',
  started_at TEXT, finished_at TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  payload_hash TEXT NOT NULL,
  counts TEXT NOT NULL DEFAULT '{}',
  summary TEXT NOT NULL DEFAULT '{}',
  UNIQUE (project_id, run_id)
);
-- One row per test of a run that Testbench keeps: every failed and flaky test, and the passes of tests that have a CI bug.
CREATE TABLE IF NOT EXISTS ci_results (
  id INTEGER PRIMARY KEY,
  ci_run_id INTEGER NOT NULL REFERENCES ci_runs(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  test_key TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,                      -- passed | failed | flaky
  duration_ms INTEGER, error TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]', attachments TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]',
  UNIQUE (ci_run_id, test_key)
);
CREATE INDEX IF NOT EXISTS ci_results_key ON ci_results(project_id, test_key);
-- A failed or flaky result that belongs to a bug.
CREATE TABLE IF NOT EXISTS bug_occurrences (
  id INTEGER PRIMARY KEY,
  bug_report_id INTEGER NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
  ci_result_id INTEGER NOT NULL REFERENCES ci_results(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (bug_report_id, ci_result_id)
);
-- What changed a bug's workflow, and who: a person or CI.
CREATE TABLE IF NOT EXISTS bug_events (
  id INTEGER PRIMARY KEY,
  bug_report_id INTEGER NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT NOT NULL,                       -- ci | user
  kind TEXT NOT NULL,                        -- created | reopened | resolved_suspected | workflow | assignee
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS bug_events_bug ON bug_events(bug_report_id);`);

  // Make sure every sprint named on a run has a sprint record.
  const named = d.prepare("SELECT DISTINCT project_id, milestone FROM runs WHERE milestone != ''").all() as { project_id: number; milestone: string }[];
  for (const r of named) ensureMilestone(r.project_id, r.milestone, d);
}

migrate(db);

export const parseJson = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
