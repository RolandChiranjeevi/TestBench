import "./env.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cleanOptions, DEFAULT_REQUEST_OPTIONS, optionsNeedAdmin as serverNeedsAdmin, REQUEST_OPTIONS } from "../server/agentrequests.ts";
import {
  DEFAULT_OPTIONS, DELIVERABLES, DEPTHS, GIT_MODES, optionsNeedAdmin, optionsProblem, optionsSummary, START_COMMAND, START_SKILL, TARGET_MODES, toggled, VIEWPORTS, withProduction, withTargetMode, CHECKS,
  type RequestOptions,
} from "../web/src/requestOptions.ts";

// The choices in the Request discover dialog (web/src/requestOptions.ts) and the server's (server/agentrequests.ts): one list each, kept in step here.

const values = (all: readonly { value: string }[]) => all.map((a) => a.value);

describe("the choices of the dialog and the server", () => {
  it("are the same choices, in the same order", () => {
    assert.deepEqual(values(TARGET_MODES), [...REQUEST_OPTIONS.targetModes]);
    assert.deepEqual(values(GIT_MODES), [...REQUEST_OPTIONS.gitModes]);
    assert.deepEqual(values(DELIVERABLES), [...REQUEST_OPTIONS.deliverables]);
    assert.deepEqual(values(VIEWPORTS), [...REQUEST_OPTIONS.viewports]);
    assert.deepEqual(values(CHECKS), [...REQUEST_OPTIONS.checks]);
    assert.deepEqual(values(DEPTHS), [...REQUEST_OPTIONS.depths]);
  });

  it("start from the same defaults", () => {
    assert.deepEqual(DEFAULT_OPTIONS, DEFAULT_REQUEST_OPTIONS);
  });

  it("agree on which choices need an admin", () => {
    for (const targetMode of values(TARGET_MODES)) {
      for (const gitMode of values(GIT_MODES)) {
        const o = { ...DEFAULT_OPTIONS, targetMode, gitMode } as RequestOptions;
        assert.equal(optionsNeedAdmin(o), serverNeedsAdmin(o), `${targetMode} ${gitMode}`);
      }
    }
    assert.equal(optionsNeedAdmin(DEFAULT_OPTIONS), false, "the defaults are open to every tester");
  });

  it("only send what the server accepts: every combination the dialog can make passes the server, unchanged", () => {
    for (const targetMode of values(TARGET_MODES)) {
      for (const gitMode of values(GIT_MODES)) {
        for (const production of [false, true]) {
          const made = withProduction({ ...DEFAULT_OPTIONS, targetMode, gitMode } as RequestOptions, production);
          assert.equal(optionsProblem(made), null);
          assert.deepEqual(cleanOptions(made), made, `${targetMode} ${gitMode} production ${production}`);
        }
      }
    }
  });
});

describe("picking in the dialog", () => {
  it("adds and removes a choice and keeps the order of the list", () => {
    assert.deepEqual(toggled(DELIVERABLES, ["plan", "bugs"], "cases"), ["plan", "cases", "bugs"]);
    assert.deepEqual(toggled(DELIVERABLES, ["plan", "cases", "bugs"], "cases"), ["plan", "bugs"]);
    assert.deepEqual(toggled(VIEWPORTS, [], "mobile"), ["mobile"]);
  });

  it("saying the address is production takes acting on it away, and unsaying it does not bring it back", () => {
    const acting = { ...DEFAULT_OPTIONS, targetMode: "full" } as RequestOptions;
    const prod = withProduction(acting, true);
    assert.deepEqual([prod.production, prod.targetMode], [true, "observe_only"]);
    const back = withProduction(prod, false);
    assert.deepEqual([back.production, back.targetMode], [false, "observe_only"]);
    assert.equal(withProduction({ ...DEFAULT_OPTIONS, gitMode: "pr" }, true).gitMode, "pr", "git is a separate choice");
  });

  it("moves the depth with the choice to act: thorough when acting, normal again when only reading, and never over a depth the person picked", () => {
    assert.equal(withTargetMode(DEFAULT_OPTIONS, "full").depth, "thorough");
    assert.equal(withTargetMode(withTargetMode(DEFAULT_OPTIONS, "full"), "observe_only").depth, "normal");
    assert.equal(withTargetMode({ ...DEFAULT_OPTIONS, depth: "quick" }, "full").depth, "quick", "a depth the person picked is kept");
    assert.equal(withTargetMode({ ...DEFAULT_OPTIONS, depth: "quick", targetMode: "full" }, "observe_only").depth, "quick");
    assert.equal(withTargetMode(DEFAULT_OPTIONS, "full").targetMode, "full");
    for (const depth of values(DEPTHS)) assert.deepEqual(cleanOptions({ ...DEFAULT_OPTIONS, depth }).depth, depth, "every depth the dialog can send passes the server");
  });

  it("will not make a request that delivers nothing or looks at no screen size", () => {
    assert.equal(optionsProblem(DEFAULT_OPTIONS), null);
    assert.match(optionsProblem({ ...DEFAULT_OPTIONS, deliverables: [] }) ?? "", /at least one thing/);
    assert.match(optionsProblem({ ...DEFAULT_OPTIONS, viewports: [] }) ?? "", /at least one screen size/);
  });
});

describe("what the request card says", () => {
  it("puts the choices on one line", () => {
    assert.equal(optionsSummary(DEFAULT_OPTIONS), "Only read · Commit on a local branch · test plan, test cases, observations, bug proposals · desktop, tablet, mobile · depth: normal");
    assert.equal(
      optionsSummary({ targetMode: "full", gitMode: "pr", deliverables: ["specs"], viewports: ["mobile"], checks: [], depth: "thorough", production: false }),
      "Act on the target · Push and open a pull request · spec files · mobile · depth: thorough",
    );
    assert.match(optionsSummary(withProduction(DEFAULT_OPTIONS, true)), / · production$/);
  });
});

describe("how to start the agent, as the dialog says it", () => {
  it("is what the set-up guide says, and the guide names the skill before the MCP tools", () => {
    const guide = readFileSync(join(import.meta.dirname, "..", "docs", "agent-quickstart.md"), "utf8");
    assert.ok(guide.includes(START_COMMAND), "the command is in docs/agent-quickstart.md");
    assert.equal(START_SKILL, "/testpilot-requests");
    assert.ok(guide.includes(START_SKILL), "the skill command is in docs/agent-quickstart.md");
    assert.ok(guide.indexOf(START_SKILL) < guide.indexOf("testbench_get_next_request"), "the guide leads with the skill, which has the one confirmation, and not with the MCP prompt");
  });
});
