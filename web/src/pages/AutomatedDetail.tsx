import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bug, FileText, Loader2, MonitorPlay } from "lucide-react";
import { api, formatDateTime, formatDuration, type AutomatedResultDetail, type EvidenceFile, type Status } from "../api";
import { StatusIcon } from "../components/ui";
import { AutomatedBugReportModal, jiraLabel, jiraUrl } from "./BugReport";

const fileUrl = (f: EvidenceFile) => `/uploads/${f.stored_name}`;
/** Playwright's trace viewer is served by this app, so the trace never leaves the machine. */
const traceUrl = (f: EvidenceFile) => `/trace-viewer/index.html?trace=${encodeURIComponent(new URL(fileUrl(f), window.location.origin).href)}`;

const isTrace = (f: EvidenceFile) => f.label === "trace" || /trace\.zip$/i.test(f.filename);
const isVideo = (f: EvidenceFile) => f.mime.startsWith("video/");
const isImage = (f: EvidenceFile) => f.mime.startsWith("image/");

/** Playwright statuses beyond passed/skipped (failed, timedOut, interrupted) all show as failed. */
const attemptStatus = (s: string): Status => (s === "passed" ? "passed" : s === "skipped" ? "skipped" : "failed");
const attemptLabel = (i: number) => (i === 0 ? "Attempt 1" : `Retry ${i}`);
const HISTORY_COLOR: Record<string, string> = { passed: "var(--passed)", failed: "var(--failed)", skipped: "var(--skipped)", blocked: "var(--blocked)", untested: "var(--untested)" };

export function AutomatedDetail({ resultId }: { resultId: number }) {
  const { pid } = useParams();
  const { data: d } = useQuery({ queryKey: ["automated-result", resultId], queryFn: () => api.get<AutomatedResultDetail>(`/api/results/${resultId}/automated`) });
  const [picked, setPicked] = useState<number | null>(null);
  const [bugOpen, setBugOpen] = useState(false);

  const box = { padding: "12px 20px 16px 52px", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 14 } as const;
  if (!d) return <div className="row muted" style={{ ...box, flexDirection: "row" }}><Loader2 size={14} className="spin" /> Loading…</div>;

  const attempts = d.detail?.attempts ?? [];
  // Open on the attempt that explains the result: the last one that failed, otherwise the last one.
  const lastFailing = attempts.map((a) => attemptStatus(a.status)).lastIndexOf("failed");
  const idx = picked ?? (lastFailing >= 0 ? lastFailing : Math.max(0, attempts.length - 1));
  const attempt = attempts[idx];
  const files = d.attachments.filter((f) => (f.attempt ?? idx) === idx);
  const shots = files.filter(isImage);
  const videos = files.filter(isVideo);
  const traces = files.filter(isTrace);
  const other = files.filter((f) => !isImage(f) && !isVideo(f) && !isTrace(f));
  const failedCount = d.history.filter((h) => h.status === "failed").length;
  const canReport = d.status === "failed" || !!d.flaky;

  return (
    <div style={box}>
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        {d.detail?.location && <span className="chip mono" title="Where the test is defined">{d.detail.location.file}:{d.detail.location.line}</span>}
        {d.detail?.projectName && <span className="chip">{d.detail.projectName}</span>}
        {d.detail?.annotations.map((a, i) => (
          <span key={i} className="chip" title={a.type}>
            {a.type}{a.description ? `: ${a.description}` : ""}
          </span>
        ))}
        <span className="chip">{formatDuration(d.duration_ms)} total</span>
        <span className="spacer" />
        {d.jira_key &&
          (jiraUrl(d.jira_key) ? (
            <a className="chip accent" href={jiraUrl(d.jira_key)!} target="_blank" rel="noreferrer">{jiraLabel(d.jira_key)}</a>
          ) : (
            <span className="chip accent">{jiraLabel(d.jira_key)}</span>
          ))}
        {canReport && (
          <button className="btn sm" onClick={() => setBugOpen(true)}><Bug size={13} /> {d.jira_key ? "Edit bug report" : "Report bug"}</button>
        )}
      </div>

      {d.history.length > 1 && (
        <div className="row" style={{ gap: 10 }}>
          <span className="section-label" style={{ margin: 0 }}>History</span>
          <div className="row" style={{ gap: 3 }}>
            {d.history.map((h) => (
              <Link
                key={h.id}
                to={`/p/${pid}/runs/${h.run_id}`}
                title={`${h.run_title} · ${formatDateTime(h.started_at)} · ${h.status}${h.flaky ? " (flaky)" : ""}`}
                aria-label={`${h.run_title}: ${h.status}`}
                style={{
                  width: 9, height: 18, borderRadius: 3, background: h.flaky ? "var(--flaky)" : HISTORY_COLOR[h.status],
                  outline: h.id === d.id ? "2px solid var(--accent)" : "none", outlineOffset: 1,
                }}
              />
            ))}
          </div>
          <span className="faint" style={{ fontSize: 12 }}>failed {failedCount} of the last {d.history.length} runs</span>
        </div>
      )}

      {attempts.length > 1 && (
        <div className="tabs" role="tablist" aria-label="Attempts">
          {attempts.map((a, i) => (
            <button key={i} role="tab" aria-selected={idx === i} className={`tab${idx === i ? " active" : ""}`} onClick={() => setPicked(i)}>
              <StatusIcon status={attemptStatus(a.status)} size={12} /> {attemptLabel(i)}
              <span className="count">{formatDuration(a.durationMs)}</span>
            </button>
          ))}
        </div>
      )}

      {attempt?.errors.length ? (
        attempt.errors.map((e, i) => (
          <div key={i} className="col" style={{ gap: 4 }}>
            <pre className="error">{e.message}</pre>
            {e.location && <span className="faint mono">{e.location.file}:{e.location.line}:{e.location.column}</span>}
          </div>
        ))
      ) : !attempt && d.error ? (
        <pre className="error">{d.error}</pre>
      ) : attempt && attemptStatus(attempt.status) === "passed" ? (
        <span className="muted">This attempt passed.</span>
      ) : null}

      {(shots.length > 0 || videos.length > 0 || traces.length > 0 || other.length > 0) && (
        <div className="col" style={{ gap: 10 }}>
          <span className="section-label" style={{ margin: 0 }}>Evidence</span>
          {shots.length > 0 && (
            <div className="thumbs">
              {shots.map((f) => (
                <a key={f.id} href={fileUrl(f)} target="_blank" rel="noreferrer" className="thumb" style={{ width: 200, height: 125 }} title={`${f.filename} (opens full size)`}>
                  <img src={fileUrl(f)} alt={`${f.label ?? "Screenshot"} from ${attemptLabel(idx).toLowerCase()}`} loading="lazy" />
                </a>
              ))}
            </div>
          )}
          {videos.map((f) => (
            <video key={f.id} src={fileUrl(f)} controls preload="metadata" style={{ maxWidth: 520, width: "100%", borderRadius: 6, border: "1px solid var(--border-strong)", background: "#000" }} />
          ))}
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            {traces.map((f) => (
              <a key={f.id} className="btn sm primary" href={traceUrl(f)} target="_blank" rel="noreferrer"><MonitorPlay size={13} /> Open trace</a>
            ))}
            {other.map((f) => (
              <a key={f.id} className="btn ghost sm" href={fileUrl(f)} target="_blank" rel="noreferrer"><FileText size={13} /> {f.label === "error-context" ? "Error context" : f.filename}</a>
            ))}
          </div>
        </div>
      )}

      {(attempt?.stdout || attempt?.stderr) && (
        <details>
          <summary className="muted" style={{ cursor: "pointer", fontSize: 12.5 }}>Console output</summary>
          {attempt.stdout && <pre className="snippet" style={{ marginTop: 6 }}>{attempt.stdout}</pre>}
          {attempt.stderr && <pre className="snippet" style={{ marginTop: 6, color: "var(--failed-fg)" }}>{attempt.stderr}</pre>}
        </details>
      )}

      {bugOpen && <AutomatedBugReportModal detail={d} onClose={() => setBugOpen(false)} />}
    </div>
  );
}
