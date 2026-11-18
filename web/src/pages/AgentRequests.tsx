import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, Plus } from "lucide-react";
import { auditPath, PROGRESS_TITLE, progressLabel } from "../agentruns";
import { api, timeAgo, type AgentRequest, type RunDetail } from "../api";
import type { Tone } from "../statuses";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { EditScope } from "../components/Access";
import { Empty, Modal, useToast } from "../components/ui";
import { useAgentRequests } from "../useAgentRequests";
import { ViewTabs } from "./Insights";

// What people ask a test agent to do. Testbench starts nothing: a request waits until an agent with a request token takes it, in the person's own environment, and
// the agent keeps its own stops (it asks before it tests, and a production target needs two confirmations). What it finds comes in through the import as proposals.

const STATUS: Record<AgentRequest["status"], { tone: Tone; label: string; title: string }> = {
  pending: { tone: "info", label: "Waiting", title: "No agent has taken it yet" },
  claimed: { tone: "accent", label: "Taken", title: "An agent has taken it and is working on it" },
  done: { tone: "ok", label: "Done", title: "The agent says it is finished" },
  cancelled: { tone: "neutral", label: "Cancelled", title: "A person withdrew it" },
};
const KIND_LABEL = { discover: "Discover", rerun: "Re-run failed tests", run: "Run test cases" } as const;

/** The Requests tab of Automated tests. */
export function RequestsPage() {
  const { pid } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: requests } = useAgentRequests();
  const [asking, setAsking] = useState(false);
  const cancel = useMutation({
    mutationFn: (id: number) => api.post<AgentRequest>(`/api/agent-requests/${id}/cancel`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["agent-requests", pid] }); toast("success", "Request cancelled"); },
    onError: (e: Error) => toast("error", e.message),
  });
  return (
    <>
      <div className="topbar">
        <h1>Automated tests</h1>
        <ViewTabs view="requests" />
        <span className="spacer" />
        <Button needs="tester" variant="primary" onClick={() => setAsking(true)} title="Ask a test agent to look at a web address and propose what to test">
          <Plus size={14} /> Request discover
        </Button>
      </div>
      <div className="content">
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12, maxWidth: 900 }}>
          <div className="muted">
            A request asks a test agent to do something. <strong>Testbench starts nothing.</strong> An agent with a request token (Settings, Agent) picks the request up, works in your own
            environment, and keeps its own stops: it asks you before it tests. What it finds comes in as proposals for you to review.
          </div>
          {requests && requests.length === 0 ? (
            <Empty icon={<Bot size={20} />} title="No requests yet" action={<Button needs="tester" variant="primary" onClick={() => setAsking(true)}><Plus size={14} /> Request discover</Button>}>
              Ask for a discover of a web address here, or ask for a failed automated run to be run again from the run itself.
            </Empty>
          ) : (
            requests?.map((r) => <RequestCard key={r.id} r={r} onCancel={() => cancel.mutate(r.id)} cancelling={cancel.isPending} />)
          )}
        </div>
      </div>
      {asking && <DiscoverModal onClose={() => setAsking(false)} />}
    </>
  );
}

function RequestCard({ r, onCancel, cancelling }: { r: AgentRequest; onCancel: () => void; cancelling: boolean }) {
  const { pid } = useParams();
  const s = STATUS[r.status];
  const open = r.status === "pending" || r.status === "claimed";
  return (
    <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6 }} data-request={r.id} data-status={r.status}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Badge tone={s.tone} title={s.title}>{s.label}</Badge>
        <span style={{ fontWeight: 500 }}>{KIND_LABEL[r.kind]}</span>
        {r.kind === "discover" ? (
          <code className="inline mono" style={{ overflowWrap: "anywhere", minWidth: 0 }}>{r.targetUrl}</code>
        ) : r.runId ? (
          <Link to={`/p/${pid}/runs/${r.runId}`} style={{ color: "var(--accent-text)" }}>Run #{r.runId}</Link>
        ) : (
          <span className="muted">the run has been deleted</span>
        )}
        {r.kind === "run" && <span className="muted">{r.caseCount} {r.caseCount === 1 ? "case" : "cases"} at <code className="inline mono" style={{ overflowWrap: "anywhere" }}>{r.targetUrl}</code></span>}
        {r.kind === "run" && progressLabel(r.progress) && <span className="chip" title={PROGRESS_TITLE}>{progressLabel(r.progress)}</span>}
        {r.environment && <span className="chip">{r.environment}</span>}
        <span className="spacer" />
        {open && <Button needs="tester" size="sm" onClick={onCancel} disabled={cancelling} aria-label={`Cancel request ${r.id}`}>Cancel</Button>}
      </div>
      <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>
        Asked by {r.createdBy || "someone"} {timeAgo(r.createdAt)}
        {r.claimedAt && ` · taken by ${r.claimedBy ?? "an agent"} ${timeAgo(r.claimedAt)}`}
        {r.finishedAt && ` · ${r.status === "cancelled" ? "cancelled" : "finished"} ${timeAgo(r.finishedAt)}`}
      </div>
      {r.note && <div style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{r.note}</div>}
      {r.kind === "rerun" && r.tests.length > 0 && (
        <details>
          <summary className="muted" style={{ cursor: "pointer" }}>{r.tests.length} {r.tests.length === 1 ? "test" : "tests"} to run again</summary>
          <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
            {r.tests.map((t) => <li key={t.id} style={{ overflowWrap: "anywhere" }}>{t.fullName}</li>)}
          </ul>
        </details>
      )}
      {r.status === "pending" && r.releasedAt && (
        <div className="faint" style={{ overflowWrap: "anywhere" }}>
          Given back by {r.releasedBy ?? "an agent"} {timeAgo(r.releasedAt)}{r.releaseNote ? <>: <span style={{ whiteSpace: "pre-wrap" }}>{r.releaseNote}</span></> : "."}
        </div>
      )}
      {(r.resultNote || r.resultRunId || r.resultDeliveredAt || r.resultAudit) && (
        <div style={{ overflowWrap: "anywhere" }}>
          {r.resultNote && <span>{r.resultNote} </span>}
          {r.resultDeliveredAt && <span>Report handed in by the agent. </span>}
          {r.resultRunId && <Link to={`/p/${pid}/runs/${r.resultRunId}`} style={{ color: "var(--accent-text)" }}>Run #{r.resultRunId}</Link>}
          {r.resultAudit && <Link to={auditPath(pid!, r.resultAudit.id)} style={{ color: "var(--accent-text)" }} title="The audit this discover made. Opens it in Bug reports, under Audits.">Audit: {r.resultAudit.title || r.resultAudit.agentAuditId}</Link>}
        </div>
      )}
    </div>
  );
}

/** The two things every request has: where it runs, and a note. The note is read by an agent as information, never as instructions. */
function Fields({ environment, setEnvironment, note, setNote }: { environment: string; setEnvironment: (v: string) => void; note: string; setNote: (v: string) => void }) {
  return (
    <>
      <div className="field">
        <label htmlFor="rq-env">Environment (optional)</label>
        <input id="rq-env" className="input" placeholder="staging, prod…" value={environment} maxLength={100} onChange={(e) => setEnvironment(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="rq-note">Note (optional)</label>
        <textarea id="rq-note" className="textarea" rows={3} maxLength={2000} placeholder="What to look at, for example a page that is new" value={note} onChange={(e) => setNote(e.target.value)} />
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>The agent reads this as information about the request, not as instructions.</span>
      </div>
    </>
  );
}

function useMakeRequest(onDone: () => void) {
  const { pid } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<AgentRequest>(`/api/projects/${pid}/agent-requests`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent-requests", pid] });
      toast("success", "Request made. An agent can now take it");
      onDone();
    },
    onError: (e: Error) => toast("error", e.message),
  });
}

function DiscoverModal({ onClose }: { onClose: () => void }) {
  const [targetUrl, setTargetUrl] = useState("");
  const [environment, setEnvironment] = useState("");
  const [note, setNote] = useState("");
  const make = useMakeRequest(onClose);
  return (
    <Modal
      title="Request discover"
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button needs="tester" variant="primary" disabled={!targetUrl.trim() || make.isPending} onClick={() => make.mutate({ kind: "discover", targetUrl, environment, note })}>Make request</Button>
        </>
      }
    >
      <EditScope>
        <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>
          Ask a test agent to look at a web address and propose what to test. Testbench starts nothing: an agent with a request token takes the request, in your own
          environment, and asks you before it tests. A production address needs the agent's own two confirmations, whatever is written here.
        </div>
        <div className="field">
          <label htmlFor="rq-url">Address to look at</label>
          <input id="rq-url" className="input" placeholder="https://staging.example.com" value={targetUrl} maxLength={500} onChange={(e) => setTargetUrl(e.target.value)} autoFocus />
          <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>No password or token in the address.</span>
        </div>
        <Fields environment={environment} setEnvironment={setEnvironment} note={note} setNote={setNote} />
      </EditScope>
    </Modal>
  );
}

/** From a run page: ask an agent to run the failed or blocked automated tests of an automated run again. */
export function RerunRequestModal({ run, onClose }: { run: RunDetail; onClose: () => void }) {
  const [environment, setEnvironment] = useState(run.environment);
  const [note, setNote] = useState("");
  const make = useMakeRequest(onClose);
  const tests = run.results.filter((r) => r.automated_test_id != null && (r.status === "failed" || r.status === "blocked"));
  return (
    <Modal
      title="Request a re-run"
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button needs="tester" variant="primary" disabled={tests.length === 0 || make.isPending} onClick={() => make.mutate({ kind: "rerun", runId: run.id, environment, note })}>Make request</Button>
        </>
      }
    >
      <EditScope>
        <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>
          Ask a test agent to run the {tests.length} failed or blocked automated {tests.length === 1 ? "test" : "tests"} of this run again. Testbench starts nothing: an agent with a request
          token takes the request and runs them in your own environment. What it delivers comes in as a new run.
        </div>
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: "var(--fs-sm)" }}>
          {tests.slice(0, 8).map((t) => <li key={t.id} style={{ overflowWrap: "anywhere" }}>{t.test_full_name ?? t.test_title}</li>)}
          {tests.length > 8 && <li className="muted">and {tests.length - 8} more</li>}
        </ul>
        <Fields environment={environment} setEnvironment={setEnvironment} note={note} setNote={setNote} />
      </EditScope>
    </Modal>
  );
}
