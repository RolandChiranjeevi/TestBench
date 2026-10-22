import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Flame, Gauge, Sparkles } from "lucide-react";
import { api, formatDateTime, formatDuration, timeAgo, type Insights, type Project } from "../api";
import { DurationChart } from "../components/charts";
import { Empty, PriorityIcon } from "../components/ui";

/** Switch between the test list and the insights on the Automated tests page. */
export function ViewTabs({ view }: { view: "tests" | "insights" }) {
  const { pid } = useParams();
  return (
    <div className="tabs" role="tablist" aria-label="View">
      <Link role="tab" aria-selected={view === "tests"} className={`tab${view === "tests" ? " active" : ""}`} to={`/p/${pid}/automated`}>Tests</Link>
      <Link role="tab" aria-selected={view === "insights"} className={`tab${view === "insights" ? " active" : ""}`} to={`/p/${pid}/automated?view=insights`}>Insights</Link>
    </div>
  );
}

const STRIP_COLOR: Record<string, string> = { passed: "var(--passed)", failed: "var(--failed)", skipped: "var(--skipped)", blocked: "var(--blocked)", untested: "var(--untested)" };

export function InsightsPage() {
  const { pid } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const requested = Number(params.get("runs"));
  const windowRuns = [10, 20, 50].includes(requested) ? requested : 20;
  const { data: d } = useQuery({ queryKey: ["insights", pid, windowRuns], queryFn: () => api.get<Insights>(`/api/projects/${pid}/insights?runs=${windowRuns}`) });
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });
  const key = projects?.find((p) => p.id === Number(pid))?.key;

  const setWindow = (n: number) => setParams((p) => { const next = new URLSearchParams(p); next.set("runs", String(n)); return next; }, { replace: true });

  return (
    <>
      <div className="topbar">
        <h1>Automated tests</h1>
        <ViewTabs view="insights" />
        <span className="spacer" />
        <label className="row muted" style={{ fontSize: "var(--fs-md)" }}>
          Based on the last
          <select className="select" style={{ width: 110, height: 28 }} value={windowRuns} onChange={(e) => setWindow(Number(e.target.value))} aria-label="Number of runs">
            <option value={10}>10 runs</option>
            <option value={20}>20 runs</option>
            <option value={50}>50 runs</option>
          </select>
        </label>
      </div>
      <div className="content">
        {!d ? null : (
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16, maxWidth: 1100 }}>
            {/* ---- Flaky ---- */}
            <div className="card">
              <div className="card-header" role="heading" aria-level={2} style={{ fontSize: "var(--fs-md)" }}>
                <Flame size={14} /> Flaky tests <span className="faint" style={{ fontWeight: 400 }}>{d.flakyTotal ? `${d.flakyTotal} found` : ""}</span>
              </div>
              <div className="muted" style={{ padding: "12px 16px 0", fontSize: "var(--fs-md)" }}>
                A test counts as flaky when it needed a retry to pass, or keeps flipping between passing and failing. Retries are shown even when the final result was green,
                because that is what a passing run hides. Tests that fail every time are broken, not flaky, and are not listed here.
              </div>
              {d.flaky.length === 0 ? (
                <div className="muted" style={{ padding: 16 }}>
                  {d.runs.length === 0 ? "Import some automated runs first." : "No flaky tests in this window. Retries are only visible from Playwright JSON reports."}
                </div>
              ) : (
                <div style={{ marginTop: 12 }}>
                  {d.flaky.map((f) => (
                    <div
                      key={f.testId}
                      className="list-row"
                      style={{ height: 56 }}
                      onClick={() => navigate(`/p/${pid}/runs/${f.lastEventRunId}`)}
                      title="Open the latest run where it failed or needed a retry"
                    >
                      <div className="grow col" style={{ gap: 1, minWidth: 0 }}>
                        <span className="truncate" title={f.title}>{f.title}</span>
                        <span className="faint truncate mono" style={{ fontSize: "var(--fs-sm)" }}>{f.file}</span>
                      </div>
                      <div className="row" style={{ gap: 2, flexShrink: 0 }} aria-label="Result of each run, oldest first">
                        {f.strip.map((s, i) => (
                          <Link
                            key={i}
                            to={`/p/${pid}/runs/${s.runId}`}
                            onClick={(e) => e.stopPropagation()}
                            title={`${s.runTitle} · ${formatDateTime(s.startedAt)} · ${s.flaky ? "passed after a retry" : s.status}`}
                            aria-label={`${s.runTitle}: ${s.flaky ? "passed after a retry" : s.status}`}
                            style={{ width: 8, height: 20, borderRadius: 3, background: s.flaky ? "var(--flaky)" : STRIP_COLOR[s.status] }}
                          />
                        ))}
                      </div>
                      <div className="col tabular" style={{ gap: 1, width: 190, flexShrink: 0, fontSize: "var(--fs-sm)", alignItems: "flex-end" }}>
                        <span>failed {f.failures} of {f.runs}{f.failingNow && <span style={{ color: "var(--failed-fg)" }}> · failing now</span>}</span>
                        <span className="faint">{f.retries ? `${f.retries} needed a retry` : ""}{f.retries && f.flips ? " · " : ""}{f.flips ? `flipped ${f.flips}×` : ""}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ---- Time ---- */}
            <div className="two-col two-col-3-2">
              <div className="card">
                <div className="card-header" role="heading" aria-level={2} style={{ fontSize: "var(--fs-md)" }}><Gauge size={14} /> Test time per run</div>
                <div className="card-body">
                  <DurationChart
                    bars={d.runs.map((r) => ({ id: r.id, label: r.title, date: r.started_at, ms: r.duration_ms, failed: r.failed }))}
                    onOpen={(id) => navigate(`/p/${pid}/runs/${id}`)}
                  />
                  <div className="faint" style={{ fontSize: "var(--fs-sm)", marginTop: 6 }}>Sum of every test's own time, not wall-clock time (tests run in parallel). Red bars had failures.</div>
                </div>
              </div>
              <div className="card">
                <div className="card-header" role="heading" aria-level={2} style={{ fontSize: "var(--fs-md)" }}>Getting slower</div>
                {d.slowdowns.length === 0 ? (
                  <div className="muted" style={{ padding: 16 }}>No test has slowed down noticeably. A test needs at least 6 timed runs, and its last 3 must be 25% and 300 ms slower than before.</div>
                ) : (
                  d.slowdowns.map((s) => (
                    <Link key={s.testId} to={`/p/${pid}/runs/${s.runId}`} className="row" style={{ padding: "8px 16px", borderBottom: "1px solid var(--border)", minHeight: 46 }}>
                      <div className="grow col" style={{ gap: 0, minWidth: 0 }}>
                        <span className="truncate" title={s.title}>{s.title}</span>
                        <span className="faint tabular" style={{ fontSize: "var(--fs-sm)" }}>{formatDuration(s.beforeMs)} → {formatDuration(s.recentMs)}</span>
                      </div>
                      <span className="tabular" style={{ color: "var(--blocked-fg)", fontWeight: 500 }}>+{s.pct}%</span>
                    </Link>
                  ))
                )}
              </div>
            </div>

            {/* ---- Automate next ---- */}
            <div className="card">
              <div className="card-header" role="heading" aria-level={2} style={{ fontSize: "var(--fs-md)" }}>
                <Sparkles size={14} /> Automate next <span className="faint" style={{ fontWeight: 400 }}>{d.candidatesTotal} manual {d.candidatesTotal === 1 ? "case has" : "cases have"} no automated test</span>
              </div>
              {d.candidates.length === 0 ? (
                <div className="muted" style={{ padding: 16 }}>Every active case has an automated test, or there are no cases yet.</div>
              ) : (
                d.candidates.map((c) => (
                  <Link key={c.id} to={`/p/${pid}/cases?case=${c.id}`} className="list-row" style={{ height: 44 }}>
                    <PriorityIcon priority={c.priority} />
                    <span className="mono muted" style={{ width: 62 }}>{key}-{c.number}</span>
                    <span className="title">{c.title}</span>
                    <span className="meta">
                      {c.reasons.map((r) => <span key={r} className="chip">{r}</span>)}
                      <span className="faint" style={{ width: 70, textAlign: "right" }}>{c.lastManual ? timeAgo(c.lastManual) : "never run"}</span>
                    </span>
                  </Link>
                ))
              )}
              <div className="faint" style={{ padding: "12px 16px", fontSize: "var(--fs-sm)" }}>
                Ranked by priority, how often the case is run by hand, how often it fails, and whether it's a smoke or regression case.
                Put <code className="inline">@{key ?? "KEY"}-n</code> in a new test's title to link it, and it leaves this list.
              </div>
            </div>

            {d.runs.length === 0 && d.candidatesTotal === 0 && <Empty icon={<Gauge size={20} />} title="Nothing to analyse yet">Import automated runs and run your cases to see insights here.</Empty>}
          </div>
        )}
      </div>
    </>
  );
}
