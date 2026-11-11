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

/** The observation tables, rebuilt first when they come from before archived and converted existed. Safe to run on every start. */
export function migrateObservations(d: Database.Database) {
  // Observations: results of load tests and security reviews that are not bugs (measurements, risks, findings for a human to review). They have their
  // own status model and are never bug reports; a person can turn one into a bug later (converted_bug_id), nothing does it automatically.
  // The agent's id is kept as source_id (unique per project); Testbench numbers them OBS-n per project. Like a bug, an observation outlives its audit.
  // Statuses: observed | needs_review | confirmed are open; resolved and archived close it (a person's decision); converted means it is tracked as a bug
  // (set by "Convert to bug" only).
  const observationsTable = (name: string) => `
CREATE TABLE ${name} (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  audit_id INTEGER REFERENCES audits(id) ON DELETE SET NULL,
  origin_audit_id TEXT NOT NULL,             -- the agent's audit id, kept when the audit row is deleted
  kind TEXT NOT NULL CHECK (kind IN ('load_test', 'security_review')),
  title TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'observed' CHECK (status IN ('observed', 'needs_review', 'confirmed', 'resolved', 'archived', 'converted')),
  status_set_by TEXT NOT NULL DEFAULT 'agent' CHECK (status_set_by IN ('agent', 'human')),   -- a human's status is never overwritten by a re-import
  status_changed_at TEXT,                            -- when a person last set the status
  changed_since_review INTEGER NOT NULL DEFAULT 0,   -- 1 = the agent sent new content after a human had set the status
  metric TEXT, value REAL, threshold REAL,           -- load_test only
  evidence TEXT NOT NULL DEFAULT '',
  recommendation TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  converted_bug_id INTEGER REFERENCES bug_reports(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, source_id),
  UNIQUE (project_id, number)
)`;
  // A table made before archived and converted existed has a CHECK that refuses them, and SQLite cannot change a CHECK: rebuild it, keeping every row
  // and its id (observation_evidence points at it). An observation that was already turned into a bug becomes "converted".
  const obsDdl = (d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'observations'").get() as { sql: string } | undefined)?.sql;
  if (obsDdl && !obsDdl.includes("'archived'")) {
    d.pragma("foreign_keys = OFF");
    d.transaction(() => {
      d.exec(observationsTable("observations_new"));
      d.exec(`INSERT INTO observations_new (id, project_id, number, source_id, audit_id, origin_audit_id, kind, title, severity, status, status_set_by, status_changed_at,
          changed_since_review, metric, value, threshold, evidence, recommendation, source, content_hash, converted_bug_id, created_at, updated_at)
        SELECT id, project_id, number, source_id, audit_id, origin_audit_id, kind, title, severity,
          CASE WHEN converted_bug_id IS NOT NULL THEN 'converted' ELSE status END,
          CASE WHEN converted_bug_id IS NOT NULL THEN 'human' ELSE status_set_by END,
          CASE WHEN converted_bug_id IS NOT NULL THEN updated_at END,
          changed_since_review, metric, value, threshold, evidence, recommendation, source, content_hash, converted_bug_id, created_at, updated_at FROM observations`);
      d.exec("DROP TABLE observations; ALTER TABLE observations_new RENAME TO observations;");
    })();
    d.pragma("foreign_keys = ON");
  }
  d.exec(`${observationsTable("IF NOT EXISTS observations")};
CREATE INDEX IF NOT EXISTS observations_project ON observations(project_id, kind, severity, status);
CREATE INDEX IF NOT EXISTS observations_audit ON observations(audit_id);
-- Evidence an observation points to: a file of the audit, by path and sha256 (the same evidence the bug reports of the audit carry).
CREATE TABLE IF NOT EXISTS observation_evidence (
  id INTEGER PRIMARY KEY,
  observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,                         -- as the agent wrote it (an EV-... label or a path)
  path TEXT NOT NULL, sha256 TEXT,
  attachment_id INTEGER REFERENCES bug_attachments(id) ON DELETE SET NULL,
  state TEXT NOT NULL,                       -- ok | problem | unresolved
  reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS observation_evidence_obs ON observation_evidence(observation_id);`);
}

/**
 * Where a requirement came from and who stood behind it, and the proposals an agent can make for new ones. Safe to run on every start.
 *  - origin: human | import | ai_suggestion. (`source` stays what it was: free text such as a Jira key.) Requirements that were imported have an external id.
 *  - created_by / approved_by are the display name a person entered in Settings, as typed (or, with accounts, the name of the signed-in account; neither is checked against a real person); for an AI suggestion
 *    created_by is the agent. approved_by is empty for a draft.
 *  - A proposal lives in its own table until a person approves it. Approving makes an ordinary requirement with origin ai_suggestion. The two triggers
 *    make the database itself refuse an ai_suggestion requirement without an approver, whatever the code does.
 */
export function migrateRequirementModel(d: Database.Database) {
  const hasColumn = (table: string, col: string) => (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
  if (!hasColumn("requirements", "origin")) {
    d.exec("ALTER TABLE requirements ADD COLUMN origin TEXT NOT NULL DEFAULT 'human' CHECK (origin IN ('human', 'import', 'ai_suggestion'))");
    d.exec("UPDATE requirements SET origin = 'import' WHERE external_id IS NOT NULL");
  }
  if (!hasColumn("requirements", "acceptance_criteria")) d.exec("ALTER TABLE requirements ADD COLUMN acceptance_criteria TEXT NOT NULL DEFAULT ''");
  if (!hasColumn("requirements", "created_by")) d.exec("ALTER TABLE requirements ADD COLUMN created_by TEXT NOT NULL DEFAULT ''");
  if (!hasColumn("requirements", "approved_by")) d.exec("ALTER TABLE requirements ADD COLUMN approved_by TEXT NOT NULL DEFAULT ''");
  if (!hasColumn("requirements", "approved_at")) d.exec("ALTER TABLE requirements ADD COLUMN approved_at TEXT");
  if (!hasColumn("requirement_revisions", "changed_by")) d.exec("ALTER TABLE requirement_revisions ADD COLUMN changed_by TEXT NOT NULL DEFAULT ''");
  d.exec(`
CREATE TRIGGER IF NOT EXISTS requirements_ai_needs_human_insert BEFORE INSERT ON requirements
WHEN NEW.origin = 'ai_suggestion' AND trim(NEW.approved_by) = ''
BEGIN SELECT RAISE(ABORT, 'An AI-suggested requirement exists only after a person has approved it'); END;
CREATE TRIGGER IF NOT EXISTS requirements_ai_needs_human_update BEFORE UPDATE ON requirements
WHEN NEW.origin = 'ai_suggestion' AND NEW.status = 'approved' AND trim(NEW.approved_by) = ''
BEGIN SELECT RAISE(ABORT, 'An AI-suggested requirement can only be approved by a person'); END;
CREATE TABLE IF NOT EXISTS requirement_proposals (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',                -- why the agent suggests it
  kind TEXT NOT NULL DEFAULT 'functional',
  suggested_priority TEXT NOT NULL DEFAULT 'medium' CHECK (suggested_priority IN ('low', 'medium', 'high', 'critical')),
  basis TEXT NOT NULL DEFAULT 'other' CHECK (basis IN ('observation', 'coverage_gap', 'prompt', 'other')),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected')),
  reject_reason TEXT NOT NULL DEFAULT '',
  proposed_by TEXT NOT NULL DEFAULT '',              -- the agent token's name
  decided_by TEXT NOT NULL DEFAULT '', decided_at TEXT,
  resulting_requirement_id INTEGER REFERENCES requirements(id) ON DELETE SET NULL,
  original TEXT NOT NULL DEFAULT '{}',               -- the proposal as the agent made it, kept when a person edits it
  edited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status != 'rejected' OR trim(reject_reason) != ''),
  CHECK (status = 'proposed' OR trim(decided_by) != '')
);
CREATE INDEX IF NOT EXISTS requirement_proposals_project ON requirement_proposals(project_id, status);
CREATE TABLE IF NOT EXISTS proposal_observations (
  proposal_id INTEGER NOT NULL REFERENCES requirement_proposals(id) ON DELETE CASCADE,
  observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  PRIMARY KEY (proposal_id, observation_id)
);
CREATE TABLE IF NOT EXISTS proposal_cases (
  proposal_id INTEGER NOT NULL REFERENCES requirement_proposals(id) ON DELETE CASCADE,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  PRIMARY KEY (proposal_id, case_id)
);
-- Tokens that let a test agent make proposals (tbpr_). A separate table and prefix from the read token (tbag_) and the CI token (tbci_): none of them can stand in
-- for another. A proposal token can create proposals and do nothing else. Only a hash is stored.
CREATE TABLE IF NOT EXISTS propose_tokens (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS propose_tokens_project ON propose_tokens(project_id);
-- What a person has linked an observation to. An observation with neither is on the coverage gap list.
CREATE TABLE IF NOT EXISTS observation_requirements (
  observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  PRIMARY KEY (observation_id, requirement_id)
);
CREATE TABLE IF NOT EXISTS observation_cases (
  observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  PRIMARY KEY (observation_id, case_id)
);`);
  // Which coverage gap a generated proposal came from (case:12, obs:7). A gap gets one proposal, ever; empty for proposals an agent made.
  if (!hasColumn("requirement_proposals", "gap_key")) d.exec("ALTER TABLE requirement_proposals ADD COLUMN gap_key TEXT NOT NULL DEFAULT ''");
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS requirement_proposals_gap ON requirement_proposals(project_id, gap_key) WHERE gap_key != ''");
}

/**
 * Accounts: who may use Testbench. Safe to run on every start; an installation without accounts keeps working as before (see accounts.ts for the three states).
 *  - users: an email (unique, any case) and a password hash (scrypt, see accounts.ts). A user is disabled, never deleted, so what they did stays attributed.
 *  - sessions: only a hash of the cookie value is kept, so a copy of the database cannot be used to sign in. A session can be revoked.
 *  - account_links: invitation and password-reset links. Only a hash of the link's token is kept; a link works once and expires. `project_id` and `role` are for
 *    project membership (a later step) and are empty for now.
 *  - audit_log: append-only. Two triggers refuse any update or delete, so what happened to accounts and permissions cannot be rewritten from inside Testbench.
 */
export function migrateAccounts(d: Database.Database) {
  d.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),   -- the owner runs the installation: backups, users, who may create projects
  disabled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT,
  password_changed_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,                  -- sha256 of the cookie value; the value itself is never stored
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  last_seen_at TEXT,
  ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '',
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS account_links (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('invite', 'reset')),
  token_hash TEXT NOT NULL UNIQUE,                  -- sha256 of the token; the token is shown once, when the link is made
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,   -- reset: whose password
  email TEXT NOT NULL DEFAULT '',                   -- invite: the address it is meant for (optional)
  note TEXT NOT NULL DEFAULT '',
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,   -- project membership comes later: empty for now
  role TEXT CHECK (role IS NULL OR role IN ('admin', 'tester', 'viewer')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT, used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  actor_user_id INTEGER,                            -- no foreign keys: the log must outlive whatever it names
  actor_label TEXT NOT NULL DEFAULT '',             -- the name at the time, or "cli" / "setup" / "anonymous"
  action TEXT NOT NULL,
  target_user_id INTEGER,
  project_id INTEGER,
  ip TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}'                 -- never a password, a token or a hash
);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at);
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'The audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'The audit log is append-only'); END;`);
}

/**
 * Who may do what in which project. Safe to run on every start.
 *  - project_members: one row per (project, account) with a role: admin, tester or viewer. The owner of the installation needs no row: the owner is an admin everywhere.
 *    A row goes with its project or its account (an account is switched off, never deleted, so in practice only with the project).
 *  - Installations that had accounts before roles existed keep working: once, every account that is not the owner becomes a tester in every project that exists then,
 *    which is what they could do before. The owner can take that back. It is written to the audit log, and not repeated (the setting below says it was done).
 *  - *_user_id columns sit next to the names that are recorded on requirements, so that "who" can be traced to an account and not only to a name as it was then.
 */
export function migrateRoles(d: Database.Database) {
  const hasColumn = (table: string, col: string) => (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
  d.exec(`
CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'tester', 'viewer')),
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, user_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS project_members_user ON project_members(user_id);`);
  // Where an imported requirement came from: who ran the import, when, and the file it was in. An import creates drafts; a person approves them (see reqimport.ts).
  for (const [col, ddl] of [["imported_by", "TEXT NOT NULL DEFAULT ''"], ["imported_by_user_id", "INTEGER"], ["imported_at", "TEXT"], ["import_ref", "TEXT NOT NULL DEFAULT ''"]] as const) {
    if (!hasColumn("requirements", col)) d.exec(`ALTER TABLE requirements ADD COLUMN ${col} ${ddl}`);
  }
  for (const [table, col] of [["requirements", "created_by_user_id"], ["requirements", "approved_by_user_id"], ["requirement_proposals", "decided_by_user_id"], ["requirement_revisions", "by_user_id"]] as const) {
    if (!hasColumn(table, col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} INTEGER`);
  }
  // Who decided on a bug report (confirm, dismiss, restore, duplicate). Only a person decides; see reviewBugReport.
  if (!hasColumn("bug_reports", "reviewed_by")) d.exec("ALTER TABLE bug_reports ADD COLUMN reviewed_by TEXT NOT NULL DEFAULT ''");
  if (!hasColumn("bug_reports", "reviewed_by_user_id")) d.exec("ALTER TABLE bug_reports ADD COLUMN reviewed_by_user_id INTEGER");
  // Who decided a bug's severity (human_severity) and why. The AI's or CI's value (agent_severity) is only a suggestion; this is the person's decision.
  for (const [col, ddl] of [["severity_by", "TEXT NOT NULL DEFAULT ''"], ["severity_by_user_id", "INTEGER"], ["severity_at", "TEXT"], ["severity_reason", "TEXT NOT NULL DEFAULT ''"]] as const) {
    if (!hasColumn("bug_reports", col)) d.exec(`ALTER TABLE bug_reports ADD COLUMN ${col} ${ddl}`);
  }
  d.exec(`
CREATE TRIGGER IF NOT EXISTS bug_reports_severity_needs_account_insert BEFORE INSERT ON bug_reports
WHEN NEW.human_severity IS NOT NULL AND NEW.severity_by_user_id IS NULL AND EXISTS (SELECT 1 FROM users)
BEGIN SELECT RAISE(ABORT, 'A severity decision on a bug report needs a person with an account'); END;
CREATE TRIGGER IF NOT EXISTS bug_reports_severity_needs_account_update BEFORE UPDATE OF human_severity ON bug_reports
WHEN NEW.human_severity IS NOT OLD.human_severity AND NEW.severity_by_user_id IS NULL AND EXISTS (SELECT 1 FROM users)
BEGIN SELECT RAISE(ABORT, 'A severity decision on a bug report needs a person with an account'); END;`);
  // With accounts, a human decision on a bug report is made by an account: a name alone is not enough. Fires only when the decision changes, so bugs
  // that were decided before accounts existed stay as they are.
  d.exec(`
CREATE TRIGGER IF NOT EXISTS bug_reports_decision_needs_account_insert BEFORE INSERT ON bug_reports
WHEN NEW.review_status != 'proposed' AND NEW.reviewed_by_user_id IS NULL AND EXISTS (SELECT 1 FROM users)
BEGIN SELECT RAISE(ABORT, 'A decision on a bug report needs a person with an account'); END;
CREATE TRIGGER IF NOT EXISTS bug_reports_decision_needs_account_update BEFORE UPDATE OF review_status ON bug_reports
WHEN NEW.review_status != OLD.review_status AND NEW.reviewed_by_user_id IS NULL AND EXISTS (SELECT 1 FROM users)
BEGIN SELECT RAISE(ABORT, 'A decision on a bug report needs a person with an account'); END;`);
  // The test plan is a workspace a person owns. A plan item starts as the agent's proposal and becomes a person's once they edit or decide it; an import never
  // overwrites an item a person owns (the agent's newer version waits in pending_json). review_status: proposed (agent) -> draft (a person works on it) -> approved / rejected.
  for (const [col, ddl] of [
    ["origin", "TEXT NOT NULL DEFAULT 'agent' CHECK (origin IN ('agent', 'human'))"],
    ["review_status", "TEXT NOT NULL DEFAULT 'proposed' CHECK (review_status IN ('proposed', 'draft', 'approved', 'rejected'))"],
    ["edited_by", "TEXT NOT NULL DEFAULT ''"], ["edited_by_user_id", "INTEGER"], ["edited_at", "TEXT"],
    ["decided_by", "TEXT NOT NULL DEFAULT ''"], ["decided_by_user_id", "INTEGER"], ["decided_at", "TEXT"],
    ["pending_json", "TEXT"],
    ["agent_hash", "TEXT NOT NULL DEFAULT ''"], // fingerprint of the last version the agent sent, so an ignored version is not offered again
  ] as const) {
    if (!hasColumn("audit_plan_items", col)) d.exec(`ALTER TABLE audit_plan_items ADD COLUMN ${col} ${ddl}`);
  }
  d.exec(`
CREATE TABLE IF NOT EXISTS audit_plan_revisions (
  id INTEGER PRIMARY KEY,
  audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  actor_user_id INTEGER,
  note TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL,
  UNIQUE (audit_id, source_id, rev)
);
CREATE INDEX IF NOT EXISTS audit_plan_revisions_audit ON audit_plan_revisions(audit_id, id);
-- With accounts, a decision on a plan item (and a person taking an item over) is made by an account: a name alone is not enough, and an agent has none.
CREATE TRIGGER IF NOT EXISTS audit_plan_items_decision_needs_account_insert BEFORE INSERT ON audit_plan_items
WHEN EXISTS (SELECT 1 FROM users) AND ((NEW.review_status IN ('approved', 'rejected') AND NEW.decided_by_user_id IS NULL) OR (NEW.review_status = 'draft' AND NEW.edited_by_user_id IS NULL))
BEGIN SELECT RAISE(ABORT, 'A decision on a test plan item needs a person with an account'); END;
CREATE TRIGGER IF NOT EXISTS audit_plan_items_decision_needs_account_update BEFORE UPDATE OF review_status ON audit_plan_items
WHEN NEW.review_status != OLD.review_status AND EXISTS (SELECT 1 FROM users) AND ((NEW.review_status IN ('approved', 'rejected') AND NEW.decided_by_user_id IS NULL) OR (NEW.review_status = 'draft' AND NEW.edited_by_user_id IS NULL))
BEGIN SELECT RAISE(ABORT, 'A decision on a test plan item needs a person with an account'); END;`);
  // Coverage gaps work the same way as plan items: the agent's proposal until a person edits, decides or adds one; an import never overwrites or removes what a person owns.
  for (const [col, ddl] of [
    ["origin", "TEXT NOT NULL DEFAULT 'agent' CHECK (origin IN ('agent', 'human'))"],
    ["review_status", "TEXT NOT NULL DEFAULT 'proposed' CHECK (review_status IN ('proposed', 'draft', 'approved', 'rejected'))"],
    ["edited_by", "TEXT NOT NULL DEFAULT ''"], ["edited_by_user_id", "INTEGER"], ["edited_at", "TEXT"],
    ["decided_by", "TEXT NOT NULL DEFAULT ''"], ["decided_by_user_id", "INTEGER"], ["decided_at", "TEXT"],
    ["pending_json", "TEXT"],
    ["agent_hash", "TEXT NOT NULL DEFAULT ''"],
  ] as const) {
    if (!hasColumn("audit_coverage_gaps", col)) d.exec(`ALTER TABLE audit_coverage_gaps ADD COLUMN ${col} ${ddl}`);
  }
  d.exec(`
CREATE TABLE IF NOT EXISTS audit_gap_revisions (
  id INTEGER PRIMARY KEY,
  audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  actor_user_id INTEGER,
  note TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL,
  UNIQUE (audit_id, source_id, rev)
);
CREATE INDEX IF NOT EXISTS audit_gap_revisions_audit ON audit_gap_revisions(audit_id, id);
CREATE TRIGGER IF NOT EXISTS audit_coverage_gaps_decision_needs_account_insert BEFORE INSERT ON audit_coverage_gaps
WHEN EXISTS (SELECT 1 FROM users) AND ((NEW.review_status IN ('approved', 'rejected') AND NEW.decided_by_user_id IS NULL) OR (NEW.review_status = 'draft' AND NEW.edited_by_user_id IS NULL))
BEGIN SELECT RAISE(ABORT, 'A decision on a coverage gap needs a person with an account'); END;
CREATE TRIGGER IF NOT EXISTS audit_coverage_gaps_decision_needs_account_update BEFORE UPDATE OF review_status ON audit_coverage_gaps
WHEN NEW.review_status != OLD.review_status AND EXISTS (SELECT 1 FROM users) AND ((NEW.review_status IN ('approved', 'rejected') AND NEW.decided_by_user_id IS NULL) OR (NEW.review_status = 'draft' AND NEW.edited_by_user_id IS NULL))
BEGIN SELECT RAISE(ABORT, 'A decision on a coverage gap needs a person with an account'); END;`);
  // With accounts, an AI-suggested requirement is approved by an account: a name alone (which anyone can type, and an agent could send) is not enough.
  d.exec(`
CREATE TRIGGER IF NOT EXISTS requirements_ai_needs_account_insert BEFORE INSERT ON requirements
WHEN NEW.origin = 'ai_suggestion' AND NEW.status = 'approved' AND NEW.approved_by_user_id IS NULL AND EXISTS (SELECT 1 FROM users)
BEGIN SELECT RAISE(ABORT, 'An AI-suggested requirement can only be approved by a person with an account'); END;
CREATE TRIGGER IF NOT EXISTS requirements_ai_needs_account_update BEFORE UPDATE OF status ON requirements
WHEN NEW.origin = 'ai_suggestion' AND NEW.status = 'approved' AND OLD.status != 'approved' AND NEW.approved_by_user_id IS NULL AND EXISTS (SELECT 1 FROM users)
BEGIN SELECT RAISE(ABORT, 'An AI-suggested requirement can only be approved by a person with an account'); END;`);
  d.transaction(() => {
    if (d.prepare("SELECT 1 FROM app_settings WHERE key = 'roles_migrated_at'").get()) return;
    const added = d.prepare(`INSERT OR IGNORE INTO project_members (project_id, user_id, role)
      SELECT p.id, u.id, 'tester' FROM projects p CROSS JOIN users u WHERE u.is_owner = 0`).run().changes;
    if (added) d.prepare("INSERT INTO audit_log (actor_label, action, detail) VALUES ('migration', 'members.migrated', ?)").run(JSON.stringify({ role: "tester", memberships: added }));
    d.prepare("INSERT INTO app_settings (key, value) VALUES ('roles_migrated_at', datetime('now'))").run();
  })();
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
  // The test plan of an audit (test-plan.json): its plan items and coverage gaps. They belong to the audit and are never test cases, runs or results: they say what
  // was planned and what was not verified, not what was tested. The latest import of the same audit replaces them. `result` is reserved for the executions of a
  // later step and is always NULL for now; `inconclusive` is a status of its own there, not a kind of skipped or untested.
  d.exec(`
CREATE TABLE IF NOT EXISTS audit_plan_items (
  id INTEGER PRIMARY KEY,
  audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  test_type TEXT NOT NULL DEFAULT '',
  risk TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT '',
  readiness TEXT NOT NULL DEFAULT '' CHECK (readiness IN ('', 'ready', 'needs-clarification')),
  preconditions TEXT NOT NULL DEFAULT '',
  test_data TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]',
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  automation TEXT NOT NULL DEFAULT '',
  requirement_refs TEXT NOT NULL DEFAULT '[]',
  result TEXT CHECK (result IS NULL OR result IN ('pass', 'fail', 'blocked', 'skipped', 'inconclusive')),
  UNIQUE (audit_id, source_id)
);
CREATE TABLE IF NOT EXISTS audit_coverage_gaps (
  id INTEGER PRIMARY KEY,
  audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  description TEXT NOT NULL,
  requirement_refs TEXT NOT NULL DEFAULT '[]',
  UNIQUE (audit_id, source_id)
);`);
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
-- Read-only tokens for a test agent (tbag_). A separate table and a separate kind of token from ci_tokens: a CI token never works for the agent and the
-- other way round. Only a hash is kept; the token itself is shown once, when it is made. A token belongs to one project.
CREATE TABLE IF NOT EXISTS agent_tokens (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_tokens_project ON agent_tokens(project_id);
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

  migrateObservations(d);
  migrateRequirementModel(d);
  migrateAccounts(d);
  migrateRoles(d);

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
