import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db } from "../server/db.ts";
import { makeCase, makeProject } from "./helpers.ts";
import { bagFromFiles } from "../server/importers/bag.ts";
import { importAuditPackage } from "../server/audits.ts";
import { createCaseFromProposal, reviewManualTest } from "../server/manualtests.ts";
import { duplicateCase } from "../server/casebulk.ts";
import { isNewCase, listCases, NEW_CASE_WINDOW_DAYS } from "../server/newcases.ts";

let n = 0;
const proj = () => makeProject(`NC${++n}`, `New cases ${n}`);
const NOW = new Date("2026-11-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
/** A SQLite UTC timestamp ("2026-11-03 12:00:00") this many milliseconds before NOW. */
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString().slice(0, 19).replace("T", " ");
const aged = (p: { id: number }, title: string, ms: number) => {
  const c = makeCase(p.id, title);
  db.prepare("UPDATE cases SET created_at = ? WHERE id = ?").run(ago(ms), c.id);
  return c;
};
const newTitles = (p: { id: number }) => listCases(p.id, NOW).filter((c) => c.is_new).map((c) => c.title).sort();

describe("new test cases", () => {
  it("the window is 7 days", () => assert.equal(NEW_CASE_WINDOW_DAYS, 7));

  it("a case created within 7 days is New and an older one is not", () => {
    const p = proj();
    aged(p, "today", 0);
    aged(p, "3 days", 3 * DAY);
    aged(p, "6 days 23 h", 7 * DAY - 3600_000);
    aged(p, "8 days", 8 * DAY);
    aged(p, "30 days", 30 * DAY);
    assert.deepEqual(newTitles(p), ["3 days", "6 days 23 h", "today"]);
  });

  it("the boundary is inclusive and exact: 7 days counts, one second more does not", () => {
    assert.equal(isNewCase(ago(7 * DAY), NOW), true);
    assert.equal(isNewCase(ago(7 * DAY + 1000), NOW), false);
    assert.equal(isNewCase(ago(7 * DAY - 1000), NOW), true);
    const p = proj();
    aged(p, "on the line", 7 * DAY);
    aged(p, "just past", 7 * DAY + 1000);
    assert.deepEqual(newTitles(p), ["on the line"]);
  });

  it("the time is read at display time, so the same case stops being New as time passes", () => {
    const p = proj();
    aged(p, "c", 6 * DAY);
    assert.equal(listCases(p.id, NOW)[0].is_new, true);
    assert.equal(listCases(p.id, new Date(NOW.getTime() + 2 * DAY))[0].is_new, false);
  });

  it("editing a case does not make it New: only created_at counts", () => {
    const p = proj();
    const c = aged(p, "old but edited", 20 * DAY);
    db.prepare("UPDATE cases SET updated_at = ?, title = 'old but edited' WHERE id = ?").run(ago(0), c.id);
    assert.deepEqual(newTitles(p), []);
  });

  it("a copy is New, the original it was copied from is not", () => {
    const p = proj();
    const orig = aged(p, "original", 40 * DAY);
    const copyId = duplicateCase(orig.id);
    const rows = listCases(p.id); // the copy was created now, in real time
    assert.equal(rows.find((r) => r.id === orig.id)!.is_new, false);
    assert.equal(rows.find((r) => r.id === copyId)!.is_new, true);
  });

  it("a case made from an agent proposal is flagged, and is New only if created within the window", () => {
    const p = proj();
    const f = new Map<string, Uint8Array>();
    f.set("manifest.json", Buffer.from(JSON.stringify({ format: "testbench-audit-package", version: 1, audit: { id: "a1", title: "A", project: p.key, agent: { name: "a", version: "1" } }, files: [], parts: {} })));
    f.set("bugs.json", Buffer.from(JSON.stringify({ version: 1, bugs: [] })));
    f.set("manual-tests.json", Buffer.from(JSON.stringify({ version: 1, tests: ["P1", "P2"].map((s) => ({ sourceId: s, title: `Proposal ${s}`, description: "d", preconditions: "", steps: ["Do"], expected: "Ok", priority: "high", category: "functional" })) })));
    importAuditPackage(bagFromFiles(f), { projectId: p.id, source: "upload" });
    const ids = (db.prepare("SELECT id, source_id FROM manual_tests WHERE project_id = ? ORDER BY source_id").all(p.id) as { id: number; source_id: string }[]);
    const made = ids.map((m) => { reviewManualTest(m.id, "accepted"); return createCaseFromProposal(m.id).caseId; });
    db.prepare("UPDATE cases SET created_at = ? WHERE id = ?").run(ago(30 * DAY), made[1]);
    const rows = listCases(p.id);
    const r0 = rows.find((r) => r.id === made[0])!;
    const r1 = rows.find((r) => r.id === made[1])!;
    assert.deepEqual([r0.from_proposal, r0.is_new], [true, true], "created now from a proposal");
    assert.deepEqual([r1.from_proposal, r1.is_new], [true, false], "the proposal still exists but the case is old");
    assert.equal(makeCase(p.id, "by hand").id > 0 && listCases(p.id).find((r) => r.title === "by hand")!.from_proposal, false);
  });

  it("is per project and the count follows the list", () => {
    const a = proj();
    const b = proj();
    aged(a, "a-new", 1 * DAY);
    aged(a, "a-old", 20 * DAY);
    aged(b, "b-old", 20 * DAY);
    assert.deepEqual(newTitles(a), ["a-new"]);
    assert.deepEqual(newTitles(b), []);
    assert.equal(listCases(a.id, NOW).filter((c) => c.is_new).length, 1);
  });

  it("the list, its order and the existing fields are what they were", () => {
    const p = proj();
    const c1 = aged(p, "one", 0);
    const c2 = aged(p, "two", 50 * DAY);
    db.prepare("UPDATE cases SET position = 5 WHERE id = ?").run(c1.id);
    db.prepare("UPDATE cases SET position = 1, status = 'draft' WHERE id = ?").run(c2.id);
    const expected = db.prepare("SELECT id FROM cases WHERE project_id = ? ORDER BY position, number").all(p.id) as { id: number }[];
    const rows = listCases(p.id, NOW);
    assert.deepEqual(rows.map((r) => r.id), expected.map((e) => e.id));
    assert.deepEqual(rows.map((r) => r.status), ["draft", "ready"]);
    for (const k of ["automated_count", "step_count", "requirement_count", "last_status", "suite_name", "tags"]) assert.ok(k in rows[0], `${k} is still there`);
  });
});
