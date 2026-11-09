import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronDown, ChevronRight, ClipboardList, Copy, Download } from "lucide-react";
import { api } from "../api";
import { Empty, ListSkeleton, useToast } from "../components/ui";

interface PlanLink { raw: string; state: string; label: string; requirementId: number | null; reason: string }
interface PlanItem {
  sourceId: string; title: string; type: string; risk: string; priority: string; readiness: string; preconditions: string; testData: string;
  steps: string[]; acceptanceCriteria: string; automation: string; result: string | null; requirements: PlanLink[];
}
interface PlanView {
  audit: { id: number; agentAuditId: string; title: string };
  planItems: PlanItem[];
  coverageGaps: { sourceId: string; description: string; requirements: PlanLink[] }[];
}
interface AuditRow { id: number; agentAuditId: string; title: string; planItems: number; coverageGaps: number }

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const refName = (r: PlanLink) => (r.requirementId ? r.label : r.raw);
const anchor = (id: string) => `plan-${id.replace(/[^A-Za-z0-9_-]/g, "-")}`;

/** The same plan as plain Markdown, for pasting into a pull request, a wiki or a ticket. Mirrors what the page shows, heading for heading. */
export function planToMarkdown(d: PlanView): string {
  const L: string[] = [`# Test plan: ${d.audit.title || d.audit.agentAuditId}`, ""];
  L.push(`${plural(d.planItems.length, "plan item")}, ${plural(d.coverageGaps.length, "coverage gap")}.`, "");
  L.push("## Plan items", "");
  if (!d.planItems.length) L.push("No plan items.", "");
  for (const x of d.planItems) {
    L.push(`### ${x.sourceId}: ${x.title}`, "");
    const meta = [x.type && `type: ${x.type}`, x.priority && `priority: ${x.priority}`, x.risk && `risk: ${x.risk}`, x.readiness && `readiness: ${x.readiness}`, x.result && `result: ${x.result}`].filter(Boolean);
    if (meta.length) L.push(meta.join(" · "), "");
    if (x.requirements.length) L.push(`**Requirements:** ${x.requirements.map(refName).join(", ")}`, "");
    if (x.preconditions) L.push("**Preconditions**", "", x.preconditions, "");
    if (x.testData) L.push("**Test data**", "", x.testData, "");
    if (x.steps.length) L.push("**Steps**", "", ...x.steps.map((s, i) => `${i + 1}. ${s}`), "");
    if (x.acceptanceCriteria) L.push("**Acceptance criteria**", "", x.acceptanceCriteria, "");
    if (x.automation) L.push(`**Automation:** ${x.automation}`, "");
  }
  L.push("## Coverage gaps", "");
  if (!d.coverageGaps.length) L.push("No coverage gaps.", "");
  for (const g of d.coverageGaps) {
    L.push(`- **${g.sourceId}**${g.requirements.length ? ` (${g.requirements.map(refName).join(", ")})` : ""}: ${g.description.replace(/\n+/g, " ")}`);
  }
  return L.join("\n").replace(/\n+$/, "\n");
}

const tone = (priority: string) => /^(p0|p1|critical|high)$/i.test(priority) ? "hi" : /^(p2|medium)$/i.test(priority) ? "mid" : "lo";
const byPriority = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const isAutomated = (x: PlanItem) => /^yes/i.test(x.automation);

/** The test plan of an audit as a table you can scan: a summary, what was not verified, filters, and one row per plan item that opens to its steps. A read-only mirror; the latest import of the audit replaces it. */
export function TestPlanPage() {
  const { pid = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const toast = useToast();
  const [priority, setPriority] = useState("");
  const [type, setType] = useState("");
  const [unclear, setUnclear] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const { data: audits, isLoading } = useQuery({ queryKey: ["audits", pid], queryFn: () => api.get<AuditRow[]>(`/api/projects/${pid}/audits`) });
  const withPlan = (audits ?? []).filter((a) => a.planItems + a.coverageGaps > 0);
  const wanted = Number(sp.get("audit"));
  const audit = withPlan.find((a) => a.id === wanted) ?? withPlan[0];
  const { data, isLoading: planLoading } = useQuery({ queryKey: ["audit-plan", audit?.id], enabled: !!audit, queryFn: () => api.get<PlanView>(`/api/audits/${audit!.id}/plan`) });

  const items = data?.planItems ?? [];
  const priorities = useMemo(() => [...new Set(items.map((x) => x.priority).filter(Boolean))].sort(byPriority), [items]);
  const types = useMemo(() => [...new Set(items.map((x) => x.type).filter(Boolean))].sort(), [items]);
  const shown = items.filter((x) => (!priority || x.priority === priority) && (!type || x.type === type) && (!unclear || x.readiness === "needs-clarification"));
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
        <button className="btn sm" onClick={copy} disabled={!data}><Copy size={13} /> Copy as Markdown</button>
        <button className="btn sm" onClick={download} disabled={!data}><Download size={13} /> Download .md</button>
      </div>
      <div className="content">
        {planLoading || !data ? <ListSkeleton rows={4} /> : (
          <div className="plan-page">
            <div className="faint" style={{ fontSize: "var(--fs-md)" }}>
              {data.audit.title || data.audit.agentAuditId}. A plan says what the audit planned to check and what it did not verify. It is not a test run, and it does not make a requirement covered.
            </div>
            <div className="plan-stats">
              {stats.map(([n, label]) => <div key={label}><b>{n}</b><span>{label}</span></div>)}
            </div>
            {data.coverageGaps.length > 0 && (
              <div className="plan-gaps" role="region" aria-label="Not verified">
                <div className="row" style={{ gap: 6 }}><AlertTriangle size={14} /><strong>Not verified</strong><span className="faint">{data.coverageGaps.length}</span></div>
                <ul>
                  {data.coverageGaps.map((g) => (
                    <li key={g.sourceId}><span className="mono">{g.sourceId}</span> {g.description} <span className="plan-refs">{reqs(g.requirements)}</span></li>
                  ))}
                </ul>
              </div>
            )}
            {items.length > 0 && (
              <div className="plan-filters" role="group" aria-label="Filter plan items">
                {priorities.length > 1 && <>
                  <span className="faint">Priority</span>
                  {["", ...priorities].map((v) => <button key={v || "all"} className={`chip${priority === v ? " on" : ""}`} aria-pressed={priority === v} onClick={() => setPriority(v)}>{v || "All"}</button>)}
                </>}
                {types.length > 1 && <>
                  <span className="faint" style={{ marginLeft: 8 }}>Type</span>
                  {["", ...types].map((v) => <button key={v || "all"} className={`chip${type === v ? " on" : ""}`} aria-pressed={type === v} onClick={() => setType(v)}>{v || "All"}</button>)}
                </>}
                <button className={`chip${unclear ? " on" : ""}`} style={{ marginLeft: 8 }} aria-pressed={unclear} onClick={() => setUnclear(!unclear)}>Needs clarification</button>
                <span className="spacer" />
                <button className="btn ghost sm" onClick={() => setOpen(open.size ? new Set() : new Set(shown.map((x) => x.sourceId)))}>{open.size ? "Collapse all" : "Expand all"}</button>
              </div>
            )}
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
                        <span className="plan-title">{x.title}{x.readiness === "needs-clarification" && <span className="plan-unclear"> · needs clarification</span>}</span>
                        <span className="muted c-type">{x.type}</span>
                        <span>{x.priority && <span className={`plan-pri ${tone(x.priority)}`}>{x.priority}</span>}</span>
                        <span className="c-auto">{isAutomated(x) ? <span className="plan-auto"><Check size={12} /> Scripted</span> : <span className="muted">{x.automation ? "Manual" : ""}</span>}</span>
                      </button>
                      {isOpen && (
                        <div className="plan-detail" id={`${anchor(x.sourceId)}-detail`}>
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
    </>
  );
}
