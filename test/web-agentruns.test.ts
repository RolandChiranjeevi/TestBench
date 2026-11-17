import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentRunInfo, askedRunInfo, auditPath } from "../web/src/agentruns.ts";

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

describe("askedRunInfo", () => {
  const r = (status: string, claimedBy: string | null = null) => ({ agentRequest: { id: 12, status, claimedBy } });

  it("says where a run that a person asked an agent to run stands: waiting, taken by whom, finished, cancelled", () => {
    assert.equal(askedRunInfo(r("pending"))!.label, "Waiting for agent · request #12");
    assert.equal(askedRunInfo(r("claimed", "agent: claude-a"))!.label, "Taken by agent: claude-a");
    assert.equal(askedRunInfo(r("claimed", null))!.label, "Taken by an agent");
    assert.equal(askedRunInfo(r("done", "agent: claude-a"))!.label, "Agent finished");
    assert.equal(askedRunInfo(r("cancelled", "agent: claude-a"))!.label, "Request cancelled");
    assert.deepEqual([askedRunInfo(r("pending"))!.requestId, askedRunInfo(r("done"))!.status], [12, "done"]);
  });

  it("has a title that says what it means, and that a waiting run can still be run by hand", () => {
    assert.match(askedRunInfo(r("pending"))!.title, /Nobody has taken the request yet\. You can still run the cases yourself/);
    assert.match(askedRunInfo(r("cancelled"))!.title, /The run is kept and can be run by hand/);
  });

  it("is null for a run nobody asked an agent about, and for an answer that is not what it expects", () => {
    for (const run of [{}, { agentRequest: null }, { agentRequest: undefined }, { agentRequest: { id: "12", status: "pending", claimedBy: null } }, { agentRequest: { id: 1.5, status: "pending", claimedBy: null } },
      { agentRequest: { id: 12, status: "exploded", claimedBy: null } }, { agentRequest: "x" as never }]) assert.equal(askedRunInfo(run as never), null, JSON.stringify(run));
  });

  it("is not agentRunInfo: a run asked of an agent is a manual run, not a report an agent handed in", () => {
    const run = { source: "manual", meta: { agentRequest: 12 }, agentRequest: { id: 12, status: "pending", claimedBy: null } };
    assert.equal(agentRunInfo(run), null);
    assert.ok(askedRunInfo(run));
  });
});

describe("auditPath", () => {
  it("is a page that exists: its first segment is a route in main.tsx, and it names the audit", () => {
    const path = auditPath(5, 42);
    assert.equal(path, "/p/5/bugs?audit=42");
    const segment = path.split("?")[0].split("/")[3];
    const routes = readFileSync(join(import.meta.dirname, "..", "web", "src", "main.tsx"), "utf8");
    assert.ok(routes.includes(`<Route path="${segment}" `), `main.tsx has no route "${segment}"`);
  });
});
