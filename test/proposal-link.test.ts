import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db } from "../server/db.ts";
import { makeCase, makeProject } from "./helpers.ts";
import { bagFromFiles } from "../server/importers/bag.ts";
import { importAuditPackage } from "../server/audits.ts";
import { createCaseFromProposal, getManualTest, reviewManualTest } from "../server/manualtests.ts";
import { listCases } from "../server/newcases.ts";
import { filterCases, openedFromProposal, proposalCaseLink, type CaseFilters } from "../web/src/caseFilter.ts";
import type { CaseSummary } from "../web/src/api.ts";

let n = 0;
const proj = () => makeProject(`PL${++n}`, `Proposal link ${n}`);
const base: CaseFilters = { tab: "all", onlyNew: false, onlyProposal: false, search: "" };

function proposals(p: { id: number; key: string }, sourceIds: string[]) {
  const f = new Map<string, Uint8Array>();
  f.set("manifest.json", Buffer.from(JSON.stringify({ format: "testbench-audit-package", version: 1, audit: { id: `a-${p.key}`, title: "A", project: p.key, agent: { name: "a", version: "1" } }, files: [], parts: {} })));
  f.set("bugs.json", Buffer.from(JSON.stringify({ version: 1, bugs: [] })));
  f.set("manual-tests.json", Buffer.from(JSON.stringify({ version: 1, tests: sourceIds.map((s) => ({ sourceId: s, title: `Proposal ${s}`, description: "d", preconditions: "", steps: ["Do"], expected: "Ok", priority: "high", category: "functional" })) })));
  importAuditPackage(bagFromFiles(f), { projectId: p.id, source: "upload" });
  return Object.fromEntries((db.prepare("SELECT id, source_id FROM manual_tests WHERE project_id = ?").all(p.id) as { id: number; source_id: string }[]).map((m) => [m.source_id, m.id]));
}

describe("the link from a proposal to its test case", () => {
  it("goes to the Cases page of the same project with the case selected, and asks for the From agent proposal switch", () => {
    assert.deepEqual(proposalCaseLink(7, 12), { to: "/p/7/cases?case=12", state: { fromProposal: true } });
    assert.deepEqual(proposalCaseLink("3", 5), { to: "/p/3/cases?case=5", state: { fromProposal: true } });
  });

  it("a proposal without a test case gets no link", () => {
    assert.equal(proposalCaseLink(7, null), null);
    assert.equal(proposalCaseLink(7, undefined), null);
    const p = proj();
    const ids = proposals(p, ["NOCASE"]);
    assert.equal(getManualTest(ids.NOCASE).testCase, null, "the detail has no test case");
    assert.equal(proposalCaseLink(p.id, getManualTest(ids.NOCASE).testCase?.id), null);
  });

  it("the page turns the switch on only for exactly that state", () => {
    assert.equal(openedFromProposal({ fromProposal: true }), true);
    for (const other of [undefined, null, {}, "fromProposal", 1, { fromProposal: "yes" }, { fromProposal: false }, [true]]) assert.equal(openedFromProposal(other), false, JSON.stringify(other));
  });

  it("the case it points at is in the filtered list, also with New, a tab and a search on, and keeps its place in the order", () => {
    const p = proj();
    const ids = proposals(p, ["A", "B", "C"]);
    for (const id of Object.values(ids)) reviewManualTest(id, "accepted");
    const target = createCaseFromProposal(ids.B);
    createCaseFromProposal(ids.A);
    makeCase(p.id, "By hand");
    const link = proposalCaseLink(p.id, getManualTest(ids.B).testCase?.id)!;
    assert.equal(link.to, `/p/${p.id}/cases?case=${target.caseId}`);
    const list = listCases(p.id) as unknown as CaseSummary[];
    const on = { ...base, onlyProposal: openedFromProposal(link.state) };
    const ofIds = (f: CaseFilters) => filterCases(list, f).map((c) => c.id);
    assert.ok(ofIds(on).includes(target.caseId), "visible with the switch on");
    assert.equal(ofIds(on).length, 2, "only the two cases made from proposals");
    assert.ok(ofIds({ ...on, onlyNew: true }).includes(target.caseId), "with New");
    assert.ok(ofIds({ ...on, tab: "manual" }).includes(target.caseId), "with a tab");
    assert.ok(ofIds({ ...on, search: "proposal b" }).includes(target.caseId), "with a search");
    assert.deepEqual(ofIds({ ...on, search: "by hand" }), [], "a search that does not match still works");
    const order = list.map((c) => c.id);
    assert.deepEqual(ofIds(on), order.filter((id) => ofIds(on).includes(id)), "same order as the list");
  });

  it("a case from another project is not selected through the link of this one", () => {
    const a = proj();
    const b = proj();
    const ia = proposals(a, ["X"]);
    reviewManualTest(ia.X, "accepted");
    const made = createCaseFromProposal(ia.X);
    const listB = listCases(b.id) as unknown as CaseSummary[];
    assert.equal(filterCases(listB, { ...base, onlyProposal: true }).some((c) => c.id === made.caseId), false);
  });
});
