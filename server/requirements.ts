import { db, parseJson } from "./db.ts";

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

/** True when the requirement's wording changed after this link was made or last confirmed. Needs the rc alias. */
const REVIEW_SQL = `EXISTS (SELECT 1 FROM requirement_revisions v WHERE v.requirement_id = rc.requirement_id AND v.material = 1 AND v.id > rc.reviewed_rev)`;

export function listRequirements(projectId: number) {
  const rows = db.prepare("SELECT * FROM requirements WHERE project_id = ? ORDER BY number").all(projectId) as RequirementRow[];
  const links = db
    .prepare(`
      SELECT rc.requirement_id, rc.case_id, c.status AS case_status, ${REVIEW_SQL} AS review
      FROM requirement_cases rc JOIN requirements r ON r.id = rc.requirement_id JOIN cases c ON c.id = rc.case_id
      WHERE r.project_id = ?`)
    .all(projectId) as { requirement_id: number; case_id: number; case_status: string; review: number }[];
  const latest = latestStatusByCase(projectId);

  const byReq = new Map<number, { id: number; active: boolean; review: boolean }[]>();
  for (const l of links) {
    if (!byReq.has(l.requirement_id)) byReq.set(l.requirement_id, []);
    byReq.get(l.requirement_id)!.push({ id: l.case_id, active: l.case_status !== "deprecated", review: !!l.review });
  }
  return rows.map((r) => {
    const linked = byReq.get(r.id) ?? [];
    return {
      ...r,
      caseIds: linked.map((l) => l.id),
      /** Linked cases that are not deprecated: only these count towards coverage. */
      activeCaseIds: linked.filter((l) => l.active).map((l) => l.id),
      coverage: classify(linked.filter((l) => l.active).map((l) => latest.get(l.id))),
      /** Active linked cases that haven't been confirmed since the requirement's wording last changed. */
      reviewCount: linked.filter((l) => l.active && l.review).length,
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
        SELECT c.id, c.number, c.title, c.priority, c.status, s.name AS suite_name, ${REVIEW_SQL} AS review_needed
        FROM requirement_cases rc JOIN cases c ON c.id = rc.case_id LEFT JOIN suites s ON s.id = c.suite_id
        WHERE rc.requirement_id = ? ORDER BY c.number`)
      .all(id) as { id: number; number: number; title: string; priority: string; status: string; suite_name: string | null; review_needed: number }[]
  ).map((c) => ({ ...c, review_needed: !!c.review_needed, last_status: latest.get(c.id) ?? null }));
  const history = (db.prepare("SELECT id, changed_at, material, changes FROM requirement_revisions WHERE requirement_id = ? ORDER BY id DESC LIMIT 100").all(id) as { id: number; changed_at: string; material: number; changes: string }[]).map(
    (h) => ({ id: h.id, at: h.changed_at, material: !!h.material, changes: parseJson<RevisionChange[]>(h.changes, []) }),
  );
  return { ...row, cases, history, coverage: classify(cases.filter((c) => c.status !== "deprecated").map((c) => c.last_status ?? undefined)) };
}

export function requirementsForCase(caseId: number) {
  return (
    db
      .prepare(`
        SELECT r.id, r.number, r.title, r.status, r.priority, ${REVIEW_SQL} AS review_needed
        FROM requirement_cases rc JOIN requirements r ON r.id = rc.requirement_id
        WHERE rc.case_id = ? ORDER BY r.number`)
      .all(caseId) as { id: number; number: number; title: string; status: string; priority: string; review_needed: number }[]
  ).map((r) => ({ ...r, review_needed: !!r.review_needed }));
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
    recordRevision(row.id, [{ field: "created" }], false);
    return row.id;
  })();
}

export interface RevisionChange { field: string; from?: string; to?: string; added?: number[]; removed?: number[] }

export function recordRevision(requirementId: number, changes: RevisionChange[], material: boolean) {
  if (!changes.length) return;
  db.prepare("INSERT INTO requirement_revisions (requirement_id, material, changes) VALUES (?, ?, ?)").run(requirementId, material ? 1 : 0, JSON.stringify(changes));
}

const currentRev = (requirementId: number) =>
  (db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM requirement_revisions WHERE requirement_id = ? AND material = 1").get(requirementId) as { m: number }).m;

const caseNumbers = (ids: number[]) =>
  ids.length ? (db.prepare(`SELECT number FROM cases WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY number`).all(...ids) as { number: number }[]).map((c) => c.number) : [];

/** Make `requirementId` link exactly `wanted` (case ids). Existing links keep their review state; new ones start as confirmed. */
function syncRequirementLinks(requirementId: number, wanted: number[]) {
  const have = (db.prepare("SELECT case_id FROM requirement_cases WHERE requirement_id = ?").all(requirementId) as { case_id: number }[]).map((r) => r.case_id);
  const add = wanted.filter((id) => !have.includes(id));
  const remove = have.filter((id) => !wanted.includes(id));
  const rev = currentRev(requirementId);
  for (const id of remove) db.prepare("DELETE FROM requirement_cases WHERE requirement_id = ? AND case_id = ?").run(requirementId, id);
  for (const id of add) db.prepare("INSERT OR IGNORE INTO requirement_cases (requirement_id, case_id, reviewed_rev) VALUES (?, ?, ?)").run(requirementId, id, rev);
  if (add.length || remove.length) recordRevision(requirementId, [{ field: "cases", added: caseNumbers(add), removed: caseNumbers(remove) }], false);
}

const validCaseIds = (projectId: number, caseIds: number[]) =>
  caseIds.length ? (db.prepare(`SELECT id FROM cases WHERE project_id = ? AND id IN (${caseIds.map(() => "?").join(",")})`).all(projectId, ...caseIds) as { id: number }[]).map((c) => c.id) : [];

/** Replaces the cases linked to a requirement. Ids from other projects are ignored. */
export function setRequirementCases(requirementId: number, projectId: number, caseIds: number[]) {
  const valid = validCaseIds(projectId, caseIds);
  db.transaction(() => syncRequirementLinks(requirementId, valid))();
}

/** Adds links without touching the existing ones. Ids from other projects are ignored. */
export function addRequirementCases(requirementId: number, projectId: number, caseIds: number[]) {
  const existing = (db.prepare("SELECT case_id FROM requirement_cases WHERE requirement_id = ?").all(requirementId) as { case_id: number }[]).map((r) => r.case_id);
  const valid = validCaseIds(projectId, caseIds);
  db.transaction(() => syncRequirementLinks(requirementId, [...new Set([...existing, ...valid])]))();
}

/** Replaces the requirements a case is linked to. Ids from other projects are ignored. */
export function setCaseRequirements(caseId: number, projectId: number, requirementIds: number[]) {
  const valid = requirementIds.length
    ? (db.prepare(`SELECT id FROM requirements WHERE project_id = ? AND id IN (${requirementIds.map(() => "?").join(",")})`).all(projectId, ...requirementIds) as { id: number }[]).map((r) => r.id)
    : [];
  const have = (db.prepare("SELECT requirement_id FROM requirement_cases WHERE case_id = ?").all(caseId) as { requirement_id: number }[]).map((r) => r.requirement_id);
  db.transaction(() => {
    for (const id of new Set([...have, ...valid])) {
      const others = (db.prepare("SELECT case_id FROM requirement_cases WHERE requirement_id = ?").all(id) as { case_id: number }[]).map((r) => r.case_id).filter((c) => c !== caseId);
      syncRequirementLinks(id, valid.includes(id) ? [...others, caseId] : others);
    }
  })();
}

/** Confirm that cases still match the requirement as it is worded now. Without `caseIds`, every linked case. */
export function markReviewed(requirementId: number, caseIds?: number[]) {
  if (caseIds && !caseIds.length) return;
  const rev = currentRev(requirementId);
  const filter = caseIds ? ` AND case_id IN (${caseIds.map(() => "?").join(",")})` : "";
  db.prepare(`UPDATE requirement_cases SET reviewed_rev = ? WHERE requirement_id = ?${filter}`).run(rev, requirementId, ...(caseIds ?? []));
}

/** `@REQ-4` in text links the case to requirement 4 of its project. Only ever adds links. */
export function linkCaseByText(caseId: number, projectId: number, text: string) {
  const numbers = [...new Set([...text.matchAll(/@REQ-(\d+)\b/gi)].map((m) => Number(m[1])))];
  for (const n of numbers) {
    const req = db.prepare("SELECT id FROM requirements WHERE project_id = ? AND number = ?").get(projectId, n) as { id: number } | undefined;
    if (req) addRequirementCases(req.id, projectId, [caseId]);
  }
}

/** A case's title, description and tags. */
export function linkCaseByTags(caseId: number) {
  const c = db.prepare("SELECT project_id, title, description, tags FROM cases WHERE id = ?").get(caseId) as { project_id: number; title: string; description: string; tags: string } | undefined;
  if (c) linkCaseByText(caseId, c.project_id, `${c.title}\n${c.description}\n${parseJson<string[]>(c.tags, []).join("\n")}`);
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
