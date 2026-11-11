import { useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bug, Check, ClipboardList, EyeOff, ExternalLink, FileText, FolderOpen, KeyRound, Link2, Paperclip, Pencil, Send, Settings, Trash2, Undo2, Upload, UserCheck } from "lucide-react";
import { api, formatDateTime, parseDate, timeAgo, type Priority } from "../api";
import { ConfirmModal, Empty, ListSkeleton, Modal, PRIORITY_LABEL, useToast } from "../components/ui";
import { Badge, BugWorkflowBadge, CiStatusBadge, ReviewStatusBadge, SeverityBadge } from "../components/Badge";
import { SEVERITY_LOOK } from "../statuses";
import { Button, buttonClass } from "../components/Button";
import { useCan } from "../components/Access";

type Status = "proposed" | "accepted" | "rejected" | "duplicate";
interface Item {
  id: number; sourceId: string; title: string; status: Status; reviewedBy: string | null; reviewedAt: string | null; severity: Priority | null; severitySource: SeveritySource | null; severityBy: string | null; foundAt: string | null; importedAt: string;
  auditTitle: string; auditDeleted: boolean; unresolvedRefs: number; attachments: number; attachmentProblems: number; pendingUpdate: boolean; published: boolean; presence: Presence;
  source: Source; testKey: string | null; tags: string[]; workflowStatus: Workflow; assignee: string;
  ci: { lastStatus: CiStatus | null; lastAt: string | null; flaky: boolean; failedRuns: number; branch: string; commit: string; pipelineUrl: string } | null;
  /** Where the bug is new: it came with the project's latest CI run or latest audit import. */
  newIn: "ci" | "audit" | null;
}
interface LatestRuns {
  ci: { runId: string; receivedAt: string; branch: string; commit: string; pipelineUrl: string; counts: { passed: number; failed: number; flaky: number; skipped: number }; newCount: number } | null;
  audit: { auditTitle: string; importedAt: string; newCount: number } | null;
  manual: { id: number; title: string; at: string } | null;
}
type NewFilter = "" | "ci" | "audit" | "any";
type Source = "ci" | "agent_audit" | "manual";
type Workflow = "open" | "resolved_suspected" | "closed";
type CiStatus = "passed" | "failed" | "flaky";
interface CiHistoryItem {
  id: number; status: CiStatus; error: string; durationMs: number | null; steps: string[]; attachments: { name: string; url: string; type: string }[];
  runId: string; commit: string; branch: string; repository: string; pipelineUrl: string; at: string;
}
interface CiDetail {
  testKey: string; lastStatus: CiStatus | null; lastAt: string | null; flaky: boolean; failedRuns: number; flakyRuns: number;
  branches: { branch: string; status: CiStatus; commit: string; pipelineUrl: string; at: string }[]; lastFailure: CiHistoryItem | null; history: CiHistoryItem[];
}
const SOURCE_LABEL: Record<Source, string> = { ci: "CI", agent_audit: "Agent audit", manual: "Manual" };
const WORKFLOW_LABEL: Record<Workflow, string> = { open: "Open", resolved_suspected: "May be resolved", closed: "Closed" };
const CI_STATUS_LABEL: Record<CiStatus, string> = { passed: "Passed", failed: "Failed", flaky: "Flaky" };
const shortSha = (s: string) => s.slice(0, 7);
const safeLink = (u: string) => /^https?:\/\//i.test(u);
/** Where a report stands against the latest run of its audit. */
type Presence = "present" | "missing" | "no_later_run";
interface RunRef { run: number; importId: number; importedAt: string; source: string; recorded: boolean; github: { repo: string; runId: number; url: string } | null }
interface LatestRun { presence: Presence; reason: string; runs: number; latest: RunRef | null; lastSeen: RunRef | null }
interface List { items: Item[]; counts: Record<string, number>; presenceCounts: Record<Presence, number>; latestRuns: LatestRuns }
interface Ref { id: number; kind: string; raw: string; state: string; reason: string; label: string; target: { kind: string; id: number } | null }
interface Attachment { id: number; declared_path: string; filename: string; mime: string; size: number; label: string; stored_name: string | null; state: string; reason: string; active: number }
interface Detail {
  id: number; projectId: number; sourceId: string; status: Status; reviewedAt: string | null; reviewedBy: string | null; reviewNote: string; editedAt: string | null;
  title: string; description: string; steps: string[]; expected: string; actual: string; environment: string; url: string;
  severity: { tool: { tool: string; value: string; ruleId?: string } | null; agent: Priority | null; human: Priority | null; effective: Priority | null; source: SeveritySource | null; decidedBy: string | null; decidedAt: string | null; reason: string };
  confidence: number | null; agentReview: { status: string; method: string; notes: string } | null; foundAt: string | null; importedAt: string; fingerprint: string;
  origin: { repository?: string; title?: string; agent?: { name?: string; version?: string; model?: string }; review?: { status: string; method: string; reviewer: string } | null; source?: string; github?: { repo: string; runId: number } | null };
  originAuditId: string; audit: { id: number; title: string; run_state: string; has_report: number } | null; runId: number | null;
  refs: Ref[]; attachments: Attachment[]; revisions: { rev: number; imported_at: string }[]; latestRun: LatestRun;
  pendingUpdate: { rev: number; changes: { field: string; from: string; to: string }[]; evidenceAdded: number; evidenceRemoved: number } | null;
  duplicateOf: { id: number; title: string } | null; duplicates: { id: number; title: string }[]; similar: { id: number; title: string; status: string }[];
  publications: Publication[];
  source: Source; testKey: string | null; tags: string[]; workflowStatus: Workflow; assignee: string; resolvedSuspectedAt: string | null; closedAt: string | null;
  ci: CiDetail | null; events: { at: string; actor: string; kind: string; detail: string }[];
}
interface Publication {
  id: number; destination: string; destination_ref: string; mode: string; state: string; external_id: string; external_url: string;
  error: string; attachments_state: string; content_sent: string; created_at: string; completed_at: string | null;
}
interface Team { id: string; key: string; name: string }
interface Destination { kind: string; baseUrl: string; team: Team; tokenSource: "stored" | "environment" | "unreadable" | "none"; tokenHint: string; ready: boolean }
interface Preview {
  bugId: number; destination: { label: string; baseUrl: string; team: Team } | null; title: string; description: string;
  priority: { severity: string | null; value: number; label: string; mapping: string };
  refs: { id: number; kind: string; label: string; state: string; included: boolean; sendable: boolean }[];
  attachments: { id: number; filename: string; mime: string; size: number; included: boolean; sendable: boolean; reason: string }[];
  warnings: string[]; blockers: string[]; canPublish: boolean; hash: string;
}
const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
interface Audit {
  id: number; agentAuditId: string; title: string; agent: string; startedAt: string | null; source: string; github: { repo: string; runId: number } | null;
  runState: string; hasReport: boolean; bugs: number; proposed: number; imports: number; lastImportedAt: string; planItems: number; coverageGaps: number;
}
interface PlanSummary { counts: { new: number; unchanged: number; updated: number; removed: number; pending: number }; waiting: string[] }
interface Summary {
  dryRun: boolean; audit: { agentAuditId: string; title: string; agent: string; isNew: boolean; github: { repo: string; runId: number } | null; runState: string };
  counts: { new: number; unchanged: number; updated: number; pending: number }; evidence: { ok: number; problems: number }; unresolvedRefs: number; warnings: string[];
  items: { sourceId: string; title: string; action: string; severity: string | null; unresolvedRefs: number; evidenceProblems: number }[];
  manualTests: {
    listed: boolean; counts: { new: number; unchanged: number; updated: number; pending: number }; unresolvedRefs: number;
    items: { sourceId: string; title: string; action: string; category: string; priority: string; unresolvedRefs: number }[];
  };
  testPlan?: { listed: boolean; planItems: PlanSummary; coverageGaps: PlanSummary };
}

type SeveritySource = "human" | "ai" | "ci_default";
/** What a bug's severity is called. The stored value for Major stays "high" (the agent package, CI, Linear and the requirements use it). */
const SEV_WORD: Record<"low" | "medium" | "high" | "critical", string> = { low: "Low", medium: "Medium", high: "Major", critical: "Critical" };
const SEV_ORDER = ["critical", "high", "medium", "low"] as const;
const SUGGESTION_WORD: Record<"ai" | "ci_default", string> = { ai: "AI suggestion", ci_default: "Default from CI" };

/**
 * A bug's severity, and whose it is. A person's decision is a plain badge. A suggestion has a dashed edge and says what it is in words (AI suggestion, or a default
 * from CI: a rule, not AI): the colour of a suggestion is never the only thing that tells it apart from a decision.
 */
export function BugSeverity({ value, source, by }: { value: Priority | null; source: SeveritySource | null; by?: string | null }) {
  if (!value) return <span className="faint" title="No severity yet">—</span>;
  const look = SEVERITY_LOOK[value];
  const word = SEV_WORD[value as keyof typeof SEV_WORD] ?? look.label;
  if (source === "human" || !source) return <Badge tone={look.tone} icon={look.icon} title={by ? `Severity set by ${by}` : "Severity set by a person"}>{word}</Badge>;
  return (
    <span className="sev-suggested">
      <Badge tone={look.tone} icon={look.icon} title={source === "ci_default" ? "A default from CI, by rule. It is not AI and nobody has decided it." : "Suggested by an AI. Nobody has decided it."}>
        {word} · {SUGGESTION_WORD[source]}
      </Badge>
    </span>
  );
}

type Tab = Status | "all" | "audits";
const TAB_LABEL: Record<Tab, string> = { proposed: "Suggested", accepted: "Confirmed", rejected: "Dismissed", duplicate: "Duplicates", all: "All", audits: "Audits" };
/** What each decision is called here. The server keeps proposed, accepted, rejected and duplicate. */
const DECISION_WORD: Record<Status, string> = { proposed: "Suggested", accepted: "Confirmed", rejected: "Dismissed", duplicate: "Duplicate" };
const DECIDED_BY: Record<Status, string> = { proposed: "Restored by", accepted: "Confirmed by", rejected: "Dismissed by", duplicate: "Marked as a duplicate by" };

/**
 * Who made a bug suggestion. A test agent's report and an observation that a person turned into a bug are AI suggestions; a failing CI test is not
 * (it is a fact from a test run), so it says where it came from and is not marked as AI.
 */
function Origin({ source }: { source: Source }) {
  if (source === "ci") return <span className="chip" title="Reported by CI from a failing test. Nothing becomes a bug until you confirm it.">From CI</span>;
  return (
    <Badge tone="accent" title={source === "manual" ? "A test agent's observation that a person turned into a suggestion. Nothing becomes a bug until you confirm it." : "Suggested by a test agent. Nothing becomes a bug until you confirm it."}>
      {source === "manual" ? "AI suggestion · from an observation" : "AI suggestion"}
    </Badge>
  );
}
const RUN_STATE: Record<string, string> = { linked: "Linked to the run", pending: "Waiting for the run to be imported", none: "No GitHub run named", deleted: "The run was deleted" };
const DANGER = { color: "var(--failed-fg)" };

/** The decision on a report, as a badge with an icon and a word. Also used for the proposed manual tests. */
export function StatusChip({ status }: { status: Status }) {
  return <ReviewStatusBadge value={status} />;
}

export function Severity({ value }: { value: Priority | null }) {
  if (!value) return <span className="faint">—</span>;
  return <SeverityBadge value={value} />;
}

export function BugReportsPage() {
  const { pid } = useParams();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>("proposed");
  const [importing, setImporting] = useState(false);
  const [destinationOpen, setDestinationOpen] = useState(false);
  const [presence, setPresence] = useState<"" | Presence>("");
  const NO_FILTER = { source: "", workflow: "", severity: "", tag: "", testKey: "", new: "" as NewFilter };
  const [filter, setFilter] = useState(NO_FILTER);
  const [tokensOpen, setTokensOpen] = useState(false);
  const toast = useToast();
  const refresh = useRefresh(pid!);
  const [deciding, setDeciding] = useState(false);
  /** Confirm, dismiss or restore one suggestion from the list. The person is saved by the server. */
  const decide = (b: Item, status: "accepted" | "rejected" | "proposed") => {
    setDeciding(true);
    api.post(`/api/bug-reports/${b.id}/review`, { status })
      .then(() => { refresh(); toast("success", status === "accepted" ? `Confirmed as bug #${b.id}. Not published anywhere.` : status === "rejected" ? "Dismissed. It is under Dismissed if you want it back." : "Back in Suggested"); })
      .catch((e: Error) => toast("error", e.message))
      .finally(() => setDeciding(false));
  };
  const { data: dest } = useQuery({ queryKey: ["destination", pid], queryFn: () => api.get<{ destination: Destination | null; serverKey: boolean }>(`/api/projects/${pid}/destination`) });
  const open = Number(params.get("bug")) || null;
  const statusParam = tab === "audits" ? "proposed" : tab;
  const query = new URLSearchParams({ status: statusParam });
  if (presence) query.set("presence", presence);
  for (const [k, v] of Object.entries(filter)) if (v.trim()) query.set(k, v.trim());
  const filtered = Object.values(filter).some((v) => v.trim());
  const { data, isLoading } = useQuery({ queryKey: ["bug-reports", pid, statusParam, presence, filter], queryFn: () => api.get<List>(`/api/projects/${pid}/bug-reports?${query}`), placeholderData: keepPreviousData });
  const counts = data?.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const setOpen = (id: number | null) => setParams((p) => { if (id) p.set("bug", String(id)); else p.delete("bug"); return p; }, { replace: true });
  // "N new" in the Latest runs strip: all statuses (an accepted bug is still new), no other filter, so that the list is exactly those N bugs.
  const showNew = (kind: "ci" | "audit") => { setTab("all"); setPresence(""); setFilter({ ...NO_FILTER, new: kind }); };

  return (
    <>
      <div className="topbar">
        <h1>Bug reports</h1>
        <span className="spacer" />
        <Button needs="admin" onClick={() => setDestinationOpen(true)} title="Where confirmed bugs are published">
          <Settings size={14} /> {dest?.destination ? `Linear · ${dest.destination.team.key}` : "Set up publishing"}
        </Button>
        <Button needs="admin" onClick={() => setTokensOpen(true)} title="API tokens that let your CI send test results here"><KeyRound size={14} /> CI</Button>
        <Button needs="tester" variant="primary" onClick={() => setImporting(true)}><Upload size={14} /> Import audit package</Button>
      </div>
      {tab !== "audits" && data && <LatestRunsStrip r={data.latestRuns} onShowNew={showNew} />}
      <div className="toolbar">
        <div className="tabs" role="tablist">
          {(["proposed", "accepted", "rejected", "duplicate", "all", "audits"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
              {TAB_LABEL[t]}
              {t !== "audits" && <span className="count">{t === "all" ? total : (counts[t] ?? 0)}</span>}
            </button>
          ))}
        </div>
        {tab !== "audits" && (
          <>
            <span className="spacer" />
            <select className="select" style={{ width: "auto" }} aria-label="Latest audit run" value={presence} onChange={(e) => setPresence(e.target.value as "" | Presence)} title="Compare with the latest run of the audit each report came from">
              <option value="">Latest run: any</option>
              <option value="present">Still present in latest run{data ? ` (${data.presenceCounts.present})` : ""}</option>
              <option value="missing">Not present in latest run{data ? ` (${data.presenceCounts.missing})` : ""}</option>
              <option value="no_later_run">No later run available{data ? ` (${data.presenceCounts.no_later_run})` : ""}</option>
            </select>
          </>
        )}
      </div>
      {tab !== "audits" && (
        <div className="toolbar" style={{ gap: 8 }}>
          <select className="select" style={{ width: "auto" }} aria-label="Source" value={filter.source} onChange={(e) => setFilter({ ...filter, source: e.target.value })}>
            <option value="">Source: any</option>
            {(Object.keys(SOURCE_LABEL) as Source[]).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
          </select>
          <select className="select" style={{ width: "auto" }} aria-label="Workflow status" value={filter.workflow} onChange={(e) => setFilter({ ...filter, workflow: e.target.value })}>
            <option value="">Workflow: any</option>
            {(Object.keys(WORKFLOW_LABEL) as Workflow[]).map((s) => <option key={s} value={s}>{WORKFLOW_LABEL[s]}</option>)}
          </select>
          <select className="select" style={{ width: "auto" }} aria-label="Severity" value={filter.severity} onChange={(e) => setFilter({ ...filter, severity: e.target.value })}>
            <option value="">Severity: any</option>
            {SEV_ORDER.map((s) => <option key={s} value={s}>{SEV_WORD[s]}</option>)}
            <option value="none">Not set</option>
          </select>
          <input className="input" style={{ width: 130 }} aria-label="Tag" placeholder="Tag" value={filter.tag} onChange={(e) => setFilter({ ...filter, tag: e.target.value })} />
          <input className="input" style={{ width: 220 }} aria-label="Test key" placeholder="Test key (exact)" value={filter.testKey} onChange={(e) => setFilter({ ...filter, testKey: e.target.value })} />
          <select className="select" style={{ width: "auto" }} aria-label="New" value={filter.new} onChange={(e) => setFilter({ ...filter, new: e.target.value as NewFilter })} title="Bugs that came with the latest CI run or the latest audit import">
            <option value="">New: any</option>
            <option value="ci">New in latest CI run</option>
            <option value="audit">New in latest audit</option>
            <option value="any">New in latest run or import</option>
          </select>
          {filtered && <Button variant="ghost" size="sm" onClick={() => setFilter(NO_FILTER)}>Clear filters</Button>}
        </div>
      )}
      <div className="content">
        {tab === "audits" ? (
          <AuditsPanel pid={pid!} />
        ) : isLoading ? (
          <ListSkeleton />
        ) : !data?.items.length ? (
          <Empty
            icon={<Bug size={20} />}
            title={presence || filtered ? "No reports match these filters" : tab === "proposed" ? "Nothing waiting for review" : "No bug reports here"}
            action={<Button needs="tester" onClick={() => setImporting(true)}><Upload size={14} /> Import audit package</Button>}
          >
            AI suggestions arrive here. Nothing becomes a bug until you confirm it.
          </Empty>
        ) : (
          data.items.map((b) => (
            <div key={b.id} className="list-row suggestion-row">
              <button className="row-main" onClick={() => setOpen(b.id)}>
              <span className="id mono truncate" style={{ width: 96 }} title={b.testKey ?? b.sourceId}>{b.status === "accepted" ? `bug #${b.id}` : b.source === "ci" ? `#${b.id}` : b.sourceId}</span>
              <span className="title">{b.title}</span>
              <span className="meta">
                {b.newIn && <Badge tone="accent" title={newWhy(b.newIn, data?.latestRuns)}>New</Badge>}
                <Origin source={b.source} />
                {b.ci?.lastStatus && (
                  <CiStatusBadge value={b.ci.lastStatus} title="The latest CI result of this test"
                    label={`${CI_STATUS_LABEL[b.ci.lastStatus]}${b.ci.failedRuns > 0 ? ` · ${b.ci.failedRuns} failed run${b.ci.failedRuns === 1 ? "" : "s"}` : ""}`} />
                )}
                {b.ci?.flaky && b.ci.lastStatus !== "flaky" && <Badge tone="warn" icon="triangle-alert" title="The test passed on retry, so it is unstable. It starts at low severity.">Flaky</Badge>}
                {b.ci?.branch && <span className="chip mono" title={`Latest failure: ${b.ci.branch} at ${b.ci.commit}`}>{b.ci.branch}{b.ci.commit && ` · ${shortSha(b.ci.commit)}`}</span>}
                {b.workflowStatus !== "open" && (
                  <BugWorkflowBadge value={b.workflowStatus} title={b.workflowStatus === "resolved_suspected" ? "The test is green again. Check it and close the bug if it is fixed." : "Closed"} />
                )}
                {b.assignee && <span className="chip" title="Assigned to">{b.assignee}</span>}
                {b.pendingUpdate && <Badge tone="accent" title="The agent sent a newer version. Review it.">Update waiting</Badge>}
                {b.unresolvedRefs > 0 && <span className="chip" title="References that match no requirement or test case in this project"><AlertTriangle size={11} /> {b.unresolvedRefs} unresolved</span>}
                {(b.attachments > 0 || b.attachmentProblems > 0) && (
                  <span className="chip" title={b.attachmentProblems ? `${b.attachmentProblems} attachment(s) not imported` : "Evidence files"}>
                    <Paperclip size={11} /> {b.attachments}{b.attachmentProblems > 0 && <span style={DANGER}> +{b.attachmentProblems} problem</span>}
                  </span>
                )}
                {b.presence === "missing" && <Badge tone="warn" icon="eye-off" title="This report was not in the latest run of its audit. It is kept as it is.">Not in latest run</Badge>}
                {b.published && <span className="chip"><Link2 size={11} /> linked</span>}
                <BugSeverity value={b.severity} source={b.severitySource} by={b.severityBy} />
                {tab === "all" && <span className="chip">{DECISION_WORD[b.status]}</span>}
                {b.status !== "proposed" && b.reviewedBy && <span className="faint" title={b.reviewedAt ? formatDateTime(b.reviewedAt) : undefined}>{DECIDED_BY[b.status]} {b.reviewedBy}</span>}
                <span className="faint" title={b.auditTitle}>{timeAgo(b.importedAt)}</span>
              </span>
              </button>
              <span className="row-actions">
                {b.status === "proposed" && <Button needs="tester" variant="primary" size="sm" disabled={deciding} onClick={() => decide(b, "accepted")}><Check size={13} /> Confirm bug</Button>}
                {b.status === "proposed" && <Button needs="tester" size="sm" disabled={deciding} title="Not a bug, or not now. It goes to Dismissed, and you can restore it." onClick={() => decide(b, "rejected")}>Dismiss</Button>}
                {b.status === "rejected" && <Button needs="tester" size="sm" disabled={deciding} onClick={() => decide(b, "proposed")}><Undo2 size={13} /> Restore to Suggested</Button>}
              </span>
            </div>
          ))
        )}
      </div>
      {open && <DetailModal id={open} pid={pid!} onClose={() => setOpen(null)} onOpen={setOpen} />}
      {importing && <ImportModal pid={pid!} onClose={() => setImporting(false)} />}
      {destinationOpen && <DestinationModal pid={pid!} onClose={() => setDestinationOpen(false)} />}
      {tokensOpen && <CiTokensModal pid={pid!} onClose={() => setTokensOpen(false)} />}
    </>
  );
}

export function useRefresh(pid: string) {
  const qc = useQueryClient();
  return () => {
    for (const k of [["bug-reports"], ["bug-report"], ["manual-tests"], ["manual-test"], ["requirements", pid], ["requirement"], ["requirement-coverage", pid], ["audits", pid], ["audit-rejections", pid]]) qc.invalidateQueries({ queryKey: k });
  };
}

// ---------- One report ----------

function DetailModal({ id, pid, onClose, onOpen }: { id: number; pid: string; onClose: () => void; onOpen: (id: number) => void }) {
  const canEdit = useCan("tester");
  const toast = useToast();
  const refresh = useRefresh(pid);
  const { data: b } = useQuery({ queryKey: ["bug-report", id], queryFn: () => api.get<Detail>(`/api/bug-reports/${id}`) });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: "", description: "", steps: "", expected: "", actual: "", environment: "", url: "" });
  const [note, setNote] = useState("");
  const [link, setLink] = useState({ destination: "jira", url: "" });
  const [deleting, setDeleting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [justConfirmed, setJustConfirmed] = useState(false);
  const [sevDraft, setSevDraft] = useState<string | null>(null); // null: show what the server has
  const [sevReason, setSevReason] = useState("");
  const run = <T,>(fn: () => Promise<T>, ok?: string) => fn().then((r) => { refresh(); if (ok) toast("success", ok); return r; }).catch((e: Error) => { toast("error", e.message); });
  const post = (path: string, body?: unknown, ok?: string) => run(() => api.post(`/api/bug-reports/${id}/${path}`, body), ok);

  if (!b) return <Modal title="Bug report" onClose={onClose} width={820}><ListSkeleton rows={4} /></Modal>;
  const startEdit = () => {
    setDraft({ title: b.title, description: b.description, steps: b.steps.join("\n"), expected: b.expected, actual: b.actual, environment: b.environment, url: b.url });
    setEditing(true);
  };
  const save = () =>
    run(() => api.patch(`/api/bug-reports/${id}`, { ...draft, steps: draft.steps.split("\n").map((s) => s.trim()).filter(Boolean) }), "Saved").then(() => setEditing(false));
  /** Confirm the bug. Edits that are not saved yet are saved with it, so that what is confirmed is what is on screen. */
  const confirm = async () => {
    try {
      if (editing) {
        if (!draft.title.trim()) { toast("error", "The title cannot be empty"); return; }
        await api.patch(`/api/bug-reports/${id}`, { ...draft, steps: draft.steps.split("\n").map((s) => s.trim()).filter(Boolean) });
        setEditing(false);
      }
      // What the severity section shows is saved as the person's decision with the confirmation (both or neither). Nothing shown: nothing saved.
      const shown = sevDraft ?? b.severity.human ?? b.severity.agent ?? "";
      await api.post(`/api/bug-reports/${id}/review`, { status: "accepted", note: note || undefined, ...(shown ? { severity: shown, severityReason: sevReason.trim() || undefined } : {}) });
      setSevDraft(null); setSevReason("");
      refresh(); setJustConfirmed(true); toast("success", `Confirmed as bug #${id}. Not published anywhere.`);
    } catch (e) { toast("error", (e as Error).message); }
  };
  const problems = b.attachments.filter((a) => a.state !== "stored");
  const stored = b.attachments.filter((a) => a.state === "stored" && a.active);
  const unresolved = b.refs.filter((r) => r.state !== "resolved");
  const field = (label: string, value: string) => value ? <div className="field"><div className="section-label">{label}</div><div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{value}</div></div> : null;
  const guarded = b.status === "accepted" || b.publications.length > 0;

  return (
    <Modal
      title={<span className="row" style={{ gap: 8 }}><Origin source={b.source} />{b.source !== "ci" && <span className="mono faint">{b.sourceId}</span>}<span className="chip">{b.status === "accepted" ? `Confirmed · bug #${b.id}` : DECISION_WORD[b.status]}</span></span>}
      onClose={onClose}
      width={820}
      footer={
        <>
          <Button needs="tester" variant="ghost" style={DANGER} onClick={() => setDeleting(true)}><Trash2 size={13} /> Delete</Button>
          <span className="spacer" />
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        {b.pendingUpdate && (
          <div className="card" style={{ padding: 12, borderColor: "var(--accent)" }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <strong>The agent sent a newer version (revision {b.pendingUpdate.rev})</strong>
              <span className="spacer" />
              <Button needs="tester" size="sm" onClick={() => post("ignore-update", undefined, "Kept your version")}>Keep mine</Button>
              <Button needs="tester" variant="primary" size="sm" onClick={() => post("apply-update", undefined, "Applied the agent's version")}>Use the agent's version</Button>
            </div>
            <div className="faint" style={{ fontSize: "var(--fs-sm)", margin: "6px 0" }}>Your edits, review and links are not changed until you choose. Applying replaces the text below with the agent's.</div>
            {b.pendingUpdate.changes.map((c) => (
              <div key={c.field} style={{ fontSize: "var(--fs-md)", marginTop: 6 }}>
                <span className="section-label" style={{ margin: 0 }}>{c.field}</span>
                <div style={{ color: "var(--failed-fg)", whiteSpace: "pre-wrap" }}>− {c.from || "(empty)"}</div>
                <div style={{ color: "var(--passed-fg)", whiteSpace: "pre-wrap" }}>+ {c.to || "(empty)"}</div>
              </div>
            ))}
            {(b.pendingUpdate.evidenceAdded > 0 || b.pendingUpdate.evidenceRemoved > 0) && (
              <div className="faint" style={{ marginTop: 6 }}>Evidence: {b.pendingUpdate.evidenceAdded} added, {b.pendingUpdate.evidenceRemoved} removed.</div>
            )}
          </div>
        )}

        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {b.status !== "accepted" && <Button needs="tester" variant="primary" onClick={confirm}><Check size={14} /> Confirm bug</Button>}
          {b.status !== "rejected" && <Button needs="tester" title="Not a bug, or not now. It goes to Dismissed, and you can restore it." onClick={() => { setJustConfirmed(false); post("review", { status: "rejected", note: note || undefined }, "Dismissed. It is under Dismissed if you want it back."); }}>Dismiss</Button>}
          {(b.status === "rejected" || b.status === "duplicate") && <Button needs="tester" variant="ghost" onClick={() => post("review", { status: "proposed" }, "Back in Suggested")}><Undo2 size={13} /> {b.status === "rejected" ? "Restore to Suggested" : "Not a duplicate: move back to Suggested"}</Button>}
          <input className="input grow" aria-label="Review note" placeholder="Reason (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          {b.status === "accepted" && !b.publications.some((p) => p.destination === "linear" && (p.mode === "linked_existing" || p.state === "sent")) && (
            <Button needs="tester" onClick={() => setPublishing(true)}><Send size={14} /> Publish to Linear…</Button>
          )}
        </div>
        {justConfirmed && b.status === "accepted" && (
          <div className="card" role="status" style={{ padding: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", borderColor: "var(--passed)" }}>
            <Check size={15} aria-hidden="true" />
            <span>Confirmed as <Link to={`/p/${pid}/bugs?bug=${b.id}`}><strong>bug #{b.id}</strong></Link>. Not published anywhere.</span>
          </div>
        )}
        {b.status === "proposed" && (
          <div className="card" style={{ padding: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <UserCheck size={15} aria-hidden="true" />
            <span style={{ fontSize: "var(--fs-md)" }} className="grow">
              {editing
                ? "Change what you like below, then confirm. Your unsaved changes are saved with it."
                : b.source === "ci"
                  ? "Reported by CI from a failing test. Check it, change it if you like, then confirm it as a bug."
                  : "A suggestion. Read it, change it if you like, then confirm it as a bug. Nothing becomes a bug until you do."}
            </span>
          </div>
        )}
        {b.status !== "proposed" && b.reviewedBy && <div className="faint" title={b.reviewedAt ? formatDateTime(b.reviewedAt) : undefined}>{DECIDED_BY[b.status]} {b.reviewedBy}</div>}
        {b.source === "agent_audit" && <RunStanding r={b.latestRun} />}
        {b.reviewNote && <div className="faint">Note: {b.reviewNote}{b.reviewedAt ? ` · ${timeAgo(b.reviewedAt)}` : ""}</div>}
        {b.duplicateOf && <div>Duplicate of <Button variant="ghost" size="sm" onClick={() => onOpen(b.duplicateOf!.id)}>{b.duplicateOf.title}</Button></div>}
        <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>Confirming is only your decision in Testbench. Publishing to Linear is a separate step: you get a preview of exactly what is sent and approve it first.</div>

        <div className="field">
          <div className="section-label">Triage</div>
          <TriageCard b={b} onChange={(body) => post("triage", body)} />
        </div>
        {b.ci && <CiSection ci={b.ci} workflow={b.workflowStatus} />}

        {/* The tool's impact, and the severity: what is suggested and what a person decided are kept apart */}
        <div className="card" style={{ padding: 12, display: "grid", gap: 12 }}>
          <div className="row" style={{ gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
            <div><div className="section-label">Tool impact</div>{b.severity.tool ? <div>{b.severity.tool.value} <span className="faint">({b.severity.tool.tool}{b.severity.tool.ruleId ? `, ${b.severity.tool.ruleId}` : ""})</span></div> : <span className="faint">—</span>}</div>
            <div>
              <div className="section-label">{b.source === "ci" ? "Default from CI" : "AI suggestion"}</div>
              {b.severity.agent ? <BugSeverity value={b.severity.agent} source={b.source === "ci" ? "ci_default" : "ai"} /> : <span className="faint">None</span>}
            </div>
            <div>
              <div className="section-label">Severity set by a person</div>
              {b.severity.human ? <BugSeverity value={b.severity.human} source="human" by={b.severity.decidedBy} /> : <span className="faint">Not decided</span>}
            </div>
          </div>
          {(() => {
            const shown = sevDraft ?? b.severity.human ?? b.severity.agent ?? "";
            const changed = shown !== (b.severity.human ?? "");
            return (
              <div className="col" style={{ gap: 8 }}>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <label className="section-label" htmlFor="human-sev" style={{ margin: 0 }}>Severity</label>
                  <select id="human-sev" className="select" style={{ width: "auto" }} disabled={!canEdit} value={shown} onChange={(e) => setSevDraft(e.target.value)}>
                    <option value="">Not set</option>
                    {SEV_ORDER.map((v) => <option key={v} value={v}>{SEV_WORD[v]}</option>)}
                  </select>
                  <input className="input grow" aria-label="Reason for the severity" placeholder="Reason (optional)" maxLength={200} disabled={!canEdit} value={sevReason} onChange={(e) => setSevReason(e.target.value)} />
                  <Button needs="tester" disabled={!changed} onClick={() => run(() => api.patch(`/api/bug-reports/${id}`, { humanSeverity: shown || null, severityReason: sevReason.trim() || undefined }), shown ? "Severity saved" : "Severity decision removed").then(() => { setSevDraft(null); setSevReason(""); })}>
                    {shown ? (b.severity.human ? "Change severity" : "Set severity") : "Remove decision"}
                  </Button>
                </div>
                <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>
                  {b.severity.human
                    ? <span title={b.severity.decidedAt ? formatDateTime(b.severity.decidedAt) : undefined}>Severity set by {b.severity.decidedBy || "a person"}{b.severity.reason ? `: ${b.severity.reason}` : ""}. You can change it at any time; each change is logged.</span>
                    : b.severity.agent
                      ? `${b.source === "ci" ? "A default from CI, by rule" : "Suggested by an AI"}. It becomes your decision when you set it here${b.status === "proposed" ? " or confirm the bug" : ""}.`
                      : "Nobody has set a severity."}
                  {b.status === "proposed" && canEdit && shown && !b.severity.human ? ` Confirm bug saves ${SEV_WORD[shown as keyof typeof SEV_WORD]} as your decision.` : ""}
                </div>
              </div>
            );
          })()}
        </div>

        {editing ? (
          <div className="col" style={{ gap: 8 }}>
            <input className="input" aria-label="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            <textarea className="textarea" aria-label="Description" rows={4} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Description" />
            <textarea className="textarea" aria-label="Steps, one per line" rows={4} value={draft.steps} onChange={(e) => setDraft({ ...draft, steps: e.target.value })} placeholder="Steps, one per line" />
            <textarea className="textarea" aria-label="Expected result" rows={2} value={draft.expected} onChange={(e) => setDraft({ ...draft, expected: e.target.value })} placeholder="Expected result" />
            <textarea className="textarea" aria-label="Actual result" rows={2} value={draft.actual} onChange={(e) => setDraft({ ...draft, actual: e.target.value })} placeholder="Actual result" />
            <div className="row"><input className="input grow" aria-label="Environment" value={draft.environment} onChange={(e) => setDraft({ ...draft, environment: e.target.value })} placeholder="Environment" /><input className="input grow" aria-label="URL" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="URL" /></div>
            <div className="row"><Button needs="tester" variant="primary" disabled={!draft.title.trim()} onClick={save}>Save</Button><Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button></div>
          </div>
        ) : (
          <div className="col" style={{ gap: 10 }}>
            <div className="row"><h2 style={{ margin: 0, fontSize: "var(--fs-lg)", overflowWrap: "anywhere" }}>{b.title}</h2><span className="spacer" /><Button needs="tester" size="sm" onClick={startEdit}><Pencil size={12} /> Edit</Button></div>
            {b.editedAt && <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>You edited this {timeAgo(b.editedAt)}. A later import will not overwrite it without asking.</div>}
            {field("Description", b.description)}
            {b.steps.length > 0 && <div className="field"><div className="section-label">Steps</div><ol style={{ margin: 0, paddingLeft: 20 }}>{b.steps.map((s, i) => <li key={i} style={{ overflowWrap: "anywhere" }}>{s}</li>)}</ol></div>}
            {field("Expected result", b.expected)}
            {field("Actual result", b.actual)}
            {field("Environment", b.environment)}
            {b.url && <div className="field"><div className="section-label">URL</div><span className="mono" style={{ overflowWrap: "anywhere" }}>{/^https?:\/\//i.test(b.url) ? <a href={b.url} target="_blank" rel="noreferrer noopener">{b.url}</a> : b.url}</span></div>}
          </div>
        )}

        <div className="field">
          <div className="section-label">Linked to {unresolved.length > 0 && <Button needs="tester" variant="ghost" size="sm" onClick={() => post("relink", undefined, "Checked again")}>Check again</Button>}</div>
          {b.refs.length === 0 ? <span className="faint">No requirements or test cases named.</span> : b.refs.map((r) => (
            <div key={r.id} className="row" style={{ gap: 8, padding: "2px 0", flexWrap: "wrap" }}>
              {r.state === "resolved" ? <span className="chip">linked</span> : <Badge tone="warn" icon="triangle-alert">{r.state.replace("_", " ")}</Badge>}
              {r.target?.kind === "case" ? <Link to={`/p/${pid}/cases?case=${r.target.id}`}>{r.label}</Link> : <span>{r.label}</span>}
              {r.reason && <span className="faint">{r.reason}</span>}
            </div>
          ))}
        </div>

        <div className="field">
          <div className="section-label"><Paperclip size={12} /> Evidence</div>
          {!stored.length && !problems.length && <span className="faint">No evidence files.</span>}
          <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
            {stored.map((a) => (
              <div key={a.id} className="col" style={{ gap: 4, maxWidth: 200 }}>
                {/^image\//.test(a.mime) && <a href={`/uploads/${a.stored_name}`} target="_blank" rel="noreferrer noopener"><img src={`/uploads/${a.stored_name}`} alt={a.label || a.filename} style={{ maxWidth: 200, maxHeight: 130, border: "1px solid var(--border)", borderRadius: "var(--radius)" }} /></a>}
                <a href={`/uploads/${a.stored_name}`} target="_blank" rel="noreferrer noopener" style={{ overflowWrap: "anywhere" }}>{a.label || a.filename}</a>
              </div>
            ))}
          </div>
          {problems.map((a) => (
            <div key={a.id} className="row" style={{ gap: 6, color: "var(--failed-fg)", fontSize: "var(--fs-md)" }}>
              <AlertTriangle size={13} /> <span className="mono" style={{ overflowWrap: "anywhere" }}>{a.declared_path}</span> — not imported: {a.reason || a.state.replace("_", " ")}
            </div>
          ))}
        </div>

        <div className="field">
          <div className="section-label"><Link2 size={12} /> External issues</div>
          {b.publications.length === 0 && <span className="faint">Not published or linked.</span>}
          {b.publications.map((p) => <PublicationRow key={p.id} p={p} run={run} />)}
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <select className="select" style={{ width: "auto" }} aria-label="Destination" value={link.destination} onChange={(e) => setLink({ ...link, destination: e.target.value })}>
              <option value="jira">Jira</option><option value="linear">Linear</option><option value="other">Other</option>
            </select>
            <input className="input grow" aria-label="Issue link" placeholder="https://… link to an issue that already covers this" value={link.url} onChange={(e) => setLink({ ...link, url: e.target.value })} />
            <Button needs="tester" disabled={!link.url.trim()} onClick={() => post("external-link", { destination: link.destination, url: link.url.trim() }, "Linked. Nothing was sent to that system.").then(() => setLink({ ...link, url: "" }))}>Link</Button>
          </div>
        </div>

        {b.status !== "duplicate" && b.similar.length > 0 && (
          <div className="field">
            <div className="section-label">Duplicates: similar reports (same fingerprint)</div>
            {b.similar.map((s) => (
              <div key={s.id} className="row" style={{ gap: 8 }}>
                <Button variant="ghost" size="sm" onClick={() => onOpen(s.id)}>{s.title}</Button><span className="faint">{s.status}</span>
                <span className="spacer" />
                <Button needs="tester" size="sm" onClick={() => post("duplicate", { ofId: s.id }, "Marked as a duplicate")}>This is a duplicate of it</Button>
              </div>
            ))}
          </div>
        )}
        {b.duplicates.length > 0 && <div className="faint">Marked as duplicates of this: {b.duplicates.map((d) => d.title).join(", ")}</div>}

        {b.events.length > 0 && (
          <div className="field">
            <div className="section-label">Workflow history</div>
            <div style={{ display: "grid", gap: 2, fontSize: "var(--fs-md)" }}>
              {b.events.map((e, i) => (
                <div key={i} className="row" style={{ gap: 8, alignItems: "baseline" }}>
                  <span className="faint" style={{ minWidth: 76 }} title={formatDateTime(e.at)}>{timeAgo(e.at)}</span>
                  <span className="chip">{e.actor === "ci" ? "CI" : "You"}</span>
                  <span style={{ overflowWrap: "anywhere" }}>{e.detail}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {b.source === "ci" ? (
          <div className="field">
            <div className="section-label"><FileText size={12} /> Where it came from</div>
            <div className="faint" style={{ fontSize: "var(--fs-md)", display: "grid", gap: 2 }}>
              <div>Reported by CI{b.origin.repository ? ` for ${b.origin.repository}` : ""}. One report per test: every failing run, branch and commit is added to it.</div>
              <div>Test key: <span className="mono" style={{ overflowWrap: "anywhere" }}>{b.testKey}</span></div>
              <div>First seen {timeAgo(b.importedAt)}</div>
            </div>
          </div>
        ) : (
        <div className="field">
          <div className="section-label"><FileText size={12} /> Where it came from</div>
          <div className="faint" style={{ fontSize: "var(--fs-md)", display: "grid", gap: 2 }}>
            <div>Audit: {b.origin.title || b.originAuditId} <span className="mono">({b.originAuditId})</span>{!b.audit && " · the audit was deleted from Testbench; this report was kept"}</div>
            <div>Agent: {[b.origin.agent?.name, b.origin.agent?.version, b.origin.agent?.model].filter(Boolean).join(" · ") || "unknown"}</div>
            <div>Found {b.foundAt ? timeAgo(b.foundAt) : "(time not given)"} · imported {timeAgo(b.importedAt)} via {b.origin.source ?? "?"}{b.origin.github ? ` (${b.origin.github.repo}#${b.origin.github.runId})` : ""}</div>
            {b.audit && <div>{RUN_STATE[b.audit.run_state] ?? b.audit.run_state}{b.runId ? <> · <Link to={`/p/${pid}/runs/${b.runId}`}>open run</Link></> : null}</div>}
            {b.agentReview && <div>Agent's own review (not a decision here): {b.agentReview.status || "—"}{b.agentReview.method ? ` · ${b.agentReview.method}` : ""}{b.agentReview.notes ? ` · ${b.agentReview.notes}` : ""}</div>}
            {b.origin.review && <div>Audit review: {b.origin.review.status}{b.origin.review.method ? ` · ${b.origin.review.method}` : ""}</div>}
            {b.confidence != null && <div>Agent's confidence: {Math.round(b.confidence * 100)}%</div>}
            <div>{b.revisions.length} revision{b.revisions.length === 1 ? "" : "s"} received</div>
          </div>
        </div>
        )}
      </div>
      {publishing && <PublishModal id={id} pid={pid} onClose={() => setPublishing(false)} />}
      {deleting && (
        <ConfirmModal
          title="Delete this report?"
          confirmLabel="Delete report"
          onClose={() => setDeleting(false)}
          onConfirm={() => run(() => api.del(`/api/bug-reports/${id}${guarded ? "?force=1" : ""}`), "Deleted").then(() => { setDeleting(false); onClose(); })}
        >
          <p style={{ margin: 0 }}>This removes the report and its evidence files from Testbench.{guarded ? " It is accepted or linked to an external issue; that issue is not touched." : ""} If the agent sends the same package again, it will come back as a new proposal.</p>
        </ConfirmModal>
      )}
    </Modal>
  );
}

// ---------- Latest runs ----------

/** Today as a time of day ("10:15"), otherwise as a date ("3 Nov"). */
export function whenShort(s: string | null | undefined): string {
  const d = parseDate(s);
  if (!d) return "—";
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Why a bug is marked New: names the run or import it came with, so the marker explains itself. */
function newWhy(kind: "ci" | "audit", r: LatestRuns | undefined): string {
  if (kind === "ci") return `First seen in the latest CI run${r?.ci ? ` (${[whenShort(r.ci.receivedAt), r.ci.branch, r.ci.commit.slice(0, 8)].filter(Boolean).join(" · ")})` : ""}. It stops being new when a newer run arrives.`;
  return `First reported in the latest audit import${r?.audit ? ` (${whenShort(r.audit.importedAt)} · ${r.audit.auditTitle})` : ""}. It stops being new when a newer import arrives.`;
}

/**
 * The latest CI run and the latest audit import of the project, and how many bugs came with each. "N new" shows exactly those bugs.
 * A bug is new when it first appeared in that latest run or import; a newer run or import makes the earlier ones' bugs old.
 */
function LatestRunsStrip({ r, onShowNew }: { r: LatestRuns; onShowNew: (kind: "ci" | "audit") => void }) {
  if (!r.ci && !r.audit && !r.manual) return null;
  const newCount = (n: number, kind: "ci" | "audit", what: string) =>
    n > 0
      ? <Button size="sm" onClick={() => onShowNew(kind)} aria-label={`${n} new ${n === 1 ? "bug" : "bugs"} from the latest ${what}: show ${n === 1 ? "it" : "them"}`} title={`Show the bugs that came with this ${what}`}>{n} new</Button>
      : <span className="faint">0 new</span>;
  const sep = <span className="faint" aria-hidden="true">·</span>;
  const row = { gap: 8, flexWrap: "wrap" as const, minHeight: 24 };
  return (
    <section aria-label="Latest runs" style={{ flexShrink: 0, padding: "6px 16px 6px 20px", borderBottom: "1px solid var(--border)", display: "grid", gap: 2, fontSize: "var(--fs-md)" }}>
      {r.ci && (
        <div className="row" style={row}>
          <strong style={{ fontWeight: 500 }}>Latest CI run</strong>
          {sep}<span title={formatDateTime(r.ci.receivedAt)}>{whenShort(r.ci.receivedAt)}</span>
          {r.ci.branch && <>{sep}<span className="mono">{r.ci.branch}</span></>}
          {r.ci.commit && <>{sep}<span className="mono">{r.ci.commit.slice(0, 8)}</span></>}
          {sep}<span className="faint">{r.ci.counts.passed} passed{r.ci.counts.failed > 0 && `, ${r.ci.counts.failed} failed`}{r.ci.counts.flaky > 0 && `, ${r.ci.counts.flaky} flaky`}</span>
          {sep}{newCount(r.ci.newCount, "ci", "CI run")}
          {r.ci.pipelineUrl && <CiLink url={r.ci.pipelineUrl}>run</CiLink>}
        </div>
      )}
      {r.audit && (
        <div className="row" style={row}>
          <strong style={{ fontWeight: 500 }}>Latest audit</strong>
          {sep}<span title={formatDateTime(r.audit.importedAt)}>{whenShort(r.audit.importedAt)}</span>
          {sep}<span style={{ overflowWrap: "anywhere" }}>{r.audit.auditTitle}</span>
          {sep}{newCount(r.audit.newCount, "audit", "audit import")}
        </div>
      )}
      {r.manual && (
        <div className="row" style={row}>
          <strong style={{ fontWeight: 500 }}>Latest manual</strong>
          {sep}<span title={formatDateTime(r.manual.at)}>{whenShort(r.manual.at)}</span>
          {sep}<span style={{ overflowWrap: "anywhere" }}>{r.manual.title}</span>
        </div>
      )}
    </section>
  );
}

// ---------- Workflow and CI ----------

/** Where the bug stands (open, may be resolved, closed) and who has it. Only a person changes these, and CI never closes a bug. */
function TriageCard({ b, onChange }: { b: Detail; onChange: (body: { assignee?: string; workflowStatus?: Workflow }) => void }) {
  return (
    <div className="card" style={{ padding: 12, display: "grid", gap: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <div>
          <label className="section-label" htmlFor="workflow">Workflow</label>
          <select id="workflow" className="select" value={b.workflowStatus} onChange={(e) => onChange({ workflowStatus: e.target.value as Workflow })}>
            {(Object.keys(WORKFLOW_LABEL) as Workflow[]).map((s) => <option key={s} value={s}>{WORKFLOW_LABEL[s]}</option>)}
          </select>
        </div>
        <div>
          <label className="section-label" htmlFor="assignee">Assigned to</label>
          <input
            key={b.assignee} id="assignee" className="input" defaultValue={b.assignee} placeholder="Unassigned" maxLength={100}
            onBlur={(e) => { if (e.target.value.trim() !== b.assignee) onChange({ assignee: e.target.value }); }}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          />
        </div>
      </div>
      {b.workflowStatus === "resolved_suspected" && (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <span style={{ flex: 1, minWidth: 220 }}>
            The test is green again{b.resolvedSuspectedAt ? ` (${timeAgo(b.resolvedSuspectedAt)})` : ""}. CI never closes a bug: check it and decide.
          </span>
          <Button needs="tester" variant="primary" size="sm" onClick={() => onChange({ workflowStatus: "closed" })}>Close bug</Button>
          <Button needs="tester" size="sm" onClick={() => onChange({ workflowStatus: "open" })}>Still a problem</Button>
        </div>
      )}
    </div>
  );
}

function CiLink({ url, children }: { url: string; children: React.ReactNode }) {
  return safeLink(url) ? <a href={url} target="_blank" rel="noreferrer noopener">{children} <ExternalLink size={11} /></a> : <>{children}</>;
}

/** What CI has reported about this bug's test: the latest failure with its error and links, each branch, and the history of runs. */
function CiSection({ ci, workflow }: { ci: CiDetail; workflow: Workflow }) {
  const [all, setAll] = useState(false);
  const f = ci.lastFailure;
  const history = all ? ci.history : ci.history.slice(0, 8);
  return (
    <div className="field">
      <div className="section-label">CI</div>
      <div className="col" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {ci.lastStatus && <CiStatusBadge value={ci.lastStatus} label={`Latest: ${CI_STATUS_LABEL[ci.lastStatus]}`} />}
          <span className="chip">{ci.failedRuns} failed run{ci.failedRuns === 1 ? "" : "s"}</span>
          {ci.flakyRuns > 0 && <Badge tone="warn" icon="triangle-alert">{ci.flakyRuns} flaky</Badge>}
          {ci.flaky && <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Flaky tests start at low severity and are never raised by CI.</span>}
          {workflow === "closed" && <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Closed. A new failure will open it again.</span>}
        </div>
        {f && (
          <div className="col" style={{ gap: 6 }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap", fontSize: "var(--fs-md)" }}>
              <strong>Latest {f.status === "flaky" ? "flaky result" : "failure"}</strong>
              <span className="mono">{f.branch || "unknown branch"}{f.commit && ` · ${shortSha(f.commit)}`}</span>
              <span className="faint" title={formatDateTime(f.at)}>{timeAgo(f.at)}</span>
              {f.pipelineUrl && <CiLink url={f.pipelineUrl}>CI run</CiLink>}
            </div>
            {f.error && <pre className="mono" style={{ margin: 0, padding: 10, maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--bg-subtle, transparent)" }}>{f.error}</pre>}
            {f.attachments.length > 0 && (
              <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                <Paperclip size={12} />
                {f.attachments.map((a, i) => <span key={i} className="row" style={{ gap: 4 }}><span className="chip">{a.type || "file"}</span><CiLink url={a.url}>{a.name}</CiLink></span>)}
              </div>
            )}
          </div>
        )}
        {ci.branches.length > 0 && (
          <div>
            <div className="section-label">By branch (latest result)</div>
            <div style={{ display: "grid", gap: 2, fontSize: "var(--fs-md)" }}>
              {ci.branches.map((x) => (
                <div key={x.branch} className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <CiStatusBadge value={x.status} />
                  <span className="mono">{x.branch || "unknown branch"}{x.commit && ` · ${shortSha(x.commit)}`}</span>
                  <span className="faint">{timeAgo(x.at)}</span>
                  {x.pipelineUrl && <CiLink url={x.pipelineUrl}>CI run</CiLink>}
                </div>
              ))}
            </div>
          </div>
        )}
        {ci.history.length > 0 && (
          <div>
            <div className="section-label">History ({ci.history.length}{ci.history.length === 100 ? "+" : ""})</div>
            <div style={{ display: "grid", gap: 2, fontSize: "var(--fs-md)" }}>
              {history.map((h) => (
                <div key={h.id} className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <CiStatusBadge value={h.status} />
                  <span className="mono">{h.branch || "unknown branch"}{h.commit && ` · ${shortSha(h.commit)}`}</span>
                  <span className="faint" title={formatDateTime(h.at)}>{timeAgo(h.at)}</span>
                  {h.pipelineUrl && <CiLink url={h.pipelineUrl}>CI run</CiLink>}
                  {h.error && <span className="faint truncate" style={{ maxWidth: 360 }} title={h.error}>{h.error.split("\n")[0]}</span>}
                </div>
              ))}
            </div>
            {ci.history.length > 8 && <Button variant="ghost" size="sm" style={{ marginTop: 4 }} onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${ci.history.length}`}</Button>}
          </div>
        )}
      </div>
    </div>
  );
}

interface CiToken { id: number; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }

/** API tokens for CI. A token is shown once, when it is made; only a hash is kept. */
function CiTokensModal({ pid, onClose }: { pid: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: tokens } = useQuery({ queryKey: ["ci-tokens", pid], queryFn: () => api.get<CiToken[]>(`/api/projects/${pid}/ci/tokens`) });
  const [name, setName] = useState("GitHub Actions");
  const [made, setMade] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<CiToken | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: ["ci-tokens", pid] });
  const create = () => api.post<{ token: string }>(`/api/projects/${pid}/ci/tokens`, { name }).then((r) => { setMade(r.token); reload(); }).catch((e: Error) => toast("error", e.message));
  const copy = (text: string) => { try { void navigator.clipboard.writeText(text).then(() => toast("success", "Copied"), () => toast("error", "Could not copy")); } catch { toast("error", "Could not copy"); } };
  const active = (tokens ?? []).filter((t) => !t.revokedAt);
  return (
    <Modal title="CI: send test results here" onClose={onClose} width={640} footer={<><span className="spacer" /><Button onClick={onClose}>Close</Button></>}>
      <div className="col" style={{ gap: 14 }}>
        <div className="faint" style={{ fontSize: "var(--fs-md)" }}>
          Your CI posts test results to <span className="mono">/api/projects/{pid}/ci/test-results</span> with <span className="mono">Authorization: Bearer &lt;token&gt;</span>.
          A failed test becomes one bug, keyed by its test key; later failures are added to it. A test that turns green is only marked "may be resolved". A token works for this project only.
        </div>
        {made && (
          <div className="card" style={{ padding: 12, borderColor: "var(--accent)", display: "grid", gap: 8 }}>
            <strong>Copy the token now. It is not shown again.</strong>
            <div className="row" style={{ gap: 8 }}>
              <input className="input grow mono" readOnly aria-label="New token" value={made} onFocus={(e) => e.currentTarget.select()} />
              <Button onClick={() => copy(made)}>Copy</Button>
            </div>
            <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>Store it as a secret in your CI (for GitHub Actions: <span className="mono">TESTBENCH_API_TOKEN</span>, with the address in <span className="mono">TESTBENCH_URL</span>), never in the code. Project number for <span className="mono">TESTBENCH_PROJECT_ID</span>: <span className="mono">{pid}</span>.</div>
          </div>
        )}
        <div className="row" style={{ gap: 8 }}>
          <input className="input grow" aria-label="Token name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, for example GitHub Actions" />
          <Button needs="admin" variant="primary" disabled={!name.trim()} onClick={create}><KeyRound size={14} /> Create token</Button>
        </div>
        <div className="field">
          <div className="section-label">Tokens</div>
          {!tokens?.length && <span className="faint">No tokens yet.</span>}
          {tokens?.map((t) => (
            <div key={t.id} className="row" style={{ gap: 8, padding: "3px 0", flexWrap: "wrap", opacity: t.revokedAt ? 0.6 : 1 }}>
              <strong>{t.name}</strong>
              <span className="mono faint">{t.prefix}…</span>
              <span className="faint">created {timeAgo(t.createdAt)}</span>
              <span className="faint">{t.lastUsedAt ? `last used ${timeAgo(t.lastUsedAt)}` : "never used"}</span>
              <span className="spacer" />
              {t.revokedAt ? <span className="chip">Revoked</span> : <Button needs="admin" size="sm" onClick={() => setRevoking(t)}>Revoke</Button>}
            </div>
          ))}
          {tokens && active.length === 0 && tokens.length > 0 && <div className="faint">No active tokens: CI cannot send results.</div>}
        </div>
      </div>
      {revoking && (
        <ConfirmModal title="Revoke this token?" confirmLabel="Revoke token" onClose={() => setRevoking(null)}
          onConfirm={() => api.post(`/api/ci-tokens/${revoking.id}/revoke`, {}).then(() => { reload(); setRevoking(null); }).catch((e: Error) => toast("error", e.message))}>
          <p style={{ margin: 0 }}>CI that uses “{revoking.name}” stops working at once and has to be given a new token. Bugs already created stay.</p>
        </ConfirmModal>
      )}
    </Modal>
  );
}

// ---------- Latest run ----------

const runText = (r: RunRef) => `Run ${r.run} · ${formatDateTime(r.importedAt)} · ${r.source === "github" ? "from GitHub" : "uploaded"}`;

function RunLink({ r }: { r: RunRef }) {
  return (
    <>
      {runText(r)}
      {r.github && r.github.url.startsWith("https://github.com/") && <> · <a href={r.github.url} target="_blank" rel="noreferrer noopener">{r.github.repo}#{r.github.runId} <ExternalLink size={11} /></a></>}
    </>
  );
}

/** Whether the report was in the latest run of its audit. Only shown, never acted on: nothing is closed, archived or removed because of it. */
function RunStanding({ r }: { r: LatestRun }) {
  if (r.presence === "missing") {
    return (
      <div className="card" style={{ padding: 12, borderColor: "var(--blocked)" }}>
        <div className="row" style={{ gap: 8 }}><EyeOff size={14} /><strong>Not present in latest audit run</strong></div>
        <div style={{ marginTop: 6, fontSize: "var(--fs-md)", display: "grid", gap: 2 }}>
          {r.lastSeen ? <div>Last seen: <RunLink r={r.lastSeen} />{!r.lastSeen.recorded && <span className="faint"> (earlier runs were not recorded in detail, so it may have been seen in a later one)</span>}</div> : <div>Last seen: not recorded</div>}
          {r.latest && <div>Latest run: <RunLink r={r.latest} /></div>}
        </div>
        <div className="faint" style={{ fontSize: "var(--fs-sm)", marginTop: 6 }}>
          The report is kept as it is. It is not closed, archived or marked as fixed because it is missing; if the problem is gone, you decide that yourself. If the agent reports it again it is the same report.
        </div>
      </div>
    );
  }
  if (r.presence === "present") return <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>Still present in the latest audit run{r.latest ? ` (${runText(r.latest)})` : ""}.</div>;
  return <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>No later run available. {r.reason}</div>;
}

// ---------- Publishing ----------

/** One link or publication of a report. A publication made here shows its state, what was sent, and what to do when it is unclear. */
function PublicationRow({ p, run }: { p: Publication; run: <T>(fn: () => Promise<T>, ok?: string) => Promise<T | void> }) {
  const created = p.mode === "created";
  const files = Object.entries((() => { try { return JSON.parse(p.attachments_state || "{}") as Record<string, string>; } catch { return {}; } })());
  const failedFiles = files.filter(([, v]) => v !== "ok");
  const sent = (() => { try { return p.content_sent ? (JSON.parse(p.content_sent) as { title: string; description: string; team?: { key: string }; priority?: { label: string } }) : null; } catch { return null; } })();
  const state = p.state === "pending" ? "unknown" : p.state;
  return (
    <div className="col" style={{ gap: 4, padding: "4px 0" }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <span className="chip">{p.destination}</span>
        {created && <Badge tone={state === "sent" ? "ok" : "warn"} icon={state === "sent" ? "circle-check" : "triangle-alert"}>{state === "sent" ? "published" : state === "failed" ? "not created" : "unclear"}</Badge>}
        {p.external_url ? <a href={p.external_url} target="_blank" rel="noreferrer noopener" style={{ overflowWrap: "anywhere" }}>{p.external_id || p.external_url} <ExternalLink size={11} /></a> : p.external_id}
        {p.completed_at && created && <span className="faint">{timeAgo(p.completed_at)}</span>}
        {p.mode === "linked_existing" && <Button needs="tester" variant="ghost" size="sm" aria-label="Remove link" onClick={() => run(() => api.del(`/api/bug-publications/${p.id}`), "Link removed")}>Remove</Button>}
        {created && state !== "sent" && <Button needs="tester" size="sm" onClick={() => run(() => api.post(`/api/bug-publications/${p.id}/check`), "Checked with Linear")}>Check status</Button>}
      </div>
      {created && state !== "sent" && (
        <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>
          {p.error || "The answer from Linear was unclear."} Linear may or may not have created the issue. Check status asks Linear; publishing again reuses the same id, so it cannot create a second issue.
        </div>
      )}
      {failedFiles.length > 0 && (
        <div className="row" style={{ gap: 8, color: "var(--failed-fg)", fontSize: "var(--fs-md)" }}>
          <AlertTriangle size={13} /> {failedFiles.length} of {files.length} file{files.length === 1 ? "" : "s"} did not get attached to the issue.
          <Button needs="tester" size="sm" onClick={() => run(() => api.post(`/api/bug-publications/${p.id}/retry-attachments`), "Tried the files again")}>Retry files</Button>
        </div>
      )}
      {created && sent && (
        <details style={{ fontSize: "var(--fs-md)" }}>
          <summary className="faint" style={{ cursor: "pointer" }}>What was sent</summary>
          <div style={{ fontWeight: 500, marginTop: 4, overflowWrap: "anywhere" }}>{sent.title}</div>
          <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: "4px 0", overflowWrap: "anywhere", fontSize: "var(--fs-sm)" }}>{sent.description}</pre>
        </details>
      )}
    </div>
  );
}

/** The preview a person approves before anything is created in Linear. The approval is tied to this exact preview. */
function PublishModal({ id, pid, onClose }: { id: number; pid: string; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh(pid);
  const [sel, setSel] = useState<{ refIds?: number[]; attachmentIds?: number[] }>({});
  const [approvedHash, setApprovedHash] = useState<string | null>(null);
  const { data: pv, error, refetch } = useQuery({ queryKey: ["publish-preview", id, sel], queryFn: () => api.post<Preview>(`/api/bug-reports/${id}/publish-preview`, sel), gcTime: 0, staleTime: 0 });
  const publish = useMutation({
    mutationFn: () => api.post<{ publication: { externalId: string } }>(`/api/bug-reports/${id}/publish`, { ...sel, previewHash: pv!.hash, approve: true }),
    onSuccess: (r) => { refresh(); toast("success", `Published as ${r.publication.externalId}`); onClose(); },
    onError: (e: Error) => { refresh(); toast("error", e.message); refetch(); },
  });
  const toggleRef = (rid: number) => pv && setSel({ ...sel, refIds: pv.refs.filter((r) => (r.id === rid ? !r.included : r.included)).map((r) => r.id) });
  const toggleFile = (aid: number) => pv && setSel({ ...sel, attachmentIds: pv.attachments.filter((a) => (a.id === aid ? !a.included : a.included)).map((a) => a.id) });
  const ready = !!pv?.canPublish && approvedHash === pv.hash;
  const team = pv?.destination?.team;
  return (
    <Modal
      title="Publish to Linear"
      onClose={onClose}
      width={820}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button needs="tester" variant="primary" disabled={!ready || publish.isPending} onClick={() => publish.mutate()}><Send size={14} /> {publish.isPending ? "Creating…" : "Create the issue in Linear"}</Button>
        </>
      }
    >
      {!pv ? (
        error ? <div style={DANGER}>{(error as Error).message}</div> : <ListSkeleton rows={4} />
      ) : (
        <div className="col" style={{ gap: 14 }}>
          <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>Nothing has been sent. This is exactly what will be created, and it is only created when you approve it below.</div>
          {pv.blockers.map((m) => <div key={m} className="row" style={{ gap: 6, ...DANGER }}><AlertTriangle size={14} /> {m}</div>)}
          <div className="field"><div className="section-label">Target</div><div>Linear · team {team ? `${team.name} (${team.key})` : "not set"}</div></div>
          <div className="field"><div className="section-label">Title</div><div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{pv.title}</div></div>
          <div className="field">
            <div className="section-label">Description</div>
            <pre className="mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0, padding: 10, border: "1px solid var(--border)", borderRadius: 6, maxHeight: 280, overflow: "auto", fontSize: "var(--fs-md)" }}>{pv.description}</pre>
          </div>
          <div className="field"><div className="section-label">Severity</div><div>{pv.priority.mapping}</div></div>
          <div className="field">
            <div className="section-label">Links to requirements and test cases</div>
            {pv.refs.length === 0 && <span className="faint">None named in the report.</span>}
            {pv.refs.map((r) => (
              <label key={r.id} className="row" style={{ gap: 8, cursor: r.sendable ? "pointer" : "default", opacity: r.sendable ? 1 : 0.6 }}>
                <input type="checkbox" className="checkbox" checked={r.included} disabled={!r.sendable} onChange={() => toggleRef(r.id)} />
                <span>{r.label}</span>{!r.sendable && <span className="faint">not found in this project, cannot be sent</span>}
              </label>
            ))}
          </div>
          <div className="field">
            <div className="section-label"><Paperclip size={12} /> Files attached to the issue</div>
            {pv.attachments.length === 0 && <span className="faint">No evidence files.</span>}
            {pv.attachments.map((a) => (
              <label key={a.id} className="row" style={{ gap: 8, cursor: a.sendable ? "pointer" : "default", opacity: a.sendable ? 1 : 0.6 }}>
                <input type="checkbox" className="checkbox" checked={a.included} disabled={!a.sendable} onChange={() => toggleFile(a.id)} />
                <span style={{ overflowWrap: "anywhere" }}>{a.filename}</span><span className="faint">{fmtSize(a.size)}</span>{a.reason && <span className="faint">will not be sent: {a.reason}</span>}
              </label>
            ))}
          </div>
          {pv.warnings.map((m) => <div key={m} className="faint" style={{ fontSize: "var(--fs-md)" }}>{m}</div>)}
          <label className="row" style={{ gap: 8, cursor: "pointer", alignItems: "flex-start" }}>
            <input type="checkbox" className="checkbox" checked={approvedHash === pv.hash} disabled={!pv.canPublish} onChange={(e) => setApprovedHash(e.target.checked ? pv.hash : null)} />
            <span>I have read the preview and approve creating this issue in Linear{team ? ` (team ${team.key})` : ""}.</span>
          </label>
        </div>
      )}
    </Modal>
  );
}

/** Where this project's accepted reports are published. The key is sealed on the server and never shown again. */
function DestinationModal({ pid, onClose }: { pid: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ["destination", pid], queryFn: () => api.get<{ destination: Destination | null; serverKey: boolean }>(`/api/projects/${pid}/destination`) });
  const [token, setToken] = useState("");
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [team, setTeam] = useState("");
  const dest = data?.destination ?? null;
  const done = () => qc.invalidateQueries({ queryKey: ["destination", pid] });
  const load = useMutation({
    mutationFn: () => api.post<Team[]>(`/api/projects/${pid}/destination/teams`, { token: token.trim() || undefined }),
    onSuccess: (t) => { setTeams(t); setTeam(t.find((x) => x.id === dest?.team.id)?.key ?? t[0]?.key ?? ""); },
    onError: (e: Error) => toast("error", e.message),
  });
  const save = useMutation({
    mutationFn: () => api.put(`/api/projects/${pid}/destination`, { token: token.trim() || undefined, team: team || undefined }),
    onSuccess: () => { done(); setToken(""); setTeams(null); toast("success", "Saved"); },
    onError: (e: Error) => toast("error", e.message),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/projects/${pid}/destination`),
    onSuccess: () => { done(); toast("success", "Destination removed"); },
    onError: (e: Error) => toast("error", e.message),
  });
  const source = dest?.tokenSource;
  return (
    <Modal title="Publishing destination" onClose={onClose} width={560} footer={<><span className="spacer" /><Button onClick={onClose}>Close</Button></>}>
      <div className="col" style={{ gap: 12 }}>
        <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>
          Accepted bug reports of this project can be published to Linear, one at a time, after a preview. Nothing is sent when you save this or when you accept a report.
        </div>
        {dest ? (
          <div className="card" style={{ padding: 10 }}>
            <div>Linear · team <strong>{dest.team.name}</strong> ({dest.team.key})</div>
            <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>
              {source === "stored" ? `API key stored for this project (ends ${dest.tokenHint})` : source === "environment" ? "Using the server's own key (LINEAR_API_KEY)" : source === "unreadable" ? "The stored key cannot be read on this installation. Enter it again." : "No API key. Enter one below."}
            </div>
          </div>
        ) : <div className="faint">No destination yet.</div>}
        <div className="field">
          <label htmlFor="lin-key">Linear API key</label>
          <input id="lin-key" className="input" type="password" autoComplete="off" spellCheck={false} placeholder={dest && source === "stored" ? "Leave empty to keep the stored key" : data?.serverKey ? "Leave empty to use the server's key" : "lin_api_…"} value={token} onChange={(e) => { setToken(e.target.value); setTeams(null); }} />
          <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Personal key from Linear: Settings, Account, Security &amp; access. It is stored encrypted on the server, never shown again, and is not part of backups.</span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Button needs="admin" disabled={load.isPending || (!token.trim() && !dest && !data?.serverKey)} onClick={() => load.mutate()}>{load.isPending ? "Checking…" : "Check key and load teams"}</Button>
          {teams && (
            <select className="select" aria-label="Team" value={team} onChange={(e) => setTeam(e.target.value)}>
              {teams.map((t) => <option key={t.id} value={t.key}>{t.name} ({t.key})</option>)}
            </select>
          )}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Button needs="admin" variant="primary" disabled={!teams || !team || save.isPending} onClick={() => save.mutate()}>Save destination</Button>
          {dest && <Button needs="admin" variant="ghost" style={DANGER} disabled={remove.isPending} onClick={() => remove.mutate()}>Remove</Button>}
        </div>
      </div>
    </Modal>
  );
}

// ---------- Audits ----------

function AuditsPanel({ pid }: { pid: string }) {
  const toast = useToast();
  const refresh = useRefresh(pid);
  const { data: audits, isLoading } = useQuery({ queryKey: ["audits", pid], queryFn: () => api.get<Audit[]>(`/api/projects/${pid}/audits`) });
  const { data: rejected } = useQuery({ queryKey: ["audit-rejections", pid], queryFn: () => api.get<{ artifactId: number; name: string; note: string; seenAt: string; repo: string }[]>(`/api/projects/${pid}/audit-rejections`) });
  const [report, setReport] = useState<Audit | null>(null);
  const [del, setDel] = useState<Audit | null>(null);
  const { data: text } = useQuery({ queryKey: ["audit-report", report?.id], enabled: !!report, queryFn: async () => { const r = await fetch(`/api/audits/${report!.id}/report`); return r.ok ? r.text() : "The report could not be loaded."; } });
  const { data: preview } = useQuery({ queryKey: ["audit-deletion", del?.id], enabled: !!del, queryFn: () => api.get<{ title: string; deleted: number; kept: number; manualDeleted: number; manualKept: number; plan?: { planItems: number; coverageGaps: number }; planOwned?: { planItems: number; coverageGaps: number; history: number } }>(`/api/audits/${del!.id}/deletion-preview`) });
  const remove = useMutation({
    mutationFn: () => api.del<{ deleted: number; kept: number }>(`/api/audits/${del!.id}`),
    onSuccess: (r) => { refresh(); setDel(null); toast("success", `Audit deleted. ${r.deleted} untouched proposal${r.deleted === 1 ? "" : "s"} removed, ${r.kept} report${r.kept === 1 ? "" : "s"} kept.`); },
    onError: (e: Error) => toast("error", e.message),
  });
  if (isLoading) return <ListSkeleton rows={3} />;
  return (
    <div className="col" style={{ gap: 16, padding: "12px 20px" }}>
      {!audits?.length ? <Empty icon={<Bug size={20} />} title="No audits imported yet">An audit is the package a test agent leaves behind: its reports, evidence and its own readable report.</Empty> : audits.map((a) => (
        <div key={a.id} className="card" style={{ padding: 12 }}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <strong style={{ overflowWrap: "anywhere" }}>{a.title || a.agentAuditId}</strong>
            <span className="chip">{a.source === "github" ? "GitHub" : "Upload"}</span>
            <span className="spacer" />
            {a.planItems + a.coverageGaps > 0 && <Link className={buttonClass("secondary", "sm")} to={`/p/${pid}/test-plan?audit=${a.id}`}><ClipboardList size={12} /> Test plan</Link>}
            {a.hasReport && <Button size="sm" onClick={() => setReport(a)}><FileText size={12} /> Audit report</Button>}
            <Button needs="admin" variant="ghost" size="sm" style={DANGER} onClick={() => setDel(a)}><Trash2 size={12} /> Delete</Button>
          </div>
          <div className="faint" style={{ fontSize: "var(--fs-md)", marginTop: 4, display: "grid", gap: 2 }}>
            <div><span className="mono">{a.agentAuditId}</span> · {a.agent || "agent unknown"} · last imported {timeAgo(a.lastImportedAt)} ({a.imports} import{a.imports === 1 ? "" : "s"})</div>
            <div>{a.bugs} report{a.bugs === 1 ? "" : "s"}, {a.proposed} still proposed · {RUN_STATE[a.runState] ?? a.runState}{a.github ? ` (${a.github.repo}#${a.github.runId})` : ""}</div>
            {a.planItems + a.coverageGaps > 0 && <div>Test plan: {a.planItems} plan item{a.planItems === 1 ? "" : "s"}, {a.coverageGaps} coverage gap{a.coverageGaps === 1 ? "" : "s"}</div>}
          </div>
        </div>
      ))}
      {!!rejected?.length && (
        <div className="card" style={{ padding: 12 }}>
          <div className="section-label"><AlertTriangle size={12} /> GitHub packages that could not be imported</div>
          <div className="faint" style={{ marginBottom: 6 }}>These are not tried again. Fix the package and upload a new one, or import it by hand.</div>
          {rejected.map((r) => <div key={r.artifactId} style={{ overflowWrap: "anywhere" }}><span className="mono">{r.name}</span> <span className="faint">({r.repo}, {timeAgo(r.seenAt)})</span> — {r.note}</div>)}
        </div>
      )}
      <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>
        GitHub import looks at the repository's 100 most recent artifacts named <code className="inline">testbench-audit-*</code> on each check. After a long pause, older packages are not found: import them by hand.
      </div>
      {report && (
        <Modal title={`Audit report · ${report.title || report.agentAuditId}`} onClose={() => setReport(null)} width={760} footer={<Button onClick={() => setReport(null)}>Close</Button>}>
          <pre className="snippet" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "60vh" }}>{text ?? "Loading…"}</pre>
        </Modal>
      )}
      {del && (
        <ConfirmModal title="Delete this audit?" confirmLabel="Delete audit" busy={remove.isPending} onClose={() => setDel(null)} onConfirm={() => remove.mutate()}>
          {preview ? (
            <>
            <p style={{ margin: 0 }}>
              {preview.deleted} untouched proposal{preview.deleted === 1 ? "" : "s"} and the stored audit report will be removed.{" "}
              {preview.kept > 0 ? `${preview.kept} report${preview.kept === 1 ? " is" : "s are"} kept (reviewed, edited or linked), with their evidence and a note of where they came from.` : "No reports are kept."}{" "}
              {preview.manualDeleted + preview.manualKept > 0 && `Agent proposals: ${preview.manualDeleted} untouched proposal${preview.manualDeleted === 1 ? "" : "s"} removed, ${preview.manualKept} kept (reviewed or edited).`}{" "}
              {!!preview.plan && preview.plan.planItems + preview.plan.coverageGaps > 0 && `The test plan (${preview.plan.planItems} plan item${preview.plan.planItems === 1 ? "" : "s"}, ${preview.plan.coverageGaps} coverage gap${preview.plan.coverageGaps === 1 ? "" : "s"}) is removed too.`}
            </p>
            {!!preview.planOwned && preview.planOwned.planItems + preview.planOwned.coverageGaps > 0 && (
              <p role="alert" style={{ margin: "8px 0 0", color: "var(--failed-fg)" }}>
                <strong>Work done by people is lost.</strong> {preview.planOwned.planItems} plan item{preview.planOwned.planItems === 1 ? "" : "s"} and {preview.planOwned.coverageGaps} coverage gap{preview.planOwned.coverageGaps === 1 ? "" : "s"} that people edited, decided or added, and the {preview.planOwned.history} entr{preview.planOwned.history === 1 ? "y" : "ies"} of the plan's history, are deleted with the audit. This cannot be undone.
              </p>
            )}
            </>
          ) : <p style={{ margin: 0 }}>Checking…</p>}
        </ConfirmModal>
      )}
    </div>
  );
}

// ---------- Import ----------

interface Picked { file: File; path: string; fromFolder: boolean }
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export function ImportModal({ pid, onClose }: { pid: string; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh(pid);
  const zipInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Picked[]>([]);
  const form = (list: Picked[]) => {
    const fd = new FormData();
    for (const p of list) {
      if (p.fromFolder) fd.append("relpath", p.path); // must come right before its file
      fd.append("file", p.file, p.file.name);
    }
    return fd;
  };
  const preview = useMutation({ mutationFn: (list: Picked[]) => api.post<Summary>(`/api/projects/${pid}/audit-import?dryRun=1`, form(list)) });
  const doImport = useMutation({
    mutationFn: () => api.post<Summary>(`/api/projects/${pid}/audit-import`, form(picked)),
    onSuccess: (s) => {
      refresh();
      const m = s.manualTests;
      toast("success", `Imported: ${s.counts.new} new, ${s.counts.updated} updated, ${s.counts.pending} waiting for your decision${m.listed ? `. Agent proposals: ${m.counts.new} new, ${m.counts.updated} updated, ${m.counts.pending} waiting` : ""}`);
      onClose();
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const choose = (list: FileList | null, fromFolder: boolean) => {
    if (!list?.length) return;
    const files = [...list].filter((f) => !f.webkitRelativePath.includes("node_modules/") && !(fromFolder && f.name === ".DS_Store"));
    if (files.some((f) => f.size > MAX_UPLOAD_BYTES)) { toast("error", "A file in the package is over 100 MB"); return; }
    const next = files.map((file) => ({ file, path: (fromFolder && file.webkitRelativePath) || file.name, fromFolder }));
    setPicked(next);
    preview.mutate(next);
  };
  const s = preview.data;
  return (
    <Modal
      title="Import audit package"
      onClose={onClose}
      width={720}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button needs="tester" variant="primary" disabled={!s || preview.isPending || doImport.isPending} onClick={() => doImport.mutate()}>{doImport.isPending ? "Importing…" : "Import as proposals"}</Button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <div className="faint">A package is a zip or a folder with <code className="inline">manifest.json</code>, <code className="inline">bugs.json</code>, optionally <code className="inline">manual-tests.json</code>, and its evidence. Every report and every manual test arrives as a proposal; nothing is accepted, run or sent anywhere. Manual tests show on Agent proposals; accept one to turn it into a test case.</div>
        <div className="row">
          <input ref={zipInput} type="file" accept=".zip" hidden onChange={(e) => { choose(e.target.files, false); e.target.value = ""; }} />
          <input ref={folderInput} type="file" multiple hidden {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} onChange={(e) => { choose(e.target.files, true); e.target.value = ""; }} />
          <Button onClick={() => zipInput.current?.click()}><Upload size={13} /> Choose a zip</Button>
          <Button onClick={() => folderInput.current?.click()}><FolderOpen size={13} /> Choose a folder</Button>
          {picked.length > 0 && <span className="faint">{picked.length} file{picked.length === 1 ? "" : "s"} chosen</span>}
        </div>
        {preview.isPending && <ListSkeleton rows={2} />}
        {preview.error && <div role="alert" style={DANGER}>{(preview.error as Error).message}</div>}
        {s && (
          <div className="col" style={{ gap: 8 }}>
            <div className="card" style={{ padding: 12 }}>
              <div><strong>{s.audit.title || s.audit.agentAuditId}</strong> <span className="faint">{s.audit.agent}</span></div>
              <div className="faint" style={{ fontSize: "var(--fs-md)" }}>
                {s.audit.isNew ? "A new audit" : "An audit that was imported before"} · {RUN_STATE[s.audit.runState]}{s.audit.github ? ` (${s.audit.github.repo}#${s.audit.github.runId})` : ""}
              </div>
              <div style={{ marginTop: 6 }}>
                {s.counts.new} new · {s.counts.unchanged} unchanged · {s.counts.updated} updated · {s.counts.pending} with a newer version waiting for review
              </div>
              <div className="faint" style={{ fontSize: "var(--fs-md)" }}>
                Evidence: {s.evidence.ok} file{s.evidence.ok === 1 ? "" : "s"} will be stored{s.evidence.problems ? `, ${s.evidence.problems} cannot be imported` : ""} · {s.unresolvedRefs} reference{s.unresolvedRefs === 1 ? "" : "s"} not resolved
              </div>
            </div>
            {s.manualTests.listed && (
              <div className="card" style={{ padding: 12 }}>
                <strong>Agent proposals (manual tests)</strong>
                <div style={{ marginTop: 4 }}>
                  {s.manualTests.counts.new} new · {s.manualTests.counts.unchanged} unchanged · {s.manualTests.counts.updated} updated · {s.manualTests.counts.pending} with a newer version waiting for review
                </div>
                <div className="faint" style={{ fontSize: "var(--fs-md)" }}>{s.manualTests.unresolvedRefs} reference{s.manualTests.unresolvedRefs === 1 ? "" : "s"} not resolved. A person has to run these; nothing is run by the import.</div>
                <div style={{ maxHeight: 140, overflow: "auto", marginTop: 6 }}>
                  {s.manualTests.items.map((i) => (
                    <div key={i.sourceId} className="row" style={{ gap: 8, padding: "3px 0" }}>
                      <span className="chip">{i.action === "update" ? "updated" : i.action}</span>
                      <span className="chip">{i.category}</span>
                      <span className="truncate grow" title={i.title}>{i.title}</span>
                      {i.unresolvedRefs > 0 && <span style={{ color: "var(--blocked-fg)" }}>{i.unresolvedRefs} unresolved</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {s.testPlan?.listed && (() => {
              const a = s.testPlan.planItems.counts; const g = s.testPlan.coverageGaps.counts; const kept = a.pending + g.pending;
              return (
                <div className="card" style={{ padding: 12 }}>
                  <strong>Test plan</strong>
                  <div style={{ marginTop: 4 }}>Plan items: {a.new} new · {a.unchanged} unchanged · {a.updated} updated · {a.removed} removed</div>
                  <div>Coverage gaps: {g.new} new · {g.unchanged} unchanged · {g.updated} updated · {g.removed} removed</div>
                  {kept > 0 && (
                    <div style={{ marginTop: 2 }}>
                      <strong>{kept} post{kept === 1 ? "" : "s"} kept, agent version waiting.</strong>{" "}
                      <span className="faint">Items and gaps you edited, decided or added are never changed by an import. Review the agent's version on Test plan.</span>
                    </div>
                  )}
                </div>
              );
            })()}
            {s.warnings.map((w, i) => <div key={i} className="row" style={{ gap: 6, color: "var(--blocked-fg)", fontSize: "var(--fs-md)" }}><AlertTriangle size={13} /> {w}</div>)}
            <div style={{ maxHeight: 220, overflow: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
              {s.items.map((i) => (
                <div key={i.sourceId} className="row" style={{ gap: 8, padding: "6px 10px", borderBottom: "1px solid var(--border)" }}>
                  <span className="chip">{i.action === "update" ? "updated" : i.action}</span>
                  <span className="truncate grow" title={i.title}>{i.title}</span>
                  {i.evidenceProblems > 0 && <span style={DANGER}>{i.evidenceProblems} file problem{i.evidenceProblems === 1 ? "" : "s"}</span>}
                  {i.unresolvedRefs > 0 && <span style={{ color: "var(--blocked-fg)" }}>{i.unresolvedRefs} unresolved</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
