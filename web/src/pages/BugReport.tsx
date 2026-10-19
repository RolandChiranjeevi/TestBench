import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Download, ExternalLink, Link2, Paperclip } from "lucide-react";
import { api, type ResultDetail } from "../api";
import { Modal, useToast } from "../components/ui";

/** Show a linked Jira issue as its key, whether a key or a full URL was saved. */
export const jiraLabel = (v: string) => v.match(/[A-Za-z][A-Za-z0-9_]*-\d+/g)?.at(-1)?.toUpperCase() ?? v;
export const jiraUrl = (v: string) => (/^https?:\/\//.test(v) ? v : null);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const paragraphs = (s: string) => esc(s).replace(/\n/g, "<br>");

interface Fields { summary: string; expected: string; actual: string; notes: string }
interface Context {
  caseId: string;
  caseTitle: string;
  environment: string;
  preconditions: string;
  steps: { action: string; fails: boolean }[];
}

/** Plain text, used when the clipboard (or the receiving editor) can't take rich text. */
function toText(f: Fields, c: Context): string {
  const out = [`Environment: ${c.environment}`, `Test case: ${c.caseId} ${c.caseTitle}`, ""];
  if (c.preconditions) out.push("Preconditions:", c.preconditions, "");
  out.push("Steps to reproduce:", ...c.steps.map((s, i) => `${i + 1}. ${s.action}${s.fails ? "  <- fails here" : ""}`), "");
  if (f.expected) out.push("Expected result:", f.expected, "");
  if (f.actual) out.push("Actual result:", f.actual, "");
  if (f.notes) out.push("Notes:", f.notes, "");
  return out.join("\n").trim();
}

/** Rich text for pasting into Jira's editor: bold labels and a real numbered list. */
function toHtml(f: Fields, c: Context): string {
  const section = (label: string, body: string) => (body ? `<p><strong>${label}</strong><br>${paragraphs(body)}</p>` : "");
  return [
    `<p><strong>Environment:</strong> ${esc(c.environment)}<br><strong>Test case:</strong> ${esc(c.caseId)} ${esc(c.caseTitle)}</p>`,
    section("Preconditions", c.preconditions),
    `<p><strong>Steps to reproduce</strong></p>`,
    `<ol>${c.steps.map((s) => `<li>${esc(s.action)}${s.fails ? " <strong>(fails here)</strong>" : ""}</li>`).join("")}</ol>`,
    section("Expected result", f.expected),
    section("Actual result", f.actual),
    section("Notes", f.notes),
  ].join("");
}

async function copy(text: string, html?: string) {
  if (html && typeof ClipboardItem !== "undefined") {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
      return;
    } catch {
      /* fall back to plain text below */
    }
  }
  await navigator.clipboard.writeText(text);
}

/**
 * A ready-to-paste bug report for a failed or blocked manual result.
 * Built from the case as it was when the run started, so it matches what was executed.
 */
export function BugReportModal({ result, projectKey, run, onClose }: {
  result: ResultDetail;
  projectKey: string;
  run: { title: string; environment: string; milestone: string };
  onClose: () => void;
}) {
  const { runId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const c = result.case!;

  const marked = c.steps.map((s) => ({ s, sr: result.stepResults.find((x) => x.step_id === s.id) }));
  const firstFail = marked.find((m) => m.sr && (m.sr.status === "failed" || m.sr.status === "blocked"));
  const caseId = `${projectKey}-${c.number}`;

  const [fields, setFields] = useState<Fields>({
    summary: `[${caseId}] ${c.title}`,
    expected: firstFail?.s.expected ?? c.steps.at(-1)?.expected ?? "",
    actual: firstFail?.sr?.actual ?? "",
    notes: result.notes,
  });
  const [copied, setCopied] = useState<"summary" | "description" | null>(null);
  const [issue, setIssue] = useState(result.jira_key ?? "");

  const ctx: Context = {
    caseId,
    caseTitle: c.title,
    environment: [run.environment, run.milestone, `Run: ${run.title}`].filter(Boolean).join(" · "),
    preconditions: c.preconditions,
    steps: marked.map((m) => ({ action: m.s.action, fails: m === firstFail })),
  };
  const html = toHtml(fields, ctx);
  const set = (k: keyof Fields) => (e: { target: { value: string } }) => setFields((f) => ({ ...f, [k]: e.target.value }));

  const doCopy = async (what: "summary" | "description") => {
    try {
      if (what === "summary") await copy(fields.summary);
      else await copy(toText(fields, ctx), html);
      setCopied(what);
      setTimeout(() => setCopied((cur) => (cur === what ? null : cur)), 2000);
    } catch {
      toast("error", "Couldn't copy. Select the text and copy it manually.");
    }
  };

  const saveIssue = useMutation({
    mutationFn: () => api.patch<{ jira_key: string | null }>(`/api/results/${result.id}`, { jiraKey: issue.trim() }),
    onSuccess: (saved) => {
      setIssue(saved.jira_key ?? ""); // show the normalised value (proj-1 -> PROJ-1)
      qc.invalidateQueries({ queryKey: ["result", result.id] });
      qc.invalidateQueries({ queryKey: ["run", runId] });
      toast("success", saved.jira_key ? `Linked ${jiraLabel(saved.jira_key)}` : "Link removed");
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const saved = result.jira_key ?? "";
  const link = jiraUrl(saved);
  const attachments = result.attachments.length;

  return (
    <Modal title="Report bug" onClose={onClose} width={760} footer={<button className="btn" onClick={onClose}>Done</button>}>
      <div className="muted" style={{ fontSize: 12.5, marginTop: -4 }}>
        Edit the draft, copy it into a new Jira issue, then paste the issue key back here to link it.
      </div>

      <div className="field">
        <label htmlFor="bug-summary">Summary</label>
        <div className="row">
          <input id="bug-summary" className="input" value={fields.summary} onChange={set("summary")} />
          <button className="btn" onClick={() => doCopy("summary")}>{copied === "summary" ? <Check size={13} /> : <Copy size={13} />} Copy</button>
        </div>
      </div>

      <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
        <div className="field grow">
          <label htmlFor="bug-expected">Expected result</label>
          <textarea id="bug-expected" className="textarea" rows={3} value={fields.expected} onChange={set("expected")} />
        </div>
        <div className="field grow">
          <label htmlFor="bug-actual">Actual result</label>
          <textarea id="bug-actual" className="textarea" rows={3} value={fields.actual} onChange={set("actual")} placeholder="What happened instead?" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="bug-notes">Notes</label>
        <textarea id="bug-notes" className="textarea" rows={2} value={fields.notes} onChange={set("notes")} />
      </div>

      <div className="field">
        <div className="row">
          <label style={{ fontSize: 12, color: "var(--text-3)", fontWeight: 500 }}>Description preview</label>
          <span className="spacer" />
          <button className="btn primary sm" onClick={() => doCopy("description")}>
            {copied === "description" ? <Check size={13} /> : <Copy size={13} />} Copy description
          </button>
        </div>
        {/* The HTML is built from escaped text above, so it is safe to render. */}
        <div
          className="card"
          style={{ padding: "10px 14px", maxHeight: 220, overflow: "auto", fontSize: 13, lineHeight: 1.55 }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>

      <div className="card" style={{ padding: 12, display: "flex", alignItems: "center", gap: 10 }}>
        <Paperclip size={15} className="faint" />
        <div className="grow">
          <div style={{ fontWeight: 500 }}>{attachments} {attachments === 1 ? "attachment" : "attachments"}</div>
          <div className="faint" style={{ fontSize: 12 }}>
            {attachments ? "Browsers can't paste several files at once. Download them and drag them into the Jira issue." : "Add screenshots on the result first (drop, browse, or paste with ⌘V)."}
          </div>
        </div>
        {attachments > 0 && (
          <a className="btn" href={`/api/results/${result.id}/attachments.zip`}><Download size={13} /> Download .zip</a>
        )}
      </div>

      <div className="field">
        <label htmlFor="bug-issue"><Link2 size={11} style={{ verticalAlign: -1 }} /> Linked Jira issue</label>
        <div className="row">
          <input
            id="bug-issue"
            className="input"
            placeholder="PROJ-123 or the issue link"
            value={issue}
            onChange={(e) => setIssue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && issue.trim() !== saved && saveIssue.mutate()}
          />
          <button className="btn" disabled={issue.trim() === saved || saveIssue.isPending} onClick={() => saveIssue.mutate()}>Save</button>
          {link && <a className="btn ghost icon" href={link} target="_blank" rel="noreferrer" aria-label="Open issue"><ExternalLink size={14} /></a>}
        </div>
      </div>
    </Modal>
  );
}
