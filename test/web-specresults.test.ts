import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareView, lineSummary, resultBadge, shortHash } from "../web/src/specresults.ts";

// The words on the screen for the results of a spec and for the outcome of a comparison. A word and an icon say it; the colour is never the only signal.
const R = (o: Partial<{ tests: number; passed: number; failed: number; skipped: number; blocked: number }>) => ({ tests: 0, passed: 0, failed: 0, skipped: 0, blocked: 0, ...o });

describe("the badge in the list", () => {
  it("says no results, 1 failed, passed", () => {
    assert.equal(resultBadge(R({})).label, "no results");
    assert.deepEqual([resultBadge(R({ tests: 3, passed: 2, failed: 1 })).label, resultBadge(R({ tests: 3, passed: 2, failed: 1 })).tone], ["1 failed", "fail"]);
    assert.deepEqual([resultBadge(R({ tests: 2, passed: 2 })).label, resultBadge(R({ tests: 2, passed: 2 })).tone], ["passed", "ok"]);
  });
  it("a failure beats a block, a block beats a pass, and a run of only skipped tests is not passed", () => {
    assert.equal(resultBadge(R({ tests: 4, failed: 2, blocked: 1, passed: 1 })).label, "2 failed");
    assert.equal(resultBadge(R({ tests: 2, blocked: 1, passed: 1 })).label, "1 blocked");
    assert.equal(resultBadge(R({ tests: 2, skipped: 2 })).label, "skipped");
    assert.equal(resultBadge(R({ tests: 1 })).label, "no status");
  });
  it("every look has an icon, so the colour is not the only signal", () => {
    for (const r of [R({}), R({ tests: 1, failed: 1 }), R({ tests: 1, blocked: 1 }), R({ tests: 1, passed: 1 }), R({ tests: 1, skipped: 1 }), R({ tests: 1 })]) assert.ok(resultBadge(r).icon);
  });
});

describe("the outcome of a comparison", () => {
  it("offers the repo's version when the bytes differ (also by line endings only), and not when they are the same", () => {
    assert.equal(compareView("same").canUse, false);
    assert.equal(compareView("same except line endings").canUse, true);
    assert.equal(compareView("differs").canUse, true);
    assert.notEqual(compareView("same").text, compareView("same except line endings").text);
  });
  it("sums up the lines, and says about when the count is approximate", () => {
    assert.equal(lineSummary(2, 1, false), "2 lines added, 1 line removed");
    assert.equal(lineSummary(1, 0, false), "1 line added, 0 lines removed");
    assert.equal(lineSummary(1200, 900, true), "about 1200 lines added, about 900 lines removed");
  });
  it("shortens a hash for reading", () => assert.equal(shortHash("a".repeat(64)), "a".repeat(12)));
});
