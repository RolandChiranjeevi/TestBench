import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Download, GitBranch, Hand, Play, Plus } from "lucide-react";
import { api, formatDuration, passRate, timeAgo, type Milestone, type RunSummary, type RunTemplate } from "../api";
import { CasePicker, useRunnableCases } from "../components/CasePicker";
import { Empty, FrameworkBadge, Github, Kbd, Modal, ProgressBar, useHotkeys, useToast } from "../components/ui";
import { TemplateModal, TemplatesPanel, useTemplates } from "./Templates";

type Kind = "all" | "manual" | "automated" | "templates";

export function RunsPage() {
  const { pid } = useParams();
  const navigate = useNavigate();
  const [kind, setKind] = useState<Kind>("all");
  const [creating, setCreating] = useState(false);
  const [startFrom, setStartFrom] = useState<RunTemplate | null>(null);
  const [editing, setEditing] = useState<RunTemplate | "new" | null>(null);
  const { data: runs, isLoading } = useQuery({ queryKey: ["runs", pid], queryFn: () => api.get<RunSummary[]>(`/api/projects/${pid}/runs`) });
  const { data: templates = [] } = useTemplates();

  useHotkeys({ c: () => setCreating(true) });

  const visible = (runs ?? []).filter((r) => kind === "all" || r.kind === kind);
  const count = (k: Kind) => (k === "templates" ? templates.length : (runs ?? []).filter((r) => k === "all" || r.kind === k).length);

  return (
    <>
      <div className="topbar">
        <h1>Runs</h1>
        <span className="spacer" />
        <button className="btn" onClick={() => navigate(`/p/${pid}/import`)}>
          <Download size={14} /> Import results
        </button>
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Plus size={14} /> New manual run <Kbd>C</Kbd>
        </button>
      </div>
      <div className="toolbar">
        <div className="tabs" role="tablist">
          {(["all", "manual", "automated", "templates"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={kind === k} className={`tab${kind === k ? " active" : ""}`} onClick={() => setKind(k)}>
              {{ all: "All runs", manual: "Manual", automated: "Automated", templates: "Templates" }[k]} <span className="count">{count(k)}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        {kind === "templates" && templates.length > 0 && (
          <button className="btn sm" onClick={() => setEditing("new")}><Plus size={13} /> New template</button>
        )}
      </div>
      <div className="content">
        {kind === "templates" ? (
          <TemplatesPanel templates={templates} onStart={setStartFrom} onEdit={setEditing} onNew={() => setEditing("new")} />
        ) : isLoading ? null : visible.length === 0 ? (
          <Empty
            icon={<Play size={20} />}
            title="No runs yet"
            action={
              <div className="row">
                <button className="btn primary" onClick={() => setCreating(true)}><Plus size={14} /> New manual run</button>
                <button className="btn" onClick={() => navigate(`/p/${pid}/import`)}><Download size={14} /> Import results</button>
              </div>
            }
          >
            Start a manual run from your test cases, or import Playwright, TestCafe or Selenium results.
          </Empty>
        ) : (
          visible.map((r) => <RunRow key={r.id} run={r} />)
        )}
      </div>
      {creating && <NewRunModal onClose={() => setCreating(false)} />}
      {startFrom && <NewRunModal template={startFrom} onClose={() => setStartFrom(null)} />}
      {editing && <TemplateModal template={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function RunRow({ run }: { run: RunSummary }) {
  const { pid } = useParams();
  const rate = passRate(run);
  const done = run.total - run.untested;
  return (
    <Link to={`/p/${pid}/runs/${run.id}`} className="list-row" style={{ height: 54 }}>
      <span className="faint" title={run.kind === "manual" ? "Manual run" : "Automated run"} style={{ display: "grid" }}>
        {run.kind === "manual" ? <Hand size={15} /> : run.source === "github" ? <Github size={15} /> : <Bot size={15} />}
      </span>
      <div className="grow" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div className="row" style={{ gap: 8 }}>
          <span className="truncate" style={{ fontWeight: 500 }}>{run.title}</span>
          {run.kind === "manual" && run.status === "in_progress" && <span className="chip accent">In progress</span>}
          {run.flaky > 0 && <span className="chip" style={{ color: "var(--flaky-fg)" }}>{run.flaky} flaky</span>}
        </div>
        <div className="row faint" style={{ gap: 8, fontSize: 12 }}>
          <span>{timeAgo(run.started_at)}</span>
          {run.environment && (<><span>·</span><span className="row" style={{ gap: 4 }}>{run.source === "github" && <GitBranch size={11} />}{run.environment}</span></>)}
          {run.milestone && (<><span>·</span><span>{run.milestone}</span></>)}
          {run.kind === "automated" && run.duration_ms > 0 && (<><span>·</span><span>{formatDuration(run.duration_ms)}</span></>)}
        </div>
      </div>
      <span className="meta">
        <FrameworkBadge framework={run.framework} />
      </span>
      <div className="run-counts">
        <ProgressBar counts={run} />
        <div className="row faint tabular" style={{ fontSize: 11.5, justifyContent: "space-between" }}>
          <span>
            <span style={{ color: "var(--passed-fg)" }}>{run.passed} passed</span> · <span style={{ color: run.failed ? "var(--failed-fg)" : undefined }}>{run.failed} failed</span>
            {run.blocked > 0 && <> · <span style={{ color: "var(--blocked-fg)" }}>{run.blocked} blocked</span></>}
            {run.skipped > 0 && <> · {run.skipped} skipped</>}
          </span>
          <span>{run.kind === "manual" ? `${done}/${run.total} run` : `${run.total} tests`}</span>
        </div>
      </div>
      <span
        className="tabular"
        title="Pass rate of executed tests"
        style={{ width: 44, textAlign: "right", fontWeight: 600, color: rate == null ? "var(--text-4)" : rate >= 90 ? "var(--passed-fg)" : rate >= 70 ? "var(--blocked-fg)" : "var(--failed-fg)" }}
      >
        {rate == null ? "—" : `${rate}%`}
      </span>
    </Link>
  );
}

/** Start a manual run. Cases can be picked by hand, taken from a template, or both; the selection can be saved as a new template. */
export function NewRunModal({ initialCaseIds = [], initialTitle, template, rerunOf, onClose, onCreated }: {
  initialCaseIds?: number[];
  /** Suggested run name, e.g. when starting from a requirement. */
  initialTitle?: string;
  template?: RunTemplate;
  /** Re-test the failures of this run: its title, environment and sprint are carried over. */
  rerunOf?: { id: number; title: string; environment: string; milestone: string };
  onClose: () => void;
  onCreated?: () => void;
}) {
  const { pid } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: milestones = [] } = useQuery({ queryKey: ["milestones", pid], queryFn: () => api.get<Milestone[]>(`/api/projects/${pid}/milestones`) });
  const { data: templates = [] } = useTemplates();
  const runnable = useRunnableCases();

  const today = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const defaultTitle = (name?: string) => `${name ?? "Regression"} · ${today}`;
  const [templateId, setTemplateId] = useState<number | null>(template?.id ?? null);
  const [title, setTitle] = useState(rerunOf ? `Re-run: ${rerunOf.title}` : initialTitle ?? defaultTitle(template?.name));
  const [titleEdited, setTitleEdited] = useState(false);
  const [environment, setEnvironment] = useState(template?.environment ?? rerunOf?.environment ?? "");
  const [milestone, setMilestone] = useState(rerunOf?.milestone ?? "");
  const [selected, setSelected] = useState<Set<number>>(() => new Set(template ? template.caseIds : initialCaseIds));
  const [saveAs, setSaveAs] = useState(false);
  const [saveName, setSaveName] = useState("");

  // Deprecated cases can't be run, even if a template still lists them.
  const runnableIds = new Set(runnable.map((c) => c.id));
  const caseIds = [...selected].filter((id) => runnableIds.has(id));

  const applyTemplate = (id: number | null) => {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setSelected(new Set(t.caseIds));
    if (t.environment) setEnvironment(t.environment);
    if (!titleEdited) setTitle(defaultTitle(t.name));
  };

  const create = useMutation({
    mutationFn: async () => {
      let tid = templateId;
      if (saveAs && saveName.trim()) {
        const t = await api.post<RunTemplate>(`/api/projects/${pid}/templates`, { name: saveName, environment, caseIds });
        tid = t.id;
        // If starting the run fails below, a retry must not try to create the template again.
        setTemplateId(t.id);
        setSaveAs(false);
      }
      return api.post<{ id: number }>(`/api/projects/${pid}/runs`, { title, environment, milestone, caseIds, templateId: tid, rerunOf: rerunOf?.id });
    },
    onSuccess: (run) => {
      for (const k of ["runs", "milestones", "dashboard", "templates"]) qc.invalidateQueries({ queryKey: [k, pid] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      onCreated?.();
      onClose();
      navigate(`/p/${pid}/runs/${run.id}`);
    },
    onError: (e: Error) => toast("error", e.message),
  });

  return (
    <Modal
      title={rerunOf ? "Re-run failed cases" : "New manual run"}
      onClose={onClose}
      width={680}
      footer={
        <>
          <span className="muted" style={{ marginRight: "auto" }}>{caseIds.length} of {runnable.length} cases</span>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!caseIds.length || !title.trim() || (saveAs && !saveName.trim()) || create.isPending}
            onClick={() => create.mutate()}
          >
            <Play size={13} /> Start run
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="run-title">Run name</label>
        <input
          id="run-title"
          className="bare title-input"
          value={title}
          onChange={(e) => { setTitle(e.target.value); setTitleEdited(true); }}
          onFocus={(e) => e.currentTarget.select()} /* the suggested name is selected, so typing replaces it */
          autoFocus
        />
      </div>
      {templates.length > 0 && (
        <div className="field">
          <label htmlFor="tpl">Template</label>
          <select id="tpl" className="select" value={templateId ?? ""} onChange={(e) => applyTemplate(e.target.value ? Number(e.target.value) : null)}>
            <option value="">None: pick cases below</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name} ({t.caseIds.filter((id) => runnableIds.has(id)).length} cases)</option>
            ))}
          </select>
        </div>
      )}
      <div className="row" style={{ gap: 10 }}>
        <div className="field grow">
          <label htmlFor="env">Environment</label>
          <input id="env" className="input" placeholder="staging, prod, iOS 18…" value={environment} onChange={(e) => setEnvironment(e.target.value)} />
        </div>
        <div className="field grow">
          <label htmlFor="ms">Sprint / release</label>
          <input id="ms" className="input" list="milestone-options" placeholder="Sprint 42, v2.3.0…" value={milestone} onChange={(e) => setMilestone(e.target.value)} />
          <datalist id="milestone-options">{milestones.map((m) => <option key={m.id} value={m.name} />)}</datalist>
        </div>
      </div>
      <CasePicker selected={selected} onChange={setSelected} />
      <div className="row" style={{ gap: 10 }}>
        <label className="row muted" style={{ fontSize: 12.5, cursor: "pointer" }}>
          <input type="checkbox" className="checkbox" checked={saveAs} onChange={(e) => setSaveAs(e.target.checked)} /> Save this selection as a template
        </label>
        {saveAs && (
          <input className="input grow" style={{ height: 28 }} placeholder="Template name, e.g. Smoke test" value={saveName} onChange={(e) => setSaveName(e.target.value)} aria-label="Template name" />
        )}
      </div>
    </Modal>
  );
}
