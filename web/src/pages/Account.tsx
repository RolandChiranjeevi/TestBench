import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LogOut, MonitorSmartphone, UserRound } from "lucide-react";
import { api, timeAgo } from "../api";
import { PASSWORD_RULES, deviceLabel, passwordFormProblem } from "../accounts";
import { AdminShell } from "../components/AdminShell";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { useAuthStatus } from "../components/Access";
import { Empty, useToast } from "../components/ui";

interface Me { user: { id: number; name: string; email: string; isOwner: boolean }; sessionId: number | null }
interface SessionRow { id: number; createdAt: string; expiresAt: string; lastSeenAt: string | null; ip: string; userAgent: string; current: boolean }

const signOut = async () => { await api.post("/api/logout"); window.location.href = "/login"; };

/** /account: a person's own name, email, password and sessions. Outside any project, so it works for someone who is in none. */
export function AccountPage() {
  const { data: auth, isLoading } = useAuthStatus();
  if (isLoading) return null;
  if (auth?.mode !== "accounts") {
    return (
      <AdminShell title="Your account">
        <Empty icon={<UserRound size={20} />} title="There are no accounts here">
          Accounts are off, or Testbench is protected with one shared password. Your own name, email, password and sessions come with accounts: make the first one on the server (see the README, “Accounts”).
        </Empty>
      </AdminShell>
    );
  }
  return (
    <AdminShell title="Your account">
      <ProfileCard />
      <PasswordCard />
      <SessionsCard />
      <Card icon={<LogOut size={15} />} title="Sign out">
        <div className="muted">Ends this session. Your other sessions, if you have any, are listed above.</div>
        <div className="row"><Button onClick={signOut}><LogOut size={14} /> Sign out</Button></div>
      </Card>
    </AdminShell>
  );
}

function ProfileCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/me") });
  const [name, setName] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const user = me?.user;
  const nameValue = name ?? user?.name ?? "";
  const emailValue = email ?? user?.email ?? "";
  const nameChanged = !!user && nameValue.trim() !== user.name;
  const emailChanged = !!user && emailValue.trim().toLowerCase() !== user.email.toLowerCase();
  const save = useMutation({
    mutationFn: () => api.patch<Me>("/api/me", { ...(nameChanged ? { name: nameValue.trim() } : {}), ...(emailChanged ? { email: emailValue.trim(), currentPassword: password } : {}) }),
    onSuccess: (r) => {
      qc.setQueryData(["me"], r);
      for (const k of ["auth", "display-name"]) qc.invalidateQueries({ queryKey: [k] });
      setName(null); setEmail(null); setPassword("");
      toast("success", "Saved");
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const ready = (nameChanged || emailChanged) && (!emailChanged || password.length > 0) && nameValue.trim().length > 0;
  return (
    <Card icon={<UserRound size={15} />} title="Profile">
      <div className="muted">
        Your name is what is recorded on what you do (created by, approved by, the change log). Testbench does not check that it is your real name. Your email address is what you sign in with.
        {user?.isOwner && " You are the owner of this Testbench."}
      </div>
      <form className="col" style={{ gap: 10, maxWidth: 420 }} onSubmit={(e) => { e.preventDefault(); if (ready) save.mutate(); }}>
        <label className="col" style={{ gap: 4 }}>Name
          <input className="input" value={nameValue} maxLength={80} autoComplete="name" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="col" style={{ gap: 4 }}>Email address
          <input className="input" type="email" value={emailValue} autoComplete="email" onChange={(e) => setEmail(e.target.value)} />
        </label>
        {emailChanged && (
          <label className="col" style={{ gap: 4 }}>Current password
            <input className="input" type="password" value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} aria-describedby="email-needs-password" />
            <span id="email-needs-password" className="faint" style={{ fontSize: "var(--fs-md)" }}>Changing the email address takes your current password, since it is what you sign in with.</span>
          </label>
        )}
        <div className="row"><Button variant="primary" type="submit" disabled={!ready || save.isPending}>Save</Button></div>
      </form>
    </Card>
  );
}

function PasswordCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/me") });
  const [f, setF] = useState({ current: "", next: "", again: "" });
  const [touched, setTouched] = useState(false);
  const [done, setDone] = useState(false);
  const problem = passwordFormProblem(f, { email: me?.user.email, name: me?.user.name });
  const change = useMutation({
    mutationFn: () => api.post("/api/me/password", { current: f.current, next: f.next }),
    onSuccess: () => { setF({ current: "", next: "", again: "" }); setTouched(false); setDone(true); qc.invalidateQueries({ queryKey: ["sessions"] }); toast("success", "Password changed"); },
    onError: (e: Error) => toast("error", e.message),
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => { setDone(false); setF({ ...f, [k]: e.target.value }); };
  return (
    <Card icon={<KeyRound size={15} />} title="Password">
      <form className="col" style={{ gap: 10, maxWidth: 420 }} onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!problem) change.mutate(); }}>
        <label className="col" style={{ gap: 4 }}>Current password
          <input className="input" type="password" value={f.current} autoComplete="current-password" onChange={set("current")} />
        </label>
        <label className="col" style={{ gap: 4 }}>New password
          <input className="input" type="password" value={f.next} autoComplete="new-password" onChange={set("next")} aria-describedby="password-rules" />
        </label>
        <label className="col" style={{ gap: 4 }}>New password, again
          <input className="input" type="password" value={f.again} autoComplete="new-password" onChange={set("again")} />
        </label>
        <ul id="password-rules" className="faint" style={{ margin: 0, paddingLeft: 18, fontSize: "var(--fs-md)" }}>
          {PASSWORD_RULES.map((r) => <li key={r}>{r}</li>)}
        </ul>
        {touched && problem && <div role="alert" style={{ color: "var(--failed-fg)" }}>{problem}</div>}
        {done && <div role="status" className="muted">Your password is changed. Every other session of yours has been signed out; this one stays.</div>}
        <div className="row"><Button variant="primary" type="submit" disabled={change.isPending}>Change password</Button></div>
      </form>
    </Card>
  );
}

function SessionsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["sessions"];
  const { data: sessions, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<SessionRow[]>("/api/me/sessions") });
  const others = (sessions ?? []).filter((s) => !s.current);
  const revoke = useMutation({
    mutationFn: (id: number) => api.post(`/api/me/sessions/${id}/revoke`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); toast("success", "Signed out"); },
    onError: (e: Error) => { qc.invalidateQueries({ queryKey: key }); toast("error", e.message); },
  });
  const revokeOthers = useMutation({
    mutationFn: () => api.post<{ ended: number }>("/api/me/sessions/revoke-others"),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: key }); toast("success", r.ended ? `Signed out of ${r.ended} other session${r.ended === 1 ? "" : "s"}` : "There were no other sessions"); },
    onError: (e: Error) => toast("error", e.message),
  });
  return (
    <Card icon={<MonitorSmartphone size={15} />} title={`Sessions${sessions ? ` (${sessions.length})` : ""}`}>
      <div className="muted">Each place you are signed in is a session. If you see one you do not know, sign it out and change your password.</div>
      {isLoading ? null : (
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ width: "100%" }}>
            <thead>
              <tr><th style={{ textAlign: "left" }}>Device</th><th style={{ textAlign: "left" }}>Address</th><th style={{ textAlign: "left" }}>Signed in</th><th style={{ textAlign: "left" }}>Last seen</th><th style={{ textAlign: "left" }}>Expires</th><th><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {(sessions ?? []).map((s) => (
                <tr key={s.id}>
                  <td>{deviceLabel(s.userAgent)} {s.current && <span className="badge badge--accent" style={{ marginLeft: 6 }}>This session</span>}</td>
                  <td>{s.ip || "unknown"}</td>
                  <td>{timeAgo(s.createdAt)}</td>
                  <td>{s.lastSeenAt ? timeAgo(s.lastSeenAt) : "never"}</td>
                  <td>{s.expiresAt.slice(0, 10)}</td>
                  <td style={{ textAlign: "right" }}>
                    {!s.current && <Button size="sm" aria-label={`Sign out ${deviceLabel(s.userAgent)} from ${s.ip || "an unknown address"}`} disabled={revoke.isPending} onClick={() => revoke.mutate(s.id)}><LogOut size={13} /> Sign out</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row">
        <Button disabled={!others.length || revokeOthers.isPending} onClick={() => revokeOthers.mutate()}><LogOut size={14} /> Sign out everywhere else{others.length ? ` (${others.length})` : ""}</Button>
      </div>
    </Card>
  );
}
