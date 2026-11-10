import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db } from "../server/db.ts";
import { makeCase, makeProject } from "./helpers.ts";
import { setDisplayName } from "../server/actor.ts";
import { createRequirement, getRequirement, listRequirements, RequirementError, setRequirementCases } from "../server/requirements.ts";
import { approveProposal, createProposals, getProposal, listProposals, rejectProposal } from "../server/reqproposals.ts";
import { coverageGaps } from "../server/coveragegaps.ts";
import { archiveObservation } from "../server/observations.ts";
import { draftFromCase, draftFromObservation, GAP_LIMIT, generateProposals } from "../server/gapproposals.ts";

// Proposals made by fixed rules from the coverage gaps. No model and no network; the same gaps always give the same proposals. Throwaway data folder (see env.ts).

let n = 0;
const proj = () => makeProject(`GP${++n}`, `Gap proposals ${n}`);
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
const caseWith = (p: { id: number }, title: string, o: { steps?: [string, string][]; priority?: string; description?: string } = {}) => {
  const c = makeCase(p.id, title, { steps: o.steps });
  if (o.priority || o.description !== undefined) db.prepare("UPDATE cases SET priority = COALESCE(?, priority), description = COALESCE(?, description) WHERE id = ?").run(o.priority ?? null, o.description ?? null, c.id);
  return c;
};
const obs = (p: { id: number }, number: number, o: { kind?: string; severity?: string; status?: string; metric?: string; value?: number; threshold?: number; evidence?: string; recommendation?: string } = {}) =>
  (db.prepare(`INSERT INTO observations (project_id, number, source_id, origin_audit_id, kind, title, severity, status, metric, value, threshold, evidence, recommendation, content_hash)
    VALUES (?, ?, ?, 'a1', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'h') RETURNING id`)
    .get(p.id, number, `S-${number}`, o.kind ?? "security_review", `Finding ${number}`, o.severity ?? "high", o.status ?? "observed", o.metric ?? null, o.value ?? null, o.threshold ?? null, o.evidence ?? "", o.recommendation ?? "") as { id: number }).id;
const fails = (fn: () => unknown, status: number, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof RequirementError && e.status === status && re.test(e.message));
const caseIn = (id: number, over: Partial<Parameters<typeof draftFromCase>[0]> = {}) => ({ id, number: 2, title: "Search by name", description: "", priority: "medium", steps: [], ...over });
const obsIn = (over: Partial<Parameters<typeof draftFromObservation>[0]> = {}) => ({ id: 7, number: 3, kind: "security_review", title: "Missing CSP header", severity: "high", metric: null, value: null, threshold: null, evidence: "", recommendation: "", ...over });

describe("the rule for a test case without a requirement", () => {
  it("asks for the requirement behind it, with the steps' expected results as criteria and the case's own priority", () => {
    const d = draftFromCase(caseIn(12, { priority: "high", description: "Typing finds products", steps: [{ expected: "The list shows matches" }, { expected: "" }, { expected: "The list shows matches" }, { expected: "No match says so" }] }), "SHOP");
    assert.equal(d.title, "The system supports: Search by name");
    assert.match(d.description, /Test case SHOP-2 “Search by name” is not linked to any requirement in use/);
    assert.match(d.description, /The test case says: Typing finds products/);
    assert.equal(d.acceptanceCriteria, "The list shows matches\nNo match says so");
    assert.deepEqual([d.suggestedPriority, d.kind, d.gapKey, d.label, d.proposedBy, d.caseIds, d.observationIds], ["high", "functional", "case:12", "SHOP-2", "rule: test case without requirement", [12], []]);
    assert.match(d.rationale, /SHOP-2 has no requirement in use/);
  });

  it("has no criteria when the case has no expected results, falls back to medium for an unknown priority, and keeps the title within its limit", () => {
    assert.equal(draftFromCase(caseIn(1), "SHOP").acceptanceCriteria, "");
    assert.equal(draftFromCase(caseIn(1, { priority: "urgent" }), "SHOP").suggestedPriority, "medium");
    assert.equal(draftFromCase(caseIn(1, { title: "x".repeat(400) }), "SHOP").title.length, 300);
    assert.ok(draftFromCase(caseIn(1, { description: "  " }), "SHOP").description.indexOf("The test case says") === -1);
  });
});

describe("the rule for an observation without a link", () => {
  it("a security finding asks to address it, with the recommendation as the criterion and a priority from its severity", () => {
    const d = draftFromObservation(obsIn({ evidence: "Header absent in every response", recommendation: "Add a Content-Security-Policy header" }));
    assert.equal(d.title, "Address: Missing CSP header");
    assert.match(d.description, /Security review finding OBS-3: Missing CSP header\./);
    assert.match(d.description, /Header absent in every response/);
    assert.equal(d.acceptanceCriteria, "Add a Content-Security-Policy header");
    assert.deepEqual([d.kind, d.suggestedPriority, d.gapKey, d.label, d.proposedBy, d.observationIds, d.caseIds], ["security_privacy", "high", "obs:7", "OBS-3", "rule: observation without link", [7], []]);
    assert.match(d.rationale, /OBS-3 is not linked to any requirement or test case/);
  });

  it("a load test finding names the metric and its threshold, without saying which way the threshold points", () => {
    const d = draftFromObservation(obsIn({ kind: "load_test", title: "p95 latency on checkout", metric: "p95_ms", value: 840, threshold: 500, recommendation: "Add an index" }));
    assert.equal(d.title, "p95 latency on checkout: p95_ms meets the threshold of 500");
    assert.match(d.description, /Load test finding OBS-3: p95 latency on checkout\./);
    assert.match(d.description, /Measured p95_ms = 840, threshold 500\./);
    assert.equal(d.acceptanceCriteria, "p95_ms meets the threshold of 500\nAdd an index");
    assert.equal(d.kind, "functional");
  });

  it("maps severity to priority: critical, high and medium stay, low and info become low", () => {
    const p = (severity: string) => draftFromObservation(obsIn({ severity })).suggestedPriority;
    assert.deepEqual(["critical", "high", "medium", "low", "info", "odd"].map(p), ["critical", "high", "medium", "low", "low", "medium"]);
  });

  it("is deterministic: the same input gives the same draft", () => {
    assert.deepEqual(draftFromObservation(obsIn({ recommendation: "Fix it" })), draftFromObservation(obsIn({ recommendation: "Fix it" })));
    assert.deepEqual(draftFromCase(caseIn(1, { steps: [{ expected: "a" }] }), "K"), draftFromCase(caseIn(1, { steps: [{ expected: "a" }] }), "K"));
  });
});

describe("generating proposals from the gaps", () => {
  it("makes proposals as `proposed`, apart from the requirements, linked to the gap and made by a rule", () => {
    setDisplayName("Anna Berg");
    const p = proj();
    const c = caseWith(p, "Search by name", { steps: [["Type a name", "The list shows matches"]], priority: "high" });
    const o = obs(p, 1, { severity: "critical", recommendation: "Add a CSP" });
    const r = generateProposals(p.id);
    assert.deepEqual(r.counts, { created: 2, skipped: 0, notGenerated: 0, more: 0 });
    assert.deepEqual(r.created.map((x) => x.gap).sort(), [`case:${c.id}`, `obs:${o}`]);
    const list = listProposals(p.id);
    assert.deepEqual(list.counts, { proposed: 2, approved: 0, rejected: 0 });
    const byCase = list.items.find((x) => x.cases.length)!;
    const byObs = list.items.find((x) => x.observations.length)!;
    assert.deepEqual([byCase.status, byCase.proposedBy, byCase.basis, byCase.suggestedPriority, byCase.acceptanceCriteria, byCase.cases[0].id], ["proposed", "rule: test case without requirement", "coverage_gap", "high", "The list shows matches", c.id]);
    assert.deepEqual([byObs.status, byObs.proposedBy, byObs.suggestedPriority, byObs.kind, byObs.observations[0].label], ["proposed", "rule: observation without link", "critical", "security_privacy", "OBS-1"]);
    assert.equal(listRequirements(p.id).length, 0, "a proposal is not a requirement");
    assert.equal(count("SELECT COUNT(*) AS n FROM requirement_proposals WHERE project_id = ? AND gap_key != ''", p.id), 2);
  });

  it("a dry run says what would be made and writes nothing", () => {
    const p = proj();
    caseWith(p, "A case"); obs(p, 1);
    const dry = generateProposals(p.id, { dryRun: true });
    assert.deepEqual([dry.dryRun, dry.counts.created, dry.created.every((x) => x.id === null)], [true, 2, true]);
    assert.equal(count("SELECT COUNT(*) AS n FROM requirement_proposals WHERE project_id = ?", p.id), 0);
    const real = generateProposals(p.id);
    assert.deepEqual(real.created.map((x) => x.title), dry.created.map((x) => x.title));
    assert.ok(real.created.every((x) => typeof x.id === "number"));
  });

  it("a second run makes no duplicates: a gap that already has a proposal is skipped, and says why", () => {
    const p = proj();
    caseWith(p, "A case"); obs(p, 1);
    generateProposals(p.id);
    const again = generateProposals(p.id);
    assert.deepEqual(again.counts, { created: 0, skipped: 2, notGenerated: 0, more: 0 });
    assert.ok(again.skipped.every((s) => /already has a proposal waiting for review/.test(s.reason)));
    assert.deepEqual(again.skipped.map((s) => s.label).sort(), [`${p.key}-1`, "OBS-1"]);
    assert.equal(count("SELECT COUNT(*) AS n FROM requirement_proposals WHERE project_id = ?", p.id), 2);
  });

  it("an observation of severity info is information, not a risk: it is skipped with a reason, and proposed once its severity is raised", () => {
    const p = proj();
    const o = obs(p, 1, { severity: "info", evidence: "TLS 1.3 is enabled" });
    obs(p, 2, { severity: "low" });
    const r = generateProposals(p.id);
    assert.deepEqual([r.counts.created, r.counts.skipped, r.skipped[0].gap, r.skipped[0].label, r.skipped[0].reason], [1, 1, `obs:${o}`, "OBS-1", "Informational (severity info): there is nothing to address"]);
    assert.equal(count("SELECT COUNT(*) AS n FROM requirement_proposals WHERE gap_key = ?", `obs:${o}`), 0, "it is not remembered");
    db.prepare("UPDATE observations SET severity = 'medium' WHERE id = ?").run(o);
    assert.equal(generateProposals(p.id).counts.created, 1);
  });

  it("a rejected proposal is not made again for the same gap", () => {
    const p = proj();
    const c = caseWith(p, "A case");
    const id = generateProposals(p.id).created[0].id!;
    rejectProposal(id, "Covered by REQ-9");
    const again = generateProposals(p.id);
    assert.deepEqual([again.counts.created, again.skipped[0].gap, again.skipped[0].reason], [0, `case:${c.id}`, "A proposal for it was rejected earlier"]);
    assert.equal(getProposal(id)!.status, "rejected");
  });

  it("approving the proposal for a test case makes an AI-suggested requirement, links the case, and closes the gap", () => {
    setDisplayName("Anna Berg");
    const p = proj();
    const c = caseWith(p, "Search by name", { steps: [["Type", "Matches are listed"]] });
    const id = generateProposals(p.id).created[0].id!;
    const { requirementId } = approveProposal(id);
    const r = getRequirement(requirementId)!;
    assert.deepEqual([r.origin, r.status, r.created_by, r.approved_by, r.acceptance_criteria, r.cases.map((x) => x.id)], ["ai_suggestion", "approved", "rule: test case without requirement", "Anna Berg", "Matches are listed", [c.id]]);
    assert.equal(coverageGaps(p.id).counts.casesWithoutRequirement, 0);
    assert.equal(generateProposals(p.id).counts.created, 0);
  });

  it("approving the proposal for an observation links the observation to the new requirement, so it leaves the gap list", () => {
    setDisplayName("Anna Berg");
    const p = proj();
    const o = obs(p, 1, { recommendation: "Add a CSP" });
    const id = generateProposals(p.id).created[0].id!;
    assert.equal(coverageGaps(p.id).counts.observationsWithoutLink, 1);
    const { requirementId } = approveProposal(id);
    assert.deepEqual(db.prepare("SELECT observation_id AS o, requirement_id AS r FROM observation_requirements WHERE observation_id = ?").all(o), [{ o, r: requirementId }]);
    assert.equal(coverageGaps(p.id).counts.observationsWithoutLink, 0);
  });

  it("approving a proposal that an agent made also links the observations it names", () => {
    setDisplayName("Anna Berg");
    const p = proj();
    const o = obs(p, 1);
    const id = createProposals(p.id, { title: "Agent idea", observations: ["OBS-1"] }, "agent: x").created[0].id;
    const { requirementId } = approveProposal(id);
    assert.deepEqual(db.prepare("SELECT requirement_id AS r FROM observation_requirements WHERE observation_id = ?").all(o), [{ r: requirementId }]);
  });

  it("a requirement without a test case is reported as not generated, and nothing is made for it", () => {
    const p = proj();
    const req = createRequirement(p.id, { title: "Orders can be exported" });
    const number = (db.prepare("SELECT number FROM requirements WHERE id = ?").get(req) as { number: number }).number;
    const r = generateProposals(p.id);
    assert.deepEqual([r.counts.created, r.counts.notGenerated, r.notGenerated[0].gap, r.notGenerated[0].label], [0, 1, `req:${req}`, `REQ-${number}`]);
    assert.match(r.notGenerated[0].reason, /Needs a test case \(not generated/);
    assert.equal(count("SELECT COUNT(*) AS n FROM requirement_proposals WHERE project_id = ?", p.id), 0);
  });

  it("leaves out what is not a gap: closed observations, deprecated cases, and cases a requirement in use names", () => {
    const p = proj();
    const closed = obs(p, 1); archiveObservation(closed);
    const retired = caseWith(p, "Retired"); db.prepare("UPDATE cases SET status = 'deprecated' WHERE id = ?").run(retired.id);
    const covered = caseWith(p, "Covered");
    setRequirementCases(createRequirement(p.id, { title: "Live" }), p.id, [covered.id]);
    assert.equal(generateProposals(p.id).counts.created, 0);
  });

  it("makes at most 50 per run, and the rest are made by the next run", () => {
    const p = proj();
    for (let i = 0; i < GAP_LIMIT + 5; i++) caseWith(p, `Case ${i}`);
    const first = generateProposals(p.id);
    assert.deepEqual([first.counts.created, first.counts.more], [GAP_LIMIT, 5]);
    const second = generateProposals(p.id);
    assert.deepEqual([second.counts.created, second.counts.skipped, second.counts.more], [5, GAP_LIMIT, 0]);
    assert.equal(count("SELECT COUNT(*) AS n FROM requirement_proposals WHERE project_id = ?", p.id), GAP_LIMIT + 5);
  });

  it("works inside one project: another project's gaps are not touched, and the same case number in both is not a clash", () => {
    const p = proj(); const q = proj();
    caseWith(p, "P case"); caseWith(q, "Q case"); obs(q, 1);
    assert.equal(generateProposals(p.id).counts.created, 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM requirement_proposals WHERE project_id = ?", q.id), 0);
    assert.equal(generateProposals(q.id).counts.created, 2);
    fails(() => generateProposals(999999), 404, /Project not found/);
  });

  it("the database keeps one proposal per gap, and lets agent proposals without a gap repeat", () => {
    const p = proj();
    caseWith(p, "A case");
    generateProposals(p.id);
    const key = (db.prepare("SELECT gap_key FROM requirement_proposals WHERE project_id = ?").get(p.id) as { gap_key: string }).gap_key;
    assert.throws(() => db.prepare("INSERT INTO requirement_proposals (project_id, title, gap_key) VALUES (?, 'again', ?)").run(p.id, key), /UNIQUE/);
    createProposals(p.id, { title: "Agent 1" }, "agent: x"); createProposals(p.id, { title: "Agent 2" }, "agent: x");
    assert.equal(count("SELECT COUNT(*) AS n FROM requirement_proposals WHERE project_id = ? AND gap_key = ''", p.id), 2);
  });
});
