import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { db, migrateRequirementModel } from "../server/db.ts";
import { makeCase, makeProject } from "./helpers.ts";
import { actorName, getDisplayName, setDisplayName, UNNAMED } from "../server/actor.ts";
import { createRequirement, deprecateRequirement, getRequirement, listRequirements, requirementSummary, RequirementError } from "../server/requirements.ts";
import { approveProposal, createProposals, editProposal, getProposal, listProposals, rejectProposal } from "../server/reqproposals.ts";
import { agentCredentialKind, agentProposalsEnabled, authenticateProposeToken, createProposeToken, isAgentPropose, listProposeTokens, revokeProposeToken, setAgentProposalsEnabled } from "../server/proposetokens.ts";
import { agentRequirementsForToken } from "../server/agentapi.ts";
import { createAgentToken } from "../server/agenttokens.ts";

// People, proposals and the agent's token. Everything runs against a throwaway data folder (see env.ts), and nothing here touches the network.

let n = 0;
const proj = () => makeProject(`RQ${++n}`, `Requirements ${n}`);
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
const reqRow = (id: number) => db.prepare("SELECT * FROM requirements WHERE id = ?").get(id) as Record<string, any>;
const fails = (fn: () => unknown, status: number, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof RequirementError && e.status === status && re.test(`${e.message} ${e.problems.join(" ")}`));
const obs = (p: { id: number }, number: number) =>
  (db.prepare("INSERT INTO observations (project_id, number, source_id, origin_audit_id, kind, title, severity, content_hash) VALUES (?, ?, ?, 'a1', 'security_review', 'Missing CSP', 'high', 'h') RETURNING id").get(p.id, number, `S-${number}`) as { id: number }).id;
const prop = (over: Record<string, unknown> = {}) => ({ title: "Passwords are never shown", description: "The login form hides the password.", acceptanceCriteria: "- The field is masked\n- A show button is optional", rationale: "OBS-1 found it readable in the page source", suggestedPriority: "high", basis: "observation", ...over });
/** One proposal as an agent made it. */
const propose = (p: { id: number }, over: Record<string, unknown> = {}, by = "agent: skill run 12") => createProposals(p.id, prop(over), by).created[0].id;

describe("who made a change", () => {
  it("records the display name from Settings, as typed, and falls back to a name that says nobody is named", () => {
    const p = proj();
    setDisplayName("");
    assert.equal(actorName(), UNNAMED);
    const a = createRequirement(p.id, { title: "Anonymous" });
    assert.equal(reqRow(a).created_by, UNNAMED);
    setDisplayName("  Anna Berg  ");
    assert.equal(getDisplayName(), "Anna Berg");
    assert.equal(actorName(), "Anna Berg");
    const r = reqRow(createRequirement(p.id, { title: "By Anna" }));
    assert.deepEqual([r.origin, r.created_by, r.status, r.approved_by], ["human", "Anna Berg", "approved", "Anna Berg"]);
    assert.ok(r.approved_at);
  });

  it("a draft has no approver; the change log says who changed what and when", () => {
    setDisplayName("Anna Berg");
    const p = proj();
    const id = createRequirement(p.id, { title: "Draft", status: "draft" });
    assert.deepEqual([reqRow(id).approved_by, reqRow(id).approved_at], ["", null]);
    const h = getRequirement(id)!.history;
    assert.deepEqual([h[0].by, h[0].changes[0].field], ["Anna Berg", "created"]);
    assert.ok(h[0].at);
  });

  it("the name is checked: not too long, no control characters, and an empty one clears it", () => {
    assert.throws(() => setDisplayName("x".repeat(81)), /at most 80/);
    assert.throws(() => setDisplayName("Anna\u0007"), /control characters/);
    assert.throws(() => setDisplayName(42), /must be text/);
    setDisplayName("Anna Berg");
    setDisplayName("");
    assert.equal(getDisplayName(), "");
  });

  it("deprecating takes a requirement out of use, keeps it with its history, and counts it out of coverage", () => {
    setDisplayName("Anna Berg");
    const p = proj();
    const id = createRequirement(p.id, { title: "Old rule" });
    createRequirement(p.id, { title: "Current rule" });
    assert.equal(requirementSummary(p.id).total, 2);
    deprecateRequirement(id, "Replaced by the new checkout");
    assert.equal(reqRow(id).status, "deprecated");
    assert.equal(requirementSummary(p.id).total, 1);
    assert.equal(listRequirements(p.id).length, 2);
    const h = getRequirement(id)!.history[0];
    assert.deepEqual([h.by, h.changes.map((c) => c.field)], ["Anna Berg", ["status", "reason"]]);
    fails(() => deprecateRequirement(id), 409, /already deprecated/);
    fails(() => deprecateRequirement(999999), 404, /not found/);
  });

  it("acceptance criteria written in the field win over the description; without them the description is still read", () => {
    const p = proj();
    createRequirement(p.id, { title: "In the field", description: "Acceptance criteria:\n- from the description", acceptanceCriteria: "- The field is masked\n2) A show button is optional" });
    createRequirement(p.id, { title: "In the text", description: "Acceptance criteria:\n- from the description" });
    const [a, b] = agentRequirementsForToken(p.id).requirements;
    assert.deepEqual([a.acceptance_criteria, a.readiness], [["The field is masked", "A show button is optional"], "ready"]);
    assert.deepEqual(b.acceptance_criteria, ["from the description"]);
  });
});

describe("the database itself refuses an AI-suggested requirement without a person", () => {
  it("cannot be inserted, or set to approved, without an approver", () => {
    const p = proj();
    const insert = (status: string, by: string) =>
      db.prepare("INSERT INTO requirements (project_id, number, title, status, origin, approved_by) VALUES (?, ?, 'x', ?, 'ai_suggestion', ?)").run(p.id, 900 + ++n, status, by);
    assert.throws(() => insert("approved", ""), /only after a person has approved/);
    assert.throws(() => insert("draft", "  "), /only after a person has approved/);
    assert.equal(insert("approved", "Anna Berg").changes, 1);
    const id = createRequirement(p.id, { title: "Human" });
    db.prepare("UPDATE requirements SET origin = 'ai_suggestion', approved_by = 'Anna Berg' WHERE id = ?").run(id);
    assert.throws(() => db.prepare("UPDATE requirements SET approved_by = '' WHERE id = ?").run(id), /only be approved by a person/);
  });

  it("an origin outside human, import and ai_suggestion is refused", () => {
    const p = proj();
    assert.throws(() => db.prepare("INSERT INTO requirements (project_id, number, title, origin) VALUES (?, 950, 'x', 'robot')").run(p.id), /CHECK/);
  });
});

describe("proposals from an agent", () => {
  it("start as proposed, apart from the requirements: not in the list, in coverage or in what an agent reads", () => {
    const p = proj();
    createRequirement(p.id, { title: "Existing" });
    const id = propose(p);
    const v = getProposal(id)!;
    assert.deepEqual([v.status, v.proposedBy, v.edited, v.suggestedPriority, v.basis], ["proposed", "agent: skill run 12", false, "high", "observation"]);
    assert.equal(v.original.title, "Passwords are never shown");
    assert.equal(listRequirements(p.id).length, 1);
    assert.equal(requirementSummary(p.id).total, 1);
    assert.equal(agentRequirementsForToken(p.id).requirements.length, 1);
    assert.deepEqual(listProposals(p.id).counts, { proposed: 1, approved: 0, rejected: 0 });
  });

  it("a proposal cannot ask for a status, an approver or an origin: such fields are refused, and nothing is made", () => {
    const p = proj();
    for (const extra of [{ status: "approved" }, { approvedBy: "Anna" }, { origin: "human" }, { proposedBy: "someone" }]) {
      fails(() => createProposals(p.id, [prop(), prop({ ...extra })], "agent: x"), 400, /Unrecognized key/i);
    }
    fails(() => createProposals(p.id, [prop(), prop({ suggestedPriority: "urgent" })], "agent: x"), 400, /suggestedPriority/);
    fails(() => createProposals(p.id, [prop({ title: "" })], "agent: x"), 400, /title/);
    fails(() => createProposals(p.id, [], "agent: x"), 400, /no proposal/);
    fails(() => createProposals(p.id, Array.from({ length: 21 }, () => prop()), "agent: x"), 400, /At most 20/);
    fails(() => createProposals(999999, prop(), "agent: x"), 404, /Project not found/);
    assert.equal(count("SELECT COUNT(*) AS n FROM requirement_proposals WHERE project_id = ?", p.id), 0);
  });

  it("links to observations and test cases of this project; what does not match is reported, not linked", () => {
    const p = proj(); const other = proj();
    const o = obs(p, 1); obs(other, 1);
    const c = makeCase(p.id, "Login masks the password");
    const foreign = makeCase(other.id, "Other project's case");
    const r = createProposals(p.id, prop({ observations: ["OBS-1", "OBS-9", "banana"], cases: [`${p.key}-${c.number}`, `${other.key}-${foreign.number}`, `${p.key}-999`] }), "agent: x");
    assert.deepEqual(r.unresolved.map((u) => [u.ref, u.reason]), [
      ["OBS-9", "no such observation in this project"], ["banana", "not an observation reference such as OBS-3"],
      [`${other.key}-${foreign.number}`, "a test case of another project"], [`${p.key}-999`, "no such test case in this project"],
    ]);
    const v = getProposal(r.created[0].id)!;
    assert.deepEqual([v.observations.map((x) => x.id), v.cases.map((x) => x.id)], [[o], [c.id]]);
    assert.equal(v.observations[0].label, "OBS-1");
  });

  it("a person can edit it before approving; the agent's version stays, and only the editable fields change", () => {
    setDisplayName("Anna Berg");
    const p = proj();
    const id = propose(p);
    const e = editProposal(id, { title: "Passwords are masked", suggestedPriority: "critical" });
    assert.deepEqual([e.title, e.suggestedPriority, e.edited, e.original.title], ["Passwords are masked", "critical", true, "Passwords are never shown"]);
    assert.equal(editProposal(id, { title: "Passwords are masked" }).title, "Passwords are masked");
    fails(() => editProposal(id, { proposedBy: "me" }), 400, /Unrecognized key/i);
    fails(() => editProposal(id, { status: "approved" }), 400, /Unrecognized key/i);
    fails(() => editProposal(id, { suggestedPriority: "urgent" }), 400, /suggestedPriority/);
    fails(() => editProposal(999999, {}), 404, /not found/);
    const untouched = propose(p, { title: "Unedited" });
    assert.equal(editProposal(untouched, { title: "Unedited" }).edited, false);
  });

  it("approving makes one ordinary requirement (origin ai_suggestion, approved by the person), links its cases, and touches no other requirement", () => {
    setDisplayName("Anna Berg");
    const p = proj();
    const existing = createRequirement(p.id, { title: "Existing", description: "unchanged", acceptanceCriteria: "- keep" });
    const before = JSON.stringify(reqRow(existing));
    const c = makeCase(p.id, "Login masks the password");
    const id = createProposals(p.id, prop({ cases: [`${p.key}-${c.number}`] }), "agent: skill run 12").created[0].id;
    editProposal(id, { suggestedPriority: "critical" });
    const { requirementId, proposal } = approveProposal(id);
    const r = reqRow(requirementId);
    assert.deepEqual([r.origin, r.status, r.priority, r.created_by, r.approved_by, r.title, r.acceptance_criteria], ["ai_suggestion", "approved", "critical", "agent: skill run 12", "Anna Berg", "Passwords are never shown", "- The field is masked\n- A show button is optional"]);
    assert.equal(r.number, reqRow(existing).number + 1);
    assert.deepEqual(getRequirement(requirementId)!.cases.map((x) => x.id), [c.id]);
    assert.deepEqual(getRequirement(requirementId)!.history.map((h) => [h.by, h.changes[0].field]).sort(), [["Anna Berg", "cases"], ["Anna Berg", "created"], ["agent: skill run 12", "why it was proposed"]]);
    assert.deepEqual([proposal.status, proposal.decidedBy, proposal.requirementId, proposal.requirementLabel], ["approved", "Anna Berg", requirementId, `REQ-${r.number}`]);
    assert.equal(JSON.stringify(reqRow(existing)), before, "the existing requirement is not touched");
    assert.equal(count("SELECT COUNT(*) AS n FROM requirements WHERE project_id = ?", p.id), 2);
  });

  it("a decided proposal is final: it cannot be approved twice, edited, rejected or approved after a rejection", () => {
    const p = proj();
    const a = propose(p); const b = propose(p, { title: "Other" });
    approveProposal(a);
    fails(() => approveProposal(a), 409, /already approved/);
    fails(() => rejectProposal(a, "changed my mind"), 409, /already approved/);
    fails(() => editProposal(a, { title: "x" }), 409, /already approved/);
    rejectProposal(b, "Covered by REQ-2");
    fails(() => approveProposal(b), 409, /already rejected/);
    assert.equal(count("SELECT COUNT(*) AS n FROM requirements WHERE project_id = ?", p.id), 1);
  });

  it("rejecting needs a reason, keeps the proposal with it and who decided, and makes no requirement", () => {
    setDisplayName("Anna Berg");
    const p = proj();
    const id = propose(p);
    for (const bad of [undefined, "", "  ", "no", 42]) fails(() => rejectProposal(id, bad), 400, /reason is needed/);
    fails(() => rejectProposal(id, "x".repeat(2001)), 400, /at most 2000/);
    const v = rejectProposal(id, "  Already covered by REQ-2  ");
    assert.deepEqual([v.status, v.rejectReason, v.decidedBy, v.requirementId], ["rejected", "Already covered by REQ-2", "Anna Berg", null]);
    assert.equal(count("SELECT COUNT(*) AS n FROM requirements WHERE project_id = ?", p.id), 0);
    assert.deepEqual(listProposals(p.id, "rejected").items.map((x) => x.id), [id]);
    assert.deepEqual(listProposals(p.id).counts, { proposed: 0, approved: 0, rejected: 1 });
    fails(() => listProposals(p.id, "maybe"), 400, /Unknown status/);
  });

  it("the database also refuses a rejection without a reason, and a decision without a name", () => {
    const p = proj();
    const id = propose(p);
    assert.throws(() => db.prepare("UPDATE requirement_proposals SET status = 'rejected', decided_by = 'Anna' WHERE id = ?").run(id), /CHECK/);
    assert.throws(() => db.prepare("UPDATE requirement_proposals SET status = 'approved' WHERE id = ?").run(id), /CHECK/);
  });

  it("belong to their project: another project's list does not show them, and deleting the project removes them", () => {
    const p = proj(); const q = proj();
    const id = propose(p);
    assert.equal(listProposals(q.id).items.length, 0);
    assert.equal(listProposals(p.id).items.length, 1);
    const { requirementId } = approveProposal(id);
    assert.equal(reqRow(requirementId).project_id, p.id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(p.id);
    assert.equal(count("SELECT COUNT(*) AS n FROM requirement_proposals WHERE id = ?", id), 0);
  });
});

describe("the proposal token", () => {
  it("is off until a person switches it on: no token can be made and none is accepted", () => {
    const p = proj();
    setAgentProposalsEnabled(false);
    assert.equal(agentProposalsEnabled(), false);
    assert.throws(() => createProposeToken(p.id, "skill"), /switched off/);
    assert.deepEqual(authenticateProposeToken("Bearer tbpr_whatever", p.id), { state: "off" });
  });

  it("is shown once and stored only as a hash; it names the agent, belongs to one project and can be revoked", () => {
    const p = proj(); const q = proj();
    setAgentProposalsEnabled(true);
    const t = createProposeToken(p.id, " skill run ");
    assert.match(t.token, /^tbpr_[A-Za-z0-9_-]{20,}$/);
    assert.equal(t.name, "skill run");
    assert.equal(count("SELECT COUNT(*) AS n FROM propose_tokens WHERE token_hash = ?", t.token), 0, "the token itself is not stored");
    assert.equal(count("SELECT COUNT(*) AS n FROM propose_tokens WHERE instr(token_hash, ?) > 0 OR instr(prefix, ?) > 1", t.token, t.token), 0);
    assert.equal(JSON.stringify(listProposeTokens(p.id)).includes(t.token), false);
    assert.deepEqual(authenticateProposeToken(`Bearer ${t.token}`, p.id), { state: "ok", name: "skill run" });
    assert.deepEqual(authenticateProposeToken(`Bearer ${t.token}`, q.id), { state: "other_project" });
    assert.deepEqual(authenticateProposeToken(`bearer ${t.token}x`, p.id), { state: "invalid" });
    assert.deepEqual(authenticateProposeToken(undefined, p.id), { state: "invalid" });
    assert.notEqual(listProposeTokens(p.id)[0].lastUsedAt, null);
    revokeProposeToken(t.id);
    assert.deepEqual(authenticateProposeToken(`Bearer ${t.token}`, p.id), { state: "invalid" });
    assert.throws(() => revokeProposeToken(999999), /not found/);
    setAgentProposalsEnabled(false);
  });

  it("a read token or a CI token is not a proposal token, and a proposal token is not either of them", () => {
    const p = proj();
    setAgentProposalsEnabled(true);
    const read = createAgentToken(p.id, "reader");
    assert.deepEqual(authenticateProposeToken(`Bearer ${read.token}`, p.id), { state: "invalid" });
    assert.deepEqual(authenticateProposeToken("Bearer tbci_abcdefghijklmnopqrstuvwxyz", p.id), { state: "invalid" });
    assert.deepEqual([agentCredentialKind(`Bearer ${read.token}`), agentCredentialKind("Bearer tbpr_x"), agentCredentialKind("Bearer tbci_x"), agentCredentialKind("Bearer abc"), agentCredentialKind(undefined), agentCredentialKind("Basic tbpr_x")],
      ["read", "propose", "ci", null, null, null]);
    setAgentProposalsEnabled(false);
  });

  it("is limited to three live tokens per project, with a name", () => {
    const p = proj();
    setAgentProposalsEnabled(true);
    assert.throws(() => createProposeToken(p.id, "  "), /name/);
    assert.throws(() => createProposeToken(999999, "x"), /Project not found/);
    for (const i of [1, 2, 3]) createProposeToken(p.id, `t${i}`);
    assert.throws(() => createProposeToken(p.id, "t4"), /3 active proposal tokens/);
    setAgentProposalsEnabled(false);
  });

  it("opens one route only: POST of proposals for a project", () => {
    assert.equal(isAgentPropose("POST", "/api/agent/projects/3/requirement-proposals"), true);
    assert.equal(isAgentPropose("POST", "/api/agent/projects/3/requirement-proposals?x=1"), true);
    for (const [m, u] of [["GET", "/api/agent/projects/3/requirement-proposals"], ["POST", "/api/requirement-proposals/3/approve"], ["POST", "/api/requirement-proposals/3/reject"],
      ["PATCH", "/api/requirement-proposals/3"], ["POST", "/api/projects/3/requirement-proposals"], ["POST", "/api/agent/projects/3/requirements"], ["POST", "/api/agent/projects/x/requirement-proposals"],
      ["POST", "/api/requirements/3/deprecate"], ["PATCH", "/api/requirements/3"], ["POST", "/api/agent/projects/3/requirement-proposals/extra"]] as const) {
      assert.equal(isAgentPropose(m, u), false, `${m} ${u}`);
    }
  });
});

describe("a database from before origin and approvers existed", () => {
  it("gets the new columns, calls imported requirements imports and the rest human, and does it once", () => {
    const side = new Database(":memory:");
    side.pragma("foreign_keys = ON");
    side.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY); CREATE TABLE cases (id INTEGER PRIMARY KEY); CREATE TABLE observations (id INTEGER PRIMARY KEY);
      CREATE TABLE requirements (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, number INTEGER NOT NULL DEFAULT 1, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'approved', external_id TEXT);
      CREATE TABLE requirement_revisions (id INTEGER PRIMARY KEY, requirement_id INTEGER NOT NULL);
      INSERT INTO projects VALUES (1);
      INSERT INTO requirements (id, project_id, number, title, external_id) VALUES (1, 1, 1, 'Imported', 'EXT-1'), (2, 1, 2, 'By hand', NULL);
      INSERT INTO requirement_revisions (requirement_id) VALUES (1);`);
    migrateRequirementModel(side);
    assert.deepEqual(side.prepare("SELECT id, origin, acceptance_criteria AS ac, created_by AS cb, approved_by AS ab, approved_at AS at FROM requirements ORDER BY id").all(),
      [{ id: 1, origin: "import", ac: "", cb: "", ab: "", at: null }, { id: 2, origin: "human", ac: "", cb: "", ab: "", at: null }]);
    assert.equal((side.prepare("SELECT changed_by AS b FROM requirement_revisions").get() as { b: string }).b, "");
    side.prepare("UPDATE requirements SET origin = 'human' WHERE id = 1").run();
    migrateRequirementModel(side); // a second start changes nothing
    assert.equal((side.prepare("SELECT origin FROM requirements WHERE id = 1").get() as { origin: string }).origin, "human");
    for (const t of ["requirement_proposals", "proposal_observations", "proposal_cases", "propose_tokens"]) assert.ok(side.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t), t);
    side.close();
  });
});
