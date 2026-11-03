import { db } from "./db.ts";

/**
 * What is linked to a requirement besides the project's own test cases: manual tests and bug reports that name it (REQ-n or its stable id),
 * and whether the latest audit run touched it. Everything here is derived and read-only.
 *
 * Only a person's decisions count as coverage: a manual test counts once it is accepted, a bug counts as open once it is accepted.
 * Proposals from a test agent are shown separately and never make a requirement look covered or broken by themselves.
 */

export interface RequirementOverview {
  manualTests: { accepted: number; proposed: number };
  bugs: { open: number; proposed: number };
  /** Test cases of the project that are linked and not deprecated. */
  cases: number;
  /** No active test case and no accepted manual test. */
  withoutTest: boolean;
  /**
   * referenced: a manual test or bug of the latest run of some audit names it.
   * not_referenced: audits have been imported with such information, and none of their latest runs names it.
   * no_audit: no audit run of this project says anything about requirements yet.
   */
  audit: "referenced" | "not_referenced" | "no_audit";
}

const LATEST = "latest AS (SELECT audit_id, MAX(id) AS import_id FROM audit_imports GROUP BY audit_id)";

/**
 * Requirement ids named by something the latest run of an audit contained, and whether any run could say that at all.
 * What the run named is what the agent's newest version of the item says (its latest revision), not the person's working copy, which may
 * be older. For a test a person has edited, their own links count as well.
 */
function latestRunReferences(projectId: number) {
  const named = new Set<string>();
  const addAll = (v: unknown) => { if (Array.isArray(v)) for (const x of v) if (typeof x === "string") named.add(x.trim().toLowerCase()); };
  const payloads = [
    ...(db.prepare(`
      WITH ${LATEST}
      SELECT rv.payload FROM bug_sightings s JOIN latest l ON l.import_id = s.audit_import_id JOIN bug_reports b ON b.id = s.bug_report_id
      JOIN bug_revisions rv ON rv.bug_report_id = b.id AND rv.rev = b.latest_rev WHERE b.project_id = ?`).all(projectId) as { payload: string }[]),
    ...(db.prepare(`
      WITH ${LATEST}
      SELECT rv.payload FROM manual_test_sightings s JOIN latest l ON l.import_id = s.audit_import_id JOIN manual_tests m ON m.id = s.manual_test_id
      JOIN manual_test_revisions rv ON rv.manual_test_id = m.id AND rv.rev = m.latest_rev WHERE m.project_id = ?`).all(projectId) as { payload: string }[]),
  ];
  for (const r of payloads) {
    try { addAll(JSON.parse(r.payload)?.refs?.requirements); } catch { /* an unreadable revision names nothing */ }
  }
  const handMade = db.prepare(`
    WITH ${LATEST}
    SELECT x.raw FROM manual_test_refs x JOIN manual_test_sightings s ON s.manual_test_id = x.manual_test_id JOIN latest l ON l.import_id = s.audit_import_id
    JOIN manual_tests m ON m.id = x.manual_test_id WHERE m.project_id = ? AND x.kind = 'requirement' AND m.edited_at IS NOT NULL`).all(projectId) as { raw: string }[];
  for (const r of handMade) named.add(r.raw.trim().toLowerCase());
  const referenced = new Set<number>();
  for (const q of db.prepare("SELECT id, number, external_id FROM requirements WHERE project_id = ?").all(projectId) as { id: number; number: number; external_id: string | null }[]) {
    if (named.has(`req-${q.number}`) || (q.external_id && named.has(q.external_id.toLowerCase()))) referenced.add(q.id);
  }
  const known = db.prepare(`
    WITH ${LATEST}
    SELECT 1 FROM latest l JOIN audits a ON a.id = l.audit_id JOIN audit_imports i ON i.id = l.import_id
    WHERE a.project_id = ? AND (i.sightings_recorded = 1 OR i.manual_listed = 1) LIMIT 1`).get(projectId);
  return { referenced, known: !!known };
}

export function requirementOverviews(projectId: number): Map<number, RequirementOverview> {
  const out = new Map<number, RequirementOverview>();
  const reqs = db.prepare("SELECT id FROM requirements WHERE project_id = ?").all(projectId) as { id: number }[];
  const get = (id: number) => out.get(id)!;
  for (const r of reqs) out.set(r.id, { manualTests: { accepted: 0, proposed: 0 }, bugs: { open: 0, proposed: 0 }, cases: 0, withoutTest: true, audit: "no_audit" });
  for (const r of db.prepare(`
      SELECT rc.requirement_id AS id, COUNT(*) AS n FROM requirement_cases rc JOIN cases c ON c.id = rc.case_id JOIN requirements q ON q.id = rc.requirement_id
      WHERE q.project_id = ? AND c.status != 'deprecated' GROUP BY rc.requirement_id`).all(projectId) as { id: number; n: number }[]) get(r.id).cases = r.n;
  for (const r of db.prepare(`
      SELECT x.requirement_id AS id, m.review_status AS s, COUNT(DISTINCT m.id) AS n FROM manual_test_refs x JOIN manual_tests m ON m.id = x.manual_test_id
      WHERE m.project_id = ? AND x.requirement_id IS NOT NULL AND m.review_status IN ('accepted', 'proposed') GROUP BY x.requirement_id, m.review_status`).all(projectId) as { id: number; s: "accepted" | "proposed"; n: number }[]) get(r.id).manualTests[r.s] = r.n;
  for (const r of db.prepare(`
      SELECT x.requirement_id AS id, b.review_status AS s, COUNT(DISTINCT b.id) AS n FROM bug_refs x JOIN bug_reports b ON b.id = x.bug_report_id
      WHERE b.project_id = ? AND x.requirement_id IS NOT NULL AND b.review_status IN ('accepted', 'proposed') GROUP BY x.requirement_id, b.review_status`).all(projectId) as { id: number; s: "accepted" | "proposed"; n: number }[]) {
    if (r.s === "accepted") get(r.id).bugs.open = r.n;
    else get(r.id).bugs.proposed = r.n;
  }
  const { referenced, known } = latestRunReferences(projectId);
  for (const [id, o] of out) {
    o.withoutTest = o.cases === 0 && o.manualTests.accepted === 0;
    o.audit = !known ? "no_audit" : referenced.has(id) ? "referenced" : "not_referenced";
  }
  return out;
}

/** The manual tests and bug reports that name one requirement, for its detail view. */
export function requirementLinks(requirementId: number) {
  const manualTests = db.prepare(`
    SELECT DISTINCT m.id, m.source_id AS sourceId, m.title, m.review_status AS status, m.category, COALESCE(m.human_priority, m.agent_priority) AS priority
    FROM manual_test_refs x JOIN manual_tests m ON m.id = x.manual_test_id WHERE x.requirement_id = ? ORDER BY m.id`).all(requirementId);
  const bugs = db.prepare(`
    SELECT DISTINCT b.id, b.source_id AS sourceId, b.title, b.review_status AS status, COALESCE(b.human_severity, b.agent_severity) AS severity
    FROM bug_refs x JOIN bug_reports b ON b.id = x.bug_report_id WHERE x.requirement_id = ? ORDER BY b.id`).all(requirementId);
  return { manualTests, bugs };
}

/** Headline numbers and the references to requirements that match nothing, with the reason. Deprecated requirements are left out of the numbers. */
export function requirementCoverage(projectId: number) {
  const overviews = requirementOverviews(projectId);
  const active = (db.prepare("SELECT id FROM requirements WHERE project_id = ? AND status = 'approved'").all(projectId) as { id: number }[]).map((r) => overviews.get(r.id)!);
  const unresolved = db.prepare(`
    SELECT 'bug' AS kind, b.id, b.title, x.raw, x.reason FROM bug_refs x JOIN bug_reports b ON b.id = x.bug_report_id
      WHERE b.project_id = ? AND x.kind = 'requirement' AND x.state != 'resolved'
    UNION ALL
    SELECT 'manual_test', m.id, m.title, x.raw, x.reason FROM manual_test_refs x JOIN manual_tests m ON m.id = x.manual_test_id
      WHERE m.project_id = ? AND x.kind = 'requirement' AND x.state != 'resolved'
    ORDER BY 1, 2`).all(projectId, projectId);
  return {
    summary: {
      active: active.length,
      withoutTest: active.filter((o) => o.withoutTest).length,
      withOpenBugs: active.filter((o) => o.bugs.open > 0).length,
      notInLatestRun: active.filter((o) => o.audit === "not_referenced").length,
      auditKnown: active.some((o) => o.audit !== "no_audit"),
    },
    unresolved,
  };
}
