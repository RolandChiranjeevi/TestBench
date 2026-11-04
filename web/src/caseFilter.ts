import type { CaseSummary } from "./api";

/**
 * The filters of the Test cases page, in one place so a filter and its count are always the same condition.
 * The tabs (all, manual, automated, failing, no requirement) choose one of several; "New" and "From agent proposal" are switches that
 * combine with a tab and with each other, and with the search. Filtering never reorders: the list keeps the order the server gave it.
 */
export type CaseTab = "all" | "manual" | "automated" | "failing" | "unlinked";

export const TAB_CONDITION: Record<CaseTab, (c: CaseSummary) => boolean> = {
  all: () => true,
  manual: (c) => c.automated_count === 0,
  automated: (c) => c.automated_count > 0,
  failing: (c) => c.last_status === "failed" || c.last_status === "blocked",
  unlinked: (c) => !c.requirement_count && c.status !== "deprecated",
};
/** Created in the last 7 days (the server decides, see server/newcases.ts). */
export const isNew = (c: CaseSummary) => !!c.is_new;
/** Made from an agent proposal: a row of manual_tests points at the case through manual_tests.case_id. */
export const isFromProposal = (c: CaseSummary) => !!c.from_proposal;

export interface CaseFilters { tab: CaseTab; onlyNew: boolean; onlyProposal: boolean; search: string; projectKey?: string }

export function filterCases(cases: CaseSummary[], f: CaseFilters): CaseSummary[] {
  const q = f.search.trim().toLowerCase();
  return cases.filter((c) => {
    if (!TAB_CONDITION[f.tab](c)) return false;
    if (f.onlyNew && !isNew(c)) return false;
    if (f.onlyProposal && !isFromProposal(c)) return false;
    if (!q) return true;
    return `${f.projectKey}-${c.number} ${c.title} ${c.tags.join(" ")}`.toLowerCase().includes(q);
  });
}

export function caseCounts(cases: CaseSummary[]): Record<CaseTab | "new" | "proposal", number> {
  const n = (test: (c: CaseSummary) => boolean) => cases.filter(test).length;
  return {
    all: n(TAB_CONDITION.all), manual: n(TAB_CONDITION.manual), automated: n(TAB_CONDITION.automated), failing: n(TAB_CONDITION.failing),
    unlinked: n(TAB_CONDITION.unlinked), new: n(isNew), proposal: n(isFromProposal),
  };
}
