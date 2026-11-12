import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Download, FileCode, Pencil, Undo2, Wand2 } from "lucide-react";
import { api, formatDateTime } from "../api";
import { useToast } from "../components/ui";
import { Badge } from "../components/Badge";
import { Button, buttonClass } from "../components/Button";

type Status = "proposed" | "draft" | "approved" | "rejected" | "ignored";
interface Change { field: string; from: string; to: string }
interface HistoryEntry { rev: number; at: string; kind: string; actor: string; byRule: boolean; note: string; status: Status; changes: Change[] }
export interface Suggestion {
  id: number; sourceId: string; subjectKind: string; label: string; summary: string; steps: string[]; assertions: string[]; testData: string; plan: string; status: Status;
  editedBy: string | null; editedAt: string | null; decidedBy: string | null; decidedAt: string | null; subjectChanged: boolean; subjectGone: boolean;
  testCase: { id: number; number: number; key: string } | null; history: HistoryEntry[];
  /** A spec suggestion has a file name and its text in artifactText; once applied, the file can be downloaded. */
  artifactName: string | null; artifactText: string; isSpec: boolean; appliedAt: string | null; appliedBy: string | null;
}
interface Draft { summary: string; steps: string; assertions: string; testData: string; plan: string; artifactText: string }

const draftOf = (s: Suggestion): Draft => ({ summary: s.summary, steps: s.steps.join("\n"), assertions: s.assertions.join("\n"), testData: s.testData, plan: s.plan, artifactText: s.artifactText });
/** A spec suggestion is edited by its summary and its text; the others by all their fields. */
const bodyOf = (d: Draft, spec: boolean) => spec ? { summary: d.summary, artifactText: d.artifactText } : ({ summary: d.summary, testData: d.testData, plan: d.plan, steps: d.steps.split("\n").map((t) => t.trim()).filter(Boolean), assertions: d.assertions.split("\n").map((t) => t.trim()).filter(Boolean) });
const KIND: Record<string, string> = {
  suggested: "Suggested by rule", edited: "Edited", draft: "Saved as a draft", approved: "Approved", rejected: "Rejected", ignored: "Ignored",
  restored: "Put back to Suggested", applied: "Applied as a draft test case",
};

/** What a suggestion is, in words: the rule's suggestion that nobody has looked at, or a person's draft, approved, rejected or ignored one. Never only a colour. */
function Marks({ s }: { s: Suggestion }) {
  return (
    <>
      <Badge tone="accent" icon="eye" title="Made by a fixed rule from the plan item's own text. It is not an AI, and nobody has to accept it.">{s.label}</Badge>
      {s.isSpec && <Badge tone="neutral" icon="info" title="A Playwright spec made from a template. It starts with test.fixme and is not run by TestBench.">Playwright spec</Badge>}
      {s.isSpec && s.appliedAt && <Badge tone="info" icon="circle-check" title={s.appliedBy ? `Applied as a draft spec by ${s.appliedBy}` : "Applied as a draft spec"}>Draft spec</Badge>}
      {s.status === "draft" && <Badge tone="info" icon="circle" title="A person is working on this suggestion.">Draft</Badge>}
      {s.status === "approved" && <Badge tone="ok" icon="circle-check" title={s.decidedBy ? `Approved by ${s.decidedBy}` : "Approved"}>Approved</Badge>}
      {s.status === "rejected" && <Badge tone="neutral" icon="circle-x" title={s.decidedBy ? `Rejected by ${s.decidedBy}` : "Rejected"}>Rejected</Badge>}
      {s.status === "ignored" && <Badge tone="neutral" icon="eye-off" title={s.decidedBy ? `Put aside by ${s.decidedBy}` : "Put aside"}>Ignored</Badge>}
      {s.subjectChanged && <Badge tone="warn" icon="triangle-alert" title="What this was suggested for was changed after it was suggested, so the suggestion may be out of date.">{s.subjectKind === "requirement" ? "Requirement" : "Plan item"} {s.subjectGone ? "removed" : "changed since"}</Badge>}
    </>
  );
}

/**
 * Automation suggestions for one plan item or one requirement. Made by a fixed rule when a person asks; only an approved one gets a suggestion. A person edits, approves, rejects or ignores a suggestion,
 * and Apply makes a DRAFT test case of it. Nothing is generated or run, and nothing changes until a person clicks.
 */
export type Scope = { kind: "plan_item"; auditId: number; sourceId: string } | { kind: "requirement"; requirementId: number };
export function AutomationSuggestions({ pid, scope, itemStatus }: { pid: string; scope: Scope; itemStatus: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [message, setMessage] = useState("");
  const [showIgnored, setShowIgnored] = useState(false);
  const noun = scope.kind === "requirement" ? "requirement" : "plan item";
  const listUrl = scope.kind === "requirement" ? `/api/requirements/${scope.requirementId}/automation-suggestions` : `/api/audits/${scope.auditId}/automation-suggestions`;
  const askUrl = scope.kind === "requirement" ? listUrl : `/api/audits/${scope.auditId}/plan/items/${encodeURIComponent(scope.sourceId)}/automation-suggestions`;
  const { data } = useQuery({ queryKey: ["automation-suggestions", listUrl], queryFn: () => api.get<Suggestion[]>(listUrl) });
  const mine = (data ?? []).filter((s) => scope.kind === "requirement" || s.sourceId === scope.sourceId);
  const shown = mine.filter((s) => showIgnored || s.status !== "ignored");
  const ignored = mine.length - mine.filter((s) => s.status !== "ignored").length;

  const run = <T,>(fn: () => Promise<T>, ok: string) =>
    fn().then((r) => {
      for (const k of ["automation-suggestions", "audits", "cases", "requirement", "requirements"]) qc.invalidateQueries({ queryKey: [k] });
      if (ok) toast("success", ok);
      return r;
    }).catch((e: Error) => { toast("error", e.message); return null; });
  const specUrl = scope.kind === "plan_item" ? `/api/audits/${scope.auditId}/plan/items/${encodeURIComponent(scope.sourceId)}/spec-suggestions` : null;
  const ask = (url: string) => run(() => api.post<{ created: Suggestion[]; message: string }>(url, {}), "").then((r) => {
    if (!r) return;
    setMessage(r.message);
    if (r.created.length) toast("success", "A suggestion was made. It is only a suggestion: nothing is generated or run.");
  });
  const suggest = () => ask(askUrl);

  return (
    <section className="auto-suggestions" aria-label="Automation suggestions">
      <h4>Automation suggestions</h4>
      {itemStatus !== "approved"
        ? <p className="faint">Approve this {noun} to get an automation suggestion for it.</p>
        : (
          <div className="plan-actions">
            <Button needs="tester" size="sm" onClick={suggest}><Wand2 size={13} /> Suggest automation</Button>
            {specUrl && <Button needs="tester" size="sm" onClick={() => ask(specUrl)}><FileCode size={13} /> Suggest Playwright spec</Button>}
            <span className="faint plan-who">A fixed rule makes it from the {noun}'s {scope.kind === "requirement" ? "acceptance criteria" : "steps and acceptance criteria"}. Nothing is generated or run.</span>
          </div>
        )}
      {message && <p role="status" className="auto-message">{message}</p>}
      {itemStatus === "approved" && mine.length === 0 && !message && <p className="faint">No suggestion yet.</p>}
      {shown.map((s) => <SuggestionCard key={s.id} s={s} pid={pid} run={run} />)}
      {ignored > 0 && <Button variant="ghost" size="sm" aria-pressed={showIgnored} onClick={() => setShowIgnored(!showIgnored)}>{showIgnored ? "Hide" : "Show"} {ignored} ignored</Button>}
    </section>
  );
}

function SuggestionCard({ s, pid, run }: { s: Suggestion; pid: string; run: <T>(fn: () => Promise<T>, ok: string) => Promise<T | null> }) {
  const [editing, setEditing] = useState(false);
  const decide = (status: "draft" | "approved" | "rejected" | "ignored" | "proposed", ok: string) => run(() => api.post(`/api/automation-suggestions/${s.id}/decision`, { status }), ok);
  const apply = () => run(() => api.post<{ case?: { key: string }; spec?: { fileName: string } }>(`/api/automation-suggestions/${s.id}/apply`, {}), s.isSpec ? "Made a draft spec. It can now be downloaded. It is a draft: nothing is run, and finishing it is your decision." : "Made a draft test case. It is a draft: making it ready is your decision.");
  const copy = async () => { try { await navigator.clipboard.writeText(s.artifactText); } catch { /* the text is on screen: select it */ } };
  const who = s.status === "proposed" && !s.editedAt ? "Suggested by a rule. Nobody has reviewed it." : [s.editedBy && `Edited by ${s.editedBy}`, s.editedAt && formatDateTime(s.editedAt), s.decidedBy && (s.status === "approved" || s.status === "rejected" || s.status === "ignored") && `${s.status === "approved" ? "Approved" : s.status === "rejected" ? "Rejected" : "Ignored"} by ${s.decidedBy}`].filter(Boolean).join(" · ");
  const canApply = (s.isSpec ? !s.appliedAt : !s.testCase) && s.status !== "rejected" && s.status !== "ignored";
  return (
    <div className="card auto-card" data-suggestion={s.id}>
      <div className="plan-marks" style={{ marginLeft: 0 }}><Marks s={s} />{s.testCase && <Link className="chip" to={`/p/${pid}/cases?case=${s.testCase.id}`}>Draft test case {s.testCase.key}</Link>}</div>
      {editing ? (
        <SuggestionEditor s={s} onCancel={() => setEditing(false)} onSave={(d, decision) =>
          run(async () => { await api.patch(`/api/automation-suggestions/${s.id}`, bodyOf(d, s.isSpec)); if (decision) await api.post(`/api/automation-suggestions/${s.id}/decision`, { status: decision }); return true; },
            decision === "approved" ? "Approved" : decision === "rejected" ? "Rejected" : "Saved as a draft").then((r) => { if (r) setEditing(false); })} />
      ) : (
        <>
          <p className="auto-summary"><strong>{s.summary}</strong></p>
          {s.isSpec ? (
            <>
              <h5>Spec: {s.artifactName}</h5>
              <pre className="snippet auto-code" aria-label="Spec text" tabIndex={0}>{s.artifactText}</pre>
              {s.plan && <><h5>Plan</h5><p>{s.plan}</p></>}
            </>
          ) : (
            <>
              <h5>Steps</h5>
              <ol>{s.steps.map((t, i) => <li key={i}>{t}</li>)}</ol>
              {s.assertions.length > 0 && <><h5>Checks</h5><ul>{s.assertions.map((t, i) => <li key={i}>{t}</li>)}</ul></>}
              {s.testData && <><h5>Test data</h5><p>{s.testData}</p></>}
              {s.plan && <><h5>Plan</h5><p>{s.plan}</p></>}
            </>
          )}
          <div className="plan-actions">
            <Button needs="tester" size="sm" onClick={() => setEditing(true)}><Pencil size={13} /> Edit</Button>
            {s.status !== "approved" && <Button needs="tester" size="sm" onClick={() => decide("approved", "Approved")}><Check size={13} /> Approve</Button>}
            {s.status !== "rejected" && <Button needs="tester" size="sm" onClick={() => decide("rejected", "Rejected")}>Reject</Button>}
            {s.status !== "ignored" && <Button needs="tester" size="sm" variant="ghost" onClick={() => decide("ignored", "Ignored. It is hidden, and it is not made again.")}>Ignore</Button>}
            {s.status === "ignored" && <Button needs="tester" size="sm" onClick={() => decide("proposed", "Put back to Suggested")}><Undo2 size={13} /> Put back</Button>}
            {s.status !== "draft" && s.status !== "proposed" && <Button needs="tester" size="sm" variant="ghost" onClick={() => decide("draft", "Saved as a draft")}>Save as draft</Button>}
            {canApply && <Button needs="tester" size="sm" variant="primary" title={s.isSpec ? "Makes a draft spec that can be downloaded. It is never finished, run or approved by this." : "Makes a draft test case. It is never ready or approved by this."} onClick={apply}>{s.isSpec ? "Apply as draft spec" : "Apply as draft test case"}</Button>}
            {s.isSpec && s.appliedAt && s.status !== "rejected" && s.status !== "ignored" && <>
              <a className={buttonClass("secondary", "sm")} href={`/api/automation-suggestions/${s.id}/spec`} download={s.artifactName ?? undefined}><Download size={13} /> Download {s.artifactName}</a>
              <Button size="sm" variant="ghost" onClick={copy}><Copy size={13} /> Copy</Button>
            </>}
            <span className="faint plan-who">{who}</span>
          </div>
        </>
      )}
      <details className="auto-history">
        <summary>History ({s.history.length})</summary>
        <ol>
          {[...s.history].reverse().map((h) => (
            <li key={h.rev}>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <strong>{h.kind === "applied" && s.isSpec ? "Applied as a draft spec" : KIND[h.kind] ?? h.kind}</strong>
                {h.byRule ? <Badge tone="accent" icon="eye">Rule</Badge> : <span className="muted">by {h.actor}</span>}
                <span className="faint">{formatDateTime(h.at)}</span>
              </div>
              {h.note && <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>{h.note}</div>}
              {h.changes.map((c) => (
                <div key={c.field} style={{ fontSize: "var(--fs-sm)", marginTop: 4 }}>
                  <span className="section-label" style={{ margin: 0 }}>{c.field}</span>
                  <div className="plan-del">− {c.from || "(empty)"}</div>
                  <div className="plan-add">+ {c.to || "(empty)"}</div>
                </div>
              ))}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

function SuggestionEditor({ s, onSave, onCancel }: { s: Suggestion; onSave: (d: Draft, decision?: "approved" | "rejected") => void; onCancel: () => void }) {
  const [d, setD] = useState<Draft>(() => draftOf(s));
  const f = (k: keyof Draft, label: string, area = false) => (
    <div className="field">
      <label htmlFor={`as-${s.id}-${k}`}>{label}</label>
      {area ? <textarea id={`as-${s.id}-${k}`} className={k === "artifactText" ? "textarea auto-code-input" : "textarea"} value={d[k]} onChange={(e) => setD({ ...d, [k]: e.target.value })} /> : <input id={`as-${s.id}-${k}`} className="input" value={d[k]} onChange={(e) => setD({ ...d, [k]: e.target.value })} />}
    </div>
  );
  const ok = !!d.summary.trim() && (s.isSpec ? !!d.artifactText.trim() : d.steps.split("\n").some((t) => t.trim()));
  return (
    <div className="col" style={{ gap: 10, marginTop: 6 }}>
      {s.isSpec
        ? <>{f("summary", "Summary")}{f("artifactText", `Spec text (${s.artifactName})`, true)}</>
        : <>{f("summary", "Summary")}{f("steps", "Steps (one per line)", true)}{f("assertions", "Checks (one per line)", true)}{f("testData", "Test data", true)}{f("plan", "Plan", true)}</>}
      <div className="plan-actions">
        <Button needs="tester" variant="primary" size="sm" disabled={!ok} onClick={() => onSave(d)}>Save draft</Button>
        <Button needs="tester" size="sm" disabled={!ok} onClick={() => onSave(d, "approved")}><Check size={13} /> Approve</Button>
        <Button needs="tester" size="sm" disabled={!ok} onClick={() => onSave(d, "rejected")}>Reject</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
