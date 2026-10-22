import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { api, timeAgo, type RunTemplate } from "../api";
import { CasePicker, useRunnableCases } from "../components/CasePicker";
import { Empty, Modal, useToast } from "../components/ui";

export function useTemplates() {
  const { pid } = useParams();
  return useQuery({ queryKey: ["templates", pid], queryFn: () => api.get<RunTemplate[]>(`/api/projects/${pid}/templates`) });
}

export function TemplatesPanel({ templates, onStart, onEdit, onNew }: { templates: RunTemplate[]; onStart: (t: RunTemplate) => void; onEdit: (t: RunTemplate) => void; onNew: () => void }) {
  const { pid } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const runnable = useRunnableCases();
  const runnableIds = new Set(runnable.map((c) => c.id));

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/templates/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["templates", pid] });
      qc.invalidateQueries({ queryKey: ["runs", pid] });
    },
    onError: (e: Error) => toast("error", e.message),
  });

  if (templates.length === 0) {
    return (
      <Empty
        icon={<ClipboardList size={20} />}
        title="No run templates yet"
        action={<button className="btn primary" onClick={onNew}><Plus size={14} /> New template</button>}
      >
        A template is a saved set of cases, like “Smoke test” or “Release regression”. Start a run from it in one click instead of ticking the same cases every sprint.
      </Empty>
    );
  }

  return (
    <>
      {templates.map((t) => {
        const count = t.caseIds.filter((id) => runnableIds.has(id)).length;
        return (
          <div key={t.id} className="list-row" style={{ height: 58, cursor: "default" }}>
            <ClipboardList size={15} className="faint" />
            <div className="grow col" style={{ gap: 2 }}>
              <div className="row" style={{ gap: 8 }}>
                <span className="truncate" style={{ fontWeight: 500 }}>{t.name}</span>
                {t.environment && <span className="chip">{t.environment}</span>}
              </div>
              <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
                {count} {count === 1 ? "case" : "cases"} · {t.last_used ? `last used ${timeAgo(t.last_used)} · ${t.run_count} ${t.run_count === 1 ? "run" : "runs"}` : "never used"}
              </span>
            </div>
            <button className="btn sm primary" disabled={count === 0} onClick={() => onStart(t)} title={count === 0 ? "This template has no runnable cases" : undefined}>
              <Play size={12} /> Start run
            </button>
            <button className="btn ghost icon sm" onClick={() => onEdit(t)} aria-label={`Edit ${t.name}`} title="Edit"><Pencil size={13} /></button>
            <button
              className="btn ghost icon sm danger"
              onClick={() => confirm(`Delete template "${t.name}"? Runs already started from it are kept.`) && remove.mutate(t.id)}
              aria-label={`Delete ${t.name}`}
              title="Delete"
            >
              <Trash2 size={13} />
            </button>
          </div>
        );
      })}
    </>
  );
}

/** Create a template, or edit an existing one. `initialCaseIds` pre-selects cases for a new template. */
export function TemplateModal({ template, initialCaseIds = [], onClose }: { template?: RunTemplate; initialCaseIds?: number[]; onClose: () => void }) {
  const { pid } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const runnable = useRunnableCases();
  const [name, setName] = useState(template?.name ?? "");
  const [environment, setEnvironment] = useState(template?.environment ?? "");
  const [selected, setSelected] = useState<Set<number>>(() => new Set(template ? template.caseIds : initialCaseIds));
  const runnableIds = new Set(runnable.map((c) => c.id));
  const count = [...selected].filter((id) => runnableIds.has(id)).length;

  const save = useMutation({
    mutationFn: () => {
      const body = { name, environment, caseIds: [...selected].filter((id) => runnableIds.has(id)) };
      return template ? api.patch<RunTemplate>(`/api/templates/${template.id}`, body) : api.post<RunTemplate>(`/api/projects/${pid}/templates`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["templates", pid] });
      onClose();
    },
    onError: (e: Error) => toast("error", e.message),
  });

  return (
    <Modal
      title={template ? "Edit template" : "New template"}
      onClose={onClose}
      width={680}
      footer={
        <>
          <span className="muted" style={{ marginRight: "auto" }}>{count} of {runnable.length} cases</span>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!name.trim() || count === 0 || save.isPending} onClick={() => save.mutate()}>
            {template ? "Save changes" : "Create template"}
          </button>
        </>
      }
    >
      <input className="bare title-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name, e.g. Smoke test" aria-label="Template name" autoFocus />
      <div className="field">
        <label htmlFor="tenv">Default environment (optional)</label>
        <input id="tenv" className="input" placeholder="staging, prod…" value={environment} onChange={(e) => setEnvironment(e.target.value)} />
      </div>
      <CasePicker selected={selected} onChange={setSelected} />
    </Modal>
  );
}
