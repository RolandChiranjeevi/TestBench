import { z } from "zod";
import { db, parseJson } from "./db.ts";
import { actorName, actorUserId } from "./actor.ts";
import { createRequirement, recordRevision, REQUIREMENT_KINDS, RequirementError, setRequirementCases } from "./requirements.ts";

/**
 * Requirement proposals: what a test agent suggests, kept apart from the requirements until a person decides.
 *  - A proposal is a row of its own. It is never in the requirements table, so it cannot show in the requirement list, in coverage or in what an agent reads, and it
 *    cannot change a requirement. Only approving it makes a requirement (origin ai_suggestion, approved by the person who approved it).
 *  - Only a person approves, rejects or edits. Rejecting needs a reason and the proposal is kept, for traceability. A decided proposal is final.
 *  - A person's edit before approving is recorded: the proposal as the agent made it stays in `original`.
 *  - Who decided is the display name from Settings, as typed and not verified (see actor.ts).
 */

export const PROPOSAL_STATUSES = ["proposed", "approved", "rejected"] as const;
export const PROPOSAL_BASES = ["observation", "coverage_gap", "prompt", "other"] as const;
const PRIORITIES = ["low", "medium", "high", "critical"] as const;
export const PROPOSAL_LIMITS = { batch: 20, title: 300, text: 20000, rationale: 4000, refs: 50, reason: 2000, nameMax: 80 };
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

const shape = {
  title: z.string().trim().min(1).max(PROPOSAL_LIMITS.title),
  description: z.string().max(PROPOSAL_LIMITS.text),
  acceptanceCriteria: z.string().max(PROPOSAL_LIMITS.text),
  rationale: z.string().max(PROPOSAL_LIMITS.rationale),
  kind: z.enum(REQUIREMENT_KINDS),
  suggestedPriority: z.enum(PRIORITIES),
  basis: z.enum(PROPOSAL_BASES),
};
const ref = z.string().trim().min(1).max(40);
/** What an agent sends. The observations are named as OBS-3 and the cases as SHOP-12; what does not match something of this project is reported, not linked. */
const NewSchema = z.object({
  title: shape.title, description: shape.description.default(""), acceptanceCriteria: shape.acceptanceCriteria.default(""), rationale: shape.rationale.default(""),
  kind: shape.kind.default("functional"), suggestedPriority: shape.suggestedPriority.default("medium"), basis: shape.basis.default("other"),
  observations: z.array(ref).max(PROPOSAL_LIMITS.refs).default([]), cases: z.array(ref).max(PROPOSAL_LIMITS.refs).default([]),
}).strict();
/** What a person may change before approving. The links and the agent's name are not editable. */
const EditSchema = z.object(shape).partial().strict();

interface Row {
  id: number; project_id: number; title: string; description: string; acceptance_criteria: string; rationale: string; kind: string; suggested_priority: string; basis: string;
  status: ProposalStatus; reject_reason: string; proposed_by: string; decided_by: string; decided_at: string | null; resulting_requirement_id: number | null;
  original: string; edited: number; created_at: string; updated_at: string;
}

const projectKey = (projectId: number) => (db.prepare("SELECT key FROM projects WHERE id = ?").get(projectId) as { key: string } | undefined)?.key;

/** The one place a proposal row is made: by an agent (createProposals) or by a rule (gapproposals.ts). It starts as `proposed`; the agent's version is kept in `original`. */
export function insertProposal(
  projectId: number,
  x: { title: string; description: string; acceptanceCriteria: string; rationale: string; kind: string; suggestedPriority: string; basis: string },
  proposedBy: string, gapKey = "",
): number {
  const original = JSON.stringify({ title: x.title, description: x.description, acceptanceCriteria: x.acceptanceCriteria, rationale: x.rationale, kind: x.kind, suggestedPriority: x.suggestedPriority, basis: x.basis });
  return (db.prepare(`INSERT INTO requirement_proposals (project_id, title, description, acceptance_criteria, rationale, kind, suggested_priority, basis, proposed_by, original, gap_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(projectId, x.title, x.description, x.acceptanceCriteria, x.rationale, x.kind, x.suggestedPriority, x.basis, proposedBy, original, gapKey) as { id: number }).id;
}

/** Validates the whole batch first; if anything is wrong nothing is made. `proposedBy` is the agent's name from its token. */
export function createProposals(projectId: number, body: unknown, proposedBy: string) {
  const key = projectKey(projectId);
  if (!key) throw new RequirementError(404, "Project not found");
  const list = Array.isArray(body) ? body : [body];
  if (!list.length) throw new RequirementError(400, "There is no proposal in the request");
  if (list.length > PROPOSAL_LIMITS.batch) throw new RequirementError(400, `At most ${PROPOSAL_LIMITS.batch} proposals at a time`);
  const problems: string[] = [];
  const items = list.flatMap((raw, i) => {
    const p = NewSchema.safeParse(raw);
    if (p.success) return [p.data];
    problems.push(...p.error.issues.map((x) => `#${i + 1}: ${x.path.join(".") || "proposal"}: ${x.message}`));
    return [];
  });
  if (problems.length) throw new RequirementError(400, `Nothing was made: ${problems.length} problem${problems.length === 1 ? "" : "s"} in the request`, problems);

  const unresolved: { proposal: number; ref: string; reason: string }[] = [];
  const created: { id: number }[] = [];
  db.transaction(() => {
    items.forEach((x, i) => {
      const id = insertProposal(projectId, x, proposedBy);
      created.push({ id });
      for (const r of [...new Set(x.observations)]) {
        const m = /^OBS-(\d+)$/i.exec(r);
        const o = m ? (db.prepare("SELECT id FROM observations WHERE project_id = ? AND number = ?").get(projectId, Number(m[1])) as { id: number } | undefined) : undefined;
        if (o) db.prepare("INSERT OR IGNORE INTO proposal_observations (proposal_id, observation_id) VALUES (?, ?)").run(id, o.id);
        else unresolved.push({ proposal: i + 1, ref: r, reason: m ? "no such observation in this project" : "not an observation reference such as OBS-3" });
      }
      for (const r of [...new Set(x.cases)]) {
        const m = /^([A-Za-z0-9]+)-(\d+)$/.exec(r);
        const c = m && m[1].toUpperCase() === key.toUpperCase() ? (db.prepare("SELECT id FROM cases WHERE project_id = ? AND number = ?").get(projectId, Number(m[2])) as { id: number } | undefined) : undefined;
        if (c) db.prepare("INSERT OR IGNORE INTO proposal_cases (proposal_id, case_id) VALUES (?, ?)").run(id, c.id);
        else unresolved.push({ proposal: i + 1, ref: r, reason: m ? (m[1].toUpperCase() === key.toUpperCase() ? "no such test case in this project" : "a test case of another project") : "not a test case reference such as SHOP-12" });
      }
    });
  })();
  return { created, unresolved };
}

const views = (rows: Row[]) => {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const obs = db.prepare(`SELECT po.proposal_id, o.id, o.number, o.title FROM proposal_observations po JOIN observations o ON o.id = po.observation_id WHERE po.proposal_id IN (${marks}) ORDER BY o.number`).all(...ids) as { proposal_id: number; id: number; number: number; title: string }[];
  const cases = db.prepare(`SELECT pc.proposal_id, c.id, c.number, c.title FROM proposal_cases pc JOIN cases c ON c.id = pc.case_id WHERE pc.proposal_id IN (${marks}) ORDER BY c.number`).all(...ids) as { proposal_id: number; id: number; number: number; title: string }[];
  const reqNumber = new Map((db.prepare(`SELECT id, number FROM requirements WHERE id IN (${rows.map((r) => r.resulting_requirement_id).filter((x) => x != null).concat([-1]).map(() => "?").join(",")})`)
    .all(...rows.map((r) => r.resulting_requirement_id).filter((x) => x != null), -1) as { id: number; number: number }[]).map((r) => [r.id, r.number]));
  return rows.map((r) => ({
    id: r.id, projectId: r.project_id, title: r.title, description: r.description, acceptanceCriteria: r.acceptance_criteria, rationale: r.rationale, kind: r.kind,
    suggestedPriority: r.suggested_priority, basis: r.basis, status: r.status, rejectReason: r.reject_reason, proposedBy: r.proposed_by, decidedBy: r.decided_by, decidedAt: r.decided_at,
    requirementId: r.resulting_requirement_id, requirementLabel: r.resulting_requirement_id != null && reqNumber.has(r.resulting_requirement_id) ? `REQ-${reqNumber.get(r.resulting_requirement_id)}` : null,
    edited: !!r.edited, original: parseJson<Record<string, unknown>>(r.original, {}), createdAt: r.created_at, updatedAt: r.updated_at,
    observations: obs.filter((o) => o.proposal_id === r.id).map((o) => ({ id: o.id, label: `OBS-${o.number}`, title: o.title })),
    cases: cases.filter((c) => c.proposal_id === r.id).map((c) => ({ id: c.id, number: c.number, title: c.title })),
  }));
};

export function listProposals(projectId: number, status?: string) {
  if (!projectKey(projectId)) throw new RequirementError(404, "Project not found");
  if (status && !(PROPOSAL_STATUSES as readonly string[]).includes(status)) throw new RequirementError(400, `Unknown status "${status}". Use one of: ${PROPOSAL_STATUSES.join(", ")}`);
  const rows = db.prepare(`SELECT * FROM requirement_proposals WHERE project_id = ?${status ? " AND status = ?" : ""} ORDER BY (status = 'proposed') DESC, id DESC`).all(...(status ? [projectId, status] : [projectId])) as Row[];
  const got = new Map((db.prepare("SELECT status AS k, COUNT(*) AS n FROM requirement_proposals WHERE project_id = ? GROUP BY status").all(projectId) as { k: string; n: number }[]).map((r) => [r.k, r.n]));
  return { counts: Object.fromEntries(PROPOSAL_STATUSES.map((s) => [s, got.get(s) ?? 0])) as Record<ProposalStatus, number>, items: views(rows) };
}

export function getProposal(id: number) {
  return views(db.prepare("SELECT * FROM requirement_proposals WHERE id = ?").all(id) as Row[])[0];
}

function openProposal(id: number): Row {
  const row = db.prepare("SELECT * FROM requirement_proposals WHERE id = ?").get(id) as Row | undefined;
  if (!row) throw new RequirementError(404, "Proposal not found");
  if (row.status !== "proposed") throw new RequirementError(409, `This proposal is already ${row.status}. A decided proposal cannot be changed.`);
  return row;
}

/** A person's edit before approving. The proposal as the agent made it stays in `original`. */
export function editProposal(id: number, body: unknown) {
  const row = openProposal(id);
  const p = EditSchema.safeParse(body);
  if (!p.success) throw new RequirementError(400, "The edit is not valid", p.error.issues.map((x) => `${x.path.join(".") || "edit"}: ${x.message}`));
  const x = p.data;
  const next = { title: x.title ?? row.title, description: x.description ?? row.description, acceptance_criteria: x.acceptanceCriteria ?? row.acceptance_criteria, rationale: x.rationale ?? row.rationale,
    kind: x.kind ?? row.kind, suggested_priority: x.suggestedPriority ?? row.suggested_priority, basis: x.basis ?? row.basis };
  const changed = (Object.keys(next) as (keyof typeof next)[]).some((k) => next[k] !== row[k]);
  if (changed) {
    db.prepare("UPDATE requirement_proposals SET title = ?, description = ?, acceptance_criteria = ?, rationale = ?, kind = ?, suggested_priority = ?, basis = ?, edited = 1, updated_at = datetime('now') WHERE id = ?")
      .run(next.title, next.description, next.acceptance_criteria, next.rationale, next.kind, next.suggested_priority, next.basis, id);
  }
  return getProposal(id)!;
}

/** Only a person calls this. It makes the requirement (origin ai_suggestion, approved by the current person) and links the proposal's test cases. */
export function approveProposal(id: number) {
  return db.transaction(() => {
    const row = openProposal(id);
    const me = actorName();
    const requirementId = createRequirement(row.project_id, {
      title: row.title, description: row.description, acceptanceCriteria: row.acceptance_criteria, priority: row.suggested_priority, kind: row.kind,
      status: "approved", origin: "ai_suggestion", createdBy: row.proposed_by || "agent", approvedBy: me,
    });
    const caseIds = (db.prepare("SELECT case_id FROM proposal_cases WHERE proposal_id = ?").all(id) as { case_id: number }[]).map((c) => c.case_id);
    if (caseIds.length) setRequirementCases(requirementId, row.project_id, caseIds);
    // A person approved it: the observations it was about are now linked to the requirement, which takes them off the coverage gap list.
    for (const o of db.prepare("SELECT observation_id FROM proposal_observations WHERE proposal_id = ?").all(id) as { observation_id: number }[]) {
      db.prepare("INSERT OR IGNORE INTO observation_requirements (observation_id, requirement_id) VALUES (?, ?)").run(o.observation_id, requirementId);
    }
    if (row.rationale.trim()) recordRevision(requirementId, [{ field: "why it was proposed", to: row.rationale }], false, row.proposed_by || "agent");
    db.prepare("UPDATE requirement_proposals SET status = 'approved', decided_by = ?, decided_by_user_id = ?, decided_at = datetime('now'), resulting_requirement_id = ?, updated_at = datetime('now') WHERE id = ?").run(me, actorUserId(), requirementId, id);
    return { proposal: getProposal(id)!, requirementId };
  })();
}

/** Kept with its reason, for traceability. */
export function rejectProposal(id: number, reason: unknown) {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text.length < 3) throw new RequirementError(400, "A reason is needed to reject a proposal (at least 3 characters)");
  if (text.length > PROPOSAL_LIMITS.reason) throw new RequirementError(400, `The reason can be at most ${PROPOSAL_LIMITS.reason} characters`);
  openProposal(id);
  db.prepare("UPDATE requirement_proposals SET status = 'rejected', reject_reason = ?, decided_by = ?, decided_by_user_id = ?, decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(text, actorName(), actorUserId(), id);
  return getProposal(id)!;
}
