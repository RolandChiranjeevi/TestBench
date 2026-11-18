import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentRunInfo, askedRunInfo, auditPath, PROGRESS_TITLE, progressLabel, reportRunLabel, reportedByAgent } from "../web/src/agentruns.ts";

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

describe("progressLabel and the progress of an asked run", () => {
  it("says 'n of M results recorded (includes manual results)', and nothing when there is nothing to say", () => {
    assert.equal(progressLabel({ total: 5, reported: 2 }), "2 of 5 results recorded (includes manual results)");
    assert.equal(progressLabel({ total: 3, reported: 0 }), "0 of 3 results recorded (includes manual results)");
    for (const p of [null, undefined, {}, { total: 0, reported: 0 }, { total: "5", reported: 2 }, { total: 5, reported: 1.5 }]) assert.equal(progressLabel(p as never), null, JSON.stringify(p));
  });
  it("is part of askedRunInfo in every state, and null when the answer has none", () => {
    for (const status of ["pending", "claimed", "done", "cancelled"]) assert.equal(askedRunInfo({ agentRequest: { id: 1, status, claimedBy: null, progress: { total: 4, reported: 1, missing: 3 } } })!.progress, "1 of 4 results recorded (includes manual results)", status);
    assert.equal(askedRunInfo({ agentRequest: { id: 1, status: "claimed", claimedBy: null } })!.progress, null);
  });
  it("has a tooltip that says the count is not only the agent's and that a person may have changed what the agent reported, and both chips use it", () => {
    assert.match(PROGRESS_TITLE, /whoever set it: the agent, or a person by hand/);
    assert.match(PROGRESS_TITLE, /A result the agent reported may have been changed by a person\./);
    const pages = join(import.meta.dirname, "..", "web", "src", "pages");
    for (const file of ["RunDetail.tsx", "AgentRequests.tsx"]) assert.ok(readFileSync(join(pages, file), "utf8").includes("title={PROGRESS_TITLE}"), `${file} uses the shared tooltip`);
  });
  it("tells a person to review and finish the run when the agent is done", () => {
    assert.match(askedRunInfo({ agentRequest: { id: 1, status: "done", claimedBy: "agent: a" } })!.title, /Review the results, then finish the run/);
  });
});

describe("the link to the report of an asked run", () => {
  it("has the number of the automated run when the agent handed in a report, and none before or for an answer that is not a number", () => {
    assert.equal(askedRunInfo({ agentRequest: { id: 1, status: "claimed", claimedBy: "agent: a", reportRunId: 40 } })!.reportRunId, 40);
    for (const v of [undefined, null, "40", 1.5, NaN]) assert.equal(askedRunInfo({ agentRequest: { id: 1, status: "claimed", claimedBy: null, reportRunId: v as never } })!.reportRunId, null, String(v));
    assert.equal(reportRunLabel(40), "Automated report: run #40");
  });
  it("is shown on the page of the run, and the request's card says an automated report was handed in", () => {
    const pages = join(import.meta.dirname, "..", "web", "src", "pages");
    assert.ok(readFileSync(join(pages, "RunDetail.tsx"), "utf8").includes("reportRunLabel(asked.reportRunId)"));
    assert.ok(readFileSync(join(pages, "AgentRequests.tsx"), "utf8").includes("Automated report handed in: "));
  });
});

describe("reportedByAgent", () => {
  it("marks a result an agent reported with its name, and says that a person may have changed it since", () => {
    assert.deepEqual(reportedByAgent({ reported_by_agent_token_id: 4, reported_by_agent: "claude-a" }), { label: "Agent: claude-a", title: "Reported by agent. A person may have changed it." });
  });
  it("still marks it when the token has been deleted (no name), and does not mark any other result", () => {
    assert.equal(reportedByAgent({ reported_by_agent_token_id: 4, reported_by_agent: null })!.label, "Agent: an agent");
    for (const r of [{}, { reported_by_agent_token_id: null, reported_by_agent: null }, { reported_by_agent_token_id: undefined }, { reported_by_agent_token_id: "4", reported_by_agent: "x" }]) assert.equal(reportedByAgent(r), null, JSON.stringify(r));
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
