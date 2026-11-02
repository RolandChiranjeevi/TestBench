import { useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bug, Check, ExternalLink, FileText, FolderOpen, Link2, Paperclip, Pencil, Trash2, Upload } from "lucide-react";
import { api, timeAgo, type Priority } from "../api";
import { ConfirmModal, Empty, ListSkeleton, Modal, PriorityIcon, PRIORITY_LABEL, useToast } from "../components/ui";

type Status = "proposed" | "accepted" | "rejected" | "duplicate";
interface Item {
  id: number; sourceId: string; title: string; status: Status; severity: Priority | null; foundAt: string | null; importedAt: string;
  auditTitle: string; auditDeleted: boolean; unresolvedRefs: number; attachments: number; attachmentProblems: number; pendingUpdate: boolean; published: boolean;
}
interface List { items: Item[]; counts: Record<string, number> }
interface Ref { id: number; kind: string; raw: string; state: string; reason: string; label: string; target: { kind: string; id: number } | null }
interface Attachment { id: number; declared_path: string; filename: string; mime: string; size: number; label: string; stored_name: string | null; state: string; reason: string; active: number }
interface Detail {
  id: number; projectId: number; sourceId: string; status: Status; reviewedAt: string | null; reviewNote: string; editedAt: string | null;
  title: string; description: string; steps: string[]; expected: string; actual: string; environment: string; url: string;
  severity: { tool: { tool: string; value: string; ruleId?: string } | null; agent: Priority | null; human: Priority | null; effective: Priority | null };
  confidence: number | null; agentReview: { status: string; method: string; notes: string } | null; foundAt: string | null; importedAt: string; fingerprint: string;
  origin: { title?: string; agent?: { name?: string; version?: string; model?: string }; review?: { status: string; method: string; reviewer: string } | null; source?: string; github?: { repo: string; runId: number } | null };
  originAuditId: string; audit: { id: number; title: string; run_state: string; has_report: number } | null; runId: number | null;
  refs: Ref[]; attachments: Attachment[]; revisions: { rev: number; imported_at: string }[];
  pendingUpdate: { rev: number; changes: { field: string; from: string; to: string }[]; evidenceAdded: number; evidenceRemoved: number } | null;
  duplicateOf: { id: number; title: string } | null; duplicates: { id: number; title: string }[]; similar: { id: number; title: string; status: string }[];
  publications: { id: number; destination: string; destination_ref: string; mode: string; state: string; external_id: string; external_url: string }[];
}
interface Audit {
  id: number; agentAuditId: string; title: string; agent: string; startedAt: string | null; source: string; github: { repo: string; runId: number } | null;
  runState: string; hasReport: boolean; bugs: number; proposed: number; imports: number; lastImportedAt: string;
}
interface Summary {
  dryRun: boolean; audit: { agentAuditId: string; title: string; agent: string; isNew: boolean; github: { repo: string; runId: number } | null; runState: string };
  counts: { new: number; unchanged: number; updated: number; pending: number }; evidence: { ok: number; problems: number }; unresolvedRefs: number; warnings: string[];
  items: { sourceId: string; title: string; action: string; severity: string | null; unresolvedRefs: number; evidenceProblems: number }[];
}

type Tab = Status | "all" | "audits";
const TAB_LABEL: Record<Tab, string> = { proposed: "Proposed", accepted: "Accepted", rejected: "Rejected", duplicate: "Duplicates", all: "All", audits: "Audits" };
const STATUS_LABEL: Record<Status, string> = { proposed: "Proposed", accepted: "Accepted", rejected: "Rejected", duplicate: "Duplicate" };
const STATUS_COLOR: Record<Status, string> = { proposed: "var(--blocked)", accepted: "var(--passed)", rejected: "var(--text-3)", duplicate: "var(--text-3)" };
const STATUS_FG: Record<Status, string> = { proposed: "var(--blocked-fg)", accepted: "var(--passed-fg)", rejected: "var(--text-3)", duplicate: "var(--text-3)" };
const RUN_STATE: Record<string, string> = { linked: "Linked to the run", pending: "Waiting for the run to be imported", none: "No GitHub run named", deleted: "The run was deleted" };
const DANGER = { color: "var(--failed-fg)" };

function StatusChip({ status }: { status: Status }) {
  return (
    <span className="chip status" style={{ color: STATUS_FG[status] }}>
      <span className="dot" style={{ background: STATUS_COLOR[status] }} />
      {STATUS_LABEL[status]}
    </span>
  );
}

function Severity({ value }: { value: Priority | null }) {
  if (!value) return <span className="faint">—</span>;
  return <span className="row" style={{ gap: 4 }}><PriorityIcon priority={value} size={13} /> {PRIORITY_LABEL[value]}</span>;
}

export function BugReportsPage() {
  const { pid } = useParams();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>("proposed");
  const [importing, setImporting] = useState(false);
  const open = Number(params.get("bug")) || null;
  const statusParam = tab === "audits" ? "proposed" : tab;
  const { data, isLoading } = useQuery({ queryKey: ["bug-reports", pid, statusParam], queryFn: () => api.get<List>(`/api/projects/${pid}/bug-reports?status=${statusParam}`) });
  const counts = data?.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const setOpen = (id: number | null) => setParams((p) => { if (id) p.set("bug", String(id)); else p.delete("bug"); return p; }, { replace: true });

  return (
    <>
      <div className="topbar">
        <h1>Bug reports</h1>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setImporting(true)}><Upload size={14} /> Import audit package</button>
      </div>
      <div className="toolbar">
        <div className="tabs" role="tablist">
          {(["proposed", "accepted", "rejected", "duplicate", "all", "audits"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
              {TAB_LABEL[t]}
              {t !== "audits" && <span className="count">{t === "all" ? total : (counts[t] ?? 0)}</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="content">
        {tab === "audits" ? (
          <AuditsPanel pid={pid!} />
        ) : isLoading ? (
          <ListSkeleton />
        ) : !data?.items.length ? (
          <Empty
            icon={<Bug size={20} />}
            title={tab === "proposed" ? "Nothing waiting for review" : "No bug reports here"}
            action={<button className="btn" onClick={() => setImporting(true)}><Upload size={14} /> Import audit package</button>}
          >
            Reports from a test agent arrive as proposals. Nothing is accepted or sent anywhere until you decide.
          </Empty>
        ) : (
          data.items.map((b) => (
            <button key={b.id} className="list-row" style={{ width: "100%", textAlign: "left" }} onClick={() => setOpen(b.id)}>
              <span className="id mono truncate" style={{ width: 88 }} title={b.sourceId}>{b.sourceId}</span>
              <span className="title">{b.title}</span>
              <span className="meta">
                {b.pendingUpdate && <span className="chip accent" title="The agent sent a newer version. Review it.">Update waiting</span>}
                {b.unresolvedRefs > 0 && <span className="chip" title="References that match no requirement or test case in this project"><AlertTriangle size={11} /> {b.unresolvedRefs} unresolved</span>}
                {(b.attachments > 0 || b.attachmentProblems > 0) && (
                  <span className="chip" title={b.attachmentProblems ? `${b.attachmentProblems} attachment(s) not imported` : "Evidence files"}>
                    <Paperclip size={11} /> {b.attachments}{b.attachmentProblems > 0 && <span style={DANGER}> +{b.attachmentProblems} problem</span>}
                  </span>
                )}
                {b.published && <span className="chip"><Link2 size={11} /> linked</span>}
                <Severity value={b.severity} />
                {tab === "all" && <StatusChip status={b.status} />}
                <span className="faint" title={b.auditTitle}>{timeAgo(b.importedAt)}</span>
              </span>
            </button>
          ))
        )}
      </div>
      {open && <DetailModal id={open} pid={pid!} onClose={() => setOpen(null)} onOpen={setOpen} />}
      {importing && <ImportModal pid={pid!} onClose={() => setImporting(false)} />}
    </>
  );
}

function useRefresh(pid: string) {
  const qc = useQueryClient();
  return () => {
    for (const k of [["bug-reports"], ["bug-report"], ["audits", pid], ["audit-rejections", pid]]) qc.invalidateQueries({ queryKey: k });
  };
}

// ---------- One report ----------

function DetailModal({ id, pid, onClose, onOpen }: { id: number; pid: string; onClose: () => void; onOpen: (id: number) => void }) {
  const toast = useToast();
  const refresh = useRefresh(pid);
  const { data: b } = useQuery({ queryKey: ["bug-report", id], queryFn: () => api.get<Detail>(`/api/bug-reports/${id}`) });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: "", description: "", steps: "", expected: "", actual: "", environment: "", url: "" });
  const [note, setNote] = useState("");
  const [link, setLink] = useState({ destination: "jira", url: "" });
  const [deleting, setDeleting] = useState(false);
  const run = <T,>(fn: () => Promise<T>, ok?: string) => fn().then((r) => { refresh(); if (ok) toast("success", ok); return r; }).catch((e: Error) => { toast("error", e.message); });
  const post = (path: string, body?: unknown, ok?: string) => run(() => api.post(`/api/bug-reports/${id}/${path}`, body), ok);

  if (!b) return <Modal title="Bug report" onClose={onClose} width={820}><ListSkeleton rows={4} /></Modal>;
  const startEdit = () => {
    setDraft({ title: b.title, description: b.description, steps: b.steps.join("\n"), expected: b.expected, actual: b.actual, environment: b.environment, url: b.url });
    setEditing(true);
  };
  const save = () =>
    run(() => api.patch(`/api/bug-reports/${id}`, { ...draft, steps: draft.steps.split("\n").map((s) => s.trim()).filter(Boolean) }), "Saved").then(() => setEditing(false));
  const problems = b.attachments.filter((a) => a.state !== "stored");
  const stored = b.attachments.filter((a) => a.state === "stored" && a.active);
  const unresolved = b.refs.filter((r) => r.state !== "resolved");
  const field = (label: string, value: string) => value ? <div className="field"><div className="section-label">{label}</div><div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{value}</div></div> : null;
  const guarded = b.status === "accepted" || b.publications.length > 0;

  return (
    <Modal
      title={<span className="row" style={{ gap: 8 }}><span className="mono faint">{b.sourceId}</span><StatusChip status={b.status} /></span>}
      onClose={onClose}
      width={820}
      footer={
        <>
          <button className="btn ghost" style={DANGER} onClick={() => setDeleting(true)}><Trash2 size={13} /> Delete</button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Close</button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        {b.pendingUpdate && (
          <div className="card" style={{ padding: 12, borderColor: "var(--accent)" }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <strong>The agent sent a newer version (revision {b.pendingUpdate.rev})</strong>
              <span className="spacer" />
              <button className="btn sm" onClick={() => post("ignore-update", undefined, "Kept your version")}>Keep mine</button>
              <button className="btn primary sm" onClick={() => post("apply-update", undefined, "Applied the agent's version")}>Use the agent's version</button>
            </div>
            <div className="faint" style={{ fontSize: "var(--fs-sm)", margin: "6px 0" }}>Your edits, review and links are not changed until you choose. Applying replaces the text below with the agent's.</div>
            {b.pendingUpdate.changes.map((c) => (
              <div key={c.field} style={{ fontSize: "var(--fs-md)", marginTop: 6 }}>
                <span className="section-label" style={{ margin: 0 }}>{c.field}</span>
                <div style={{ color: "var(--failed-fg)", whiteSpace: "pre-wrap" }}>− {c.from || "(empty)"}</div>
                <div style={{ color: "var(--passed-fg)", whiteSpace: "pre-wrap" }}>+ {c.to || "(empty)"}</div>
              </div>
            ))}
            {(b.pendingUpdate.evidenceAdded > 0 || b.pendingUpdate.evidenceRemoved > 0) && (
              <div className="faint" style={{ marginTop: 6 }}>Evidence: {b.pendingUpdate.evidenceAdded} added, {b.pendingUpdate.evidenceRemoved} removed.</div>
            )}
          </div>
        )}

        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {b.status !== "accepted" && <button className="btn primary" onClick={() => post("review", { status: "accepted", note: note || undefined }, "Accepted. Nothing was sent to Jira or Linear.")}><Check size={14} /> Accept</button>}
          {b.status !== "rejected" && <button className="btn" onClick={() => post("review", { status: "rejected", note: note || undefined }, "Rejected")}>Reject</button>}
          {b.status !== "proposed" && <button className="btn ghost" onClick={() => post("review", { status: "proposed" }, "Back to proposed")}>Reopen</button>}
          <input className="input grow" aria-label="Review note" placeholder="Note about your decision (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {b.reviewNote && <div className="faint">Note: {b.reviewNote}{b.reviewedAt ? ` · ${timeAgo(b.reviewedAt)}` : ""}</div>}
        {b.duplicateOf && <div>Duplicate of <button className="btn ghost sm" onClick={() => onOpen(b.duplicateOf!.id)}>{b.duplicateOf.title}</button></div>}
        <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>Accepting is only your decision in Testbench. Sending a report to Jira or Linear is a separate step and is not available yet.</div>

        {/* Three separate judgements */}
        <div className="card" style={{ padding: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
          <div><div className="section-label">Tool impact</div>{b.severity.tool ? <div>{b.severity.tool.value} <span className="faint">({b.severity.tool.tool}{b.severity.tool.ruleId ? `, ${b.severity.tool.ruleId}` : ""})</span></div> : <span className="faint">—</span>}</div>
          <div><div className="section-label">Agent's severity</div><Severity value={b.severity.agent} /></div>
          <div>
            <label className="section-label" htmlFor="human-sev">Your severity</label>
            <select id="human-sev" className="select" value={b.severity.human ?? ""} onChange={(e) => run(() => api.patch(`/api/bug-reports/${id}`, { humanSeverity: e.target.value || null }))}>
              <option value="">Not set</option>
              {(["low", "medium", "high", "critical"] as const).map((s) => <option key={s} value={s}>{PRIORITY_LABEL[s]}</option>)}
            </select>
          </div>
        </div>

        {editing ? (
          <div className="col" style={{ gap: 8 }}>
            <input className="input" aria-label="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            <textarea className="textarea" aria-label="Description" rows={4} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Description" />
            <textarea className="textarea" aria-label="Steps, one per line" rows={4} value={draft.steps} onChange={(e) => setDraft({ ...draft, steps: e.target.value })} placeholder="Steps, one per line" />
            <textarea className="textarea" aria-label="Expected result" rows={2} value={draft.expected} onChange={(e) => setDraft({ ...draft, expected: e.target.value })} placeholder="Expected result" />
            <textarea className="textarea" aria-label="Actual result" rows={2} value={draft.actual} onChange={(e) => setDraft({ ...draft, actual: e.target.value })} placeholder="Actual result" />
            <div className="row"><input className="input grow" aria-label="Environment" value={draft.environment} onChange={(e) => setDraft({ ...draft, environment: e.target.value })} placeholder="Environment" /><input className="input grow" aria-label="URL" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="URL" /></div>
            <div className="row"><button className="btn primary" disabled={!draft.title.trim()} onClick={save}>Save</button><button className="btn ghost" onClick={() => setEditing(false)}>Cancel</button></div>
          </div>
        ) : (
          <div className="col" style={{ gap: 10 }}>
            <div className="row"><h2 style={{ margin: 0, fontSize: "var(--fs-lg)", overflowWrap: "anywhere" }}>{b.title}</h2><span className="spacer" /><button className="btn sm" onClick={startEdit}><Pencil size={12} /> Edit</button></div>
            {b.editedAt && <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>You edited this {timeAgo(b.editedAt)}. A later import will not overwrite it without asking.</div>}
            {field("Description", b.description)}
            {b.steps.length > 0 && <div className="field"><div className="section-label">Steps</div><ol style={{ margin: 0, paddingLeft: 20 }}>{b.steps.map((s, i) => <li key={i} style={{ overflowWrap: "anywhere" }}>{s}</li>)}</ol></div>}
            {field("Expected result", b.expected)}
            {field("Actual result", b.actual)}
            {field("Environment", b.environment)}
            {b.url && <div className="field"><div className="section-label">URL</div><span className="mono" style={{ overflowWrap: "anywhere" }}>{/^https?:\/\//i.test(b.url) ? <a href={b.url} target="_blank" rel="noreferrer noopener">{b.url}</a> : b.url}</span></div>}
          </div>
        )}

        <div className="field">
          <div className="section-label">Linked to {unresolved.length > 0 && <button className="btn ghost sm" onClick={() => post("relink", undefined, "Checked again")}>Check again</button>}</div>
          {b.refs.length === 0 ? <span className="faint">No requirements or test cases named.</span> : b.refs.map((r) => (
            <div key={r.id} className="row" style={{ gap: 8, padding: "2px 0", flexWrap: "wrap" }}>
              <span className="chip" style={r.state === "resolved" ? undefined : { color: "var(--blocked-fg)" }}>{r.state === "resolved" ? "linked" : r.state.replace("_", " ")}</span>
              {r.target?.kind === "case" ? <Link to={`/p/${pid}/cases?case=${r.target.id}`}>{r.label}</Link> : <span>{r.label}</span>}
              {r.reason && <span className="faint">{r.reason}</span>}
            </div>
          ))}
        </div>

        <div className="field">
          <div className="section-label"><Paperclip size={12} /> Evidence</div>
          {!stored.length && !problems.length && <span className="faint">No evidence files.</span>}
          <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
            {stored.map((a) => (
              <div key={a.id} className="col" style={{ gap: 4, maxWidth: 200 }}>
                {/^image\//.test(a.mime) && <a href={`/uploads/${a.stored_name}`} target="_blank" rel="noreferrer noopener"><img src={`/uploads/${a.stored_name}`} alt={a.label || a.filename} style={{ maxWidth: 200, maxHeight: 130, border: "1px solid var(--border)", borderRadius: "var(--radius)" }} /></a>}
                <a href={`/uploads/${a.stored_name}`} target="_blank" rel="noreferrer noopener" style={{ overflowWrap: "anywhere" }}>{a.label || a.filename}</a>
              </div>
            ))}
          </div>
          {problems.map((a) => (
            <div key={a.id} className="row" style={{ gap: 6, color: "var(--failed-fg)", fontSize: "var(--fs-md)" }}>
              <AlertTriangle size={13} /> <span className="mono" style={{ overflowWrap: "anywhere" }}>{a.declared_path}</span> — not imported: {a.reason || a.state.replace("_", " ")}
            </div>
          ))}
        </div>

        <div className="field">
          <div className="section-label"><Link2 size={12} /> Existing external issue</div>
          {b.publications.map((p) => (
            <div key={p.id} className="row" style={{ gap: 8 }}>
              <span className="chip">{p.destination}</span>
              {p.external_url ? <a href={p.external_url} target="_blank" rel="noreferrer noopener" style={{ overflowWrap: "anywhere" }}>{p.external_id || p.external_url} <ExternalLink size={11} /></a> : p.external_id}
              {p.mode === "linked_existing" && <button className="btn ghost sm" aria-label="Remove link" onClick={() => run(() => api.del(`/api/bug-publications/${p.id}`), "Link removed")}>Remove</button>}
            </div>
          ))}
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <select className="select" style={{ width: "auto" }} aria-label="Destination" value={link.destination} onChange={(e) => setLink({ ...link, destination: e.target.value })}>
              <option value="jira">Jira</option><option value="linear">Linear</option><option value="other">Other</option>
            </select>
            <input className="input grow" aria-label="Issue link" placeholder="https://… link to an issue that already covers this" value={link.url} onChange={(e) => setLink({ ...link, url: e.target.value })} />
            <button className="btn" disabled={!link.url.trim()} onClick={() => post("external-link", { destination: link.destination, url: link.url.trim() }, "Linked. Nothing was sent to that system.").then(() => setLink({ ...link, url: "" }))}>Link</button>
          </div>
        </div>

        {b.status !== "duplicate" && b.similar.length > 0 && (
          <div className="field">
            <div className="section-label">Similar reports (same fingerprint)</div>
            {b.similar.map((s) => (
              <div key={s.id} className="row" style={{ gap: 8 }}>
                <button className="btn ghost sm" onClick={() => onOpen(s.id)}>{s.title}</button><span className="faint">{s.status}</span>
                <span className="spacer" />
                <button className="btn sm" onClick={() => post("duplicate", { ofId: s.id }, "Marked as a duplicate")}>This is a duplicate of it</button>
              </div>
            ))}
          </div>
        )}
        {b.duplicates.length > 0 && <div className="faint">Marked as duplicates of this: {b.duplicates.map((d) => d.title).join(", ")}</div>}

        <div className="field">
          <div className="section-label"><FileText size={12} /> Where it came from</div>
          <div className="faint" style={{ fontSize: "var(--fs-md)", display: "grid", gap: 2 }}>
            <div>Audit: {b.origin.title || b.originAuditId} <span className="mono">({b.originAuditId})</span>{!b.audit && " · the audit was deleted from Testbench; this report was kept"}</div>
            <div>Agent: {[b.origin.agent?.name, b.origin.agent?.version, b.origin.agent?.model].filter(Boolean).join(" · ") || "unknown"}</div>
            <div>Found {b.foundAt ? timeAgo(b.foundAt) : "(time not given)"} · imported {timeAgo(b.importedAt)} via {b.origin.source ?? "?"}{b.origin.github ? ` (${b.origin.github.repo}#${b.origin.github.runId})` : ""}</div>
            {b.audit && <div>{RUN_STATE[b.audit.run_state] ?? b.audit.run_state}{b.runId ? <> · <Link to={`/p/${pid}/runs/${b.runId}`}>open run</Link></> : null}</div>}
            {b.agentReview && <div>Agent's own review (not a decision here): {b.agentReview.status || "—"}{b.agentReview.method ? ` · ${b.agentReview.method}` : ""}{b.agentReview.notes ? ` · ${b.agentReview.notes}` : ""}</div>}
            {b.origin.review && <div>Audit review: {b.origin.review.status}{b.origin.review.method ? ` · ${b.origin.review.method}` : ""}</div>}
            {b.confidence != null && <div>Agent's confidence: {Math.round(b.confidence * 100)}%</div>}
            <div>{b.revisions.length} revision{b.revisions.length === 1 ? "" : "s"} received</div>
          </div>
        </div>
      </div>
      {deleting && (
        <ConfirmModal
          title="Delete this report?"
          confirmLabel="Delete report"
          onClose={() => setDeleting(false)}
          onConfirm={() => run(() => api.del(`/api/bug-reports/${id}${guarded ? "?force=1" : ""}`), "Deleted").then(() => { setDeleting(false); onClose(); })}
        >
          <p style={{ margin: 0 }}>This removes the report and its evidence files from Testbench.{guarded ? " It is accepted or linked to an external issue; that issue is not touched." : ""} If the agent sends the same package again, it will come back as a new proposal.</p>
        </ConfirmModal>
      )}
    </Modal>
  );
}

// ---------- Audits ----------

function AuditsPanel({ pid }: { pid: string }) {
  const toast = useToast();
  const refresh = useRefresh(pid);
  const { data: audits, isLoading } = useQuery({ queryKey: ["audits", pid], queryFn: () => api.get<Audit[]>(`/api/projects/${pid}/audits`) });
  const { data: rejected } = useQuery({ queryKey: ["audit-rejections", pid], queryFn: () => api.get<{ artifactId: number; name: string; note: string; seenAt: string; repo: string }[]>(`/api/projects/${pid}/audit-rejections`) });
  const [report, setReport] = useState<Audit | null>(null);
  const [del, setDel] = useState<Audit | null>(null);
  const { data: text } = useQuery({ queryKey: ["audit-report", report?.id], enabled: !!report, queryFn: async () => { const r = await fetch(`/api/audits/${report!.id}/report`); return r.ok ? r.text() : "The report could not be loaded."; } });
  const { data: preview } = useQuery({ queryKey: ["audit-deletion", del?.id], enabled: !!del, queryFn: () => api.get<{ title: string; deleted: number; kept: number }>(`/api/audits/${del!.id}/deletion-preview`) });
  const remove = useMutation({
    mutationFn: () => api.del<{ deleted: number; kept: number }>(`/api/audits/${del!.id}`),
    onSuccess: (r) => { refresh(); setDel(null); toast("success", `Audit deleted. ${r.deleted} untouched proposal${r.deleted === 1 ? "" : "s"} removed, ${r.kept} report${r.kept === 1 ? "" : "s"} kept.`); },
    onError: (e: Error) => toast("error", e.message),
  });
  if (isLoading) return <ListSkeleton rows={3} />;
  return (
    <div className="col" style={{ gap: 16, padding: "12px 20px" }}>
      {!audits?.length ? <Empty icon={<Bug size={20} />} title="No audits imported yet">An audit is the package a test agent leaves behind: its reports, evidence and its own readable report.</Empty> : audits.map((a) => (
        <div key={a.id} className="card" style={{ padding: 12 }}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <strong style={{ overflowWrap: "anywhere" }}>{a.title || a.agentAuditId}</strong>
            <span className="chip">{a.source === "github" ? "GitHub" : "Upload"}</span>
            <span className="spacer" />
            {a.hasReport && <button className="btn sm" onClick={() => setReport(a)}><FileText size={12} /> Audit report</button>}
            <button className="btn ghost sm" style={DANGER} onClick={() => setDel(a)}><Trash2 size={12} /> Delete</button>
          </div>
          <div className="faint" style={{ fontSize: "var(--fs-md)", marginTop: 4, display: "grid", gap: 2 }}>
            <div><span className="mono">{a.agentAuditId}</span> · {a.agent || "agent unknown"} · last imported {timeAgo(a.lastImportedAt)} ({a.imports} import{a.imports === 1 ? "" : "s"})</div>
            <div>{a.bugs} report{a.bugs === 1 ? "" : "s"}, {a.proposed} still proposed · {RUN_STATE[a.runState] ?? a.runState}{a.github ? ` (${a.github.repo}#${a.github.runId})` : ""}</div>
          </div>
        </div>
      ))}
      {!!rejected?.length && (
        <div className="card" style={{ padding: 12 }}>
          <div className="section-label"><AlertTriangle size={12} /> GitHub packages that could not be imported</div>
          <div className="faint" style={{ marginBottom: 6 }}>These are not tried again. Fix the package and upload a new one, or import it by hand.</div>
          {rejected.map((r) => <div key={r.artifactId} style={{ overflowWrap: "anywhere" }}><span className="mono">{r.name}</span> <span className="faint">({r.repo}, {timeAgo(r.seenAt)})</span> — {r.note}</div>)}
        </div>
      )}
      <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>
        GitHub import looks at the repository's 100 most recent artifacts named <code className="inline">testbench-audit-*</code> on each check. After a long pause, older packages are not found: import them by hand.
      </div>
      {report && (
        <Modal title={`Audit report · ${report.title || report.agentAuditId}`} onClose={() => setReport(null)} width={760} footer={<button className="btn" onClick={() => setReport(null)}>Close</button>}>
          <pre className="snippet" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "60vh" }}>{text ?? "Loading…"}</pre>
        </Modal>
      )}
      {del && (
        <ConfirmModal title="Delete this audit?" confirmLabel="Delete audit" busy={remove.isPending} onClose={() => setDel(null)} onConfirm={() => remove.mutate()}>
          {preview ? (
            <p style={{ margin: 0 }}>
              {preview.deleted} untouched proposal{preview.deleted === 1 ? "" : "s"} and the stored audit report will be removed.{" "}
              {preview.kept > 0 ? `${preview.kept} report${preview.kept === 1 ? " is" : "s are"} kept (reviewed, edited or linked), with their evidence and a note of where they came from.` : "No reports are kept."}
            </p>
          ) : <p style={{ margin: 0 }}>Checking…</p>}
        </ConfirmModal>
      )}
    </div>
  );
}

// ---------- Import ----------

interface Picked { file: File; path: string; fromFolder: boolean }
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function ImportModal({ pid, onClose }: { pid: string; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh(pid);
  const zipInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Picked[]>([]);
  const form = (list: Picked[]) => {
    const fd = new FormData();
    for (const p of list) {
      if (p.fromFolder) fd.append("relpath", p.path); // must come right before its file
      fd.append("file", p.file, p.file.name);
    }
    return fd;
  };
  const preview = useMutation({ mutationFn: (list: Picked[]) => api.post<Summary>(`/api/projects/${pid}/audit-import?dryRun=1`, form(list)) });
  const doImport = useMutation({
    mutationFn: () => api.post<Summary>(`/api/projects/${pid}/audit-import`, form(picked)),
    onSuccess: (s) => { refresh(); toast("success", `Imported: ${s.counts.new} new, ${s.counts.updated} updated, ${s.counts.pending} waiting for your decision`); onClose(); },
    onError: (e: Error) => toast("error", e.message),
  });
  const choose = (list: FileList | null, fromFolder: boolean) => {
    if (!list?.length) return;
    const files = [...list].filter((f) => !f.webkitRelativePath.includes("node_modules/") && !(fromFolder && f.name === ".DS_Store"));
    if (files.some((f) => f.size > MAX_UPLOAD_BYTES)) { toast("error", "A file in the package is over 100 MB"); return; }
    const next = files.map((file) => ({ file, path: (fromFolder && file.webkitRelativePath) || file.name, fromFolder }));
    setPicked(next);
    preview.mutate(next);
  };
  const s = preview.data;
  return (
    <Modal
      title="Import audit package"
      onClose={onClose}
      width={720}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!s || preview.isPending || doImport.isPending} onClick={() => doImport.mutate()}>{doImport.isPending ? "Importing…" : "Import as proposals"}</button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <div className="faint">A package is a zip or a folder with <code className="inline">manifest.json</code>, <code className="inline">bugs.json</code> and its evidence. Every report arrives as a proposal; nothing is accepted or sent anywhere.</div>
        <div className="row">
          <input ref={zipInput} type="file" accept=".zip" hidden onChange={(e) => { choose(e.target.files, false); e.target.value = ""; }} />
          <input ref={folderInput} type="file" multiple hidden {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} onChange={(e) => { choose(e.target.files, true); e.target.value = ""; }} />
          <button className="btn" onClick={() => zipInput.current?.click()}><Upload size={13} /> Choose a zip</button>
          <button className="btn" onClick={() => folderInput.current?.click()}><FolderOpen size={13} /> Choose a folder</button>
          {picked.length > 0 && <span className="faint">{picked.length} file{picked.length === 1 ? "" : "s"} chosen</span>}
        </div>
        {preview.isPending && <ListSkeleton rows={2} />}
        {preview.error && <div role="alert" style={DANGER}>{(preview.error as Error).message}</div>}
        {s && (
          <div className="col" style={{ gap: 8 }}>
            <div className="card" style={{ padding: 12 }}>
              <div><strong>{s.audit.title || s.audit.agentAuditId}</strong> <span className="faint">{s.audit.agent}</span></div>
              <div className="faint" style={{ fontSize: "var(--fs-md)" }}>
                {s.audit.isNew ? "A new audit" : "An audit that was imported before"} · {RUN_STATE[s.audit.runState]}{s.audit.github ? ` (${s.audit.github.repo}#${s.audit.github.runId})` : ""}
              </div>
              <div style={{ marginTop: 6 }}>
                {s.counts.new} new · {s.counts.unchanged} unchanged · {s.counts.updated} updated · {s.counts.pending} with a newer version waiting for review
              </div>
              <div className="faint" style={{ fontSize: "var(--fs-md)" }}>
                Evidence: {s.evidence.ok} file{s.evidence.ok === 1 ? "" : "s"} will be stored{s.evidence.problems ? `, ${s.evidence.problems} cannot be imported` : ""} · {s.unresolvedRefs} reference{s.unresolvedRefs === 1 ? "" : "s"} not resolved
              </div>
            </div>
            {s.warnings.map((w, i) => <div key={i} className="row" style={{ gap: 6, color: "var(--blocked-fg)", fontSize: "var(--fs-md)" }}><AlertTriangle size={13} /> {w}</div>)}
            <div style={{ maxHeight: 220, overflow: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
              {s.items.map((i) => (
                <div key={i.sourceId} className="row" style={{ gap: 8, padding: "6px 10px", borderBottom: "1px solid var(--border)" }}>
                  <span className="chip">{i.action === "update" ? "updated" : i.action}</span>
                  <span className="truncate grow" title={i.title}>{i.title}</span>
                  {i.evidenceProblems > 0 && <span style={DANGER}>{i.evidenceProblems} file problem{i.evidenceProblems === 1 ? "" : "s"}</span>}
                  {i.unresolvedRefs > 0 && <span style={{ color: "var(--blocked-fg)" }}>{i.unresolvedRefs} unresolved</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
