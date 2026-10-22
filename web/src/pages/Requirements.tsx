import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenCheck, Check, ExternalLink, FileText, History, ImagePlus, Link2, Loader2, Paperclip, Play, Plus, Search, Trash2, X } from "lucide-react";
import { api, timeAgo, type CoverageState, type Priority, type Project, type Requirement, type RequirementAttachment, type RequirementDetail, type RequirementRevision, type RequirementStatus } from "../api";
import { Empty, Kbd, Modal, PriorityIcon, PRIORITY_LABEL, StatusIcon, useHotkeys, useToast } from "../components/ui";
import { CasePicker } from "../components/CasePicker";
import { jiraLabel, jiraUrl } from "./BugReport";
import { NewRunModal } from "./Runs";

export const COVERAGE_LABEL: Record<CoverageState, string> = {
  uncovered: "No test cases", failing: "Failing", passing: "Passing", partial: "Partly tested", untested: "Not run yet",
};
const COVERAGE_COLOR: Record<CoverageState, string> = {
  uncovered: "var(--text-3)", failing: "var(--failed)", passing: "var(--passed)", partial: "var(--blocked)", untested: "var(--text-3)",
};

export function CoverageChip({ coverage }: { coverage: Requirement["coverage"] }) {
  const label = COVERAGE_LABEL[coverage.state];
  const detail = coverage.cases ? ` · ${coverage.passing}/${coverage.cases}` : "";
  return (
    <span className="chip" title={`${coverage.cases} test case(s): ${coverage.passing} passing, ${coverage.failing} failing, ${coverage.notRun} not run`}>
      <span className="dot" style={{ background: COVERAGE_COLOR[coverage.state] }} />
      {label}{detail}
    </span>
  );
}

const STATUS_LABEL: Record<RequirementStatus, string> = { draft: "Draft", approved: "Approved", deprecated: "Deprecated" };
type Filter = "all" | "review" | CoverageState;

export function RequirementsPage() {
  const { pid } = useParams();
  const projectId = Number(pid);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("req") ? Number(params.get("req")) : null;
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });
  const key = projects?.find((p) => p.id === projectId)?.key ?? "";
  const { data: reqs = [], isLoading } = useQuery({ queryKey: ["requirements", pid], queryFn: () => api.get<Requirement[]>(`/api/projects/${pid}/requirements`) });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [creating, setCreating] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const select = (id: number | null) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (id == null) n.delete("req");
      else n.set("req", String(id));
      return n;
    }, { replace: true });

  useHotkeys({ c: (e) => { e.preventDefault(); setCreating(true); }, "/": (e) => { e.preventDefault(); searchRef.current?.focus(); } }, !creating);

  const active = reqs.filter((r) => r.status !== "deprecated");
  const counts: Record<Filter, number> = {
    all: reqs.length,
    review: active.filter((r) => r.reviewCount > 0).length,
    uncovered: active.filter((r) => r.coverage.state === "uncovered").length,
    failing: active.filter((r) => r.coverage.state === "failing").length,
    passing: active.filter((r) => r.coverage.state === "passing").length,
    partial: active.filter((r) => r.coverage.state === "partial").length,
    untested: active.filter((r) => r.coverage.state === "untested").length,
  };
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return reqs.filter((r) => {
      if (filter === "review" ? r.status === "deprecated" || r.reviewCount === 0 : filter !== "all" && (r.status === "deprecated" || r.coverage.state !== filter)) return false;
      return !q || `REQ-${r.number} ${r.title} ${r.source} ${r.description}`.toLowerCase().includes(q);
    });
  }, [reqs, search, filter]);
  const compact = selectedId != null;
  const tabs: Filter[] = ["all", "uncovered", "failing", "passing", "review"];

  return (
    <div className="split">
      <div className="pane grow" style={{ display: "flex", flexDirection: "column" }}>
        <div className="topbar">
          <h1>Requirements</h1>
          <span className="spacer" />
          <div className="search">
            <Search size={13} />
            <input ref={searchRef} className="input" placeholder="Search requirements" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search requirements" />
          </div>
          <button className="btn primary" onClick={() => setCreating(true)}><Plus size={14} /> New requirement <Kbd>C</Kbd></button>
        </div>
        <div className="toolbar">
          <div className="tabs" role="tablist">
            {tabs.map((f) => (
              <button key={f} role="tab" aria-selected={filter === f} className={`tab${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>
                {f === "all" ? "All" : f === "uncovered" ? "No test cases" : f === "review" ? "Needs review" : COVERAGE_LABEL[f]}
                <span className="count">{counts[f]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="content">
          {isLoading ? null : visible.length === 0 ? (
            reqs.length ? (
              <Empty icon={<Search size={20} />} title="No matching requirements">Try a different search or filter.</Empty>
            ) : (
              <Empty icon={<BookOpenCheck size={20} />} title="No requirements yet" action={<button className="btn primary" onClick={() => setCreating(true)}><Plus size={14} /> New requirement</button>}>
                Write down what the system should do, then link the test cases that prove it. Reports show which requirements are covered and which are failing.
              </Empty>
            )
          ) : (
            visible.map((r) => (
              <div key={r.id} className={`list-row${selectedId === r.id ? " selected" : ""}`} onClick={() => select(r.id)}>
                <PriorityIcon priority={r.priority} />
                <span className="id mono" style={{ width: 62 }}>REQ-{r.number}</span>
                <span className="title" style={r.status === "deprecated" ? { textDecoration: "line-through", color: "var(--text-3)" } : undefined}>{r.title}</span>
                <span className="meta">
                  {!compact && r.source && <span className="chip">{jiraLabel(r.source)}</span>}
                  {r.status === "draft" && <span className="chip">Draft</span>}
                  {r.attachmentCount > 0 && <span className="chip" title={`${r.attachmentCount} attachment(s)`}><Paperclip size={11} /> {r.attachmentCount}</span>}
                  {r.status !== "deprecated" && r.reviewCount > 0 && (
                    <span className="chip" style={{ borderColor: "var(--blocked)" }} title={`${r.reviewCount} linked case(s) to check after the wording changed`}>
                      <span className="dot" style={{ background: "var(--blocked)" }} />{r.reviewCount} to review
                    </span>
                  )}
                  {r.status !== "deprecated" && <CoverageChip coverage={r.coverage} />}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
      {selectedId != null && (
        <>
          <div className="detail-backdrop" onClick={() => select(null)} />
          <div className="detail-pane">
          <RequirementEditor key={selectedId} id={selectedId} caseKey={key} onClose={() => select(null)} />
        </div>
        </>
      )}
      {creating && <NewRequirementModal projectId={projectId} onClose={() => setCreating(false)} onCreated={select} />}
    </div>
  );
}

function useInvalidate() {
  const qc = useQueryClient();
  const { pid } = useParams();
  return () => {
    qc.invalidateQueries({ queryKey: ["requirements", pid] });
    qc.invalidateQueries({ queryKey: ["requirement"] });
    qc.invalidateQueries({ queryKey: ["cases", pid] });
    qc.invalidateQueries({ queryKey: ["case"] });
    qc.invalidateQueries({ queryKey: ["dashboard", pid] });
  };
}

function NewRequirementModal({ projectId, onClose, onCreated }: { projectId: number; onClose: () => void; onCreated: (id: number) => void }) {
  const [title, setTitle] = useState("");
  const toast = useToast();
  const invalidate = useInvalidate();
  const create = useMutation({
    mutationFn: () => api.post<RequirementDetail>(`/api/projects/${projectId}/requirements`, { title }),
    onSuccess: (r) => { invalidate(); toast("success", `Created REQ-${r.number}`); onClose(); onCreated(r.id); },
    onError: (e: Error) => toast("error", e.message),
  });
  const submit = () => title.trim() && !create.isPending && create.mutate();
  return (
    <Modal
      title={<span className="chip">New requirement</span>}
      onClose={onClose}
      footer={<button className="btn primary" disabled={!title.trim() || create.isPending} onClick={submit}>Create requirement <Kbd>↵</Kbd></button>}
    >
      <input className="bare title-input" autoFocus placeholder="e.g. A customer can pay with a saved card" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} aria-label="Requirement title" />
      <span className="faint" style={{ fontSize: 12 }}>Add the description, priority and linked test cases after creating.</span>
    </Modal>
  );
}

function RequirementEditor({ id, caseKey, onClose }: { id: number; caseKey: string; onClose: () => void }) {
  const { pid } = useParams();
  const toast = useToast();
  const invalidate = useInvalidate();
  const { data } = useQuery({ queryKey: ["requirement", id], queryFn: () => api.get<RequirementDetail>(`/api/requirements/${id}`) });
  const [linking, setLinking] = useState(false);
  const [running, setRunning] = useState(false);
  const [edits, setEdits] = useState<Partial<Pick<RequirementDetail, "title" | "description" | "source">>>({});

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<RequirementDetail>(`/api/requirements/${id}`, body),
    onSuccess: invalidate,
    onError: (e: Error) => toast("error", e.message),
  });
  const review = useMutation({
    mutationFn: (caseIds?: number[]) => api.post<RequirementDetail>(`/api/requirements/${id}/review`, caseIds ? { caseIds } : {}),
    onSuccess: invalidate,
    onError: (e: Error) => toast("error", e.message),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/requirements/${id}`),
    onSuccess: () => { invalidate(); onClose(); },
    onError: (e: Error) => toast("error", e.message),
  });
  if (!data) return null;

  const text = (k: "title" | "description" | "source") => edits[k] ?? data[k];
  const commit = (k: "title" | "description" | "source") => {
    const v = edits[k];
    if (v === undefined || v === data[k]) return;
    if (k === "title" && !v.trim()) { setEdits((e) => ({ ...e, title: undefined })); return; }
    save.mutate({ [k]: v });
    setEdits((e) => ({ ...e, [k]: undefined }));
  };
  const link = jiraUrl(data.source);

  return (
    <div>
      <div className="toolbar">
        <span className="mono muted">REQ-{data.number}</span>
        <CoverageChip coverage={data.coverage} />
        <span className="spacer" />
        <button className="btn ghost icon sm danger" title="Delete requirement" aria-label="Delete requirement" onClick={() => confirm(`Delete REQ-${data.number}? The test cases stay, only the links are removed.`) && remove.mutate()}><Trash2 size={14} /></button>
        <button className="btn ghost icon sm" onClick={onClose} title="Close" aria-label="Close"><X size={14} /></button>
      </div>
      <div style={{ padding: "20px 28px 40px", display: "flex", flexDirection: "column", gap: 18 }}>
        <textarea className="bare title-input" rows={1} value={text("title")} placeholder="Requirement title" aria-label="Title"
          onChange={(e) => setEdits((s) => ({ ...s, title: e.target.value.replace(/\n/g, " ") }))} onBlur={() => commit("title")} />
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          <label className="pill" title="Priority">
            <PriorityIcon priority={data.priority} />
            {PRIORITY_LABEL[data.priority]}
            <select value={data.priority} onChange={(e) => save.mutate({ priority: e.target.value as Priority })} aria-label="Priority">
              {(["critical", "high", "medium", "low"] as const).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
          </label>
          <label className="pill" title="Status">
            {STATUS_LABEL[data.status]}
            <select value={data.status} onChange={(e) => save.mutate({ status: e.target.value })} aria-label="Status">
              {(Object.keys(STATUS_LABEL) as RequirementStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
          </label>
        </div>
        <section>
          <div className="section-label">Description</div>
          <textarea className="bare" style={{ minHeight: 60, fieldSizing: "content" } as React.CSSProperties} value={text("description")} placeholder="What should the system do? Add acceptance criteria here."
            aria-label="Description" onChange={(e) => setEdits((s) => ({ ...s, description: e.target.value }))} onBlur={() => commit("description")} />
        </section>
        <section>
          <div className="section-label">Source</div>
          <div className="row">
            <input className="input grow" value={text("source")} placeholder="Jira story key or link, e.g. SHOP-123" aria-label="Source"
              onChange={(e) => setEdits((s) => ({ ...s, source: e.target.value }))} onBlur={() => commit("source")} />
            {link && <a className="btn sm" href={link} target="_blank" rel="noreferrer"><ExternalLink size={12} /> {jiraLabel(data.source)}</a>}
          </div>
        </section>
        <section>
          <div className="section-label"><Paperclip size={13} /> Attachments <span className="faint">{data.attachments.length}</span></div>
          <AttachmentsSection requirementId={data.id} attachments={data.attachments} />
        </section>
        {data.cases.some((c) => c.review_needed) && (
          <div className="card" style={{ padding: "10px 12px", borderColor: "var(--blocked)", display: "flex", gap: 10, alignItems: "center" }}>
            <span className="grow" style={{ fontSize: 12.5 }}>
              The wording changed after {data.cases.filter((c) => c.review_needed).length} linked {data.cases.filter((c) => c.review_needed).length === 1 ? "case was" : "cases were"} written or last checked. Make sure they still test the right thing.
            </span>
            <button className="btn sm" onClick={() => review.mutate(undefined)} disabled={review.isPending}><Check size={12} /> All still correct</button>
          </div>
        )}
        <section>
          <div className="section-label">Test cases <span className="faint">{data.cases.length}</span></div>
          {data.cases.length === 0 ? (
            <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>No test cases linked yet. This requirement is not covered.</div>
          ) : (
            <div className="card">
              {data.cases.map((c) => (
                <Link key={c.id} to={`/p/${pid}/cases?case=${c.id}`} className="row" style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", color: "inherit", textDecoration: c.status === "deprecated" ? "line-through" : undefined }}>
                  <StatusIcon status={c.last_status} />
                  <span className="mono muted" style={{ width: 62 }}>{caseKey}-{c.number}</span>
                  <span className="truncate grow">{c.title}</span>
                  {c.status === "deprecated" && <span className="chip">Deprecated</span>}
                  {c.review_needed && (
                    <button className="btn sm" title="Mark as still matching the requirement" onClick={(e) => { e.preventDefault(); e.stopPropagation(); review.mutate([c.id]); }}>Review</button>
                  )}
                </Link>
              ))}
            </div>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn sm" onClick={() => setLinking(true)}><Link2 size={13} /> Link test cases</button>
            <Link className="btn ghost sm" to={`/p/${pid}/cases?newFor=${data.id}`}>Write a new case</Link>
            <span className="spacer" />
            <button className="btn sm" disabled={!data.cases.some((c) => c.status !== "deprecated")} onClick={() => setRunning(true)}><Play size={12} /> Start run</button>
          </div>
        </section>
        <section>
          <div className="section-label"><History size={13} /> History <span className="faint">{data.history.length}</span></div>
          <div className="col" style={{ gap: 8 }}>
            {data.history.map((h) => <RevisionRow key={h.id} rev={h} caseKey={caseKey} />)}
          </div>
        </section>
      </div>
      {running && (
        <NewRunModal
          initialCaseIds={data.cases.filter((c) => c.status !== "deprecated").map((c) => c.id)}
          initialTitle={`REQ-${data.number}: ${data.title}`.slice(0, 120)}
          onClose={() => setRunning(false)}
        />
      )}
      {linking && (
        <LinkCasesModal
          initial={data.cases.map((c) => c.id)}
          onClose={() => setLinking(false)}
          onSave={(caseIds) => save.mutate({ caseIds: [...new Set([...caseIds, ...data.cases.filter((c) => c.status === "deprecated").map((c) => c.id)])] }, { onSuccess: () => setLinking(false) })}
          saving={save.isPending}
        />
      )}
    </div>
  );
}

function LinkCasesModal({ initial, onClose, onSave, saving }: { initial: number[]; onClose: () => void; onSave: (ids: number[]) => void; saving: boolean }) {
  const [selected, setSelected] = useState(new Set(initial));
  return (
    <Modal title="Link test cases" onClose={onClose} width={560}
      footer={<button className="btn primary" disabled={saving} onClick={() => onSave([...selected])}>Save {selected.size} linked</button>}>
      <CasePicker selected={selected} onChange={setSelected} />
    </Modal>
  );
}

const FIELD_LABEL: Record<string, string> = { title: "Title", description: "Description", priority: "Priority", status: "Status", source: "Source" };

function RevisionRow({ rev, caseKey }: { rev: RequirementRevision; caseKey: string }) {
  const keys = (nums: number[]) => nums.map((n) => `${caseKey}-${n}`).join(", ");
  return (
    <div style={{ fontSize: 12.5 }}>
      <div className="faint" style={{ fontSize: 11.5 }}>{timeAgo(rev.at.replace(" ", "T") + "Z")}{rev.material && " · wording changed"}</div>
      {rev.changes.map((c, i) => (
        <div key={i}>
          {c.field === "created" && "Created"}
          {c.field === "cases" && (
            <>
              {!!c.added?.length && <>Linked {keys(c.added)}. </>}
              {!!c.removed?.length && <>Unlinked {keys(c.removed)}.</>}
            </>
          )}
          {c.field === "attachments" && (c.to ? <>Attached {c.to}</> : <>Removed attachment {c.from}</>)}
          {c.field === "description" && (
            <details>
              <summary style={{ cursor: "pointer" }}>Description edited</summary>
              <div className="muted" style={{ whiteSpace: "pre-wrap" }}>Before: {c.from || "(empty)"}</div>
              <div style={{ whiteSpace: "pre-wrap" }}>After: {c.to || "(empty)"}</div>
            </details>
          )}
          {c.field in FIELD_LABEL && c.field !== "description" && (
            <>{FIELD_LABEL[c.field]}: <span className="muted">{c.from || "(empty)"}</span> → {c.to || "(empty)"}</>
          )}
        </div>
      ))}
    </div>
  );
}

/** Link ticked cases to one requirement, keeping whatever is already linked. */
export function LinkToRequirementModal({ caseIds, onClose, onDone }: { caseIds: number[]; onClose: () => void; onDone: () => void }) {
  const { pid } = useParams();
  const toast = useToast();
  const invalidate = useInvalidate();
  const { data: reqs = [] } = useQuery({ queryKey: ["requirements", pid], queryFn: () => api.get<Requirement[]>(`/api/projects/${pid}/requirements`) });
  const [picked, setPicked] = useState<number | null>(null);
  const link = useMutation({
    mutationFn: () => api.post<RequirementDetail>(`/api/requirements/${picked}/cases`, { caseIds }),
    onSuccess: (r) => { invalidate(); toast("success", `Linked ${caseIds.length} ${caseIds.length === 1 ? "case" : "cases"} to REQ-${r.number}`); onDone(); onClose(); },
    onError: (e: Error) => toast("error", e.message),
  });
  const open = reqs.filter((r) => r.status !== "deprecated");
  return (
    <Modal title={`Link ${caseIds.length} ${caseIds.length === 1 ? "case" : "cases"} to a requirement`} onClose={onClose} width={520}
      footer={<button className="btn primary" disabled={picked == null || link.isPending} onClick={() => link.mutate()}>Link</button>}>
      {open.length === 0 ? (
        <div className="muted">No requirements yet. Add some on the Requirements page first.</div>
      ) : (
        <div className="card" style={{ maxHeight: 340, overflow: "auto" }}>
          {open.map((r) => (
            <label key={r.id} className="list-row" style={{ height: 32, padding: "0 12px" }}>
              <input type="radio" name="req" checked={picked === r.id} onChange={() => setPicked(r.id)} />
              <PriorityIcon priority={r.priority} />
              <span className="mono muted" style={{ width: 62 }}>REQ-{r.number}</span>
              <span className="title">{r.title}</span>
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Files that belong to a requirement: specs, mockups, mails. Drop, browse or paste (screenshots) to add. */
function AttachmentsSection({ requirementId, attachments }: { requirementId: number; attachments: RequirementAttachment[] }) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    if (!list.length) return;
    const fd = new FormData();
    list.forEach((f, i) => fd.append("file", f, f.name || `screenshot-${Date.now()}-${i}.png`));
    setUploading(true);
    try {
      await api.post(`/api/requirements/${requirementId}/attachments`, fd);
      invalidate();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setUploading(false);
    }
  };
  const uploadRef = useRef(upload);
  uploadRef.current = upload;

  // A pasted screenshot or file goes straight in. Pasted text is left alone.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        e.preventDefault();
        uploadRef.current(files);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  return (
    <>
      {attachments.length > 0 && (
        <div className="card" style={{ marginBottom: 10 }}>
          {attachments.map((a) => {
            const url = `/uploads/${a.stored_name}`;
            return (
              <div key={a.id} className="row" style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)", minHeight: 40 }}>
                {a.mime.startsWith("image/") ? <img src={url} alt="" style={{ width: 28, height: 28, objectFit: "cover", borderRadius: 4 }} /> : <FileText size={16} className="faint" />}
                <a className="truncate grow" href={url} target="_blank" rel="noreferrer" download={a.filename} title={`Open ${a.filename}`}>{a.filename}</a>
                <span className="faint" style={{ fontSize: 12 }}>{fmtSize(a.size)}</span>
                <button
                  className="btn ghost icon sm danger"
                  aria-label={`Remove ${a.filename}`}
                  onClick={async () => {
                    if (!confirm(`Remove ${a.filename}?`)) return;
                    try { await api.del(`/api/requirement-attachments/${a.id}`); invalidate(); } catch (e) { toast("error", (e as Error).message); }
                  }}
                ><Trash2 size={12} /></button>
              </div>
            );
          })}
        </div>
      )}
      <div
        className={`dropzone${over ? " over" : ""}`}
        style={{ padding: 14 }}
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files); }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && fileRef.current?.click()}
      >
        {uploading ? <Loader2 size={16} className="spin" /> : <ImagePlus size={16} />}
        <div style={{ marginTop: 4 }}>Drop files here, click to browse, or paste a screenshot with <Kbd>⌘V</Kbd></div>
        <div className="faint" style={{ fontSize: 11.5 }}>PDF, Word, Excel, PowerPoint, images, CSV, text, mail (.eml), zip</div>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ""; }} />
      </div>
    </>
  );
}
