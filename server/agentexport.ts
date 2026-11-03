import { db } from "./db.ts";
import { parseJson } from "./db.ts";
import { requirementOverviews } from "./reqlinks.ts";
import type { Viewport } from "./shapes.ts";
import { AuditError } from "./auditcommon.ts";

/**
 * The requirements of a project as a test agent reads them: what to test against, what is already covered, and nothing that says a
 * requirement is met. Whether a requirement is fulfilled is a person's decision in Testbench; this export is read-only and the agent has
 * no way to set it. The shape is the same as the requirement import file, so an exported file can be edited and imported again.
 */

const EXPORT_STATUS: Record<string, "active" | "draft" | "retired"> = { approved: "active", draft: "draft", deprecated: "retired" };
const SELECT: Record<string, string[]> = { active: ["approved"], draft: ["draft"], retired: ["deprecated"], all: ["approved", "draft", "deprecated"] };

export const AGENT_NOTE =
  "These requirements are the basis for what to test. Use them to choose and prioritise test cases, and propose manual tests (manual-tests.json, refs.requirements) " +
  "for a requirement that has no coverage. Whether a requirement is met is decided by a person in Testbench: nothing here says a requirement is fulfilled, and you must not claim it is.";

export function agentRequirements(projectId: number, opts: { status?: string; kind?: string } = {}) {
  const project = db.prepare("SELECT id, key, name FROM projects WHERE id = ?").get(projectId) as { id: number; key: string; name: string } | undefined;
  if (!project) throw new AuditError(404, "Project not found");
  const status = opts.status ?? "active";
  const statuses = SELECT[status];
  if (!statuses) throw new AuditError(400, `status must be one of ${Object.keys(SELECT).join(", ")}`);
  const where = [`project_id = ?`, `status IN (${statuses.map(() => "?").join(",")})`];
  const args: (string | number)[] = [projectId, ...statuses];
  if (opts.kind) { where.push("kind = ?"); args.push(opts.kind); }
  const rows = db.prepare(`SELECT * FROM requirements WHERE ${where.join(" AND ")} ORDER BY number`).all(...args) as Record<string, any>[];
  const overviews = requirementOverviews(projectId);
  const caseKeys = new Map((db.prepare("SELECT rc.requirement_id AS rid, c.number FROM requirement_cases rc JOIN cases c ON c.id = rc.case_id WHERE c.project_id = ? AND c.status != 'deprecated' ORDER BY c.number").all(projectId) as { rid: number; number: number }[]).reduce((m, r) => m.set(r.rid, [...(m.get(r.rid) ?? []), `${project.key}-${r.number}`]), new Map<number, string[]>()));
  const linkedTests = db.prepare(`SELECT x.requirement_id AS rid, m.source_id AS sourceId, m.title, m.review_status AS status, (SELECT p.key || '-' || c.number FROM cases c JOIN projects p ON p.id = c.project_id WHERE c.id = m.case_id) AS testCase FROM manual_test_refs x JOIN manual_tests m ON m.id = x.manual_test_id WHERE m.project_id = ? AND x.requirement_id IS NOT NULL AND m.review_status != 'rejected' ORDER BY m.id`).all(projectId) as { rid: number; sourceId: string; title: string; status: string; testCase: string | null }[];
  const linkedBugs = db.prepare(`SELECT x.requirement_id AS rid, b.id, b.title, b.review_status AS status FROM bug_refs x JOIN bug_reports b ON b.id = x.bug_report_id WHERE b.project_id = ? AND x.requirement_id IS NOT NULL AND b.review_status IN ('accepted', 'proposed') ORDER BY b.id`).all(projectId) as { rid: number; id: number; title: string; status: string }[];
  return {
    format: "testbench-requirements" as const,
    version: 1 as const,
    project: project.key,
    projectName: project.name,
    generatedAt: new Date().toISOString(),
    filter: { status, ...(opts.kind ? { kind: opts.kind } : {}) },
    note: AGENT_NOTE,
    requirements: rows.map((r) => {
      const o = overviews.get(r.id)!;
      const source = String(r.source ?? "");
      return {
        id: r.external_id ?? `REQ-${r.number}`,
        ref: `REQ-${r.number}`,
        title: r.title,
        description: r.description,
        kind: r.kind,
        priority: r.priority,
        status: EXPORT_STATUS[r.status],
        source,
        sourceUrl: /^https?:\/\//i.test(source) ? source : null,
        wcag: parseJson<string[]>(r.wcag, []),
        viewports: parseJson<Viewport[]>(r.viewports, []),
        updatedAt: r.updated_at,
        // Counts of what people have decided, plus what the agent itself has proposed. Not a verdict: there is no "met" in this export.
        coverage: {
          testCases: o.cases, manualTestsAccepted: o.manualTests.accepted, manualTestsProposed: o.manualTests.proposed,
          openBugs: o.bugs.open, proposedBugs: o.bugs.proposed, hasTest: !o.withoutTest, notReferencedInLatestAuditRun: o.audit === "not_referenced",
        },
        links: {
          testCases: caseKeys.get(r.id) ?? [],
          manualTests: linkedTests.filter((t) => t.rid === r.id).map(({ rid: _r, ...t }) => t),
          bugs: linkedBugs.filter((b) => b.rid === r.id).map(({ rid: _r, ...b }) => b),
        },
      };
    }),
  };
}
