import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { api, timeAgo, type RunTemplate, type Suite } from "../api";
import { casesInFolder } from "../folders";
import { CasePicker, useRunnableCases } from "../components/CasePicker";
import { Empty, Modal, useToast } from "../components/ui";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";

// A run template is what the app calls a SUITE: a saved list of cases that is run as a unit, as a manual run. (The tree on the Test cases page is made of FOLDERS,
// which only organise cases.) The table and the routes keep the old name, so these components keep it too.

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
        title="No suites yet"
        action={<Button needs="tester" variant="primary" onClick={onNew}><Plus size={14} /> New suite</Button>}
      >
        A suite is a saved list of test cases, like “Smoke test” or “Release regression”. Start a run from it in one click instead of ticking the same cases every sprint.
        Folders on the Test cases page only organise cases; a suite is what you run.
      </Empty>
    );
  }

  return (
    <>
      {templates.map((t) => {
        const count = t.caseIds.filter((id) => runnableIds.has(id)).length;
        const lr = t.last_run;
        return (
          <div key={t.id} className="list-row" style={{ height: "auto", minHeight: 58, padding: "8px 16px", cursor: "default" }} data-suite={t.name}>
            <ClipboardList size={15} className="faint" />
            <div className="grow col" style={{ gap: 2, minWidth: 0 }}>
              <div className="row" style={{ gap: 8 }}>
                <span className="truncate" style={{ fontWeight: 500 }}>{t.name}</span>
                {t.environment && <span className="chip">{t.environment}</span>}
              </div>
              {t.description && <span className="muted truncate" style={{ fontSize: "var(--fs-sm)" }}>{t.description}</span>}
              <span className="faint row" style={{ fontSize: "var(--fs-sm)", gap: 6, flexWrap: "wrap" }}>
                <span>{count} {count === 1 ? "case" : "cases"}</span>
                <span>·</span>
                {lr ? (
                  <>
                    <span>
                      last run <Link to={`/p/${pid}/runs/${lr.id}`} style={{ color: "var(--accent-text)" }}>{timeAgo(lr.started_at)}</Link>:
                    </span>
                    <span style={{ color: "var(--passed-fg)" }}>{lr.passed} passed</span>
                    <span>·</span>
                    <span style={{ color: lr.failed ? "var(--failed-fg)" : undefined }}>{lr.failed} failed</span>
                    {lr.blocked > 0 && <><span>·</span><span style={{ color: "var(--blocked-fg)" }}>{lr.blocked} blocked</span></>}
                    {lr.untested > 0 && <><span>·</span><span>{lr.untested} not run</span></>}
                    {lr.status === "in_progress" && <Badge tone="accent" icon="eye">In progress</Badge>}
                    <span>·</span>
                    <span>{t.run_count} {t.run_count === 1 ? "run" : "runs"}</span>
                  </>
                ) : (
                  <span>never run</span>
                )}
              </span>
            </div>
            <Button needs="tester" variant="primary" size="sm" disabled={count === 0} onClick={() => onStart(t)} aria-label={`Run ${t.name}`} title={count === 0 ? "This suite has no runnable cases" : "Start a manual run of this suite"}>
              <Play size={12} /> Run
            </Button>
            <Button needs="tester" variant="ghost" size="sm" icon onClick={() => onEdit(t)} aria-label={`Edit ${t.name}`} title="Edit"><Pencil size={13} /></Button>
            <Button needs="admin" variant="danger" size="sm" icon
              onClick={() => confirm(`Delete suite "${t.name}"? Runs already started from it are kept.`) && remove.mutate(t.id)}
              aria-label={`Delete ${t.name}`}
              title="Delete"
            >
              <Trash2 size={13} />
            </Button>
          </div>
        );
      })}
    </>
  );
}

/** Create a suite, or edit an existing one: its name, description, default environment and cases. `initialCaseIds` pre-selects cases for a new suite. */
export function TemplateModal({ template, initialCaseIds = [], onClose }: { template?: RunTemplate; initialCaseIds?: number[]; onClose: () => void }) {
  const { pid } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const runnable = useRunnableCases();
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [environment, setEnvironment] = useState(template?.environment ?? "");
  const [selected, setSelected] = useState<Set<number>>(() => new Set(template ? template.caseIds : initialCaseIds));
  const runnableIds = new Set(runnable.map((c) => c.id));
  const count = [...selected].filter((id) => runnableIds.has(id)).length;

  const save = useMutation({
    mutationFn: () => {
      const body = { name, description, environment, caseIds: [...selected].filter((id) => runnableIds.has(id)) };
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
      title={template ? "Edit suite" : "New suite"}
      onClose={onClose}
      width={680}
      footer={
        <>
          <span className="muted" style={{ marginRight: "auto" }}>{count} of {runnable.length} cases</span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button needs="tester" variant="primary" disabled={!name.trim() || count === 0 || save.isPending} onClick={() => save.mutate()}>
            {template ? "Save changes" : "Create suite"}
          </Button>
        </>
      }
    >
      <input className="bare title-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Suite name, e.g. Smoke test" aria-label="Suite name" autoFocus />
      <div className="field">
        <label htmlFor="tdesc">Description (optional)</label>
        <textarea id="tdesc" className="textarea" rows={2} placeholder="What it is for, and when to run it" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="tenv">Default environment (optional)</label>
        <input id="tenv" className="input" placeholder="staging, prod…" value={environment} onChange={(e) => setEnvironment(e.target.value)} />
      </div>
      <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>
        Tick the cases in the suite. A run takes them in the order of the case list. The chip on each case shows whether an automated test is linked to it; the suite is run by hand, and nothing is started automatically.
      </div>
      <CasePicker selected={selected} onChange={setSelected} />
    </Modal>
  );
}

/** Save the cases of a folder (and by default its subfolders) as a new suite. It is a copy: later changes to the folder do not change the suite. */
export function FolderToSuiteModal({ folder, onClose }: { folder: Suite; onClose: () => void }) {
  const { pid } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const runnable = useRunnableCases();
  const { data: folders = [] } = useQuery({ queryKey: ["suites", pid], queryFn: () => api.get<Suite[]>(`/api/projects/${pid}/suites`) });
  const [name, setName] = useState(folder.name);
  const [include, setInclude] = useState(true);
  const hasSub = folders.some((f) => f.parent_id === folder.id);
  const count = casesInFolder(runnable, folders, folder.id, include).length;

  const save = useMutation({
    mutationFn: () => api.post<RunTemplate>(`/api/projects/${pid}/templates/from-folder`, { folderId: folder.id, name, includeSubfolders: include }),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ["templates", pid] });
      toast("success", `Suite “${t.name}” saved with ${t.caseIds.length} ${t.caseIds.length === 1 ? "case" : "cases"}`);
      onClose();
      navigate(`/p/${pid}/runs?kind=suites`);
    },
    onError: (e: Error) => toast("error", e.message),
  });

  return (
    <Modal
      title={`Save folder “${folder.name}” as a suite`}
      onClose={onClose}
      width={520}
      footer={
        <>
          <span className="muted" style={{ marginRight: "auto" }}>{count} {count === 1 ? "case" : "cases"}</span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button needs="tester" variant="primary" disabled={!name.trim() || count === 0 || save.isPending} onClick={() => save.mutate()}>Create suite</Button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="f2s-name">Suite name</label>
        <input id="f2s-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      {hasSub && (
        <label className="row muted" style={{ fontSize: "var(--fs-md)", cursor: "pointer" }}>
          <input type="checkbox" className="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} /> Include the cases in subfolders
        </label>
      )}
      <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>
        The suite gets a copy of the cases the folder holds now. Cases added to the folder later are not added to the suite, and the folder is left as it is.
        {count === 0 && " This folder has no cases that can be run."}
      </div>
    </Modal>
  );
}
