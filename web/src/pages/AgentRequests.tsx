import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, Copy, Plus } from "lucide-react";
import { needsText } from "../access";
import { auditPath, byQueue, deliveredSummary, PROGRESS_TITLE, progressLabel } from "../agentruns";
import { api, timeAgo, type AgentRequest, type RunDetail } from "../api";
import { addressIsLocal, DEFAULT_LOAD, LOAD_DURATIONS, LOAD_ERROR_RATES, LOAD_P95S, LOAD_RAMPS, LOAD_VUS, loadProblem, loadSummary, parsePaths, type LoadOptions } from "../loadOptions";
import { CHECKS, DEFAULT_OPTIONS, DELIVERABLES, DEPTHS, GIT_MODES, optionsProblem, optionsSummary, START_COMMAND, START_SKILL, TARGET_MODES, toggled, VIEWPORTS, withProduction, withTargetMode, type RequestOptions } from "../requestOptions";
import type { Tone } from "../statuses";
import { statusOf } from "../requestStatus";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { EditScope, useCan } from "../components/Access";
import { Empty, Modal, useToast } from "../components/ui";
import { useAgentRequests } from "../useAgentRequests";
import { ViewTabs } from "./Insights";

// What people ask a test agent to do. Testbench starts nothing: a request waits until an agent with a request token takes it, in the person's own environment, and
// the agent keeps its own stops (it asks before it tests, and a production target needs two confirmations). What it finds comes in through the import as proposals.

const KIND_LABEL = { discover: "Discover", rerun: "Re-run failed tests", run: "Run test cases", loadtest: "Load test" } as const;

/** The Requests tab of Automated tests. */
export function RequestsPage() {
  const { pid } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: requests } = useAgentRequests();
  const [asking, setAsking] = useState(false);
  const [askingLoad, setAskingLoad] = useState(false);
  const cancel = useMutation({
    mutationFn: (id: number) => api.post<AgentRequest>(`/api/agent-requests/${id}/cancel`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["agent-requests", pid] }); toast("success", "Request cancelled"); },
    onError: (e: Error) => toast("error", e.message),
  });
  // One request runs at a time in a project. With several waiting, a person says which goes first; an agent is given them in that order.
  const runNext = useMutation({
    mutationFn: (id: number) => api.post<AgentRequest>(`/api/agent-requests/${id}/run-next`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["agent-requests", pid] }); toast("success", "Put first in line"); },
    onError: (e: Error) => toast("error", e.message),
  });
  const waiting = requests?.filter((r) => r.queuePosition !== null).length ?? 0;
  return (
    <>
      <div className="topbar">
        <h1>Automated tests</h1>
        <ViewTabs view="requests" />
        <span className="spacer" />
        <Button needs="tester" variant="primary" onClick={() => setAsking(true)} title="Ask a test agent to look at a web address and propose what to test">
          <Plus size={14} /> Request discover
        </Button>
        <Button needs="admin" onClick={() => setAskingLoad(true)} title="Ask a test agent to run a small, bounded load test against a local or private address">
          <Plus size={14} /> Request load test
        </Button>
      </div>
      <div className="content">
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12, maxWidth: 900 }}>
          <div className="muted">
            A request asks a test agent to do something. <strong>Testbench starts nothing.</strong> An agent with a request token (Settings, Agent) picks the request up, works in your own
            environment, and keeps its own stops: it asks you before it tests. What it finds comes in as proposals for you to review.{" "}
            <strong>One request runs at a time:</strong> while one is taken, the others wait, and with several waiting you choose which goes first.
          </div>
          {requests && requests.length === 0 ? (
            <Empty icon={<Bot size={20} />} title="No requests yet" action={<Button needs="tester" variant="primary" onClick={() => setAsking(true)}><Plus size={14} /> Request discover</Button>}>
              Ask for a discover of a web address here, or ask for a failed automated run to be run again from the run itself.
            </Empty>
          ) : (
            requests?.slice().sort(byQueue).map((r) => <RequestCard key={r.id} r={r} onCancel={() => cancel.mutate(r.id)} cancelling={cancel.isPending} waiting={waiting} onRunNext={() => runNext.mutate(r.id)} putting={runNext.isPending} />)
          )}
        </div>
      </div>
      {asking && <DiscoverModal onClose={() => setAsking(false)} />}
      {askingLoad && <LoadTestModal onClose={() => setAskingLoad(false)} />}
    </>
  );
}

function RequestCard({ r, onCancel, cancelling, waiting, onRunNext, putting }: { r: AgentRequest; onCancel: () => void; cancelling: boolean; waiting: number; onRunNext: () => void; putting: boolean }) {
  const { pid } = useParams();
  const s = statusOf(r);
  const open = r.status === "pending" || r.status === "claimed";
  // The place in line only says something when two or more wait. A request that is next is marked; the others can be put first.
  const place = r.queuePosition !== null && waiting >= 2 ? r.queuePosition : null;
  return (
    <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6 }} data-request={r.id} data-status={r.status} data-queue={r.queuePosition ?? ""}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Badge tone={s.tone} title={s.title}>{s.label}</Badge>
        <span className="muted mono" title="The request number: the number an agent shows when you choose" data-request-number>#{r.id}</span>
        {r.name && <span style={{ fontWeight: 600, overflowWrap: "anywhere", minWidth: 0 }} data-request-name>{r.name}</span>}
        <span style={{ fontWeight: 500 }}>{KIND_LABEL[r.kind]}</span>
        {r.kind === "discover" || r.kind === "loadtest" ? (
          <code className="inline mono" style={{ overflowWrap: "anywhere", minWidth: 0 }}>{r.targetUrl}</code>
        ) : r.runId ? (
          <Link to={`/p/${pid}/runs/${r.runId}`} style={{ color: "var(--accent-text)" }}>Run #{r.runId}</Link>
        ) : (
          <span className="muted">the run has been deleted</span>
        )}
        {r.kind === "run" && <span className="muted">{r.caseCount} {r.caseCount === 1 ? "case" : "cases"} at <code className="inline mono" style={{ overflowWrap: "anywhere" }}>{r.targetUrl}</code></span>}
        {r.kind === "run" && progressLabel(r.progress) && <span className="chip" title={PROGRESS_TITLE}>{progressLabel(r.progress)}</span>}
        {r.environment && <span className="chip">{r.environment}</span>}
        {place !== null && (
          <span className="chip" title="The order an agent is given waiting requests in: the one you put first, then the oldest." data-place={place}>{place === 1 ? "Next in line" : `#${place} in line`}</span>
        )}
        <span className="spacer" />
        {place !== null && place > 1 && (
          <Button needs="tester" size="sm" onClick={onRunNext} disabled={putting} aria-label={`Run request ${r.id} next`} title="Put this request first in line, so that an agent is given it before the others">Run next</Button>
        )}
        {open && <Button needs="tester" size="sm" onClick={onCancel} disabled={cancelling} aria-label={`Cancel request ${r.id}`}>Cancel</Button>}
      </div>
      <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>
        Asked by {r.createdBy || "someone"} {timeAgo(r.createdAt)}
        {r.claimedAt && ` · taken by ${r.claimedBy ?? "an agent"} ${timeAgo(r.claimedAt)}`}
        {r.finishedAt && ` · ${r.status === "cancelled" ? "cancelled" : "finished"} ${timeAgo(r.finishedAt)}`}
      </div>
      {r.note && <div style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{r.note}</div>}
      {r.kind === "discover" && r.options && (
        <div className="faint" style={{ fontSize: "var(--fs-sm)", overflowWrap: "anywhere" }} title="What the person chose when asking. A preselection for the agent, never a permission." data-options={r.id}>
          {optionsSummary(r.options)}
        </div>
      )}
      {r.kind === "loadtest" && r.loadOptions && (
        <div className="faint" style={{ fontSize: "var(--fs-sm)", overflowWrap: "anywhere" }} title="What the person chose when asking. A preselection and a ceiling for the result, never a permission." data-load-options={r.id}>
          {loadSummary(r.loadOptions)}
        </div>
      )}
      {r.delivered && (
        <div style={{ fontSize: "var(--fs-md)", overflowWrap: "anywhere" }} title="What this discover has made that is still there. Everything is a proposal or a draft for you to review: the plan in Test plan, cases in Test cases, the rest where it always is." data-delivered={r.id}>
          <span className="muted">Delivered:</span> {deliveredSummary(r.delivered)}
        </div>
      )}
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
          {r.resultDeliveredAt && <span>{r.kind === "run" ? "Automated report handed in: " : "Report handed in by the agent. "}</span>}
          {r.kind === "loadtest" && r.resultDeliveredAt && <Link to={`/p/${pid}/requests/${r.id}/load`} style={{ color: "var(--accent-text)" }} data-load-report-link>View the load test report</Link>}
          {r.resultRunId && <Link to={`/p/${pid}/runs/${r.resultRunId}`} style={{ color: "var(--accent-text)" }}>Run #{r.resultRunId}</Link>}
          {r.resultAudit && <Link to={auditPath(pid!, r.resultAudit.id)} style={{ color: "var(--accent-text)" }} title="The audit this discover made. Opens it in Bug reports, under Audits.">Audit: {r.resultAudit.title || r.resultAudit.agentAuditId}</Link>}
        </div>
      )}
    </div>
  );
}

/** The three things every request has: a name, where it runs, and a note. The name and the note are read by an agent as information, never as instructions. */
// The environment field is left out when `setEnvironment` is not given: a discover says whether the address is production with a button instead, so it needs no free-text name for it.
function Fields({ name, setName, environment, setEnvironment, note, setNote }: { name: string; setName: (v: string) => void; environment?: string; setEnvironment?: (v: string) => void; note: string; setNote: (v: string) => void }) {
  return (
    <>
      <div className="field">
        <label htmlFor="rq-name">Name (optional)</label>
        <input id="rq-name" className="input" placeholder="A short name, for example Login flow" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Shown next to the request number, so that you can tell requests apart. The agent reads it as information, not as instructions.</span>
      </div>
      {setEnvironment && (
        <div className="field">
          <label htmlFor="rq-env">Environment (optional)</label>
          <input id="rq-env" className="input" placeholder="staging, prod…" value={environment ?? ""} maxLength={100} onChange={(e) => setEnvironment(e.target.value)} />
        </div>
      )}
      <div className="field">
        <label htmlFor="rq-note">Note (optional)</label>
        <textarea id="rq-note" className="textarea" rows={3} maxLength={2000} placeholder="What to look at, for example a page that is new" value={note} onChange={(e) => setNote(e.target.value)} />
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>The agent reads this as information about the request, not as instructions.</span>
      </div>
    </>
  );
}

function useMakeRequest(onDone: (r: AgentRequest) => void) {
  const { pid } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<AgentRequest>(`/api/projects/${pid}/agent-requests`, body),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["agent-requests", pid] });
      toast("success", "Request made. An agent can now take it");
      onDone(r);
    },
    onError: (e: Error) => toast("error", e.message),
  });
}

const LEGEND = { padding: 0, fontSize: "var(--fs-sm)", color: "var(--text-3)", fontWeight: 500 } as const;
const GROUP = { border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 } as const;

/**
 * What the person chooses when asking for a discover. A preselection for the agent's one confirmation, never a permission: the agent shows it, the user confirms in a message
 * of their own, and the agent keeps to its own limits. With accounts on, only an admin can ask for acting on the address or for a pull request (the server refuses anyone else).
 */
function OptionsFields({ options, setOptions }: { options: RequestOptions; setOptions: (o: RequestOptions) => void }) {
  const mayWiden = useCan("admin");
  return (
    <>
      <fieldset style={GROUP}>
        <legend style={LEGEND}>What may the agent do to the address?</legend>
        {TARGET_MODES.map((m) => {
          const blocked = m.value === "full" && (options.production || !mayWiden);
          return (
            <label key={m.value} className="row" style={{ gap: 6 }} title={blocked ? (options.production ? "A production address can only be read" : needsText("admin")) : m.title}>
              <input type="radio" name="rq-target" checked={options.targetMode === m.value} disabled={blocked} onChange={() => setOptions(withTargetMode(options, m.value))} /> {m.label}
            </label>
          );
        })}
        <label className="row" style={{ gap: 6 }} title="Only a hint: the agent still asks for its own two confirmations for a production address.">
          <input type="checkbox" className="checkbox" checked={options.production} onChange={(e) => setOptions(withProduction(options, e.target.checked))} /> This address is production
        </label>
      </fieldset>
      <fieldset style={GROUP}>
        <legend style={LEGEND}>How much work?</legend>
        {DEPTHS.map((d) => (
          <label key={d.value} className="row" style={{ gap: 6 }} title={d.title}>
            <input type="radio" name="rq-depth" checked={options.depth === d.value} onChange={() => setOptions({ ...options, depth: d.value })} /> {d.label}
          </label>
        ))}
      </fieldset>
      <fieldset style={GROUP}>
        <legend style={LEGEND}>What may the agent do in git?</legend>
        {GIT_MODES.map((m) => {
          const blocked = m.value === "pr" && !mayWiden;
          return (
            <label key={m.value} className="row" style={{ gap: 6 }} title={blocked ? needsText("admin") : m.title}>
              <input type="radio" name="rq-git" checked={options.gitMode === m.value} disabled={blocked} onChange={() => setOptions({ ...options, gitMode: m.value })} /> {m.label}
            </label>
          );
        })}
      </fieldset>
      <fieldset style={GROUP}>
        <legend style={LEGEND}>What should it deliver?</legend>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          {DELIVERABLES.map((d) => (
            <label key={d.value} className="row" style={{ gap: 6 }}>
              <input type="checkbox" className="checkbox" checked={options.deliverables.includes(d.value)} onChange={() => setOptions({ ...options, deliverables: toggled(DELIVERABLES, options.deliverables, d.value) })} /> {d.label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset style={GROUP}>
        <legend style={LEGEND}>Which screen sizes?</legend>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          {VIEWPORTS.map((v) => (
            <label key={v.value} className="row" style={{ gap: 6 }}>
              <input type="checkbox" className="checkbox" checked={options.viewports.includes(v.value)} onChange={() => setOptions({ ...options, viewports: toggled(VIEWPORTS, options.viewports, v.value) })} /> {v.label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset style={GROUP}>
        <legend style={LEGEND}>Which extra checks? The test plan and bug proposals always follow our rules for them.</legend>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          {CHECKS.map((c) => {
            const blocked = options.production && c.value !== "visual";
            return (
              <label key={c.value} className="row" style={{ gap: 6 }} title={blocked ? "A production address can only be read" : c.title}>
                <input type="checkbox" className="checkbox" checked={options.checks.includes(c.value)} disabled={blocked} onChange={() => setOptions({ ...options, checks: toggled(CHECKS, options.checks, c.value) })} /> {c.label}
              </label>
            );
          })}
        </div>
      </fieldset>
      <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
        These are your choices for the agent to start from, not permissions. It shows them and asks you to confirm in its own session, and it keeps to its own limits.
      </span>
    </>
  );
}

/** A line to copy: the agent is started by a person, so the way to start it is on screen. */
function Copyable({ text, label }: { text: string; label: string }) {
  const toast = useToast();
  const failed = () => toast("error", "Could not copy. Select the text and copy it");
  const copy = () => { try { void navigator.clipboard.writeText(text).then(() => toast("success", "Copied"), failed); } catch { failed(); } };
  return (
    <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 4 }}>
      <code className="inline mono" style={{ overflowWrap: "anywhere", minWidth: 0, flex: "1 1 240px" }}>{text}</code>
      <Button size="sm" onClick={copy} aria-label={label}><Copy size={12} /> Copy</Button>
    </div>
  );
}

/** After a discover was asked for: Testbench starts nothing, so what the person does next is on screen. The set-up steps are in docs/agent-quickstart.md. */
function NextSteps({ request }: { request: AgentRequest }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-next-steps={request.id}>
      <div><strong>Request #{request.id}{request.name ? ` · ${request.name}` : ""} is waiting.</strong> Testbench starts nothing, so start your agent now:</div>
      <ol style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 10 }}>
        <li>In a terminal, in your agent's folder, start Claude Code:<Copyable text={START_COMMAND} label="Copy the command that starts Claude Code" /></li>
        <li>In that session, run this. It lists what is waiting, and you choose request #{request.id}:<Copyable text={START_SKILL} label="Copy the /testpilot-requests command" /></li>
        <li>Answer what the agent asks, in messages of your own: which request, whether the address is production, and then its one confirmation. After that it works on its own until it is done or needs you. Answer a permission prompt with "allow once", or allow its tools once in advance so that it can run while you are away (docs/agent-requests.md, "Running a discover without sitting by").</li>
        <li>When it says it is done, review what it delivered. It all comes in as proposals.</li>
      </ol>
      <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>
        Your choices: {request.options ? optionsSummary(request.options) : request.loadOptions ? loadSummary(request.loadOptions) : "the defaults"}. First time? The set-up steps are in docs/agent-quickstart.md in the Testbench repository. The MCP tools are another way to take a request: docs/agent-paths.md.
      </div>
    </div>
  );
}

function DiscoverModal({ onClose }: { onClose: () => void }) {
  const [targetUrl, setTargetUrl] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [options, setOptions] = useState<RequestOptions>(DEFAULT_OPTIONS);
  const [made, setMade] = useState<AgentRequest | null>(null);
  const make = useMakeRequest(setMade);
  const problem = optionsProblem(options);
  if (made) {
    return (
      <Modal title="Request made" onClose={onClose} width={560} footer={<Button variant="primary" onClick={onClose}>Close</Button>}>
        <NextSteps request={made} />
      </Modal>
    );
  }
  return (
    <Modal
      title="Request discover"
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button needs="tester" variant="primary" disabled={!targetUrl.trim() || !!problem || make.isPending} onClick={() => make.mutate({ kind: "discover", targetUrl, name, note, options })}>Make request</Button>
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
        <Fields name={name} setName={setName} note={note} setNote={setNote} />
        <OptionsFields options={options} setOptions={setOptions} />
        {problem && <span role="alert" style={{ color: "var(--failed-fg)" }}>{problem}</span>}
      </EditScope>
    </Modal>
  );
}

/** One choice out of a few numbers, as a row of radio buttons. */
function NumberChoice<T extends number | null>({ legend, name, values, value, onChange, label }: { legend: string; name: string; values: readonly T[]; value: T; onChange: (v: T) => void; label: (v: T) => string }) {
  return (
    <fieldset style={GROUP}>
      <legend style={LEGEND}>{legend}</legend>
      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        {values.map((v) => (
          <label key={String(v)} className="row" style={{ gap: 6 }}>
            <input type="radio" name={name} checked={value === v} onChange={() => onChange(v)} /> {label(v)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * A load test of a local or private address (admin only). The choices are a preselection for the agent's one confirmation and a ceiling for the result it may hand in, never a
 * permission. Only GET requests; the agent stops when the error rate or the p95 limit is passed.
 */
function LoadTestModal({ onClose }: { onClose: () => void }) {
  const [targetUrl, setTargetUrl] = useState("");
  const [environment, setEnvironment] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [load, setLoad] = useState<LoadOptions>(DEFAULT_LOAD);
  const [pathsText, setPathsText] = useState("/");
  const [made, setMade] = useState<AgentRequest | null>(null);
  const make = useMakeRequest(setMade);
  const options: LoadOptions = { ...load, paths: parsePaths(pathsText) };
  const problem = loadProblem(options, targetUrl);
  if (made) {
    return (
      <Modal title="Request made" onClose={onClose} width={560} footer={<Button variant="primary" onClick={onClose}>Close</Button>}>
        <NextSteps request={made} />
      </Modal>
    );
  }
  return (
    <Modal
      title="Request load test"
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button needs="admin" variant="primary" disabled={!!problem || make.isPending} onClick={() => make.mutate({ kind: "loadtest", targetUrl, environment, name, note, loadOptions: options })}>Make request</Button>
        </>
      }
    >
      <EditScope>
        <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>
          Ask a test agent to run a small, bounded load test: GET requests only, against a <strong>local or private address</strong> (never production or shared systems). Testbench starts
          nothing: an agent with a request token takes the request, shows these choices and asks you before it sends any load. The result can never use more than you choose here.
        </div>
        <div className="field">
          <label htmlFor="rq-load-url">Address to test</label>
          <input id="rq-load-url" className="input" placeholder="http://localhost:3000" value={targetUrl} maxLength={500} onChange={(e) => setTargetUrl(e.target.value)} autoFocus />
          {addressIsLocal(targetUrl) === false && <span role="alert" style={{ color: "var(--failed-fg)", fontSize: "var(--fs-sm)" }}>Not a local or private address: localhost, 127.x, 10.x, 172.16-31.x, 192.168.x or a .local name.</span>}
        </div>
        <Fields name={name} setName={setName} environment={environment} setEnvironment={setEnvironment} note={note} setNote={setNote} />
        <NumberChoice legend="How many users at most?" name="rq-load-vus" values={LOAD_VUS} value={load.vus} onChange={(vus) => setLoad({ ...load, vus })} label={(v) => String(v)} />
        <NumberChoice legend="How long?" name="rq-load-dur" values={LOAD_DURATIONS} value={load.durationSeconds} onChange={(durationSeconds) => setLoad({ ...load, durationSeconds })} label={(v) => `${v} s`} />
        <NumberChoice legend="Ramp-up (time to reach all users)" name="rq-load-ramp" values={LOAD_RAMPS} value={load.rampUpSeconds} onChange={(rampUpSeconds) => setLoad({ ...load, rampUpSeconds })} label={(v) => `${v} s`} />
        <NumberChoice legend="Stop if more than this share of requests fail" name="rq-load-err" values={LOAD_ERROR_RATES} value={load.maxErrorRatePercent} onChange={(maxErrorRatePercent) => setLoad({ ...load, maxErrorRatePercent })} label={(v) => `${v} %`} />
        <NumberChoice legend="Stop if p95 passes (optional)" name="rq-load-p95" values={[null, ...LOAD_P95S] as readonly (number | null)[]} value={load.maxP95Ms} onChange={(maxP95Ms) => setLoad({ ...load, maxP95Ms })} label={(v) => (v === null ? "no limit" : `${v} ms`)} />
        <div className="field">
          <label htmlFor="rq-load-paths">Paths to request, one per line (GET only, at most 10)</label>
          <textarea id="rq-load-paths" className="textarea mono" rows={4} value={pathsText} onChange={(e) => setPathsText(e.target.value)} placeholder="/&#10;/api/health" />
        </div>
        {problem && addressIsLocal(targetUrl) !== false && <span role="alert" style={{ color: "var(--failed-fg)" }}>{problem}</span>}
      </EditScope>
    </Modal>
  );
}

/** From a run page: ask an agent to run the failed or blocked automated tests of an automated run again. */
export function RerunRequestModal({ run, onClose }: { run: RunDetail; onClose: () => void }) {
  const [environment, setEnvironment] = useState(run.environment);
  const [name, setName] = useState("");
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
          <Button needs="tester" variant="primary" disabled={tests.length === 0 || make.isPending} onClick={() => make.mutate({ kind: "rerun", runId: run.id, environment, name, note })}>Make request</Button>
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
        <Fields name={name} setName={setName} environment={environment} setEnvironment={setEnvironment} note={note} setNote={setNote} />
      </EditScope>
    </Modal>
  );
}
