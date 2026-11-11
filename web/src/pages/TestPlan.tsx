import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronDown, ChevronRight, ClipboardList, Copy, Download, History, Pencil, Plus } from "lucide-react";
import { api, formatDateTime } from "../api";
import { Empty, ListSkeleton, Modal, useToast } from "../components/ui";
import { Badge, PriorityBadge } from "../components/Badge";
import { Button } from "../components/Button";
import { FilterChip } from "../components/FilterChip";
import { planToMarkdown } from "../planMarkdown";
import { AutomationSuggestions } from "./AutomationSuggestions";

interface PlanLink { raw: string; state: string; label: string; requirementId: number | null; reason: string }
type PlanStatus = "proposed" | "draft" | "approved" | "rejected";
interface Change { field: string; from: string; to: string }
interface PlanItem {
  sourceId: string; title: string; type: string; risk: string; priority: string; readiness: string; preconditions: string; testData: string;
  steps: string[]; acceptanceCriteria: string; automation: string; result: string | null; requirements: PlanLink[];
  origin: "agent" | "human"; status: PlanStatus; editedBy: string | null; editedAt: string | null; decidedBy: string | null; decidedAt: string | null;
  /** The agent's newer version (or its leaving the item out) of an item a person owns. It waits until a person applies or ignores it. */
  pending: { removed: boolean; changes: Change[] } | null;
}
interface HistoryEntry { subject?: "Plan item" | "Gap"; id: number; sourceId: string; rev: number; at: string; kind: string; actor: string; byAgent: boolean; note: string; title: string; status: PlanStatus; changes: Change[] }
interface Draft { title: string; type: string; priority: string; risk: string; readiness: string; preconditions: string; testData: string; steps: string; acceptanceCriteria: string; automation: string; requirements: string }
const draftOf = (x: PlanItem): Draft => ({ title: x.title, type: x.type, priority: x.priority, risk: x.risk, readiness: x.readiness, preconditions: x.preconditions, testData: x.testData, steps: x.steps.join("\n"), acceptanceCriteria: x.acceptanceCriteria, automation: x.automation, requirements: x.requirements.map((r) => r.raw).join(", ") });
const bodyOf = (d: Draft) => ({ ...d, steps: d.steps.split("\n").map((t) => t.trim()).filter(Boolean), requirements: d.requirements.split(",").map((t) => t.trim()).filter(Boolean) });
const EMPTY: Draft = { title: "", type: "", priority: "", risk: "", readiness: "", preconditions: "", testData: "", steps: "", acceptanceCriteria: "", automation: "", requirements: "" };

/** What an item is, in a word: the agent's proposal, or a person's draft, approved or rejected item. The words are never only a colour. */
type Owned = Pick<PlanItem, "origin" | "status" | "editedBy" | "editedAt" | "decidedBy" | "pending">;
export function PlanMarks({ x, noun = "item" }: { x: Owned; noun?: "item" | "gap" }) {
  const aiProposal = x.origin === "agent" && x.status === "proposed" && !x.editedAt;
  return (
    <>
      {aiProposal && <Badge tone="accent" icon="eye" title="Proposed by a test agent. Nobody has reviewed it yet.">AI proposal</Badge>}
      {x.status === "draft" && <Badge tone="info" icon="circle" title={`A person is working on this ${noun}.`}>Draft</Badge>}
      {x.status === "approved" && <Badge tone="ok" icon="circle-check" title={x.decidedBy ? `Approved by ${x.decidedBy}` : "Approved"}>Approved</Badge>}
      {x.status === "rejected" && <Badge tone="neutral" icon="circle-x" title={x.decidedBy ? `Rejected by ${x.decidedBy}` : "Rejected"}>Rejected</Badge>}
      {x.pending && <Badge tone="warn" icon="triangle-alert" title={`The agent sent something newer. Open the ${noun} to apply or ignore it.`}>{x.pending.removed ? "Agent removal waiting" : "Agent update waiting"}</Badge>}
    </>
  );
}
const ownerNote = (x: Owned) => (x.origin === "human" ? `Added by ${x.editedBy}` : x.editedBy ? `Edited by ${x.editedBy}` : "");
interface GapItem extends Owned { sourceId: string; description: string; requirements: PlanLink[]; decidedAt: string | null }
interface PlanView {
  audit: { id: number; agentAuditId: string; title: string };
  planItems: PlanItem[];
  coverageGaps: GapItem[];
}
interface AuditRow { id: number; agentAuditId: string; title: string; planItems: number; coverageGaps: number }

const anchor = (id: string) => `plan-${id.replace(/[^A-Za-z0-9_-]/g, "-")}`;

const byPriority = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const isAutomated = (x: PlanItem) => /^yes/i.test(x.automation);

/** The test plan of an audit as a table you can scan: a summary, what was not verified, filters, and one row per plan item that opens to its steps. A workspace: the agent proposes, a person edits, approves or rejects, and an import never changes an item a person owns. */
export function TestPlanPage() {
  const { pid = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const toast = useToast();
  const [priority, setPriority] = useState("");
  const [type, setType] = useState("");
  const [unclear, setUnclear] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addingGap, setAddingGap] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const qc = useQueryClient();
  const { data: audits, isLoading } = useQuery({ queryKey: ["audits", pid], queryFn: () => api.get<AuditRow[]>(`/api/projects/${pid}/audits`) });
  const withPlan = (audits ?? []).filter((a) => a.planItems + a.coverageGaps > 0);
  const wanted = Number(sp.get("audit"));
  const audit = withPlan.find((a) => a.id === wanted) ?? withPlan[0];
  const { data, isLoading: planLoading } = useQuery({ queryKey: ["audit-plan", audit?.id], enabled: !!audit, queryFn: () => api.get<PlanView>(`/api/audits/${audit!.id}/plan`) });

  const { data: history } = useQuery({
    queryKey: ["audit-history", audit?.id], enabled: !!audit && showHistory,
    queryFn: async () => {
      const [items, gaps] = await Promise.all([api.get<HistoryEntry[]>(`/api/audits/${audit!.id}/history`), api.get<HistoryEntry[]>(`/api/audits/${audit!.id}/gaps/history`)]);
      // One panel, oldest first (the panel turns it round): plan items and gaps interleaved by time, each entry keeping its own order.
      return [...items.map((h) => ({ ...h, subject: "Plan item" as const })), ...gaps.map((h) => ({ ...h, subject: "Gap" as const }))].sort((a, b) => a.at.localeCompare(b.at));
    },
  });
  /** Runs a change to the plan and shows the plan the server answers with. The server refuses what the role does not allow; a message says so. */
  const act = (fn: () => Promise<PlanView>, ok: string) =>
    fn().then((plan) => { qc.setQueryData(["audit-plan", audit!.id], plan); for (const k of ["audits", "audit-history", "requirement", "requirements"]) qc.invalidateQueries({ queryKey: [k] }); toast("success", ok); return plan; })
      .catch((e: Error) => { toast("error", e.message); return null; });
  const base = audit ? `/api/audits/${audit.id}/plan/items` : "";
  const gapBase = audit ? `/api/audits/${audit.id}/gaps` : "";
  const item = (id: string) => `${base}/${encodeURIComponent(id)}`;

  const items = data?.planItems ?? [];
  const priorities = useMemo(() => [...new Set(items.map((x) => x.priority).filter(Boolean))].sort(byPriority), [items]);
  const types = useMemo(() => [...new Set(items.map((x) => x.type).filter(Boolean))].sort(), [items]);
  const label = (x: PlanItem) => (x.origin === "agent" && x.status === "proposed" && !x.editedAt ? "AI proposal" : x.status);
  const statuses = useMemo(() => [...new Set(items.map(label))], [items]);
  const shown = items.filter((x) => (!priority || x.priority === priority) && (!type || x.type === type) && (!unclear || x.readiness === "needs-clarification") && (!status || label(x) === status));
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // A link such as #plan-TPI-004 opens that item and scrolls to it once the plan has loaded.
  useEffect(() => {
    if (!data || !location.hash) return;
    const hit = data.planItems.find((x) => anchor(x.sourceId) === location.hash.slice(1));
    if (hit) setOpen((o) => new Set(o).add(hit.sourceId));
    setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "center" }), 0);
  }, [data]);

  const reqs = (links: PlanLink[]) => links.map((r) => r.requirementId
    ? <Link key={r.raw} className="chip" to={`/p/${pid}/requirements?req=${r.requirementId}`}>{r.label}</Link>
    : <span key={r.raw} className="chip" style={{ color: "var(--blocked-fg)" }} title={r.reason}>{r.raw} · not found</span>);
  const text = (label: string, value: string) => value ? <><h4>{label}</h4><p>{value}</p></> : null;

  const md = data ? planToMarkdown(data) : "";
  const copy = async () => {
    try { await navigator.clipboard.writeText(md); toast("success", "Test plan copied as Markdown"); }
    catch { toast("error", "Could not copy. Use Download .md instead."); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `test-plan-${data!.audit.agentAuditId}.md` });
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading) return <><div className="topbar"><h1>Test plan</h1></div><div className="content"><ListSkeleton rows={4} /></div></>;
  if (!audit) {
    return (
      <>
        <div className="topbar"><h1>Test plan</h1></div>
        <div className="content"><Empty icon={<ClipboardList size={22} />} title="No test plan yet">A test plan arrives with an audit package from TestPilot (contract 1.3, test-plan.json). Import one under Bug reports.</Empty></div>
      </>
    );
  }

  const top = priorities[0];
  const stats: [number, string][] = [
    [items.length, "plan items"],
    ...(top ? [[items.filter((x) => x.priority === top).length, `${top}, highest priority`] as [number, string]] : []),
    [items.filter((x) => label(x) === "AI proposal").length, "AI proposals, not reviewed"],
    [items.filter((x) => x.status === "approved").length, "approved"],
    [items.filter((x) => x.pending).length, "with an agent update waiting"],
    [items.filter((x) => x.readiness === "needs-clarification").length, "need clarification"],
    [data?.coverageGaps.length ?? 0, "coverage gaps"],
  ];

  return (
    <>
      <div className="topbar">
        <h1>Test plan</h1>
        <span className="spacer" />
        {withPlan.length > 1 && (
          <select className="select" aria-label="Audit" value={audit.id} onChange={(e) => setSp({ audit: e.target.value })}>
            {withPlan.map((a) => <option key={a.id} value={a.id}>{a.title || a.agentAuditId}</option>)}
          </select>
        )}
        <Button needs="tester" variant="primary" size="sm" onClick={() => setAdding(true)} disabled={!data}><Plus size={13} /> Add item</Button>
        <Button size="sm" aria-pressed={showHistory} onClick={() => setShowHistory(!showHistory)}><History size={13} /> History</Button>
        <Button size="sm" onClick={copy} disabled={!data}><Copy size={13} /> Copy as Markdown</Button>
        <Button size="sm" onClick={download} disabled={!data}><Download size={13} /> Download .md</Button>
      </div>
      <div className="content">
        {planLoading || !data ? <ListSkeleton rows={4} /> : (
          <div className="plan-page">
            <div className="faint" style={{ fontSize: "var(--fs-md)" }}>
              {data.audit.title || data.audit.agentAuditId}. A plan says what the audit planned to check and what it did not verify. It is not a test run, and it does not make a requirement covered. The agent proposes; you decide. An item becomes yours when you edit, approve, reject or add it, and a later import never changes it.
            </div>
            <div className="plan-stats">
              {stats.map(([n, label]) => <div key={label}><b>{n}</b><span>{label}</span></div>)}
            </div>
            <div className="plan-gaps" role="region" aria-label="Not verified">
              <div className="row" style={{ gap: 6 }}>
                <AlertTriangle size={14} /><strong>Not verified</strong><span className="faint">{data.coverageGaps.length}</span>
                <span className="spacer" />
                <Button needs="tester" size="sm" onClick={() => setAddingGap(true)}><Plus size={13} /> Add gap</Button>
              </div>
              {data.coverageGaps.length === 0 ? <p className="faint" style={{ margin: "6px 0 0" }}>Nothing is recorded as not verified.</p> : (
                <ul>
                  {data.coverageGaps.map((g) => <GapRow key={g.sourceId} g={g} reqs={reqs} act={act} url={`${gapBase}/${encodeURIComponent(g.sourceId)}`} />)}
                </ul>
              )}
            </div>
            {items.length > 0 && (
              <div className="plan-filters" role="group" aria-label="Filter plan items">
                {priorities.length > 1 && <>
                  <span className="faint">Priority</span>
                  {["", ...priorities].map((v) => <FilterChip key={v || "all"} pressed={priority === v} onClick={() => setPriority(v)}>{v || "All"}</FilterChip>)}
                </>}
                {types.length > 1 && <>
                  <span className="faint" style={{ marginLeft: 8 }}>Type</span>
                  {["", ...types].map((v) => <FilterChip key={v || "all"} pressed={type === v} onClick={() => setType(v)}>{v || "All"}</FilterChip>)}
                </>}
                {statuses.length > 1 && <>
                  <span className="faint" style={{ marginLeft: 8 }}>Status</span>
                  {["", ...statuses].map((v) => <FilterChip key={v || "all"} pressed={status === v} onClick={() => setStatus(v)}>{v ? v[0].toUpperCase() + v.slice(1) : "All"}</FilterChip>)}
                </>}
                <span style={{ marginLeft: 8 }}><FilterChip pressed={unclear} onClick={() => setUnclear(!unclear)}>Needs clarification</FilterChip></span>
                <span className="spacer" />
                <Button variant="ghost" size="sm" onClick={() => setOpen(open.size ? new Set() : new Set(shown.map((x) => x.sourceId)))}>{open.size ? "Collapse all" : "Expand all"}</Button>
              </div>
            )}
            {showHistory && <HistoryPanel entries={history} />}
            {items.length === 0 ? <p className="faint">No plan items.</p> : (
              <div className="plan-table" role="list">
                <div className="plan-row plan-head" aria-hidden="true"><span /><span>ID</span><span>Plan item</span><span className="c-type">Type</span><span>Priority</span><span className="c-auto">Automation</span></div>
                {shown.map((x) => {
                  const isOpen = open.has(x.sourceId);
                  return (
                    <div key={x.sourceId} id={anchor(x.sourceId)} role="listitem" className="plan-entry">
                      <button className="plan-row" aria-expanded={isOpen} aria-controls={`${anchor(x.sourceId)}-detail`} onClick={() => toggle(x.sourceId)}>
                        <span aria-hidden="true">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
                        <span className="mono muted key-col">{x.sourceId}</span>
                        <span className="plan-title">{x.title}{x.readiness === "needs-clarification" && <span className="plan-unclear"> · needs clarification</span>} <span className="plan-marks"><PlanMarks x={x} />{ownerNote(x) && <span className="faint plan-owner">{ownerNote(x)}</span>}</span></span>
                        <span className="muted c-type">{x.type}</span>
                        <span>{x.priority && <PriorityBadge value={x.priority} />}</span>
                        <span className="c-auto">{isAutomated(x) ? <span className="plan-auto"><Check size={12} /> Scripted</span> : <span className="muted">{x.automation ? "Manual" : ""}</span>}</span>
                      </button>
                      {isOpen && (
                        <div className="plan-detail" id={`${anchor(x.sourceId)}-detail`}>
                          {x.pending && <PendingBanner pending={x.pending} noun="item" onApply={() => act(() => api.post<PlanView>(`${item(x.sourceId)}/pending`, { action: "apply" }), x.pending!.removed ? "Removed, as the agent's plan left it out" : "Applied the agent's version. It is a draft until you approve it.")}
                            onIgnore={() => act(() => api.post<PlanView>(`${item(x.sourceId)}/pending`, { action: "ignore" }), "Kept your version")} />}
                          {editing === x.sourceId ? (
                            <ItemEditor x={x} onCancel={() => setEditing(null)}
                              onSave={(d, decision) => act(async () => {
                                let plan = await api.patch<PlanView>(item(x.sourceId), bodyOf(d));
                                if (decision) plan = await api.post<PlanView>(`${item(x.sourceId)}/decision`, { status: decision });
                                return plan;
                              }, decision === "approved" ? "Approved" : decision === "rejected" ? "Rejected" : "Saved as a draft").then((r) => { if (r) setEditing(null); })} />
                          ) : (
                            <>
                              <div className="plan-actions">
                                <Button needs="tester" size="sm" onClick={() => setEditing(x.sourceId)}><Pencil size={13} /> Edit</Button>
                                {x.status !== "approved" && <Button needs="tester" size="sm" variant="primary" onClick={() => act(() => api.post<PlanView>(`${item(x.sourceId)}/decision`, { status: "approved" }), "Approved")}><Check size={13} /> Approve</Button>}
                                {x.status !== "rejected" && <Button needs="tester" size="sm" onClick={() => act(() => api.post<PlanView>(`${item(x.sourceId)}/decision`, { status: "rejected" }), "Rejected")}>Reject</Button>}
                                {x.status !== "draft" && <Button needs="tester" size="sm" variant="ghost" onClick={() => act(() => api.post<PlanView>(`${item(x.sourceId)}/decision`, { status: "draft" }), "Saved as a draft")}>Save as draft</Button>}
                                <span className="faint plan-who">
                                  {x.origin === "agent" && x.status === "proposed" && !x.editedAt ? "Proposed by the agent. Nobody has reviewed it." : [ownerNote(x), x.editedAt && formatDateTime(x.editedAt), x.decidedBy && x.status !== "draft" && `${x.status === "approved" ? "Approved" : "Rejected"} by ${x.decidedBy}`].filter(Boolean).join(" · ")}
                                </span>
                              </div>
                              <div className="plan-refs">
                                {x.risk && <span className="chip">risk {x.risk}</span>}
                                {x.result && <span className="chip">{x.result}</span>}
                                {reqs(x.requirements)}
                              </div>
                              {text("Preconditions", x.preconditions)}
                              {text("Test data", x.testData)}
                              {x.steps.length > 0 && <><h4>Steps</h4><ol>{x.steps.map((st, i) => <li key={i}>{st}</li>)}</ol></>}
                              {text("Acceptance criteria", x.acceptanceCriteria)}
                              {text("Automation", x.automation)}
                              <AutomationSuggestions pid={pid} scope={{ kind: "plan_item", auditId: audit.id, sourceId: x.sourceId }} itemStatus={x.status} />
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {shown.length === 0 && <p className="faint" style={{ padding: 12, margin: 0 }}>No plan item matches these filters.</p>}
              </div>
            )}
            <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>Showing {shown.length} of {items.length} plan items. Click a row to open it.</div>
          </div>
        )}
      </div>
      {addingGap && <AddGapModal onClose={() => setAddingGap(false)} onAdd={(d) => act(() => api.post<PlanView>(gapBase, d), "Added. It is your draft; an import will not change it.").then((plan) => { if (plan) setAddingGap(false); })} />}
      {adding && <AddItemModal onClose={() => setAdding(false)} onAdd={(d) => act(() => api.post<PlanView>(base, bodyOf(d)), "Added. It is your draft; an import will not change it.").then((plan) => {
        if (!plan) return;
        setAdding(false);
        const known = new Set(items.map((i) => i.sourceId));
        const mine = plan.planItems.find((i) => !known.has(i.sourceId));
        if (mine) setOpen((o) => new Set(o).add(mine.sourceId));
      })} />}
    </>
  );
}

/** The agent's newer version of an item or gap you own, as a diff. Nothing changes until you choose. */
function PendingBanner({ pending, noun, onApply, onIgnore }: { pending: NonNullable<Owned["pending"]>; noun: "item" | "gap"; onApply: () => void; onIgnore: () => void }) {
  const removed = pending.removed;
  return (
    <div className="card plan-pending" role="region" aria-label="Agent sent a newer version">
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <strong>{removed ? `The agent's newer plan leaves this ${noun} out` : "Agent sent a newer version"}</strong>
        <span className="spacer" />
        <Button needs="tester" size="sm" onClick={onIgnore}>{removed ? `Keep the ${noun}` : "Ignore"}</Button>
        <Button needs="tester" size="sm" variant="primary" onClick={onApply}>{removed ? "Remove it" : "Apply"}</Button>
      </div>
      <div className="faint" style={{ fontSize: "var(--fs-sm)", margin: "6px 0" }}>
        {removed ? `Your ${noun} is kept until you decide.` : "Your text and decision are unchanged until you choose. Applying replaces the text below with the agent's, as a draft you approve again."}
      </div>
      {pending.changes.map((c) => (
        <div key={c.field} style={{ fontSize: "var(--fs-md)", marginTop: 6 }}>
          <span className="section-label" style={{ margin: 0 }}>{c.field}</span>
          <div className="plan-del">− {c.from || "(empty)"}</div>
          <div className="plan-add">+ {c.to || "(empty)"}</div>
        </div>
      ))}
    </div>
  );
}

const KIND: Record<string, string> = {
  agent_import: "Agent import", agent_sent: "Agent sent a newer version", removal_pending: "Agent's plan leaves it out", agent_removed: "Removed with the agent's plan",
  created: "Added", edited: "Edited", draft: "Saved as a draft", approved: "Approved", rejected: "Rejected",
  applied_agent: "Applied the agent's version", ignored_agent: "Ignored the agent's version", removed_by_agent: "Removed, as the agent's plan left it out",
};
/** The history of the plan, newest first: who changed what and when, and what the agent sent. */
function HistoryPanel({ entries }: { entries: HistoryEntry[] | undefined }) {
  return (
    <div className="card plan-history" role="region" aria-label="Plan history">
      <strong>History</strong>
      {!entries ? <p className="faint">Loading…</p> : entries.length === 0 ? <p className="faint">Nothing has happened yet.</p> : (
        <ol>
          {[...entries].reverse().map((h) => (
            <li key={`${h.subject}-${h.id}`}>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                {h.subject && <span className="chip">{h.subject}</span>}
                <span className="mono muted">{h.sourceId}</span>
                <strong>{KIND[h.kind] ?? h.kind}</strong>
                {h.byAgent ? <Badge tone="accent" icon="eye">Agent</Badge> : <span className="muted">by {h.actor}</span>}
                <span className="faint" title={formatDateTime(h.at)}>{formatDateTime(h.at)}</span>
              </div>
              {h.note && <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>{h.note}</div>}
              {h.changes.map((c) => (
                <div key={c.field} style={{ fontSize: "var(--fs-sm)", marginTop: 4 }}>
                  <span className="section-label" style={{ margin: 0 }}>{c.field}</span>
                  <div className="plan-del">− {c.from || "(empty)"}</div>
                  <div className="plan-add">+ {c.to || "(empty)"}</div>
                </div>
              ))}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Fields({ d, set }: { d: Draft; set: (d: Draft) => void }) {
  const f = (k: keyof Draft, label: string, area = false) => (
    <div className="field" key={k}>
      <label htmlFor={`pf-${k}`}>{label}</label>
      {area ? <textarea id={`pf-${k}`} className="textarea" value={d[k]} onChange={(e) => set({ ...d, [k]: e.target.value })} /> : <input id={`pf-${k}`} className="input" value={d[k]} onChange={(e) => set({ ...d, [k]: e.target.value })} />}
    </div>
  );
  return (
    <div className="col" style={{ gap: 10 }}>
      {f("title", "Title")}
      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>{f("type", "Type")}{f("priority", "Priority")}{f("risk", "Risk")}
        <div className="field"><label htmlFor="pf-readiness">Readiness</label>
          <select id="pf-readiness" className="select" value={d.readiness} onChange={(e) => set({ ...d, readiness: e.target.value })}><option value="">Not set</option><option value="ready">Ready</option><option value="needs-clarification">Needs clarification</option></select></div>
      </div>
      {f("preconditions", "Preconditions", true)}{f("testData", "Test data", true)}{f("steps", "Steps (one per line)", true)}
      {f("acceptanceCriteria", "Acceptance criteria", true)}{f("automation", "Automation")}{f("requirements", "Requirements (REQ-1, REQ-LOCAL-002, separated by commas)")}
    </div>
  );
}

function ItemEditor({ x, onSave, onCancel }: { x: PlanItem; onSave: (d: Draft, decision?: "approved" | "rejected") => void; onCancel: () => void }) {
  const [d, setD] = useState<Draft>(() => draftOf(x));
  return (
    <div className="col" style={{ gap: 12 }}>
      <Fields d={d} set={setD} />
      <div className="plan-actions">
        <Button needs="tester" variant="primary" size="sm" disabled={!d.title.trim()} onClick={() => onSave(d)}>Save draft</Button>
        <Button needs="tester" size="sm" disabled={!d.title.trim()} onClick={() => onSave(d, "approved")}><Check size={13} /> Approve</Button>
        <Button needs="tester" size="sm" disabled={!d.title.trim()} onClick={() => onSave(d, "rejected")}>Reject</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function AddItemModal({ onClose, onAdd }: { onClose: () => void; onAdd: (d: Draft) => void }) {
  const [d, setD] = useState<Draft>(EMPTY);
  return (
    <Modal title="Add a plan item" onClose={onClose} width={640}
      footer={<><span className="spacer" /><Button onClick={onClose}>Cancel</Button><Button needs="tester" variant="primary" disabled={!d.title.trim()} onClick={() => onAdd(d)}>Add as draft</Button></>}>
      <div className="faint" style={{ marginBottom: 10 }}>Your own item. It starts as a draft, and an import from the agent never changes or removes it.</div>
      <Fields d={d} set={setD} />
    </Modal>
  );
}

const gapBody = (d: { description: string; requirements: string }) => ({ description: d.description, requirements: d.requirements.split(",").map((t) => t.trim()).filter(Boolean) });

/** One coverage gap: what the audit did not verify. The same marks, edit, approve, reject and agent version as a plan item. */
function GapRow({ g, reqs, act, url }: { g: GapItem; reqs: (l: PlanLink[]) => React.ReactNode; act: (fn: () => Promise<PlanView>, ok: string) => Promise<PlanView | null>; url: string }) {
  const [editing, setEditing] = useState(false);
  const decide = (status: "draft" | "approved" | "rejected", ok: string) => act(() => api.post<PlanView>(`${url}/decision`, { status }), ok);
  const who = g.origin === "agent" && g.status === "proposed" && !g.editedAt ? "Proposed by the agent. Nobody has reviewed it." : [ownerNote(g), g.editedAt && formatDateTime(g.editedAt), g.decidedBy && g.status !== "draft" && `${g.status === "approved" ? "Approved" : "Rejected"} by ${g.decidedBy}`].filter(Boolean).join(" · ");
  return (
    <li data-gap={g.sourceId}>
      <div><span className="mono">{g.sourceId}</span> {g.description} <span className="plan-refs">{reqs(g.requirements)}</span> <span className="plan-marks"><PlanMarks x={g} noun="gap" />{ownerNote(g) && <span className="faint plan-owner">{ownerNote(g)}</span>}</span></div>
      {g.pending && <PendingBanner pending={g.pending} noun="gap" onApply={() => act(() => api.post<PlanView>(`${url}/pending`, { action: "apply" }), g.pending!.removed ? "Removed, as the agent's plan left it out" : "Applied the agent's version. It is a draft until you approve it.")}
        onIgnore={() => act(() => api.post<PlanView>(`${url}/pending`, { action: "ignore" }), "Kept your version")} />}
      {editing ? (
        <GapEditor g={g} onCancel={() => setEditing(false)} onSave={(d, decision) => act(async () => {
          let plan = await api.patch<PlanView>(url, gapBody(d));
          if (decision) plan = await api.post<PlanView>(`${url}/decision`, { status: decision });
          return plan;
        }, decision === "approved" ? "Approved" : decision === "rejected" ? "Rejected" : "Saved as a draft").then((r) => { if (r) setEditing(false); })} />
      ) : (
        <div className="plan-actions">
          <Button needs="tester" size="sm" onClick={() => setEditing(true)}><Pencil size={13} /> Edit</Button>
          {g.status !== "approved" && <Button needs="tester" size="sm" variant="primary" onClick={() => decide("approved", "Approved")}><Check size={13} /> Approve</Button>}
          {g.status !== "rejected" && <Button needs="tester" size="sm" onClick={() => decide("rejected", "Rejected")}>Reject</Button>}
          {g.status !== "draft" && <Button needs="tester" size="sm" variant="ghost" onClick={() => decide("draft", "Saved as a draft")}>Save as draft</Button>}
          <span className="faint plan-who">{who}</span>
        </div>
      )}
    </li>
  );
}

function GapFields({ d, set, id }: { d: { description: string; requirements: string }; set: (d: { description: string; requirements: string }) => void; id: string }) {
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="field"><label htmlFor={`${id}-description`}>Not verified (description)</label>
        <textarea id={`${id}-description`} className="textarea" value={d.description} onChange={(e) => set({ ...d, description: e.target.value })} /></div>
      <div className="field"><label htmlFor={`${id}-requirements`}>Requirements (REQ-1, REQ-LOCAL-002, separated by commas)</label>
        <input id={`${id}-requirements`} className="input" value={d.requirements} onChange={(e) => set({ ...d, requirements: e.target.value })} /></div>
    </div>
  );
}

function GapEditor({ g, onSave, onCancel }: { g: GapItem; onSave: (d: { description: string; requirements: string }, decision?: "approved" | "rejected") => void; onCancel: () => void }) {
  const [d, setD] = useState({ description: g.description, requirements: g.requirements.map((r) => r.raw).join(", ") });
  const ok = !!d.description.trim();
  return (
    <div className="col" style={{ gap: 10, marginTop: 6 }}>
      <GapFields d={d} set={setD} id={`gap-${anchor(g.sourceId)}`} />
      <div className="plan-actions">
        <Button needs="tester" variant="primary" size="sm" disabled={!ok} onClick={() => onSave(d)}>Save draft</Button>
        <Button needs="tester" size="sm" disabled={!ok} onClick={() => onSave(d, "approved")}><Check size={13} /> Approve</Button>
        <Button needs="tester" size="sm" disabled={!ok} onClick={() => onSave(d, "rejected")}>Reject</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function AddGapModal({ onClose, onAdd }: { onClose: () => void; onAdd: (body: ReturnType<typeof gapBody>) => void }) {
  const [d, setD] = useState({ description: "", requirements: "" });
  return (
    <Modal title="Add a gap" onClose={onClose} width={560}
      footer={<><span className="spacer" /><Button onClick={onClose}>Cancel</Button><Button needs="tester" variant="primary" disabled={!d.description.trim()} onClick={() => onAdd(gapBody(d))}>Add as draft</Button></>}>
      <div className="faint" style={{ marginBottom: 10 }}>Something you know was not verified. It starts as a draft, and an import from the agent never changes or removes it.</div>
      <GapFields d={d} set={setD} id="new-gap" />
    </Modal>
  );
}
