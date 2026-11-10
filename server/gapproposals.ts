import { db } from "./db.ts";
import { coverageGaps } from "./coveragegaps.ts";
import { insertProposal } from "./reqproposals.ts";
import { RequirementError } from "./requirements.ts";

/**
 * Proposals from coverage gaps, made by fixed rules. There is no model behind this and no network: the same gaps always give the same proposals.
 *  - A rule turns one gap into a requirement proposal (title, description, acceptance criteria, why, priority, and a link to the gap). It goes into the ordinary
 *    proposal flow as `proposed`: nothing here makes or changes a requirement, and a person approves, edits or rejects it as usual.
 *  - One proposal per gap, ever: a gap that already has a proposal (even a rejected one) is skipped, so pressing the button twice makes no duplicates and a rejection
 *    is not argued with. `gap_key` (case:12, obs:7) is what remembers it.
 *  - An observation of severity info is information, not a risk (a positive finding such as "TLS 1.3 is enabled"): there is nothing to address, so it is skipped
 *    and not remembered; if its severity is raised later it is proposed then.
 *  - A requirement without a test case is not turned into a proposal: a test case proposal is another flow (agent audit packages). It is reported as not generated.
 *  - At most GAP_LIMIT proposals per run, so one click cannot flood the review queue.
 */

export const GAP_LIMIT = 50;
type Priority = "low" | "medium" | "high" | "critical";
type Kind = "functional" | "security_privacy";

export interface Draft {
  gapKey: string; /** what the person sees, such as SHOP-2 or OBS-3 */ label: string; rule: string; proposedBy: string; title: string; description: string; acceptanceCriteria: string; rationale: string;
  kind: Kind; suggestedPriority: Priority; caseIds: number[]; observationIds: number[];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const lines = (list: string[], max = 20) => [...new Set(list.map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, max).map((x) => clip(x, 500)).join("\n");
const SEVERITY_TO_PRIORITY: Record<string, Priority> = { critical: "critical", high: "high", medium: "medium", low: "low", info: "low" };

export interface CaseInput { id: number; number: number; title: string; description: string; priority: string; steps: { expected: string }[] }
export interface ObservationInput { id: number; number: number; kind: string; title: string; severity: string; metric: string | null; value: number | null; threshold: number | null; evidence: string; recommendation: string }

/** Rule: a test case that no requirement in use names. The proposal asks for the requirement behind it; its steps' expected results become the criteria. */
export function draftFromCase(c: CaseInput, projectKey: string): Draft {
  const key = `${projectKey}-${c.number}`;
  return {
    gapKey: `case:${c.id}`, label: key, rule: "test_without_requirement", proposedBy: "rule: test case without requirement",
    title: clip(`The system supports: ${c.title}`, 300),
    description: [`Test case ${key} “${c.title}” is not linked to any requirement in use, so nothing says why it matters. Write down what the system should do, so the test has something to prove.`, c.description.trim() && `The test case says: ${c.description.trim()}`].filter(Boolean).join("\n\n"),
    acceptanceCriteria: lines(c.steps.map((s) => s.expected)),
    rationale: `Test case ${key} has no requirement in use. (Rule: test case without requirement.)`,
    kind: "functional", suggestedPriority: SEVERITY_TO_PRIORITY[c.priority] ?? "medium", caseIds: [c.id], observationIds: [],
  };
}

/** Rule: an observation still being looked at that is linked to neither a requirement nor a test case. */
export function draftFromObservation(o: ObservationInput): Draft {
  const label = `OBS-${o.number}`;
  const load = o.kind === "load_test";
  const measured = load && o.metric ? `${o.metric} meets the threshold of ${o.threshold}` : "";
  return {
    gapKey: `obs:${o.id}`, label, rule: "observation_without_link", proposedBy: "rule: observation without link",
    title: clip(load && o.metric ? `${o.title}: ${o.metric} meets the threshold of ${o.threshold}` : `Address: ${o.title}`, 300),
    description: [
      `${load ? "Load test" : "Security review"} finding ${label}: ${o.title}.`,
      load && o.metric ? `Measured ${o.metric} = ${o.value}, threshold ${o.threshold}.` : "",
      o.evidence.trim(),
    ].filter(Boolean).join("\n\n"),
    acceptanceCriteria: lines([measured, o.recommendation]),
    rationale: `Observation ${label} is not linked to any requirement or test case. (Rule: observation without link.)`,
    kind: load ? "functional" : "security_privacy", suggestedPriority: SEVERITY_TO_PRIORITY[o.severity] ?? "medium", caseIds: [], observationIds: [o.id],
  };
}

export interface GenerateResult {
  dryRun: boolean;
  counts: { created: number; skipped: number; notGenerated: number; more: number };
  /** What was made (ids), or in a dry run what would be made (id null). */
  created: { id: number | null; gap: string; rule: string; title: string }[];
  skipped: { gap: string; label: string; reason: string }[];
  notGenerated: { gap: string; label: string; title: string; reason: string }[];
}

const NOT_GENERATED = "Needs a test case (not generated: test case proposals are a separate flow). Link an existing test case, or write one.";

export function generateProposals(projectId: number, opts: { dryRun?: boolean } = {}): GenerateResult {
  const project = db.prepare("SELECT key FROM projects WHERE id = ?").get(projectId) as { key: string } | undefined;
  if (!project) throw new RequirementError(404, "Project not found");
  const gaps = coverageGaps(projectId);

  const drafts: Draft[] = [];
  const informational: GenerateResult["skipped"] = [];
  const caseIds = gaps.casesWithoutRequirement.map((c) => c.id);
  if (caseIds.length) {
    const marks = caseIds.map(() => "?").join(",");
    const rows = db.prepare(`SELECT id, number, title, description, priority FROM cases WHERE project_id = ? AND id IN (${marks}) ORDER BY number`).all(projectId, ...caseIds) as Omit<CaseInput, "steps">[];
    const steps = db.prepare(`SELECT case_id, expected FROM case_steps WHERE case_id IN (${marks}) ORDER BY case_id, position`).all(...caseIds) as { case_id: number; expected: string }[];
    for (const c of rows) drafts.push(draftFromCase({ ...c, steps: steps.filter((s) => s.case_id === c.id) }, project.key));
  }
  const obsIds = gaps.observationsWithoutLink.map((o) => o.id);
  if (obsIds.length) {
    const marks = obsIds.map(() => "?").join(",");
    const rows = db.prepare(`SELECT id, number, kind, title, severity, metric, value, threshold, evidence, recommendation FROM observations WHERE project_id = ? AND id IN (${marks})`).all(projectId, ...obsIds) as ObservationInput[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const g of gaps.observationsWithoutLink) {
      if (g.severity === "info") informational.push({ gap: `obs:${g.id}`, label: g.label, reason: "Informational (severity info): there is nothing to address" });
      else drafts.push(draftFromObservation(byId.get(g.id)!)); // the gap list's order: most severe first
    }
  }

  const existing = new Map((db.prepare("SELECT gap_key, status FROM requirement_proposals WHERE project_id = ? AND gap_key != ''").all(projectId) as { gap_key: string; status: string }[]).map((r) => [r.gap_key, r.status]));
  const skipped: GenerateResult["skipped"] = [...informational];
  const fresh: Draft[] = [];
  for (const d of drafts) {
    const had = existing.get(d.gapKey);
    if (had) skipped.push({ gap: d.gapKey, label: d.label, reason: had === "rejected" ? "A proposal for it was rejected earlier" : had === "approved" ? "A proposal for it was approved" : "It already has a proposal waiting for review" });
    else fresh.push(d);
  }
  const make = fresh.slice(0, GAP_LIMIT);
  const created: GenerateResult["created"] = make.map((d) => ({ id: null, gap: d.gapKey, rule: d.rule, title: d.title }));
  if (!opts.dryRun) {
    db.transaction(() => {
      make.forEach((d, i) => {
        const id = insertProposal(projectId, { title: d.title, description: d.description, acceptanceCriteria: d.acceptanceCriteria, rationale: d.rationale, kind: d.kind, suggestedPriority: d.suggestedPriority, basis: "coverage_gap" }, d.proposedBy, d.gapKey);
        for (const c of d.caseIds) db.prepare("INSERT OR IGNORE INTO proposal_cases (proposal_id, case_id) VALUES (?, ?)").run(id, c);
        for (const o of d.observationIds) db.prepare("INSERT OR IGNORE INTO proposal_observations (proposal_id, observation_id) VALUES (?, ?)").run(id, o);
        created[i].id = id;
      });
    })();
  }
  const notGenerated = gaps.requirementsWithoutCases.map((r) => ({ gap: `req:${r.id}`, label: `REQ-${r.number}`, title: r.title, reason: NOT_GENERATED }));
  return { dryRun: !!opts.dryRun, counts: { created: created.length, skipped: skipped.length, notGenerated: notGenerated.length, more: fresh.length - make.length }, created, skipped, notGenerated };
}
