import { z } from "zod";
import { db } from "./db.ts";
import { OPEN_STATUSES } from "./observations.ts";
import { RequirementError } from "./requirements.ts";

/**
 * What is not covered yet, as three lists a person works through. They are the groundwork for proposals, and nothing here makes or changes a requirement.
 *  - Requirements without a test case: approved requirements with no linked test case that is still in use.
 *  - Test cases without a requirement: cases in use that no requirement in use names.
 *  - Observations without a link: observations still being looked at that a person has linked to neither a requirement nor a test case.
 * Everything is scoped to the project; a link can only name things of the observation's own project.
 */

const projectExists = (projectId: number) => !!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);

export function coverageGaps(projectId: number) {
  if (!projectExists(projectId)) throw new RequirementError(404, "Project not found");
  const requirements = db.prepare(`
    SELECT r.id, r.number, r.title, r.priority, r.kind, r.origin FROM requirements r
    WHERE r.project_id = ? AND r.status = 'approved'
      AND NOT EXISTS (SELECT 1 FROM requirement_cases rc JOIN cases c ON c.id = rc.case_id WHERE rc.requirement_id = r.id AND c.status = 'ready')
    ORDER BY r.number`).all(projectId) as { id: number; number: number; title: string; priority: string; kind: string; origin: string }[];
  const cases = db.prepare(`
    SELECT c.id, c.number, c.title, c.priority, c.status FROM cases c
    WHERE c.project_id = ? AND c.status != 'deprecated'
      AND NOT EXISTS (SELECT 1 FROM requirement_cases rc JOIN requirements r ON r.id = rc.requirement_id WHERE rc.case_id = c.id AND r.status != 'deprecated')
    ORDER BY c.number`).all(projectId) as { id: number; number: number; title: string; priority: string; status: string }[];
  const open = OPEN_STATUSES.map(() => "?").join(",");
  const observations = db.prepare(`
    SELECT o.id, o.number, o.title, o.kind, o.severity, o.status FROM observations o
    WHERE o.project_id = ? AND o.status IN (${open})
      AND NOT EXISTS (SELECT 1 FROM observation_requirements x WHERE x.observation_id = o.id)
      AND NOT EXISTS (SELECT 1 FROM observation_cases y WHERE y.observation_id = o.id)
    ORDER BY CASE o.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC, o.number DESC`).all(projectId, ...OPEN_STATUSES) as
    { id: number; number: number; title: string; kind: string; severity: string; status: string }[];
  return {
    counts: { requirementsWithoutCases: requirements.length, casesWithoutRequirement: cases.length, observationsWithoutLink: observations.length },
    requirementsWithoutCases: requirements,
    casesWithoutRequirement: cases,
    observationsWithoutLink: observations.map((o) => ({ id: o.id, label: `OBS-${o.number}`, title: o.title, kind: o.kind, severity: o.severity, status: o.status })),
  };
}

const observationProject = (observationId: number) => {
  const o = db.prepare("SELECT project_id FROM observations WHERE id = ?").get(observationId) as { project_id: number } | undefined;
  if (!o) throw new RequirementError(404, "Observation not found");
  return o.project_id;
};

/** The requirements and test cases a person has linked an observation to. */
export function getObservationLinks(observationId: number) {
  observationProject(observationId);
  return {
    requirements: db.prepare("SELECT r.id, r.number, r.title, r.status FROM observation_requirements x JOIN requirements r ON r.id = x.requirement_id WHERE x.observation_id = ? ORDER BY r.number").all(observationId) as { id: number; number: number; title: string; status: string }[],
    cases: db.prepare("SELECT c.id, c.number, c.title, c.status FROM observation_cases x JOIN cases c ON c.id = x.case_id WHERE x.observation_id = ? ORDER BY c.number").all(observationId) as { id: number; number: number; title: string; status: string }[],
  };
}

const LinksSchema = z.object({
  requirementIds: z.array(z.number().int().positive()).max(200).default([]),
  caseIds: z.array(z.number().int().positive()).max(200).default([]),
}).strict();

/**
 * Replaces the links of an observation. This is a person's decision (a link is what takes an observation off the gap list). An id that is not in the observation's
 * own project is refused, not skipped: nothing is saved and the answer says which.
 */
export function setObservationLinks(observationId: number, body: unknown) {
  const projectId = observationProject(observationId);
  const p = LinksSchema.safeParse(body);
  if (!p.success) throw new RequirementError(400, "The links are not valid", p.error.issues.map((x) => `${x.path.join(".") || "links"}: ${x.message}`));
  const { requirementIds, caseIds } = { requirementIds: [...new Set(p.data.requirementIds)], caseIds: [...new Set(p.data.caseIds)] };
  const problems: string[] = [];
  const known = (table: "requirements" | "cases", ids: number[]) => new Set((ids.length ? db.prepare(`SELECT id FROM ${table} WHERE project_id = ? AND id IN (${ids.map(() => "?").join(",")})`).all(projectId, ...ids) as { id: number }[] : []).map((r) => r.id));
  const okReq = known("requirements", requirementIds);
  const okCase = known("cases", caseIds);
  for (const id of requirementIds) if (!okReq.has(id)) problems.push(`requirementIds: ${id} is not a requirement of this project`);
  for (const id of caseIds) if (!okCase.has(id)) problems.push(`caseIds: ${id} is not a test case of this project`);
  if (problems.length) throw new RequirementError(400, "Nothing was saved: some links are not in this project", problems);
  db.transaction(() => {
    db.prepare("DELETE FROM observation_requirements WHERE observation_id = ?").run(observationId);
    db.prepare("DELETE FROM observation_cases WHERE observation_id = ?").run(observationId);
    for (const id of requirementIds) db.prepare("INSERT INTO observation_requirements (observation_id, requirement_id) VALUES (?, ?)").run(observationId, id);
    for (const id of caseIds) db.prepare("INSERT INTO observation_cases (observation_id, case_id) VALUES (?, ?)").run(observationId, id);
  })();
  return getObservationLinks(observationId);
}
