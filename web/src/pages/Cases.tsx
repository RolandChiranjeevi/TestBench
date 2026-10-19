import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Folder, FolderOpen, Inbox, ListChecks, MoreHorizontal, Pencil, Play, Plus, Search, Trash2, X } from "lucide-react";
import { api, type CaseDetail, type CaseSummary, type Project, type Suite } from "../api";
import { Empty, Kbd, Modal, PriorityIcon, StatusIcon, useHotkeys, useToast } from "../components/ui";
import { CaseEditor } from "./CaseEditor";
import { NewRunModal } from "./Runs";

type Filter = "all" | "manual" | "automated" | "failing";

export function CasesPage() {
  const { pid } = useParams();
  const projectId = Number(pid);
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("case") ? Number(params.get("case")) : null;
  // With the editor open the list gets narrow, so drop secondary metadata.
  const compact = selectedId != null;
  const suiteParam = params.get("suite");
  const suiteFilter: number | "none" | null = suiteParam === "none" ? "none" : suiteParam ? Number(suiteParam) : null;

  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });
  const project = projects?.find((p) => p.id === projectId);
  const { data: suites = [] } = useQuery({ queryKey: ["suites", pid], queryFn: () => api.get<Suite[]>(`/api/projects/${pid}/suites`) });
  const { data: cases, isLoading } = useQuery({ queryKey: ["cases", pid], queryFn: () => api.get<CaseSummary[]>(`/api/projects/${pid}/cases`) });

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [focus, setFocus] = useState(0);
  const [newCase, setNewCase] = useState(false);
  const [suiteModal, setSuiteModal] = useState<{ suite?: Suite; parentId?: number | null } | null>(null);
  const [runModal, setRunModal] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const setParam = (k: string, v: string | null) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (v == null) n.delete(k);
      else n.set(k, v);
      return n;
    }, { replace: true });
  const select = (id: number | null) => setParam("case", id == null ? null : String(id));

  // Suite ids in the selected subtree.
  const suiteScope = useMemo(() => {
    if (typeof suiteFilter !== "number") return null;
    const ids = new Set([suiteFilter]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of suites) if (s.parent_id && ids.has(s.parent_id) && !ids.has(s.id)) { ids.add(s.id); grew = true; }
    }
    return ids;
  }, [suiteFilter, suites]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (cases ?? []).filter((c) => {
      if (suiteFilter === "none" && c.suite_id != null) return false;
      if (suiteScope && !suiteScope.has(c.suite_id ?? -1)) return false;
      if (filter === "manual" && c.automated_count > 0) return false;
      if (filter === "automated" && c.automated_count === 0) return false;
      if (filter === "failing" && c.last_status !== "failed" && c.last_status !== "blocked") return false;
      if (!q) return true;
      return `${project?.key}-${c.number} ${c.title} ${c.tags.join(" ")}`.toLowerCase().includes(q);
    });
  }, [cases, search, filter, suiteFilter, suiteScope, project?.key]);

  // Group by suite in tree order, with "No suite" last.
  const groups = useMemo(() => {
    const order = new Map(suites.map((s, i) => [s.id, i]));
    const map = new Map<number | null, CaseSummary[]>();
    for (const c of visible) {
      if (!map.has(c.suite_id)) map.set(c.suite_id, []);
      map.get(c.suite_id)!.push(c);
    }
    return [...map.entries()]
      .sort(([a], [b]) => (a == null ? 1 : b == null ? -1 : (order.get(a) ?? 0) - (order.get(b) ?? 0)))
      .map(([id, items]) => ({ id, name: id == null ? "No suite" : suites.find((s) => s.id === id)?.name ?? "Unknown", items }));
  }, [visible, suites]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => setFocus((f) => Math.min(f, Math.max(0, flat.length - 1))), [flat.length]);
  useEffect(() => {
    listRef.current?.querySelector(".list-row.focused")?.scrollIntoView({ block: "nearest" });
  }, [focus]);

  const toggle = (id: number) =>
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  useHotkeys({
    c: () => setNewCase(true),
    "/": () => searchRef.current?.focus(),
    j: () => setFocus((f) => Math.min(f + 1, flat.length - 1)),
    k: () => setFocus((f) => Math.max(f - 1, 0)),
    ArrowDown: () => setFocus((f) => Math.min(f + 1, flat.length - 1)),
    ArrowUp: () => setFocus((f) => Math.max(f - 1, 0)),
    Enter: () => flat[focus] && select(flat[focus].id),
    o: () => flat[focus] && select(flat[focus].id),
    x: () => flat[focus] && toggle(flat[focus].id),
    r: () => checked.size > 0 && setRunModal(true),
  });

  const deleteSuite = useMutation({
    mutationFn: (id: number) => api.del(`/api/suites/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suites", pid] });
      qc.invalidateQueries({ queryKey: ["cases", pid] });
      setParam("suite", null);
    },
    onError: (e: Error) => toast("error", e.message),
  });

  const counts = {
    all: cases?.length ?? 0,
    manual: cases?.filter((c) => c.automated_count === 0).length ?? 0,
    automated: cases?.filter((c) => c.automated_count > 0).length ?? 0,
    failing: cases?.filter((c) => c.last_status === "failed" || c.last_status === "blocked").length ?? 0,
  };
  const noSuiteCount = cases?.filter((c) => c.suite_id == null).length ?? 0;

  return (
    <div className="split">
      {/* Suite tree */}
      <div className="pane" style={{ width: 220, flexShrink: 0, borderRight: "1px solid var(--border)", background: "var(--bg-panel)", position: "relative" }}>
        <div className="topbar" style={{ padding: "0 8px 0 16px" }}>
          <h1 style={{ fontSize: 12.5, color: "var(--text-3)", fontWeight: 500 }}>Suites</h1>
          <span className="spacer" />
          <button className="btn ghost icon sm" onClick={() => setSuiteModal({ parentId: null })} title="New suite" aria-label="New suite">
            <Plus size={14} />
          </button>
        </div>
        <div className="tree">
          <button className={`tree-item${suiteFilter == null ? " active" : ""}`} onClick={() => setParam("suite", null)}>
            <ListChecks size={14} /> All cases <span className="count">{cases?.length ?? 0}</span>
          </button>
          <SuiteTree
            suites={suites}
            parentId={null}
            depth={0}
            active={suiteFilter}
            onSelect={(id) => setParam("suite", String(id))}
            onAdd={(parentId) => setSuiteModal({ parentId })}
            onEdit={(suite) => setSuiteModal({ suite })}
            onDelete={(s) => confirm(`Delete suite "${s.name}" and its sub-suites? Cases are kept and moved to "No suite".`) && deleteSuite.mutate(s.id)}
          />
          {noSuiteCount > 0 && (
            <button className={`tree-item${suiteFilter === "none" ? " active" : ""}`} onClick={() => setParam("suite", "none")}>
              <Inbox size={14} /> No suite <span className="count">{noSuiteCount}</span>
            </button>
          )}
        </div>
      </div>

      {/* Case list */}
      <div className="pane grow" style={{ display: "flex", flexDirection: "column" }}>
        <div className="topbar">
          <h1>Test cases</h1>
          <span className="spacer" />
          <div className="search" style={{ width: compact ? 160 : 220 }}>
            <Search size={13} />
            <input
              ref={searchRef}
              className="input"
              placeholder="Search cases"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearch("");
                  e.currentTarget.blur();
                }
              }}
              aria-label="Search cases"
            />
          </div>
          <button className="btn primary" onClick={() => setNewCase(true)}>
            <Plus size={14} /> New case <Kbd>C</Kbd>
          </button>
        </div>
        <div className="toolbar">
          {checked.size > 0 ? (
            <>
              <span style={{ fontWeight: 500 }}>{checked.size} selected</span>
              <button className="btn sm" onClick={() => setRunModal(true)}>
                <Play size={12} /> Start run <Kbd>R</Kbd>
              </button>
              <button className="btn ghost sm" onClick={() => setChecked(new Set(visible.map((c) => c.id)))}>Select all {visible.length}</button>
              <button className="btn ghost sm" onClick={() => setChecked(new Set())}>
                <X size={12} /> Clear
              </button>
            </>
          ) : (
            <div className="tabs" role="tablist">
              {(["all", "manual", "automated", "failing"] as const).map((f) => (
                <button key={f} role="tab" aria-selected={filter === f} className={`tab${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>
                  {{ all: "All", manual: "Manual only", automated: "Automated", failing: "Failing" }[f]}
                  <span className="count">{counts[f]}</span>
                </button>
              ))}
            </div>
          )}
          <span className="spacer" />
          {!compact && (
            <span className="faint" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
              <Kbd>J</Kbd> <Kbd>K</Kbd> move · <Kbd>X</Kbd> select · <Kbd>↵</Kbd> open
            </span>
          )}
        </div>
        <div className="content" ref={listRef}>
          {isLoading ? null : flat.length === 0 ? (
            cases?.length ? (
              <Empty icon={<Search size={20} />} title="No matching cases">Try a different search or filter.</Empty>
            ) : (
              <Empty
                icon={<ListChecks size={20} />}
                title="No test cases yet"
                action={<button className="btn primary" onClick={() => setNewCase(true)}><Plus size={14} /> New case</button>}
              >
                Write your first manual test case. Group cases in suites, then start a run to execute them.
              </Empty>
            )
          ) : (
            groups.map((g) => (
              <div key={g.id ?? "none"}>
                <div className="group-header">
                  {g.id == null ? <Inbox size={13} /> : <Folder size={13} />}
                  {g.name}
                  <span className="count">{g.items.length}</span>
                </div>
                {g.items.map((c) => {
                  const idx = flat.indexOf(c);
                  return (
                    <div
                      key={c.id}
                      className={`list-row${selectedId === c.id ? " selected" : ""}${focus === idx ? " focused" : ""}`}
                      onClick={() => { setFocus(idx); select(c.id); }}
                    >
                      <input
                        type="checkbox"
                        className="checkbox"
                        checked={checked.has(c.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggle(c.id)}
                        aria-label={`Select ${project?.key}-${c.number}`}
                        style={{ opacity: checked.size || checked.has(c.id) ? 1 : 0.35 }}
                      />
                      <PriorityIcon priority={c.priority} />
                      <span className="id mono">{project?.key}-{c.number}</span>
                      <span className="title" style={c.status === "deprecated" ? { textDecoration: "line-through", color: "var(--text-3)" } : undefined}>
                        {c.title}
                      </span>
                      <span className="meta">
                        {!compact && c.status === "draft" && <span className="chip">Draft</span>}
                        {!compact && c.tags.slice(0, 3).map((t) => <span key={t} className="chip">{t}</span>)}
                        {c.automated_count > 0 && (
                          <span className="chip accent" title={`${c.automated_count} automated test(s)`}>
                            <Bot size={11} /> {c.automated_count}
                          </span>
                        )}
                        {!compact && (
                          <span className="faint tabular" style={{ width: 52, textAlign: "right" }} title="Steps">
                            {c.step_count} {c.step_count === 1 ? "step" : "steps"}
                          </span>
                        )}
                        <StatusIcon status={c.last_status} />
                      </span>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Editor */}
      {selectedId != null && (
        <div className="detail-pane" style={{ width: "min(600px, 48vw)" }}>
          <CaseEditor key={selectedId} caseId={selectedId} suites={suites} onClose={() => select(null)} onDeleted={() => select(null)} />
        </div>
      )}

      {newCase && (
        <NewCaseModal
          projectId={projectId}
          suites={suites}
          defaultSuite={typeof suiteFilter === "number" ? suiteFilter : null}
          onClose={() => setNewCase(false)}
          onCreated={(id) => select(id)}
        />
      )}
      {suiteModal && <SuiteModal projectId={projectId} suites={suites} {...suiteModal} onClose={() => setSuiteModal(null)} />}
      {runModal && <NewRunModal initialCaseIds={[...checked]} onClose={() => setRunModal(false)} onCreated={() => setChecked(new Set())} />}
    </div>
  );
}

function SuiteTree(props: {
  suites: Suite[];
  parentId: number | null;
  depth: number;
  active: number | "none" | null;
  onSelect: (id: number) => void;
  onAdd: (parentId: number) => void;
  onEdit: (s: Suite) => void;
  onDelete: (s: Suite) => void;
}) {
  const children = props.suites.filter((s) => s.parent_id === props.parentId);
  const [menu, setMenu] = useState<number | null>(null);
  return (
    <>
      {children.map((s) => (
        <div key={s.id} style={{ position: "relative" }}>
          <div
            role="button"
            tabIndex={0}
            className={`tree-item${props.active === s.id ? " active" : ""}`}
            style={{ paddingLeft: 8 + props.depth * 14 }}
            onClick={() => props.onSelect(s.id)}
            onKeyDown={(e) => e.key === "Enter" && props.onSelect(s.id)}
          >
            {props.active === s.id ? <FolderOpen size={14} /> : <Folder size={14} />}
            <span className="truncate">{s.name}</span>
            <span className="count">{s.case_count}</span>
            <span className="actions">
              <button
                className="btn ghost icon sm"
                style={{ width: 20, height: 20 }}
                onClick={(e) => { e.stopPropagation(); setMenu(menu === s.id ? null : s.id); }}
                aria-label={`Suite actions for ${s.name}`}
              >
                <MoreHorizontal size={13} />
              </button>
            </span>
          </div>
          {menu === s.id && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 9 }} onClick={() => setMenu(null)} />
              <div className="card" style={{ position: "absolute", right: 0, top: 28, zIndex: 10, padding: 4, boxShadow: "var(--shadow)", background: "var(--bg-elev)", width: 170 }}>
                <button className="nav-item" onClick={() => { setMenu(null); props.onAdd(s.id); }}><Plus size={13} /> Add sub-suite</button>
                <button className="nav-item" onClick={() => { setMenu(null); props.onEdit(s); }}><Pencil size={13} /> Rename</button>
                <button className="nav-item" onClick={() => { setMenu(null); props.onDelete(s); }} style={{ color: "var(--failed)" }}><Trash2 size={13} /> Delete</button>
              </div>
            </>
          )}
          <SuiteTree {...props} parentId={s.id} depth={props.depth + 1} />
        </div>
      ))}
    </>
  );
}

function NewCaseModal({ projectId, suites, defaultSuite, onClose, onCreated }: {
  projectId: number; suites: Suite[]; defaultSuite: number | null; onClose: () => void; onCreated: (id: number) => void;
}) {
  const [title, setTitle] = useState("");
  const [suiteId, setSuiteId] = useState<number | null>(defaultSuite ?? suites[0]?.id ?? null);
  const [another, setAnother] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const create = useMutation({
    mutationFn: () => api.post<CaseDetail>(`/api/projects/${projectId}/cases`, { title, suiteId }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["cases", String(projectId)] });
      qc.invalidateQueries({ queryKey: ["suites", String(projectId)] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast("success", `Created ${c.project_key}-${c.number}`);
      if (another) setTitle("");
      else {
        onClose();
        onCreated(c.id);
      }
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const submit = () => title.trim() && !create.isPending && create.mutate();
  return (
    <Modal
      title={<span className="chip">New case</span>}
      onClose={onClose}
      footer={
        <>
          <label className="row muted" style={{ marginRight: "auto", fontSize: 12.5, cursor: "pointer" }}>
            <input type="checkbox" className="checkbox" checked={another} onChange={(e) => setAnother(e.target.checked)} /> Create more
          </label>
          <button className="btn primary" onClick={submit} disabled={!title.trim() || create.isPending}>
            Create case <Kbd>↵</Kbd>
          </button>
        </>
      }
    >
      <input
        className="bare title-input"
        autoFocus
        placeholder="Case title, e.g. Log in with valid credentials"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        aria-label="Case title"
      />
      <div className="row">
        <label className="pill">
          <Folder size={13} />
          {suites.find((s) => s.id === suiteId)?.name ?? "No suite"}
          <select value={suiteId ?? ""} onChange={(e) => setSuiteId(e.target.value ? Number(e.target.value) : null)} aria-label="Suite">
            <option value="">No suite</option>
            {suites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <span className="faint" style={{ fontSize: 12 }}>Add steps, priority and tags after creating.</span>
      </div>
    </Modal>
  );
}

function SuiteModal({ projectId, suites, suite, parentId, onClose }: { projectId: number; suites: Suite[]; suite?: Suite; parentId?: number | null; onClose: () => void }) {
  const [name, setName] = useState(suite?.name ?? "");
  const qc = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: () =>
      suite ? api.patch(`/api/suites/${suite.id}`, { name }) : api.post(`/api/projects/${projectId}/suites`, { name, parentId: parentId ?? null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suites", String(projectId)] });
      qc.invalidateQueries({ queryKey: ["cases", String(projectId)] });
      onClose();
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const parent = suites.find((s) => s.id === parentId);
  return (
    <Modal
      title={suite ? "Rename suite" : parent ? `New suite in ${parent.name}` : "New suite"}
      onClose={onClose}
      width={420}
      footer={<button className="btn primary" disabled={!name.trim()} onClick={() => save.mutate()}>{suite ? "Save" : "Create suite"}</button>}
    >
      <input
        className="input"
        autoFocus
        placeholder="e.g. Checkout"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && name.trim() && save.mutate()}
        aria-label="Suite name"
      />
    </Modal>
  );
}
