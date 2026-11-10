import { useState, type ReactNode } from "react";
import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Link2, ScrollText, ShieldCheck, Trash2, Users } from "lucide-react";
import { api, timeAgo, type Project } from "../api";
import { AUDIT_FILTERS, describeAudit, type AuditEntry } from "../accounts";
import { AdminShell } from "../components/AdminShell";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { OneTimeLink } from "../components/OneTimeLink";
import { useAuthStatus } from "../components/Access";
import { ConfirmModal, Empty, useToast } from "../components/ui";

interface UserRow { id: number; email: string; name: string; isOwner: boolean; createdAt: string; lastLoginAt: string | null; disabledAt: string | null }
interface MembershipRow { projectId: number; name: string; key: string; role: string }
interface InvitationRow { id: number; email: string; note: string; createdBy: string; createdAt: string; expiresAt: string; status: "open" | "used" | "revoked" | "expired"; project: { id: number; name: string; key: string } | null; role: string | null }
interface MadeLink { id: number; url: string; expiresAt: string }

const TABS = [{ to: "/admin/accounts", label: "Accounts" }, { to: "/admin/audit-log", label: "Audit log" }] as const;

/** Only the owner of the installation gets in. The server refuses everyone else too; this tells them why instead of showing errors. */
function OwnerOnly({ title, children }: { title: string; children: ReactNode }) {
  const { data: auth, isLoading } = useAuthStatus();
  if (isLoading) return null;
  if (auth?.mode !== "accounts" || !auth.user?.isOwner) {
    return (
      <AdminShell title={title}>
        <Empty icon={<ShieldCheck size={20} />} title="Only the owner can open this">
          {auth?.mode === "accounts" ? "Accounts and the audit log are looked after by the owner of this Testbench. Ask them, or look at your own account." : "There are no accounts here, so there is nothing to look after."}
        </Empty>
      </AdminShell>
    );
  }
  return <AdminShell title={title} tabs={TABS}>{children}</AdminShell>;
}

// ---------- /admin/accounts ----------

export function AdminAccountsPage() {
  return (
    <OwnerOnly title="Administration">
      <AccountList />
      <InviteWithoutProject />
      <OpenInvitations />
    </OwnerOnly>
  );
}

function AccountList() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: auth } = useAuthStatus();
  const [switching, setSwitching] = useState<{ user: UserRow; off: boolean } | null>(null);
  const [link, setLink] = useState<{ for: string; url: string } | null>(null);
  const { data: users, isLoading } = useQuery({ queryKey: ["admin-users"], queryFn: () => api.get<UserRow[]>("/api/users") });
  const others = (users ?? []).filter((u) => !u.isOwner);
  const memberships = useQueries({ queries: others.map((u) => ({ queryKey: ["admin-memberships", u.id], queryFn: () => api.get<MembershipRow[]>(`/api/users/${u.id}/memberships`) })) });
  const projectsOf = (u: UserRow): ReactNode => {
    if (u.isOwner) return "All projects (admin)";
    const q = memberships[others.findIndex((x) => x.id === u.id)];
    if (!q?.data) return <span className="faint">…</span>;
    return q.data.length ? q.data.map((m) => `${m.name} (${m.role})`).join(", ") : <span className="faint">none</span>;
  };
  const toggle = useMutation({
    mutationFn: (v: { id: number; off: boolean }) => api.post<UserRow>(`/api/users/${v.id}/${v.off ? "disable" : "enable"}`),
    onSuccess: (_r, v) => { qc.invalidateQueries({ queryKey: ["admin-users"] }); qc.invalidateQueries({ queryKey: ["audit"] }); setSwitching(null); toast("success", v.off ? "Account switched off" : "Account switched on"); },
    onError: (e: Error) => { setSwitching(null); toast("error", e.message); },
  });
  const reset = useMutation({
    mutationFn: (u: UserRow) => api.post<MadeLink>(`/api/users/${u.id}/reset-link`),
    onSuccess: (r, u) => { setLink({ for: u.name, url: r.url }); qc.invalidateQueries({ queryKey: ["audit"] }); },
    onError: (e: Error) => toast("error", e.message),
  });
  return (
    <Card icon={<Users size={15} />} title={`Accounts${users ? ` (${users.length})` : ""}`}>
      <div className="muted">
        Everyone with an account on this Testbench. Switching an account off ends its sessions at once and it cannot sign in until you switch it on again; what it made stays under its name, and
        tokens it made for a project (CI, agent, propose) keep working, since they belong to the project. A password reset link lets someone choose a new password: you hand it over, since Testbench sends no email.
      </div>
      {link && <OneTimeLink what={`Password reset link for ${link.for}. It works once, for seven days.`} url={link.url} doneLabel="I have handed it over" onDone={() => setLink(null)} />}
      {isLoading ? null : (
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Name</th><th style={{ textAlign: "left" }}>Email</th><th style={{ textAlign: "left" }}>Status</th>
                <th style={{ textAlign: "left" }}>Last signed in</th><th style={{ textAlign: "left" }}>Projects</th><th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {(users ?? []).map((u) => {
                const self = u.id === auth?.user?.id;
                return (
                  <tr key={u.id} style={u.disabledAt ? { color: "var(--text-3)" } : undefined}>
                    <td>{u.name}{u.isOwner && <span className="badge badge--accent" style={{ marginLeft: 6 }}>Owner</span>}{self && <span className="faint"> (you)</span>}</td>
                    <td>{u.email}</td>
                    <td>{u.disabledAt ? "Switched off" : "Active"}</td>
                    <td>{u.lastLoginAt ? timeAgo(u.lastLoginAt) : "never"}</td>
                    <td>{projectsOf(u)}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <Button size="sm" aria-label={`Make a password reset link for ${u.name}`} disabled={reset.isPending} onClick={() => reset.mutate(u)}><KeyRound size={13} /> Reset link</Button>{" "}
                      {u.disabledAt
                        ? <Button size="sm" aria-label={`Switch on ${u.name}`} onClick={() => setSwitching({ user: u, off: false })}>Switch on</Button>
                        : <Button size="sm" aria-label={`Switch off ${u.name}`} disabled={self} title={self ? "You cannot switch off your own account" : undefined} onClick={() => setSwitching({ user: u, off: true })}>Switch off</Button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {switching && (
        <ConfirmModal
          title={switching.off ? `Switch off ${switching.user.name}?` : `Switch on ${switching.user.name}?`}
          confirmLabel={switching.off ? "Switch off" : "Switch on"}
          tone="primary"
          busy={toggle.isPending}
          onConfirm={() => toggle.mutate({ id: switching.user.id, off: switching.off })}
          onClose={() => setSwitching(null)}
        >
          {switching.off
            ? <p style={{ margin: 0 }}>{switching.user.name} is signed out of every session now and cannot sign in. Their data stays, under their name, and the tokens they made for projects keep working. You can switch the account on again.</p>
            : <p style={{ margin: 0 }}>{switching.user.name} can sign in again with their password, and has the same projects and roles as before.</p>}
        </ConfirmModal>
      )}
    </Card>
  );
}

function InviteWithoutProject() {
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.post<MadeLink>("/api/invitations", { ...(email.trim() ? { email: email.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: (r) => { setLink(r.url); setEmail(""); setNote(""); qc.invalidateQueries({ queryKey: ["admin-invitations"] }); qc.invalidateQueries({ queryKey: ["audit"] }); },
    onError: (e: Error) => toast("error", e.message),
  });
  return (
    <Card icon={<Link2 size={15} />} title="Invite someone, without a project">
      <div className="muted">
        The person makes their own account with the link and belongs to no project until an admin of a project adds them. To bring someone straight into a project, use Settings, Members in that project.
        The link works once, for seven days.
      </div>
      <form className="row" style={{ gap: 8, flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <input aria-label="Email address (optional)" type="email" className="input" style={{ flex: "1 1 240px", maxWidth: 340 }} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address (optional)" autoComplete="off" />
        <input aria-label="Note (optional)" className="input" style={{ flex: "1 1 200px", maxWidth: 300 }} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Note, for example who it is (optional)" autoComplete="off" />
        <Button variant="primary" type="submit" disabled={create.isPending}><Link2 size={14} /> Make invitation link</Button>
      </form>
      {link && <OneTimeLink what="Invitation link." url={link} doneLabel="I have handed it over" onDone={() => setLink(null)} />}
    </Card>
  );
}

function OpenInvitations() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ["admin-invitations"], queryFn: () => api.get<InvitationRow[]>("/api/invitations") });
  const open = (data ?? []).filter((i) => i.status === "open");
  const revoke = useMutation({
    mutationFn: (id: number) => api.post(`/api/invitations/${id}/revoke`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-invitations"] }); qc.invalidateQueries({ queryKey: ["audit"] }); toast("success", "Invitation revoked"); },
    onError: (e: Error) => toast("error", e.message),
  });
  if (!open.length) return null;
  return (
    <Card title={`Open invitations (${open.length})`}>
      <div style={{ overflowX: "auto" }}>
        <table className="table" style={{ width: "100%" }}>
          <thead><tr><th style={{ textAlign: "left" }}>For</th><th style={{ textAlign: "left" }}>Project and role</th><th style={{ textAlign: "left" }}>Made by</th><th style={{ textAlign: "left" }}>Expires</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {open.map((i) => (
              <tr key={i.id}>
                <td>{i.email || <span className="faint">anyone with the link</span>}{i.note && <span className="faint"> · {i.note}</span>}</td>
                <td>{i.project ? `${i.project.name} (${i.role})` : <span className="faint">no project</span>}</td>
                <td>{i.createdBy}</td>
                <td>{i.expiresAt.slice(0, 10)}</td>
                <td style={{ textAlign: "right" }}><Button size="sm" aria-label={`Revoke the invitation for ${i.email || "anyone"}`} disabled={revoke.isPending} onClick={() => revoke.mutate(i.id)}><Trash2 size={13} /> Revoke</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------- /admin/audit-log ----------

const PAGE = 50;

export function AdminAuditLogPage() {
  return (
    <OwnerOnly title="Administration">
      <AuditLog />
    </OwnerOnly>
  );
}

function AuditLog() {
  const [prefix, setPrefix] = useState("");
  const { data: users } = useQuery({ queryKey: ["admin-users"], queryFn: () => api.get<UserRow[]>("/api/users") });
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });
  const log = useInfiniteQuery({
    queryKey: ["audit", prefix],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.get<AuditEntry[]>(`/api/audit-log?limit=${PAGE}${pageParam ? `&before=${pageParam}` : ""}${prefix ? `&action=${encodeURIComponent(prefix)}` : ""}`),
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1].id : undefined),
  });
  const entries = (log.data?.pages ?? []).flat();
  const names = {
    user: (id: number | null) => users?.find((u) => u.id === id)?.name,
    project: (id: number | null) => projects?.find((p) => p.id === id)?.name,
  };
  return (
    <Card icon={<ScrollText size={15} />} title={`Audit log${entries.length ? ` (${entries.length}${log.hasNextPage ? " newest" : ""})` : ""}`}>
      <div className="muted">
        What happened to accounts and roles, newest first. It holds no passwords, tokens or reset links, and the database refuses any edit or delete of it. A failed sign-in is recorded with the address it came from, not with what was typed.
      </div>
      <label className="row" style={{ gap: 8 }}>Show
        <select className="select" style={{ width: "auto" }} value={prefix} onChange={(e) => setPrefix(e.target.value)} aria-label="Kind of event">
          {AUDIT_FILTERS.map((f) => <option key={f.label} value={f.prefix}>{f.label}</option>)}
        </select>
      </label>
      {log.isLoading ? null : !entries.length ? (
        <Empty icon={<ScrollText size={20} />} title="Nothing here yet">No events of this kind have been recorded.</Empty>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ width: "100%" }}>
            <thead><tr><th style={{ textAlign: "left" }}>When</th><th style={{ textAlign: "left" }}>What happened</th><th style={{ textAlign: "left" }}>Event</th><th style={{ textAlign: "left" }}>Address</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td title={e.at} style={{ whiteSpace: "nowrap" }}>{timeAgo(e.at)}</td>
                  <td>{describeAudit(e, names)}</td>
                  <td><code className="inline">{e.action}</code></td>
                  <td>{e.ip || <span className="faint">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {log.hasNextPage && <div className="row"><Button disabled={log.isFetchingNextPage} onClick={() => log.fetchNextPage()}>{log.isFetchingNextPage ? "Loading…" : "Load older"}</Button></div>}
    </Card>
  );
}
