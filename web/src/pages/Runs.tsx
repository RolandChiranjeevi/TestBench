import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Download, GitBranch, Hand, Play, Plus } from "lucide-react";
import { api, formatDuration, passRate, timeAgo, type Milestone, type RunSummary, type RunTemplate } from "../api";
import { CasePicker, useRunnableCases } from "../components/CasePicker";
import { Empty, FrameworkBadge, Github, Kbd, Modal, ProgressBar, useHotkeys, useToast, ListSkeleton } from "../components/ui";
import { Badge, CiStatusBadge } from "../components/Badge";
import { Button } from "../components/Button";
import { agentRunInfo, askedRunInfo } from "../agentruns";
import { TemplateModal, TemplatesPanel, useTemplates } from "./Templates";

// "suites" is the tab of the runnable groups of cases (run templates). The tab and the suite filter are kept in the address, so that a link can open them.
type Kind = "all" | "manual" | "automated" | "suites";
const KINDS: Kind[] = ["all", "manual", "automated", "suites"];

export function RunsPage() {
  const { pid } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const kind: Kind = KINDS.includes(params.get("kind") as Kind) ? (params.get("kind") as Kind) : "all";
  const suiteFilter = params.get("suite") ?? "";
  const setQuery = (name: string, value: string) =>
    setParams((p) => { const next = new URLSearchParams(p); if (value) next.set(name, value); else next.delete(name); return next; }, { replace: true });
  const setKind = (k: Kind) => setQuery("kind", k === "all" ? "" : k);
  const [creating, setCreating] = useState(false);
  const [startFrom, setStartFrom] = useState<RunTemplate | null>(null);
  const [editing, setEditing] = useState<RunTemplate | "new" | null>(null);
  const { data: runs, isLoading } = useQuery({ queryKey: ["runs", pid], queryFn: () => api.get<RunSummary[]>(`/api/projects/${pid}/runs`) });
  const { data: templates = [] } = useTemplates();

  useHotkeys({ c: () => setCreating(true) });

  // A run that came from a suite that has been deleted since still has the name, so it is "from a suite" for the filter.
  const inSuite = (r: RunSummary) => !suiteFilter || (suiteFilter === "none" ? r.template_name == null : String(r.template_id) === suiteFilter);
  const visible = (runs ?? []).filter((r) => (kind === "all" || r.kind === kind) && inSuite(r));
  const count = (k: Kind) => (k === "suites" ? templates.length : (runs ?? []).filter((r) => k === "all" || r.kind === k).length);
  const showSuiteFilter = kind !== "suites" && (templates.length > 0 || (runs ?? []).some((r) => r.template_name != null));

  return (
    <>
      <div className="topbar">
        <h1>Runs</h1>
        <span className="spacer" />
        <Button onClick={() => navigate(`/p/${pid}/import`)}>
          <Download size={14} /> Import results
        </Button>
        <Button needs="tester" variant="primary" onClick={() => setCreating(true)}>
          <Plus size={14} /> New manual run <Kbd>C</Kbd>
        </Button>
      </div>
      <div className="toolbar">
        <div className="tabs" role="tablist">
          {KINDS.map((k) => (
            <button key={k} role="tab" aria-selected={kind === k} className={`tab${kind === k ? " active" : ""}`} onClick={() => setKind(k)}>
              {{ all: "All runs", manual: "Manual", automated: "Automated", suites: "Suites" }[k]} <span className="count">{count(k)}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        {showSuiteFilter && (
          <select className="select" style={{ height: 28, maxWidth: 220 }} value={suiteFilter} onChange={(e) => setQuery("suite", e.target.value)} aria-label="Filter runs by suite">
            <option value="">Any suite</option>
            <option value="none">Not from a suite</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        {kind === "suites" && templates.length > 0 && (
          <Button needs="tester" size="sm" onClick={() => setEditing("new")}><Plus size={13} /> New suite</Button>
        )}
      </div>
      <div className="content">
        {kind === "suites" ? (
          <TemplatesPanel templates={templates} onStart={setStartFrom} onEdit={setEditing} onNew={() => setEditing("new")} />
        ) : isLoading ? <ListSkeleton /> : visible.length === 0 ? (
          <Empty
            icon={<Play size={20} />}
            title={suiteFilter ? "No runs match" : "No runs yet"}
            action={
              <div className="row">
                <Button needs="tester" variant="primary" onClick={() => setCreating(true)}><Plus size={14} /> New manual run</Button>
                <Button onClick={() => navigate(`/p/${pid}/import`)}><Download size={14} /> Import results</Button>
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
          {run.template_name && <span className="chip" title="This run was started from a suite">Suite: {run.template_name}</span>}
          {run.meta?.scheduled && <span className="chip" title="Prepared by the suite's schedule, not started by a person">Scheduled</span>}
          {agentRunInfo(run) && <span className="chip" title={`Handed in by an agent for request #${agentRunInfo(run)!.requestId}, not imported by a person`}>Agent</span>}
          {askedRunInfo(run) && <span className="chip chip-long" title={askedRunInfo(run)!.title}>{askedRunInfo(run)!.label}</span>}
          {run.kind === "manual" && run.status === "in_progress" && <Badge tone="accent" icon="eye">In progress</Badge>}
          {run.flaky > 0 && <CiStatusBadge value="flaky" label={`${run.flaky} flaky`} />}
        </div>
        <div className="row faint" style={{ gap: 8, fontSize: "var(--fs-sm)" }}>
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
        <div className="row faint tabular" style={{ fontSize: "var(--fs-sm)", justifyContent: "space-between" }}>
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

/** Start a manual run. Cases can be picked by hand, taken from a suite (a run template), or both; the selection can be saved as a new suite. */
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
  // "Ask an agent" (AG4): the run is made now, with an empty result for each case, and an agent is asked to run them in its own environment. TestBench starts nothing.
  const [agentMode, setAgentMode] = useState(false);
  const [targetUrl, setTargetUrl] = useState("");
  const [note, setNote] = useState("");
  const chooseMode = (agent: boolean) => {
    setAgentMode(agent);
    if (!titleEdited && !rerunOf && !initialTitle) setTitle(agent ? `Agent run · ${today}` : defaultTitle(template?.name));
  };

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
      if (agentMode) {
        // One request makes the run and the request together (the suite, if any, follows so that the run still says "Suite: …"). It gives back the request, and the request the run.
        const asked = await api.post<{ id: number; runId: number | null }>(`/api/projects/${pid}/agent-requests`, { kind: "run", title, environment, targetUrl, note, caseIds, templateId });
        qc.invalidateQueries({ queryKey: ["agent-requests", pid] });
        return { id: asked.runId as number };
      }
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
      title={rerunOf ? "Re-run failed cases" : template ? `Run suite “${template.name}”` : "New manual run"}
      onClose={onClose}
      width={680}
      footer={
        <>
          <span className="muted" style={{ marginRight: "auto" }}>{caseIds.length} of {runnable.length} cases</span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button needs="tester" variant="primary"
            disabled={!caseIds.length || !title.trim() || (agentMode ? !targetUrl.trim() : saveAs && !saveName.trim()) || create.isPending}
            onClick={() => create.mutate()}
          >
            {agentMode ? <><Bot size={13} /> Ask agent to run ({caseIds.length})</> : <><Play size={13} /> Start run</>}
          </Button>
        </>
      }
    >
      <div className="tabs" role="radiogroup" aria-label="Who runs the cases" style={{ marginBottom: 4 }}>
        <button type="button" role="radio" aria-checked={!agentMode} className={`tab${!agentMode ? " active" : ""}`} onClick={() => chooseMode(false)}>Run it myself</button>
        <button type="button" role="radio" aria-checked={agentMode} className={`tab${agentMode ? " active" : ""}`} onClick={() => chooseMode(true)}><Bot size={12} /> Ask an agent</button>
      </div>
      {agentMode && (
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
          <p style={{ margin: "0 0 6px" }}>
            TestBench starts nothing. An agent with a request token takes this request and runs the cases in <b>your own environment</b>, then reports a result for each one.
            The run is made now and waits for the agent; you can still fill in results yourself.
          </p>
          <p style={{ margin: 0 }}>
            <b>The text of the chosen test cases is sent to the agent</b> (title, description, preconditions and steps, and the names of linked automated tests and spec files), but no specs
            and no requirements. Do not put secrets, passwords, API keys or other sensitive information in test cases or in the address.
          </p>
        </div>
      )}
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
          <label htmlFor="tpl">Suite</label>
          <select id="tpl" className="select" value={templateId ?? ""} onChange={(e) => applyTemplate(e.target.value ? Number(e.target.value) : null)}>
            <option value="">None: pick cases below</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name} ({t.caseIds.filter((id) => runnableIds.has(id)).length} cases)</option>
            ))}
          </select>
        </div>
      )}
      <div className="row" style={{ gap: 12 }}>
        <div className="field grow">
          <label htmlFor="env">Environment</label>
          <input id="env" className="input" placeholder="staging, prod, iOS 18…" value={environment} onChange={(e) => setEnvironment(e.target.value)} />
        </div>
        {!agentMode && (
          <div className="field grow">
            <label htmlFor="ms">Sprint / release</label>
            <input id="ms" className="input" list="milestone-options" placeholder="Sprint 42, v2.3.0…" value={milestone} onChange={(e) => setMilestone(e.target.value)} />
            <datalist id="milestone-options">{milestones.map((m) => <option key={m.id} value={m.name} />)}</datalist>
          </div>
        )}
        {agentMode && (
          <div className="field grow">
            <label htmlFor="agent-url">Address to test</label>
            <input id="agent-url" className="input" type="url" inputMode="url" placeholder="https://staging.example.com" value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} />
          </div>
        )}
      </div>
      {agentMode && (
        <div className="field">
          <label htmlFor="agent-note">Note for the agent (optional)</label>
          <input id="agent-note" className="input" maxLength={2000} placeholder="Anything the agent should know about this run" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      )}
      <CasePicker selected={selected} onChange={setSelected} />
      {!agentMode && (
        <div className="row" style={{ gap: 12 }}>
          <label className="row muted" style={{ fontSize: "var(--fs-md)", cursor: "pointer" }}>
            <input type="checkbox" className="checkbox" checked={saveAs} onChange={(e) => setSaveAs(e.target.checked)} /> Save this selection as a suite
          </label>
          {saveAs && (
            <input className="input grow" style={{ height: 28 }} placeholder="Suite name, e.g. Smoke test" value={saveName} onChange={(e) => setSaveName(e.target.value)} aria-label="Suite name" />
          )}
        </div>
      )}
    </Modal>
  );
}
