import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/**
 * The figures behind the Observations counters (the badge in the sidebar and the tile on the dashboard). "Active" is what the server says it is: observed, needs
 * review and confirmed. Archived, resolved and converted ones are not counted. The key sits under ["observations", pid], so everything the Observations page
 * does (archive, resolve, reopen, convert) refreshes the counters at once.
 */
export interface ObservationSummary { active: number; needsReview: number; total: number; status: Record<string, number> }

export const useObservationSummary = (pid?: string) =>
  useQuery({ queryKey: ["observations", pid, "summary"], queryFn: () => api.get<ObservationSummary>(`/api/projects/${pid}/observations/summary`), staleTime: 30_000, enabled: !!pid });
