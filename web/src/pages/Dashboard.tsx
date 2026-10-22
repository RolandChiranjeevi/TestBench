import type { ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bot, Download, FlaskConical, Play, Sparkles } from "lucide-react";
import { api, formatDuration, passRate, timeAgo, type Dashboard, type TestStat } from "../api";
import { Empty, FrameworkBadge, PriorityIcon, ProgressBar, StatusIcon } from "../components/ui";
import { CoverageBar, TrendChart } from "../components/charts";

function Delta({ cur, prev }: { cur: number | null; prev: number | null }) {
  if (cur == null || prev == null) return null;
  const d = Math.round((cur - prev) * 10) / 10;
  if (d === 0) return <span className="faint" style={{ fontSize: 12 }}>no change</span>;
  return (
    <span style={{ fontSize: 12, fontWeight: 500, color: d > 0 ? "var(--passed-fg)" : "var(--failed-fg)" }}>
      {d > 0 ? "▲" : "▼"} {Math.abs(d)} pts vs previous run
    </span>
  );
}

function Stat({ label, value, sub, color }: { label: string; value: ReactNode; sub?: ReactNode; color?: string }) {
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div className="stat">
        <span className="label">{label}</span>
        <span className="value" style={{ color }}>{value}</span>
        <span style={{ minHeight: 18, fontSize: 12 }} className="muted">{sub}</span>
      </div>
    </div>
  );
}

function TestTable({ title, rows, metric, empty }: { title: string; rows: TestStat[]; metric: (t: TestStat) => ReactNode; empty: string }) {
  const { pid } = useParams();
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div className="card-header" style={{ fontSize: 13 }}>{title}</div>
      {rows.length === 0 ? (
        <div className="muted" style={{ padding: 16 }}>{empty}</div>
      ) : (
        rows.map((t) => (
          <Link key={t.id} to={`/p/${pid}/automated?q=${encodeURIComponent(t.title)}`} className="row" style={{ padding: "8px 16px", borderBottom: "1px solid var(--border)", minHeight: 42 }}>
            <StatusIcon status={t.last_status} />
            <div className="grow col" style={{ gap: 0 }}>
              <span className="truncate" title={t.title}>{t.title}</span>
              <span className="faint truncate mono" style={{ fontSize: 11 }}>{t.file}</span>
            </div>
            <span className="tabular" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>{metric(t)}</span>
          </Link>
        ))
      )}
    </div>
  );
}

export function DashboardPage() {
  const { pid } = useParams();
  const navigate = useNavigate();
  const { data: d, isLoading } = useQuery({ queryKey: ["dashboard", pid], queryFn: () => api.get<Dashboard>(`/api/projects/${pid}/dashboard`) });

  if (isLoading || !d) return null;
  const s = d.summary;
  const key = d.project.key;
  const hasRuns = d.automatedRuns.length + d.manualRuns.length > 0;

  return (
    <>
      <div className="topbar">
        <h1>Dashboard</h1>
        <span className="spacer" />
        <button className="btn" onClick={() => navigate(`/p/${pid}/import`)}><Download size={14} /> Import results</button>
        <button className="btn primary" onClick={() => navigate(`/p/${pid}/reports`)}>Sprint reports</button>
      </div>
      <div className="content">
        {!hasRuns && s.cases === 0 ? (
          <Empty icon={<FlaskConical size={20} />} title="Nothing to show yet">Write some test cases and run them, or import automated results, and the dashboard fills in.</Empty>
        ) : (
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16, maxWidth: 1400 }}>
            <div className="dash-tiles">
              <Stat
                label="Automated pass rate"
                value={s.latestRate == null ? "—" : `${s.latestRate}%`}
                color={s.latestRate == null ? undefined : s.latestRate >= 90 ? "var(--passed-fg)" : s.latestRate >= 70 ? "var(--blocked-fg)" : "var(--failed-fg)"}
                sub={<Delta cur={s.latestRate} prev={s.previousRate} />}
              />
              <Stat label="Automation coverage" value={`${s.coverage}%`} sub={`${s.automatedCases} of ${s.cases} cases have an automated test`} />
              {d.requirements.total > 0 && (
                <Stat
                  label="Requirement coverage"
                  value={`${Math.round((d.requirements.covered / d.requirements.total) * 100)}%`}
                  color={d.requirements.failing ? "var(--failed-fg)" : undefined}
                  sub={
                    <Link to={`/p/${pid}/requirements`} style={{ color: "var(--accent-text)" }}>
                      {d.requirements.covered} of {d.requirements.total} have test cases
                      {d.requirements.failing ? `, ${d.requirements.failing} failing` : ""}
                    </Link>
                  }
                />
              )}
              <Stat label="Failing cases" value={s.failingCases} color={s.failingCases ? "var(--failed-fg)" : undefined} sub="Latest result failed or blocked" />
              <Stat label="Flaky tests" value={s.flakyTests} color={s.flakyTests ? "var(--flaky-fg)" : undefined} sub="In the last 10 automated runs" />
              <Stat
                label="Unlinked tests"
                value={s.unlinkedTests}
                sub={s.unlinkedTests ? <Link to={`/p/${pid}/automated?filter=unlinked`} style={{ color: "var(--accent-text)" }}>Link them to cases</Link> : "All linked"}
              />
            </div>

            <div className="two-col two-col-2-1">
              <div className="card">
                <div className="card-header" style={{ fontSize: 13 }}>
                  Automated pass rate <span className="faint" style={{ fontWeight: 400 }}>last {d.automatedRuns.length} runs</span>
                </div>
                <div className="card-body">
                  <TrendChart
                    points={d.automatedRuns.map((r) => ({ id: r.id, label: r.title, date: r.started_at, rate: r.rate, detail: `${r.passed} passed, ${r.failed} failed` }))}
                    onOpen={(id) => navigate(`/p/${pid}/runs/${id}`)}
                  />
                </div>
              </div>
              <div className="card">
                <div className="card-header" style={{ fontSize: 13 }}>Manual runs</div>
                {d.manualRuns.length === 0 ? (
                  <div className="muted" style={{ padding: 16 }}>No manual runs yet.</div>
                ) : (
                  [...d.manualRuns].reverse().slice(0, 6).map((r) => (
                    <Link key={r.id} to={`/p/${pid}/runs/${r.id}`} className="col" style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", gap: 5 }}>
                      <div className="row">
                        <Play size={12} className="faint" />
                        <span className="truncate grow">{r.title}</span>
                        {r.run_status === "in_progress" && <span className="chip accent">In progress</span>}
                        <span className="tabular muted" style={{ fontSize: 12 }}>{passRate(r) == null ? "—" : `${passRate(r)}%`}</span>
                      </div>
                      <ProgressBar counts={r} />
                      <span className="faint" style={{ fontSize: 11.5 }}>
                        {r.total - r.untested}/{r.total} executed · {timeAgo(r.started_at)}{r.milestone && ` · ${r.milestone}`}
                      </span>
                    </Link>
                  ))
                )}
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))", gap: 16 }}>
              <TestTable title="Most failing" rows={d.mostFailing} empty="No failing tests in the last 10 runs." metric={(t) => <span style={{ color: "var(--failed-fg)" }}>{t.failures}/{t.runs} failed</span>} />
              <TestTable title="Flaky" rows={d.flaky} empty="No flaky tests. Playwright's JSON report is needed to detect them." metric={(t) => <span style={{ color: "var(--flaky-fg)" }}>{t.flaky}× flaky</span>} />
              <TestTable title="Slowest" rows={d.slowest} empty="No timing data yet." metric={(t) => formatDuration(t.avg_ms)} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(380px, 100%), 1fr))", gap: 16 }}>
              <div className="card">
                <div className="card-header" style={{ fontSize: 13 }}>Failing cases</div>
                {d.failingCases.length === 0 ? (
                  <div className="muted" style={{ padding: 16 }}>Every case's latest result is passing.</div>
                ) : (
                  d.failingCases.map((c) => (
                    <Link key={c.id} to={`/p/${pid}/cases?case=${c.id}`} className="row" style={{ padding: "0 16px", height: 38, borderBottom: "1px solid var(--border)" }}>
                      <StatusIcon status={c.status} />
                      <PriorityIcon priority={c.priority} />
                      <span className="mono muted" style={{ width: 62 }}>{key}-{c.number}</span>
                      <span className="truncate grow">{c.title}</span>
                      <span className="faint" style={{ fontSize: 12 }}>{timeAgo(c.executed_at)}</span>
                    </Link>
                  ))
                )}
              </div>
              <div className="card">
                <div className="card-header" style={{ fontSize: 13 }}><Bot size={14} /> Automation coverage by suite</div>
                <div className="card-body">
                  {d.bySuite.length === 0 ? <span className="muted">No suites yet.</span> : d.bySuite.map((x) => <CoverageBar key={x.name} label={x.name} value={x.automated} total={x.cases} />)}
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-header" style={{ fontSize: 13 }}>
                <Sparkles size={14} /> Automate next
                <Link to={`/p/${pid}/automated?view=insights`} style={{ marginLeft: "auto", color: "var(--accent-text)", fontSize: 12, fontWeight: 400 }}>
                  {d.candidatesTotal > d.candidates.length ? `All ${d.candidatesTotal}` : "Insights"}
                </Link>
              </div>
              {d.candidates.length === 0 ? (
                <div className="muted" style={{ padding: 16 }}>Every active case has an automated test.</div>
              ) : (
                d.candidates.map((c) => (
                  <Link key={c.id} to={`/p/${pid}/cases?case=${c.id}`} className="row" style={{ padding: "0 16px", height: 38, borderBottom: "1px solid var(--border)" }}>
                    <PriorityIcon priority={c.priority} />
                    <span className="mono muted" style={{ width: 62 }}>{key}-{c.number}</span>
                    <span className="truncate grow">{c.title}</span>
                    <span className="faint truncate" style={{ fontSize: 12, maxWidth: 220 }}>{c.reasons.join(" · ")}</span>
                  </Link>
                ))
              )}
            </div>

            {d.automatedRuns.length > 0 && (
              <div className="faint row" style={{ fontSize: 12, gap: 6 }}>
                Frameworks: {[...new Set(d.automatedRuns.map((r) => r.framework))].map((f) => <FrameworkBadge key={f} framework={f} />)}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
