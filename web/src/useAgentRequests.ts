import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { api, type AgentRequest } from "./api";

/** The requests people have made of a test agent in this project, newest first. Looked at again every 15 seconds: an agent may take or finish one at any time. */
export function useAgentRequests() {
  const { pid } = useParams();
  return useQuery({ queryKey: ["agent-requests", pid], queryFn: () => api.get<AgentRequest[]>(`/api/projects/${pid}/agent-requests`), refetchInterval: 15_000 });
}

/** How many are still open: waiting for an agent, or taken and not finished. */
export const openRequests = (requests: AgentRequest[] | undefined) => (requests ?? []).filter((r) => r.status === "pending" || r.status === "claimed").length;
