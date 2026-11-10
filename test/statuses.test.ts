import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SEVERITIES, STATUSES } from "../server/observations.ts";
import { WORKFLOW_STATUSES } from "../server/ci.ts";
import { BUG_WORKFLOW_LOOK, CI_STATUS_LOOK, COVERAGE_LOOK, OBSERVATION_STATUS_LOOK, priorityLook, REVIEW_STATUS_LOOK, SEVERITY_LOOK, type BadgeLook } from "../web/src/statuses.ts";

// How a priority, a severity and an observation status look is decided in one place (web/src/statuses.ts). The server owns the lists of allowed values,
// so these tests fail when a value is added there and nobody says what it looks like.

const TONES = ["ok", "fail", "warn", "info", "accent", "crit", "neutral"];
const complete = (l: BadgeLook) => TONES.includes(l.tone) && l.icon.length > 0 && l.label.length > 0;

describe("what a status looks like", () => {
  it("every severity the server allows has a look, and the look has no severity the server does not know", () => {
    assert.deepEqual(Object.keys(SEVERITY_LOOK).sort(), [...SEVERITIES].sort());
  });

  it("every observation status the server allows has a look, and the look has no status the server does not know", () => {
    assert.deepEqual(Object.keys(OBSERVATION_STATUS_LOOK).sort(), [...STATUSES].sort());
  });

  it("every look has a tone, an icon and a word, so colour is never the only signal", () => {
    for (const l of [...Object.values(SEVERITY_LOOK), ...Object.values(OBSERVATION_STATUS_LOOK), priorityLook("P0"), priorityLook("whatever")]) assert.ok(complete(l), JSON.stringify(l));
  });

  it("severity runs from solid red (critical) through red and yellow to neutral (low) and blue (info)", () => {
    assert.deepEqual(["critical", "high", "medium", "low", "info"].map((s) => SEVERITY_LOOK[s as keyof typeof SEVERITY_LOOK].tone), ["crit", "fail", "warn", "neutral", "info"]);
  });

  it("only Resolved is green and only Needs review uses the accent, because the accent means it waits for a person", () => {
    const by = (tone: string) => Object.entries(OBSERVATION_STATUS_LOOK).filter(([, l]) => l.tone === tone).map(([k]) => k);
    assert.deepEqual(by("ok"), ["resolved"]);
    assert.deepEqual(by("accent"), ["needs_review"]);
  });
});

describe("bug reports", () => {
  it("the decision on a report has a look for each of the four values", () => {
    assert.deepEqual(Object.keys(REVIEW_STATUS_LOOK).sort(), ["accepted", "duplicate", "proposed", "rejected"]);
    for (const l of Object.values(REVIEW_STATUS_LOOK)) assert.ok(complete(l), JSON.stringify(l));
  });

  it("proposed is the accent (it waits for a person), accepted is green, rejected and duplicate are neutral and differ without colour", () => {
    assert.equal(REVIEW_STATUS_LOOK.proposed.tone, "accent");
    assert.equal(REVIEW_STATUS_LOOK.accepted.tone, "ok");
    assert.equal(REVIEW_STATUS_LOOK.rejected.tone, "neutral");
    assert.equal(REVIEW_STATUS_LOOK.duplicate.tone, "neutral");
    assert.notEqual(REVIEW_STATUS_LOOK.rejected.icon, REVIEW_STATUS_LOOK.duplicate.icon);
  });

  it("every workflow status the server allows has a look, and the look has none the server does not know", () => {
    assert.deepEqual(Object.keys(BUG_WORKFLOW_LOOK).sort(), [...WORKFLOW_STATUSES].sort());
    for (const l of Object.values(BUG_WORKFLOW_LOOK)) assert.ok(complete(l), JSON.stringify(l));
  });

  it("a test in CI is green when it passed, red when it failed and yellow when it is flaky, each with its own icon", () => {
    assert.deepEqual(["passed", "failed", "flaky"].map((s) => CI_STATUS_LOOK[s as keyof typeof CI_STATUS_LOOK].tone), ["ok", "fail", "warn"]);
    assert.equal(new Set(Object.values(CI_STATUS_LOOK).map((l) => l.icon)).size, 3);
  });
});

describe("requirement coverage", () => {
  it("has a look for each of the five states the server computes", () => {
    assert.deepEqual(Object.keys(COVERAGE_LOOK).sort(), ["failing", "partial", "passing", "uncovered", "untested"]);
    for (const l of Object.values(COVERAGE_LOOK)) assert.ok(complete(l), JSON.stringify(l));
  });

  it("passing is green, failing red, partial yellow, and the two states with nothing to show are neutral", () => {
    assert.deepEqual(["passing", "failing", "partial", "uncovered", "untested"].map((s) => COVERAGE_LOOK[s as keyof typeof COVERAGE_LOOK].tone), ["ok", "fail", "warn", "neutral", "neutral"]);
  });

  it("every state has its own icon, so the neutral ones differ without colour", () => {
    assert.equal(new Set(Object.values(COVERAGE_LOOK).map((l) => l.icon)).size, 5);
  });
});

describe("the priority words of a test plan", () => {
  it("P0 and critical are solid red, P1 and high soft red, P2 and medium yellow", () => {
    for (const w of ["P0", "p0", "Critical", "blocker"]) assert.equal(priorityLook(w).tone, "crit", w);
    for (const w of ["P1", "High", "HIGH"]) assert.equal(priorityLook(w).tone, "fail", w);
    for (const w of ["P2", "Medium"]) assert.equal(priorityLook(w).tone, "warn", w);
  });

  it("P3, low and words it does not know are neutral, and the agent's own word is what is shown", () => {
    for (const w of ["P3", "Low", "someday", ""]) assert.equal(priorityLook(w).tone, "neutral", w);
    assert.equal(priorityLook("  High ").label, "High");
    assert.equal(priorityLook("Release blocker?").label, "Release blocker?");
  });

  it("each of the four steps has its own icon, so P0 and P1 differ without colour", () => {
    const icons = ["P0", "P1", "P2", "P3"].map((w) => priorityLook(w).icon);
    assert.equal(new Set(icons).size, 4);
  });
});
