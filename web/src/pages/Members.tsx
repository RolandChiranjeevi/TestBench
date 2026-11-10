import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Link2, ShieldAlert, Trash2, UserPlus, Users } from "lucide-react";
import { api, timeAgo } from "../api";
import { LEVELS, can, type Level } from "../access";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { RoleTag, useAccess } from "../components/Access";
import { ConfirmModal, Empty, useToast } from "../components/ui";

/** A member as the server lists them. Only an admin gets the email address. */
interface Member { userId: number; name: string; email?: string; role: Level; addedAt: string; disabled: boolean }
interface Invitation { id: number; email: string; note: string; createdBy: string; createdAt: string; expiresAt: string; status: "open" | "used" | "revoked" | "expired"; project: { id: number } | null; role: string | null }
interface NewInvitation { id: number; url: string; expiresAt: string }

const cap = (r: string) => r[0].toUpperCase() + r.slice(1);
const ROLE_HELP: Record<Level, string> = {
  admin: "Looks after the project's members, tokens and settings, and can delete things",
  tester: "Changes test cases, runs, results, observations and requirements, and approves proposals",
  viewer: "Reads everything in the project, and changes nothing",
};
const RoleSelect = ({ value, onChange, disabled, label }: { value: Level; onChange: (r: Level) => void; disabled?: boolean; label: string }) => (
  <select aria-label={label} className="input" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as Level)} style={{ width: "auto" }}>
    {[...LEVELS].reverse().map((r) => <option key={r} value={r}>{cap(r)}</option>)}
  </select>
);

/**
 * Who is in the project and with which role. Everyone in the project sees the list; an admin also sees email addresses and looks after it: adds an account that
 * exists, changes a role, removes someone, and makes invitation links for people who have no account yet. Testbench sends no email: the link is handed over.
 */
export function MembersSection({ pid }: { pid: number }) {
  const access = useAccess(pid);
  const admin = can(access, "admin");
  if (!access.accounts) {
    return (
      <Card icon={<Users size={15} />} title="Members">
        <div className="muted">Roles and members come with accounts. This Testbench has none, so everyone who can open it can do everything. Make the first account on the server to turn them on (see the README, “Accounts”).</div>
      </Card>
    );
  }
  return (
    <>
      <MemberList pid={pid} admin={admin} />
      {admin && <AddMember pid={pid} />}
      {admin && <Invite pid={pid} />}
      {admin && <OpenInvitations pid={pid} />}
    </>
  );
}

function MemberList({ pid, admin }: { pid: number; admin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [removing, setRemoving] = useState<Member | null>(null);
  const key = ["members", pid];
  const { data: members, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<Member[]>(`/api/projects/${pid}/members`) });
  const change = useMutation({
    mutationFn: (v: { userId: number; role: Level }) => api.patch(`/api/projects/${pid}/members/${v.userId}`, { role: v.role }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ["projects"] }); toast("success", "Role changed"); },
    onError: (e: Error) => { qc.invalidateQueries({ queryKey: key }); toast("error", e.message); },
  });
  const remove = useMutation({
    mutationFn: (userId: number) => api.del(`/api/projects/${pid}/members/${userId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ["projects"] }); setRemoving(null); toast("success", "Removed from the project"); },
    onError: (e: Error) => { setRemoving(null); toast("error", e.message); },
  });
  return (
    <Card icon={<Users size={15} />} title={`Members${members ? ` (${members.length})` : ""}`}>
      <div className="muted">
        Each person has one role in this project. The owner of this Testbench is an admin of every project, and is not listed here.
        A project keeps at least one admin among its members.
      </div>
      {isLoading ? null : !members?.length ? (
        <Empty icon={<Users size={20} />} title="No members yet">{admin ? "Add an account below, or make an invitation link." : "Only the owner is in this project so far."}</Empty>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Name</th>
                {admin && <th style={{ textAlign: "left" }}>Email</th>}
                <th style={{ textAlign: "left" }}>Role</th>
                <th style={{ textAlign: "left" }}>Added</th>
                {admin && <th><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId} style={m.disabled ? { color: "var(--text-3)" } : undefined}>
                  <td>{m.name}{m.disabled && <span className="faint"> (account switched off)</span>}</td>
                  {admin && <td>{m.email}</td>}
                  <td>
                    {admin
                      ? <RoleSelect label={`Role of ${m.name}`} value={m.role} disabled={change.isPending} onChange={(role) => change.mutate({ userId: m.userId, role })} />
                      : <RoleTag access={{ accounts: true, role: m.role, isOwner: false }} />}
                  </td>
                  <td>{timeAgo(m.addedAt)}</td>
                  {admin && (
                    <td style={{ textAlign: "right" }}>
                      <Button size="sm" aria-label={`Remove ${m.name}`} onClick={() => setRemoving(m)}><Trash2 size={13} /> Remove</Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ul className="faint" style={{ margin: 0, paddingLeft: 18, fontSize: "var(--fs-md)" }}>
        {[...LEVELS].reverse().map((r) => <li key={r}><strong>{cap(r)}</strong>: {ROLE_HELP[r]}</li>)}
      </ul>
      {removing && (
        <ConfirmModal title={`Remove ${removing.name}?`} confirmLabel="Remove from project" busy={remove.isPending} onConfirm={() => remove.mutate(removing.userId)} onClose={() => setRemoving(null)}>
          <p style={{ margin: 0 }}>{removing.name} can no longer open this project, from the next request on, also if they are signed in. What they made stays, under their name. You can add them again later.</p>
        </ConfirmModal>
      )}
    </Card>
  );
}

function AddMember({ pid }: { pid: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Level>("tester");
  const add = useMutation({
    mutationFn: () => api.post(`/api/projects/${pid}/members`, { email: email.trim(), role }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["members", pid] }); setEmail(""); toast("success", "Added to the project"); },
    onError: (e: Error) => toast("error", e.message),
  });
  return (
    <Card icon={<UserPlus size={15} />} title="Add someone who has an account">
      <div className="muted">Type the email address of an account on this Testbench. If there is no such account, you are told, and can invite the person with a link instead.</div>
      <form className="row" style={{ gap: 8, flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); if (email.trim()) add.mutate(); }}>
        <input aria-label="Email address" type="email" className="input" style={{ flex: "1 1 240px", maxWidth: 340 }} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" autoComplete="off" />
        <RoleSelect label="Role" value={role} onChange={setRole} />
        <Button variant="primary" type="submit" needs="admin" disabled={!email.trim() || add.isPending}><UserPlus size={14} /> Add</Button>
      </form>
    </Card>
  );
}

function Invite({ pid }: { pid: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [role, setRole] = useState<Level>("tester");
  const [email, setEmail] = useState("");
  // The link lives in this state only: not in the query cache, not in storage. It is shown once, as the server shows it once.
  const [fresh, setFresh] = useState<NewInvitation | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useMutation({ mutationFn: () => api.post<NewInvitation>("/api/invitations", { projectId: pid, role, ...(email.trim() ? { email: email.trim() } : {}) }) });
  const submit = async () => {
    try {
      const made = await create.mutateAsync();
      create.reset();
      setFresh(made);
      setCopied(false);
      setEmail("");
      qc.invalidateQueries({ queryKey: ["invitations", pid] });
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };
  const copy = async () => {
    if (!fresh) return;
    try { await navigator.clipboard.writeText(fresh.url); setCopied(true); } catch { toast("error", "Could not copy. Select the link and copy it by hand."); }
  };
  return (
    <Card icon={<Link2 size={15} />} title="Invite someone who has no account">
      <div className="muted">
        Testbench sends no email. You make a link and hand it over. It works once, for seven days, and the person makes their own account with it and joins this project with the role you pick.
        Fill in an email address to make the link work for that address only.
      </div>
      <form className="row" style={{ gap: 8, flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <input aria-label="Email address (optional)" type="email" className="input" style={{ flex: "1 1 240px", maxWidth: 340 }} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address (optional)" autoComplete="off" />
        <RoleSelect label="Role of the person invited" value={role} onChange={setRole} />
        <Button variant="primary" type="submit" needs="admin" disabled={create.isPending}><Link2 size={14} /> Make invitation link</Button>
      </form>
      {fresh && (
        <div role="status" className="card" style={{ padding: 12, background: "var(--bg)", borderColor: "var(--blocked-fg)" }}>
          <div className="row" style={{ gap: 8, alignItems: "flex-start", color: "var(--blocked-fg)" }}>
            <ShieldAlert size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <span style={{ color: "var(--text-2)" }}>Copy the link now. It is not shown again, and anyone who has it can use it once.</span>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <code className="inline mono" style={{ wordBreak: "break-all", userSelect: "all" }}>{fresh.url}</code>
            <Button size="sm" onClick={copy}>{copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}</Button>
            <Button variant="ghost" size="sm" onClick={() => setFresh(null)}>I have handed it over</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function OpenInvitations({ pid }: { pid: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["invitations", pid];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<Invitation[]>("/api/invitations") });
  const open = (data ?? []).filter((i) => i.project?.id === pid && i.status === "open");
  const revoke = useMutation({
    mutationFn: (id: number) => api.post(`/api/invitations/${id}/revoke`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); toast("success", "Invitation revoked"); },
    onError: (e: Error) => toast("error", e.message),
  });
  if (!open.length) return null;
  return (
    <Card title={`Open invitations (${open.length})`}>
      <div style={{ overflowX: "auto" }}>
        <table className="table" style={{ width: "100%" }}>
          <thead><tr><th style={{ textAlign: "left" }}>For</th><th style={{ textAlign: "left" }}>Role</th><th style={{ textAlign: "left" }}>Made by</th><th style={{ textAlign: "left" }}>Expires</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {open.map((i) => (
              <tr key={i.id}>
                <td>{i.email || <span className="faint">anyone with the link</span>}</td>
                <td>{i.role}</td>
                <td>{i.createdBy}</td>
                <td>{i.expiresAt.slice(0, 10)}</td>
                <td style={{ textAlign: "right" }}><Button size="sm" aria-label={`Revoke the invitation for ${i.email || "anyone"}`} onClick={() => revoke.mutate(i.id)} disabled={revoke.isPending}><Trash2 size={13} /> Revoke</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
