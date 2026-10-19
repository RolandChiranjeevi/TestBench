import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Download, GitBranch, Hand, Play, Plus, Search } from "lucide-react";
import { api, formatDuration, passRate, timeAgo, type CaseSummary, type Project, type RunSummary, type Suite } from "../api";
import { Empty, FrameworkBadge, Github, Kbd, Modal, PriorityIcon, ProgressBar, useHotkeys, useToast } from "../components/ui";

type Kind = "all" | "manual" | "automated";

export function RunsPage() {
  const { pid } = useParams();
  const navigate = useNavigate();
  const [kind, setKind] = useState<Kind>("all");
  const [creating, setCreating] = useState(false);
  const { data: runs, isLoading } = useQuery({ queryKey: ["runs", pid], queryFn: () => api.get<RunSummary[]>(`/api/projects/${pid}/runs`) });

  useHotkeys({ c: () => setCreating(true) });

  const visible = (runs ?? []).filter((r) => kind === "all" || r.kind === kind);
  const count = (k: Kind) => (runs ?? []).filter((r) => k === "all" || r.kind === k).length;

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
          {(["all", "manual", "automated"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={kind === k} className={`tab${kind === k ? " active" : ""}`} onClick={() => setKind(k)}>
              {{ all: "All runs", manual: "Manual", automated: "Automated" }[k]} <span className="count">{count(k)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="content">
        {isLoading ? null : visible.length === 0 ? (
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
          {run.flaky > 0 && <span className="chip" style={{ color: "var(--flaky)" }}>{run.flaky} flaky</span>}
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
      <div style={{ width: 180, flexShrink: 0, display: "flex", flexDirection: "column", gap: 5 }}>
        <ProgressBar counts={run} />
        <div className="row faint tabular" style={{ fontSize: 11.5, justifyContent: "space-between" }}>
          <span>
            <span style={{ color: "var(--passed)" }}>{run.passed}</span> · <span style={{ color: run.failed ? "var(--failed)" : undefined }}>{run.failed}</span>
            {run.blocked > 0 && <> · <span style={{ color: "var(--blocked)" }}>{run.blocked}</span></>}
            {run.skipped > 0 && <> · {run.skipped}</>}
          </span>
          <span>{run.kind === "manual" ? `${done}/${run.total}` : `${run.total} tests`}</span>
        </div>
      </div>
      <span
        className="tabular"
        title="Pass rate of executed tests"
        style={{ width: 44, textAlign: "right", fontWeight: 600, color: rate == null ? "var(--text-4)" : rate >= 90 ? "var(--passed)" : rate >= 70 ? "var(--blocked)" : "var(--failed)" }}
      >
        {rate == null ? "—" : `${rate}%`}
      </span>
    </Link>
  );
}

export function NewRunModal({ initialCaseIds = [], onClose, onCreated }: { initialCaseIds?: number[]; onClose: () => void; onCreated?: () => void }) {
  const { pid } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });
  const key = projects?.find((p) => p.id === Number(pid))?.key;
  const { data: suites = [] } = useQuery({ queryKey: ["suites", pid], queryFn: () => api.get<Suite[]>(`/api/projects/${pid}/suites`) });
  const { data: cases = [] } = useQuery({ queryKey: ["cases", pid], queryFn: () => api.get<CaseSummary[]>(`/api/projects/${pid}/cases`) });

  const today = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const [title, setTitle] = useState(`Regression · ${today}`);
  const [environment, setEnvironment] = useState("");
  const [milestone, setMilestone] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<number>>(() => new Set(initialCaseIds));

  const runnable = useMemo(() => cases.filter((c) => c.status !== "deprecated"), [cases]);
  const q = search.trim().toLowerCase();
  const shown = runnable.filter((c) => !q || `${key}-${c.number} ${c.title} ${c.tags.join(" ")}`.toLowerCase().includes(q));
  const groups = [...suites.map((s) => ({ id: s.id as number | null, name: s.name })), { id: null, name: "No suite" }]
    .map((g) => ({ ...g, items: shown.filter((c) => c.suite_id === g.id) }))
    .filter((g) => g.items.length);

  const setMany = (ids: number[], on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      ids.forEach((id) => (on ? n.add(id) : n.delete(id)));
      return n;
    });

  const create = useMutation({
    mutationFn: () => api.post<{ id: number }>(`/api/projects/${pid}/runs`, { title, environment, milestone, caseIds: [...selected] }),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ["runs", pid] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      onCreated?.();
      onClose();
      navigate(`/p/${pid}/runs/${run.id}`);
    },
    onError: (e: Error) => toast("error", e.message),
  });

  return (
    <Modal
      title="New manual run"
      onClose={onClose}
      width={680}
      footer={
        <>
          <span className="muted" style={{ marginRight: "auto" }}>{selected.size} of {runnable.length} cases</span>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!selected.size || !title.trim() || create.isPending} onClick={() => create.mutate()}>
            <Play size={13} /> Start run
          </button>
        </>
      }
    >
      <input className="bare title-input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Run title" autoFocus />
      <div className="row" style={{ gap: 10 }}>
        <div className="field grow">
          <label htmlFor="env">Environment</label>
          <input id="env" className="input" placeholder="staging, prod, iOS 18…" value={environment} onChange={(e) => setEnvironment(e.target.value)} />
        </div>
        <div className="field grow">
          <label htmlFor="ms">Sprint / release</label>
          <input id="ms" className="input" placeholder="Sprint 42, v2.3.0…" value={milestone} onChange={(e) => setMilestone(e.target.value)} />
        </div>
      </div>
      <div className="row">
        <div className="search grow">
          <Search size={13} />
          <input className="input" placeholder="Filter cases" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Filter cases" />
        </div>
        <button className="btn sm" onClick={() => setMany(shown.map((c) => c.id), true)}>Select {q ? "shown" : "all"}</button>
        <button className="btn ghost sm" onClick={() => setSelected(new Set())}>Clear</button>
      </div>
      <div className="card" style={{ maxHeight: 300, overflow: "auto" }}>
        {groups.length === 0 && <div className="muted" style={{ padding: 16 }}>No cases to run. Create test cases first.</div>}
        {groups.map((g) => {
          const ids = g.items.map((c) => c.id);
          const all = ids.every((id) => selected.has(id));
          const some = !all && ids.some((id) => selected.has(id));
          return (
            <div key={g.id ?? "none"}>
              <label className="group-header" style={{ cursor: "pointer", padding: "0 12px" }}>
                <input type="checkbox" className="checkbox" checked={all} ref={(el) => { if (el) el.indeterminate = some; }} onChange={() => setMany(ids, !all)} />
                {g.name} <span className="count">{g.items.length}</span>
              </label>
              {g.items.map((c) => (
                <label key={c.id} className="list-row" style={{ height: 32, padding: "0 12px" }}>
                  <input type="checkbox" className="checkbox" checked={selected.has(c.id)} onChange={() => setMany([c.id], !selected.has(c.id))} />
                  <PriorityIcon priority={c.priority} />
                  <span className="mono muted" style={{ width: 62 }}>{key}-{c.number}</span>
                  <span className="title">{c.title}</span>
                  {c.automated_count > 0 && <Bot size={12} className="faint" />}
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
