import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db } from "../server/db.ts";
import { makeCase, makeProject } from "./helpers.ts";
import { bagFromFiles } from "../server/importers/bag.ts";
import { importAuditPackage } from "../server/audits.ts";
import { createCaseFromProposal, reviewManualTest } from "../server/manualtests.ts";
import { listCases } from "../server/newcases.ts";
import { caseCounts, filterCases, type CaseFilters } from "../web/src/caseFilter.ts";
import type { CaseSummary } from "../web/src/api.ts";

let n = 0;
const proj = () => makeProject(`CF${++n}`, `Case filter ${n}`);
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString().slice(0, 19).replace("T", " ");

/** Imports one audit with the given proposals, accepts them all and makes a test case from each. Returns the case ids by source id. */
function fromProposals(p: { id: number; key: string }, sourceIds: string[]) {
  const f = new Map<string, Uint8Array>();
  f.set("manifest.json", Buffer.from(JSON.stringify({ format: "testbench-audit-package", version: 1, audit: { id: `a-${p.key}`, title: "A", project: p.key, agent: { name: "a", version: "1" } }, files: [], parts: {} })));
  f.set("bugs.json", Buffer.from(JSON.stringify({ version: 1, bugs: [] })));
  f.set("manual-tests.json", Buffer.from(JSON.stringify({ version: 1, tests: sourceIds.map((s) => ({ sourceId: s, title: `Proposal ${s}`, description: "d", preconditions: "", steps: ["Do"], expected: "Ok", priority: "high", category: "functional" })) })));
  importAuditPackage(bagFromFiles(f), { projectId: p.id, source: "upload" });
  const out: Record<string, number> = {};
  for (const m of db.prepare("SELECT id, source_id FROM manual_tests WHERE project_id = ?").all(p.id) as { id: number; source_id: string }[]) {
    reviewManualTest(m.id, "accepted");
    out[m.source_id] = createCaseFromProposal(m.id).caseId;
  }
  return out;
}
const setAge = (id: number, ms: number) => db.prepare("UPDATE cases SET created_at = ? WHERE id = ?").run(ago(ms), id);
const rows = (p: { id: number }) => listCases(p.id) as unknown as CaseSummary[];
const base: CaseFilters = { tab: "all", onlyNew: false, onlyProposal: false, search: "" };
const titles = (list: CaseSummary[]) => list.map((c) => c.title);

describe("the From agent proposal filter", () => {
  it("a case linked from manual_tests.case_id is under it, one without a link is not", () => {
    const p = proj();
    const made = fromProposals(p, ["P1"]);
    const hand = makeCase(p.id, "By hand");
    const list = rows(p);
    assert.deepEqual(titles(filterCases(list, { ...base, onlyProposal: true })), ["Proposal P1"]);
    assert.equal(list.find((c) => c.id === made.P1)!.from_proposal, true);
    assert.equal(list.find((c) => c.id === hand.id)!.from_proposal, false);
  });

  it("a deleted case is no longer listed under it", () => {
    const p = proj();
    const made = fromProposals(p, ["P1"]);
    db.prepare("DELETE FROM cases WHERE id = ?").run(made.P1);
    assert.deepEqual(filterCases(rows(p), { ...base, onlyProposal: true }), []);
  });

  it("combines with New: only cases that are both", () => {
    const p = proj();
    const made = fromProposals(p, ["NEWP", "OLDP"]);
    setAge(made.OLDP, 30 * DAY);
    makeCase(p.id, "New by hand");
    const old = makeCase(p.id, "Old by hand");
    setAge(old.id, 30 * DAY);
    const list = rows(p);
    assert.deepEqual(titles(filterCases(list, { ...base, onlyNew: true })).sort(), ["New by hand", "Proposal NEWP"]);
    assert.deepEqual(titles(filterCases(list, { ...base, onlyProposal: true })).sort(), ["Proposal NEWP", "Proposal OLDP"]);
    assert.deepEqual(titles(filterCases(list, { ...base, onlyNew: true, onlyProposal: true })), ["Proposal NEWP"]);
  });

  it("combines with the tabs and the search", () => {
    const p = proj();
    const made = fromProposals(p, ["LOGIN", "CART"]);
    const req = db.prepare("INSERT INTO requirements (project_id, number, title) VALUES (?, 1, 'R') RETURNING id").get(p.id) as { id: number };
    db.prepare("INSERT INTO requirement_cases (requirement_id, case_id) VALUES (?, ?)").run(req.id, made.CART);
    const hand = makeCase(p.id, "Login by hand");
    const list = rows(p);
    // tab "No requirement": CART is linked to one, LOGIN is not, and the hand-made case is not from a proposal
    assert.deepEqual(titles(filterCases(list, { ...base, tab: "unlinked", onlyProposal: true })), ["Proposal LOGIN"]);
    assert.deepEqual(titles(filterCases(list, { ...base, tab: "manual", onlyProposal: true })).sort(), ["Proposal CART", "Proposal LOGIN"]);
    assert.deepEqual(titles(filterCases(list, { ...base, tab: "automated", onlyProposal: true })), []);
    assert.deepEqual(titles(filterCases(list, { ...base, search: "login" })).sort(), ["Login by hand", "Proposal LOGIN"]);
    assert.deepEqual(titles(filterCases(list, { ...base, search: "login", onlyProposal: true })), ["Proposal LOGIN"]);
    assert.deepEqual(titles(filterCases(list, { ...base, search: `${p.key}-${(db.prepare("SELECT number FROM cases WHERE id = ?").get(hand.id) as { number: number }).number}`, onlyProposal: true })), []);
  });

  it("the count and the filter are the same condition", () => {
    const p = proj();
    const made = fromProposals(p, ["A", "B", "C"]);
    setAge(made.C, 40 * DAY);
    makeCase(p.id, "hand");
    const list = rows(p);
    const counts = caseCounts(list);
    assert.equal(counts.proposal, filterCases(list, { ...base, onlyProposal: true }).length);
    assert.equal(counts.new, filterCases(list, { ...base, onlyNew: true }).length);
    assert.deepEqual([counts.proposal, counts.new, counts.all], [3, 3, 4]);
  });

  it("another project is not affected", () => {
    const a = proj();
    const b = proj();
    fromProposals(a, ["A1", "A2"]);
    makeCase(b.id, "B hand");
    assert.deepEqual(filterCases(rows(b), { ...base, onlyProposal: true }), []);
    assert.equal(caseCounts(rows(b)).proposal, 0);
    assert.equal(caseCounts(rows(a)).proposal, 2);
  });

  it("without the switches the list, its order and the tab counts are what they were", () => {
    const p = proj();
    const made = fromProposals(p, ["X"]);
    const c1 = makeCase(p.id, "c1");
    db.prepare("UPDATE cases SET position = 9 WHERE id = ?").run(made.X);
    db.prepare("UPDATE cases SET position = 2, status = 'deprecated' WHERE id = ?").run(c1.id);
    const list = rows(p);
    const expected = (db.prepare("SELECT id FROM cases WHERE project_id = ? ORDER BY position, number").all(p.id) as { id: number }[]).map((r) => r.id);
    assert.deepEqual(filterCases(list, base).map((c) => c.id), expected, "order unchanged");
    assert.deepEqual(filterCases(list, { ...base, onlyProposal: true }).map((c) => c.id), [made.X], "filtering keeps the order and drops only");
    const counts = caseCounts(list);
    assert.deepEqual([counts.all, counts.manual, counts.unlinked], [2, 2, 1], "a deprecated case is not 'No requirement'");
  });
});
