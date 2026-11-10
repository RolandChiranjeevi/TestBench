import { db } from "./db.ts";
import { AuditError } from "./auditcommon.ts";
import { criteriaFromField, parseAcceptance, type Readiness } from "./acceptance.ts";
import { REQUIREMENT_KINDS } from "./requirements.ts";

/**
 * What a test agent reads with an agent token: the active requirements of one project, five fields each, and nothing else. It is a small projection
 * on purpose. It has no coverage, no links to bugs or tests and no descriptions: the login-protected export (agentexport.ts) is unchanged and still
 * has those. Whether a requirement is met is a person's decision, and nothing here says it is.
 */

export const AGENT_REQUIREMENTS_NOTE =
  "These are the active requirements of the project. readiness only says whether acceptance criteria were found in the description: it does not say that they are " +
  "measurable, and nothing here says that a requirement is met. Judge the criteria yourself, and mark a requirement needs-clarification when they cannot be measured.";

export interface AgentRequirement { requirement_id: string; title: string; source: string; readiness: Readiness; acceptance_criteria: string[] }

/** The only query parameters: `status` may only be "active" and `kind` one of the requirement kinds. Anything else is refused, not ignored. */
export function parseAgentQuery(query: unknown): { kind?: string } {
  const q = (query ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(q)) {
    if (k !== "status" && k !== "kind") throw new AuditError(400, `Unknown parameter "${k}". Only status=active and kind are accepted.`);
    if (typeof v !== "string") throw new AuditError(400, `${k} must be a single value`);
  }
  if (q.status !== undefined && q.status !== "active") throw new AuditError(400, "status must be active: an agent token only reads the active requirements");
  if (q.kind !== undefined && !(REQUIREMENT_KINDS as readonly string[]).includes(q.kind as string)) throw new AuditError(400, `kind must be one of ${REQUIREMENT_KINDS.join(", ")}`);
  return q.kind === undefined ? {} : { kind: q.kind as string };
}

export function agentRequirementsForToken(projectId: number, opts: { kind?: string } = {}) {
  const project = db.prepare("SELECT key FROM projects WHERE id = ?").get(projectId) as { key: string } | undefined;
  if (!project) throw new AuditError(404, "Project not found");
  const where = ["project_id = ?", "status = 'approved'"];
  const args: (string | number)[] = [projectId];
  if (opts.kind) { where.push("kind = ?"); args.push(opts.kind); }
  const rows = db.prepare(`SELECT number, external_id, title, description, acceptance_criteria, source FROM requirements WHERE ${where.join(" AND ")} ORDER BY number`).all(...args) as
    { number: number; external_id: string | null; title: string; description: string; acceptance_criteria: string; source: string }[];
  return {
    format: "testbench-agent-requirements" as const,
    version: 1 as const,
    project: project.key,
    generatedAt: new Date().toISOString(),
    filter: { status: "active" as const, ...(opts.kind ? { kind: opts.kind } : {}) },
    note: AGENT_REQUIREMENTS_NOTE,
    requirements: rows.map((r): AgentRequirement => {
      const { criteria, readiness } = r.acceptance_criteria.trim() ? criteriaFromField(r.acceptance_criteria) : parseAcceptance(r.description);
      return { requirement_id: r.external_id ?? `REQ-${r.number}`, title: r.title, source: r.source ?? "", readiness, acceptance_criteria: criteria };
    }),
  };
}
