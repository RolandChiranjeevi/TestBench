import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentRunInfo, auditPath } from "../web/src/agentruns.ts";

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

describe("auditPath", () => {
  it("is a page that exists: its first segment is a route in main.tsx, and it names the audit", () => {
    const path = auditPath(5, 42);
    assert.equal(path, "/p/5/bugs?audit=42");
    const segment = path.split("?")[0].split("/")[3];
    const routes = readFileSync(join(import.meta.dirname, "..", "web", "src", "main.tsx"), "utf8");
    assert.ok(routes.includes(`<Route path="${segment}" `), `main.tsx has no route "${segment}"`);
  });
});
