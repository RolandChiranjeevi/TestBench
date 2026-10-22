import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, BookOpenCheck, Bot, ClipboardList, Copy, Folder, FolderOpen, Inbox, ListChecks, MoreHorizontal, Pencil, Play, Plus, Search, Trash2, X } from "lucide-react";
import { api, orderSuites, type BackupInfo, type CaseDetail, type CaseSummary, type Project, type RequirementDetail, type Suite } from "../api";
import { ConfirmModal, Empty, Kbd, Modal, PriorityIcon, StatusIcon, useHotkeys, useToast, ListSkeleton } from "../components/ui";
import { CaseEditor } from "./CaseEditor";
import { NewRunModal } from "./Runs";
import { TemplateModal } from "./Templates";
import { LinkToRequirementModal } from "./Requirements";

type Filter = "all" | "manual" | "automated" | "failing" | "unlinked";

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
  // The dashboard tiles link here with ?filter=failing, ?filter=manual and so on.
  const [filter, setFilter] = useState<Filter>(() => {
    const f = params.get("filter");
    return f === "manual" || f === "automated" || f === "failing" || f === "unlinked" ? f : "all";
  });
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [focus, setFocus] = useState(0);
  const newFor = params.get("newFor") ? Number(params.get("newFor")) : null;
  const [newCase, setNewCase] = useState(newFor != null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [drop, setDrop] = useState<{ id: number | "end" | "none"; zone: "before" | "after" | "into" } | null>(null);
  const [caseDrag, setCaseDrag] = useState<number[] | null>(null);
  const [bulkModal, setBulkModal] = useState(false);
  const [deleteModal, setDeleteModal] = useState(false);
  const { data: backupInfo } = useQuery({ queryKey: ["backup-info"], queryFn: () => api.get<BackupInfo>("/api/backup/info"), staleTime: 60_000 });
  const moveCases = useMutation({
    mutationFn: (v: { ids: number[]; suiteId: number | null }) => api.post<{ updated: number }>(`/api/projects/${pid}/cases/bulk`, v),
    onSuccess: (r, v) => {
      qc.invalidateQueries({ queryKey: ["cases", pid] });
      qc.invalidateQueries({ queryKey: ["suites", pid] });
      qc.invalidateQueries({ queryKey: ["case"] });
      toast("success", `Moved ${r.updated} ${r.updated === 1 ? "case" : "cases"} to ${v.suiteId == null ? "No suite" : suites.find((s) => s.id === v.suiteId)?.name ?? "the suite"}`);
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const dropCases = (suiteId: number | null) => {
    const ids = caseDrag;
    setCaseDrag(null);
    setDrop(null);
    if (ids?.length) moveCases.mutate({ ids, suiteId });
  };
  const duplicate = useMutation({
    mutationFn: async (ids: number[]) => {
      const made: CaseDetail[] = [];
      for (const id of ids) made.push(await api.post<CaseDetail>(`/api/cases/${id}/duplicate`));
      return made;
    },
    onSuccess: (made) => {
      qc.invalidateQueries({ queryKey: ["cases", pid] });
      qc.invalidateQueries({ queryKey: ["suites", pid] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      setChecked(new Set());
      toast("success", made.length === 1 ? `Created ${made[0].project_key}-${made[0].number} as a draft copy` : `Created ${made.length} draft copies`);
      if (made.length === 1) select(made[0].id);
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const moveSuite = useMutation({
    mutationFn: (v: { id: number; parentId: number | null; beforeId: number | null }) => api.post(`/api/suites/${v.id}/move`, { parentId: v.parentId, beforeId: v.beforeId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suites", pid] });
      qc.invalidateQueries({ queryKey: ["cases", pid] });
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const [suiteModal, setSuiteModal] = useState<{ suite?: Suite; parentId?: number | null } | null>(null);
  const [runModal, setRunModal] = useState(false);
  const [templateModal, setTemplateModal] = useState(false);
  const [linkModal, setLinkModal] = useState(false);
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
      if (filter === "unlinked" && (c.requirement_count || c.status === "deprecated")) return false;
      if (!q) return true;
      return `${project?.key}-${c.number} ${c.title} ${c.tags.join(" ")}`.toLowerCase().includes(q);
    });
  }, [cases, search, filter, suiteFilter, suiteScope, project?.key]);

  // Group by suite in tree order, with "No suite" last.
  const groups = useMemo(() => {
    const order = new Map(orderSuites(suites).map((s, i) => [s.id, i]));
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
    unlinked: cases?.filter((c) => !c.requirement_count && c.status !== "deprecated").length ?? 0,
    manual: cases?.filter((c) => c.automated_count === 0).length ?? 0,
    automated: cases?.filter((c) => c.automated_count > 0).length ?? 0,
    failing: cases?.filter((c) => c.last_status === "failed" || c.last_status === "blocked").length ?? 0,
  };
  const noSuiteCount = cases?.filter((c) => c.suite_id == null).length ?? 0;

  return (
    <div className="split has-tree">
      {/* Suite tree */}
      <div className="pane suite-pane" style={{ width: 220, flexShrink: 0, borderRight: "1px solid var(--border)", background: "var(--bg-panel)", position: "relative" }}>
        <div className="topbar" style={{ padding: "0 8px 0 16px" }}>
          <h2 style={{ fontSize: "var(--fs-md)", color: "var(--text-3)", fontWeight: 500 }}>Suites</h2>
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
            dragId={dragId}
            setDragId={setDragId}
            drop={drop}
            setDrop={setDrop}
            onMove={(id, parentId, beforeId) => moveSuite.mutate({ id, parentId, beforeId })}
            caseDrag={caseDrag}
            onDropCases={dropCases}
          />
          {/* Dropping below the last suite moves it to the end of the top level. */}
          {dragId != null && (
            <div
              style={{ height: 24, borderRadius: 4, ...(drop?.id === "end" ? { boxShadow: "inset 0 2px 0 var(--accent)" } : {}) }}
              onDragOver={(e) => { e.preventDefault(); setDrop({ id: "end", zone: "after" }); }}
              onDrop={(e) => { e.preventDefault(); const id = dragId; setDragId(null); setDrop(null); if (id != null) moveSuite.mutate({ id, parentId: null, beforeId: null }); }}
            />
          )}
          {(noSuiteCount > 0 || caseDrag != null) && (
            <button
              className={`tree-item${suiteFilter === "none" ? " active" : ""}${drop?.id === "none" ? " drop-into" : ""}`}
              onClick={() => setParam("suite", "none")}
              onDragOver={(e) => { if (caseDrag == null) return; e.preventDefault(); if (drop?.id !== "none") setDrop({ id: "none", zone: "into" }); }}
              onDrop={(e) => { if (caseDrag == null) return; e.preventDefault(); dropCases(null); }}
            >
              <Inbox size={14} /> No suite <span className="count">{noSuiteCount}</span>
            </button>
          )}
        </div>
      </div>

      {/* Case list */}
      <div className="pane grow" style={{ display: "flex", flexDirection: "column" }}>
        <div className="topbar">
          <h1>Test cases</h1>
          {/* On narrow screens the suite tree is hidden and this takes its place. */}
          <select className="select suite-select" aria-label="Suite" value={suiteParam ?? ""} onChange={(e) => setParam("suite", e.target.value || null)}>
            <option value="">All cases ({cases?.length ?? 0})</option>
            {orderSuites(suites).map((s) => {
              let depth = 0;
              for (let p = s.parent_id; p != null; p = suites.find((x) => x.id === p)?.parent_id ?? null) depth++;
              return <option key={s.id} value={s.id}>{"\u00a0\u00a0".repeat(depth)}{s.name} ({s.case_count})</option>;
            })}
            {noSuiteCount > 0 && <option value="none">No suite ({noSuiteCount})</option>}
          </select>
          <span className="spacer" />
          <div className="search">
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
          {/* Select everything that is shown (after the search and filter). Ticks all, partly ticked when some are selected. */}
          <input
            type="checkbox"
            className="checkbox"
            aria-label="Select all shown cases"
            title="Select all shown cases"
            disabled={visible.length === 0}
            checked={visible.length > 0 && visible.every((c) => checked.has(c.id))}
            ref={(el) => { if (el) el.indeterminate = checked.size > 0 && !visible.every((c) => checked.has(c.id)); }}
            onChange={(e) => setChecked(e.target.checked ? new Set(visible.map((c) => c.id)) : new Set())}
            style={{ marginRight: 6 }}
          />
          {checked.size > 0 ? (
            <>
              <span style={{ fontWeight: 500 }}>{checked.size} selected</span>
              <button className="btn sm" onClick={() => setRunModal(true)}>
                <Play size={12} /> Start run <Kbd>R</Kbd>
              </button>
              <button className="btn sm" onClick={() => setBulkModal(true)}>
                <Pencil size={12} /> Edit…
              </button>
              <button className="btn sm" onClick={() => duplicate.mutate([...checked])} disabled={duplicate.isPending}>
                <Copy size={12} /> Duplicate
              </button>
              <button className="btn sm" onClick={() => setLinkModal(true)}>
                <BookOpenCheck size={12} /> Link to requirement
              </button>
              <button className="btn sm" onClick={() => setTemplateModal(true)}>
                <ClipboardList size={12} /> Save as template
              </button>
              <button className="btn sm danger" onClick={() => setDeleteModal(true)}>
                <Trash2 size={12} /> Delete
              </button>
              <button className="btn ghost sm" onClick={() => setChecked(new Set(visible.map((c) => c.id)))}>Select all {visible.length}</button>
              <button className="btn ghost sm" onClick={() => setChecked(new Set())}>
                <X size={12} /> Clear
              </button>
            </>
          ) : (
            <div className="tabs" role="tablist">
              {(["all", "manual", "automated", "failing", "unlinked"] as const).map((f) => (
                <button key={f} role="tab" aria-selected={filter === f} className={`tab${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>
                  {{ all: "All", manual: "Manual only", automated: "Automated", failing: "Failing", unlinked: "No requirement" }[f]}
                  <span className="count">{counts[f]}</span>
                </button>
              ))}
            </div>
          )}
          <span className="spacer" />
          {!compact && (
            <span className="faint kbd-hints" style={{ fontSize: "var(--fs-sm)", whiteSpace: "nowrap" }}>
              <Kbd>J</Kbd> <Kbd>K</Kbd> move · <Kbd>X</Kbd> select · <Kbd>↵</Kbd> open
            </span>
          )}
        </div>
        <div className="content" ref={listRef}>
          {isLoading ? <ListSkeleton /> : flat.length === 0 ? (
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
                      className={`list-row${selectedId === c.id ? " selected" : ""}${focus === idx ? " focused" : ""}${caseDrag?.includes(c.id) ? " dragging" : ""}`}
                      draggable
                      onDragStart={(e) => {
                        // Dragging a ticked case takes every ticked case with it.
                        const ids = checked.has(c.id) ? [...checked] : [c.id];
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", ids.length === 1 ? c.title : `${ids.length} cases`);
                        setCaseDrag(ids);
                      }}
                      onDragEnd={() => { setCaseDrag(null); setDrop(null); }}
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
                      <span className="title" title={c.tags.length ? `Tags: ${c.tags.join(", ")}` : undefined} style={c.status === "deprecated" ? { textDecoration: "line-through", color: "var(--text-3)" } : undefined}>
                        {c.title}
                      </span>
                      <span className="meta">
                        {!compact && c.status === "draft" && <span className="chip">Draft</span>}
                        {!!c.requirement_count && (
                          <span className="chip" title={`${c.requirement_count} linked requirement(s)`}><BookOpenCheck size={11} /> {c.requirement_count}{!compact && " req"}</span>
                        )}
                        {c.automated_count > 0 && (
                          <span className="chip accent" title={`${c.automated_count} automated test(s)`}>
                            <Bot size={11} /> {c.automated_count}{!compact && " auto"}
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
        <>
          <div className="detail-backdrop" onClick={() => select(null)} />
          <div className="detail-pane">
          <CaseEditor key={selectedId} caseId={selectedId} suites={suites} onClose={() => select(null)} onDeleted={() => select(null)} onDuplicated={(id) => select(id)} />
        </div>
        </>
      )}

      {newCase && (
        <NewCaseModal
          projectId={projectId}
          suites={suites}
          defaultSuite={typeof suiteFilter === "number" ? suiteFilter : null}
          requirementId={newFor}
          onClose={() => { setNewCase(false); setParam("newFor", null); }}
          onCreated={(id) => select(id)}
        />
      )}
      {suiteModal && <SuiteModal projectId={projectId} suites={suites} {...suiteModal} onClose={() => setSuiteModal(null)} />}
      {runModal && <NewRunModal initialCaseIds={[...checked]} onClose={() => setRunModal(false)} onCreated={() => setChecked(new Set())} />}
      {deleteModal && (
        <DeleteCasesModal
          cases={(cases ?? []).filter((c) => checked.has(c.id))}
          projectKey={project?.key ?? ""}
          backupOn={!!backupInfo?.auto.enabled}
          onClose={() => setDeleteModal(false)}
          onDone={(ids) => { setChecked(new Set()); if (selectedId != null && ids.includes(selectedId)) select(null); }}
        />
      )}
      {bulkModal && <BulkEditModal caseIds={[...checked]} suites={suites} allTags={[...new Set((cases ?? []).flatMap((c) => c.tags))].sort()} onClose={() => setBulkModal(false)} onDone={() => setChecked(new Set())} />}
      {linkModal && <LinkToRequirementModal caseIds={[...checked]} onClose={() => setLinkModal(false)} onDone={() => setChecked(new Set())} />}
      {templateModal && <TemplateModal initialCaseIds={[...checked]} onClose={() => setTemplateModal(false)} />}
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
  dragId: number | null;
  setDragId: (id: number | null) => void;
  drop: { id: number | "end" | "none"; zone: "before" | "after" | "into" } | null;
  setDrop: (d: { id: number | "end" | "none"; zone: "before" | "after" | "into" } | null) => void;
  onMove: (id: number, parentId: number | null, beforeId: number | null) => void;
  /** Cases being dragged from the list, if any: suites then accept them as a drop. */
  caseDrag: number[] | null;
  onDropCases: (suiteId: number) => void;
}) {
  const children = props.suites.filter((s) => s.parent_id === props.parentId);
  const { dragId, setDragId, drop, setDrop, onMove, suites } = props;

  // A suite can't be dropped on itself or anything inside it.
  const insideDragged = (id: number) => {
    for (let a: number | null = id; a != null; a = suites.find((x) => x.id === a)?.parent_id ?? null) if (a === dragId) return true;
    return false;
  };
  const zoneFor = (e: React.DragEvent<HTMLElement>): "before" | "after" | "into" => {
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    return y < 0.28 ? "before" : y > 0.72 ? "after" : "into";
  };
  const dropOn = (target: Suite, zone: "before" | "after" | "into") => {
    if (dragId == null) return;
    if (zone === "into") return onMove(dragId, target.id, null);
    const sibs = suites.filter((x) => x.parent_id === target.parent_id && x.id !== dragId);
    const i = sibs.findIndex((x) => x.id === target.id);
    onMove(dragId, target.parent_id, zone === "before" ? target.id : sibs[i + 1]?.id ?? null);
  };
  // Menu alternative to dragging: swap places with the neighbouring suite.
  const nudge = (s: Suite, dir: -1 | 1) => {
    const sibs = suites.filter((x) => x.parent_id === s.parent_id);
    const i = sibs.findIndex((x) => x.id === s.id);
    if (dir === -1) onMove(s.id, s.parent_id, sibs[i - 1]?.id ?? null);
    else onMove(s.id, s.parent_id, sibs[i + 2]?.id ?? null);
  };
  const [menu, setMenu] = useState<number | null>(null);
  return (
    <>
      {children.map((s) => (
        <div key={s.id} style={{ position: "relative" }}>
          <div
            role="button"
            tabIndex={0}
            className={`tree-item${props.active === s.id ? " active" : ""}${dragId === s.id ? " dragging" : ""}${drop?.id === s.id ? ` drop-${drop.zone}` : ""}`}
            style={{ paddingLeft: 8 + props.depth * 14 }}
            draggable
            onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", s.name); setDragId(s.id); }}
            onDragEnd={() => { setDragId(null); setDrop(null); }}
            onDragOver={(e) => {
              if (props.caseDrag != null) {
                e.preventDefault();
                e.stopPropagation();
                if (drop?.id !== s.id || drop.zone !== "into") setDrop({ id: s.id, zone: "into" });
                return;
              }
              if (dragId == null || insideDragged(s.id)) return;
              e.preventDefault();
              e.stopPropagation();
              const zone = zoneFor(e);
              if (drop?.id !== s.id || drop.zone !== zone) setDrop({ id: s.id, zone });
            }}
            onDrop={(e) => {
              if (props.caseDrag != null) {
                e.preventDefault();
                e.stopPropagation();
                props.onDropCases(s.id);
                return;
              }
              if (dragId == null || insideDragged(s.id)) return;
              e.preventDefault();
              e.stopPropagation();
              const zone = zoneFor(e);
              setDrop(null);
              dropOn(s, zone);
              setDragId(null);
            }}
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
                <button className="nav-item" disabled={children[0] === s} onClick={() => { setMenu(null); nudge(s, -1); }}><ArrowUp size={13} /> Move up</button>
                <button className="nav-item" disabled={children.at(-1) === s} onClick={() => { setMenu(null); nudge(s, 1); }}><ArrowDown size={13} /> Move down</button>
                <button className="nav-item" onClick={() => { setMenu(null); props.onDelete(s); }} style={{ color: "var(--failed-fg)" }}><Trash2 size={13} /> Delete</button>
              </div>
            </>
          )}
          <SuiteTree {...props} parentId={s.id} depth={props.depth + 1} />
        </div>
      ))}
    </>
  );
}

function NewCaseModal({ projectId, suites, defaultSuite, requirementId, onClose, onCreated }: {
  projectId: number; suites: Suite[]; defaultSuite: number | null; requirementId?: number | null; onClose: () => void; onCreated: (id: number) => void;
}) {
  const [title, setTitle] = useState("");
  const [suiteId, setSuiteId] = useState<number | null>(defaultSuite ?? suites[0]?.id ?? null);
  const [another, setAnother] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const create = useMutation({
    mutationFn: async () => {
      const created = await api.post<CaseDetail>(`/api/projects/${projectId}/cases`, { title, suiteId });
      // Started from a requirement: link the new case to it straight away.
      if (requirementId) {
        const req = await api.get<RequirementDetail>(`/api/requirements/${requirementId}`);
        await api.patch(`/api/requirements/${requirementId}`, { caseIds: [...req.cases.map((x) => x.id), created.id] });
        qc.invalidateQueries({ queryKey: ["requirements"] });
        qc.invalidateQueries({ queryKey: ["requirement"] });
      }
      return created;
    },
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
          <label className="row muted" style={{ marginRight: "auto", fontSize: "var(--fs-md)", cursor: "pointer" }}>
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
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Add steps, priority and tags after creating.</span>
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

/** Change several cases at once. Anything left on "Keep" is untouched; tags are added or removed, never replaced. */
function BulkEditModal({ caseIds, suites, allTags, onClose, onDone }: { caseIds: number[]; suites: Suite[]; allTags: string[]; onClose: () => void; onDone: () => void }) {
  const { pid } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [suite, setSuite] = useState("keep");
  const [priority, setPriority] = useState("keep");
  const [status, setStatus] = useState("keep");
  const [addTags, setAddTags] = useState("");
  const [removeTags, setRemoveTags] = useState("");
  const tags = (v: string) => v.split(",").map((t) => t.trim()).filter(Boolean);
  const depth = (s: Suite) => { let d = 0; for (let p = s.parent_id; p != null; p = suites.find((x) => x.id === p)?.parent_id ?? null) d++; return d; };

  const body = {
    ids: caseIds,
    ...(suite !== "keep" ? { suiteId: suite === "none" ? null : Number(suite) } : {}),
    ...(priority !== "keep" ? { priority } : {}),
    ...(status !== "keep" ? { status } : {}),
    ...(tags(addTags).length ? { addTags: tags(addTags) } : {}),
    ...(tags(removeTags).length ? { removeTags: tags(removeTags) } : {}),
  };
  const changes = Object.keys(body).length - 1;
  const save = useMutation({
    mutationFn: () => api.post<{ updated: number }>(`/api/projects/${pid}/cases/bulk`, body),
    onSuccess: (r) => {
      for (const k of ["cases", "suites", "case"]) qc.invalidateQueries({ queryKey: [k] });
      toast("success", `Updated ${r.updated} ${r.updated === 1 ? "case" : "cases"}`);
      onDone();
      onClose();
    },
    onError: (e: Error) => toast("error", e.message),
  });

  return (
    <Modal
      title={`Edit ${caseIds.length} ${caseIds.length === 1 ? "case" : "cases"}`}
      onClose={onClose}
      width={480}
      footer={<button className="btn primary" disabled={changes === 0 || save.isPending} onClick={() => save.mutate()}>Apply to {caseIds.length}</button>}
    >
      <div className="col" style={{ gap: 12 }}>
        <div className="field">
          <label htmlFor="be-suite">Suite</label>
          <select id="be-suite" className="select" value={suite} onChange={(e) => setSuite(e.target.value)}>
            <option value="keep">Keep</option>
            <option value="none">No suite</option>
            {orderSuites(suites).map((s) => <option key={s.id} value={s.id}>{"\u00a0\u00a0".repeat(depth(s))}{s.name}</option>)}
          </select>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <div className="field grow">
            <label htmlFor="be-priority">Priority</label>
            <select id="be-priority" className="select" value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="keep">Keep</option>
              {["critical", "high", "medium", "low"].map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
            </select>
          </div>
          <div className="field grow">
            <label htmlFor="be-status">Status</label>
            <select id="be-status" className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="keep">Keep</option>
              {["draft", "ready", "deprecated"].map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="be-add">Add tags</label>
          <input id="be-add" className="input" list="be-tags" placeholder="smoke, regression" value={addTags} onChange={(e) => setAddTags(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="be-remove">Remove tags</label>
          <input id="be-remove" className="input" list="be-tags" placeholder="old-tag" value={removeTags} onChange={(e) => setRemoveTags(e.target.value)} />
          <datalist id="be-tags">{allTags.map((t) => <option key={t} value={t} />)}</datalist>
          <span className="muted" style={{ fontSize: "var(--fs-sm)" }}>Separate several with commas. Existing tags on each case are kept.</span>
        </div>
      </div>
    </Modal>
  );
}

/** Confirms and performs a bulk delete. Five or more cases are saved to a backup first (the server does that when backups are on). */
function DeleteCasesModal({ cases, projectKey, backupOn, onClose, onDone }: {
  cases: CaseSummary[]; projectKey: string; backupOn: boolean; onClose: () => void; onDone: (ids: number[]) => void;
}) {
  const { pid } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const ids = cases.map((c) => c.id);
  const del = useMutation({
    mutationFn: () => api.post<{ deleted: number; backup: string | null; backupDir: string }>(`/api/projects/${pid}/cases/delete`, { ids }),
    onSuccess: (r) => {
      for (const k of ["cases", "suites", "projects", "requirements", "requirement", "automated", "dashboard", "case"]) qc.invalidateQueries({ queryKey: [k] });
      toast("success", `Deleted ${r.deleted} ${r.deleted === 1 ? "case" : "cases"}${r.backup ? `. A backup was saved first (${r.backup}).` : ""}`);
      onDone(ids);
      onClose();
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const n = cases.length;
  return (
    <ConfirmModal title={`Delete ${n} ${n === 1 ? "case" : "cases"}?`} confirmLabel={`Delete ${n} ${n === 1 ? "case" : "cases"}`} busy={del.isPending} onConfirm={() => del.mutate()} onClose={onClose}>
      <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2 }}>
        {cases.slice(0, 5).map((c) => <li key={c.id}><span className="mono muted">{projectKey}-{c.number}</span> {c.title}</li>)}
        {n > 5 && <li className="muted">and {n - 5} more</li>}
      </ul>
      <ul className="muted" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
        <li>Steps and links to requirements and run templates are removed.</li>
        <li>Results already recorded in past runs are kept, but lose their link to the case.</li>
        <li>Automated tests linked to them become unlinked.</li>
        <li><strong>This cannot be undone.</strong> {n >= 5 ? (backupOn ? "A backup is saved first, so you can restore it from Backup & restore." : "Automatic backups are off, so nothing is saved first.") : ""}</li>
      </ul>
    </ConfirmModal>
  );
}
