import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Download, Link2, Search, Sparkles } from "lucide-react";
import { api, formatDuration, timeAgo, type AutomatedTest, type CaseSummary, type Project } from "../api";
import { Empty, FrameworkBadge, StatusIcon, useToast } from "../components/ui";
import { InsightsPage, ViewTabs } from "./Insights";

type Filter = "all" | "unlinked" | "failing" | "flaky";

export function AutomatedPage() {
  const { pid } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const filter = (params.get("filter") as Filter) || "all";
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [framework, setFramework] = useState("");

  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });
  const key = projects?.find((p) => p.id === Number(pid))?.key;
  const { data: tests, isLoading } = useQuery({ queryKey: ["automated", pid], queryFn: () => api.get<AutomatedTest[]>(`/api/projects/${pid}/automated`) });
  const { data: cases = [] } = useQuery({ queryKey: ["cases", pid], queryFn: () => api.get<CaseSummary[]>(`/api/projects/${pid}/cases`) });

  const { data: features } = useQuery({ queryKey: ["features"], queryFn: () => api.get<{ linkSuggestions: boolean }>("/api/features"), staleTime: 60_000 });
  const relink = useMutation({
    mutationFn: () => api.post<{ linked: number }>(`/api/projects/${pid}/automated/relink`),
    onSuccess: (r) => {
      for (const k of ["automated", "cases", "case", "run", "dashboard", "requirements"]) qc.invalidateQueries({ queryKey: [k] });
      toast("success", r.linked ? `Linked ${r.linked} ${r.linked === 1 ? "test" : "tests"} by the case ID in the name` : "No more tests matched a case ID in their name");
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const link = useMutation({
    mutationFn: ({ id, caseId }: { id: number; caseId: number | null }) => api.patch(`/api/automated/${id}`, { caseId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["automated", pid] });
      qc.invalidateQueries({ queryKey: ["cases", pid] });
      qc.invalidateQueries({ queryKey: ["case"] });
      qc.invalidateQueries({ queryKey: ["run"] });
    },
    onError: (e: Error) => toast("error", e.message),
  });

  const frameworks = useMemo(() => [...new Set((tests ?? []).map((t) => t.framework))], [tests]);
  const q = search.trim().toLowerCase();
  const matches = (t: AutomatedTest, f: Filter) =>
    (f === "all" ||
      (f === "unlinked" && !t.case_id) ||
      (f === "failing" && t.last_status === "failed") ||
      (f === "flaky" && (t.flaky_count ?? 0) > 0)) &&
    (!framework || t.framework === framework);
  const visible = (tests ?? []).filter((t) => matches(t, filter) && (!q || `${t.full_name} ${t.file}`.toLowerCase().includes(q)));
  const count = (f: Filter) => (tests ?? []).filter((t) => matches(t, f)).length;
  const linkedPct = tests?.length ? Math.round(((tests.length - (tests ?? []).filter((t) => !t.case_id).length) / tests.length) * 100) : 0;

  if (params.get("view") === "insights") return <InsightsPage />;

  return (
    <>
      <div className="topbar">
        <h1>Automated tests</h1>
        <ViewTabs view="tests" />
        {tests && tests.length > 0 && <span className="faint" style={{ fontSize: 12.5 }}>{linkedPct}% linked to cases</span>}
        <span className="spacer" />
        <div className="search">
          <Search size={13} />
          <input className="input" placeholder="Search tests" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search tests" />
        </div>
        {tests?.some((t) => !t.case_id) && (
          <button className="btn" onClick={() => relink.mutate()} disabled={relink.isPending} title={`Link tests whose name contains a case ID like ${key}-12`}>
            <Link2 size={14} /> Re-link by name
          </button>
        )}
        <button className="btn" onClick={() => navigate(`/p/${pid}/import`)}><Download size={14} /> Import results</button>
      </div>
      <div className="toolbar">
        <div className="tabs" role="tablist">
          {(["all", "unlinked", "failing", "flaky"] as const).map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              className={`tab${filter === f ? " active" : ""}`}
              onClick={() => setParams(f === "all" ? {} : { filter: f }, { replace: true })}
            >
              {{ all: "All", unlinked: "Not linked", failing: "Failing", flaky: "Flaky" }[f]} <span className="count">{count(f)}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        {frameworks.length > 1 && (
          <select className="select" style={{ width: 150, height: 28 }} value={framework} onChange={(e) => setFramework(e.target.value)} aria-label="Framework">
            <option value="">All frameworks</option>
            {frameworks.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        )}
      </div>
      <div className="content">
        {features?.linkSuggestions && !!tests?.some((t) => !t.case_id) && <SuggestionsPanel />}
        {isLoading ? null : !tests?.length ? (
          <Empty
            icon={<Bot size={20} />}
            title="No automated tests yet"
            action={<button className="btn primary" onClick={() => navigate(`/p/${pid}/import`)}><Download size={14} /> Import results</button>}
          >
            Tests appear here once you import a Playwright, TestCafe or Selenium report. Put <code className="inline">@{key}-12</code> in a test title to link it to a case automatically.
          </Empty>
        ) : visible.length === 0 ? (
          <Empty icon={<Search size={20} />} title="No matching tests" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 28 }} />
                <th>Test</th>
                <th>Framework</th>
                <th style={{ width: 280 }}>Linked case</th>
                <th style={{ textAlign: "right" }}>Runs</th>
                <th style={{ textAlign: "right" }}>Failures</th>
                <th style={{ textAlign: "right" }}>Flaky</th>
                <th style={{ textAlign: "right" }}>Avg time</th>
                <th style={{ textAlign: "right" }}>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => (
                <tr key={t.id}>
                  <td><StatusIcon status={t.last_status} /></td>
                  <td style={{ maxWidth: 420 }}>
                    <div className="truncate" title={t.full_name}>{t.title}</div>
                    <div className="faint truncate mono" style={{ fontSize: 11 }}>{[t.file, t.suite_path].filter(Boolean).join(" › ")}</div>
                  </td>
                  <td><FrameworkBadge framework={t.framework} /></td>
                  <td>
                    <div className="row" style={{ gap: 6, maxWidth: 280 }}>
                      {t.case_id && (
                        <Link to={`/p/${pid}/cases?case=${t.case_id}`} className="chip accent" title="Open case" style={{ minHeight: 24, display: "inline-flex", alignItems: "center" }}>
                          {key}-{t.case_number}
                        </Link>
                      )}
                      <label className="pill" style={{ height: 24, minWidth: 0, flex: 1 }}>
                        <Link2 size={12} style={{ flexShrink: 0 }} />
                        <span className="truncate" style={{ color: t.case_id ? "var(--text-2)" : "var(--text-4)" }}>{t.case_id ? t.case_title : "Link to case…"}</span>
                        <select
                          value={t.case_id ?? ""}
                          onChange={(e) => link.mutate({ id: t.id, caseId: e.target.value ? Number(e.target.value) : null })}
                          aria-label={`Linked case for ${t.title}`}
                        >
                          <option value="">Not linked</option>
                          {cases.map((c) => <option key={c.id} value={c.id}>{key}-{c.number} {c.title}</option>)}
                        </select>
                      </label>
                    </div>
                  </td>
                  <td className="tabular" style={{ textAlign: "right" }}>{t.run_count}</td>
                  <td className="tabular" style={{ textAlign: "right", color: t.fail_count ? "var(--failed-fg)" : "var(--text-4)" }}>{t.fail_count || "–"}</td>
                  <td className="tabular" style={{ textAlign: "right", color: t.flaky_count ? "var(--flaky-fg)" : "var(--text-4)" }}>{t.flaky_count || "–"}</td>
                  <td className="tabular muted" style={{ textAlign: "right" }}>{formatDuration(t.avg_duration_ms)}</td>
                  <td className="muted" style={{ textAlign: "right" }}>{timeAgo(t.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

interface Suggestions {
  suggestions: { testId: number; title: string; file: string; framework: string; candidates: { caseId: number; number: number; title: string; probability: number }[] }[];
  unjudged: number;
  threshold: number;
}

/** Optional AI suggestions: tests that probably verify an existing case. Nothing is linked until you accept. */
function SuggestionsPanel() {
  const { pid } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });
  const key = projects?.find((p) => p.id === Number(pid))?.key;
  const queryKey = ["link-suggestions", pid];
  const { data } = useQuery({ queryKey, queryFn: () => api.get<Suggestions>(`/api/projects/${pid}/automated/link-suggestions`) });

  const check = useMutation({
    mutationFn: (force: boolean) => api.post<{ judged: number; remaining: number; error: string | null }>(`/api/projects/${pid}/automated/suggest-links`, { force }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey });
      if (r.error) toast("error", r.error);
      else toast("success", `Checked ${r.judged} ${r.judged === 1 ? "test" : "tests"}${r.remaining ? `, ${r.remaining} left` : ""}`);
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const accept = useMutation({
    mutationFn: ({ testId, caseId }: { testId: number; caseId: number }) => api.patch(`/api/automated/${testId}`, { caseId }),
    onSuccess: () => {
      for (const k of ["automated", "cases", "case", "run", "dashboard", "link-suggestions"]) qc.invalidateQueries({ queryKey: [k] });
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const dismiss = useMutation({
    mutationFn: (v: { testId: number; caseId: number }) => api.post("/api/link-suggestions/dismiss", v),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });

  const unjudged = data?.unjudged ?? 0;
  return (
    <div className="card" style={{ margin: "16px 20px 0" }}>
      <div className="card-header row" style={{ fontSize: 13 }}>
        <Sparkles size={14} style={{ color: "var(--accent-text)" }} />
        <span style={{ fontWeight: 600 }}>Suggested links</span>
        <span className="faint" style={{ fontSize: 12 }}>
          Judged by TypeSafe from the test and case text. Titles and steps are sent to their API. Review each one.
        </span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => check.mutate(!unjudged)} disabled={check.isPending}>
          {check.isPending ? "Checking…" : unjudged ? `Check ${Math.min(unjudged, 20)} of ${unjudged} unlinked tests` : "Check again"}
        </button>
      </div>
      {data && data.suggestions.length === 0 && (
        <div className="muted" style={{ padding: 16, fontSize: 12.5 }}>
          {unjudged ? "Not checked yet." : `No suggestions at ${Math.round(data.threshold * 100)}% or higher.`}
        </div>
      )}
      {data?.suggestions.map((s) => (
        <div key={s.testId} style={{ padding: "8px 16px", borderTop: "1px solid var(--border)" }}>
          <div className="truncate" title={s.title}>{s.title}</div>
          <div className="faint truncate mono" style={{ fontSize: 11 }}>{s.file}</div>
          {s.candidates.map((c) => (
            <div key={c.caseId} className="row" style={{ marginTop: 4 }}>
              <span className="mono muted" style={{ width: 62 }}>{key}-{c.number}</span>
              <span className="truncate grow">{c.title}</span>
              <span className="chip" title="Probability that the test checks this case">{Math.round(c.probability * 100)}%</span>
              <button className="btn sm primary" onClick={() => accept.mutate({ testId: s.testId, caseId: c.caseId })} disabled={accept.isPending}>Link</button>
              <button className="btn ghost sm" onClick={() => dismiss.mutate({ testId: s.testId, caseId: c.caseId })}>Dismiss</button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
