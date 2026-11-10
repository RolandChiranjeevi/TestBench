import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db } from "../server/db.ts";
import { makeCase, makeProject } from "./helpers.ts";
import { createRequirement, deprecateRequirement, RequirementError, setRequirementCases } from "../server/requirements.ts";
import { archiveObservation, resolveObservation } from "../server/observations.ts";
import { coverageGaps, getObservationLinks, setObservationLinks } from "../server/coveragegaps.ts";

// What is not covered yet: requirements without a test case, test cases without a requirement, observations without a link. Throwaway data folder, no network.

let n = 0;
const proj = () => makeProject(`CG${++n}`, `Gaps ${n}`);
const obs = (p: { id: number }, number: number, over: { severity?: string; status?: string } = {}) =>
  (db.prepare("INSERT INTO observations (project_id, number, source_id, origin_audit_id, kind, title, severity, status, content_hash) VALUES (?, ?, ?, 'a1', 'security_review', ?, ?, ?, 'h') RETURNING id")
    .get(p.id, number, `S-${number}`, `Finding ${number}`, over.severity ?? "high", over.status ?? "observed") as { id: number }).id;
const fails = (fn: () => unknown, status: number, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof RequirementError && e.status === status && re.test(`${e.message} ${e.problems.join(" ")}`));
const set = (id: number, status: string) => db.prepare("UPDATE cases SET status = ? WHERE id = ?").run(status, id);

describe("requirements without a test case", () => {
  it("lists approved requirements that no test case in use is linked to; drafts, deprecated ones and covered ones are left out", () => {
    const p = proj();
    const bare = createRequirement(p.id, { title: "No test" });
    createRequirement(p.id, { title: "Draft", status: "draft" });
    const gone = createRequirement(p.id, { title: "Old" });
    deprecateRequirement(gone);
    const covered = createRequirement(p.id, { title: "Covered" });
    const c = makeCase(p.id, "Proves it");
    setRequirementCases(covered, p.id, [c.id]);
    const onlyDeprecatedCase = createRequirement(p.id, { title: "Only a deprecated case" });
    const old = makeCase(p.id, "Old case");
    setRequirementCases(onlyDeprecatedCase, p.id, [old.id]);
    set(old.id, "deprecated");
    const g = coverageGaps(p.id);
    assert.deepEqual(g.requirementsWithoutCases.map((r) => r.id), [bare, onlyDeprecatedCase]);
    assert.equal(g.counts.requirementsWithoutCases, 2);
    assert.deepEqual(Object.keys(g.requirementsWithoutCases[0]).sort(), ["id", "kind", "number", "origin", "priority", "title"]);
  });
});

describe("test cases without a requirement", () => {
  it("lists cases in use that no requirement in use names", () => {
    const p = proj();
    const loose = makeCase(p.id, "Loose");
    const linked = makeCase(p.id, "Linked");
    const toDeprecated = makeCase(p.id, "Linked to a deprecated requirement");
    const retired = makeCase(p.id, "Retired");
    set(retired.id, "deprecated");
    setRequirementCases(createRequirement(p.id, { title: "Live" }), p.id, [linked.id]);
    const old = createRequirement(p.id, { title: "Old" });
    setRequirementCases(old, p.id, [toDeprecated.id]);
    deprecateRequirement(old);
    const g = coverageGaps(p.id);
    assert.deepEqual(g.casesWithoutRequirement.map((c) => c.id), [loose.id, toDeprecated.id]);
    assert.equal(g.counts.casesWithoutRequirement, 2);
  });
});

describe("observations without a link", () => {
  it("lists the observations still being looked at, most severe first; closed ones and linked ones are left out", () => {
    const p = proj();
    const low = obs(p, 1, { severity: "low" });
    const crit = obs(p, 2, { severity: "critical" });
    const closed = obs(p, 3); const done = obs(p, 4); const linked = obs(p, 5); const viaCase = obs(p, 6);
    archiveObservation(closed); resolveObservation(done);
    setObservationLinks(linked, { requirementIds: [createRequirement(p.id, { title: "R" })] });
    setObservationLinks(viaCase, { caseIds: [makeCase(p.id, "C").id] });
    const g = coverageGaps(p.id);
    assert.deepEqual(g.observationsWithoutLink.map((o) => [o.id, o.label]), [[crit, "OBS-2"], [low, "OBS-1"]]);
    assert.equal(g.counts.observationsWithoutLink, 2);
  });

  it("an observation comes back to the list when what it was linked to is deleted", () => {
    const p = proj();
    const o = obs(p, 1);
    const r = createRequirement(p.id, { title: "R" });
    setObservationLinks(o, { requirementIds: [r] });
    assert.equal(coverageGaps(p.id).observationsWithoutLink.length, 0);
    db.prepare("DELETE FROM requirements WHERE id = ?").run(r);
    assert.equal(coverageGaps(p.id).observationsWithoutLink.length, 1);
  });
});

describe("linking an observation", () => {
  it("replaces its links, ignores repeated ids, and says what it is linked to", () => {
    const p = proj();
    const o = obs(p, 1);
    const r1 = createRequirement(p.id, { title: "First" }); const r2 = createRequirement(p.id, { title: "Second" });
    const c = makeCase(p.id, "A case");
    const first = setObservationLinks(o, { requirementIds: [r1, r1, r2], caseIds: [c.id] });
    assert.deepEqual([first.requirements.map((r) => r.id), first.cases.map((x) => x.id)], [[r1, r2], [c.id]]);
    const second = setObservationLinks(o, { requirementIds: [r2] });
    assert.deepEqual([second.requirements.map((r) => r.id), second.cases.length], [[r2], 0]);
    assert.deepEqual(getObservationLinks(o).requirements.map((r) => r.id), [r2]);
    assert.deepEqual(setObservationLinks(o, {}).requirements, []);
  });

  it("refuses ids from another project, and saves nothing", () => {
    const p = proj(); const q = proj();
    const o = obs(p, 1);
    const mine = createRequirement(p.id, { title: "Mine" });
    const theirs = createRequirement(q.id, { title: "Theirs" });
    const theirCase = makeCase(q.id, "Their case");
    setObservationLinks(o, { requirementIds: [mine] });
    fails(() => setObservationLinks(o, { requirementIds: [mine, theirs], caseIds: [theirCase.id] }), 400, /not a requirement of this project.*not a test case of this project/s);
    assert.deepEqual(getObservationLinks(o).requirements.map((r) => r.id), [mine], "the earlier links are untouched");
    fails(() => setObservationLinks(o, { requirementIds: [999999] }), 400, /999999/);
  });

  it("refuses unknown fields, wrong types and an observation that does not exist", () => {
    const p = proj();
    const o = obs(p, 1);
    fails(() => setObservationLinks(o, { requirementIds: ["x"] }), 400, /requirementIds/);
    fails(() => setObservationLinks(o, { status: "converted" }), 400, /Unrecognized key/i);
    fails(() => setObservationLinks(999999, {}), 404, /Observation not found/);
    fails(() => getObservationLinks(999999), 404, /Observation not found/);
    fails(() => coverageGaps(999999), 404, /Project not found/);
  });

  it("one project's gaps never show another project's data", () => {
    const p = proj(); const q = proj();
    createRequirement(p.id, { title: "P only" }); makeCase(p.id, "P case"); obs(p, 1);
    const g = coverageGaps(q.id);
    assert.deepEqual(g.counts, { requirementsWithoutCases: 0, casesWithoutRequirement: 0, observationsWithoutLink: 0 });
  });
});
