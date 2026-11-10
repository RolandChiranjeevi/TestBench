import { useId, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Crown, Eye, Pencil, Shield } from "lucide-react";
import { useParams } from "react-router-dom";
import { api, type Project } from "../api";
import { OPEN, can, isReadOnly, needsText, roleLabel, type Access, type Level, type Needs } from "../access";

/** Who is signed in, as the server says (the same answer the sign-in redirect and Settings use). */
export interface AuthStatus { enabled: boolean; authenticated: boolean; mode?: string; user?: { id: number; name: string; email: string; isOwner: boolean } }
export const useAuthStatus = () => useQuery({ queryKey: ["auth"], queryFn: () => api.get<AuthStatus>("/api/auth/status"), staleTime: 60_000 });
export const useProjectList = () => useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });

/**
 * What the person signed in may do in a project (the one in the address by default). Without accounts everything is allowed. The server decides in the end: this only
 * decides what the screen offers. While the answer is still on its way nothing is held back, since the server refuses what it must anyway.
 */
export function useAccess(projectId?: number | string): Access {
  const params = useParams();
  const id = Number(projectId ?? params.pid);
  const { data: auth } = useAuthStatus();
  const { data: projects } = useProjectList();
  if (auth?.mode !== "accounts") return OPEN;
  const role = projects?.find((p) => p.id === id)?.role ?? null;
  return { accounts: true, role, isOwner: !!auth.user?.isOwner };
}

const ROLE_ICON = { Owner: Crown, Admin: Shield, Tester: Pencil, Viewer: Eye } as const;
const ROLE_TITLE = {
  Owner: "Owner of this Testbench: an admin of every project",
  Admin: "Admin: looks after the project's members, tokens and settings",
  Tester: "Tester: changes test cases, runs and requirements",
  Viewer: "Viewer: can read the project but not change it",
} as const;

/** The person's role, as a small label with an icon and the word (never colour alone). Nothing without accounts. */
export function RoleTag({ access }: { access: Access }) {
  const label = roleLabel(access);
  if (!label) return null;
  const Icon = ROLE_ICON[label];
  return (
    <span className="role-tag" title={ROLE_TITLE[label]} data-role={label.toLowerCase()}>
      <Icon size={11} aria-hidden="true" />
      {label}
    </span>
  );
}

/** The role of a person in a project that is not the one at hand, for the project menu. */
export const accessIn = (base: Access, project: Pick<Project, "role">): Access => ({ ...base, role: (project.role as Level | undefined) ?? null });

/** A notice on project pages for someone who can read but not change. */
export function ReadOnlyNotice() {
  const access = useAccess();
  if (!isReadOnly(access)) return null;
  return <div className="readonly-notice" role="status"><Eye size={14} aria-hidden="true" /> You are a viewer in this project: you can read everything here but not change it.</div>;
}

/** Whether the person may do something that needs `needs`, for the controls that are not buttons (a select, a field, a drop zone). */
export const useCan = (needs: Needs, projectId?: number | string) => can(useAccess(projectId), needs);

/**
 * Turns every field and button inside it off for someone who passes less than `needs`, as a disabled <fieldset> does, and says why. For the parts of a page that are a form
 * to edit something. Keep navigation (a Close button, a link) outside it.
 */
export function EditScope({ needs = "tester", children, className }: { needs?: Needs; children: ReactNode; className?: string }) {
  const allowed = useCan(needs);
  return <fieldset className={["edit-scope", className].filter(Boolean).join(" ")} disabled={!allowed} title={allowed ? undefined : needsText(needs)}>{children}</fieldset>;
}

/** Shows its children only to someone who passes `needs`; others see `otherwise` (nothing by default). */
export function Can({ needs, children, otherwise = null }: { needs: Needs; children: ReactNode; otherwise?: ReactNode }) {
  return can(useAccess(), needs) ? <>{children}</> : <>{otherwise}</>;
}

/**
 * What a control that needs a role looks like to someone without it: off, with the reason in words next to it for a screen reader and on hover.
 * `children` gets `disabled` and `describedBy` to put on the control itself.
 */
export function Gate({ needs, children }: { needs: Needs; children: (p: { disabled: boolean; describedBy?: string }) => ReactNode }) {
  const allowed = can(useAccess(), needs);
  const reason = useId();
  if (allowed) return <>{children({ disabled: false })}</>;
  return (
    <span className="needs-wrap" title={needsText(needs)}>
      {children({ disabled: true, describedBy: reason })}
      <span id={reason} className="sr-only">{needsText(needs)}</span>
    </span>
  );
}
