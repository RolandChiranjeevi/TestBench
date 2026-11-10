import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Archive, ArchiveRestore, BookOpenCheck, Bug, Check, ClipboardCheck, Download, ExternalLink, FileText, History, ImagePlus, Link2, Loader2, Paperclip, Play, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { api, formatViewport, KIND_LABEL, parseViewports, timeAgo, type CoverageState, type Priority, type Project, type Requirement, type RequirementKind, type RequirementAttachment, type RequirementDetail, type RequirementRevision, type RequirementStatus } from "../api";
import { Empty, Kbd, Modal, PriorityIcon, PRIORITY_LABEL, StatusIcon, rowActivation, useConfirm, useHotkeys, useToast, ListSkeleton } from "../components/ui";
import { CasePicker } from "../components/CasePicker";
import { Badge, CoverageBadge } from "../components/Badge";
import { Button, buttonClass } from "../components/Button";
import { FilterChip } from "../components/FilterChip";
import { COVERAGE_LOOK } from "../statuses";
import { OriginBadge, ORIGIN_LABEL, RecordedAs, whenText } from "../components/RequirementBits";
import { RequirementProposalsTab } from "./RequirementProposals";
import { CoverageGapsTab } from "./CoverageGaps";
import type { CoverageGaps, ProposalList, RequirementOrigin } from "../api";
import type { ReactNode } from "react";
import { jiraLabel, jiraUrl } from "./BugReport";
import { NewRunModal } from "./Runs";
import { EditScope, useCan } from "../components/Access";

export function CoverageChip({ coverage }: { coverage: Requirement["coverage"] }) {
  const detail = coverage.cases ? ` · ${coverage.passing}/${coverage.cases}` : "";
  return (
    <CoverageBadge value={coverage.state} label={`${COVERAGE_LOOK[coverage.state].label}${detail}`}
      title={`${coverage.cases} test case(s): ${coverage.passing} passing, ${coverage.failing} failing, ${coverage.notRun} not run`} />
  );
}

const STATUS_LABEL: Record<RequirementStatus, string> = { draft: "Draft", approved: "Approved", deprecated: "Deprecated" };
type Filter = "all" | "review" | CoverageState;
/** How a requirement stands with what the agent and people have produced. Only decisions by a person count as coverage. */
type Scope = "" | "no_test" | "open_bugs" | "not_in_run";
interface CoverageInfo {
  summary: { active: number; withoutTest: number; withOpenBugs: number; notInLatestRun: number; auditKnown: boolean };
  unresolved: { kind: "bug" | "manual_test"; id: number; title: string; raw: string; reason: string }[];
}
const WCAG_PATTERN = /^[1-4]\.\d{1,2}\.\d{1,2}$/;

type Tab = "requirements" | "proposals" | "gaps";

/**
 * Requirements, what a test agent proposes for new ones, and what is not covered yet. Proposals are not requirements until a person approves them, so they have
 * a tab of their own and never appear in the list.
 */
export function RequirementsPage() {
  const { pid } = useParams();
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: Tab = raw === "proposals" || raw === "gaps" ? raw : "requirements";
  const { data: proposals } = useQuery({ queryKey: ["requirement-proposals", pid, "badge"], queryFn: () => api.get<ProposalList>(`/api/projects/${pid}/requirement-proposals?status=proposed`) });
  const { data: gaps } = useQuery({ queryKey: ["coverage-gaps", pid], queryFn: () => api.get<CoverageGaps>(`/api/projects/${pid}/coverage-gaps`) });
  const go = (t: Tab) => setParams((p) => { const n = new URLSearchParams(p); n.delete("req"); if (t === "requirements") n.delete("tab"); else n.set("tab", t); return n; }, { replace: true });
  const gapTotal = gaps ? gaps.counts.requirementsWithoutCases + gaps.counts.casesWithoutRequirement + gaps.counts.observationsWithoutLink : null;
  const strip = (
    <div className="toolbar">
      <div className="tabs" role="tablist" aria-label="Requirements sections">
        {([["requirements", "Requirements", null], ["proposals", "Proposals", proposals?.counts.proposed ?? null], ["gaps", "Coverage gaps", gapTotal]] as const).map(([t, label, n]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab${tab === t ? " active" : ""}`} onClick={() => go(t)}>
            {label}{n != null && <span className="count">{n}</span>}
          </button>
        ))}
      </div>
    </div>
  );
  if (tab === "requirements") return <RequirementsList tabStrip={strip} />;
  return (
    <div className="split">
      <div className="pane grow" style={{ display: "flex", flexDirection: "column" }}>
        <div className="topbar"><h1>Requirements</h1></div>
        {strip}
        <div className="content">{tab === "proposals" ? <RequirementProposalsTab /> : <CoverageGapsTab />}</div>
      </div>
    </div>
  );
}

function RequirementsList({ tabStrip }: { tabStrip: ReactNode }) {
  const canEdit = useCan("tester");
  const { pid } = useParams();
  const projectId = Number(pid);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("req") ? Number(params.get("req")) : null;
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });
  const key = projects?.find((p) => p.id === projectId)?.key ?? "";
  const { data: reqs = [], isLoading } = useQuery({ queryKey: ["requirements", pid], queryFn: () => api.get<Requirement[]>(`/api/projects/${pid}/requirements`) });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [kind, setKind] = useState<"" | RequirementKind>("");
  const [statusF, setStatusF] = useState<"" | RequirementStatus>("");
  const [originF, setOriginF] = useState<"" | RequirementOrigin>("");
  const [priorityF, setPriorityF] = useState<"" | Priority>("");
  const [scope, setScope] = useState<Scope>("");
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [approving, setApproving] = useState(false);
  const { data: cov } = useQuery({ queryKey: ["requirement-coverage", pid], queryFn: () => api.get<CoverageInfo>(`/api/projects/${pid}/requirements/coverage`) });
  const searchRef = useRef<HTMLInputElement>(null);

  const select = (id: number | null) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (id == null) n.delete("req");
      else n.set("req", String(id));
      return n;
    }, { replace: true });

  useHotkeys({ c: (e) => { e.preventDefault(); if (canEdit) setCreating(true); }, "/": (e) => { e.preventDefault(); searchRef.current?.focus(); } }, !creating);

  const active = reqs.filter((r) => r.status !== "deprecated");
  const importedDrafts = reqs.filter((r) => r.origin === "import" && r.status === "draft");
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
      if (kind && r.kind !== kind) return false;
      if (statusF && r.status !== statusF) return false;
      if (originF && r.origin !== originF) return false;
      if (priorityF && r.priority !== priorityF) return false;
      if (scope && (r.status !== "approved" || (scope === "no_test" ? !r.links.withoutTest : scope === "open_bugs" ? r.links.bugs.open === 0 : r.links.audit !== "not_referenced"))) return false;
      if (filter === "review" ? r.status === "deprecated" || r.reviewCount === 0 : filter !== "all" && (r.status === "deprecated" || r.coverage.state !== filter)) return false;
      return !q || `REQ-${r.number} ${r.title} ${r.source} ${r.description}`.toLowerCase().includes(q);
    });
  }, [reqs, search, filter, kind, scope, statusF, originF, priorityF]);
  const compact = selectedId != null;
  const anyFilter = !!(statusF || originF || priorityF || filter !== "all" || kind || scope);
  const clearFilters = () => { setStatusF(""); setOriginF(""); setPriorityF(""); setFilter("all"); setKind(""); setScope(""); };

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
          <a className={buttonClass("secondary", undefined, true)} href={`/api/projects/${pid}/agent/requirements?download=1`} title="Download the active requirements as a file for a test agent (read-only)" aria-label="Download requirements for the agent"><Download size={14} /></a>
          <Button needs="tester" onClick={() => setImporting(true)}><Upload size={14} /> Import</Button>
          <Button needs="tester" variant="primary" onClick={() => setCreating(true)}><Plus size={14} /> New requirement <Kbd>C</Kbd></Button>
        </div>
        {tabStrip}
        {importedDrafts.length > 0 && (
          <div className="toolbar" style={{ gap: 8 }} role="status">
            <Upload size={14} aria-hidden="true" />
            <span>{importedDrafts.length} imported requirement{importedDrafts.length === 1 ? " is a draft" : "s are drafts"}: not counted until you approve {importedDrafts.length === 1 ? "it" : "them"}.</span>
            <Button needs="tester" variant="primary" size="sm" onClick={() => setApproving(true)}>Review and approve {importedDrafts.length} requirement{importedDrafts.length === 1 ? "" : "s"}</Button>
          </div>
        )}
        {cov && cov.summary.active > 0 && (
          <div className="toolbar" style={{ gap: 8 }} aria-label="Coverage of active requirements">
            <span className="faint" style={{ whiteSpace: "nowrap" }}>{cov.summary.active} active</span>
            <FilterChip pressed={scope === "no_test"} onClick={() => setScope(scope === "no_test" ? "" : "no_test")} title="No test case is linked, and no accepted agent proposal">{cov.summary.withoutTest} without a test</FilterChip>
            <FilterChip pressed={scope === "open_bugs"} onClick={() => setScope(scope === "open_bugs" ? "" : "open_bugs")} title="An accepted bug report names the requirement"><Bug size={11} /> {cov.summary.withOpenBugs} with open bugs</FilterChip>
            {cov.summary.auditKnown && <FilterChip pressed={scope === "not_in_run"} onClick={() => setScope(scope === "not_in_run" ? "" : "not_in_run")} title="No bug report or agent proposal of the latest run of an audit names the requirement"><ClipboardCheck size={11} /> {cov.summary.notInLatestRun} not in latest audit run</FilterChip>}
            <span className="spacer" />
            <select className="select" style={{ width: "auto" }} aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as "" | RequirementKind)}>
              <option value="">Kind: any</option>
              {(Object.keys(KIND_LABEL) as RequirementKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </div>
        )}
        {!!cov?.unresolved.length && (
          <details className="card" style={{ margin: "8px 20px", padding: 10 }}>
            <summary style={{ cursor: "pointer" }}><AlertTriangle size={13} /> {cov.unresolved.length} reference{cov.unresolved.length === 1 ? "" : "s"} to requirements that do not exist in this project</summary>
            <div style={{ fontSize: "var(--fs-md)", marginTop: 6, display: "grid", gap: 2 }}>
              {cov.unresolved.map((u, i) => (
                <div key={i}><span className="mono">{u.raw}</span> in {u.kind === "bug" ? "bug report" : "agent proposal"} “{u.title}” <span className="faint">— {u.reason}</span></div>
              ))}
            </div>
          </details>
        )}
        <div className="toolbar" style={{ gap: 8, flexWrap: "wrap", height: "auto", minHeight: 42, padding: "6px 16px 6px 20px" }} role="group" aria-label="Filter requirements">
          <select className="select" style={{ width: "auto" }} aria-label="Status" value={statusF} onChange={(e) => setStatusF(e.target.value as "" | RequirementStatus)}>
            <option value="">Status: any</option>
            {(Object.keys(STATUS_LABEL) as RequirementStatus[]).map((v) => <option key={v} value={v}>{STATUS_LABEL[v]}</option>)}
          </select>
          <select className="select" style={{ width: "auto" }} aria-label="Origin" value={originF} onChange={(e) => setOriginF(e.target.value as "" | RequirementOrigin)}>
            <option value="">Origin: any</option>
            {(Object.keys(ORIGIN_LABEL) as RequirementOrigin[]).map((v) => <option key={v} value={v}>{ORIGIN_LABEL[v]}</option>)}
          </select>
          <select className="select" style={{ width: "auto" }} aria-label="Priority" value={priorityF} onChange={(e) => setPriorityF(e.target.value as "" | Priority)}>
            <option value="">Priority: any</option>
            {(["critical", "high", "medium", "low"] as const).map((v) => <option key={v} value={v}>{PRIORITY_LABEL[v]}</option>)}
          </select>
          <select className="select" style={{ width: "auto" }} aria-label="Coverage" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            <option value="all">Coverage: any</option>
            <option value="uncovered">No test cases ({counts.uncovered})</option>
            <option value="failing">Failing ({counts.failing})</option>
            <option value="partial">Partly passing ({counts.partial})</option>
            <option value="untested">Not run ({counts.untested})</option>
            <option value="passing">Passing ({counts.passing})</option>
            <option value="review">Needs review ({counts.review})</option>
          </select>
          <span className="spacer" />
          {anyFilter && <Button variant="ghost" size="sm" onClick={clearFilters}>Clear filters</Button>}
          <span className="faint" style={{ whiteSpace: "nowrap" }} aria-live="polite">{visible.length} of {reqs.length}</span>
        </div>
        <div className="content">
          {isLoading ? <ListSkeleton /> : visible.length === 0 ? (
            reqs.length ? (
              <Empty icon={<Search size={20} />} title="No matching requirements">Try a different search or filter.</Empty>
            ) : (
              <Empty icon={<BookOpenCheck size={20} />} title="No requirements yet" action={<Button needs="tester" variant="primary" onClick={() => setCreating(true)}><Plus size={14} /> New requirement</Button>}>
                Write down what the system should do, then link the test cases that prove it. Reports show which requirements are covered and which are failing.
              </Empty>
            )
          ) : (
            visible.map((r) => (
              <div key={r.id} className={`list-row${selectedId === r.id ? " selected" : ""}`} {...rowActivation(() => select(r.id), selectedId === r.id)}>
                <PriorityIcon priority={r.priority} />
                <span className="id mono">REQ-{r.number}</span>
                <span className="title" style={r.status === "deprecated" ? { textDecoration: "line-through", color: "var(--text-3)" } : undefined}>{r.title}</span>
                <span className="meta">
                  {!compact && r.source && <span className="faint mono" style={{ fontSize: "var(--fs-sm)" }}>{jiraLabel(r.source)}</span>}
                  {r.status === "draft" && <span className="chip">Draft</span>}
                  {(!compact || r.origin !== "human") && <OriginBadge origin={r.origin} />}
                  {!compact && r.kind !== "functional" && <span className="chip" title={r.wcag.length ? `WCAG ${r.wcag.join(", ")}` : undefined}>{KIND_LABEL[r.kind]}{r.wcag.length ? ` · WCAG ${r.wcag.length > 2 ? `${r.wcag.slice(0, 2).join(", ")}…` : r.wcag.join(", ")}` : ""}</span>}
                  {r.status === "approved" && r.links.bugs.open > 0 && <Badge tone="fail" icon="bug" title="Accepted bug reports name this requirement">{r.links.bugs.open} open</Badge>}
                  {!compact && r.status === "approved" && r.links.manualTests.accepted + r.links.manualTests.proposed > 0 && <span className="chip" title={`${r.links.manualTests.accepted} accepted and ${r.links.manualTests.proposed} not yet reviewed agent proposal(s)`}><ClipboardCheck size={11} /> {r.links.manualTests.accepted}{r.links.manualTests.proposed ? ` +${r.links.manualTests.proposed}` : ""}</span>}
                  {!compact && r.status === "approved" && r.links.audit === "not_referenced" && <span className="chip" title="Not named by the latest run of any audit">Not in latest run</span>}
                  {r.attachmentCount > 0 && <span className="chip" title={`${r.attachmentCount} attachment(s)`}><Paperclip size={11} /> {r.attachmentCount}</span>}
                  {r.status !== "deprecated" && r.reviewCount > 0 && (
                    <Badge tone="accent" icon="eye" title={`${r.reviewCount} linked case(s) to check after the wording changed`}>{r.reviewCount} to review</Badge>
                  )}
                  {r.status !== "deprecated" && (r.coverage.state === "uncovered" && r.links.manualTests.accepted > 0
                    ? <Badge tone="warn" icon="circle-check" title="No test case is linked yet. An agent proposal is accepted: create a test case from it to run it">Proposal accepted</Badge>
                    : <CoverageChip coverage={r.coverage} />)}
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
      {importing && <ImportRequirementsModal pid={pid!} onClose={() => setImporting(false)} />}
      {approving && <ApproveImportedModal pid={pid!} drafts={importedDrafts} onClose={() => setApproving(false)} />}
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
    qc.invalidateQueries({ queryKey: ["requirement-coverage", pid] });
    qc.invalidateQueries({ queryKey: ["coverage-gaps", pid] });
    qc.invalidateQueries({ queryKey: ["cases", pid] });
    qc.invalidateQueries({ queryKey: ["case"] });
    qc.invalidateQueries({ queryKey: ["dashboard", pid] });
  };
}

function NewRequirementModal({ projectId, onClose, onCreated }: { projectId: number; onClose: () => void; onCreated: (id: number) => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [criteria, setCriteria] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [startAs, setStartAs] = useState<"approved" | "draft">("approved");
  const toast = useToast();
  const invalidate = useInvalidate();
  const create = useMutation({
    mutationFn: () => api.post<RequirementDetail>(`/api/projects/${projectId}/requirements`, { title, description, acceptanceCriteria: criteria, priority, status: startAs }),
    onSuccess: (r) => { invalidate(); toast("success", `Created REQ-${r.number}`); onClose(); onCreated(r.id); },
    onError: (e: Error) => toast("error", e.message),
  });
  const submit = () => title.trim() && !create.isPending && create.mutate();
  return (
    <Modal
      title={<span className="chip">New requirement</span>}
      onClose={onClose}
      footer={<Button needs="tester" variant="primary" disabled={!title.trim() || create.isPending} onClick={submit}>Create requirement</Button>}
    >
      <div className="col" style={{ gap: 12 }}>
        <input className="bare title-input" autoFocus placeholder="e.g. A customer can pay with a saved card" aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        <div className="field">
          <label htmlFor="nr-desc">Description</label>
          <textarea id="nr-desc" className="textarea" rows={3} value={description} placeholder="What should the system do?" onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="nr-crit">Acceptance criteria</label>
          <textarea id="nr-crit" className="textarea" rows={3} value={criteria} placeholder="One per line. How do we know it is met?" onChange={(e) => setCriteria(e.target.value)} />
        </div>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div className="field">
            <label htmlFor="nr-pri">Priority</label>
            <select id="nr-pri" className="select" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {(["critical", "high", "medium", "low"] as const).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="nr-start">Start as</label>
            <select id="nr-start" className="select" value={startAs} onChange={(e) => setStartAs(e.target.value as "approved" | "draft")}>
              <option value="approved">Approved: I approve it now</option>
              <option value="draft">Draft: not approved yet</option>
            </select>
          </div>
        </div>
        <RecordedAs what={startAs === "approved" ? "Created and approved as" : "Created as"} />
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Link test cases after creating.</span>
      </div>
    </Modal>
  );
}

function RequirementEditor({ id, caseKey, onClose }: { id: number; caseKey: string; onClose: () => void }) {
  const confirm = useConfirm();
  const { pid } = useParams();
  const toast = useToast();
  const invalidate = useInvalidate();
  const { data } = useQuery({ queryKey: ["requirement", id], queryFn: () => api.get<RequirementDetail>(`/api/requirements/${id}`) });
  const [linking, setLinking] = useState(false);
  const [running, setRunning] = useState(false);
  const [edits, setEdits] = useState<Partial<Pick<RequirementDetail, "title" | "description" | "source" | "acceptance_criteria">>>({});
  const [more, setMore] = useState<{ externalId?: string; wcag?: string; viewports?: string }>({});

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
  const deprecate = useMutation({
    mutationFn: () => api.post<RequirementDetail>(`/api/requirements/${id}/deprecate`, {}),
    onSuccess: () => { invalidate(); toast("success", "Deprecated. It stays, with its links and history."); },
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
  const wcagText = more.wcag ?? data.wcag.join(", ");
  const viewportText = more.viewports ?? data.viewports.map(formatViewport).join("\n");
  const idText = more.externalId ?? data.external_id ?? "";
  const commitMore = () => {
    const body: Record<string, unknown> = {};
    if (more.externalId !== undefined && more.externalId.trim() !== (data.external_id ?? "")) body.externalId = more.externalId.trim() || null;
    if (more.wcag !== undefined) {
      const list = more.wcag.split(/[,\s]+/).filter(Boolean);
      if (list.some((c) => !WCAG_PATTERN.test(c))) { toast("error", "A WCAG criterion looks like 2.4.3"); return; }
      if (list.join(",") !== data.wcag.join(",")) body.wcag = list;
    }
    if (more.viewports !== undefined && more.viewports.trim() !== data.viewports.map(formatViewport).join("\n").trim()) body.viewports = parseViewports(more.viewports);
    setMore({});
    if (Object.keys(body).length) save.mutate(body);
  };
  const criteria = edits.acceptance_criteria ?? data.acceptance_criteria;
  const commitCriteria = () => {
    const v = edits.acceptance_criteria;
    if (v === undefined || v === data.acceptance_criteria) return;
    save.mutate({ acceptanceCriteria: v });
    setEdits((e) => ({ ...e, acceptance_criteria: undefined }));
  };
  const archived = data.status === "deprecated";

  return (
    <div>
      <div className="toolbar">
        <span className="mono muted">REQ-{data.number}</span>
        <CoverageChip coverage={data.coverage} />
        <span className="spacer" />
        {archived ? (
          <Button needs="tester" variant="ghost" size="sm" title="Make it an approved requirement again. You become the approver." onClick={() => save.mutate({ status: "approved" })}><ArchiveRestore size={13} /> Restore</Button>
        ) : (
          <Button needs="tester" variant="ghost" size="sm" title="Retire it: it stays, with its links and history, but is no longer an active requirement"
            onClick={async () => (await confirm({ title: `Deprecate REQ-${data.number}?`, body: <p style={{ margin: 0 }}>It stays, with its test case links and history, but stops counting as an active requirement: it leaves coverage and what a test agent reads. You can restore it later.</p>, confirmLabel: "Deprecate" })) && deprecate.mutate()}>
            <Archive size={13} /> Deprecate
          </Button>
        )}
        <Button needs="admin" variant="danger" size="sm" icon title="Delete requirement" aria-label="Delete requirement" onClick={async () => (await confirm({ title: `Delete REQ-${data.number}?`, body: <p style={{ margin: 0 }}>The test cases stay, only the links are removed.</p>, confirmLabel: "Delete requirement" })) && remove.mutate()}><Trash2 size={14} /></Button>
        <Button variant="ghost" size="sm" icon onClick={onClose} title="Close" aria-label="Close"><X size={14} /></Button>
      </div>
      <div style={{ padding: "20px 28px 40px", display: "flex", flexDirection: "column", gap: 18 }}>
        <EditScope>
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
          <label className="pill" title="What the requirement is about">
            {KIND_LABEL[data.kind]}
            <select value={data.kind} onChange={(e) => save.mutate({ kind: e.target.value })} aria-label="Kind">
              {(Object.keys(KIND_LABEL) as RequirementKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
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
          <div className="section-label">Origin</div>
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            <OriginBadge origin={data.origin} />
            <span className="muted">Created by <b>{data.created_by || "unknown"}</b> {whenText(data.created_at)}</span>
            {data.approved_by ? <span className="muted">Approved by <b>{data.approved_by}</b>{data.approved_at ? ` ${whenText(data.approved_at)}` : ""}</span> : <span className="faint">{data.status === "draft" ? "Not approved yet" : "No approver recorded"}</span>}
          </div>
          <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>With accounts the names are those of the accounts people are signed in with. Without accounts they are the display names set in Settings, as typed. Neither is checked against a real person.</span>
        </section>
        <section>
          <div className="section-label">Description</div>
          <textarea className="bare" style={{ minHeight: 60, fieldSizing: "content" } as React.CSSProperties} value={text("description")} placeholder="What should the system do?"
            aria-label="Description" onChange={(e) => setEdits((s) => ({ ...s, description: e.target.value }))} onBlur={() => commit("description")} />
        </section>
        <section>
          <div className="section-label">Acceptance criteria</div>
          <textarea className="bare" style={{ minHeight: 48, fieldSizing: "content" } as React.CSSProperties} value={criteria} placeholder="One per line. How do we know it is met?"
            aria-label="Acceptance criteria" onChange={(e) => setEdits((s) => ({ ...s, acceptance_criteria: e.target.value }))} onBlur={commitCriteria} />
        </section>
        {(data.kind === "accessibility" || data.kind === "responsive") && (
          <section>
            <div className="section-label">{data.kind === "accessibility" ? "WCAG criteria and viewports" : "Viewports, devices and breakpoints"}</div>
            {data.kind === "accessibility" && <input className="input" style={{ marginBottom: 6 }} value={wcagText} placeholder="WCAG success criteria, e.g. 2.4.3, 1.3.2" aria-label="WCAG criteria" onChange={(e) => setMore((m) => ({ ...m, wcag: e.target.value }))} onBlur={commitMore} />}
            <textarea className="textarea" rows={2} value={viewportText} placeholder={"One per line: 390x844 iPhone 13, 320, bp:md"} aria-label="Viewports" onChange={(e) => setMore((m) => ({ ...m, viewports: e.target.value }))} onBlur={commitMore} />
          </section>
        )}
        <section>
          <div className="section-label">Stable id</div>
          <input className="input" value={idText} placeholder="e.g. CHK-001. Used when requirements are imported and exported" aria-label="Stable id" onChange={(e) => setMore((m) => ({ ...m, externalId: e.target.value }))} onBlur={commitMore} />
        </section>
        <section>
          <div className="section-label">Source</div>
          <div className="row">
            <input className="input grow" value={text("source")} placeholder="Jira story key or link, e.g. SHOP-123" aria-label="Source"
              onChange={(e) => setEdits((s) => ({ ...s, source: e.target.value }))} onBlur={() => commit("source")} />
            {link && <a className={buttonClass("secondary", "sm")} href={link} target="_blank" rel="noreferrer"><ExternalLink size={12} /> {jiraLabel(data.source)}</a>}
          </div>
        </section>
        <section>
          <div className="section-label"><Paperclip size={13} /> Attachments <span className="faint">{data.attachments.length}</span></div>
          <AttachmentsSection requirementId={data.id} attachments={data.attachments} />
        </section>
        {data.cases.some((c) => c.review_needed) && (
          <div className="card" style={{ padding: "12px 12px", borderColor: "var(--blocked)", display: "flex", gap: 12, alignItems: "center" }}>
            <span className="grow" style={{ fontSize: "var(--fs-md)" }}>
              The wording changed after {data.cases.filter((c) => c.review_needed).length} linked {data.cases.filter((c) => c.review_needed).length === 1 ? "case was" : "cases were"} written or last checked. Make sure they still test the right thing.
            </span>
            <Button needs="tester" size="sm" onClick={() => review.mutate(undefined)} disabled={review.isPending}><Check size={12} /> All still correct</Button>
          </div>
        )}
        <section>
          <div className="section-label"><ClipboardCheck size={13} /> Agent proposals <span className="faint">{data.linked.manualTests.length}</span></div>
          {data.linked.manualTests.length === 0 ? <div className="muted" style={{ fontSize: "var(--fs-md)" }}>No agent proposal names this requirement. A test agent can propose a manual test in an audit package (refs.requirements).</div> : (
            <div className="card">
              {data.linked.manualTests.map((m) => (
                <Link key={m.id} to={`/p/${pid}/manual-tests?test=${m.id}`} className="row" style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", color: "inherit" }}>
                  <span className="mono muted" style={{ width: 120 }}>{m.sourceId}</span>
                  <span className="truncate grow">{m.title}</span>
                  {m.testCase && <span className="chip" title="The test case made from it, run in Runs">{m.testCase}</span>}
                  <span className="chip">{m.status}</span>
                </Link>
              ))}
            </div>
          )}
          <div className="faint" style={{ fontSize: "var(--fs-sm)", marginTop: 4 }}>A proposal only counts once you accept it. Create a test case from it to run it; the test case, with its results, is what shows how well the requirement is tested.</div>
        </section>
        <section>
          <div className="section-label"><Bug size={13} /> Bug reports <span className="faint">{data.linked.bugs.length}</span></div>
          {data.linked.bugs.length === 0 ? <div className="muted" style={{ fontSize: "var(--fs-md)" }}>No bug report names this requirement.</div> : (
            <div className="card">
              {data.linked.bugs.map((b) => (
                <Link key={b.id} to={`/p/${pid}/bugs?bug=${b.id}`} className="row" style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", color: "inherit" }}>
                  <span className="mono muted" style={{ width: 120 }}>{b.sourceId}</span>
                  <span className="truncate grow">{b.title}</span>
                  <span className="chip">{b.status}</span>
                </Link>
              ))}
            </div>
          )}
          <div className="faint" style={{ fontSize: "var(--fs-sm)", marginTop: 4 }}>Only accepted bug reports count as open.</div>
        </section>
        <section>
          <div className="section-label"><ClipboardCheck size={13} /> Planned in audits <span className="faint">{data.linked.planItems.length}</span></div>
          {data.linked.planItems.length === 0 ? <div className="muted" style={{ fontSize: "var(--fs-md)" }}>No audit plan names this requirement.</div> : (
            <div className="card">
              {data.linked.planItems.map((x) => (
                <div key={`${x.auditId}-${x.sourceId}`} className="row" style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", gap: 8, flexWrap: "wrap" }}>
                  <span className="mono muted" style={{ width: 120 }}>{x.sourceId}</span>
                  <span className="grow" style={{ overflowWrap: "anywhere" }}>{x.title}</span>
                  {x.type && <span className="chip">{x.type}</span>}
                  <span className="faint" title={x.auditTitle || x.agentAuditId}>{x.agentAuditId}</span>
                </div>
              ))}
            </div>
          )}
          <div className="faint" style={{ fontSize: "var(--fs-sm)", marginTop: 4 }}>A plan item says what an audit planned to check. It is not a test: it does not make this requirement covered.</div>
        </section>
        <section>
          <div className="section-label"><AlertTriangle size={13} /> Coverage gaps <span className="faint">{data.linked.coverageGaps.length}</span></div>
          {data.linked.coverageGaps.length === 0 ? <div className="muted" style={{ fontSize: "var(--fs-md)" }}>No audit reports a coverage gap for this requirement.</div> : (
            <div className="card">
              {data.linked.coverageGaps.map((g) => (
                <div key={`${g.auditId}-${g.sourceId}`} style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
                  <div className="row" style={{ gap: 8 }}><span className="mono muted">{g.sourceId}</span><span className="faint" title={g.auditTitle || g.agentAuditId}>{g.agentAuditId}</span></div>
                  <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{g.description}</div>
                </div>
              ))}
            </div>
          )}
          <div className="faint" style={{ fontSize: "var(--fs-sm)", marginTop: 4 }}>What an audit did not verify about this requirement, and why.</div>
        </section>
        <section>
          <div className="section-label">Test cases <span className="faint">{data.cases.length}</span></div>
          {data.cases.length === 0 ? (
            <div className="muted" style={{ fontSize: "var(--fs-md)", marginBottom: 8 }}>No test cases linked yet. This requirement is not covered.</div>
          ) : (
            <div className="card">
              {data.cases.map((c) => (
                <Link key={c.id} to={`/p/${pid}/cases?case=${c.id}`} className="row" style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", color: "inherit", textDecoration: c.status === "deprecated" ? "line-through" : undefined }}>
                  <StatusIcon status={c.last_status} />
                  <span className="mono muted key-col">{caseKey}-{c.number}</span>
                  <span className="truncate grow">{c.title}</span>
                  {c.status === "deprecated" && <span className="chip">Deprecated</span>}
                  {c.review_needed && (
                    <Button needs="tester" size="sm" title="Mark as still matching the requirement" onClick={(e) => { e.preventDefault(); e.stopPropagation(); review.mutate([c.id]); }}>Review</Button>
                  )}
                </Link>
              ))}
            </div>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <Button needs="tester" size="sm" onClick={() => setLinking(true)}><Link2 size={13} /> Link test cases</Button>
            <Link className={buttonClass("ghost", "sm")} to={`/p/${pid}/cases?newFor=${data.id}`}>Write a new case</Link>
            <span className="spacer" />
            <Button needs="tester" size="sm" disabled={!data.cases.some((c) => c.status !== "deprecated")} onClick={() => setRunning(true)}><Play size={12} /> Start run</Button>
          </div>
        </section>
        <section>
          <div className="section-label"><History size={13} /> History <span className="faint">{data.history.length}</span></div>
          <div className="col" style={{ gap: 8 }}>
            {data.history.map((h) => <RevisionRow key={h.id} rev={h} caseKey={caseKey} />)}
          </div>
        </section>
        </EditScope>
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
      footer={<Button needs="tester" variant="primary" disabled={saving} onClick={() => onSave([...selected])}>Save {selected.size} linked</Button>}>
      <CasePicker selected={selected} onChange={setSelected} />
    </Modal>
  );
}

const FIELD_LABEL: Record<string, string> = { title: "Title", description: "Description", priority: "Priority", status: "Status", source: "Source", kind: "Kind", id: "Stable id", wcag: "WCAG criteria", viewports: "Viewports" };

function RevisionRow({ rev, caseKey }: { rev: RequirementRevision; caseKey: string }) {
  const keys = (nums: number[]) => nums.map((n) => `${caseKey}-${n}`).join(", ");
  return (
    <div style={{ fontSize: "var(--fs-md)" }}>
      <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>{rev.by || "unknown"} · {timeAgo(rev.at.replace(" ", "T") + "Z")}{rev.material && " · wording changed"}</div>
      {rev.changes.map((c, i) => (
        <div key={i}>
          {c.field === "created" && <>Created{c.to ? <span className="muted"> ({c.to})</span> : null}</>}
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
          {c.field === "acceptance criteria" && (
            <details>
              <summary style={{ cursor: "pointer" }}>Acceptance criteria edited</summary>
              <div className="muted" style={{ whiteSpace: "pre-wrap" }}>Before: {c.from || "(empty)"}</div>
              <div style={{ whiteSpace: "pre-wrap" }}>After: {c.to || "(empty)"}</div>
            </details>
          )}
          {!(c.field in FIELD_LABEL) && !["created", "cases", "attachments", "description", "acceptance criteria"].includes(c.field) && (
            <>{c.field}: {c.from ? <><span className="muted">{c.from}</span> → </> : null}{c.to || "(empty)"}</>
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
      footer={<Button needs="tester" variant="primary" disabled={picked == null || link.isPending} onClick={() => link.mutate()}>Link</Button>}>
      {open.length === 0 ? (
        <div className="muted">No requirements yet. Add some on the Requirements page first.</div>
      ) : (
        <div className="card" style={{ maxHeight: 340, overflow: "auto" }}>
          {open.map((r) => (
            <label key={r.id} className="list-row" style={{ height: 32, padding: "0 12px" }}>
              <input type="radio" name="req" checked={picked === r.id} onChange={() => setPicked(r.id)} />
              <PriorityIcon priority={r.priority} />
              <span className="mono muted key-col">REQ-{r.number}</span>
              <span className="title">{r.title}</span>
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** After an import: the drafts it made, to read through and approve, all or the ones ticked. Approving records the person (and their account) as the approver. */
function ApproveImportedModal({ pid, drafts, onClose }: { pid: string; drafts: Requirement[]; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [picked, setPicked] = useState<Set<number>>(() => new Set(drafts.map((r) => r.id)));
  const toggle = (id: number) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const approve = useMutation({
    mutationFn: () => api.post<{ approved: number }>(`/api/projects/${pid}/requirements/approve-imported`, { ids: [...picked] }),
    onSuccess: (r) => { invalidate(); toast("success", `Approved ${r.approved} requirement${r.approved === 1 ? "" : "s"}`); onClose(); },
    onError: (e: Error) => toast("error", e.message),
  });
  return (
    <Modal title="Review and approve imported requirements" onClose={onClose} width={720}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button needs="tester" variant="primary" disabled={!picked.size || approve.isPending} onClick={() => approve.mutate()}>{approve.isPending ? "Approving…" : `Approve ${picked.size} requirement${picked.size === 1 ? "" : "s"}`}</Button></>}>
      <div className="col" style={{ gap: 12 }}>
        <div className="muted">
          These came from an import and are drafts. Approving makes them requirements: they count for coverage, and a test agent reads them. You are recorded as the approver.
          Leave out any you do not want yet; they stay drafts, and you can edit them first.
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Button size="sm" onClick={() => setPicked(new Set(drafts.map((r) => r.id)))}>Select all</Button>
          <Button size="sm" onClick={() => setPicked(new Set())}>Select none</Button>
          <span className="faint">{picked.size} of {drafts.length} selected</span>
        </div>
        <div className="card" style={{ maxHeight: 340, overflow: "auto" }}>
          {drafts.map((r) => (
            <label key={r.id} className="list-row" style={{ height: 32, padding: "0 12px" }}>
              <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Approve REQ-${r.number} ${r.title}`} />
              <PriorityIcon priority={r.priority} />
              <span className="mono muted key-col">REQ-{r.number}</span>
              <span className="title truncate" title={r.title}>{r.title}</span>
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/** Import requirements from a JSON file: a preview first, nothing is written until it is confirmed. */
function ImportRequirementsModal({ pid, onClose }: { pid: string; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [content, setContent] = useState<string | null>(null);
  const [name, setName] = useState("");
  const preview = useMutation({ mutationFn: (text: string) => api.post<ImportPreview>(`/api/projects/${pid}/requirements/import?dryRun=1`, { content: text }) });
  const doImport = useMutation({
    mutationFn: () => api.post<ImportPreview>(`/api/projects/${pid}/requirements/import`, { content, fileName: name }),
    onSuccess: (s) => { invalidate(); toast("success", `Imported: ${s.counts.new} new${s.asDrafts ? ` (${s.asDrafts} as drafts)` : ""}, ${s.counts.updated} updated, ${s.counts.unchanged} unchanged`); onClose(); },
    onError: (e: Error) => toast("error", e.message),
  });
  const choose = async (f: File | undefined) => {
    if (!f) return;
    const text = await f.text();
    setContent(text);
    setName(f.name);
    preview.mutate(text);
  };
  const s = preview.data;
  const problems = ((preview.error as (Error & { problems?: string[] }) | null)?.problems) ?? [];
  return (
    <Modal title="Import requirements" onClose={onClose} width={720}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button needs="tester" variant="primary" disabled={!s || doImport.isPending || (s.counts.new + s.counts.updated === 0)} onClick={() => doImport.mutate()}>{doImport.isPending ? "Importing…" : "Import"}</Button></>}>
      <div className="col" style={{ gap: 12 }}>
        <div className="faint">A JSON file with <code className="inline">"format": "testbench-requirements"</code>, <code className="inline">"project"</code> (this project's key) and <code className="inline">"requirements"</code>. Each has a stable <code className="inline">id</code>: the same id is updated, a new id is added, and requirements that are not in the file are left alone.</div>
        <div className="row">
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
          <Button onClick={() => fileRef.current?.click()}><Upload size={13} /> Choose a file</Button>
          {name && <span className="faint">{name}</span>}
        </div>
        {preview.isPending && <ListSkeleton rows={2} />}
        {preview.error && (
          <div role="alert" style={{ color: "var(--failed-fg)" }}>
            {(preview.error as Error).message}
            {problems.length > 0 && <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
          </div>
        )}
        {s && (
          <div className="col" style={{ gap: 8 }}>
            <div className="card" style={{ padding: 12 }}>
              {s.counts.new} new · {s.counts.updated} updated · {s.counts.unchanged} unchanged · {s.untouched} existing requirement{s.untouched === 1 ? "" : "s"} not in the file (left as they are)
              {s.asDrafts > 0 && <div style={{ marginTop: 6 }}><strong>{s.asDrafts} new requirement{s.asDrafts === 1 ? " is" : "s are"} added as drafts.</strong> An import never approves: you review and approve them afterwards, on this page.</div>}
            </div>
            <div style={{ maxHeight: 280, overflow: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
              {s.items.map((i) => (
                <div key={i.id} style={{ padding: "6px 10px", borderBottom: "1px solid var(--border)" }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="chip">{i.action === "update" ? "updated" : i.action}</span>
                    <span className="mono faint">{i.matches ?? i.id}</span>
                    <span className="truncate grow" title={i.title}>{i.title}</span>
                  </div>
                  {i.changes.map((c) => <div key={c.field} className="faint" style={{ fontSize: "var(--fs-sm)", overflowWrap: "anywhere" }}>{c.field}: {c.from || "(empty)"} → {c.to || "(empty)"}</div>)}
                  {i.warnings.map((w, k) => <div key={k} style={{ fontSize: "var(--fs-sm)", color: "var(--blocked-fg)" }}><AlertTriangle size={11} /> {w}</div>)}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
interface ImportPreview {
  counts: { new: number; unchanged: number; updated: number }; untouched: number; asDrafts: number;
  items: { id: string; title: string; action: string; matches: string | null; changes: { field: string; from: string; to: string }[]; warnings: string[] }[];
}

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Files that belong to a requirement: specs, mockups, mails. Drop, browse or paste (screenshots) to add. */
function AttachmentsSection({ requirementId, attachments }: { requirementId: number; attachments: RequirementAttachment[] }) {
  const canEdit = useCan("tester");
  const confirm = useConfirm();
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
        <div className="card" style={{ marginBottom: 12 }}>
          {attachments.map((a) => {
            const url = `/uploads/${a.stored_name}`;
            return (
              <div key={a.id} className="row" style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)", minHeight: 40 }}>
                {a.mime.startsWith("image/") ? <img src={url} alt="" style={{ width: 28, height: 28, objectFit: "cover", borderRadius: 4 }} /> : <FileText size={16} className="faint" />}
                <a className="truncate grow" href={url} target="_blank" rel="noreferrer" download={a.filename} title={`Open ${a.filename}`}>{a.filename}</a>
                <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>{fmtSize(a.size)}</span>
                <Button needs="tester"
                  variant="danger" size="sm" icon
                  aria-label={`Remove ${a.filename}`}
                  onClick={async () => {
                    if (!(await confirm({ title: `Remove ${a.filename}?`, confirmLabel: "Remove" }))) return;
                    try { await api.del(`/api/requirement-attachments/${a.id}`); invalidate(); } catch (e) { toast("error", (e as Error).message); }
                  }}
                ><Trash2 size={12} /></Button>
              </div>
            );
          })}
        </div>
      )}
      <div
        className={`dropzone${over ? " over" : ""}`}
        style={{ padding: 16 }}
        onClick={() => canEdit && fileRef.current?.click()}
        aria-disabled={!canEdit}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (canEdit) upload(e.dataTransfer.files); }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && fileRef.current?.click()}
      >
        {uploading ? <Loader2 size={16} className="spin" /> : <ImagePlus size={16} />}
        <div style={{ marginTop: 4 }}>Drop files here, click to browse, or paste a screenshot with <Kbd>⌘V</Kbd></div>
        <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>PDF, Word, Excel, PowerPoint, images, CSV, text, mail (.eml), zip</div>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ""; }} />
      </div>
    </>
  );
}
