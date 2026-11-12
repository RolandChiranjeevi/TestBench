import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Check, Pencil, Undo2 } from "lucide-react";
import { api, formatDateTime } from "../api";
import { useToast } from "../components/ui";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { EditScope } from "../components/Access";

type Status = "proposed" | "draft" | "approved" | "rejected" | "ignored";
interface Change { field: string; from: string; to: string }
interface HistoryEntry { rev: number; at: string; kind: string; actor: string; byRule: boolean; note: string; status: Status; changes: Change[] }
interface BugDraft {
  id: number; number: number; label: string; suggestedBy: string; note: string; title: string; description: string; steps: string[]; expected: string; actual: string; status: Status;
  createdBy: string; createdAt: string; editedBy: string | null; editedAt: string | null; decidedBy: string | null; decidedAt: string | null; appliedBy: string | null; appliedAt: string | null;
  screenshot: { filename: string; mime: string; size: number; url: string }; bug: { id: number } | null; history: HistoryEntry[];
}
interface Draft { title: string; description: string; steps: string; expected: string; actual: string }
const draftOf = (d: BugDraft): Draft => ({ title: d.title, description: d.description, steps: d.steps.join("\n"), expected: d.expected, actual: d.actual });
const bodyOf = (d: Draft) => ({ title: d.title, description: d.description, steps: d.steps.split("\n").map((t) => t.trim()).filter(Boolean), expected: d.expected, actual: d.actual });
const KIND: Record<string, string> = { suggested: "Suggested by rule", edited: "Edited", draft: "Saved as a draft", approved: "Approved", rejected: "Rejected", ignored: "Ignored", restored: "Put back to Suggested", applied: "Applied as a draft bug" };

/**
 * Bug drafts from a screenshot and a short note. A fixed rule makes the draft (it is not AI, and the picture is not looked at). A person edits, approves, rejects or ignores it, and Apply
 * makes a bug report that stays proposed: accepting it as a real bug is the bug review's decision. Nothing is generated or run.
 */
export function BugDrafts({ pid }: { pid: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const listUrl = `/api/projects/${pid}/bug-drafts`;
  const { data } = useQuery({ queryKey: ["bug-drafts", pid], queryFn: () => api.get<BugDraft[]>(listUrl) });
  const all = data ?? [];
  const shown = all.filter((d) => showIgnored || d.status !== "ignored");
  const ignored = all.filter((d) => d.status === "ignored").length;

  const run = <T,>(fn: () => Promise<T>, ok: string) =>
    fn().then((r) => {
      for (const k of ["bug-drafts", "bug-reports"]) qc.invalidateQueries({ queryKey: [k] });
      if (ok) toast("success", ok);
      return r;
    }).catch((e: Error) => { toast("error", e.message); return null; });

  const make = async () => {
    if (!file || !note.trim()) return;
    setBusy(true);
    const fd = new FormData();
    fd.append("note", note);
    fd.append("file", file);
    const r = await run(() => api.post<BugDraft>(listUrl, fd), "A draft was made. It is only a draft: nothing is analysed, run or accepted.");
    setBusy(false);
    if (r) { setNote(""); setFile(null); if (fileRef.current) fileRef.current.value = ""; }
  };

  return (
    <section className="auto-suggestions bug-drafts" aria-label="Bug drafts from screenshots">
      <h4>Report from screenshot</h4>
      <EditScope>
        <div className="col" style={{ gap: 10 }}>
          <div className="field">
            <label htmlFor="bd-note">Note (what does the screenshot show?)</label>
            <textarea id="bd-note" className="textarea" value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="bd-file">Screenshot (png, jpg, webp or gif, at most 5 MB)</label>
            <input id="bd-file" ref={fileRef} className="input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
          <div className="plan-actions">
            <Button needs="tester" variant="primary" size="sm" disabled={busy || !file || !note.trim()} onClick={make}><Camera size={13} /> Make draft bug</Button>
            <span className="faint plan-who">A fixed rule makes the draft from your note. The picture is kept as evidence and is not analysed.</span>
          </div>
        </div>
      </EditScope>
      {all.length === 0 && <p className="faint">No bug drafts yet.</p>}
      {shown.map((d) => <DraftCard key={d.id} d={d} pid={pid} run={run} />)}
      {ignored > 0 && <Button variant="ghost" size="sm" aria-pressed={showIgnored} onClick={() => setShowIgnored(!showIgnored)}>{showIgnored ? "Hide" : "Show"} {ignored} ignored</Button>}
    </section>
  );
}

function Marks({ d }: { d: BugDraft }) {
  return (
    <>
      <Badge tone="accent" icon="eye" title="Made by a fixed rule from your note. It is not an AI, and the screenshot was not analysed.">{d.suggestedBy}</Badge>
      <Badge tone="neutral" icon="info" title="A draft bug report. It becomes a bug report only when a person applies it, and it stays proposed until the bug review accepts it.">Draft bug {d.label}</Badge>
      {d.status === "draft" && <Badge tone="info" icon="circle" title="A person is working on this draft.">Draft</Badge>}
      {d.status === "approved" && <Badge tone="ok" icon="circle-check" title={d.decidedBy ? `Approved by ${d.decidedBy}` : "Approved"}>Approved</Badge>}
      {d.status === "rejected" && <Badge tone="neutral" icon="circle-x" title={d.decidedBy ? `Rejected by ${d.decidedBy}` : "Rejected"}>Rejected</Badge>}
      {d.status === "ignored" && <Badge tone="neutral" icon="eye-off" title={d.decidedBy ? `Put aside by ${d.decidedBy}` : "Put aside"}>Ignored</Badge>}
    </>
  );
}

function DraftCard({ d, pid, run }: { d: BugDraft; pid: string; run: <T>(fn: () => Promise<T>, ok: string) => Promise<T | null> }) {
  const [editing, setEditing] = useState(false);
  const decide = (status: Status, ok: string) => run(() => api.post(`/api/bug-drafts/${d.id}/decision`, { status }), ok);
  const apply = () => run(() => api.post(`/api/bug-drafts/${d.id}/apply`, {}), "Made a bug report. It stays proposed: a person accepts it with the bug review.");
  const who = d.status === "proposed" && !d.editedAt ? `Suggested by a rule from ${d.createdBy}'s note. Nobody has reviewed it.` : [d.editedBy && `Edited by ${d.editedBy}`, d.editedAt && formatDateTime(d.editedAt), d.decidedBy && (d.status === "approved" || d.status === "rejected" || d.status === "ignored") && `${d.status === "approved" ? "Approved" : d.status === "rejected" ? "Rejected" : "Ignored"} by ${d.decidedBy}`].filter(Boolean).join(" · ");
  const canApply = !d.bug && d.status !== "rejected" && d.status !== "ignored";
  return (
    <div className="card auto-card" data-bug-draft={d.id}>
      <div className="plan-marks" style={{ marginLeft: 0 }}>
        <Marks d={d} />
        {d.bug && <Link className="chip" to={`/p/${pid}/bugs?bug=${d.bug.id}`}>Bug report {d.label}</Link>}
      </div>
      {editing ? (
        <DraftEditor d={d} onCancel={() => setEditing(false)} onSave={(v, decision) =>
          run(async () => { await api.patch(`/api/bug-drafts/${d.id}`, bodyOf(v)); if (decision) await api.post(`/api/bug-drafts/${d.id}/decision`, { status: decision }); return true; },
            decision === "approved" ? "Approved" : decision === "rejected" ? "Rejected" : "Saved as a draft").then((r) => { if (r) setEditing(false); })} />
      ) : (
        <>
          <p className="auto-summary"><strong>{d.title}</strong></p>
          <a href={d.screenshot.url} className="bug-draft-link" title="Opens the screenshot as a download">
            <img className="bug-draft-shot" src={d.screenshot.url} alt={`Screenshot for ${d.label}: ${d.screenshot.filename}`} loading="lazy" />
          </a>
          <h5>Description</h5>
          <p>{d.description}</p>
          <h5>Steps</h5>
          <ol>{d.steps.map((t, i) => <li key={i}>{t}</li>)}</ol>
          <h5>Expected</h5>
          <p>{d.expected}</p>
          <h5>Actual</h5>
          <p>{d.actual}</p>
          <div className="plan-actions">
            <Button needs="tester" size="sm" onClick={() => setEditing(true)}><Pencil size={13} /> Edit</Button>
            {d.status !== "approved" && <Button needs="tester" size="sm" onClick={() => decide("approved", "Approved")}><Check size={13} /> Approve</Button>}
            {d.status !== "rejected" && <Button needs="tester" size="sm" onClick={() => decide("rejected", "Rejected")}>Reject</Button>}
            {d.status !== "ignored" && <Button needs="tester" size="sm" variant="ghost" onClick={() => decide("ignored", "Ignored. It is hidden.")}>Ignore</Button>}
            {d.status === "ignored" && <Button needs="tester" size="sm" onClick={() => decide("proposed", "Put back to Suggested")}><Undo2 size={13} /> Put back</Button>}
            {d.status !== "draft" && d.status !== "proposed" && <Button needs="tester" size="sm" variant="ghost" onClick={() => decide("draft", "Saved as a draft")}>Save as draft</Button>}
            {canApply && <Button needs="tester" size="sm" variant="primary" title="Makes a bug report from this draft. The report stays proposed: it is never accepted by this." onClick={apply}>Apply as draft bug</Button>}
            <span className="faint plan-who">{who}</span>
          </div>
        </>
      )}
      <details className="auto-history">
        <summary>History ({d.history.length})</summary>
        <ol>
          {[...d.history].reverse().map((h) => (
            <li key={h.rev}>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <strong>{KIND[h.kind] ?? h.kind}</strong>
                {h.byRule ? <Badge tone="accent" icon="eye">Rule</Badge> : <span className="muted">by {h.actor}</span>}
                <span className="faint">{formatDateTime(h.at)}</span>
              </div>
              {h.note && <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>{h.note}</div>}
              {h.changes.map((c) => (
                <div key={c.field} style={{ fontSize: "var(--fs-sm)", marginTop: 4 }}>
                  <span className="section-label" style={{ margin: 0 }}>{c.field}</span>
                  <div className="plan-del">− {c.from || "(empty)"}</div>
                  <div className="plan-add">+ {c.to || "(empty)"}</div>
                </div>
              ))}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

function DraftEditor({ d, onSave, onCancel }: { d: BugDraft; onSave: (v: Draft, decision?: "approved" | "rejected") => void; onCancel: () => void }) {
  const [v, setV] = useState<Draft>(() => draftOf(d));
  const f = (k: keyof Draft, label: string, area = false) => (
    <div className="field">
      <label htmlFor={`bd-${d.id}-${k}`}>{label}</label>
      {area ? <textarea id={`bd-${d.id}-${k}`} className="textarea" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} /> : <input id={`bd-${d.id}-${k}`} className="input" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />}
    </div>
  );
  const ok = !!v.title.trim() && v.steps.split("\n").some((t) => t.trim());
  return (
    <div className="col" style={{ gap: 10, marginTop: 6 }}>
      {f("title", "Title")}{f("description", "Description", true)}{f("steps", "Steps (one per line)", true)}{f("expected", "Expected", true)}{f("actual", "Actual", true)}
      <div className="plan-actions">
        <Button needs="tester" variant="primary" size="sm" disabled={!ok} onClick={() => onSave(v)}>Save draft</Button>
        <Button needs="tester" size="sm" disabled={!ok} onClick={() => onSave(v, "approved")}><Check size={13} /> Approve</Button>
        <Button needs="tester" size="sm" disabled={!ok} onClick={() => onSave(v, "rejected")}>Reject</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
