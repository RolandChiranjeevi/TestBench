import "./env.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { findingBody } from "../server/agentfindings.ts";

// The example findings files in the request-discover skill are what an agent copies the field names from, and TestBench refuses a field it does not know. So the strict schema of the
// server must accept every finding in them: an example that drifts from the schema would make the agent send findings that are refused.
const skill = readFileSync(new URL("../.claude/skills/testpilot-request-discover/SKILL.md", import.meta.url), "utf8");
const files = [...skill.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]!) as { findings: Record<string, unknown>[] });
const findings = files.flatMap((f) => f.findings);

describe("the example findings files in the request-discover skill", () => {
  it("are two files and show the five kinds that the skill's table names", () => {
    assert.equal(files.length, 2);
    assert.deepEqual([...new Set(findings.map((f) => f.kind))].sort(), ["bug_report", "coverage_gap", "observation", "plan_item", "test_case"]);
  });

  it("pass the strict schema of the server, with `ref` and `planItemRef` taken out as the helper does", () => {
    for (const f of findings) {
      const { ref: _ref, planItemRef, ...rest } = f;
      // The helper replaces planItemRef by the P-number TestBench gave the plan item; any P-number stands in for it here.
      findingBody.parse(planItemRef === undefined ? rest : { ...rest, planItem: "P-1" });
    }
  });

  it("are refused by the schema as soon as one field in them is not one of the server's (so this test can fail)", () => {
    assert.throws(() => findingBody.parse({ ...findings[0], status: "approved" }));
  });
});
