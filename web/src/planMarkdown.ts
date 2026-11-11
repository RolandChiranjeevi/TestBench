// The test plan as plain Markdown, for pasting into a pull request, a wiki or a ticket. Kept apart from the page so that it can be tested without a browser.
// It mirrors what the page shows, heading for heading, and says for every plan item and coverage gap what became of it: the agent's proposal that nobody has
// reviewed, a draft, approved or rejected, by whom, and whether the agent has sent something newer. Rejected ones are kept, and marked.

export interface MdLink { requirementId: number | null; label: string; raw: string }
export interface MdOwned {
  origin: "agent" | "human";
  status: "proposed" | "draft" | "approved" | "rejected";
  editedBy: string | null;
  editedAt: string | null;
  decidedBy: string | null;
  pending: { removed: boolean } | null;
}
export interface MdItem extends MdOwned {
  sourceId: string; title: string; type: string; risk: string; priority: string; readiness: string; preconditions: string; testData: string;
  steps: string[]; acceptanceCriteria: string; automation: string; result: string | null; requirements: MdLink[];
}
export interface MdGap extends MdOwned { sourceId: string; description: string; requirements: MdLink[] }
export interface MdPlan { audit: { title: string; agentAuditId: string }; planItems: MdItem[]; coverageGaps: MdGap[] }

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const refName = (r: MdLink) => (r.requirementId ? r.label : r.raw);

/** What became of an item or gap, in words: "AI proposal, not reviewed", "Approved by Tess · edited by Anna", "Draft · own item · edited by Tess" ... */
export function statusText(x: MdOwned): string {
  const by = (name: string | null) => (name ? ` by ${name}` : "");
  const parts: string[] = [];
  if (x.origin === "agent" && x.status === "proposed" && !x.editedAt) parts.push("AI proposal, not reviewed");
  else {
    parts.push(x.status === "approved" ? `Approved${by(x.decidedBy)}` : x.status === "rejected" ? `Rejected${by(x.decidedBy)}` : x.status === "draft" ? "Draft" : "AI proposal");
    if (x.origin === "human") parts.push("own item");
    if (x.editedBy) parts.push(`edited by ${x.editedBy}`);
  }
  if (x.pending) parts.push(x.pending.removed ? "agent removal waiting" : "agent update waiting");
  return parts.join(" · ");
}
const rejectedMark = (x: MdOwned) => (x.status === "rejected" ? " [REJECTED]" : "");

export function planToMarkdown(d: MdPlan): string {
  const L: string[] = [`# Test plan: ${d.audit.title || d.audit.agentAuditId}`, ""];
  L.push(`${plural(d.planItems.length, "plan item")}, ${plural(d.coverageGaps.length, "coverage gap")}.`, "");
  L.push("## Plan items", "");
  if (!d.planItems.length) L.push("No plan items.", "");
  for (const x of d.planItems) {
    L.push(`### ${x.sourceId}: ${x.title}${rejectedMark(x)}`, "");
    L.push(`**Status:** ${statusText(x)}`, "");
    const meta = [x.type && `type: ${x.type}`, x.priority && `priority: ${x.priority}`, x.risk && `risk: ${x.risk}`, x.readiness && `readiness: ${x.readiness}`, x.result && `result: ${x.result}`].filter(Boolean);
    if (meta.length) L.push(meta.join(" · "), "");
    if (x.requirements.length) L.push(`**Requirements:** ${x.requirements.map(refName).join(", ")}`, "");
    if (x.preconditions) L.push("**Preconditions**", "", x.preconditions, "");
    if (x.testData) L.push("**Test data**", "", x.testData, "");
    if (x.steps.length) L.push("**Steps**", "", ...x.steps.map((s, i) => `${i + 1}. ${s}`), "");
    if (x.acceptanceCriteria) L.push("**Acceptance criteria**", "", x.acceptanceCriteria, "");
    if (x.automation) L.push(`**Automation:** ${x.automation}`, "");
  }
  L.push("## Coverage gaps", "");
  if (!d.coverageGaps.length) L.push("No coverage gaps.", "");
  for (const g of d.coverageGaps) {
    L.push(`- **${g.sourceId}**${rejectedMark(g)}${g.requirements.length ? ` (${g.requirements.map(refName).join(", ")})` : ""}: ${g.description.replace(/\n+/g, " ")} _(Status: ${statusText(g)})_`);
  }
  return L.join("\n").replace(/\n+$/, "\n");
}
