import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Copy, Download, Gauge } from "lucide-react";
import { api, formatDateTime, type LoadReportData } from "../api";
import { loadReportMarkdown, loadSummary, OUTCOME, ranSeconds, VERDICT } from "../loadOptions";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { LoadChart } from "../components/charts";
import { Empty, useToast } from "../components/ui";

// What a load test found, as the agent handed it in (server/loadtest.ts checked it against what the person asked for). Everything the agent wrote (the reason, the paths) is data for a
// person to read, shown as text.

const ms = (n: number) => `${Math.round(n)} ms`;
const pct = (n: number) => `${Math.round(n * 100) / 100} %`;
const rate = (n: number) => `${Math.round(n * 10) / 10}`;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card" style={{ padding: "12px 14px", minWidth: 120 }}>
      <div className="stat">
        <span className="label">{label}</span>
        <span className="value">{value}</span>
        <span className="muted" style={{ minHeight: 18, fontSize: "var(--fs-sm)" }}>{sub}</span>
      </div>
    </div>
  );
}

/** Saves text as a file in the person's browser. Nothing is sent anywhere. */
function save(name: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function LoadReportPage() {
  const { pid, requestId } = useParams();
  const toast = useToast();
  const { data, error, isLoading } = useQuery({ queryKey: ["load-result", requestId], queryFn: () => api.get<LoadReportData>(`/api/agent-requests/${requestId}/load-result`) });
  const back = `/p/${pid}/automated?view=requests`;
  if (isLoading) return <div className="content"><div className="muted" style={{ padding: 20 }}>Loading the report…</div></div>;
  if (error || !data) {
    return (
      <div className="content">
        <Empty icon={<Gauge size={20} />} title="No report to show" action={<Link to={back} style={{ color: "var(--accent-text)" }}>Back to the requests</Link>}>
          {error instanceof Error ? error.message : "This load test has no result yet. It shows here when the agent has handed it in."}
        </Empty>
      </div>
    );
  }
  const { request, result: r } = data;
  const v = VERDICT[r.verdict];
  const markdown = loadReportMarkdown(request, r);
  const copy = () => { try { void navigator.clipboard.writeText(markdown).then(() => toast("success", "Copied as Markdown"), () => toast("error", "Could not copy")); } catch { toast("error", "Could not copy"); } };
  return (
    <>
      <div className="topbar">
        <Link to={back} className="muted" style={{ display: "inline-flex", gap: 4, alignItems: "center" }} aria-label="Back to the requests"><ArrowLeft size={14} /> Requests</Link>
        <h1>Load test · request #{request.id}{request.name ? ` · ${request.name}` : ""}</h1>
        <Badge tone={v.tone} title={r.verdictReason}>{v.label}</Badge>
        <span className="spacer" />
        <Button onClick={copy} title="Copy the report as Markdown, to paste into a bug or a message"><Copy size={14} /> Copy as Markdown</Button>
        <Button onClick={() => save(`load-test-request-${request.id}.json`, "application/json", JSON.stringify(r, null, 2))} title="Save the result as JSON"><Download size={14} /> Download JSON</Button>
      </div>
      <div className="content">
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16, maxWidth: 960 }}>
          <div>
            <div style={{ fontSize: "var(--fs-lg)", overflowWrap: "anywhere" }} data-verdict-reason>{r.verdictReason}</div>
            <div className="muted" style={{ overflowWrap: "anywhere" }}>
              {OUTCOME[r.outcome]} · ran {ranSeconds(r)} s of {r.params.durationSeconds} s · <code className="inline mono">{request.targetUrl}</code>
              {request.environment ? ` · ${request.environment}` : ""} · {formatDateTime(r.startedAt)}
            </div>
            {request.loadOptions && <div className="faint" style={{ fontSize: "var(--fs-sm)" }} title="What the person asked for. The result can never use more than this.">Asked for: {loadSummary(request.loadOptions)}</div>}
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }} data-load-totals>
            <Stat label="Requests" value={String(r.totals.requests)} sub={`${rate(r.totals.rps)} per second`} />
            <Stat label="Errors" value={pct(r.totals.errorRate)} sub={`${r.totals.errors} failed`} />
            <Stat label="p50" value={ms(r.totals.p50Ms)} />
            <Stat label="p95" value={ms(r.totals.p95Ms)} />
            <Stat label="p99" value={ms(r.totals.p99Ms)} />
            <Stat label="Slowest" value={ms(r.totals.maxMs)} />
          </div>

          <div className="card" style={{ padding: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Response time over time</div>
            <LoadChart timeline={r.timeline} p95Limit={request.loadOptions?.maxP95Ms ?? null} />
          </div>

          <div className="card" style={{ overflowX: "auto" }}>
            <table className="table" data-load-paths>
              <thead>
                <tr><th>Path</th><th style={{ textAlign: "right" }}>Requests</th><th style={{ textAlign: "right" }}>Errors</th><th style={{ textAlign: "right" }}>p50</th><th style={{ textAlign: "right" }}>p95</th><th style={{ textAlign: "right" }}>p99</th><th style={{ textAlign: "right" }}>Req/s</th><th>Answers</th></tr>
              </thead>
              <tbody>
                {r.paths.map((p) => (
                  <tr key={p.path}>
                    <td><code className="inline mono" style={{ overflowWrap: "anywhere" }}>{p.path}</code></td>
                    <td style={{ textAlign: "right" }}>{p.requests}</td>
                    <td style={{ textAlign: "right" }}>{pct(p.errorRate)}</td>
                    <td style={{ textAlign: "right" }}>{ms(p.p50Ms)}</td>
                    <td style={{ textAlign: "right" }}>{ms(p.p95Ms)}</td>
                    <td style={{ textAlign: "right" }}>{ms(p.p99Ms)}</td>
                    <td style={{ textAlign: "right" }}>{rate(p.rps)}</td>
                    <td className="muted">{Object.entries(p.statuses).map(([code, n]) => `${code}: ${n}`).join(", ") || "none"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>
            Handed in by the agent {formatDateTime(data.deliveredAt)}. TestBench checked the result against what was asked for (users, time and paths), not the measurements themselves: they are what the agent reports.
          </div>
        </div>
      </div>
    </>
  );
}
