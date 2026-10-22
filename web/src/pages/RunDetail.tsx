import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban, Bot, Check, ChevronDown, ChevronRight, CircleSlash, ExternalLink, FileCode2, GitBranch, GitCommit,
  ImagePlus, Loader2, Paperclip, RotateCcw, Search, Trash2, X,
} from "lucide-react";
import {
  api, formatDateTime, formatDuration, passRate, timeAgo,
  type Attachment, type ResultDetail, type RunDetail, type RunResult, type Status,
} from "../api";
import { Bug, Pencil } from "lucide-react";
import { Empty, FrameworkBadge, Github, Kbd, PriorityIcon, ProgressBar, StatusIcon, STATUS_LABEL, useHotkeys, useToast, ListSkeleton } from "../components/ui";
import { AutomatedDetail } from "./AutomatedDetail";
import { NewRunModal } from "./Runs";
import { BugReportModal, jiraLabel, jiraUrl } from "./BugReport";

export function RunDetailPage() {
  const { pid, runId } = useParams();
  const { data: run, isLoading, error } = useQuery({ queryKey: ["run", runId], queryFn: () => api.get<RunDetail>(`/api/runs/${runId}`) });
  if (isLoading) return <div className="content"><ListSkeleton rows={8} /></div>;
  if (error || !run) {
    return (
      <Empty icon={<X size={20} />} title="Run not found">
        <Link to={`/p/${pid}/runs`} style={{ color: "var(--accent-text)" }}>Back to runs</Link>
      </Empty>
    );
  }
  return run.kind === "manual" ? <ManualRun run={run} /> : <AutomatedRun run={run} />;
}

/** The run's name in the header. Click the pencil (or double-click the name) to rename it. */
function RunTitle({ run }: { run: RunDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(run.title);
  const rename = useMutation({
    mutationFn: (title: string) => api.patch(`/api/runs/${run.id}`, { title }),
    onSuccess: () => {
      for (const k of ["run", "runs", "dashboard", "milestones"]) qc.invalidateQueries({ queryKey: [k] });
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const commit = () => {
    const title = value.trim();
    setEditing(false);
    if (title && title !== run.title) rename.mutate(title);
    else setValue(run.title);
  };

  if (editing) {
    return (
      <input
        className="input"
        style={{ height: 28, maxWidth: 420, fontWeight: 600 }}
        value={value}
        autoFocus
        aria-label="Run name"
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") { setValue(run.title); setEditing(false); }
        }}
      />
    );
  }
  return (
    <>
      <span className="truncate" onDoubleClick={() => { setValue(run.title); setEditing(true); }} title="Double-click to rename">{run.title}</span>
      <button className="btn ghost icon sm" onClick={() => { setValue(run.title); setEditing(true); }} aria-label="Rename run" title="Rename run"><Pencil size={12} /></button>
    </>
  );
}

function RunHeader({ run, children }: { run: RunDetail; children?: ReactNode }) {
  const { pid } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [rerun, setRerun] = useState(false);
  // Failed or blocked results whose case still exists can be re-tested manually (for automated runs, via the case each test is linked to).
  const failing = run.results.filter((r) => r.status === "failed" || r.status === "blocked");
  const caseIds = [...new Set(failing.map((r) => r.case_id).filter((id): id is number => id != null))];
  const unlinked = failing.filter((r) => r.case_id == null).length;
  const rerunOf = (run.meta as { rerunOf?: { id: number; title: string } }).rerunOf;
  const remove = async () => {
    if (!confirm(`Delete run "${run.title}" and all its results?`)) return;
    await api.del(`/api/runs/${run.id}`);
    qc.invalidateQueries({ queryKey: ["runs", pid] });
    qc.invalidateQueries({ queryKey: ["projects"] });
    qc.invalidateQueries({ queryKey: ["cases", pid] });
    navigate(`/p/${pid}/runs`);
  };
  return (
    <div className="topbar">
      <h1>
        <Link to={`/p/${pid}/runs`} className="crumb">Runs</Link>
        <ChevronRight size={13} className="faint" />
        <RunTitle run={run} />
      </h1>
      <span className="spacer" />
      {rerunOf && <Link className="chip" to={`/p/${pid}/runs/${rerunOf.id}`} title="The run this one re-tests">Re-run of {rerunOf.title}</Link>}
      {failing.length > 0 && (
        <button
          className="btn sm"
          disabled={!caseIds.length}
          onClick={() => setRerun(true)}
          title={caseIds.length ? `Start a manual run with the ${caseIds.length} failed or blocked ${caseIds.length === 1 ? "case" : "cases"}${unlinked ? `. ${unlinked} failing ${unlinked === 1 ? "test isn't" : "tests aren't"} linked to a case and can't be included` : ""}` : "None of the failing tests are linked to a case"}
        >
          <RotateCcw size={12} /> Re-run failed ({caseIds.length})
        </button>
      )}
      {children}
      <button className="btn ghost icon sm danger" onClick={remove} title="Delete run" aria-label="Delete run">
        <Trash2 size={14} />
      </button>
      {rerun && (
        <NewRunModal
          initialCaseIds={caseIds}
          rerunOf={{ id: run.id, title: run.title, environment: run.environment, milestone: run.milestone }}
          onClose={() => setRerun(false)}
        />
      )}
    </div>
  );
}

// =====================================================================
// Manual run execution
// =====================================================================

const EXEC_STATUSES: { s: Status; key: string }[] = [
  { s: "passed", key: "p" },
  { s: "failed", key: "f" },
  { s: "blocked", key: "b" },
  { s: "skipped", key: "s" },
];

function ManualRun({ run }: { run: RunDetail }) {
  const { runId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const q = search.trim().toLowerCase();
  const results = run.results.filter((r) => !q || `${run.project_key}-${r.case_number} ${r.case_title}`.toLowerCase().includes(q));
  const selectedId = Number(params.get("result")) || results.find((r) => r.status === "untested")?.id || results[0]?.id;
  const idx = results.findIndex((r) => r.id === selectedId);
  const select = (id: number | undefined) => id && setParams({ result: String(id) }, { replace: true });

  useEffect(() => {
    listRef.current?.querySelector(".list-row.selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: Status }) => api.patch(`/api/results/${id}`, { status }),
    onMutate: ({ id, status }) => {
      // Optimistic: update the list and counts right away.
      qc.setQueryData<RunDetail>(["run", runId], (old) => {
        if (!old) return old;
        const prev = old.results.find((r) => r.id === id)?.status;
        const counts = { ...old.counts };
        if (prev) counts[prev]--;
        counts[status]++;
        return { ...old, counts, results: old.results.map((r) => (r.id === id ? { ...r, status } : r)) };
      });
      qc.setQueryData<ResultDetail>(["result", id], (old) => (old ? { ...old, status } : old));
    },
    onSettled: (_d, _e, { id }) => {
      qc.invalidateQueries({ queryKey: ["run", runId] });
      qc.invalidateQueries({ queryKey: ["result", id] });
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["cases"] });
    },
    onError: (e: Error) => toast("error", e.message),
  });

  const mark = (status: Status, advance: boolean) => {
    const cur = results[idx];
    if (!cur) return;
    const next = cur.status === status ? "untested" : status;
    setStatus.mutate({ id: cur.id, status: next });
    if (advance && next !== "untested") {
      // Move to the next untested case after this one, wrapping around.
      const after = [...results.slice(idx + 1), ...results.slice(0, idx)].find((r) => r.status === "untested");
      if (after) select(after.id);
    }
  };

  const complete = useMutation({
    mutationFn: (status: "completed" | "in_progress") => api.patch(`/api/runs/${run.id}`, { status }),
    onSuccess: (_d, status) => {
      qc.invalidateQueries({ queryKey: ["run", runId] });
      qc.invalidateQueries({ queryKey: ["runs"] });
      toast("success", status === "completed" ? "Run completed" : "Run reopened");
    },
  });

  // Passing or skipping moves on; failing or blocking stays so you can add notes and screenshots.
  useHotkeys({
    j: () => select(results[Math.min(idx + 1, results.length - 1)]?.id),
    k: () => select(results[Math.max(idx - 1, 0)]?.id),
    ArrowDown: () => select(results[Math.min(idx + 1, results.length - 1)]?.id),
    ArrowUp: () => select(results[Math.max(idx - 1, 0)]?.id),
    p: () => mark("passed", true),
    f: () => mark("failed", false),
    b: () => mark("blocked", false),
    s: () => mark("skipped", true),
  });

  const c = run.counts;
  const done = c.total - c.untested;
  const rate = passRate(c);
  const groups = useMemo(() => {
    const out: { name: string; items: RunResult[] }[] = [];
    for (const r of results) {
      const name = r.suite_name ?? "No suite";
      const last = out.at(-1);
      if (last?.name === name) last.items.push(r);
      else out.push({ name, items: [r] });
    }
    return out;
  }, [results]);

  return (
    <>
      <RunHeader run={run}>
        {run.environment && <span className="chip">{run.environment}</span>}
        {run.milestone && <span className="chip accent">{run.milestone}</span>}
        {run.status === "completed" ? (
          <button className="btn sm" onClick={() => complete.mutate("in_progress")}><RotateCcw size={12} /> Reopen</button>
        ) : (
          <button className="btn sm primary" onClick={() => complete.mutate("completed")} disabled={complete.isPending}>
            <Check size={13} /> Complete run
          </button>
        )}
      </RunHeader>
      <div className="toolbar" style={{ gap: 16 }}>
        <div style={{ width: 240 }}><ProgressBar counts={c} large /></div>
        <span className="tabular muted">{done}/{c.total} executed</span>
        <span className="row tabular" style={{ gap: 12, fontSize: "var(--fs-md)" }}>
          <span className="row" style={{ gap: 4 }}><StatusIcon status="passed" size={12} /> {c.passed}</span>
          <span className="row" style={{ gap: 4 }}><StatusIcon status="failed" size={12} /> {c.failed}</span>
          <span className="row" style={{ gap: 4 }}><StatusIcon status="blocked" size={12} /> {c.blocked}</span>
          <span className="row" style={{ gap: 4 }}><StatusIcon status="skipped" size={12} /> {c.skipped}</span>
        </span>
        <span className="spacer" />
        {rate != null && <span className="tabular" style={{ fontWeight: 600 }}>{rate}% pass rate</span>}
        {run.status === "completed" && <span className="faint">Completed {timeAgo(run.finished_at)}</span>}
      </div>
      <div className="split run-split" style={{ flex: 1, minHeight: 0 }}>
        <div className="pane run-list" ref={listRef}>
          <div style={{ padding: 8, borderBottom: "1px solid var(--border)" }}>
            <div className="search">
              <Search size={13} />
              <input className="input" placeholder="Filter" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Filter cases in run" />
            </div>
          </div>
          {groups.map((g, gi) => (
            <div key={gi}>
              <div className="group-header" style={{ padding: "0 16px" }}>{g.name}<span className="count">{g.items.length}</span></div>
              {g.items.map((r) => (
                <div key={r.id} className={`list-row${r.id === selectedId ? " selected focused" : ""}`} style={{ padding: "0 16px" }} onClick={() => select(r.id)}>
                  <StatusIcon status={r.status} />
                  <span className="mono muted" style={{ width: 58, flexShrink: 0 }}>{run.project_key}-{r.case_number ?? "?"}</span>
                  <span className="title">{r.case_title ?? "Deleted case"}</span>
                  {r.jira_key && <span className="chip" title={`Linked Jira issue ${jiraLabel(r.jira_key)}`}><Bug size={10} /> {jiraLabel(r.jira_key)}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="pane grow">
          {selectedId ? (
            <ExecutionPanel key={selectedId} resultId={selectedId} projectKey={run.project_key} run={run} onMark={(s) => mark(s, s === "passed" || s === "skipped")} />
          ) : (
            <Empty icon={<Check size={20} />} title="Nothing to execute" />
          )}
        </div>
      </div>
    </>
  );
}

function ExecutionPanel({ resultId, projectKey, run, onMark }: { resultId: number; projectKey: string; run: { title: string; environment: string; milestone: string }; onMark: (s: Status) => void }) {
  const [bugOpen, setBugOpen] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const { data: r } = useQuery({ queryKey: ["result", resultId], queryFn: () => api.get<ResultDetail>(`/api/results/${resultId}`) });
  const [notes, setNotes] = useState<string | null>(null);
  const notesTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingNotes = useRef<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (r && notes === null) setNotes(r.notes);
  }, [r, notes]);

  const flushNotes = () => {
    clearTimeout(notesTimer.current);
    if (pendingNotes.current === null) return;
    const v = pendingNotes.current;
    pendingNotes.current = null;
    api.patch(`/api/results/${resultId}`, { notes: v }).catch((e) => toast("error", e.message));
  };
  const saveNotes = (v: string) => {
    setNotes(v);
    pendingNotes.current = v;
    clearTimeout(notesTimer.current);
    notesTimer.current = setTimeout(flushNotes, 500);
  };
  // Don't lose notes typed just before switching case.
  useEffect(() => () => flushNotes(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const setStep = useMutation({
    mutationFn: ({ stepId, status, actual }: { stepId: number; status: Status; actual?: string }) =>
      api.put(`/api/results/${resultId}/steps/${stepId}`, { status, actual }),
    onMutate: ({ stepId, status, actual }) => {
      qc.setQueryData<ResultDetail>(["result", resultId], (old) => {
        if (!old) return old;
        const others = old.stepResults.filter((s) => s.step_id !== stepId);
        const prev = old.stepResults.find((s) => s.step_id === stepId);
        return { ...old, stepResults: [...others, { step_id: stepId, status, actual: actual ?? prev?.actual ?? "" }] };
      });
    },
    onError: (e: Error) => toast("error", e.message),
  });

  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    if (!list.length) return;
    const fd = new FormData();
    list.forEach((f, i) => fd.append("file", f, f.name || `screenshot-${Date.now()}-${i}.png`));
    setUploading(true);
    try {
      await api.post(`/api/results/${resultId}/attachments`, fd);
      qc.invalidateQueries({ queryKey: ["result", resultId] });
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setUploading(false);
    }
  };
  const uploadRef = useRef(upload);
  uploadRef.current = upload;

  // Paste a screenshot straight from the clipboard.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (files.length) {
        e.preventDefault();
        uploadRef.current(files);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  if (!r) return <div className="row muted" style={{ padding: 24 }}><Loader2 size={14} className="spin" /> Loading…</div>;
  const c = r.case;
  if (!c) return <Empty icon={<X size={20} />} title="This case was deleted">Its result is kept for the run history.</Empty>;

  const stepStatus = (id: number) => r.stepResults.find((s) => s.step_id === id);
  const markStep = (stepId: number, status: Status) => {
    const cur = stepStatus(stepId)?.status;
    const next = cur === status ? "untested" : status;
    setStep.mutate({ stepId, status: next });
    // A failing or blocked step fails or blocks the case if it hasn't been decided yet.
    if ((next === "failed" || next === "blocked") && r.status === "untested") onMark(next);
  };

  return (
    <div style={{ padding: "22px 28px 48px", maxWidth: 900, display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="col" style={{ gap: 6 }}>
        <div className="row muted" style={{ gap: 8 }}>
          <span className="mono">{projectKey}-{c.number}</span>
          <PriorityIcon priority={c.priority} />
          {c.tags.map((t) => <span key={t} className="chip">{t}</span>)}
          <span className="spacer" />
          {c.id ? (
            <Link to={`/p/${c.project_id}/cases?case=${c.id}`} className="btn ghost sm"><ExternalLink size={12} /> Open case</Link>
          ) : (
            <span className="chip">Case deleted</span>
          )}
        </div>
        {c.edited_since && (
          <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>
            This case was edited after the run started. You're seeing the steps as they were then.
          </div>
        )}
        <h2 style={{ margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: "-0.01em" }}>{c.title}</h2>
        {c.description && <p style={{ margin: 0, color: "var(--text-2)", whiteSpace: "pre-wrap" }}>{c.description}</p>}
      </div>

      <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="row">
          <span className="section-label" style={{ margin: 0 }}>Result</span>
          <span className="spacer" />
          {r.executed_at && r.status !== "untested" && <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>{formatDateTime(r.executed_at)}</span>}
        </div>
        <div className="status-btns">
          {EXEC_STATUSES.map(({ s, key }) => (
            <button key={s} className={`status-btn ${s}${r.status === s ? " on" : ""}`} onClick={() => onMark(s)} aria-pressed={r.status === s}>
              <StatusIcon status={s} /> {STATUS_LABEL[s]} <Kbd>{key.toUpperCase()}</Kbd>
            </button>
          ))}
        </div>
        {(r.status === "failed" || r.status === "blocked") && (
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm" onClick={() => setBugOpen(true)}><Bug size={13} /> {r.jira_key ? "Edit bug report" : "Report bug"}</button>
            {r.jira_key &&
              (jiraUrl(r.jira_key) ? (
                <a className="chip accent" href={jiraUrl(r.jira_key)!} target="_blank" rel="noreferrer">{jiraLabel(r.jira_key)}</a>
              ) : (
                <span className="chip accent">{jiraLabel(r.jira_key)}</span>
              ))}
          </div>
        )}
      </div>

      {c.preconditions && (
        <section>
          <div className="section-label">Preconditions</div>
          <div style={{ whiteSpace: "pre-wrap", color: "var(--text-2)" }}>{c.preconditions}</div>
        </section>
      )}

      <section>
        <div className="section-label">Steps <span className="faint">{c.steps.length}</span></div>
        {c.steps.length === 0 ? (
          <div className="muted">This case has no steps. Mark the whole case above.</div>
        ) : (
          <div>
            {c.steps.map((s, i) => {
              const sr = stepStatus(s.id);
              return (
                <div key={s.id} className="exec-step">
                  <span className="faint tabular" style={{ paddingTop: 1 }}>{i + 1}</span>
                  <div className="col" style={{ gap: 4 }}>
                    <div style={{ whiteSpace: "pre-wrap" }}>{s.action || <span className="faint">No action</span>}</div>
                    {s.expected && (
                      <div className="row" style={{ alignItems: "flex-start", gap: 6, color: "var(--text-3)" }}>
                        <span style={{ fontSize: "var(--fs-sm)", fontWeight: 600, paddingTop: 2, letterSpacing: "0.02em" }}>EXPECT</span>
                        <span style={{ whiteSpace: "pre-wrap" }}>{s.expected}</span>
                      </div>
                    )}
                    {(sr?.status === "failed" || sr?.status === "blocked") && (
                      <StepActual initial={sr.actual} onSave={(actual) => setStep.mutate({ stepId: s.id, status: sr.status, actual })} />
                    )}
                  </div>
                  <div className="mini-status" role="group" aria-label={`Step ${i + 1} result`}>
                    <button className={`passed${sr?.status === "passed" ? " on" : ""}`} onClick={() => markStep(s.id, "passed")} title="Passed" aria-pressed={sr?.status === "passed"}><Check size={14} /></button>
                    <button className={`failed${sr?.status === "failed" ? " on" : ""}`} onClick={() => markStep(s.id, "failed")} title="Failed" aria-pressed={sr?.status === "failed"}><X size={14} /></button>
                    <button className={`blocked${sr?.status === "blocked" ? " on" : ""}`} onClick={() => markStep(s.id, "blocked")} title="Blocked" aria-pressed={sr?.status === "blocked"}><Ban size={13} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <div className="section-label">Notes</div>
        <textarea
          className="textarea"
          rows={3}
          placeholder="What did you observe? Bug links, data used, device…"
          value={notes ?? ""}
          onChange={(e) => saveNotes(e.target.value)}
          onBlur={flushNotes}
          aria-label="Notes"
        />
      </section>

      <section>
        <div className="section-label"><Paperclip size={12} /> Attachments <span className="faint">{r.attachments.length}</span></div>
        {r.attachments.length > 0 && (
          <div className="thumbs" style={{ marginBottom: 12 }}>
            {r.attachments.map((a) => (
              <Thumb key={a.id} a={a} onDelete={async () => { await api.del(`/api/attachments/${a.id}`); qc.invalidateQueries({ queryKey: ["result", resultId] }); }} />
            ))}
          </div>
        )}
        <div
          className={`dropzone${over ? " over" : ""}`}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files); }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && fileRef.current?.click()}
        >
          {uploading ? <Loader2 size={16} className="spin" /> : <ImagePlus size={16} />}
          <div style={{ marginTop: 4 }}>Drop screenshots here, click to browse, or paste with <Kbd>⌘V</Kbd></div>
          <input ref={fileRef} type="file" multiple hidden accept="image/*,video/*,.txt,.log,.pdf" onChange={(e) => e.target.files && upload(e.target.files)} />
        </div>
      </section>
      {bugOpen && <BugReportModal result={r} projectKey={projectKey} run={run} onClose={() => setBugOpen(false)} />}
    </div>
  );
}

function StepActual({ initial, onSave }: { initial: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <input
      className="input"
      style={{ height: 28, fontSize: "var(--fs-md)" }}
      placeholder="Actual result"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== initial && onSave(v)}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      aria-label="Actual result"
    />
  );
}

function Thumb({ a, onDelete }: { a: Attachment; onDelete: () => void }) {
  const url = `/uploads/${a.stored_name}`;
  return (
    <div className="thumb" title={a.filename}>
      <a href={url} target="_blank" rel="noreferrer" style={{ display: "contents" }}>
        {a.mime.startsWith("image/") ? <img src={url} alt={a.filename} /> : <span className="truncate" style={{ padding: 6 }}>{a.filename}</span>}
      </a>
      <button className="btn icon sm x" onClick={onDelete} aria-label={`Remove ${a.filename}`}><X size={12} /></button>
    </div>
  );
}

// =====================================================================
// Automated run
// =====================================================================

type AutoFilter = "all" | "failed" | "flaky" | "passed" | "skipped";

function AutomatedRun({ run }: { run: RunDetail }) {
  const { pid } = useParams();
  const [filter, setFilter] = useState<AutoFilter>(run.counts.failed ? "failed" : "all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Set<number>>(new Set());
  const c = run.counts;
  const rate = passRate(c);
  const meta = run.meta as { url?: string; branch?: string; sha?: string; commit?: string; files?: string[] };

  const q = search.trim().toLowerCase();
  const visible = run.results.filter((r) => {
    if (filter === "failed" && r.status !== "failed") return false;
    if (filter === "flaky" && !r.flaky) return false;
    if (filter === "passed" && r.status !== "passed") return false;
    if (filter === "skipped" && r.status !== "skipped") return false;
    return !q || `${r.test_full_name} ${r.error}`.toLowerCase().includes(q);
  });
  const groups = useMemo(() => {
    const map = new Map<string, RunResult[]>();
    for (const r of visible) {
      const k = r.test_file || r.test_suite_path || "Tests";
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(r);
    }
    return [...map.entries()];
  }, [visible]);

  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const tabCount: Record<AutoFilter, number> = { all: c.total, failed: c.failed, flaky: c.flaky, passed: c.passed, skipped: c.skipped };
  const unlinked = run.results.filter((r) => !r.case_id).length;
  const rateColor = rate == null ? undefined : rate >= 90 ? "var(--passed-fg)" : rate >= 70 ? "var(--blocked-fg)" : "var(--failed-fg)";

  return (
    <>
      <RunHeader run={run}>
        <FrameworkBadge framework={run.framework} />
        {meta.url && <a className="btn sm" href={meta.url} target="_blank" rel="noreferrer"><Github size={12} /> View on GitHub</a>}
      </RunHeader>
      <div className="content">
        <div style={{ padding: "18px 20px", display: "flex", gap: 32, alignItems: "flex-end", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
          <div className="stat"><span className="value" style={{ color: rateColor }}>{rate == null ? "—" : `${rate}%`}</span><span className="label">Pass rate</span></div>
          <div className="stat"><span className="value">{c.total}</span><span className="label">Tests</span></div>
          <div className="stat"><span className="value" style={{ color: "var(--passed-fg)" }}>{c.passed}</span><span className="label">Passed</span></div>
          <div className="stat"><span className="value" style={{ color: c.failed ? "var(--failed-fg)" : undefined }}>{c.failed}</span><span className="label">Failed</span></div>
          <div className="stat"><span className="value" style={{ color: c.flaky ? "var(--flaky-fg)" : undefined }}>{c.flaky}</span><span className="label">Flaky</span></div>
          <div className="stat"><span className="value">{c.skipped}</span><span className="label">Skipped</span></div>
          <div className="stat"><span className="value">{formatDuration(c.duration_ms)}</span><span className="label">Total test time</span></div>
          <div className="col" style={{ gap: 4, marginLeft: "auto", fontSize: "var(--fs-sm)", color: "var(--text-3)", alignItems: "flex-end" }}>
            <span>{formatDateTime(run.started_at)}</span>
            {meta.branch && (
              <span className="row" style={{ gap: 4 }}>
                <GitBranch size={12} /> {meta.branch}
                {meta.sha && <><GitCommit size={12} /> <span className="mono">{meta.sha.slice(0, 7)}</span></>}
              </span>
            )}
            {meta.commit && <span className="truncate" style={{ maxWidth: 360 }}>{meta.commit}</span>}
            {meta.files && <span className="row" style={{ gap: 4 }}><FileCode2 size={12} /> {meta.files.join(", ")}</span>}
          </div>
        </div>
        <div className="toolbar" style={{ position: "sticky", top: 0, background: "var(--bg)", zIndex: 2 }}>
          <div className="tabs" role="tablist">
            {(["all", "failed", "flaky", "passed", "skipped"] as const).map((f) => (
              <button key={f} role="tab" aria-selected={filter === f} className={`tab${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>
                {f[0].toUpperCase() + f.slice(1)} <span className="count">{tabCount[f]}</span>
              </button>
            ))}
          </div>
          <span className="spacer" />
          <div className="search">
            <Search size={13} />
            <input className="input" placeholder="Search tests or errors" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search tests" />
          </div>
        </div>
        {groups.length === 0 ? (
          <Empty icon={<CircleSlash size={20} />} title="No tests match" />
        ) : (
          groups.map(([file, items]) => (
            <div key={file}>
              <div className="group-header" style={{ top: 42 }}>
                <FileCode2 size={13} /> <span className="mono" style={{ fontSize: "var(--fs-sm)" }}>{file}</span> <span className="count">{items.length}</span>
              </div>
              {items.map((r) => {
                const expandable = !!r.error || !!r.has_detail || r.attachment_count > 0;
                const isOpen = open.has(r.id);
                return (
                  <div key={r.id}>
                    <div className="list-row" onClick={() => expandable && toggle(r.id)} style={{ cursor: expandable ? "pointer" : "default" }}>
                      <span style={{ width: 12, display: "grid", color: "var(--text-4)" }}>
                        {expandable && (isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
                      </span>
                      <StatusIcon status={r.status} flaky={!!r.flaky} />
                      <span className="title">{r.test_title}</span>
                      <span className="meta">
                        {r.test_suite_path && r.test_suite_path !== file && <span className="faint truncate" style={{ maxWidth: 220 }}>{r.test_suite_path}</span>}
                        {r.flaky ? <span className="chip" style={{ color: "var(--flaky-fg)" }}>flaky</span> : null}
                        {r.attachment_count > 0 && <span className="chip" title="Screenshots, videos and traces"><Paperclip size={10} /> {r.attachment_count}</span>}
                        {r.jira_key && <span className="chip accent" title="Linked Jira issue"><Bug size={10} /> {jiraLabel(r.jira_key)}</span>}
                        {r.case_id ? (
                          <Link to={`/p/${pid}/cases?case=${r.case_id}`} className="chip accent" onClick={(e) => e.stopPropagation()} title={r.case_title ?? ""}>
                            {run.project_key}-{r.case_number}
                          </Link>
                        ) : null}
                        <span className="tabular faint" style={{ width: 56, textAlign: "right" }}>{formatDuration(r.duration_ms)}</span>
                      </span>
                    </div>
                    {isOpen && <AutomatedDetail resultId={r.id} />}
                  </div>
                );
              })}
            </div>
          ))
        )}
        {unlinked > 0 && (
          <div className="row muted" style={{ padding: "16px 20px", fontSize: "var(--fs-md)" }}>
            <Bot size={13} /> {unlinked} {unlinked === 1 ? "test isn't" : "tests aren't"} linked to a case.
            <Link to={`/p/${pid}/automated?filter=unlinked`} style={{ color: "var(--accent-text)" }}>Link them</Link>
          </div>
        )}
      </div>
    </>
  );
}
