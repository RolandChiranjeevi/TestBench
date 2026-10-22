import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, BookOpenCheck, Bot, Copy, Link2, Check, ChevronsUpDown, CircleDot, Folder, Loader2, Plus, Trash2, X } from "lucide-react";
import { api, timeAgo, type CaseDetail, type Priority, type Requirement, type Suite } from "../api";
import { FrameworkBadge, Modal, PriorityIcon, PRIORITY_LABEL, StatusIcon, useToast } from "../components/ui";

interface DraftStep { uid: string; id?: number; action: string; expected: string }
interface Draft {
  title: string;
  description: string;
  preconditions: string;
  priority: Priority;
  status: CaseDetail["status"];
  suiteId: number | null;
  tags: string[];
  steps: DraftStep[];
}

let uidSeq = 0;
const uid = () => `s${++uidSeq}`;
const autoSize = { fieldSizing: "content" } as CSSProperties;

const toDraft = (c: CaseDetail): Draft => ({
  title: c.title,
  description: c.description,
  preconditions: c.preconditions,
  priority: c.priority,
  status: c.status,
  suiteId: c.suite_id,
  tags: c.tags,
  steps: c.steps.map((s) => ({ uid: uid(), id: s.id, action: s.action, expected: s.expected })),
});

/** Autosaving case editor. Saves are serialised so newly created steps get their ids before the next save. */
export function CaseEditor({ caseId, suites, onClose, onDeleted, onDuplicated }: { caseId: number; suites: Suite[]; onClose: () => void; onDeleted: () => void; onDuplicated?: (id: number) => void }) {
  const { pid } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ["case", caseId], queryFn: () => api.get<CaseDetail>(`/api/cases/${caseId}`) });

  const [linkingReqs, setLinkingReqs] = useState(false);
  const [draft, setDraftState] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const dirty = useRef(false);
  const focusStep = useRef<string | null>(null);

  const setDraft = (d: Draft) => {
    draftRef.current = d;
    setDraftState(d);
  };

  useEffect(() => {
    if (data && !draftRef.current) setDraft(toDraft(data));
  }, [data]);

  const doSave = async () => {
    const snapshot = draftRef.current;
    if (!snapshot || !dirty.current) return;
    dirty.current = false;
    setSaveState("saving");
    try {
      const saved = await api.patch<CaseDetail>(`/api/cases/${caseId}`, {
        title: snapshot.title.trim() || "Untitled case",
        description: snapshot.description,
        preconditions: snapshot.preconditions,
        priority: snapshot.priority,
        status: snapshot.status,
        suiteId: snapshot.suiteId,
        tags: snapshot.tags,
        steps: snapshot.steps.map(({ id, action, expected }) => ({ id, action, expected })),
      });
      // Give newly inserted steps their server ids (matched by position in the snapshot).
      const idByUid = new Map(snapshot.steps.map((s, i) => [s.uid, saved.steps[i]?.id]));
      const cur = draftRef.current!;
      setDraft({ ...cur, steps: cur.steps.map((s) => (s.id ? s : { ...s, id: idByUid.get(s.uid) })) });
      qc.setQueryData(["case", caseId], saved);
      qc.invalidateQueries({ queryKey: ["cases", pid] });
      qc.invalidateQueries({ queryKey: ["suites", pid] });
      setSaveState(dirty.current ? "saving" : "saved");
    } catch (e) {
      dirty.current = true;
      setSaveState("error");
      toast("error", `Couldn't save: ${(e as Error).message}`);
    }
  };

  const flushRef = useRef(() => {});
  flushRef.current = () => {
    clearTimeout(timer.current);
    queue.current = queue.current.then(doSave);
  };

  const update = (patch: Partial<Draft>, immediate = false) => {
    if (!draftRef.current) return;
    setDraft({ ...draftRef.current, ...patch });
    dirty.current = true;
    setSaveState("saving");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => flushRef.current(), immediate ? 0 : 600);
  };

  // Save whatever is pending when the panel closes or switches case.
  useEffect(() => () => flushRef.current(), []);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".overlay")) {
        (document.activeElement as HTMLElement | null)?.blur();
        onCloseRef.current();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        flushRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Focus a newly added step once it has rendered.
  useEffect(() => {
    if (!focusStep.current) return;
    document.querySelector<HTMLTextAreaElement>(`[data-step="${focusStep.current}"]`)?.focus();
    focusStep.current = null;
  }, [draft?.steps.length]);

  if (!data || !draft) {
    return (
      <div className="row muted" style={{ padding: 24 }}>
        <Loader2 size={14} className="spin" /> Loading…
      </div>
    );
  }

  const setStep = (i: number, patch: Partial<DraftStep>) => update({ steps: draft.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const moveStep = (i: number, dir: -1 | 1) => {
    const steps = [...draft.steps];
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    update({ steps }, true);
  };
  const addStep = () => {
    const step = { uid: uid(), action: "", expected: "" };
    focusStep.current = step.uid;
    update({ steps: [...draft.steps, step] }, true);
  };

  const remove = async () => {
    if (!confirm(`Delete ${data.project_key}-${data.number}? Past run results are kept but lose their link to this case.`)) return;
    clearTimeout(timer.current);
    dirty.current = false;
    await api.del(`/api/cases/${caseId}`);
    qc.invalidateQueries({ queryKey: ["cases", pid] });
    qc.invalidateQueries({ queryKey: ["suites", pid] });
    qc.invalidateQueries({ queryKey: ["projects"] });
    toast("success", `Deleted ${data.project_key}-${data.number}`);
    onDeleted();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      <div className="topbar" style={{ position: "sticky", top: 0, background: "var(--bg)", zIndex: 2 }}>
        <span className="mono muted">{data.project_key}-{data.number}</span>
        <span className="faint" style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}>
          {saveState === "saving" && <><Loader2 size={12} className="spin" /> Saving</>}
          {saveState === "saved" && <><Check size={12} /> Saved</>}
          {saveState === "error" && <span style={{ color: "var(--failed-fg)" }}>Not saved</span>}
        </span>
        <span className="spacer" />
        <button
          className="btn ghost icon sm"
          title="Duplicate as a draft"
          aria-label="Duplicate case"
          onClick={async () => {
            try {
              const copy = await api.post<CaseDetail>(`/api/cases/${caseId}/duplicate`);
              for (const k of ["cases", "suites", "projects"]) qc.invalidateQueries({ queryKey: [k] });
              toast("success", `Created ${copy.project_key}-${copy.number} as a draft copy`);
              onDuplicated?.(copy.id);
            } catch (e) {
              toast("error", (e as Error).message);
            }
          }}
        >
          <Copy size={14} />
        </button>
        <button className="btn ghost icon sm danger" onClick={remove} title="Delete case" aria-label="Delete case">
          <Trash2 size={14} />
        </button>
        <button className="btn ghost icon sm" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <X size={14} />
        </button>
      </div>

      <div style={{ padding: "20px 28px 40px", display: "flex", flexDirection: "column", gap: 18 }}>
        <textarea
          className="bare title-input"
          rows={1}
          value={draft.title}
          placeholder="Case title"
          onChange={(e) => update({ title: e.target.value.replace(/\n/g, " ") })}
          aria-label="Title"
        />

        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          <label className="pill" title="Suite">
            <Folder size={13} />
            {suites.find((s) => s.id === draft.suiteId)?.name ?? "No suite"}
            <select value={draft.suiteId ?? ""} onChange={(e) => update({ suiteId: e.target.value ? Number(e.target.value) : null }, true)} aria-label="Suite">
              <option value="">No suite</option>
              {suites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="pill" title="Priority">
            <PriorityIcon priority={draft.priority} />
            {PRIORITY_LABEL[draft.priority]}
            <select value={draft.priority} onChange={(e) => update({ priority: e.target.value as Priority }, true)} aria-label="Priority">
              {(["critical", "high", "medium", "low"] as const).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
          </label>
          <label className="pill" title="Status">
            <CircleDot size={13} style={{ color: draft.status === "ready" ? "var(--passed-fg)" : draft.status === "draft" ? "var(--text-3)" : "var(--failed-fg)" }} />
            {draft.status[0].toUpperCase() + draft.status.slice(1)}
            <ChevronsUpDown size={11} className="faint" />
            <select value={draft.status} onChange={(e) => update({ status: e.target.value as Draft["status"] }, true)} aria-label="Status">
              <option value="draft">Draft</option>
              <option value="ready">Ready</option>
              <option value="deprecated">Deprecated</option>
            </select>
          </label>
          <TagInput tags={draft.tags} onChange={(tags) => update({ tags }, true)} />
        </div>

        <section>
          <div className="section-label">Description</div>
          <textarea
            className="bare"
            style={{ minHeight: 44, ...autoSize }}
            value={draft.description}
            placeholder="What does this case verify?"
            onChange={(e) => update({ description: e.target.value })}
            aria-label="Description"
          />
        </section>

        <section>
          <div className="section-label">Preconditions</div>
          <textarea
            className="bare"
            style={{ minHeight: 22, ...autoSize }}
            value={draft.preconditions}
            placeholder="Setup or data needed before step 1"
            onChange={(e) => update({ preconditions: e.target.value })}
            aria-label="Preconditions"
          />
        </section>

        <section>
          <div className="section-label">
            Steps <span className="faint">{draft.steps.length}</span>
          </div>
          {draft.steps.length > 0 && (
            <div className="steps">
              <div className="steps-head">
                <div />
                <div>Action</div>
                <div style={{ borderLeft: "1px solid var(--border)" }}>Expected result</div>
              </div>
              {draft.steps.map((s, i) => (
                <div className="step" key={s.uid}>
                  <div className="step-num">{i + 1}</div>
                  <textarea
                    data-step={s.uid}
                    rows={1}
                    value={s.action}
                    placeholder="Do something…"
                    onChange={(e) => setStep(i, { action: e.target.value })}
                    aria-label={`Step ${i + 1} action`}
                  />
                  <textarea
                    rows={1}
                    value={s.expected}
                    placeholder="Expect…"
                    onChange={(e) => setStep(i, { expected: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        addStep();
                      }
                    }}
                    aria-label={`Step ${i + 1} expected result`}
                  />
                  <div className="step-actions">
                    <button className="btn ghost icon sm" onClick={() => moveStep(i, -1)} disabled={i === 0} aria-label="Move up"><ArrowUp size={12} /></button>
                    <button className="btn ghost icon sm" onClick={() => moveStep(i, 1)} disabled={i === draft.steps.length - 1} aria-label="Move down"><ArrowDown size={12} /></button>
                    <button className="btn ghost icon sm danger" onClick={() => update({ steps: draft.steps.filter((_, j) => j !== i) }, true)} aria-label="Delete step"><Trash2 size={12} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={addStep}>
            <Plus size={13} /> Add step {draft.steps.length > 0 && <span className="kbd">⌘↵</span>}
          </button>
        </section>

        <section>
          <div className="section-label">
            <BookOpenCheck size={13} /> Requirements <span className="faint">{data.requirements.length}</span>
          </div>
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            {data.requirements.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>Not linked to a requirement.</span>}
            {data.requirements.map((r) => (
              <Link key={r.id} to={`/p/${pid}/requirements?req=${r.id}`} className="chip" title={r.review_needed ? `${r.title} (reworded, review needed)` : r.title} style={{ textDecoration: r.status === "deprecated" ? "line-through" : undefined, borderColor: r.review_needed ? "var(--blocked)" : undefined }}>
                {r.review_needed && <span className="dot" style={{ background: "var(--blocked)" }} />}REQ-{r.number} <span className="truncate" style={{ maxWidth: 200 }}>{r.title}</span>
              </Link>
            ))}
            <button className="btn ghost sm" onClick={() => setLinkingReqs(true)}><Link2 size={13} /> Link</button>
          </div>
          {data.requirements.filter((r) => r.review_needed).map((r) => (
            <div key={r.id} className="row" style={{ marginTop: 8, fontSize: 12.5, color: "var(--blocked-fg)" }}>
              <span className="grow">REQ-{r.number} was reworded after this case was linked. Check the case still fits.</span>
              <button className="btn sm" onClick={async () => {
                await api.post(`/api/requirements/${r.id}/review`, { caseIds: [caseId] });
                for (const k of ["case", "requirements", "requirement"]) qc.invalidateQueries({ queryKey: [k] });
              }}>Still correct</button>
            </div>
          ))}
        </section>

        <section>
          <div className="section-label">
            <Bot size={13} /> Automation <span className="faint">{data.automated.length}</span>
          </div>
          {data.automated.length === 0 ? (
            <div className="muted" style={{ fontSize: 12.5 }}>
              Not automated. Put <code className="inline">@{data.project_key}-{data.number}</code> in a test title, or link a test from{" "}
              <Link to={`/p/${pid}/automated`} style={{ color: "var(--accent-text)" }}>Automated tests</Link>.
            </div>
          ) : (
            <div className="card">
              {data.automated.map((a) => (
                <div key={a.id} className="row" style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
                  <StatusIcon status={a.last_status} />
                  <span className="truncate grow" title={a.full_name}>{a.title}</span>
                  <span className="faint truncate mono" style={{ maxWidth: 180 }}>{a.file}</span>
                  <FrameworkBadge framework={a.framework} />
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="section-label">History</div>
          {data.history.length === 0 ? (
            <div className="muted" style={{ fontSize: 12.5 }}>Not executed yet.</div>
          ) : (
            <div className="col" style={{ gap: 0 }}>
              {data.history.map((h) => (
                <Link key={h.id} to={`/p/${pid}/runs/${h.run_id}`} className="row" style={{ height: 30, color: "var(--text-2)" }}>
                  <StatusIcon status={h.status} flaky={!!h.flaky} />
                  {h.kind === "automated" ? <Bot size={13} className="faint" /> : null}
                  <span className="truncate grow">{h.run_title}</span>
                  <span className="faint" style={{ fontSize: 12 }}>{timeAgo(h.executed_at ?? h.started_at)}</span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
      {linkingReqs && <LinkRequirementsModal caseId={caseId} projectId={Number(pid)} current={data.requirements.map((r) => r.id)} onClose={() => setLinkingReqs(false)} />}
    </div>
  );
}

/** Pick the requirements a case covers. Saved as a whole list, like the link editor on the requirement side. */
function LinkRequirementsModal({ caseId, projectId, current, onClose }: { caseId: number; projectId: number; current: number[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: reqs = [] } = useQuery({ queryKey: ["requirements", String(projectId)], queryFn: () => api.get<Requirement[]>(`/api/projects/${projectId}/requirements`) });
  const [selected, setSelected] = useState(new Set(current));
  const [saving, setSaving] = useState(false);
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/api/cases/${caseId}/requirements`, { requirementIds: [...selected] });
      for (const k of ["case", "cases", "requirements", "requirement", "dashboard"]) qc.invalidateQueries({ queryKey: [k] });
      onClose();
    } catch (e) {
      toast("error", (e as Error).message);
      setSaving(false);
    }
  };
  return (
    <Modal title="Link requirements" onClose={onClose} width={520} footer={<button className="btn primary" disabled={saving} onClick={save}>Save {selected.size} linked</button>}>
      {reqs.length === 0 ? (
        <div className="muted">No requirements yet. Add some on the Requirements page first.</div>
      ) : (
        <div className="card" style={{ maxHeight: 340, overflow: "auto" }}>
          {reqs.filter((r) => r.status !== "deprecated" || selected.has(r.id)).map((r) => (
            <label key={r.id} className="list-row" style={{ height: 32, padding: "0 12px" }}>
              <input type="checkbox" className="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
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

function TagInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [value, setValue] = useState("");
  const add = () => {
    const t = value.trim().replace(/,$/, "");
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setValue("");
  };
  return (
    <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
      {tags.map((t) => (
        <span key={t} className="chip">
          {t}
          <button className="bare" style={{ width: "auto", cursor: "pointer", display: "grid" }} onClick={() => onChange(tags.filter((x) => x !== t))} aria-label={`Remove tag ${t}`}>
            <X size={10} />
          </button>
        </span>
      ))}
      <input
        className="bare"
        style={{ width: 90, height: 26, fontSize: 12.5 }}
        value={value}
        placeholder="+ Add tag"
        onChange={(e) => setValue(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !value && tags.length) {
            onChange(tags.slice(0, -1));
          }
        }}
        aria-label="Add tag"
      />
    </div>
  );
}
