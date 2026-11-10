import type { ReactNode } from "react";
import { Archive, Bug, ChevronDown, ChevronUp, ChevronsUp, Circle, CircleCheck, CircleMinus, CircleX, Copy, Diamond, Eye, EyeOff, Info, ShieldAlert, TriangleAlert } from "lucide-react";
import {
  BUG_WORKFLOW_LOOK, CI_STATUS_LOOK, COVERAGE_LOOK, OBSERVATION_STATUS_LOOK, priorityLook, REVIEW_STATUS_LOOK, SEVERITY_LOOK,
  type BadgeLook, type BugWorkflow, type CiStatus, type CoverageState, type IconName, type ObservationStatus, type ReviewStatus, type Severity, type Tone,
} from "../statuses";

const ICONS = {
  "chevrons-up": ChevronsUp, "chevron-up": ChevronUp, diamond: Diamond, "chevron-down": ChevronDown, "shield-alert": ShieldAlert,
  info: Info, circle: Circle, eye: Eye, "circle-check": CircleCheck, archive: Archive, bug: Bug,
  "circle-x": CircleX, copy: Copy, "triangle-alert": TriangleAlert, "eye-off": EyeOff, "circle-minus": CircleMinus,
} satisfies Record<IconName, unknown>;

/** A small label with an icon and a word. The tone gives the colour; it is never the only signal. `title` is the explanation shown on hover. */
export function Badge({ tone, icon, title, children }: { tone: Tone; icon?: IconName; title?: string; children: ReactNode }) {
  const Icon = icon ? ICONS[icon] : null;
  return (
    <span className={`badge badge--${tone}`} title={title}>
      {Icon && <Icon size={12} aria-hidden="true" />}
      {children}
    </span>
  );
}

/** `label` replaces the word of the look (for "Failed · 2 failed runs"); `title` is the hover text. */
type LookProps = { title?: string; label?: ReactNode };
const FromLook = ({ look, title, label }: { look: BadgeLook } & LookProps) => <Badge tone={look.tone} icon={look.icon} title={title}>{label ?? look.label}</Badge>;

/** P0, High, critical ... as the agent wrote it. See `priorityLook` for which word gets which tone. */
export const PriorityBadge = ({ value }: { value: string }) => <FromLook look={priorityLook(value)} />;
export const SeverityBadge = ({ value }: { value: Severity }) => <FromLook look={SEVERITY_LOOK[value]} />;
export const ObservationStatusBadge = ({ value }: { value: ObservationStatus }) => <FromLook look={OBSERVATION_STATUS_LOOK[value]} />;
export const ReviewStatusBadge = ({ value, ...p }: { value: ReviewStatus } & LookProps) => <FromLook look={REVIEW_STATUS_LOOK[value]} {...p} />;
export const CiStatusBadge = ({ value, ...p }: { value: CiStatus } & LookProps) => <FromLook look={CI_STATUS_LOOK[value]} {...p} />;
export const BugWorkflowBadge = ({ value, ...p }: { value: BugWorkflow } & LookProps) => <FromLook look={BUG_WORKFLOW_LOOK[value]} {...p} />;
export const CoverageBadge = ({ value, ...p }: { value: CoverageState } & LookProps) => <FromLook look={COVERAGE_LOOK[value]} {...p} />;
