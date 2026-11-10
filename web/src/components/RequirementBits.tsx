import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, timeAgo, type DisplayName, type RequirementOrigin } from "../api";
import { Badge } from "./Badge";
import type { IconName, Tone } from "../statuses";

/** Where a requirement came from. The word is always there; the tone only helps. */
const ORIGIN: Record<RequirementOrigin, { tone: Tone; icon?: IconName; label: string; title: string }> = {
  human: { tone: "neutral", label: "Human", title: "Written by a person" },
  import: { tone: "info", icon: "info", label: "Import", title: "Came in with an import that a person ran" },
  ai_suggestion: { tone: "accent", icon: "eye", label: "AI-suggested", title: "Suggested by a test agent. It became a requirement when a person approved it." },
};
export const OriginBadge = ({ origin }: { origin: RequirementOrigin }) => <Badge tone={ORIGIN[origin].tone} icon={ORIGIN[origin].icon} title={ORIGIN[origin].title}>{ORIGIN[origin].label}</Badge>;
export const ORIGIN_LABEL: Record<RequirementOrigin, string> = { human: "Human", import: "Import", ai_suggestion: "AI-suggested" };

/** An agent's proposal that nobody has decided on. Not a requirement. */
export const ProposalBadge = () => <Badge tone="accent" icon="eye" title="Suggested by a test agent. It changes nothing until a person approves it.">AI proposal – needs review</Badge>;

/** A time from the server (UTC, no zone) as "3 hours ago". */
export const whenText = (s: string | null | undefined) => (s ? timeAgo(s.replace(" ", "T") + "Z") : "");

/**
 * "Rejected as Anna Berg (your account)." or "(as typed)". What is recorded on created by, approved by and in the change log is the name of the account that is signed in, or
 * without accounts the display name set in Settings, as typed. Neither is checked against a real person. Without a name it says so and points to where to set it.
 */
export function RecordedAs({ what = "Recorded as" }: { what?: string }) {
  const { pid } = useParams();
  const { data } = useQuery({ queryKey: ["display-name"], queryFn: () => api.get<DisplayName>("/api/settings/display-name"), staleTime: 60_000 });
  if (!data) return null;
  return (
    <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
      {data.name
        ? <>{what} <b>{data.name}</b> ({data.source === "account" ? "your account" : "as typed"}).</>
        : <>{what} “{data.recordedAs}”: no name is set. <Link to={`/p/${pid}/settings/account`}>Set your name</Link></>}
    </span>
  );
}
