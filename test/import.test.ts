import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db } from "../server/db.ts";
import { importReport, relinkAutomatedTests } from "../server/importers/import.ts";
import { parseReport } from "../server/importers/parse.ts";
import { createRequirement } from "../server/requirements.ts";
import { makeCase, makeProject, playwrightJson } from "./helpers.ts";

const importTitles = (projectId: number, titles: string[], externalId?: string) =>
  importReport(parseReport(playwrightJson(titles)), { projectId, source: "upload", title: "run", externalId });

const linkedCase = (projectId: number, titleStart: string) =>
  (db.prepare("SELECT case_id FROM automated_tests WHERE project_id = ? AND title LIKE ?").get(projectId, `${titleStart}%`) as { case_id: number | null }).case_id;

describe("importing a run", () => {
  const p = makeProject("D");
  const c1 = makeCase(p.id, "Add competitor");
  const c2 = makeCase(p.id, "Remove competitor");

  it("links tests to cases by the ID in the name, including 'D-1: title'", () => {
    const r = importTitles(p.id, ["D-1: Add competitor", "[D-2] Remove competitor", "no id at all", "OTHER-1 wrong project key", "D-99 case that does not exist"]);
    assert.equal(r.total, 5);
    assert.equal(r.linked, 2);
    assert.equal(linkedCase(p.id, "D-1"), c1.id);
    assert.equal(linkedCase(p.id, "[D-2]"), c2.id);
    assert.equal(linkedCase(p.id, "no id"), null);
    assert.equal(linkedCase(p.id, "OTHER-1"), null);
    assert.equal(linkedCase(p.id, "D-99"), null);
  });

  it("puts the case on the result so the case's history shows it", () => {
    const row = db.prepare("SELECT COUNT(*) AS n FROM results WHERE case_id = ?").get(c1.id) as { n: number };
    assert.equal(row.n, 1);
  });

  it("does not import the same external run twice", () => {
    const first = importTitles(p.id, ["D-1: Add competitor"], "gh-123");
    const again = importTitles(p.id, ["D-1: Add competitor"], "gh-123");
    assert.equal(first.duplicate, false);
    assert.equal(again.duplicate, true);
    assert.equal(again.runId, first.runId);
  });
});

describe("relinkAutomatedTests", () => {
  it("links tests imported before their case existed, and fills in their old results", () => {
    const p = makeProject("R");
    importTitles(p.id, ["R-1: Add competitor", "R-2: Remove competitor"]);
    assert.equal(linkedCase(p.id, "R-1"), null);

    const c1 = makeCase(p.id, "Add competitor");
    assert.equal(relinkAutomatedTests(p.id), 1); // only R-1 exists so far
    assert.equal(linkedCase(p.id, "R-1"), c1.id);
    assert.equal(linkedCase(p.id, "R-2"), null);
    const old = db.prepare("SELECT COUNT(*) AS n FROM results r JOIN automated_tests a ON a.id = r.automated_test_id WHERE a.title LIKE 'R-1%' AND r.case_id = ?").get(c1.id) as { n: number };
    assert.equal(old.n, 1);

    const c2 = makeCase(p.id, "Remove competitor");
    assert.equal(relinkAutomatedTests(p.id), 1);
    assert.equal(linkedCase(p.id, "R-2"), c2.id);
    assert.equal(relinkAutomatedTests(p.id), 0); // nothing left to do
  });

  it("never changes a test that is already linked", () => {
    const p = makeProject("K");
    const a = makeCase(p.id, "A");
    const b = makeCase(p.id, "B");
    importTitles(p.id, ["K-1: something"]);
    db.prepare("UPDATE automated_tests SET case_id = ? WHERE project_id = ?").run(b.id, p.id); // linked by hand to K-2
    assert.equal(relinkAutomatedTests(p.id), 0);
    assert.equal(linkedCase(p.id, "K-1"), b.id);
    assert.notEqual(a.id, b.id);
  });
});

describe("@REQ tags on automated tests", () => {
  it("cover the requirement through the linked case", () => {
    const p = makeProject("Q");
    makeCase(p.id, "Add competitor");
    const req = createRequirement(p.id, { title: "Users can add competitors" });
    importTitles(p.id, ["Q-1 @REQ-1 adds a competitor", "@REQ-1 unlinked test"]);
    const links = db.prepare("SELECT case_id FROM requirement_cases WHERE requirement_id = ?").all(req) as { case_id: number }[];
    assert.equal(links.length, 1); // the unlinked test has no case, so it adds nothing
  });
});
