import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planToMarkdown, statusText, type MdGap, type MdItem, type MdPlan } from "../web/src/planMarkdown.ts";

// The Markdown export says, for every plan item and coverage gap, what became of it. Rejected ones are kept, and marked.

const owned = { origin: "agent" as const, status: "proposed" as const, editedBy: null, editedAt: null, decidedBy: null, pending: null };
const item = (over: Partial<MdItem> = {}): MdItem => ({
  sourceId: "TPI-001", title: "Add a todo", type: "Functional", risk: "High", priority: "High", readiness: "ready", preconditions: "An empty list", testData: "",
  steps: ["Type the text", "Press Enter"], acceptanceCriteria: "The text is shown", automation: "Yes", result: null, requirements: [{ requirementId: 4, label: "REQ-1 · Todo can be added", raw: "REQ-1" }], ...owned, ...over,
});
const gap = (over: Partial<MdGap> = {}): MdGap => ({ sourceId: "CG-001", description: "Validation is not verified", requirements: [{ requirementId: null, label: "REQ-LOCAL-002", raw: "REQ-LOCAL-002" }], ...owned, ...over });
const plan = (planItems: MdItem[], coverageGaps: MdGap[]): MdPlan => ({ audit: { title: "Audit", agentAuditId: "a1" }, planItems, coverageGaps });

describe("the status of a plan item or gap, in words", () => {
  it("an agent's proposal that nobody has reviewed says so", () => {
    assert.equal(statusText(owned), "AI proposal, not reviewed");
  });
  it("approved and rejected say by whom, and who edited it", () => {
    assert.equal(statusText({ ...owned, status: "approved", decidedBy: "Tess", editedBy: "Anna", editedAt: "2026-11-11 10:00:00" }), "Approved by Tess · edited by Anna");
    assert.equal(statusText({ ...owned, status: "rejected", decidedBy: "Sam" }), "Rejected by Sam");
  });
  it("a draft, a person's own item and the agent's waiting version are all said", () => {
    assert.equal(statusText({ ...owned, origin: "human", status: "draft", editedBy: "Tess", editedAt: "2026-11-11 10:00:00" }), "Draft · own item · edited by Tess");
    assert.equal(statusText({ ...owned, status: "draft", editedBy: "Tess", editedAt: "x", pending: { removed: false } }), "Draft · edited by Tess · agent update waiting");
    assert.equal(statusText({ ...owned, status: "approved", decidedBy: "Tess", pending: { removed: true } }), "Approved by Tess · agent removal waiting");
  });
});

describe("the export", () => {
  it("every plan item has a status line, and a rejected one is kept and marked in its heading", () => {
    const md = planToMarkdown(plan([
      item(),
      item({ sourceId: "TPI-002", title: "Rejected one", status: "rejected", decidedBy: "Sam" }),
      item({ sourceId: "TPI-003", title: "Approved one", status: "approved", decidedBy: "Tess", editedBy: "Anna", editedAt: "x" }),
    ], []));
    assert.match(md, /### TPI-001: Add a todo\n\n\*\*Status:\*\* AI proposal, not reviewed\n/);
    assert.match(md, /### TPI-002: Rejected one \[REJECTED\]\n\n\*\*Status:\*\* Rejected by Sam\n/);
    assert.match(md, /### TPI-003: Approved one\n\n\*\*Status:\*\* Approved by Tess · edited by Anna\n/);
    assert.equal((md.match(/\*\*Status:\*\*/g) ?? []).length, 3);
    assert.doesNotMatch(md.split("### TPI-001")[1].split("### TPI-002")[0], /REJECTED/, "only the rejected one is marked");
  });

  it("every coverage gap has its status, and a rejected one is kept and marked", () => {
    const md = planToMarkdown(plan([], [
      gap(),
      gap({ sourceId: "CG-002", description: "Second", status: "rejected", decidedBy: "Sam", requirements: [] }),
      gap({ sourceId: "G-1", description: "Mine", origin: "human", status: "draft", editedBy: "Tess", editedAt: "x", pending: { removed: false }, requirements: [] }),
    ]));
    assert.match(md, /- \*\*CG-001\*\* \(REQ-LOCAL-002\): Validation is not verified _\(Status: AI proposal, not reviewed\)_/);
    assert.match(md, /- \*\*CG-002\*\* \[REJECTED\]: Second _\(Status: Rejected by Sam\)_/);
    assert.match(md, /- \*\*G-1\*\*: Mine _\(Status: Draft · own item · edited by Tess · agent update waiting\)_/);
  });

  it("what the export said before is still there: headings, counts, metadata, steps, requirements, and no blank line at the end", () => {
    const md = planToMarkdown(plan([item()], [gap()]));
    assert.match(md, /^# Test plan: Audit\n\n1 plan item, 1 coverage gap\.\n\n## Plan items\n\n/);
    assert.match(md, /type: Functional · priority: High · risk: High · readiness: ready/);
    assert.match(md, /\*\*Requirements:\*\* REQ-1 · Todo can be added/);
    assert.match(md, /\*\*Steps\*\*\n\n1\. Type the text\n2\. Press Enter/);
    assert.match(md, /\*\*Acceptance criteria\*\*\n\nThe text is shown/);
    assert.match(md, /## Coverage gaps\n\n- /);
    assert.ok(!md.endsWith("\n\n"), "no blank line at the end");
    assert.match(planToMarkdown(plan([], [])), /No plan items\.\n\n## Coverage gaps\n\nNo coverage gaps\.\n$/);
  });
});
