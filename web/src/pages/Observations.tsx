import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronRight, Gauge } from "lucide-react";
import { api } from "../api";
import { Empty, ListSkeleton, Modal, useConfirm, useToast } from "../components/ui";

type Kind = "load_test" | "security_review";
type Severity = "info" | "low" | "medium" | "high" | "critical";
type Status = "observed" | "needs_review" | "confirmed" | "resolved" | "archived" | "converted";
interface EvidenceFile { ref: string; path: string; sha256: string | null; state: "ok" | "problem" | "unresolved"; reason: string }
interface Observation {
  id: number; label: string; sourceId: string; auditId: number | null; agentAuditId: string; auditTitle: string;
  kind: Kind; title: string; severity: Severity; status: Status; statusSetBy: "agent" | "human"; statusChangedAt: string | null; changedSinceReview: boolean;
  metric: string | null; value: number | null; threshold: number | null; evidence: string; recommendation: string; source: string;
  evidenceFiles: EvidenceFile[]; convertedBugId: number | null; createdAt: string; updatedAt: string;
}
interface Counts { total: number; kind: Record<Kind, number>; severity: Record<Severity, number>; status: Record<Status, number> }
interface Listing { counts: Counts; items: Observation[] }

const KINDS: [Kind, string][] = [["load_test", "Load test"], ["security_review", "Security review"]];
const SEVERITIES: [Severity, string][] = [["critical", "Critical"], ["high", "High"], ["medium", "Medium"], ["low", "Low"], ["info", "Info"]];
const STATUSES: [Status, string][] = [["observed", "Observed"], ["needs_review", "Needs review"], ["confirmed", "Confirmed"], ["resolved", "Resolved"], ["archived", "Archived"], ["converted", "Converted"]];
/** The statuses of an observation that is still being looked at. A person can set these by hand; the others close it or mean it is tracked as a bug. */
const OPEN: Status[] = ["observed", "needs_review", "confirmed"];
const isOpenStatus = (s: Status) => OPEN.includes(s);
type Closing = "archive" | "resolve" | "reopen";
const nameOf = (list: [string, string][], v: string) => list.find(([k]) => k === v)?.[1] ?? v;
const tone = (s: Severity) => (s === "critical" || s === "high" ? "hi" : s === "medium" ? "mid" : "lo");
const anchor = (label: string) => `obs-${label}`;
const EVIDENCE_NOTE: Record<EvidenceFile["state"], string> = { ok: "found", problem: "problem", unresolved: "not found" };

/** Chips for one filter: "All" and each value that has observations (or is selected). The numbers are for the whole project, so they do not move while you filter. */
function FilterGroup({ label, options, counts, value, onChange }: { label: string; options: [string, string][]; counts: Record<string, number>; value: string; onChange: (v: string) => void }) {
  const shown = options.filter(([k]) => counts[k] > 0 || k === value);
  if (shown.length === 0) return null;
  return (
    <div className="obs-filter" role="group" aria-label={label}>
      <span className="faint">{label}</span>
      {[["", "All"] as [string, string], ...shown].map(([k, name]) => (
        <button key={k || "all"} className={`chip${value === k ? " on" : ""}`} aria-pressed={value === k} onClick={() => onChange(k)}>
          {name}{k ? <span className="faint"> {counts[k] ?? 0}</span> : null}
        </button>
      ))}
    </div>
  );
}

/**
 * The status chips. "Active" (no `status` in the address) is the working list: observed, needs review and confirmed. Archived, resolved and converted
 * leave it, and each has a chip of its own while there are any. "All" shows everything.
 */
function StatusFilter({ counts, value, onChange }: { counts: Record<Status, number>; value: string; onChange: (v: string) => void }) {
  const active = OPEN.reduce((n, k) => n + counts[k], 0);
  const options: [string, string, number | null][] = [
    ["", "Active", active],
    ...STATUSES.filter(([k]) => counts[k] > 0 || k === value).map(([k, name]) => [k, name, counts[k]] as [string, string, number]),
    ["all", "All", null],
  ];
  return (
    <div className="obs-filter" role="group" aria-label="Status">
      <span className="faint">Status</span>
      {options.map(([k, name, n]) => (
        <button key={k || "active"} className={`chip${value === k ? " on" : ""}`} aria-pressed={value === k} onClick={() => onChange(k)}>
          {name}{n !== null ? <span className="faint"> {n}</span> : null}
        </button>
      ))}
    </div>
  );
}

/**
 * Results of load tests and security reviews that are not bugs: measurements, risks and findings that a person looks at. They have their own status
 * and are listed apart from the bug reports. Turning one into a bug is a decision made here, never automatic.
 */
export function ObservationsPage() {
  const { pid = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();
  const kind = sp.get("kind") ?? "";
  const severity = sp.get("severity") ?? "";
  const status = sp.get("status") ?? "";
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [converting, setConverting] = useState<Observation | null>(null);
  const confirm = useConfirm();
  const setFilter = (key: string, v: string) => setSp((p) => { const n = new URLSearchParams(p); if (v) n.set(key, v); else n.delete(key); return n; }, { replace: true });

  const query = new URLSearchParams();
  for (const [k, v] of [["kind", kind], ["severity", severity], ["status", status]]) if (v) query.set(k, v);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["observations", pid, kind, severity, status],
    queryFn: () => api.get<Listing>(`/api/projects/${pid}/observations?${query}`),
  });
  const items = data?.items ?? [];
  const toggle = (id: number) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // A link such as #obs-OBS-3 opens that observation and scrolls to it once the list has loaded.
  useEffect(() => {
    if (!data || !location.hash) return;
    const hit = data.items.find((o) => anchor(o.label) === location.hash.slice(1));
    if (hit) setOpen((o) => new Set(o).add(hit.id));
    setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "center" }), 0);
  }, [data]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["observations", pid] });
  const closing = useMutation({
    mutationFn: (v: { o: Observation; action: Closing }) => api.post<Observation>(`/api/observations/${v.o.id}/${v.action}`),
    onSuccess: async (_r, v) => {
      await refresh();
      toast("success", v.action === "archive" ? `${v.o.label} archived. It is under the Archived filter.` : v.action === "resolve" ? `${v.o.label} marked as resolved. It is under the Resolved filter.` : `${v.o.label} reopened as needs review.`);
    },
    onError: (e: Error) => toast("error", e.message),
  });
  /** Closing and reopening ask first: the observation leaves the working list (or comes back to it). */
  const close = async (o: Observation, action: Closing) => {
    const text = {
      archive: { title: `Archive ${o.label}?`, label: "Archive", body: "It leaves the active list. Use this when it is not a bug and there is nothing to follow up: a false positive, something that is only information, a duplicate. You can reopen it from the Archived filter." },
      resolve: { title: `Mark ${o.label} as resolved?`, label: "Mark as resolved", body: "It has been fixed or is no longer relevant. It leaves the active list, and you can reopen it from the Resolved filter." },
      reopen: { title: `Reopen ${o.label}?`, label: "Reopen", body: `It goes back to needs review and into the active list.` },
    }[action];
    if (await confirm({ title: text.title, body: <p style={{ margin: 0 }}>{text.body}</p>, confirmLabel: text.label })) closing.mutate({ o, action });
  };
  const setStatus = useMutation({
    mutationFn: (v: { id: number; status: Status }) => api.patch<Observation>(`/api/observations/${v.id}`, { status: v.status }),
    onSuccess: refresh,
    onError: (e: Error) => toast("error", e.message),
  });
  const convert = useMutation({
    mutationFn: (id: number) => api.post<{ bugId: number }>(`/api/observations/${id}/convert-to-bug`),
    onSuccess: async () => {
      setConverting(null);
      await Promise.all([refresh(), qc.invalidateQueries({ queryKey: ["bug-reports"] })]);
      toast("success", "A bug report was made. It waits under Bug reports until you decide.");
    },
    onError: (e: Error) => toast("error", e.message),
  });

  // The number beside the title is what the list shows now, after the status, kind and severity filters.
  const head = <div className="topbar"><h1>Observations</h1>{data && <span className="chip" aria-label={`${items.length} shown`}>{items.length}</span>}</div>;
  if (isLoading) return <>{head}<div className="content"><ListSkeleton rows={4} /></div></>;
  if (isError || !data) return <>{head}<div className="content"><Empty icon={<AlertTriangle size={22} />} title="Could not load the observations">{(error as Error | null)?.message}</Empty></div></>;
  if (data.counts.total === 0) {
    return (
      <>
        {head}
        <div className="content">
          <Empty icon={<Gauge size={22} />} title="No observations yet">
            Observations are results of load tests and security reviews that are not bugs: a measurement, a risk, a finding that needs a person to look at it. A test agent sends them to this project; they are kept apart from the bug reports.
          </Empty>
        </div>
      </>
    );
  }

  return (
    <>
      {head}
      <div className="content">
        <div className="plan-page">
          <div className="faint" style={{ fontSize: "var(--fs-md)" }}>
            Not bugs. Results of load tests and security reviews that need a person to look at them. Turn one into a bug report only when it is one.
          </div>
          <div className="obs-filters">
            <FilterGroup label="Kind" options={KINDS} counts={data.counts.kind} value={kind} onChange={(v) => setFilter("kind", v)} />
            <FilterGroup label="Severity" options={SEVERITIES} counts={data.counts.severity} value={severity} onChange={(v) => setFilter("severity", v)} />
            <StatusFilter counts={data.counts.status} value={status} onChange={(v) => setFilter("status", v)} />
          </div>
          <div className="plan-table" role="list">
            <div className="plan-row obs-row plan-head" aria-hidden="true"><span /><span>ID</span><span>Observation</span><span className="c-type">Kind</span><span>Severity</span><span className="c-auto">Status</span></div>
            {items.map((o) => {
              const isOpen = open.has(o.id);
              return (
                <div key={o.id} id={anchor(o.label)} role="listitem" className="plan-entry">
                  <button className="plan-row obs-row" aria-expanded={isOpen} aria-controls={`${anchor(o.label)}-detail`} onClick={() => toggle(o.id)}>
                    <span aria-hidden="true">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
                    <span className="mono muted key-col">{o.label}</span>
                    <span className="plan-title">
                      {o.title}
                      {o.changedSinceReview && <span className="plan-unclear"> · changed since you reviewed it</span>}
                      {o.status === "converted" && <span className="muted"> · tracked as a bug report</span>}
                    </span>
                    <span className="muted c-type">{nameOf(KINDS, o.kind)}</span>
                    <span><span className={`plan-pri ${tone(o.severity)}`}>{nameOf(SEVERITIES, o.severity)}</span></span>
                    <span className="c-auto">{nameOf(STATUSES, o.status)}</span>
                  </button>
                  {isOpen && (
                    <div className="plan-detail" id={`${anchor(o.label)}-detail`}>
                      <div className="plan-refs">
                        <span className="chip">{o.sourceId}</span>
                        {o.auditId ? <span className="chip">audit {o.auditTitle || o.agentAuditId}</span> : <span className="chip">audit {o.agentAuditId} (removed)</span>}
                        {o.source && <span className="chip">{o.source}</span>}
                      </div>
                      {o.kind === "load_test" && (
                        <>
                          <h4>Measurement</h4>
                          <p><span className="mono">{o.metric}</span>: <b>{o.value}</b>, threshold <b>{o.threshold}</b></p>
                        </>
                      )}
                      {o.evidence && <><h4>Evidence</h4><p>{o.evidence}</p></>}
                      {o.evidenceFiles.length > 0 && (
                        <ul className="obs-files">
                          {o.evidenceFiles.map((f) => (
                            <li key={f.ref}>
                              <span className="mono">{f.path}</span>{f.ref !== f.path && <span className="faint"> ({f.ref})</span>}{" "}
                              <span className={f.state === "ok" ? "muted" : "obs-bad"}>{EVIDENCE_NOTE[f.state]}{f.reason ? `: ${f.reason}` : ""}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {o.recommendation && <><h4>Recommendation</h4><p>{o.recommendation}</p></>}
                      <h4>Review</h4>
                      {o.changedSinceReview && <p className="obs-bad">The agent sent new content after you set the status.{isOpenStatus(o.status) ? " Set the status again to mark it as reviewed." : o.status === "converted" ? "" : " Reopen it to look at it again."}</p>}
                      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        {isOpenStatus(o.status) ? (
                          <>
                            <label className="faint" htmlFor={`st-${o.id}`}>Status</label>
                            <select id={`st-${o.id}`} className="select" style={{ width: "auto" }} value={o.status} disabled={setStatus.isPending} onChange={(e) => setStatus.mutate({ id: o.id, status: e.target.value as Status })}>
                              {STATUSES.filter(([k]) => isOpenStatus(k)).map(([k, name]) => <option key={k} value={k}>{name}</option>)}
                            </select>
                            <span className="faint">{o.statusSetBy === "human" ? "set by a person" : "set by the agent"}</span>
                          </>
                        ) : o.status === "converted" ? (
                          <span className="muted">{o.convertedBugId ? "Tracked as a bug report, so it cannot be archived or resolved here." : "Its bug report no longer exists."}</span>
                        ) : (
                          <span className="muted">{nameOf(STATUSES, o.status)}{o.statusChangedAt ? ` · ${o.statusChangedAt.slice(0, 10)}` : ""}{o.statusSetBy === "agent" ? " · set by the agent" : ""}</span>
                        )}
                        <span className="spacer" />
                        {isOpenStatus(o.status) && (
                          <>
                            <button className="btn sm" disabled={closing.isPending} onClick={() => close(o, "archive")}>Archive</button>
                            <button className="btn sm" disabled={closing.isPending} onClick={() => close(o, "resolve")}>Mark as resolved</button>
                          </>
                        )}
                        {(o.status === "archived" || o.status === "resolved" || (o.status === "converted" && !o.convertedBugId)) && (
                          <button className="btn sm" disabled={closing.isPending} onClick={() => close(o, "reopen")}>Reopen</button>
                        )}
                        {o.convertedBugId
                          ? <Link className="btn sm" to={`/p/${pid}/bugs?bug=${o.convertedBugId}`}>Open the bug report</Link>
                          : <button className="btn sm" onClick={() => setConverting(o)}>Convert to bug</button>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {items.length === 0 && (
              <p className="faint" style={{ padding: 12, margin: 0 }}>
                {status === "" && !kind && !severity
                  ? "Nothing is open. Archived, resolved and converted observations are under their own status filters."
                  : "No observation matches these filters."}
              </p>
            )}
          </div>
          <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>Showing {items.length} of {data.counts.total} in this project. Click a row to open it.</div>
        </div>
      </div>
      {converting && (
        <Modal
          title={`Make ${converting.label} a bug report?`}
          onClose={convert.isPending ? () => {} : () => setConverting(null)}
          width={480}
          footer={
            <>
              <button className="btn ghost" onClick={() => setConverting(null)} disabled={convert.isPending}>Cancel</button>
              <button className="btn primary" disabled={convert.isPending} onClick={() => convert.mutate(converting.id)}>{convert.isPending ? "Making…" : "Make a bug report"}</button>
            </>
          }
        >
          <div className="col" style={{ gap: 10 }}>
            <p style={{ margin: 0 }}>A bug report called "{converting.title}" is made from this observation. It starts as proposed under Bug reports, like any report from an agent, until you accept or reject it.</p>
            <p className="muted" style={{ margin: 0 }}>The observation stays here with the status Converted, and can no longer be archived or resolved. This can only be done once for each observation.</p>
          </div>
        </Modal>
      )}
    </>
  );
}
