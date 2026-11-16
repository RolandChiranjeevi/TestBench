import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentRunInfo } from "../web/src/agentruns.ts";

describe("agentRunInfo", () => {
  it("names the request of a run an agent handed in", () => {
    assert.deepEqual(agentRunInfo({ source: "agent", meta: { agentRequest: 12, deliveredBy: "qa-agent" } }), { requestId: 12 });
  });
  it("is null for every other run, and for a run whose meta is not what it expects", () => {
    for (const run of [
      { source: "upload", meta: { agentRequest: 12 } }, { source: "github", meta: {} }, { source: "manual", meta: null },
      { source: "agent", meta: null }, { source: "agent", meta: {} }, { source: "agent", meta: { agentRequest: "12" } }, { source: "agent", meta: { agentRequest: 1.5 } }, { source: "agent", meta: "x" }, {},
    ]) assert.equal(agentRunInfo(run), null, JSON.stringify(run));
  });
});
