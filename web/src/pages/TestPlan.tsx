import { useEffect } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ClipboardList, Copy, Download } from "lucide-react";
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
const countBy = (items: PlanItem[], pick: (x: PlanItem) => string) => {
  const m = new Map<string, number>();
  for (const x of items) {
    const k = pick(x) || "unspecified";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([k, n]) => `${n} ${k}`).join(", ");
};
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

/** The test plan of an audit as a document: headings, lists and numbered steps, the way TestPilot wrote it. A read-only mirror; the latest import of the audit replaces it. */
export function TestPlanPage() {
  const { pid = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const toast = useToast();
  const { data: audits, isLoading } = useQuery({ queryKey: ["audits", pid], queryFn: () => api.get<AuditRow[]>(`/api/projects/${pid}/audits`) });
  const withPlan = (audits ?? []).filter((a) => a.planItems + a.coverageGaps > 0);
  const wanted = Number(sp.get("audit"));
  const audit = withPlan.find((a) => a.id === wanted) ?? withPlan[0];
  const { data, isLoading: planLoading } = useQuery({ queryKey: ["audit-plan", audit?.id], enabled: !!audit, queryFn: () => api.get<PlanView>(`/api/audits/${audit!.id}/plan`) });

  // A link such as #plan-TPI-004 scrolls to its item once the plan has loaded.
  useEffect(() => {
    if (data && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
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
        <div className="plan-layout">
          <article className="doc" aria-label={`Test plan of ${data.audit.title || data.audit.agentAuditId}`}>
            <h2 className="doc-title">{data.audit.title || data.audit.agentAuditId}</h2>
            <p className="doc-lede">
              {plural(data.planItems.length, "plan item")}{data.planItems.length > 0 && ` (${countBy(data.planItems, (x) => x.type)})`}, {plural(data.coverageGaps.length, "coverage gap")}.
              A plan says what the audit planned to check and what it did not verify. It is not a test run, and it does not make a requirement covered.
            </p>
            <h2 id="plan-items">Plan items</h2>
            {data.planItems.length === 0 && <p className="faint">No plan items.</p>}
            {data.planItems.map((x) => (
              <section key={x.sourceId} id={anchor(x.sourceId)} className="doc-item">
                <h3><span className="mono muted">{x.sourceId}</span> {x.title}</h3>
                <div className="doc-meta">
                  {x.type && <span className="chip">{x.type}</span>}
                  {x.priority && <span className="chip">priority {x.priority}</span>}
                  {x.risk && <span className="chip">risk {x.risk}</span>}
                  {x.readiness && <span className="chip">{x.readiness}</span>}
                  {x.result && <span className="chip">{x.result}</span>}
                  {reqs(x.requirements)}
                </div>
                {text("Preconditions", x.preconditions)}
                {text("Test data", x.testData)}
                {x.steps.length > 0 && <><h4>Steps</h4><ol>{x.steps.map((s, i) => <li key={i}>{s}</li>)}</ol></>}
                {text("Acceptance criteria", x.acceptanceCriteria)}
                {text("Automation", x.automation)}
              </section>
            ))}
            <h2 id="plan-gaps">Coverage gaps</h2>
            {data.coverageGaps.length === 0 && <p className="faint">No coverage gaps.</p>}
            {data.coverageGaps.length > 0 && (
              <ul>
                {data.coverageGaps.map((g) => (
                  <li key={g.sourceId} id={anchor(g.sourceId)}>
                    <strong className="mono">{g.sourceId}</strong> {g.description} {reqs(g.requirements)}
                  </li>
                ))}
              </ul>
            )}
          </article>
          <nav className="plan-toc" aria-label="On this page">
            <div className="section-label">On this page</div>
            <a href="#plan-items">Plan items</a>
            {data.planItems.map((x) => <a key={x.sourceId} className="sub" href={`#${anchor(x.sourceId)}`} title={x.title}><span className="mono">{x.sourceId}</span> {x.title}</a>)}
            <a href="#plan-gaps">Coverage gaps</a>
          </nav>
        </div>
      )}
      </div>
    </>
  );
}
