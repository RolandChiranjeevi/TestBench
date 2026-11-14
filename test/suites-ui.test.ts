import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db } from "../server/db.ts";
import { listCases } from "../server/newcases.ts";
import { automationByCase } from "../server/runsuites.ts";
import { AUTOMATION_LABEL, automationOf, lastAutomatedText, suiteDriftText } from "../web/src/automation.ts";
import { casesInFolder, folderScope } from "../web/src/folders.ts";
import { makeCase, makeProject } from "./helpers.ts";

// The words and the small rules the suite screens use (web/src/automation.ts, web/src/folders.ts), without a browser. The screens themselves are checked by
// scripts/check-roles-ui.mjs (buttons per role) and check-contrast / check-layout (the Suites tab is one of the pages they open).

describe("what the case list says about automation", () => {
  it("manual without a linked test, automated with tests and no steps, both with tests and steps", () => {
    assert.equal(automationOf({ automated_count: 0, step_count: 0 }), "manual");
    assert.equal(automationOf({ automated_count: 0, step_count: 5 }), "manual");
    assert.equal(automationOf({ automated_count: 2, step_count: 0 }), "automated");
    assert.equal(automationOf({ automated_count: 1, step_count: 3 }), "both");
    assert.deepEqual(Object.values(AUTOMATION_LABEL), ["Manual", "Automated", "Manual + automated"]);
  });

  it("is the same answer as the server gives for suites and runs, for the same cases", () => {
    const p = makeProject(`U${Math.random().toString(36).slice(2, 6).toUpperCase()}`);
    const manual = makeCase(p.id, "Manual", { steps: [["a", "b"]] });
    const both = makeCase(p.id, "Both", { steps: [["a", "b"], ["c", "d"]] });
    const auto = makeCase(p.id, "Auto");
    const link = (caseId: number, n: number) => {
      for (let i = 0; i < n; i++) db.prepare("INSERT INTO automated_tests (project_id, framework, title, full_name, case_id) VALUES (?, 'playwright', 't', ?, ?)").run(p.id, `t-${Math.random()}`, caseId);
    };
    link(both.id, 1);
    link(auto.id, 2);
    const server = automationByCase(p.id, [manual.id, both.id, auto.id]);
    for (const c of listCases(p.id)) {
      const mine = automationOf(c as unknown as { automated_count: number; step_count: number });
      assert.equal(mine, server.get(c.id)?.automation, `case ${c.number}`);
      assert.equal(c.automated_count, server.get(c.id)?.automatedTests, `case ${c.number}: number of tests`);
    }
  });
});

describe("what a run says about its suite", () => {
  const info = (over: Partial<Parameters<typeof suiteDriftText>[0]> = {}) => ({ deleted: false, partial: false, added: 0, removed: 0, ...over });

  it("says nothing when the suite is as it was", () => assert.equal(suiteDriftText(info()), null));

  it("counts cases added and removed since the run, in plain words", () => {
    assert.equal(suiteDriftText(info({ added: 2, removed: 1 })), "2 cases added to the suite and 1 removed since this run");
    assert.equal(suiteDriftText(info({ added: 1 })), "1 case added to the suite since this run");
    assert.equal(suiteDriftText(info({ added: 3 })), "3 cases added to the suite since this run");
    assert.equal(suiteDriftText(info({ removed: 1 })), "1 case removed from the suite since this run");
    assert.equal(suiteDriftText(info({ removed: 4 })), "4 cases removed from the suite since this run");
  });

  it("says nothing about a run that covered only part of the suite on purpose, or about a suite that is gone", () => {
    assert.equal(suiteDriftText(info({ partial: true, added: 5 })), null);
    assert.equal(suiteDriftText(info({ deleted: true, added: 5, removed: 5 })), null);
  });

  it("the last automated result is one short phrase: the status, and how many tests when there are several", () => {
    assert.equal(lastAutomatedText({ status: "failed", at: "2026-11-05 09:00:00", runId: 1, tests: 1 }), "failed");
    assert.equal(lastAutomatedText({ status: "passed", at: "2026-11-05 09:00:00", runId: 1, tests: 3 }), "passed · 3 tests");
  });
});

describe("the cases of a folder", () => {
  const folders = [
    { id: 1, parent_id: null }, { id: 2, parent_id: 1 }, { id: 3, parent_id: 2 }, { id: 4, parent_id: null }, { id: 5, parent_id: 4 },
  ];
  const cases = [
    { id: 10, suite_id: 1 }, { id: 11, suite_id: 3 }, { id: 12, suite_id: 5 }, { id: 13, suite_id: null }, { id: 14, suite_id: 2 },
  ];

  it("a folder and everything below it, however deep", () => {
    assert.deepEqual([...folderScope(folders, 1)].sort(), [1, 2, 3]);
    assert.deepEqual([...folderScope(folders, 2)].sort(), [2, 3]);
    assert.deepEqual([...folderScope(folders, 3)], [3]);
    assert.deepEqual([...folderScope(folders, 4)].sort(), [4, 5]);
  });

  it("only the folder itself when asked not to include subfolders", () => assert.deepEqual([...folderScope(folders, 1, false)], [1]));

  it("its cases, in the order given; a case with no folder is in none", () => {
    assert.deepEqual(casesInFolder(cases, folders, 1).map((c) => c.id), [10, 11, 14]);
    assert.deepEqual(casesInFolder(cases, folders, 1, false).map((c) => c.id), [10]);
    assert.deepEqual(casesInFolder(cases, folders, 4).map((c) => c.id), [12]);
    assert.deepEqual(casesInFolder(cases, folders, 99).map((c) => c.id), []);
  });
});

import { describeSchedule, fromCron, toCron, DEFAULT_FORM } from "../web/src/schedule.ts";

describe("the schedule form (web/src/schedule.ts)", () => {
  it("makes the cron of a daily or weekly time, and Mon-Fri as 1-5", () => {
    assert.equal(toCron({ ...DEFAULT_FORM, preset: "daily", time: "06:05" }), "5 6 * * *");
    assert.equal(toCron({ ...DEFAULT_FORM, preset: "weekly", time: "08:00", days: [5, 1, 2, 4, 3] }), "0 8 * * 1-5");
    assert.equal(toCron({ ...DEFAULT_FORM, preset: "weekly", time: "14:30", days: [0, 3, 1] }), "30 14 * * 1,3,0");
    assert.equal(toCron({ ...DEFAULT_FORM, preset: "weekly", time: "09:00", days: [0, 1, 2, 3, 4, 5, 6] }), "0 9 * * *");
  });

  it("is empty while it is not complete", () => {
    assert.equal(toCron({ ...DEFAULT_FORM, time: "" }), "");
    assert.equal(toCron({ ...DEFAULT_FORM, time: "25:00" }), "");
    assert.equal(toCron({ ...DEFAULT_FORM, days: [] }), "");
    assert.equal(toCron({ ...DEFAULT_FORM, preset: "custom", cron: "  " }), "");
  });

  it("reads back what it wrote, and shows anything else as Custom, untouched", () => {
    for (const f of [
      { ...DEFAULT_FORM, preset: "daily" as const, time: "06:05" },
      { ...DEFAULT_FORM, preset: "weekly" as const, time: "08:00", days: [1, 2, 3, 4, 5] },
      { ...DEFAULT_FORM, preset: "weekly" as const, time: "14:30", days: [1, 3, 0] },
    ]) {
      const back = fromCron(toCron(f));
      assert.equal(toCron(back), toCron(f));
      assert.equal(back.preset, f.preset);
    }
    for (const odd of ["*/20 * * * *", "0 8 1 * *", "0 8 * * 7", "61 8 * * *", "0 8-18 * * 1-5", "0 8 * * MON"]) {
      const f = fromCron(odd);
      assert.equal(f.preset, "custom");
      assert.equal(toCron(f), odd);
    }
  });

  it("describes a schedule in words, and a custom one as it is", () => {
    assert.equal(describeSchedule("0 8 * * 1-5", "Europe/Stockholm"), "Weekdays 08:00 (Europe/Stockholm)");
    assert.equal(describeSchedule("30 14 * * 1,3", "UTC"), "Mon, Wed 14:30 (UTC)");
    assert.equal(describeSchedule("5 6 * * *", "UTC"), "Every day 06:05 (UTC)");
    assert.equal(describeSchedule("*/20 * * * *", "UTC"), "*/20 * * * * (UTC)");
  });
});
