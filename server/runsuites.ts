import { db, ensureMilestone, parseJson, snapshotCase } from "./db.ts";
import { latestStatusByCase } from "./requirements.ts";

/**
 * Suites: runnable groups of test cases.
 *
 * Two different things have been called a suite. The app now names them apart:
 *  - a FOLDER organises cases (table `suites`, routes /suites, server/suites.ts). A case is in one folder. A folder is not run as a whole.
 *  - a SUITE is a named, saved list of cases that is run as a unit (table `run_templates`, routes /templates). A case can be in any number of suites.
 * The tables and routes keep their old names, so that nothing stored or called from outside changes; only the words in the app differ.
 *
 * A suite is a static list: it holds the cases a person put in it (or copied from a folder), in the order of the case list. Running it makes an ordinary
 * MANUAL run of the cases it holds at that moment (createManualRun). Nothing is executed automatically. For a case that has automated tests linked to it
 * (automated_tests.case_id) the latest automated result is shown as information only ("Last automated"); starting automated tests comes later.
 */

export class SuiteError extends Error {
  constructor(public status: 400 | 404 | 409, message: string) {
    super(message);
  }
}

/** manual: no automated test is linked to the case. automated: tests are linked and the case has no manual steps. both: tests are linked and it has steps. */
export type Automation = "manual" | "automated" | "both";
export interface LastAutomated {
  /** failed when any linked test last failed or was blocked, otherwise passed. */
  status: "passed" | "failed";
  /** When the latest of the linked tests ran. */
  at: string;
  runId: number;
  /** How many of the linked tests have a result. */
  tests: number;
}
export interface CaseAutomation {
  automation: Automation;
  automatedTests: number;
  lastAutomated: LastAutomated | null;
}

const json = (ids: number[]) => JSON.stringify([...new Set(ids)]);

/** What the automated side knows about each case. Derived from the links every time; nothing about it is stored on the case. */
export function automationByCase(projectId: number, caseIds: number[]): Map<number, CaseAutomation> {
  const out = new Map<number, CaseAutomation>();
  const ids = [...new Set(caseIds)];
  if (!ids.length) return out;
  const list = json(ids);
  const steps = new Map(
    (db.prepare("SELECT case_id, COUNT(*) AS n FROM case_steps WHERE case_id IN (SELECT value FROM json_each(?)) GROUP BY case_id").all(list) as { case_id: number; n: number }[]).map((r) => [r.case_id, r.n]),
  );
  const tests = db
    .prepare("SELECT id, case_id FROM automated_tests WHERE project_id = ? AND case_id IN (SELECT value FROM json_each(?))")
    .all(projectId, list) as { id: number; case_id: number }[];
  const caseOfTest = new Map(tests.map((t) => [t.id, t.case_id]));
  const latest = tests.length
    ? (db
        .prepare(`
          SELECT automated_test_id, status, at, run_id FROM (
            SELECT r.automated_test_id, r.status, r.run_id, COALESCE(r.executed_at, ru.started_at) AS at,
              ROW_NUMBER() OVER (PARTITION BY r.automated_test_id ORDER BY COALESCE(r.executed_at, ru.started_at) DESC, r.id DESC) AS rn
            FROM results r JOIN runs ru ON ru.id = r.run_id
            WHERE ru.project_id = ? AND r.status NOT IN ('untested', 'skipped')
              AND r.automated_test_id IN (SELECT id FROM automated_tests WHERE project_id = ? AND case_id IN (SELECT value FROM json_each(?)))
          ) WHERE rn = 1`)
        .all(projectId, projectId, list) as { automated_test_id: number; status: string; at: string; run_id: number }[])
    : [];
  const perCase = new Map<number, { failed: boolean; at: string; runId: number; tests: number }>();
  for (const r of latest) {
    const caseId = caseOfTest.get(r.automated_test_id);
    if (caseId === undefined) continue;
    const cur = perCase.get(caseId) ?? { failed: false, at: "", runId: 0, tests: 0 };
    cur.tests++;
    if (r.status === "failed" || r.status === "blocked") cur.failed = true;
    if (r.at > cur.at) { cur.at = r.at; cur.runId = r.run_id; }
    perCase.set(caseId, cur);
  }
  const count = new Map<number, number>();
  for (const t of tests) count.set(t.case_id, (count.get(t.case_id) ?? 0) + 1);
  for (const id of ids) {
    const automatedTests = count.get(id) ?? 0;
    const last = perCase.get(id);
    out.set(id, {
      automation: automatedTests === 0 ? "manual" : (steps.get(id) ?? 0) > 0 ? "both" : "automated",
      automatedTests,
      lastAutomated: last ? { status: last.failed ? "failed" : "passed", at: last.at, runId: last.runId, tests: last.tests } : null,
    });
  }
  return out;
}

/** Adds `automation`, `automated_tests` and `last_automated` to rows that have a `case_id`. */
export function withAutomation<T extends { case_id: number | null }>(projectId: number, rows: T[]) {
  const map = automationByCase(projectId, rows.map((r) => r.case_id).filter((id): id is number => id !== null));
  return rows.map((r) => {
    const a = r.case_id === null ? undefined : map.get(r.case_id);
    return { ...r, automation: a?.automation ?? "manual", automated_tests: a?.automatedTests ?? 0, last_automated: a?.lastAutomated ?? null };
  });
}

// ---------- the suites of a project ----------

interface SuiteRow {
  id: number; project_id: number; name: string; description: string; environment: string; created_at: string; updated_at: string;
}

const RUN_COUNTS = `
  COUNT(r.id) AS total,
  COALESCE(SUM(r.status = 'passed'), 0) AS passed,
  COALESCE(SUM(r.status = 'failed'), 0) AS failed,
  COALESCE(SUM(r.status = 'blocked'), 0) AS blocked,
  COALESCE(SUM(r.status = 'untested'), 0) AS untested`;

const runsOf = (templateId: number, limit: number) =>
  db
    .prepare(`
      SELECT ru.id, ru.title, ru.status, ru.started_at, ${RUN_COUNTS}
      FROM runs ru LEFT JOIN results r ON r.run_id = ru.id
      WHERE ru.template_id = ? GROUP BY ru.id ORDER BY ru.started_at DESC, ru.id DESC LIMIT ?`)
    .all(templateId, limit) as Record<string, any>[];

export function suiteCaseIds(templateId: number): number[] {
  return (
    db
      .prepare("SELECT x.case_id FROM run_template_cases x JOIN cases c ON c.id = x.case_id WHERE x.template_id = ? ORDER BY c.position, c.number")
      .all(templateId) as { case_id: number }[]
  ).map((c) => c.case_id);
}

export function listSuites(projectId: number, onlyId?: number) {
  const rows = db
    .prepare(`
      SELECT t.id, t.project_id, t.name, t.description, t.environment, t.created_at, t.updated_at,
        t.schedule, t.schedule_tz, t.next_run_at, t.schedule_set_by, t.schedule_set_at,
        (SELECT COUNT(*) FROM runs r WHERE r.template_id = t.id) AS run_count,
        (SELECT MAX(r.started_at) FROM runs r WHERE r.template_id = t.id) AS last_used
      FROM run_templates t WHERE t.project_id = ? ${onlyId ? "AND t.id = ?" : ""} ORDER BY t.name COLLATE NOCASE`)
    .all(...(onlyId ? [projectId, onlyId] : [projectId])) as Record<string, any>[];
  return rows.map((t) => {
    const caseIds = suiteCaseIds(t.id);
    return { ...t, caseIds, case_count: caseIds.length, last_run: runsOf(t.id, 1)[0] ?? null };
  });
}

const suiteRow = (id: number) => {
  const row = db.prepare("SELECT * FROM run_templates WHERE id = ?").get(id) as SuiteRow | undefined;
  if (!row) throw new SuiteError(404, "Suite not found");
  return row;
};

/** One suite with its cases (in the order they are run), what the automated side knows about each, and its latest runs. */
export function getSuite(id: number) {
  const row = suiteRow(id);
  const base = listSuites(row.project_id, id)[0];
  const cases = db
    .prepare(`
      SELECT c.id, c.number, c.title, c.priority, c.status, c.suite_id AS folder_id, s.name AS folder_name
      FROM run_template_cases x JOIN cases c ON c.id = x.case_id LEFT JOIN suites s ON s.id = c.suite_id
      WHERE x.template_id = ? ORDER BY c.position, c.number`)
    .all(id) as { id: number; [key: string]: unknown }[];
  const automation = automationByCase(row.project_id, cases.map((c) => c.id));
  const latest = latestStatusByCase(row.project_id);
  return {
    ...base,
    cases: cases.map((c) => {
      const a = automation.get(c.id);
      return { ...c, automation: a?.automation ?? "manual", automated_tests: a?.automatedTests ?? 0, last_automated: a?.lastAutomated ?? null, last_status: latest.get(c.id) ?? null };
    }),
    runs: runsOf(id, 10),
  };
}

const touch = (id: number) => db.prepare("UPDATE run_templates SET updated_at = datetime('now') WHERE id = ?").run(id);

/** Replaces the list. Cases of other projects are skipped. Used by create and by the whole-list PATCH. */
export function setSuiteCases(templateId: number, projectId: number, caseIds: number[]) {
  const valid = caseIds.length
    ? (db.prepare("SELECT id FROM cases WHERE project_id = ? AND id IN (SELECT value FROM json_each(?))").all(projectId, json(caseIds)) as { id: number }[])
    : [];
  db.prepare("DELETE FROM run_template_cases WHERE template_id = ?").run(templateId);
  const ins = db.prepare("INSERT OR IGNORE INTO run_template_cases (template_id, case_id) VALUES (?, ?)");
  for (const c of valid) ins.run(templateId, c.id);
}

/** Adds cases. Asking for a case that is not in this project is an error, and then nothing is added. Adding what is already there does nothing. */
export function addSuiteCases(id: number, caseIds: number[]) {
  const row = suiteRow(id);
  const wanted = [...new Set(caseIds)];
  const found = db.prepare("SELECT id FROM cases WHERE project_id = ? AND id IN (SELECT value FROM json_each(?))").all(row.project_id, json(wanted)) as { id: number }[];
  if (found.length !== wanted.length) {
    const missing = wanted.length - found.length;
    throw new SuiteError(400, `${missing} of the test cases ${missing === 1 ? "is" : "are"} not in this project`);
  }
  db.transaction(() => {
    const ins = db.prepare("INSERT OR IGNORE INTO run_template_cases (template_id, case_id) VALUES (?, ?)");
    for (const c of found) ins.run(id, c.id);
    touch(id);
  })();
  return getSuite(id);
}

export function removeSuiteCase(id: number, caseId: number) {
  suiteRow(id);
  const res = db.prepare("DELETE FROM run_template_cases WHERE template_id = ? AND case_id = ?").run(id, caseId);
  if (res.changes === 0) throw new SuiteError(404, "That test case is not in the suite");
  touch(id);
  return getSuite(id);
}

export interface FromFolderInput { folderId: number; name?: string; description?: string; environment?: string; includeSubfolders?: boolean }

/** A new suite that is a COPY of the cases a folder holds now (and, by default, its subfolders). Later changes to the folder do not change the suite. */
export function suiteFromFolder(projectId: number, input: FromFolderInput) {
  const folder = db.prepare("SELECT id, name FROM suites WHERE id = ? AND project_id = ?").get(input.folderId, projectId) as { id: number; name: string } | undefined;
  if (!folder) throw new SuiteError(404, "Folder not found");
  const name = (input.name ?? folder.name).trim();
  if (!name || name.length > 100) throw new SuiteError(400, "The suite needs a name of 1 to 100 characters");
  if (db.prepare("SELECT 1 FROM run_templates WHERE project_id = ? AND name = ?").get(projectId, name)) throw new SuiteError(409, `A suite named "${name}" already exists`);
  const folderIds = (input.includeSubfolders ?? true)
    ? (db
        .prepare(`
          WITH RECURSIVE tree(id) AS (
            SELECT id FROM suites WHERE id = ? AND project_id = ?
            UNION SELECT s.id FROM suites s JOIN tree t ON s.parent_id = t.id WHERE s.project_id = ?
          ) SELECT id FROM tree`)
        .all(folder.id, projectId, projectId) as { id: number }[]).map((r) => r.id)
    : [folder.id];
  const cases = db
    .prepare("SELECT id FROM cases WHERE project_id = ? AND suite_id IN (SELECT value FROM json_each(?)) ORDER BY position, number")
    .all(projectId, json(folderIds)) as { id: number }[];
  if (!cases.length) throw new SuiteError(400, "The folder has no test cases");
  const id = db.transaction(() => {
    const t = db
      .prepare("INSERT INTO run_templates (project_id, name, description, environment) VALUES (?, ?, ?, ?) RETURNING id")
      .get(projectId, name, input.description ?? "", input.environment ?? "") as { id: number };
    const ins = db.prepare("INSERT INTO run_template_cases (template_id, case_id) VALUES (?, ?)");
    for (const c of cases) ins.run(t.id, c.id);
    return t.id;
  })();
  return getSuite(id);
}

// ---------- running ----------

export interface ManualRunInput {
  title: string;
  environment?: string;
  milestone?: string;
  caseIds: number[];
  templateId?: number | null;
  /** The run this one re-tests, e.g. the failures of last night's run. */
  rerunOf?: number | null;
  /** Set by the scheduler (server/scheduler.ts): the time the schedule said, in UTC. Written to meta.scheduled, which is how a scheduled run is told from one started by hand. */
  scheduledFor?: string;
}

/**
 * A manual run of the given cases, in the order of the case list. Each case is frozen as it is now (snapshot), so later edits do not change the run.
 * When it comes from a suite, the run remembers which one in meta.suite (id, name), because the suite can be renamed or deleted afterwards. `partial` is set when
 * the run does not cover all the cases the suite held at the start, so that nobody is told cases were "left out" that a person chose not to run.
 */
export function createManualRun(projectId: number, input: ManualRunInput) {
  const suite = input.templateId
    ? (db.prepare("SELECT id, name FROM run_templates WHERE id = ? AND project_id = ?").get(input.templateId, projectId) as { id: number; name: string } | undefined)
    : undefined;
  if (input.templateId && !suite) throw new SuiteError(400, "Template belongs to another project");
  const source = input.rerunOf
    ? (db.prepare("SELECT id, title FROM runs WHERE id = ? AND project_id = ?").get(input.rerunOf, projectId) as { id: number; title: string } | undefined)
    : undefined;
  if (input.rerunOf && !source) throw new SuiteError(400, "The run to re-test belongs to another project");
  return db.transaction(() => {
    // Keep the same order as the case list, not the order of selection.
    const cases = db
      .prepare("SELECT id FROM cases WHERE project_id = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY position, number")
      .all(projectId, json(input.caseIds)) as { id: number }[];
    const members = suite ? new Set(suiteCaseIds(suite.id)) : null;
    const partial = !!members && (cases.length !== members.size || cases.some((c) => !members.has(c.id)));
    const meta = {
      ...(source ? { rerunOf: source } : {}),
      ...(suite ? { suite: { id: suite.id, name: suite.name, ...(partial ? { partial: true } : {}) } } : {}),
      ...(input.scheduledFor ? { scheduled: { for: input.scheduledFor } } : {}),
    };
    const run = db
      .prepare(`
        INSERT INTO runs (project_id, title, kind, source, environment, milestone, template_id, meta)
        VALUES (?, ?, 'manual', 'manual', ?, ?, ?, ?) RETURNING *`)
      .get(projectId, input.title, input.environment ?? "", input.milestone ?? "", suite?.id ?? null, JSON.stringify(meta)) as { id: number };
    const ins = db.prepare("INSERT INTO results (run_id, case_id, position, snapshot) VALUES (?, ?, ?, ?)");
    cases.forEach((c, i) => ins.run(run.id, c.id, i, JSON.stringify(snapshotCase(c.id))));
    ensureMilestone(projectId, input.milestone ?? "");
    return run;
  })();
}

export interface SuiteRunInput { title?: string; environment?: string; milestone?: string; scheduledFor?: string }

/** Runs a suite again or for the first time: a manual run of the cases it holds NOW (not of the cases of the last run). */
export function startSuiteRun(id: number, input: SuiteRunInput = {}) {
  const suite = suiteRow(id);
  const caseIds = suiteCaseIds(id);
  if (!caseIds.length) throw new SuiteError(400, "The suite has no test cases");
  const title = input.title?.trim() || `${suite.name} · ${new Date().toISOString().slice(0, 10)}`;
  return createManualRun(suite.project_id, { title, environment: input.environment ?? suite.environment, milestone: input.milestone, caseIds, templateId: id, scheduledFor: input.scheduledFor });
}

export interface RunSuiteInfo {
  /** null when the suite has been deleted. */
  id: number | null;
  name: string;
  deleted: boolean;
  /** The run covered only part of the suite on purpose: nothing is said about what was left out. */
  partial: boolean;
  /** Cases the suite holds now that the run did not cover, and cases the run covered that the suite does not hold any more. */
  added: number;
  removed: number;
}

type RunMeta = { suite?: { id: number; name: string; partial?: boolean } };

/** Which suite a run came from, and how the suite has changed since. null for a run that did not come from a suite. */
export function runSuiteInfo(run: { id: number; template_id: number | null; meta: unknown }): RunSuiteInfo | null {
  const meta: RunMeta = (typeof run.meta === "string" ? parseJson<RunMeta>(run.meta, {}) : (run.meta as RunMeta | null)) ?? {};
  const current = run.template_id ? (db.prepare("SELECT id, name FROM run_templates WHERE id = ?").get(run.template_id) as { id: number; name: string } | undefined) : undefined;
  if (!current && !meta.suite) return null;
  if (!current) return { id: null, name: meta.suite?.name ?? "Deleted suite", deleted: true, partial: !!meta.suite?.partial, added: 0, removed: 0 };
  const partial = !!meta.suite?.partial;
  if (partial) return { id: current.id, name: current.name, deleted: false, partial, added: 0, removed: 0 };
  const covered = new Set((db.prepare("SELECT case_id FROM results WHERE run_id = ? AND case_id IS NOT NULL").all(run.id) as { case_id: number }[]).map((r) => r.case_id));
  const members = new Set(suiteCaseIds(current.id));
  return {
    id: current.id,
    name: current.name,
    deleted: false,
    partial,
    added: [...members].filter((id) => !covered.has(id)).length,
    removed: [...covered].filter((id) => !members.has(id)).length,
  };
}
