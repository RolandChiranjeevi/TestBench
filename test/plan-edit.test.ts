import "./env.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { runAs, type AccountUser } from "../server/accountcontext.ts";
import { db } from "../server/db.ts";
import { bagFromFiles } from "../server/importers/bag.ts";
import { addPlanItem, decidePlanItem, editPlanItem, getAuditPlan, importAuditPackage, planHistory, resolvePending } from "../server/audits.ts";
import { planForRequirement } from "../server/auditplan.ts";
import { makeProject } from "./helpers.ts";

// The test plan is a workspace a person owns. An item is the agent's proposal until a person edits, decides or adds it; after that an import never overwrites or removes it.

let n = 0;
const proj = () => makeProject(`PE${++n}`, `Plan edit ${n}`);
const plan = (id: number) => getAuditPlan(id)!;
const item = (over: Record<string, unknown> = {}) => ({
  sourceId: "TPI-001", title: "Add a todo", type: "Functional", risk: "High", priority: "High", readiness: "ready", preconditions: "An empty list", testData: "",
  steps: ["Type the text", "Press Enter"], acceptanceCriteria: "The text is shown", automation: "Yes", refs: { requirements: [] }, ...over,
});
function pkg(p: { key: string }, planItems: unknown[] | undefined, audit = "a1") {
  const f = new Map<string, Uint8Array>();
  f.set("manifest.json", Buffer.from(JSON.stringify({ format: "testbench-audit-package", version: 1, audit: { id: audit, title: "Audit", project: p.key }, files: [], parts: {} })));
  f.set("bugs.json", Buffer.from(JSON.stringify({ version: 1, bugs: [] })));
  if (planItems) f.set("test-plan.json", Buffer.from(JSON.stringify({ version: 1, planItems, coverageGaps: [] })));
  return bagFromFiles(f);
}
const send = (p: { id: number; key: string }, items: unknown[] | undefined, o: { dryRun?: boolean } = {}) =>
  importAuditPackage(pkg(p, items), { projectId: p.id, source: "upload" }, { dryRun: !!o.dryRun });
const audit = (p: { id: number }) => (db.prepare("SELECT id FROM audits WHERE project_id = ? AND agent_audit_id = 'a1'").get(p.id) as { id: number }).id;
const row = (a: number, src: string) => db.prepare("SELECT * FROM audit_plan_items WHERE audit_id = ? AND source_id = ?").get(a, src) as Record<string, any> | undefined;
const user = (name: string): AccountUser => {
  const id = (db.prepare("INSERT INTO users (email, name, password_hash) VALUES (?, ?, 'h') RETURNING id").get(`${name.toLowerCase().replace(/\W/g, "")}@x.io`, name) as { id: number }).id;
  return { id, email: "", name, isOwner: false, disabledAt: null, createdAt: "", lastLoginAt: null };
};
/** An audit with these items imported. */
const seeded = (...items: Record<string, unknown>[]) => { const p = proj(); send(p, items.length ? items : [item()]); return { p, a: audit(p) }; };

// Runs first on purpose: there is no account yet, so this is what a single-person install does.
describe("without accounts (nothing changes for a single-person install)", () => {
  it("a person can edit, approve and add, and no account is saved", () => {
    const { a } = seeded();
    editPlanItem(a, "TPI-001", { title: "Add a todo item" });
    decidePlanItem(a, "TPI-001", "approved");
    const added = addPlanItem(a, { title: "Mine" });
    assert.deepEqual([row(a, "TPI-001")!.review_status, row(a, "TPI-001")!.decided_by_user_id, row(a, added)!.edited_by_user_id], ["approved", null, null]);
    assert.ok(row(a, "TPI-001")!.decided_by, "a name is saved, even if it is the 'unnamed user' fallback");
  });
});

describe("what the agent sent is marked, and a person's changes are theirs", () => {
  let anna!: AccountUser; let sam!: AccountUser;
  before(() => { anna = user("Anna Berg"); sam = user("Sam Lund"); });

  it("an imported item is the agent's proposal: origin agent, status proposed, nobody edited or decided it", () => {
    const { a } = seeded();
    const x = plan(a).planItems[0];
    assert.deepEqual([x.origin, x.status, x.editedBy, x.decidedBy, x.pending], ["agent", "proposed", null, null, null]);
    assert.deepEqual(planHistory(a).map((h) => [h.kind, h.byAgent]), [["agent_import", true]]);
  });

  it("editing takes the item over as a draft and saves the person, the account and the time; a change that changes nothing is not an edit", () => {
    const { a } = seeded();
    runAs(anna, () => editPlanItem(a, "TPI-001", { title: "Add a todo item", steps: ["Type", "Enter"] }));
    const r = row(a, "TPI-001")!;
    assert.deepEqual([r.review_status, r.edited_by, r.edited_by_user_id, r.title, JSON.parse(r.steps)], ["draft", "Anna Berg", anna.id, "Add a todo item", ["Type", "Enter"]]);
    assert.ok(r.edited_at);
    runAs(sam, () => editPlanItem(a, "TPI-001", { title: "Add a todo item" })); // the same text again
    assert.equal(row(a, "TPI-001")!.edited_by_user_id, anna.id, "no new edit");
    assert.equal(planHistory(a).filter((h) => h.kind === "edited").length, 1);
    assert.throws(() => runAs(anna, () => editPlanItem(a, "TPI-001", { title: "  " })), /needs a title/);
  });

  it("approve and reject save who decided and when, 'draft' saves it as a draft, and every step is in the history in order", () => {
    const { a } = seeded();
    runAs(anna, () => decidePlanItem(a, "TPI-001", "draft"));
    runAs(sam, () => decidePlanItem(a, "TPI-001", "approved", "looks right"));
    let r = row(a, "TPI-001")!;
    assert.deepEqual([r.review_status, r.decided_by, r.decided_by_user_id], ["approved", "Sam Lund", sam.id]);
    assert.ok(r.decided_at);
    runAs(anna, () => decidePlanItem(a, "TPI-001", "rejected"));
    r = row(a, "TPI-001")!;
    assert.deepEqual([r.review_status, r.decided_by_user_id], ["rejected", anna.id]);
    runAs(anna, () => decidePlanItem(a, "TPI-001", "rejected")); // again: nothing new
    const h = planHistory(a);
    assert.deepEqual(h.map((x) => [x.kind, x.actor]), [["agent_import", "Agent import"], ["draft", "Anna Berg"], ["approved", "Sam Lund"], ["rejected", "Anna Berg"]]);
    assert.deepEqual(h.map((x) => x.rev), [1, 2, 3, 4]);
    assert.equal(h[2].note, "looks right");
  });

  it("editing an approved item puts it back to draft, because the decision was about the earlier text", () => {
    const { a } = seeded();
    runAs(anna, () => decidePlanItem(a, "TPI-001", "approved"));
    runAs(sam, () => editPlanItem(a, "TPI-001", { acceptanceCriteria: "Shown, and saved" }));
    assert.equal(row(a, "TPI-001")!.review_status, "draft");
    const last = planHistory(a).at(-1)!;
    assert.deepEqual([last.kind, last.changes.map((c) => c.field)], ["edited", ["Acceptance criteria"]]);
    assert.match(last.note, /earlier text/);
  });

  it("a person's own item has origin human, starts as a draft, and says who added it", () => {
    const { a } = seeded();
    const id = runAs(anna, () => addPlanItem(a, { title: "Check the empty state", steps: ["Open the list"] }));
    assert.match(id, /^H-\d+$/);
    const x = plan(a).planItems.find((i) => i.sourceId === id)!;
    assert.deepEqual([x.origin, x.status, x.editedBy], ["human", "draft", "Anna Berg"]);
    assert.deepEqual(planHistory(a).filter((h) => h.sourceId === id).map((h) => h.kind), ["created"]);
    assert.throws(() => runAs(anna, () => addPlanItem(a, { title: " " })), /needs a title/);
  });

  it("a rejected item is left out of the requirement's own view", () => {
    const p = proj();
    db.prepare("INSERT INTO requirements (project_id, number, title) VALUES (?, 1, 'Req')").run(p.id);
    const q = (db.prepare("SELECT id FROM requirements WHERE project_id = ?").get(p.id) as { id: number }).id;
    send(p, [item({ refs: { requirements: ["REQ-1"] } })]);
    assert.equal(planForRequirement(q).planItems.length, 1);
    runAs(anna, () => decidePlanItem(audit(p), "TPI-001", "rejected"));
    assert.equal(planForRequirement(q).planItems.length, 0);
  });
});

describe("an import never overwrites what a person owns", () => {
  let ida!: AccountUser;
  before(() => { ida = user("Ida Import"); });
  const changed = { title: "Add a todo (agent's new wording)", steps: ["Agent step"] };

  for (const how of ["edited", "approved", "rejected", "saved as draft"] as const) {
    it(`an item a person ${how} keeps its text, and the agent's newer version waits with a diff`, () => {
      const { p, a } = seeded();
      runAs(ida, () => { if (how === "edited") editPlanItem(a, "TPI-001", { title: "My title" }); else decidePlanItem(a, "TPI-001", how === "approved" ? "approved" : how === "rejected" ? "rejected" : "draft"); });
      const before = row(a, "TPI-001")!;
      send(p, [item(changed)]);
      const after = row(a, "TPI-001")!;
      assert.deepEqual([after.title, after.steps, after.review_status], [before.title, before.steps, before.review_status], "the text and status are untouched");
      const x = plan(a).planItems[0];
      assert.equal(x.pending?.removed, false);
      assert.ok(x.pending!.changes.some((c) => c.field === "Title" && c.to === changed.title));
      assert.equal(planHistory(a).at(-1)!.kind, "agent_sent");
    });
  }

  it("an item nobody has touched is updated by the import, and the history says the agent did it", () => {
    const { p, a } = seeded();
    send(p, [item(changed)]);
    assert.equal(row(a, "TPI-001")!.title, changed.title);
    assert.equal(row(a, "TPI-001")!.review_status, "proposed");
    assert.deepEqual(planHistory(a).map((h) => h.kind), ["agent_import", "agent_import"]);
  });

  it("the preview says how many items are kept with the agent's version waiting, and writes nothing", () => {
    const { p, a } = seeded(item(), item({ sourceId: "TPI-002", title: "Second" }));
    runAs(ida, () => editPlanItem(a, "TPI-001", { title: "Mine" }));
    const before = JSON.stringify(plan(a));
    const dry = send(p, [item(changed), item({ sourceId: "TPI-002", title: "Second" })], { dryRun: true });
    assert.deepEqual(dry.testPlan.planItems.counts, { new: 0, unchanged: 1, updated: 0, removed: 0, pending: 1 });
    assert.equal(dry.testPlan.planItems.items.find((i) => i.sourceId === "TPI-001")!.action, "pending");
    assert.equal(JSON.stringify(plan(a)), before, "a dry run writes nothing");
  });

  it("Apply takes the agent's version as a draft to approve again; Ignore keeps the item and the same version is not offered again", () => {
    const { p, a } = seeded();
    runAs(ida, () => decidePlanItem(a, "TPI-001", "approved"));
    send(p, [item(changed)]);
    runAs(ida, () => resolvePending(a, "TPI-001", "ignore"));
    assert.equal(plan(a).planItems[0].pending, null);
    assert.equal(row(a, "TPI-001")!.title, "Add a todo", "kept");
    send(p, [item(changed)]);
    assert.equal(plan(a).planItems[0].pending, null, "the ignored version is not offered again");
    send(p, [item({ title: "Yet another wording" })]);
    assert.ok(plan(a).planItems[0].pending, "a different version is");
    runAs(ida, () => resolvePending(a, "TPI-001", "apply"));
    const r = row(a, "TPI-001")!;
    assert.deepEqual([r.title, r.review_status, r.pending_json, r.edited_by], ["Yet another wording", "draft", null, "Ida Import"]);
    assert.deepEqual(planHistory(a).map((h) => h.kind).slice(-4), ["agent_sent", "ignored_agent", "agent_sent", "applied_agent"]);
    assert.throws(() => runAs(ida, () => resolvePending(a, "TPI-001", "apply")), /has not sent a newer version/);
  });

  it("an item the agent leaves out is removed only if nobody owns it; an owned one is kept with the removal waiting", () => {
    const { p, a } = seeded(item(), item({ sourceId: "TPI-002", title: "Second" }), item({ sourceId: "TPI-003", title: "Third" }));
    runAs(ida, () => editPlanItem(a, "TPI-002", { title: "Second, mine" }));
    const dry = send(p, [item({ sourceId: "TPI-001" })], { dryRun: true });
    assert.deepEqual([dry.testPlan.planItems.counts.removed, dry.testPlan.planItems.counts.pending, dry.testPlan.planItems.waiting], [1, 1, ["TPI-002"]]);
    send(p, [item({ sourceId: "TPI-001" })]);
    assert.equal(row(a, "TPI-003"), undefined, "the untouched one is gone");
    assert.equal(row(a, "TPI-002")!.title, "Second, mine", "the owned one stays");
    assert.deepEqual(plan(a).planItems.find((i) => i.sourceId === "TPI-002")!.pending, { removed: true, changes: [] });
    runAs(ida, () => resolvePending(a, "TPI-002", "ignore"));
    assert.ok(row(a, "TPI-002"), "ignoring the removal keeps it");
    send(p, [item({ sourceId: "TPI-001" })]);
    assert.ok(plan(a).planItems.find((i) => i.sourceId === "TPI-002")!.pending, "the agent's plan still leaves it out, so the removal waits again");
    runAs(ida, () => resolvePending(a, "TPI-002", "apply"));
    assert.equal(row(a, "TPI-002"), undefined, "applying the removal removes it");
    assert.equal(planHistory(a).at(-1)!.kind, "removed_by_agent", "and the history still says so");
  });

  it("an empty test-plan.json removes what nobody owns and nothing else", () => {
    const { p, a } = seeded(item(), item({ sourceId: "TPI-002", title: "Second" }));
    runAs(ida, () => decidePlanItem(a, "TPI-001", "approved"));
    const mine = runAs(ida, () => addPlanItem(a, { title: "My own" }));
    send(p, []);
    assert.deepEqual(plan(a).planItems.map((i) => i.sourceId).sort(), [mine, "TPI-001"].sort());
    assert.equal(row(a, "TPI-001")!.review_status, "approved");
    assert.deepEqual(plan(a).planItems.find((i) => i.sourceId === "TPI-001")!.pending, { removed: true, changes: [] });
  });

  it("a package without test-plan.json leaves the plan alone", () => {
    const { p, a } = seeded();
    runAs(ida, () => editPlanItem(a, "TPI-001", { title: "Mine" }));
    send(p, undefined);
    assert.deepEqual([row(a, "TPI-001")!.title, row(a, "TPI-001")!.pending_json], ["Mine", null]);
  });

  it("a person's own item is never replaced or removed: the same id from the agent waits, a similar one is a separate proposal", () => {
    const { p, a } = seeded();
    const mine = runAs(ida, () => addPlanItem(a, { title: "Check the empty state" }));
    send(p, [item(), item({ sourceId: mine, title: "Agent's idea with my id" }), item({ sourceId: "TPI-009", title: "Check the empty state" })]);
    const own = plan(a).planItems.find((i) => i.sourceId === mine)!;
    assert.deepEqual([own.title, own.origin, own.pending?.changes.some((c) => c.to === "Agent's idea with my id")], ["Check the empty state", "human", true]);
    const similar = plan(a).planItems.find((i) => i.sourceId === "TPI-009")!;
    assert.deepEqual([similar.origin, similar.status], ["agent", "proposed"]);
    send(p, [item()]);
    assert.ok(row(a, mine), "and a later plan without it does not remove it");
    assert.equal(plan(a).planItems.find((i) => i.sourceId === mine)!.pending?.removed, false, "no removal is proposed for a person's own item; the earlier waiting version stays");
  });
});

describe("with accounts, a decision needs an account in the database itself", () => {
  it("the database refuses an approve, a reject or a draft without an account, however it is made", () => {
    const { a } = seeded();
    for (const to of ["approved", "rejected", "draft"]) {
      assert.throws(() => db.prepare("UPDATE audit_plan_items SET review_status = ? WHERE audit_id = ? AND source_id = 'TPI-001'").run(to, a), /needs a person with an account/, to);
    }
    assert.throws(() => decidePlanItem(a, "TPI-001", "approved"), /needs a person with an account/, "the function, run without a person");
    assert.throws(() => editPlanItem(a, "TPI-001", { title: "Nobody's edit" }), /needs a person with an account/);
    assert.throws(() => addPlanItem(a, { title: "Nobody's item" }), /needs a person with an account/);
    assert.throws(() => db.prepare("INSERT INTO audit_plan_items (audit_id, source_id, position, title, review_status) VALUES (?, 'X', 9, 't', 'approved')").run(a), /needs a person with an account/);
    assert.equal(row(a, "TPI-001")!.review_status, "proposed");
  });

  it("an import is not a person: it never makes an item anything but a proposal, and leaves no decision", () => {
    const p = proj();
    send(p, [item(), item({ sourceId: "TPI-002", title: "Second" })]);
    send(p, [item({ title: "Reworded" })]);
    const rows = db.prepare("SELECT review_status AS s, decided_by AS d, decided_by_user_id AS u, edited_by AS e FROM audit_plan_items WHERE audit_id = ?").all(audit(p));
    assert.ok(rows.every((r: any) => r.s === "proposed" && !r.d && r.u === null && !r.e), JSON.stringify(rows));
  });

  it("no code but the person's functions writes a plan item's status, and the import writes no decision", () => {
    const dir = join(import.meta.dirname, "..", "server");
    const src = readFileSync(join(dir, "auditplan.ts"), "utf8");
    const store = src.slice(src.indexOf("function reconcile"), src.indexOf("export const planCounts")); // the import: reconcile and storeTestPlan
    assert.ok(store.length > 500);
    assert.doesNotMatch(store, /review_status\s*=|decided_by|edited_by\s*=|origin\s*=\s*'human'/, "the import never decides, edits or claims an item");
    assert.doesNotMatch(store, /DELETE FROM audit_plan_items WHERE audit_id/, "and never clears the whole plan");
    for (const f of ["audits.ts", "index.ts", "manualtests.ts", "ci.ts", "observations.ts"]) {
      assert.doesNotMatch(readFileSync(join(dir, f), "utf8"), /audit_plan_items SET[^;`]*review_status/, f);
    }
  });
});
