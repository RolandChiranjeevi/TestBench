import { useState, type ReactNode } from "react";
import { Navigate, NavLink, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, LogOut, Pencil, ShieldAlert, Trash2 } from "lucide-react";
import { api, timeAgo, type Project } from "../api";
import { ConfirmModal, Empty, Kbd, useToast } from "../components/ui";
import { DeleteProjectModal, RenameProjectModal } from "../components/ProjectModals";
import { BackupPage } from "./Backup";

interface AgentToken { id: number; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }
/** The answer to creating a token. `token` is in it this once and is never stored by the server (only its hash) or by this page. */
interface NewAgentToken { id: number; name: string; prefix: string; createdAt: string; token: string }

export const SETTINGS_SECTIONS = [
  ["agent", "Agent access"],
  ["project", "Project"],
  ["data", "Data"],
  ["shortcuts", "Keyboard shortcuts"],
  ["account", "Account"],
] as const;
type Section = (typeof SETTINGS_SECTIONS)[number][0];

export function SettingsPage() {
  const { pid, section } = useParams();
  const known = SETTINGS_SECTIONS.find(([id]) => id === section);
  if (!known) return <Navigate to={`/p/${pid}/settings/agent`} replace />;
  const id = known[0] as Section;
  return (
    <>
      <div className="topbar">
        <h1>Settings</h1>
      </div>
      <nav className="tabs" aria-label="Settings sections" style={{ padding: "8px 20px 0", flexWrap: "wrap" }}>
        {SETTINGS_SECTIONS.map(([s, label]) => (
          <NavLink key={s} to={`/p/${pid}/settings/${s}`} className={({ isActive }) => `tab${isActive ? " active" : ""}`}>{label}</NavLink>
        ))}
      </nav>
      <div className="content">
        {id === "data" ? (
          <BackupPage embedded />
        ) : (
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16, maxWidth: 760 }}>
            {id === "agent" && <AgentAccess pid={Number(pid)} />}
            {id === "project" && <ProjectSection pid={Number(pid)} />}
            {id === "shortcuts" && <Shortcuts />}
            {id === "account" && <Account />}
          </div>
        )}
      </div>
    </>
  );
}

const Card = ({ icon, title, children }: { icon?: ReactNode; title: string; children: ReactNode }) => (
  <div className="card">
    <div className="card-header" role="heading" aria-level={2}>{icon} {title}</div>
    <div className="card-body col" style={{ gap: 12 }}>{children}</div>
  </div>
);

// ---------- Agent access ----------

function AgentAccess({ pid }: { pid: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  // The new token lives in this state only: not in the query cache, not in storage, not in the URL.
  const [fresh, setFresh] = useState<NewAgentToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<AgentToken | null>(null);
  const key = ["agent-tokens", pid];
  const { data: tokens, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<AgentToken[]>(`/api/projects/${pid}/agent/tokens`) });
  const create = useMutation({ mutationFn: (n: string) => api.post<NewAgentToken>(`/api/projects/${pid}/agent/tokens`, { name: n }) });
  const revoke = useMutation({
    mutationFn: (id: number) => api.post(`/api/agent-tokens/${id}/revoke`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); setRevoking(null); toast("success", "Token revoked"); },
    onError: (e: Error) => toast("error", e.message),
  });

  const submit = async () => {
    if (!name.trim()) return;
    try {
      const t = await create.mutateAsync(name.trim());
      create.reset(); // drop the answer, which holds the token, from the mutation cache
      setFresh(t);
      setCopied(false);
      setName("");
      qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };
  const copy = async () => {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.token);
      setCopied(true);
    } catch {
      toast("error", "Could not copy. Select the token and copy it by hand.");
    }
  };

  const active = tokens?.filter((t) => !t.revokedAt) ?? [];
  return (
    <>
      <Card icon={<KeyRound size={15} />} title="Agent tokens">
        <div className="muted">
          A test agent reads this project's active requirements with a token. The token opens that one read-only route and nothing else: no other route,
          no write, no other project. It is shown once, when you create it. Testbench keeps only a hash, so a lost token cannot be shown again: revoke it and make a new one.
        </div>
        <form className="row" style={{ gap: 8, flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <input id="token-name" aria-label="Token name" className="input" style={{ flex: "1 1 220px", maxWidth: 320 }} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="Name, for example qa-agent" />
          <button className="btn primary" type="submit" disabled={!name.trim() || create.isPending}><KeyRound size={14} /> Create token</button>
        </form>

        {fresh && (
          <div role="status" className="card" style={{ padding: 12, background: "var(--bg)", borderColor: "var(--blocked-fg)" }}>
            <div className="row" style={{ gap: 8, alignItems: "flex-start", color: "var(--blocked-fg)" }}>
              <ShieldAlert size={16} style={{ flexShrink: 0, marginTop: 2 }} />
              <span style={{ color: "var(--text-2)" }}>
                Copy <strong>{fresh.name}</strong> now. It is not shown again. Keep it in an environment variable or a secret, never in a file in a repository.
              </span>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <code className="inline mono" style={{ wordBreak: "break-all", userSelect: "all" }}>{fresh.token}</code>
              <button className="btn sm" onClick={copy}>{copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}</button>
              <button className="btn sm ghost" onClick={() => setFresh(null)}>I have saved it</button>
            </div>
          </div>
        )}
      </Card>

      <Card title={`Tokens for this project${tokens ? ` (${active.length} active)` : ""}`}>
        {isLoading ? null : !tokens?.length ? (
          <Empty icon={<KeyRound size={20} />} title="No tokens yet">Create one above, then give it to your agent as an environment variable.</Empty>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table" style={{ width: "100%" }}>
              <thead>
                <tr><th style={{ textAlign: "left" }}>Name</th><th style={{ textAlign: "left" }}>Token</th><th style={{ textAlign: "left" }}>Created</th><th style={{ textAlign: "left" }}>Last used</th><th style={{ textAlign: "left" }}>Status</th><th><span className="sr-only" style={{ position: "absolute", left: -9999 }}>Actions</span></th></tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id} style={t.revokedAt ? { color: "var(--text-3)" } : undefined}>
                    <td>{t.name}</td>
                    <td><code className="inline">{t.prefix}…</code></td>
                    <td>{timeAgo(t.createdAt)}</td>
                    <td>{t.lastUsedAt ? timeAgo(t.lastUsedAt) : "never"}</td>
                    <td>{t.revokedAt ? `Revoked ${timeAgo(t.revokedAt)}` : "Active"}</td>
                    <td style={{ textAlign: "right" }}>
                      {!t.revokedAt && <button className="btn sm" aria-label={`Revoke ${t.name}`} onClick={() => setRevoking(t)}><Trash2 size={13} /> Revoke</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="faint" style={{ fontSize: "var(--fs-md)" }}>A project can have five active tokens. Revoking is the only way to end one; there is no expiry yet.</div>
      </Card>

      <Card title="Using a token">
        <div className="muted">The agent sends it as a Bearer token. Read it from an environment variable, and put only the variable's name in the agent's configuration.</div>
        <pre className="mono" style={{ margin: 0, padding: 10, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflowX: "auto" }}>
{`GET ${window.location.origin}/api/agent/projects/${pid}/requirements
Authorization: Bearer $TESTBENCH_API_TOKEN`}
        </pre>
      </Card>

      {revoking && (
        <ConfirmModal
          title={`Revoke "${revoking.name}"?`}
          confirmLabel="Revoke token"
          busy={revoke.isPending}
          onConfirm={() => revoke.mutate(revoking.id)}
          onClose={() => setRevoking(null)}
        >
          <p style={{ margin: 0 }}>An agent using <code className="inline">{revoking.prefix}…</code> gets an error from the next request. This cannot be undone; make a new token if it is still needed.</p>
        </ConfirmModal>
      )}
    </>
  );
}

// ---------- Project ----------

function ProjectSection({ pid }: { pid: number }) {
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });
  const project = projects?.find((p) => p.id === pid);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  if (!project) return null;
  return (
    <>
      <Card title="This project">
        <div className="row" style={{ gap: 28, flexWrap: "wrap" }}>
          <div className="stat"><span className="value">{project.name}</span><span className="label">name</span></div>
          <div className="stat"><span className="value mono">{project.key}</span><span className="label">key</span></div>
          <div className="stat"><span className="value mono">{project.id}</span><span className="label">id</span></div>
          <div className="stat"><span className="value">{project.case_count}</span><span className="label">cases</span></div>
          <div className="stat"><span className="value">{project.run_count}</span><span className="label">runs</span></div>
        </div>
        <div className="faint" style={{ fontSize: "var(--fs-md)" }}>
          The id is what an agent's configuration calls <code className="inline">projectId</code>, and what the API addresses contain (<code className="inline">/api/projects/{project.id}/…</code>).
          The key is what case IDs use. The id never changes, even when the project is renamed.
        </div>
        <div className="row"><button className="btn" onClick={() => setRenaming(true)}><Pencil size={14} /> Rename</button></div>
      </Card>
      <Card title="Delete this project">
        <div className="muted">Permanently deletes the project and everything in it. You are asked to type the key first, and a backup is saved before when automatic backups are on.</div>
        <div className="row"><button className="btn" style={{ color: "var(--failed-fg)" }} onClick={() => setDeleting(true)}><Trash2 size={14} /> Delete this project…</button></div>
      </Card>
      {renaming && <RenameProjectModal project={project} onClose={() => setRenaming(false)} />}
      {deleting && <DeleteProjectModal project={project} onClose={() => setDeleting(false)} />}
    </>
  );
}

// ---------- Keyboard shortcuts ----------

const SHORTCUTS: [string, [string, string][]][] = [
  ["Go to (anywhere in a project)", [["1", "Dashboard"], ["2", "Requirements"], ["3", "Test cases"], ["4", "Runs"], ["5", "Bug reports"], ["6", "Agent proposals"], ["7", "Automated tests"], ["8", "Import results"], ["9", "Sprint reports"], ["0", "Settings"]]],
  ["Test cases", [["c", "New case"], ["/", "Search"], ["j / ↓", "Next"], ["k / ↑", "Previous"], ["Enter / o", "Open"], ["x", "Select"], ["r", "Run the selected cases"]]],
  ["Requirements", [["c", "New requirement"], ["/", "Search"]]],
  ["Runs", [["c", "New run"]]],
  ["Run detail", [["j / ↓", "Next result"], ["k / ↑", "Previous result"], ["p", "Passed, then next"], ["f", "Failed"], ["b", "Blocked"], ["s", "Skipped, then next"]]],
];

function Shortcuts() {
  return (
    <Card title="Keyboard shortcuts">
      <div className="muted">Single keys. They are ignored while you type in a field, with Ctrl, Cmd or Alt held, or while a dialog is open.</div>
      {SHORTCUTS.map(([group, rows]) => (
        <div key={group}>
          <div style={{ fontWeight: 500, marginBottom: 4 }}>{group}</div>
          <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: "4px 12px" }}>
            {rows.map(([k, what]) => (
              <div key={k} style={{ display: "contents" }}><span><Kbd>{k}</Kbd></span><span className="muted">{what}</span></div>
            ))}
          </div>
        </div>
      ))}
    </Card>
  );
}

// ---------- Account ----------

function Account() {
  const { data: auth } = useQuery({ queryKey: ["auth"], queryFn: () => api.get<{ enabled: boolean; authenticated: boolean }>("/api/auth/status"), staleTime: 60_000 });
  return (
    <Card icon={<LogOut size={15} />} title="Account">
      {auth?.enabled ? (
        <>
          <div className="muted">This Testbench is protected with a password, and you are signed in.</div>
          <div className="row">
            <button className="btn" onClick={async () => { await api.post("/api/logout"); window.location.href = "/login"; }}><LogOut size={14} /> Sign out</button>
          </div>
        </>
      ) : (
        <div className="muted">Password protection is off, so there is nothing to sign in to. Set <code className="inline">TESTBENCH_PASSWORD</code> to turn it on.</div>
      )}
    </Card>
  );
}
