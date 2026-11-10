import type { ReactNode } from "react";
import { Archive, Bug, ChevronDown, ChevronUp, ChevronsUp, Circle, CircleCheck, Diamond, Eye, Info, ShieldAlert } from "lucide-react";
import { OBSERVATION_STATUS_LOOK, priorityLook, SEVERITY_LOOK, type BadgeLook, type IconName, type ObservationStatus, type Severity, type Tone } from "../statuses";

const ICONS = {
  "chevrons-up": ChevronsUp, "chevron-up": ChevronUp, diamond: Diamond, "chevron-down": ChevronDown, "shield-alert": ShieldAlert,
  info: Info, circle: Circle, eye: Eye, "circle-check": CircleCheck, archive: Archive, bug: Bug,
} satisfies Record<IconName, unknown>;

/** A small label with an icon and a word. The tone gives the colour; it is never the only signal. */
export function Badge({ tone, icon, children }: { tone: Tone; icon?: IconName; children: ReactNode }) {
  const Icon = icon ? ICONS[icon] : null;
  return (
    <span className={`badge badge--${tone}`}>
      {Icon && <Icon size={12} aria-hidden="true" />}
      {children}
    </span>
  );
}

const FromLook = ({ look }: { look: BadgeLook }) => <Badge tone={look.tone} icon={look.icon}>{look.label}</Badge>;

/** P0, High, critical ... as the agent wrote it. See `priorityLook` for which word gets which tone. */
export const PriorityBadge = ({ value }: { value: string }) => <FromLook look={priorityLook(value)} />;
export const SeverityBadge = ({ value }: { value: Severity }) => <FromLook look={SEVERITY_LOOK[value]} />;
export const ObservationStatusBadge = ({ value }: { value: ObservationStatus }) => <FromLook look={OBSERVATION_STATUS_LOOK[value]} />;
