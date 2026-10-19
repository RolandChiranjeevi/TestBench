import { db } from "./db.ts";

/**
 * How well a requirement is tested, from the latest result of each test case linked to it:
 * - uncovered: no (active) test case is linked
 * - failing:   at least one linked case's latest result failed or is blocked
 * - passing:   every linked case has a latest result and all of them passed
 * - partial:   some linked cases passed, the rest have not been run yet
 * - untested:  cases are linked but none has been run
 */
export type CoverageState = "uncovered" | "failing" | "passing" | "partial" | "untested";

export interface Coverage {
  state: CoverageState;
  cases: number;
  passing: number;
  failing: number;
  notRun: number;
}

export interface RequirementRow {
  id: number;
  project_id: number;
  number: number;
  title: string;
  description: string;
  priority: string;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
}

/** Newest executed result per case. Skipped and untested results say nothing about a case, so they are ignored. */
export function latestStatusByCase(projectId: number): Map<number, string> {
  const rows = db
    .prepare(`
      SELECT case_id, status FROM (
        SELECT r.case_id, r.status,
          ROW_NUMBER() OVER (PARTITION BY r.case_id ORDER BY COALESCE(r.executed_at, ru.started_at) DESC, r.id DESC) AS rn
        FROM results r JOIN runs ru ON ru.id = r.run_id
        WHERE ru.project_id = ? AND r.case_id IS NOT NULL AND r.status NOT IN ('untested', 'skipped')
      ) WHERE rn = 1`)
    .all(projectId) as { case_id: number; status: string }[];
  return new Map(rows.map((r) => [r.case_id, r.status]));
}

/** `statuses` holds one entry per active linked case: its latest result status, or undefined when it has none. */
export function classify(statuses: (string | undefined)[]): Coverage {
  const cases = statuses.length;
  const failing = statuses.filter((s) => s === "failed" || s === "blocked").length;
  const passing = statuses.filter((s) => s === "passed").length;
  const notRun = cases - failing - passing;
  const state: CoverageState = cases === 0 ? "uncovered" : failing > 0 ? "failing" : passing === cases ? "passing" : passing > 0 ? "partial" : "untested";
  return { state, cases, passing, failing, notRun };
}

export function listRequirements(projectId: number) {
  const rows = db.prepare("SELECT * FROM requirements WHERE project_id = ? ORDER BY number").all(projectId) as RequirementRow[];
  const links = db
    .prepare(`
      SELECT rc.requirement_id, rc.case_id, c.status AS case_status
      FROM requirement_cases rc JOIN requirements r ON r.id = rc.requirement_id JOIN cases c ON c.id = rc.case_id
      WHERE r.project_id = ?`)
    .all(projectId) as { requirement_id: number; case_id: number; case_status: string }[];
  const latest = latestStatusByCase(projectId);

  const byReq = new Map<number, { id: number; active: boolean }[]>();
  for (const l of links) {
    if (!byReq.has(l.requirement_id)) byReq.set(l.requirement_id, []);
    byReq.get(l.requirement_id)!.push({ id: l.case_id, active: l.case_status !== "deprecated" });
  }
  return rows.map((r) => {
    const linked = byReq.get(r.id) ?? [];
    return {
      ...r,
      caseIds: linked.map((l) => l.id),
      /** Linked cases that are not deprecated: only these count towards coverage. */
      activeCaseIds: linked.filter((l) => l.active).map((l) => l.id),
      coverage: classify(linked.filter((l) => l.active).map((l) => latest.get(l.id))),
    };
  });
}

export function getRequirement(id: number) {
  const row = db.prepare("SELECT * FROM requirements WHERE id = ?").get(id) as RequirementRow | undefined;
  if (!row) return null;
  const latest = latestStatusByCase(row.project_id);
  const cases = (
    db
      .prepare(`
        SELECT c.id, c.number, c.title, c.priority, c.status, s.name AS suite_name
        FROM requirement_cases rc JOIN cases c ON c.id = rc.case_id LEFT JOIN suites s ON s.id = c.suite_id
        WHERE rc.requirement_id = ? ORDER BY c.number`)
      .all(id) as { id: number; number: number; title: string; priority: string; status: string; suite_name: string | null }[]
  ).map((c) => ({ ...c, last_status: latest.get(c.id) ?? null }));
  return { ...row, cases, coverage: classify(cases.filter((c) => c.status !== "deprecated").map((c) => c.last_status ?? undefined)) };
}

export function requirementsForCase(caseId: number) {
  return db
    .prepare(`
      SELECT r.id, r.number, r.title, r.status, r.priority
      FROM requirement_cases rc JOIN requirements r ON r.id = rc.requirement_id
      WHERE rc.case_id = ? ORDER BY r.number`)
    .all(caseId) as { id: number; number: number; title: string; status: string; priority: string }[];
}

export interface RequirementInput {
  title: string;
  description?: string;
  priority?: string;
  status?: string;
  source?: string;
}

export function createRequirement(projectId: number, input: RequirementInput): number {
  return db.transaction(() => {
    const n = db
      .prepare("UPDATE projects SET next_requirement_number = next_requirement_number + 1 WHERE id = ? RETURNING next_requirement_number - 1 AS n")
      .get(projectId) as { n: number } | undefined;
    if (!n) throw new Error("Project not found");
    const row = db
      .prepare(`
        INSERT INTO requirements (project_id, number, title, description, priority, status, source)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .get(projectId, n.n, input.title, input.description ?? "", input.priority ?? "medium", input.status ?? "approved", input.source ?? "") as { id: number };
    return row.id;
  })();
}

/** Replaces the cases linked to a requirement. Ids from other projects are ignored. */
export function setRequirementCases(requirementId: number, projectId: number, caseIds: number[]) {
  const valid = caseIds.length ? (db.prepare(`SELECT id FROM cases WHERE project_id = ? AND id IN (${caseIds.map(() => "?").join(",")})`).all(projectId, ...caseIds) as { id: number }[]) : [];
  db.transaction(() => {
    db.prepare("DELETE FROM requirement_cases WHERE requirement_id = ?").run(requirementId);
    const ins = db.prepare("INSERT OR IGNORE INTO requirement_cases (requirement_id, case_id) VALUES (?, ?)");
    for (const c of valid) ins.run(requirementId, c.id);
  })();
}

/** Replaces the requirements a case is linked to. Ids from other projects are ignored. */
export function setCaseRequirements(caseId: number, projectId: number, requirementIds: number[]) {
  const valid = requirementIds.length
    ? (db.prepare(`SELECT id FROM requirements WHERE project_id = ? AND id IN (${requirementIds.map(() => "?").join(",")})`).all(projectId, ...requirementIds) as { id: number }[])
    : [];
  db.transaction(() => {
    db.prepare("DELETE FROM requirement_cases WHERE case_id = ?").run(caseId);
    const ins = db.prepare("INSERT OR IGNORE INTO requirement_cases (requirement_id, case_id) VALUES (?, ?)");
    for (const r of valid) ins.run(r.id, caseId);
  })();
}

/** Headline numbers for the dashboard. Deprecated requirements are left out. */
export function requirementSummary(projectId: number) {
  const active = listRequirements(projectId).filter((r) => r.status !== "deprecated");
  const count = (s: CoverageState) => active.filter((r) => r.coverage.state === s).length;
  return {
    total: active.length,
    covered: active.filter((r) => r.coverage.cases > 0).length,
    passing: count("passing"),
    failing: count("failing"),
    uncovered: count("uncovered"),
  };
}
