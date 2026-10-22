import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Calendar, Check, ExternalLink, FileDown, FileJson, FileSpreadsheet, FileText, Loader2, Plus, Rocket, Trash2, Zap } from "lucide-react";
import { api, type ChecklistItem, type Milestone } from "../api";
import { Empty, Modal, useToast } from "../components/ui";

type MilestoneEdit = Partial<{ name: string; kind: string; startDate: string | null; endDate: string | null }>;

const fmtRange = (m: Milestone) => {
  const f = (s: string) => new Date(s + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return m.start_date || m.end_date ? `${m.start_date ? f(m.start_date) : "…"} – ${m.end_date ? f(m.end_date) : "…"}` : "No dates";
};

export function ReportsPage() {
  const { pid, mid } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [pdfBusy, setPdfBusy] = useState(false);

  const { data: milestones, isLoading } = useQuery({ queryKey: ["milestones", pid], queryFn: () => api.get<Milestone[]>(`/api/projects/${pid}/milestones`) });
  const current = milestones?.find((m) => m.id === Number(mid));

  // Land on the newest milestone that has runs.
  useEffect(() => {
    if (!mid && milestones?.length) navigate(`/p/${pid}/reports/${(milestones.find((m) => m.run_count > 0) ?? milestones[0]).id}`, { replace: true });
  }, [mid, milestones, navigate, pid]);

  const update = useMutation({
    mutationFn: (body: MilestoneEdit) => api.patch<Milestone>(`/api/milestones/${mid}`, body),
    onSuccess: () => {
      for (const k of ["milestones", "runs", "dashboard"]) qc.invalidateQueries({ queryKey: [k, pid] });
      setNonce((n) => n + 1);
    },
    onError: (e: Error) => toast("error", e.message),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/api/milestones/${mid}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["milestones", pid] });
      navigate(`/p/${pid}/reports`, { replace: true });
    },
    onError: (e: Error) => toast("error", e.message),
  });

  const downloadPdf = async () => {
    if (!current) return;
    setPdfBusy(true);
    try {
      const res = await fetch(`/api/milestones/${current.id}/report.pdf`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Export failed (${res.status})`);
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "report.pdf";
      const url = URL.createObjectURL(await res.blob());
      Object.assign(document.createElement("a"), { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <>
      <div className="topbar">
        <h1>Sprint &amp; release reports</h1>
        <span className="spacer" />
        {current && (
          <>
            <a className="btn" href={`/api/milestones/${current.id}/report.html`} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open</a>
            <a className="btn" href={`/api/milestones/${current.id}/report.html?download=1`}><FileText size={14} /> HTML</a>
            <button className="btn primary" onClick={downloadPdf} disabled={pdfBusy}>
              {pdfBusy ? <Loader2 size={14} className="spin" /> : <FileDown size={14} />} Download PDF
            </button>
          </>
        )}
      </div>
      <div className="split" style={{ flex: 1, minHeight: 0 }}>
        <div className="pane" style={{ width: 290, flexShrink: 0, borderRight: "1px solid var(--border)", background: "var(--bg-panel)", display: "flex", flexDirection: "column" }}>
          <div className="toolbar" style={{ padding: "0 8px 0 16px" }}>
            <span className="muted" style={{ fontWeight: 500 }}>Sprints &amp; releases</span>
            <span className="spacer" />
            <button className="btn ghost icon sm" onClick={() => setCreating(true)} title="New sprint or release" aria-label="New sprint or release"><Plus size={14} /></button>
          </div>
          <div style={{ flex: 1, overflow: "auto" }}>
            {milestones?.map((m) => (
              <button
                key={m.id}
                className={`list-row${m.id === Number(mid) ? " selected" : ""}`}
                style={{ width: "100%", height: 52, textAlign: "left", background: m.id === Number(mid) ? undefined : "none", border: 0, borderBottom: "1px solid var(--border)", padding: "0 16px" }}
                onClick={() => navigate(`/p/${pid}/reports/${m.id}`)}
              >
                {m.kind === "release" ? <Rocket size={14} className="faint" /> : <Zap size={14} className="faint" />}
                <div className="grow col" style={{ gap: 0 }}>
                  <span className="truncate" style={{ fontWeight: 500 }}>{m.name}</span>
                  <span className="faint" style={{ fontSize: 11.5 }}>{fmtRange(m)} · {m.run_count} {m.run_count === 1 ? "run" : "runs"}</span>
                </div>
              </button>
            ))}
          </div>
          <div style={{ borderTop: "1px solid var(--border)", padding: 12 }}>
            <div className="section-label"><Archive size={12} /> Export project data</div>
            <div className="col" style={{ gap: 4 }}>
              <a className="btn sm" href={`/api/projects/${pid}/export.json`}><FileJson size={13} /> Everything (JSON backup)</a>
              <a className="btn sm" href={`/api/projects/${pid}/export-markdown.zip`}><FileText size={13} /> Cases as Markdown (zip)</a>
              <a className="btn sm" href={`/api/projects/${pid}/export-cases.csv`}><FileSpreadsheet size={13} /> Cases (CSV)</a>
              <a className="btn sm" href={`/api/projects/${pid}/export-requirements.csv`}><FileSpreadsheet size={13} /> Requirements (CSV)</a>
              <a className="btn sm" href={`/api/projects/${pid}/export-results.csv`}><FileSpreadsheet size={13} /> Results (CSV)</a>
            </div>
          </div>
        </div>

        <div className="pane grow" style={{ display: "flex", flexDirection: "column", background: "var(--bg-sidebar)" }}>
          {isLoading ? null : !milestones?.length ? (
            <Empty icon={<Calendar size={20} />} title="No sprints or releases yet" action={<button className="btn primary" onClick={() => setCreating(true)}><Plus size={14} /> New sprint</button>}>
              Give a run a sprint or release name when you create it or import results. Each one gets a report here, with a comparison to the one before.
            </Empty>
          ) : current ? (
            <>
              <MilestoneBar key={current.id} m={current} onChange={(b) => update.mutate(b)} onDelete={() => confirm(`Delete "${current.name}"? It has no runs.`) && remove.mutate()} />
              <ChecklistPanel key={`cl-${current.id}`} milestone={current} others={milestones.filter((m) => m.id !== current.id)} onChanged={() => setNonce((n) => n + 1)} />
              <div style={{ flex: 1, minHeight: 0, padding: 16, display: "flex", justifyContent: "center" }}>
                {current.run_count === 0 ? (
                  <Empty icon={<FileText size={20} />} title="No runs in this sprint yet">Start a manual run or import results and set “{current.name}” as the sprint/release.</Empty>
                ) : (
                  <iframe
                    key={`${current.id}-${nonce}`}
                    title={`${current.name} report`}
                    src={`/api/milestones/${current.id}/report.html?v=${nonce}`}
                    sandbox="allow-same-origin" /* no allow-scripts: the report has none, and its CSP forbids them */
                    style={{ width: "min(900px, 100%)", height: "100%", border: "1px solid var(--border-strong)", borderRadius: 6, background: "#fff", boxShadow: "var(--shadow)" }}
                  />
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>
      {creating && <NewMilestoneModal onClose={() => setCreating(false)} />}
    </>
  );
}

function MilestoneBar({ m, onChange, onDelete }: { m: Milestone; onChange: (b: MilestoneEdit) => void; onDelete: () => void }) {
  const [name, setName] = useState(m.name);
  const [start, setStart] = useState(m.start_date ?? "");
  const [end, setEnd] = useState(m.end_date ?? "");
  const commitName = () => name.trim() && name.trim() !== m.name && onChange({ name: name.trim() });
  return (
    <div className="toolbar" style={{ height: "auto", minHeight: 46, flexWrap: "wrap", padding: "8px 20px", gap: 10, background: "var(--bg)" }}>
      <input className="bare" style={{ width: 220, fontWeight: 600, fontSize: 14 }} value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} aria-label="Name" />
      <select className="select" style={{ width: 110, height: 28 }} value={m.kind} onChange={(e) => onChange({ kind: e.target.value })} aria-label="Type">
        <option value="sprint">Sprint</option>
        <option value="release">Release</option>
      </select>
      <label className="row muted" style={{ fontSize: 12.5 }}>
        From <input type="date" className="input" style={{ width: 140, height: 28 }} value={start} max={end || undefined} onChange={(e) => { setStart(e.target.value); onChange({ startDate: e.target.value || null }); }} />
      </label>
      <label className="row muted" style={{ fontSize: 12.5 }}>
        To <input type="date" className="input" style={{ width: 140, height: 28 }} value={end} min={start || undefined} onChange={(e) => { setEnd(e.target.value); onChange({ endDate: e.target.value || null }); }} />
      </label>
      <span className="faint" style={{ fontSize: 12 }}>Dates label the report and order sprints for comparison.</span>
      {m.run_count === 0 && (
        <button className="btn ghost sm danger" style={{ marginLeft: "auto" }} onClick={onDelete}>
          <Trash2 size={13} /> Delete empty {m.kind}
        </button>
      )}
    </div>
  );
}

function NewMilestoneModal({ onClose }: { onClose: () => void }) {
  const { pid } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"sprint" | "release">("sprint");
  const create = useMutation({
    mutationFn: () => api.post<Milestone>(`/api/projects/${pid}/milestones`, { name, kind }),
    onSuccess: (m) => {
      qc.invalidateQueries({ queryKey: ["milestones", pid] });
      onClose();
      navigate(`/p/${pid}/reports/${m.id}`);
    },
    onError: (e: Error) => toast("error", e.message),
  });
  return (
    <Modal
      title="New sprint or release"
      onClose={onClose}
      width={440}
      footer={<button className="btn primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>Create</button>}
    >
      <div className="field">
        <label htmlFor="mname">Name</label>
        <input id="mname" className="input" autoFocus placeholder="Sprint 43, v2.4.0…" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && create.mutate()} />
      </div>
      <div className="field">
        <label htmlFor="mkind">Type</label>
        <select id="mkind" className="select" value={kind} onChange={(e) => setKind(e.target.value as "sprint" | "release")}>
          <option value="sprint">Sprint</option>
          <option value="release">Release</option>
        </select>
      </div>
    </Modal>
  );
}

const parseUtc = (s: string) => new Date(s.replace(" ", "T") + "Z");
const toLocalInput = (s: string) => {
  const d = parseUtc(s);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Manual release checklist: add tasks, tick them off (the time is recorded), and the report lists what was done and when. */
function ChecklistPanel({ milestone, others, onChanged }: { milestone: Milestone; others: Milestone[]; onChanged: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["checklist", milestone.id];
  const { data: items = [] } = useQuery({ queryKey: key, queryFn: () => api.get<ChecklistItem[]>(`/api/milestones/${milestone.id}/checklist`) });
  const [open, setOpen] = useState(true);
  const [title, setTitle] = useState("");
  const [editing, setEditing] = useState<number | null>(null);

  const run = useMutation({
    mutationFn: (fn: () => Promise<ChecklistItem[]>) => fn(),
    onSuccess: (next) => { qc.setQueryData(key, next); onChanged(); },
    onError: (e: Error) => toast("error", e.message),
  });
  const base = `/api/milestones/${milestone.id}/checklist`;
  const add = () => { if (title.trim()) { run.mutate(() => api.post<ChecklistItem[]>(base, { title })); setTitle(""); } };
  const done = items.filter((i) => i.done_at).length;

  return (
    <div className="card" style={{ margin: "12px 16px 0", flexShrink: 0, alignSelf: "center", width: "min(900px, calc(100% - 32px))", background: "var(--bg)" }}>
      <button className="card-header row" style={{ width: "100%", cursor: "pointer", background: "none", border: 0, textAlign: "left" }} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Release checklist</span>
        <span className="faint" style={{ fontSize: 12 }}>{items.length ? `${done} of ${items.length} done` : "No tasks yet"}</span>
        {items.length > 0 && done === items.length && <Check size={13} style={{ color: "var(--passed-fg)" }} />}
        <span className="spacer" />
        <span className="faint" style={{ fontSize: 12 }}>{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div style={{ maxHeight: 260, overflow: "auto" }}>
          {items.map((i) => (
            <div key={i.id} className="row" style={{ padding: "6px 16px", borderTop: "1px solid var(--border)", minHeight: 36 }}>
              <input type="checkbox" className="checkbox" checked={!!i.done_at} aria-label={`Done: ${i.title}`}
                onChange={(e) => { const done = e.target.checked; run.mutate(() => api.patch<ChecklistItem[]>(`/api/checklist/${i.id}`, { done })); }} />
              {editing === i.id ? (
                <input className="input grow" autoFocus defaultValue={i.title} aria-label="Task"
                  onBlur={(e) => { setEditing(null); const v = e.target.value.trim(); if (v && v !== i.title) run.mutate(() => api.patch<ChecklistItem[]>(`/api/checklist/${i.id}`, { title: v })); }}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setEditing(null); }} />
              ) : (
                <span className="grow" style={{ cursor: "text", textDecoration: i.done_at ? "line-through" : undefined, color: i.done_at ? "var(--text-3)" : undefined }} onClick={() => setEditing(i.id)}>{i.title}</span>
              )}
              {i.done_at && (
                <label className="row faint" style={{ fontSize: 12, gap: 4 }} title="When it was done. Click to change.">
                  Done
                  <input type="datetime-local" className="input" style={{ height: 24, width: 170, fontSize: 12 }} value={toLocalInput(i.done_at)}
                    onChange={(e) => { const v = e.target.value; if (v) run.mutate(() => api.patch<ChecklistItem[]>(`/api/checklist/${i.id}`, { doneAt: new Date(v).toISOString().slice(0, 16) })); }} />
                </label>
              )}
              <button className="btn ghost icon sm danger" aria-label={`Delete ${i.title}`} onClick={() => run.mutate(() => api.del<ChecklistItem[]>(`/api/checklist/${i.id}`))}><Trash2 size={12} /></button>
            </div>
          ))}
          <div className="row" style={{ padding: "8px 16px", borderTop: items.length ? "1px solid var(--border)" : undefined }}>
            <input className="input grow" placeholder="Add a task, e.g. Regression signed off by QA" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} aria-label="New task" />
            <button className="btn sm" onClick={add} disabled={!title.trim()}><Plus size={13} /> Add</button>
            {others.length > 0 && (
              <select className="select" style={{ width: 150, height: 28 }} value="" aria-label="Copy tasks from another sprint"
                onChange={(e) => { const from = Number(e.target.value); if (from) run.mutate(() => api.post<ChecklistItem[]>(`${base}/copy`, { fromId: from })); }}>
                <option value="">Copy tasks from…</option>
                {others.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
