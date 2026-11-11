import "./env.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { runAs, type AccountUser } from "../server/accountcontext.ts";
import { db } from "../server/db.ts";
import { bagFromFiles } from "../server/importers/bag.ts";
import { addGap, addPlanItem, decideGap, editGap, gapHistory, getAuditPlan, importAuditPackage, planHistory, resolveGapPending } from "../server/audits.ts";
import { planForRequirement } from "../server/auditplan.ts";
import { makeProject } from "./helpers.ts";

// Coverage gaps work like plan items: the agent's proposal until a person edits, decides or adds one; after that an import never overwrites or removes it.

let n = 0;
const proj = () => makeProject(`GE${++n}`, `Gap edit ${n}`);
const plan = (id: number) => getAuditPlan(id)!;
const gap = (over: Record<string, unknown> = {}) => ({ sourceId: "CG-001", description: "Validation is not verified", refs: { requirements: [] }, ...over });
function pkg(p: { key: string }, gaps: unknown[] | undefined, items: unknown[] = []) {
  const f = new Map<string, Uint8Array>();
  f.set("manifest.json", Buffer.from(JSON.stringify({ format: "testbench-audit-package", version: 1, audit: { id: "a1", title: "Audit", project: p.key }, files: [], parts: {} })));
  f.set("bugs.json", Buffer.from(JSON.stringify({ version: 1, bugs: [] })));
  if (gaps) f.set("test-plan.json", Buffer.from(JSON.stringify({ version: 1, planItems: items, coverageGaps: gaps })));
  return bagFromFiles(f);
}
const send = (p: { id: number; key: string }, gaps: unknown[] | undefined, o: { dryRun?: boolean; items?: unknown[] } = {}) =>
  importAuditPackage(pkg(p, gaps, o.items), { projectId: p.id, source: "upload" }, { dryRun: !!o.dryRun });
const audit = (p: { id: number }) => (db.prepare("SELECT id FROM audits WHERE project_id = ? AND agent_audit_id = 'a1'").get(p.id) as { id: number }).id;
const row = (a: number, src: string) => db.prepare("SELECT * FROM audit_coverage_gaps WHERE audit_id = ? AND source_id = ?").get(a, src) as Record<string, any> | undefined;
const user = (name: string): AccountUser => {
  const id = (db.prepare("INSERT INTO users (email, name, password_hash) VALUES (?, ?, 'h') RETURNING id").get(`${name.toLowerCase().replace(/\W/g, "")}@x.io`, name) as { id: number }).id;
  return { id, email: "", name, isOwner: false, disabledAt: null, createdAt: "", lastLoginAt: null };
};
/** An audit with these gaps imported. */
const seeded = (...gaps: Record<string, unknown>[]) => { const p = proj(); send(p, gaps.length ? gaps : [gap()]); return { p, a: audit(p) }; };

// Runs first on purpose: there is no account yet, so this is what a single-person install does.
describe("without accounts (nothing changes for a single-person install)", () => {
  it("a person can edit, approve and add a gap, and no account is saved", () => {
    const { a } = seeded();
    editGap(a, "CG-001", { description: "Validation is not verified, mine" });
    decideGap(a, "CG-001", "approved");
    const added = addGap(a, { description: "Mine" });
    assert.deepEqual([row(a, "CG-001")!.review_status, row(a, "CG-001")!.decided_by_user_id, row(a, added)!.edited_by_user_id], ["approved", null, null]);
    assert.ok(row(a, "CG-001")!.decided_by);
  });
});

describe("what the agent sent is marked, and a person's changes are theirs", () => {
  let anna!: AccountUser; let sam!: AccountUser;
  before(() => { anna = user("Gunnar Gap"); sam = user("Greta Gap"); });

  it("an imported gap is the agent's proposal: origin agent, status proposed, nobody edited or decided it", () => {
    const { a } = seeded();
    const x = plan(a).coverageGaps[0];
    assert.deepEqual([x.origin, x.status, x.editedBy, x.decidedBy, x.pending], ["agent", "proposed", null, null, null]);
    assert.deepEqual(gapHistory(a).map((h) => [h.kind, h.byAgent]), [["agent_import", true]]);
  });

  it("editing takes the gap over as a draft and saves the person, the account and the time; the same text again is not an edit", () => {
    const { a } = seeded();
    runAs(anna, () => editGap(a, "CG-001", { description: "Validation is not verified for dates", requirements: ["REQ-1", "REQ-1", " REQ-2 "] }));
    const r = row(a, "CG-001")!;
    assert.deepEqual([r.review_status, r.edited_by, r.edited_by_user_id, r.description, JSON.parse(r.requirement_refs)], ["draft", "Gunnar Gap", anna.id, "Validation is not verified for dates", ["REQ-1", "REQ-2"]]);
    assert.ok(r.edited_at);
    runAs(sam, () => editGap(a, "CG-001", { description: "Validation is not verified for dates" }));
    assert.equal(row(a, "CG-001")!.edited_by_user_id, anna.id, "no new edit");
    assert.equal(gapHistory(a).filter((h) => h.kind === "edited").length, 1);
    assert.throws(() => runAs(anna, () => editGap(a, "CG-001", { description: "  " })), /needs a description/);
    assert.throws(() => runAs(anna, () => editGap(a, "NOPE", { description: "x" })), /not found/);
  });

  it("approve and reject save who decided and when, 'draft' saves a draft, and every step is in the history in order", () => {
    const { a } = seeded();
    runAs(anna, () => decideGap(a, "CG-001", "draft"));
    runAs(sam, () => decideGap(a, "CG-001", "approved", "confirmed by hand"));
    let r = row(a, "CG-001")!;
    assert.deepEqual([r.review_status, r.decided_by, r.decided_by_user_id], ["approved", "Greta Gap", sam.id]);
    assert.ok(r.decided_at);
    runAs(anna, () => decideGap(a, "CG-001", "rejected"));
    r = row(a, "CG-001")!;
    assert.deepEqual([r.review_status, r.decided_by_user_id], ["rejected", anna.id]);
    runAs(anna, () => decideGap(a, "CG-001", "rejected")); // again: nothing new
    const h = gapHistory(a);
    assert.deepEqual(h.map((x) => [x.kind, x.actor]), [["agent_import", "Agent import"], ["draft", "Gunnar Gap"], ["approved", "Greta Gap"], ["rejected", "Gunnar Gap"]]);
    assert.deepEqual(h.map((x) => x.rev), [1, 2, 3, 4]);
    assert.equal(h[2].note, "confirmed by hand");
  });

  it("editing an approved gap puts it back to draft, because the decision was about the earlier text", () => {
    const { a } = seeded();
    runAs(anna, () => decideGap(a, "CG-001", "approved"));
    runAs(sam, () => editGap(a, "CG-001", { description: "Validation is only partly verified" }));
    assert.equal(row(a, "CG-001")!.review_status, "draft");
    const last = gapHistory(a).at(-1)!;
    assert.deepEqual([last.kind, last.changes.map((c) => c.field)], ["edited", ["Description"]]);
    assert.match(last.note, /earlier text/);
  });

  it("a person's own gap has origin human, id G-n, starts as a draft and says who added it", () => {
    const { a } = seeded();
    const id = runAs(anna, () => addGap(a, { description: "Nobody checked the empty state", requirements: ["REQ-4"] }));
    assert.match(id, /^G-\d+$/);
    const x = plan(a).coverageGaps.find((g) => g.sourceId === id)!;
    assert.deepEqual([x.origin, x.status, x.editedBy], ["human", "draft", "Gunnar Gap"]);
    assert.deepEqual(gapHistory(a).filter((h) => h.sourceId === id).map((h) => h.kind), ["created"]);
    assert.throws(() => runAs(anna, () => addGap(a, { description: " " })), /needs a description/);
  });

  it("a rejected gap is left out of the requirement's own view", () => {
    const p = proj();
    db.prepare("INSERT INTO requirements (project_id, number, title) VALUES (?, 1, 'Req')").run(p.id);
    const q = (db.prepare("SELECT id FROM requirements WHERE project_id = ?").get(p.id) as { id: number }).id;
    send(p, [gap({ refs: { requirements: ["REQ-1"] } })]);
    assert.equal(planForRequirement(q).coverageGaps.length, 1);
    runAs(anna, () => decideGap(audit(p), "CG-001", "rejected"));
    assert.equal(planForRequirement(q).coverageGaps.length, 0);
  });

  it("plan items and gaps have a history each, and the same id in both does not collide", () => {
    const p = proj();
    send(p, [gap({ sourceId: "X-1" })], { items: [{ sourceId: "X-1", title: "An item" }] });
    const a = audit(p);
    runAs(anna, () => { decideGap(a, "X-1", "approved"); addPlanItem(a, { title: "Mine" }); });
    assert.deepEqual(gapHistory(a).map((h) => h.kind), ["agent_import", "approved"]);
    assert.deepEqual(planHistory(a).map((h) => h.kind), ["agent_import", "created"]);
    assert.deepEqual(gapHistory(a).map((h) => h.rev), [1, 2]);
  });
});

describe("an import never overwrites what a person owns", () => {
  let ida!: AccountUser;
  before(() => { ida = user("Ingrid Import"); });
  const changed = { description: "Validation is not verified (agent's new wording)", refs: { requirements: ["REQ-9"] } };

  for (const how of ["edited", "approved", "rejected", "saved as draft"] as const) {
    it(`a gap a person ${how} keeps its text, and the agent's newer version waits with a diff`, () => {
      const { p, a } = seeded();
      runAs(ida, () => { if (how === "edited") editGap(a, "CG-001", { description: "My wording" }); else decideGap(a, "CG-001", how === "approved" ? "approved" : how === "rejected" ? "rejected" : "draft"); });
      const before = row(a, "CG-001")!;
      send(p, [gap(changed)]);
      const after = row(a, "CG-001")!;
      assert.deepEqual([after.description, after.requirement_refs, after.review_status], [before.description, before.requirement_refs, before.review_status], "the text and status are untouched");
      const x = plan(a).coverageGaps[0];
      assert.equal(x.pending?.removed, false);
      assert.ok(x.pending!.changes.some((c) => c.field === "Description" && c.to === changed.description));
      assert.equal(gapHistory(a).at(-1)!.kind, "agent_sent");
    });
  }

  it("a gap nobody has touched is updated by the import, and the history says the agent did it", () => {
    const { p, a } = seeded();
    send(p, [gap(changed)]);
    assert.equal(row(a, "CG-001")!.description, changed.description);
    assert.equal(row(a, "CG-001")!.review_status, "proposed");
    assert.deepEqual(gapHistory(a).map((h) => h.kind), ["agent_import", "agent_import"]);
  });

  it("the preview says how many gaps are kept with the agent's version waiting, and writes nothing", () => {
    const { p, a } = seeded(gap(), gap({ sourceId: "CG-002", description: "Second" }));
    runAs(ida, () => editGap(a, "CG-001", { description: "Mine" }));
    const before = JSON.stringify(plan(a));
    const dry = send(p, [gap(changed), gap({ sourceId: "CG-002", description: "Second" })], { dryRun: true });
    assert.deepEqual(dry.testPlan.coverageGaps.counts, { new: 0, unchanged: 1, updated: 0, removed: 0, pending: 1 });
    assert.equal(dry.testPlan.coverageGaps.items.find((i) => i.sourceId === "CG-001")!.action, "pending");
    assert.equal(JSON.stringify(plan(a)), before, "a dry run writes nothing");
  });

  it("Apply takes the agent's version as a draft to approve again; Ignore keeps the gap and the same version is not offered again", () => {
    const { p, a } = seeded();
    runAs(ida, () => decideGap(a, "CG-001", "approved"));
    send(p, [gap(changed)]);
    runAs(ida, () => resolveGapPending(a, "CG-001", "ignore"));
    assert.equal(plan(a).coverageGaps[0].pending, null);
    assert.equal(row(a, "CG-001")!.description, "Validation is not verified", "kept");
    send(p, [gap(changed)]);
    assert.equal(plan(a).coverageGaps[0].pending, null, "the ignored version is not offered again");
    send(p, [gap({ description: "Yet another wording" })]);
    assert.ok(plan(a).coverageGaps[0].pending, "a different version is");
    runAs(ida, () => resolveGapPending(a, "CG-001", "apply"));
    const r = row(a, "CG-001")!;
    assert.deepEqual([r.description, r.review_status, r.pending_json, r.edited_by], ["Yet another wording", "draft", null, "Ingrid Import"]);
    assert.deepEqual(gapHistory(a).map((h) => h.kind).slice(-4), ["agent_sent", "ignored_agent", "agent_sent", "applied_agent"]);
    assert.throws(() => runAs(ida, () => resolveGapPending(a, "CG-001", "apply")), /has not sent a newer version/);
  });

  it("a gap the agent leaves out is removed only if nobody owns it; an owned one is kept with the removal waiting", () => {
    const { p, a } = seeded(gap(), gap({ sourceId: "CG-002", description: "Second" }), gap({ sourceId: "CG-003", description: "Third" }));
    runAs(ida, () => editGap(a, "CG-002", { description: "Second, mine" }));
    const dry = send(p, [gap()], { dryRun: true });
    assert.deepEqual([dry.testPlan.coverageGaps.counts.removed, dry.testPlan.coverageGaps.counts.pending, dry.testPlan.coverageGaps.waiting], [1, 1, ["CG-002"]]);
    send(p, [gap()]);
    assert.equal(row(a, "CG-003"), undefined, "the untouched one is gone");
    assert.equal(row(a, "CG-002")!.description, "Second, mine", "the owned one stays");
    assert.deepEqual(plan(a).coverageGaps.find((g) => g.sourceId === "CG-002")!.pending, { removed: true, changes: [] });
    runAs(ida, () => resolveGapPending(a, "CG-002", "ignore"));
    assert.ok(row(a, "CG-002"), "ignoring the removal keeps it");
    send(p, [gap()]);
    assert.ok(plan(a).coverageGaps.find((g) => g.sourceId === "CG-002")!.pending, "the agent's plan still leaves it out, so the removal waits again");
    runAs(ida, () => resolveGapPending(a, "CG-002", "apply"));
    assert.equal(row(a, "CG-002"), undefined, "applying the removal removes it");
    assert.equal(gapHistory(a).at(-1)!.kind, "removed_by_agent", "and the history still says so");
  });

  it("an empty test-plan.json removes the gaps nobody owns and nothing else", () => {
    const { p, a } = seeded(gap(), gap({ sourceId: "CG-002", description: "Second" }));
    runAs(ida, () => decideGap(a, "CG-001", "approved"));
    const mine = runAs(ida, () => addGap(a, { description: "My own" }));
    send(p, []);
    assert.deepEqual(plan(a).coverageGaps.map((g) => g.sourceId).sort(), [mine, "CG-001"].sort());
    assert.equal(row(a, "CG-001")!.review_status, "approved");
    assert.deepEqual(plan(a).coverageGaps.find((g) => g.sourceId === "CG-001")!.pending, { removed: true, changes: [] });
  });

  it("a package without test-plan.json leaves the gaps alone", () => {
    const { p, a } = seeded();
    runAs(ida, () => editGap(a, "CG-001", { description: "Mine" }));
    send(p, undefined);
    assert.deepEqual([row(a, "CG-001")!.description, row(a, "CG-001")!.pending_json], ["Mine", null]);
  });

  it("a person's own gap is never replaced or removed: the same id from the agent waits, a similar one is a separate proposal", () => {
    const { p, a } = seeded();
    const mine = runAs(ida, () => addGap(a, { description: "Nobody checked the empty state" }));
    send(p, [gap(), gap({ sourceId: mine, description: "Agent's idea with my id" }), gap({ sourceId: "CG-009", description: "Nobody checked the empty state" })]);
    const own = plan(a).coverageGaps.find((g) => g.sourceId === mine)!;
    assert.deepEqual([own.description, own.origin, own.pending?.changes.some((c) => c.to === "Agent's idea with my id")], ["Nobody checked the empty state", "human", true]);
    const similar = plan(a).coverageGaps.find((g) => g.sourceId === "CG-009")!;
    assert.deepEqual([similar.origin, similar.status], ["agent", "proposed"]);
    send(p, [gap()]);
    assert.ok(row(a, mine), "and a later plan without it does not remove it");
    assert.equal(plan(a).coverageGaps.find((g) => g.sourceId === mine)!.pending?.removed, false, "no removal is proposed for a person's own gap");
  });

  it("plan items in the same package are handled on their own: a person's gap is kept while an untouched item follows the package", () => {
    const p = proj();
    send(p, [gap()], { items: [{ sourceId: "TPI-1", title: "An item" }] });
    const a = audit(p);
    runAs(ida, () => editGap(a, "CG-001", { description: "Mine" }));
    send(p, [gap({ description: "Agent again" })], { items: [{ sourceId: "TPI-1", title: "An item, reworded" }] });
    assert.deepEqual([row(a, "CG-001")!.description, plan(a).planItems[0].title], ["Mine", "An item, reworded"]);
  });
});

describe("with accounts, a decision needs an account in the database itself", () => {
  it("the database refuses an approve, a reject or a draft without an account, however it is made", () => {
    const { a } = seeded();
    for (const to of ["approved", "rejected", "draft"]) {
      assert.throws(() => db.prepare("UPDATE audit_coverage_gaps SET review_status = ? WHERE audit_id = ? AND source_id = 'CG-001'").run(to, a), /needs a person with an account/, to);
    }
    assert.throws(() => decideGap(a, "CG-001", "approved"), /needs a person with an account/, "the function, run without a person");
    assert.throws(() => editGap(a, "CG-001", { description: "Nobody's edit" }), /needs a person with an account/);
    assert.throws(() => addGap(a, { description: "Nobody's gap" }), /needs a person with an account/);
    assert.throws(() => db.prepare("INSERT INTO audit_coverage_gaps (audit_id, source_id, position, description, review_status) VALUES (?, 'X', 9, 't', 'approved')").run(a), /needs a person with an account/);
    assert.equal(row(a, "CG-001")!.review_status, "proposed");
  });

  it("an import is not a person: it never makes a gap anything but a proposal, and leaves no decision", () => {
    const p = proj();
    send(p, [gap(), gap({ sourceId: "CG-002", description: "Second" })]);
    send(p, [gap({ description: "Reworded" })]);
    const rows = db.prepare("SELECT review_status AS s, decided_by AS d, decided_by_user_id AS u, edited_by AS e FROM audit_coverage_gaps WHERE audit_id = ?").all(audit(p));
    assert.ok(rows.every((r: any) => r.s === "proposed" && !r.d && r.u === null && !r.e), JSON.stringify(rows));
  });

  it("no code but the person's functions writes a gap's status, and the import never clears a table", () => {
    const dir = join(import.meta.dirname, "..", "server");
    for (const f of ["audits.ts", "index.ts", "manualtests.ts", "ci.ts", "observations.ts"]) {
      assert.doesNotMatch(readFileSync(join(dir, f), "utf8"), /audit_coverage_gaps SET[^;`]*review_status/, f);
    }
    const src = readFileSync(join(dir, "auditplan.ts"), "utf8");
    const store = src.slice(src.indexOf("function reconcile"), src.indexOf("export const planCounts"));
    assert.doesNotMatch(store, /DELETE FROM \$\{s\.table\} WHERE audit_id/, "the import never clears a whole table");
    assert.doesNotMatch(src, /DELETE FROM audit_coverage_gaps/, "nor the gaps in particular");
  });
});
