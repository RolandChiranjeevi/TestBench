/**
 * Acceptance criteria are not a field of a requirement in Testbench: the editor's hint is "Add acceptance criteria here" in the description.
 * This reads them back out of the description, with one deterministic rule, so that an agent can see what a requirement says it must satisfy.
 *
 *  - A label is the words "Acceptance criteria" (any case, optionally in bold or as a heading) either alone on a line, or followed by a colon.
 *  - After a label alone on a line the criteria are the list items below it (-, *, + or 1. / 1)), blank lines before the list are allowed.
 *  - After a label with a colon the text on the same line is one criterion, and list items directly below it are more criteria.
 *  - A block ends at a heading, at a blank line after the criteria (unless the next text is another list item) or at any other text.
 *  - Several labelled blocks add up. No label, or a label with nothing under it, means no criteria.
 *
 * The server never says that a criterion is measurable or that a requirement is met: `ready` only means "has criteria". Judging them is the agent's job.
 */

export type Readiness = "ready" | "needs-clarification";
export interface Acceptance { criteria: string[]; readiness: Readiness }

export const ACCEPTANCE_LIMITS = { criteria: 50, length: 500 };

const LABEL_ONLY = /^\s*(?:#{1,6}\s*)?(?:[*_]{1,2})?\s*acceptance\s+criteria\s*(?:[*_]{1,2})?\s*:?\s*(?:[*_]{1,2})?\s*$/i;
const LABEL_INLINE = /acceptance\s+criteria\s*(?:[*_]{1,2})?\s*:\s*(?:[*_]{1,2})?\s*(\S.*)$/i;
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+(\S.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s/;

const clean = (s: string) => s.replace(/^\[[ xX]\]\s+/, "").replace(/\s+/g, " ").trim().slice(0, ACCEPTANCE_LIMITS.length);

export function parseAcceptance(description: string): Acceptance {
  const lines = (description ?? "").split(/\r?\n/);
  const criteria: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const only = LABEL_ONLY.test(lines[i]);
    const inline = only ? null : LABEL_INLINE.exec(lines[i]);
    if (!only && !inline) continue;
    const block: string[] = [];
    if (inline) block.push(clean(inline[1]));
    let listStarted = false;
    let blank = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) { blank = true; continue; }
      if (HEADING.test(line)) break;
      const item = LIST_ITEM.exec(line);
      if (item) {
        // After a label with text on its line, a list must follow it directly. After a label alone, blank lines before and between items are fine.
        if (blank && inline && !listStarted) break;
        block.push(clean(item[1]));
        listStarted = true;
        blank = false;
        continue;
      }
      // A wrapped line of the item above: indented, and straight after it.
      if (/^\s{2,}\S/.test(line) && !blank && block.length > 0) { block[block.length - 1] = clean(`${block[block.length - 1]} ${line.trim()}`); continue; }
      break;
    }
    criteria.push(...block.filter(Boolean));
    i = j - 1;
  }
  const capped = criteria.slice(0, ACCEPTANCE_LIMITS.criteria);
  return { criteria: capped, readiness: capped.length > 0 ? "ready" : "needs-clarification" };
}
