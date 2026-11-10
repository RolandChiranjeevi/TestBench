import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LEVELS, OPEN, SETTINGS_NEEDS, can, explainStatus, isReadOnly, needsText, roleLabel, visibleSettings, type Access, type Needs } from "../web/src/access.ts";

// What the screens show for each kind of person. Pure logic: no browser. The server decides what is allowed; this decides what to show.
const member = (role: Access["role"], isOwner = false): Access => ({ accounts: true, role, isOwner });
const people = { admin: member("admin"), tester: member("tester"), viewer: member("viewer"), stranger: member(null), owner: member(null, true) };

describe("can: a role allows what it and the roles below it allow", () => {
  it("the table, for every kind of person and every need", () => {
    const needs: Needs[] = ["viewer", "tester", "admin", "owner"];
    const expected: Record<keyof typeof people, boolean[]> = {
      //                viewer tester admin  owner
      admin:    [true,  true,  true,  false],
      tester:   [true,  true,  false, false],
      viewer:   [true,  false, false, false],
      stranger: [false, false, false, false],
      owner:    [true,  true,  true,  true],
    };
    for (const [who, a] of Object.entries(people)) assert.deepEqual(needs.map((n) => can(a, n)), expected[who as keyof typeof people], who);
  });

  it("without accounts everything is allowed, as it always was", () => {
    for (const n of ["viewer", "tester", "admin", "owner"] as Needs[]) assert.equal(can(OPEN, n), true, n);
    assert.equal(can({ accounts: false, role: null, isOwner: false }, "admin"), true);
  });

  it("the roles are ordered viewer < tester < admin", () => {
    assert.deepEqual([...LEVELS], ["viewer", "tester", "admin"]);
  });
});

describe("what is shown", () => {
  it("the badge says Owner for the owner, else the role, and nothing without accounts or a role", () => {
    assert.deepEqual(Object.values(people).map(roleLabel), ["Admin", "Tester", "Viewer", null, "Owner"]);
    assert.equal(roleLabel(OPEN), null);
    assert.equal(roleLabel(member("admin", true)), "Owner");
  });

  it("only a viewer sees the read-only notice", () => {
    assert.deepEqual(Object.values(people).map(isReadOnly), [false, false, true, false, false]);
    assert.equal(isReadOnly(OPEN), false);
  });

  it("the reason a button is off names the role to ask for", () => {
    assert.equal(needsText("tester"), "Needs the tester role in this project");
    assert.equal(needsText("admin"), "Needs the admin role in this project");
    assert.equal(needsText("owner"), "Only the owner of this Testbench can do this");
  });
});

describe("settings tabs that cannot be used are left out", () => {
  const all = [["agent", "Agent access"], ["project", "Project"], ["members", "Members"], ["data", "Data"], ["shortcuts", "Keyboard shortcuts"], ["account", "Account"]] as const;
  const ids = (a: Access) => visibleSettings(all, a).map(([id]) => id);

  it("by role", () => {
    assert.deepEqual(ids(people.viewer), ["members", "shortcuts", "account"]);
    assert.deepEqual(ids(people.tester), ["members", "shortcuts", "account"]);
    assert.deepEqual(ids(people.admin), ["agent", "project", "members", "shortcuts", "account"]);
    assert.deepEqual(ids(people.owner), ["agent", "project", "members", "data", "shortcuts", "account"]);
    assert.deepEqual(ids(OPEN), ["agent", "project", "members", "data", "shortcuts", "account"], "without accounts, every tab");
  });

  it("every tab has a rule, and a tab with no rule is shown (the route behind it still refuses)", () => {
    assert.deepEqual(Object.keys(SETTINGS_NEEDS).sort(), ["account", "agent", "data", "members", "project", "shortcuts"]);
    assert.deepEqual(visibleSettings([["unknown", "?"]] as const, people.viewer).map(([id]) => id), ["unknown"]);
  });
});

describe("what a refusal means", () => {
  it("a plain 404 is lost access; a 403 keeps the server's words; anything else is passed on", () => {
    assert.deepEqual(explainStatus(404, "Not found"), { kind: "lost-access", text: "You no longer have access to this project." });
    assert.deepEqual(explainStatus(403, "This needs the tester role in this project; you are a viewer"), { kind: "forbidden", text: "This needs the tester role in this project; you are a viewer" });
    assert.equal(explainStatus(403, "").text, "You are not allowed to do that.");
    assert.deepEqual(explainStatus(404, "Case not found"), { kind: "other", text: "Case not found" }, "a 404 from a route itself is not lost access");
    assert.equal(explainStatus(409, "A project needs at least one admin").kind, "other");
  });
});
