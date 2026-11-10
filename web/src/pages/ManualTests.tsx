import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, ClipboardCheck, EyeOff, Pencil, Trash2, Upload, UserCheck } from "lucide-react";
import { api, formatDateTime, formatViewport, timeAgo, type Priority, type Viewport } from "../api";
import { ConfirmModal, Empty, ListSkeleton, Modal, PriorityIcon, PRIORITY_LABEL, useToast } from "../components/ui";
import { proposalCaseLink } from "../caseFilter";
import { ImportModal, Severity, StatusChip, useRefresh, whenShort } from "./BugReports";
import { Button, buttonClass } from "../components/Button";
import { Badge } from "../components/Badge";
import { useCan } from "../components/Access";

type Status = "proposed" | "accepted" | "rejected";
type Presence = "present" | "missing" | "no_later_run";
type Category = "functional" | "accessibility" | "responsive" | "usability" | "security" | "other";
const CATEGORY_LABEL: Record<Category, string> = { functional: "Functional", accessibility: "Accessibility", responsive: "Responsive", usability: "Usability", security: "Security", other: "Other" };

interface Item {
  id: number; sourceId: string; title: string; status: Status; category: Category; priority: Priority; wcag: string[]; viewports: string[];
  importedAt: string; auditTitle: string; auditDeleted: boolean; unresolvedRefs: number; requirements: number; edited: boolean; pendingUpdate: boolean; presence: Presence; testCase: string | null; isNew: boolean;
}
interface LatestImport { importId: number; auditTitle: string; importedAt: string; newCount: number }
interface List { items: Item[]; counts: Record<string, number>; presenceCounts: Record<Presence, number>; wcagCriteria: string[]; latest: LatestImport | null }
interface RunRef { run: number; importId: number; importedAt: string; source: string; github: { repo: string; runId: number; url: string } | null }
interface Ref { id: number; kind: string; raw: string; state: string; reason: string; label: string; target: { kind: string; id: number } | null }
interface Detail {
  id: number; projectId: number; sourceId: string; status: Status; reviewedAt: string | null; reviewNote: string; editedAt: string | null;
  title: string; description: string; preconditions: string; steps: string[]; expected: string; category: Category; wcag: string[]; viewports: Viewport[];
  priority: { agent: Priority; human: Priority | null; effective: Priority };
  agentVersion: { title: string; steps: string[]; expected: string; priority: Priority } | null;
  importedAt: string; agentUpdatedAt: string; origin: { title?: string; agent?: { name?: string; version?: string; model?: string }; source?: string; github?: { repo: string; runId: number } | null };
  originAuditId: string; audit: { id: number; title: string; run_state: string; run_id: number | null } | null;
  refs: Ref[]; revisions: { rev: number; imported_at: string }[];
  pendingUpdate: { rev: number; changes: { field: string; from: string; to: string }[] } | null;
  latestRun: { presence: Presence; reason: string; runs: number; latest: RunRef | null; lastSeen: RunRef | null };
  testCase: { id: number; number: number; key: string; title: string; status: string; lastStatus: string | null } | null;
}

type Tab = Status | "all";
const TAB_LABEL: Record<Tab, string> = { proposed: "Proposed", accepted: "Accepted", rejected: "Rejected", all: "All" };
const DANGER = { color: "var(--failed-fg)" };
const RUN_STATE: Record<string, string> = { linked: "Linked to the run", pending: "Waiting for the run to be imported", none: "No GitHub run named", deleted: "The run was deleted" };

export function ManualTestsPage() {
  const { pid } = useParams();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>("proposed");
  const [importing, setImporting] = useState(false);
  const [category, setCategory] = useState("");
  const [priority, setPriority] = useState("");
  const [wcag, setWcag] = useState("");
  const [presence, setPresence] = useState<"" | Presence>("");
  const [q, setQ] = useState("");
  const [onlyNew, setOnlyNew] = useState(false);
  const open = Number(params.get("test")) || null;
  const query = new URLSearchParams({ status: tab, ...(category && { category }), ...(priority && { priority }), ...(wcag && { wcag }), ...(presence && { presence }), ...(onlyNew && { new: "any" }), ...(q.trim() && { q: q.trim() }) }).toString();
  const { data, isLoading } = useQuery({ queryKey: ["manual-tests", pid, tab, category, priority, wcag, presence, onlyNew, q.trim()], queryFn: () => api.get<List>(`/api/projects/${pid}/manual-tests?${query}`), placeholderData: keepPreviousData });
  const counts = data?.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const setOpen = (id: number | null) => setParams((p) => { if (id) p.set("test", String(id)); else p.delete("test"); return p; }, { replace: true });
  const filtered = !!(category || priority || wcag || presence || onlyNew || q.trim());
  const latest = data?.latest ?? null;

  return (
    <>
      <div className="topbar">
        <h1>Agent proposals</h1>
        <span className="spacer" />
        <Button needs="tester" variant="primary" onClick={() => setImporting(true)}><Upload size={14} /> Import audit package</Button>
      </div>
      {latest && (
        <section aria-label="Latest audit" className="row" style={{ flexShrink: 0, gap: 8, flexWrap: "wrap", minHeight: 24, padding: "6px 16px 6px 20px", borderBottom: "1px solid var(--border)", fontSize: "var(--fs-md)" }}>
          <strong style={{ fontWeight: 500 }}>Latest audit with proposals</strong>
          <span className="faint" aria-hidden="true">·</span><span title={formatDateTime(latest.importedAt)}>{whenShort(latest.importedAt)}</span>
          <span className="faint" aria-hidden="true">·</span><span style={{ overflowWrap: "anywhere" }}>{latest.auditTitle}</span>
          <span className="faint" aria-hidden="true">·</span>
          {latest.newCount > 0
            ? <Button size="sm" onClick={() => { setTab("all"); setCategory(""); setPriority(""); setWcag(""); setPresence(""); setQ(""); setOnlyNew(true); }} aria-label={`${latest.newCount} new ${latest.newCount === 1 ? "proposal" : "proposals"} from the latest audit: show ${latest.newCount === 1 ? "it" : "them"}`} title="Show the proposals that came with this audit import">{latest.newCount} new</Button>
            : <span className="faint">0 new</span>}
        </section>
      )}
      <div className="toolbar">
        <div className="tabs" role="tablist">
          {(["proposed", "accepted", "rejected", "all"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
              {TAB_LABEL[t]}<span className="count">{t === "all" ? total : (counts[t] ?? 0)}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        <input className="input" style={{ width: 200 }} placeholder="Search proposals" aria-label="Search agent proposals" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="toolbar" style={{ gap: 8 }}>
        <select className="select" style={{ width: "auto" }} aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Category: any</option>
          {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
        </select>
        <select className="select" style={{ width: "auto" }} aria-label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="">Priority: any</option>
          {(["critical", "high", "medium", "low"] as const).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
        </select>
        <select className="select" style={{ width: "auto" }} aria-label="WCAG criterion" value={wcag} onChange={(e) => setWcag(e.target.value)}>
          <option value="">WCAG: any</option>
          <option value="any">Has a WCAG criterion</option>
          {(data?.wcagCriteria ?? []).map((c) => <option key={c} value={c}>WCAG {c}</option>)}
        </select>
        <select className="select" style={{ width: "auto" }} aria-label="Latest audit run" value={presence} onChange={(e) => setPresence(e.target.value as "" | Presence)} title="Compare with the latest run of the audit each test came from">
          <option value="">Latest run: any</option>
          <option value="present">Still present in latest run{data ? ` (${data.presenceCounts.present})` : ""}</option>
          <option value="missing">Not present in latest run{data ? ` (${data.presenceCounts.missing})` : ""}</option>
          <option value="no_later_run">No later run available{data ? ` (${data.presenceCounts.no_later_run})` : ""}</option>
        </select>
        <select className="select" style={{ width: "auto" }} aria-label="New" value={onlyNew ? "any" : ""} onChange={(e) => setOnlyNew(e.target.value === "any")} title="Proposals that came with the latest audit import">
          <option value="">New: any</option>
          <option value="any">New{latest ? ` (${latest.newCount})` : ""}</option>
        </select>
      </div>
      <div className="content">
        <div className="faint" style={{ padding: "8px 20px", fontSize: "var(--fs-md)", display: "flex", gap: 8, alignItems: "center" }}>
          <UserCheck size={14} />
          <span>Manual test cases proposed by a test agent. <strong>Accept one, then create a test case from it</strong>: the test case is what you run in Runs and what counts as coverage. Testbench never runs a test or decides its result.</span>
        </div>
        {isLoading ? (
          <ListSkeleton />
        ) : !data?.items.length ? (
          <Empty icon={<ClipboardCheck size={20} />} title={filtered ? "No proposals match these filters" : tab === "proposed" ? "Nothing waiting for review" : "No proposals here"}
            action={<Button needs="tester" onClick={() => setImporting(true)}><Upload size={14} /> Import audit package</Button>}>
            An audit package can carry a manual-tests.json: checks an automatic run cannot decide, such as reading order with a screen reader.
          </Empty>
        ) : (
          data.items.map((t) => (
            <button key={t.id} className="list-row" style={{ width: "100%", textAlign: "left" }} onClick={() => setOpen(t.id)}>
              <span className="id mono truncate" style={{ width: 120 }} title={t.sourceId}>{t.sourceId}</span>
              <span className="title">{t.title}</span>
              <span className="meta">
                {t.isNew && <Badge tone="accent" title={`First proposed in the latest audit import${latest ? ` (${whenShort(latest.importedAt)} · ${latest.auditTitle})` : ""}. It stops being new when a newer import with proposals arrives.`}>New</Badge>}
                {t.pendingUpdate && <Badge tone="accent" icon="eye" title="The agent sent a newer version. Review it.">Update waiting</Badge>}
                {t.presence === "missing" && <Badge tone="warn" icon="eye-off" title="This test was not in the latest run of its audit. It is kept as it is.">Not in latest run</Badge>}
                {t.unresolvedRefs > 0 && <span className="chip" title="References that match nothing in this project"><AlertTriangle size={11} /> {t.unresolvedRefs} unresolved</span>}
                <span className="chip">{CATEGORY_LABEL[t.category]}</span>
                {t.wcag.length > 0 && <span className="chip" title={`WCAG ${t.wcag.join(", ")}`}>WCAG {t.wcag.length > 2 ? `${t.wcag.slice(0, 2).join(", ")}…` : t.wcag.join(", ")}</span>}
                {t.viewports.length > 0 && <span className="chip" title={t.viewports.join("; ")}>{t.viewports.length} viewport{t.viewports.length === 1 ? "" : "s"}</span>}
                {t.testCase
                  ? <span className="chip" title="The test case made from this proposal. Run it in Runs."><ClipboardCheck size={11} /> Test case {t.testCase}</span>
                  : <Badge tone={t.status === "proposed" ? "accent" : t.status === "accepted" ? "warn" : "neutral"} icon={t.status === "proposed" ? "eye" : t.status === "accepted" ? "circle-check" : "circle-x"} title="Testbench does not run this. A person has to.">{t.status === "proposed" ? "Needs your review" : t.status === "accepted" ? "Accepted: create a test case" : "Not used"}</Badge>}
                <Severity value={t.priority} />
                {tab === "all" && <StatusChip status={t.status} />}
                <span className="faint" title={t.auditTitle}>{timeAgo(t.importedAt)}</span>
              </span>
            </button>
          ))
        )}
      </div>
      {open && <DetailModal id={open} pid={pid!} onClose={() => setOpen(null)} />}
      {importing && <ImportModal pid={pid!} onClose={() => setImporting(false)} />}
    </>
  );
}

// ---------- One test ----------

const runText = (r: RunRef) => `Run ${r.run} · ${formatDateTime(r.importedAt)} · ${r.source === "github" ? "from GitHub" : "uploaded"}`;

function Standing({ r }: { r: Detail["latestRun"] }) {
  if (r.presence === "missing") {
    return (
      <div className="card" style={{ padding: 12, borderColor: "var(--blocked)" }}>
        <div className="row" style={{ gap: 8 }}><EyeOff size={14} /><strong>Not present in latest audit run</strong></div>
        <div style={{ marginTop: 6, fontSize: "var(--fs-md)", display: "grid", gap: 2 }}>
          <div>Last seen: {r.lastSeen ? runText(r.lastSeen) : "not recorded"}</div>
          {r.latest && <div>Latest run: {runText(r.latest)}</div>}
        </div>
        <div className="faint" style={{ fontSize: "var(--fs-sm)", marginTop: 6 }}>
          The test is kept as it is. It is not removed, closed or archived because it is missing. If the agent lists it again it is the same test.
        </div>
      </div>
    );
  }
  if (r.presence === "present") return <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>Still present in the latest audit run{r.latest ? ` (${runText(r.latest)})` : ""}.</div>;
  return <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>No later run available. {r.reason}</div>;
}

function DetailModal({ id, pid, onClose }: { id: number; pid: string; onClose: () => void }) {
  const canEdit = useCan("tester");
  const toast = useToast();
  const refresh = useRefresh(pid);
  const { data: t } = useQuery({ queryKey: ["manual-test", id], queryFn: () => api.get<Detail>(`/api/manual-tests/${id}`) });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: "", description: "", preconditions: "", steps: "", expected: "" });
  const [reqs, setReqs] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [deleting, setDeleting] = useState(false);
  const run = <T,>(fn: () => Promise<T>, ok?: string) => fn().then((r) => { refresh(); if (ok) toast("success", ok); return r; }).catch((e: Error) => { toast("error", e.message); });
  const post = (path: string, body?: unknown, ok?: string) => run(() => api.post(`/api/manual-tests/${id}/${path}`, body), ok);

  if (!t) return <Modal title="Agent proposal" onClose={onClose} width={820}><ListSkeleton rows={4} /></Modal>;
  const startEdit = () => {
    setDraft({ title: t.title, description: t.description, preconditions: t.preconditions, steps: t.steps.join("\n"), expected: t.expected });
    setEditing(true);
  };
  const save = () => run(() => api.patch(`/api/manual-tests/${id}`, { ...draft, steps: draft.steps.split("\n").map((s) => s.trim()).filter(Boolean) }), "Saved").then(() => setEditing(false));
  const unresolved = t.refs.filter((r) => r.state !== "resolved");
  const caseLink = proposalCaseLink(pid ?? "", t.testCase?.id);
  const field = (label: string, value: string) => value ? <div className="field"><div className="section-label">{label}</div><div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{value}</div></div> : null;
  const edited = !!t.editedAt;
  const reqRefs = t.refs.filter((r) => r.kind === "requirement");

  return (
    <Modal
      title={<span className="row" style={{ gap: 8 }}><span className="mono faint">{t.sourceId}</span><StatusChip status={t.status} /></span>}
      onClose={onClose}
      width={820}
      footer={<><Button needs="tester" variant="ghost" style={DANGER} onClick={() => setDeleting(true)}><Trash2 size={13} /> Delete</Button><span className="spacer" /><Button onClick={onClose}>Close</Button></>}
    >
      <div className="col" style={{ gap: 14 }}>
        {t.testCase ? (
          <div className="card" style={{ padding: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <ClipboardCheck size={15} />
            <span style={{ fontSize: "var(--fs-md)" }}>
              This is now the test case <Link to={caseLink!.to} state={caseLink!.state}><strong>{t.testCase.key}</strong></Link>. Run it in Runs; edit it there.
              {t.testCase.lastStatus ? ` Latest result: ${t.testCase.lastStatus}.` : " It has not been run yet."}
            </span>
            <span className="spacer" />
            <Link className={buttonClass("secondary", "sm")} to={caseLink!.to} state={caseLink!.state}>Open the test case</Link>
          </div>
        ) : (
          <div className="card" style={{ padding: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <UserCheck size={15} />
            <span style={{ fontSize: "var(--fs-md)" }} className="grow">
              {t.status === "proposed" ? "Proposed by a test agent. Review it first; a person has to run it." : t.status === "accepted" ? "Accepted. Create a test case from it to run it in Runs and have it count as coverage. Testbench does not run it or decide its result." : "Rejected. It is kept for reference and is not used."}
            </span>
            {t.status === "accepted" && <Button needs="tester" variant="primary" size="sm" onClick={() => run(() => api.post(`/api/manual-tests/${id}/create-case`), "Test case created. Run it in Runs.")}><ClipboardCheck size={13} /> Create test case</Button>}
          </div>
        )}

        {t.pendingUpdate && (
          <div className="card" style={{ padding: 12, borderColor: "var(--accent)" }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <strong>The agent sent a newer version (revision {t.pendingUpdate.rev})</strong>
              <span className="spacer" />
              <Button needs="tester" size="sm" onClick={() => post("ignore-update", undefined, "Kept your version")}>Keep mine</Button>
              <Button needs="tester" variant="primary" size="sm" onClick={() => post("apply-update", undefined, "Applied the agent's version")}>Use the agent's version</Button>
            </div>
            <div className="faint" style={{ fontSize: "var(--fs-sm)", margin: "6px 0" }}>Your edits, your review and your own priority are not changed until you choose. Applying replaces the text below with the agent's.</div>
            {t.pendingUpdate.changes.map((c) => (
              <div key={c.field} style={{ fontSize: "var(--fs-md)", marginTop: 6 }}>
                <span className="section-label" style={{ margin: 0 }}>{c.field}</span>
                <div style={{ color: "var(--failed-fg)", whiteSpace: "pre-wrap" }}>− {c.from || "(empty)"}</div>
                <div style={{ color: "var(--passed-fg)", whiteSpace: "pre-wrap" }}>+ {c.to || "(empty)"}</div>
              </div>
            ))}
          </div>
        )}

        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {t.status !== "accepted" && <Button needs="tester" variant="primary" onClick={() => post("review", { status: "accepted", note: note || undefined }, "Accepted. Nothing was run.")}><Check size={14} /> Accept</Button>}
          {t.status !== "rejected" && <Button needs="tester" onClick={() => post("review", { status: "rejected", note: note || undefined }, "Rejected")}>Reject</Button>}
          {t.status !== "proposed" && <Button needs="tester" variant="ghost" onClick={() => post("review", { status: "proposed" }, "Back to proposed")}>Reopen</Button>}
          <input className="input grow" aria-label="Review note" placeholder="Note about your decision (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {t.reviewNote && <div className="faint">Note: {t.reviewNote}{t.reviewedAt ? ` · ${timeAgo(t.reviewedAt)}` : ""}</div>}
        <Standing r={t.latestRun} />

        {/* The agent's priority and the person's are kept apart. */}
        <div className="card" style={{ padding: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
          <div><div className="section-label">Agent's priority</div><Severity value={t.priority.agent} /></div>
          <div>
            <label className="section-label" htmlFor="human-prio">Your priority</label>
            <select id="human-prio" className="select" disabled={!!t.testCase || !canEdit} value={t.priority.human ?? ""} onChange={(e) => run(() => api.patch(`/api/manual-tests/${id}`, { humanPriority: e.target.value || null }))}>
              <option value="">Not set (use the agent's)</option>
              {(["low", "medium", "high", "critical"] as const).map((s) => <option key={s} value={s}>{PRIORITY_LABEL[s]}</option>)}
            </select>
          </div>
          <div><div className="section-label">Used</div><span className="row" style={{ gap: 4 }}><PriorityIcon priority={t.priority.effective} size={13} /> {PRIORITY_LABEL[t.priority.effective]}</span></div>
        </div>

        {editing ? (
          <div className="col" style={{ gap: 8 }}>
            <input className="input" aria-label="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            <textarea className="textarea" aria-label="Description" rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Description" />
            <textarea className="textarea" aria-label="Preconditions" rows={2} value={draft.preconditions} onChange={(e) => setDraft({ ...draft, preconditions: e.target.value })} placeholder="Preconditions" />
            <textarea className="textarea" aria-label="Steps, one per line" rows={5} value={draft.steps} onChange={(e) => setDraft({ ...draft, steps: e.target.value })} placeholder="Steps, one per line" />
            <textarea className="textarea" aria-label="Expected result" rows={3} value={draft.expected} onChange={(e) => setDraft({ ...draft, expected: e.target.value })} placeholder="Expected result" />
            <div className="row"><Button needs="tester" variant="primary" disabled={!draft.title.trim() || !draft.expected.trim() || !draft.steps.trim()} onClick={save}>Save</Button><Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button></div>
          </div>
        ) : (
          <div className="col" style={{ gap: 10 }}>
            <div className="row"><h2 style={{ margin: 0, fontSize: "var(--fs-lg)", overflowWrap: "anywhere" }}>{t.title}</h2><span className="spacer" />{!t.testCase && <Button needs="tester" size="sm" onClick={startEdit}><Pencil size={12} /> Edit</Button>}</div>
            {edited && <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>You edited this {timeAgo(t.editedAt!)}. A later import will not overwrite it without asking.</div>}
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <span className="chip">{CATEGORY_LABEL[t.category]}</span>
              {t.wcag.map((c) => <span key={c} className="chip">WCAG {c}</span>)}
              {t.viewports.map((v, i) => <span key={i} className="chip">{formatViewport(v)}</span>)}
            </div>
            {field("Description", t.description)}
            {field("Preconditions", t.preconditions)}
            <div className="field"><div className="section-label">Steps</div><ol style={{ margin: 0, paddingLeft: 20 }}>{t.steps.map((s, i) => <li key={i} style={{ overflowWrap: "anywhere" }}>{s}</li>)}</ol></div>
            {field("Expected result", t.expected)}
          </div>
        )}
        {edited && t.agentVersion && (
          <details>
            <summary className="faint" style={{ cursor: "pointer" }}>What the agent wrote (separate from your version)</summary>
            <div style={{ fontSize: "var(--fs-md)", display: "grid", gap: 4, marginTop: 6 }}>
              <div><strong>Title:</strong> {t.agentVersion.title}</div>
              <div><strong>Steps:</strong><ol style={{ margin: "2px 0", paddingLeft: 20 }}>{t.agentVersion.steps.map((s, i) => <li key={i}>{s}</li>)}</ol></div>
              <div><strong>Expected:</strong> {t.agentVersion.expected}</div>
              <div><strong>Priority:</strong> {PRIORITY_LABEL[t.agentVersion.priority]}</div>
            </div>
          </details>
        )}

        <div className="field">
          <div className="section-label">Linked to {unresolved.length > 0 && <Button needs="tester" variant="ghost" size="sm" onClick={() => post("relink", undefined, "Checked again")}>Check again</Button>}</div>
          {t.refs.length === 0 ? <span className="faint">No requirements or test cases named.</span> : t.refs.map((r) => (
            <div key={r.id} className="row" style={{ gap: 8, padding: "2px 0", flexWrap: "wrap" }}>
              <span className="chip" style={r.state === "resolved" ? undefined : { color: "var(--blocked-fg)" }}>{r.state === "resolved" ? "linked" : r.state.replace("_", " ")}</span>
              {r.target?.kind === "case" ? <Link to={`/p/${pid}/cases?case=${r.target.id}`}>{r.label}</Link> : r.target?.kind === "requirement" ? <Link to={`/p/${pid}/requirements?req=${r.target.id}`}>{r.label}</Link> : <span>{r.label}</span>}
              {r.reason && <span className="faint">{r.reason}</span>}
            </div>
          ))}
          {t.testCase ? null : reqs === null ? (
            <Button needs="tester" size="sm" style={{ marginTop: 6 }} onClick={() => setReqs(reqRefs.map((r) => r.raw).join(", "))}>Edit requirements</Button>
          ) : (
            <div className="row" style={{ gap: 6, marginTop: 6 }}>
              <input className="input grow" aria-label="Requirements this test covers" placeholder="REQ-3, CHK-001" value={reqs} onChange={(e) => setReqs(e.target.value)} />
              <Button needs="tester" variant="primary" onClick={() => run(() => api.patch(`/api/manual-tests/${id}`, { requirements: reqs.split(/[,\s]+/).filter(Boolean) }), "Saved").then(() => setReqs(null))}>Save</Button>
              <Button variant="ghost" onClick={() => setReqs(null)}>Cancel</Button>
            </div>
          )}
        </div>

        <div className="field">
          <div className="section-label">Where it came from</div>
          <div className="faint" style={{ fontSize: "var(--fs-md)", display: "grid", gap: 2 }}>
            <div>Audit: {t.origin.title || t.originAuditId} <span className="mono">({t.originAuditId})</span>{!t.audit && " · the audit was deleted from Testbench; this test was kept"}</div>
            <div>Agent: {[t.origin.agent?.name, t.origin.agent?.version, t.origin.agent?.model].filter(Boolean).join(" · ") || "unknown"}</div>
            <div>Imported {timeAgo(t.importedAt)} via {t.origin.source ?? "?"}{t.origin.github ? ` (${t.origin.github.repo}#${t.origin.github.runId})` : ""} · agent's latest version received {timeAgo(t.agentUpdatedAt)}</div>
            {t.audit && <div>{RUN_STATE[t.audit.run_state] ?? t.audit.run_state}{t.audit.run_id ? <> · <Link to={`/p/${pid}/runs/${t.audit.run_id}`}>open run</Link></> : null}</div>}
            <div>{t.revisions.length} revision{t.revisions.length === 1 ? "" : "s"} received</div>
          </div>
        </div>
      </div>
      {deleting && (
        <ConfirmModal title="Delete this proposal?" confirmLabel="Delete proposal" onClose={() => setDeleting(false)}
          onConfirm={() => run(() => api.del(`/api/manual-tests/${id}${t.status === "accepted" ? "?force=1" : ""}`), "Deleted").then(() => { setDeleting(false); onClose(); })}>
          <p style={{ margin: 0 }}>This removes the proposal from Testbench{t.testCase ? `; the test case ${t.testCase.key} stays` : ""}. If the agent lists it again in a later package, it comes back as a new proposal.</p>
        </ConfirmModal>
      )}
    </Modal>
  );
}
