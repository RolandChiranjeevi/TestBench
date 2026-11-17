import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileCode, Pencil, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { api, formatDateTime, timeAgo, type CaseSummary, type SpecDetail, type SpecSummary } from "../api";
import { Badge } from "../components/Badge";
import { Button, buttonClass } from "../components/Button";
import { EditScope } from "../components/Access";
import { ConfirmModal, Empty, Modal, useToast } from "../components/ui";
import { SPEC_TEXT_MAX_BYTES, formatBytes, specNameProblem, specTextProblem, textBytes } from "../specname";
import { ViewTabs } from "./Insights";

// Own specs: a Playwright spec that a person writes or pastes here. It is a COPY of a file in their own repo, which is the source. TestBench keeps the text and its history, lets a person link
// it to a test case, and gives it back as a download. It never runs it and never writes it anywhere. Only a signed-in person with a tester's role changes one; no agent reaches it.

const STATUS = { draft: { tone: "info", label: "Draft", title: "Being written: not yet the copy of a finished file" }, ready: { tone: "ok", label: "Ready", title: "A person says this is the file as it is in the repo" } } as const;
const KIND: Record<SpecDetail["history"][number]["kind"], string> = { created: "Made", edited: "Text changed", renamed: "Renamed", status: "Status changed", case: "Test case changed" };

function StatusBadge({ status }: { status: SpecSummary["status"] }) {
  const s = STATUS[status];
  return <Badge tone={s.tone} icon={status === "ready" ? "circle-check" : "circle"} title={s.title}>{s.label}</Badge>;
}

/** What a person must know before they paste something here. */
function CopyNotice() {
  return (
    <div className="card" role="note" style={{ padding: 12, display: "flex", gap: 10, alignItems: "flex-start" }}>
      <ShieldAlert size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2, color: "var(--blocked-fg)" }} />
      <div>
        <strong>TestBench does not run this. Your repo is the source; this is a copy.</strong>
        <div className="muted" style={{ marginTop: 2 }}>
          Keep a copy of a spec here, with its history, link it to a test case, and download it. Do not paste passwords or tokens: the text is stored in TestBench's database and in its backups.
        </div>
      </div>
    </div>
  );
}

/** The Specs tab of Automated tests: the list, and the editor of one spec. */
export function SpecsPage() {
  const { pid } = useParams();
  const [params, setParams] = useSearchParams();
  const selected = Number(params.get("spec")) || null;
  const [creating, setCreating] = useState(false);
  const { data: specs } = useQuery({ queryKey: ["specs", pid], queryFn: () => api.get<SpecSummary[]>(`/api/projects/${pid}/specs`) });
  const open = (id: number | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set("spec", String(id)); else next.delete("spec");
    setParams(next);
  };
  return (
    <>
      <div className="topbar">
        <h1>Automated tests</h1>
        <ViewTabs view="specs" />
        <span className="spacer" />
        <Button needs="tester" variant="primary" onClick={() => setCreating(true)} title="Keep a copy of a spec from your repo, or write a new one"><Plus size={14} /> New spec</Button>
      </div>
      <div className="content">
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12, maxWidth: 980 }}>
          <CopyNotice />
          {selected ? (
            <SpecEditor key={selected} id={selected} onClose={() => open(null)} />
          ) : specs && specs.length === 0 ? (
            <Empty icon={<FileCode size={20} />} title="No specs yet" action={<Button needs="tester" variant="primary" onClick={() => setCreating(true)}><Plus size={14} /> New spec</Button>}>
              Paste a spec from your repo to keep a copy here, or write a new one. TestBench never runs it.
            </Empty>
          ) : (
            <div className="card">
              {specs?.map((s) => (
                <Link key={s.id} to={`/p/${pid}/automated?view=specs&spec=${s.id}`} className="list-row" style={{ minHeight: 54 }}>
                  <span className="faint" style={{ display: "grid" }}><FileCode size={15} aria-hidden="true" /></span>
                  <div className="grow" style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                      <span className="mono truncate" style={{ fontWeight: 500 }}>{s.fileName}</span>
                      <StatusBadge status={s.status} />
                      {s.testCase && <span className="chip" title="The test case this spec is about">{s.testCase.key}</span>}
                    </div>
                    <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>{formatBytes(s.size)} · updated {timeAgo(s.updatedAt)} by {s.updatedBy || "someone"}</div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
      {creating && <NewSpecModal onClose={() => setCreating(false)} onMade={(s) => { setCreating(false); open(s.id); }} />}
    </>
  );
}

/** The test cases a spec can be linked to, as a choice. */
function CaseSelect({ id, value, onChange, disabled }: { id: string; value: number | null; onChange: (v: number | null) => void; disabled?: boolean }) {
  const { pid } = useParams();
  const { data } = useQuery({ queryKey: ["cases", pid], queryFn: () => api.get<CaseSummary[]>(`/api/projects/${pid}/cases`) });
  return (
    <select id={id} className="select" value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">No test case</option>
      {(data ?? []).filter((c) => c.status !== "deprecated" || c.id === value).map((c) => <option key={c.id} value={c.id}>#{c.number} {c.title}</option>)}
    </select>
  );
}

/** How much of the 200 kB a text uses, and what is wrong with it, if anything. */
function TextMeter({ text }: { text: string }) {
  const bytes = textBytes(text);
  const problem = text ? specTextProblem(text) : null;
  return (
    <div className="faint" style={{ fontSize: "var(--fs-sm)", color: problem ? "var(--failed-fg)" : undefined }} role={problem ? "alert" : undefined}>
      {formatBytes(bytes)} of {SPEC_TEXT_MAX_BYTES / 1024} kB{problem ? `. ${problem}` : ""}
    </div>
  );
}

const MONO_AREA = { width: "100%", fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: "var(--fs-sm)", whiteSpace: "pre", overflowX: "auto" } as const;

function NewSpecModal({ onClose, onMade }: { onClose: () => void; onMade: (s: SpecDetail) => void }) {
  const { pid } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [fileName, setFileName] = useState("");
  const [status, setStatus] = useState<SpecSummary["status"]>("draft");
  const [caseId, setCaseId] = useState<number | null>(null);
  const [text, setText] = useState("");
  const nameProblem = fileName ? specNameProblem(fileName) : "Give the spec a file name, for example login.spec.ts";
  const textProblem = specTextProblem(text);
  const make = useMutation({
    mutationFn: () => api.post<SpecDetail>(`/api/projects/${pid}/specs`, { fileName: fileName.trim(), text, status, caseId }),
    onSuccess: (s) => { qc.invalidateQueries({ queryKey: ["specs", pid] }); toast("success", `${s.fileName} was added`); onMade(s); },
    onError: (e: Error) => toast("error", e.message),
  });
  return (
    <Modal
      title="New spec"
      onClose={onClose}
      width={760}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button needs="tester" variant="primary" disabled={!!nameProblem || !!textProblem || make.isPending} onClick={() => make.mutate()}>Add spec</Button>
        </>
      }
    >
      <EditScope>
        <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>
          <strong>TestBench does not run this. Your repo is the source; this is a copy.</strong> Do not paste passwords or tokens: the text is stored in TestBench's database and in its backups.
        </div>
        <div className="field">
          <label htmlFor="sp-name">File name</label>
          <input id="sp-name" className="input mono" placeholder="login.spec.ts" value={fileName} maxLength={120} autoFocus aria-invalid={!!fileName && !!nameProblem} onChange={(e) => setFileName(e.target.value)} />
          <span className="faint" style={{ fontSize: "var(--fs-sm)", color: fileName && nameProblem ? "var(--failed-fg)" : undefined }} role={fileName && nameProblem ? "alert" : undefined}>
            {fileName && nameProblem ? nameProblem : "A flat name that ends in .spec.ts, with no folder."}
          </span>
        </div>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div className="field" style={{ flex: "1 1 200px" }}>
            <label htmlFor="sp-status">Status</label>
            <select id="sp-status" className="select" value={status} onChange={(e) => setStatus(e.target.value as SpecSummary["status"])}>
              <option value="draft">Draft</option>
              <option value="ready">Ready</option>
            </select>
          </div>
          <div className="field" style={{ flex: "2 1 280px" }}>
            <label htmlFor="sp-case">Test case (optional)</label>
            <CaseSelect id="sp-case" value={caseId} onChange={setCaseId} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="sp-text">Spec text</label>
          <textarea id="sp-text" className="textarea" rows={16} wrap="off" spellCheck={false} style={MONO_AREA} value={text} onChange={(e) => setText(e.target.value)} placeholder={'import { test, expect } from "@playwright/test";'} />
          <TextMeter text={text} />
        </div>
      </EditScope>
    </Modal>
  );
}

function SpecEditor({ id, onClose }: { id: number; onClose: () => void }) {
  const { pid } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isError } = useQuery({ queryKey: ["spec", id], queryFn: () => api.get<SpecDetail>(`/api/specs/${id}`) });
  const [draft, setDraft] = useState<{ text?: string; status?: SpecSummary["status"]; caseId?: number | null }>({});
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["spec", id] }); qc.invalidateQueries({ queryKey: ["specs", pid] }); };
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<SpecDetail>(`/api/specs/${id}`, body),
    onSuccess: () => { setDraft({}); refresh(); toast("success", "Saved"); },
    onError: (e: Error) => toast("error", e.message),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/specs/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["specs", pid] }); toast("success", "The spec was deleted"); onClose(); },
    onError: (e: Error) => toast("error", e.message),
  });
  if (isError) return <div className="muted" role="alert">This spec is not there any more. <Button variant="ghost" size="sm" onClick={onClose}>Back to specs</Button></div>;
  if (!data) return <div className="muted">Loading…</div>;
  const text = draft.text ?? data.text;
  const status = draft.status ?? data.status;
  const caseId = draft.caseId === undefined ? data.testCase?.id ?? null : draft.caseId;
  const changes: Record<string, unknown> = {};
  if (draft.text !== undefined && draft.text !== data.text) changes.text = draft.text;
  if (draft.status !== undefined && draft.status !== data.status) changes.status = draft.status;
  if (draft.caseId !== undefined && draft.caseId !== (data.testCase?.id ?? null)) changes.caseId = draft.caseId;
  const dirty = Object.keys(changes).length > 0;
  const textProblem = specTextProblem(text);
  return (
    <div className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <Button variant="ghost" size="sm" onClick={() => (dirty ? setLeaving(true) : onClose())}>← Specs</Button>
        <h2 className="mono" style={{ margin: 0, fontSize: "var(--fs-lg)", overflowWrap: "anywhere" }}>{data.fileName}</h2>
        <StatusBadge status={data.status} />
        {dirty && <span className="chip" role="status">Unsaved changes</span>}
        <span className="spacer" />
        <Button needs="tester" size="sm" onClick={() => setRenaming(true)}><Pencil size={13} /> Rename</Button>
        <a className={buttonClass("secondary", "sm")} href={`/api/specs/${id}/file`} download={data.fileName}><Download size={13} /> Download</a>
        <Button needs="tester" size="sm" variant="ghost" onClick={() => setRemoving(true)} style={{ color: "var(--failed-fg)" }}><Trash2 size={13} /> Delete</Button>
      </div>
      <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>
        Made by {data.createdBy || "someone"} {timeAgo(data.createdAt)} · last changed by {data.updatedBy || "someone"} {timeAgo(data.updatedAt)} · {formatBytes(data.size)}
        {data.testCase && <> · <Link to={`/p/${pid}/cases?case=${data.testCase.id}`} style={{ color: "var(--accent-text)" }}>{data.testCase.key}</Link></>}
      </div>
      <EditScope>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div className="field" style={{ flex: "1 1 200px" }}>
            <label htmlFor="se-status">Status</label>
            <select id="se-status" className="select" value={status} onChange={(e) => setDraft({ ...draft, status: e.target.value as SpecSummary["status"] })}>
              <option value="draft">Draft</option>
              <option value="ready">Ready</option>
            </select>
          </div>
          <div className="field" style={{ flex: "2 1 280px" }}>
            <label htmlFor="se-case">Test case</label>
            <CaseSelect id="se-case" value={caseId} onChange={(v) => setDraft({ ...draft, caseId: v })} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="se-text">Spec text</label>
          <textarea id="se-text" className="textarea" rows={26} wrap="off" spellCheck={false} style={MONO_AREA} value={text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          <TextMeter text={text} />
        </div>
      </EditScope>
      <div className="row" style={{ gap: 8 }}>
        <Button needs="tester" variant="primary" disabled={!dirty || !!textProblem || save.isPending} onClick={() => save.mutate(changes)}>Save</Button>
        {dirty && <Button variant="ghost" onClick={() => setDraft({})}>Discard changes</Button>}
      </div>
      <details className="auto-history">
        <summary>History ({data.history.length})</summary>
        <ol>
          {[...data.history].reverse().map((h) => (
            <li key={h.rev}>
              <strong>{KIND[h.kind]}</strong> by {h.actor || "someone"} · {formatDateTime(h.at)}{h.note ? ` · ${h.note}` : ""}
            </li>
          ))}
        </ol>
      </details>
      {renaming && <RenameModal spec={data} onClose={() => setRenaming(false)} onDone={() => { setRenaming(false); refresh(); }} />}
      {removing && (
        <ConfirmModal title={`Delete ${data.fileName}?`} confirmLabel="Delete spec" busy={remove.isPending} onConfirm={() => remove.mutate()} onClose={() => setRemoving(false)}>
          <p style={{ margin: 0 }}>The copy in TestBench and its history are deleted. This cannot be undone. The file in your repo is not touched.</p>
        </ConfirmModal>
      )}
      {leaving && (
        <ConfirmModal title="Leave without saving?" confirmLabel="Leave" onConfirm={() => { setLeaving(false); onClose(); }} onClose={() => setLeaving(false)}>
          <p style={{ margin: 0 }}>Your changes to {data.fileName} are not saved.</p>
        </ConfirmModal>
      )}
    </div>
  );
}

function RenameModal({ spec, onClose, onDone }: { spec: SpecDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(spec.fileName);
  const problem = specNameProblem(name);
  const rename = useMutation({
    mutationFn: () => api.post<SpecDetail>(`/api/specs/${spec.id}/rename`, { fileName: name.trim() }),
    onSuccess: () => { toast("success", "Renamed"); onDone(); },
    onError: (e: Error) => toast("error", e.message),
  });
  return (
    <Modal
      title="Rename spec"
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button needs="tester" variant="primary" disabled={!!problem || name.trim() === spec.fileName || rename.isPending} onClick={() => rename.mutate()}>Rename</Button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="sp-rename">File name</label>
        <input id="sp-rename" className="input mono" value={name} maxLength={120} autoFocus aria-invalid={!!problem} onChange={(e) => setName(e.target.value)} />
        <span className="faint" style={{ fontSize: "var(--fs-sm)", color: problem ? "var(--failed-fg)" : undefined }} role={problem ? "alert" : undefined}>{problem ?? "A flat name that ends in .spec.ts, with no folder."}</span>
      </div>
    </Modal>
  );
}
