import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Download, ExternalLink, Link2, Paperclip, Send } from "lucide-react";
import { api, type AutomatedResultDetail, type ResultDetail } from "../api";
import { Modal, useToast } from "../components/ui";

/** Show a linked Jira issue as its key, whether a key or a full URL was saved. */
export const jiraLabel = (v: string) => v.match(/[A-Za-z][A-Za-z0-9_]*-\d+/g)?.at(-1)?.toUpperCase() ?? v;
export const jiraUrl = (v: string) => (/^https?:\/\//.test(v) ? v : null);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const paragraphs = (s: string) => esc(s).replace(/\n/g, "<br>");

interface Fields { summary: string; expected: string; actual: string; notes: string }
interface Context {
  /** Label/value pairs at the top, e.g. Environment, Test case. */
  facts: [string, string][];
  preconditions?: string;
  stepsTitle: string;
  steps: { action: string; fails: boolean }[];
  /** Monospaced output such as an error message. */
  blocks: { label: string; text: string }[];
}
interface Draft { fields: Fields; ctx: Context }

/** Plain text, used when the clipboard (or the receiving editor) can't take rich text. */
function toText(f: Fields, c: Context): string {
  const out: string[] = [...c.facts.map(([k, v]) => `${k}: ${v}`), ""];
  if (c.preconditions) out.push("Preconditions:", c.preconditions, "");
  out.push(`${c.stepsTitle}:`, ...c.steps.map((s, i) => `${i + 1}. ${s.action}${s.fails ? "  <- fails here" : ""}`), "");
  if (f.expected) out.push("Expected result:", f.expected, "");
  if (f.actual) out.push("Actual result:", f.actual, "");
  for (const b of c.blocks) out.push(`${b.label}:`, ...b.text.split("\n").map((l) => `    ${l}`), "");
  if (f.notes) out.push("Notes:", f.notes, "");
  return out.join("\n").trim();
}

/** Markdown for Linear, whose description field renders it. */
function toMarkdown(f: Fields, c: Context): string {
  const out: string[] = [...c.facts.map(([k, v]) => `**${k}:** ${v}`), ""];
  if (c.preconditions) out.push("**Preconditions**", c.preconditions, "");
  out.push(`**${c.stepsTitle}**`, ...c.steps.map((s, i) => `${i + 1}. ${s.action}${s.fails ? " **(fails here)**" : ""}`), "");
  if (f.expected) out.push("**Expected result**", f.expected, "");
  if (f.actual) out.push("**Actual result**", f.actual, "");
  for (const b of c.blocks) {
    const fence = b.text.includes("```") ? "~~~~" : "```";
    out.push(`**${b.label}**`, fence, b.text, fence, "");
  }
  if (f.notes) out.push("**Notes**", f.notes, "");
  return out.join("\n").trim();
}

interface LinearStatus { enabled: boolean; teams: { id: string; key: string; name: string }[]; defaultTeam: string | null; error?: string }

/** Rich text for pasting into Jira's editor: bold labels, a real numbered list and code blocks. */
function toHtml(f: Fields, c: Context): string {
  const section = (label: string, body: string) => (body ? `<p><strong>${label}</strong><br>${paragraphs(body)}</p>` : "");
  return [
    `<p>${c.facts.map(([k, v]) => `<strong>${esc(k)}:</strong> ${esc(v)}`).join("<br>")}</p>`,
    section("Preconditions", c.preconditions ?? ""),
    `<p><strong>${esc(c.stepsTitle)}</strong></p>`,
    `<ol>${c.steps.map((s) => `<li>${esc(s.action)}${s.fails ? " <strong>(fails here)</strong>" : ""}</li>`).join("")}</ol>`,
    section("Expected result", f.expected),
    section("Actual result", f.actual),
    ...c.blocks.map((b) => `<p><strong>${esc(b.label)}</strong></p><pre>${esc(b.text)}</pre>`),
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

/** The Jira create-issue form shows a title without our "@SHOP-1" test tags. */
const stripTags = (s: string) => s.replace(/(^|\s)@[\w-]+/g, " ").replace(/\s+/g, " ").trim();

// ---------- Drafts ----------

function manualDraft(result: ResultDetail, projectKey: string, run: { title: string; environment: string; milestone: string }): Draft {
  const c = result.case!;
  const marked = c.steps.map((s) => ({ s, sr: result.stepResults.find((x) => x.step_id === s.id) }));
  const firstFail = marked.find((m) => m.sr && (m.sr.status === "failed" || m.sr.status === "blocked"));
  const caseId = `${projectKey}-${c.number}`;
  return {
    fields: {
      summary: `[${caseId}] ${c.title}`,
      expected: firstFail?.s.expected ?? c.steps.at(-1)?.expected ?? "",
      actual: firstFail?.sr?.actual ?? "",
      notes: result.notes,
    },
    ctx: {
      facts: [
        ["Environment", [run.environment, run.milestone, `Run: ${run.title}`].filter(Boolean).join(" · ")],
        ["Test case", `${caseId} ${c.title}`],
        ...((c.requirements ?? []).length ? [["Requirements", c.requirements.map((r) => `REQ-${r.number} ${r.title}`).join("; ")] as [string, string]] : []),
      ],
      preconditions: c.preconditions,
      stepsTitle: "Steps to reproduce",
      steps: marked.map((m) => ({ action: m.s.action, fails: m === firstFail })),
      blocks: [],
    },
  };
}

function automatedDraft(d: AutomatedResultDetail): Draft {
  const attempts = d.detail?.attempts ?? [];
  const failing = [...attempts].reverse().find((a) => a.status !== "passed" && a.status !== "skipped");
  const err = failing?.errors[0];
  const loc = err?.location ?? d.detail?.location;
  const title = stripTags(d.test_title ?? "Automated test");
  const caseId = d.case_number ? `${d.project_key}-${d.case_number}` : null;
  const meta = d.meta as { url?: string; branch?: string; sha?: string };
  const firstLine = (err?.message ?? d.error).split("\n").find((l) => l.trim()) ?? "";

  const failedCount = attempts.filter((a) => a.status !== "passed" && a.status !== "skipped").length;
  const notes =
    d.flaky && attempts.length > 1
      ? `Flaky: failed ${failedCount} of ${attempts.length} attempts, passed on retry.`
      : attempts.length > 1
        ? `Failed on all ${attempts.length} attempts (${attempts.length - 1} ${attempts.length === 2 ? "retry" : "retries"}).`
        : "";

  const facts: [string, string][] = [
    ["Environment", [d.environment, d.milestone, `Run: ${d.run_title}`].filter(Boolean).join(" · ")],
    ["Test", caseId ? `${caseId} ${title}` : title],
    ["File", loc ? `${loc.file}:${loc.line}` : (d.test_file ?? "")],
  ];
  if (d.detail?.projectName) facts.push(["Browser / project", d.detail.projectName]);
  if (meta.branch) facts.push(["Branch", `${meta.branch}${meta.sha ? ` @ ${meta.sha.slice(0, 7)}` : ""}`]);
  if (meta.url) facts.push(["CI run", meta.url]);

  return {
    fields: {
      summary: caseId ? `[${caseId}] ${title}` : `Automated test failing: ${title}`,
      expected: "",
      actual: firstLine.length > 240 ? firstLine.slice(0, 239) + "…" : firstLine,
      notes,
    },
    ctx: {
      facts: facts.filter(([, v]) => v),
      stepsTitle: "How to reproduce",
      steps: [{ action: `Run the Playwright test "${title}"${d.test_file ? ` (${d.test_file})` : ""}`, fails: false }, ...(loc ? [{ action: `It fails at ${loc.file}:${loc.line}`, fails: true }] : [])],
      blocks: err ? [{ label: "Error output", text: err.message.length > 3000 ? err.message.slice(0, 3000) + "\n…" : err.message }] : [],
    },
  };
}

// ---------- Dialog ----------

function BugReportDialog({ draft, resultId, jiraKey, attachmentCount, attachmentHint, onClose }: {
  draft: Draft;
  resultId: number;
  jiraKey: string | null;
  attachmentCount: number;
  attachmentHint?: string;
  onClose: () => void;
}) {
  const { runId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [fields, setFields] = useState<Fields>(draft.fields);
  const [copied, setCopied] = useState<"summary" | "description" | null>(null);
  const [issue, setIssue] = useState(jiraKey ?? "");

  const html = toHtml(fields, draft.ctx);
  const set = (k: keyof Fields) => (e: { target: { value: string } }) => setFields((f) => ({ ...f, [k]: e.target.value }));

  const doCopy = async (what: "summary" | "description") => {
    try {
      if (what === "summary") await copy(fields.summary);
      else await copy(toText(fields, draft.ctx), html);
      setCopied(what);
      setTimeout(() => setCopied((cur) => (cur === what ? null : cur)), 2000);
    } catch {
      toast("error", "Couldn't copy. Select the text and copy it manually.");
    }
  };

  const saveIssue = useMutation({
    mutationFn: () => api.patch<{ jira_key: string | null }>(`/api/results/${resultId}`, { jiraKey: issue.trim() }),
    onSuccess: (saved) => {
      setIssue(saved.jira_key ?? ""); // show the normalised value (proj-1 -> PROJ-1)
      for (const k of [["result", resultId], ["automated-result", resultId], ["run", runId]]) qc.invalidateQueries({ queryKey: k });
      toast("success", saved.jira_key ? `Linked ${jiraLabel(saved.jira_key)}` : "Link removed");
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const saved = jiraKey ?? "";
  const link = jiraUrl(saved);

  // Optional Linear connection: the server creates the issue (LINEAR_API_KEY) and keeps its link on the result.
  const { data: linear } = useQuery({ queryKey: ["linear-status"], queryFn: () => api.get<LinearStatus>("/api/linear/status"), staleTime: 60_000 });
  const [team, setTeam] = useState("");
  const teamId = team || linear?.defaultTeam || "";
  const createLinear = useMutation({
    mutationFn: () =>
      api.post<{ identifier: string; url: string }>(`/api/results/${resultId}/linear-issue`, {
        title: fields.summary.trim(),
        description: toMarkdown(fields, draft.ctx),
        ...(teamId ? { teamId } : {}),
      }),
    onSuccess: (r) => {
      setIssue(r.url);
      for (const k of [["result", resultId], ["automated-result", resultId], ["run", runId]]) qc.invalidateQueries({ queryKey: k });
      toast("success", `Created ${r.identifier} in Linear`);
    },
    onError: (e: Error) => toast("error", e.message),
  });

  return (
    <Modal title="Report bug" onClose={onClose} width={760} footer={<button className="btn" onClick={onClose}>Done</button>}>
      <div className="muted" style={{ fontSize: "var(--fs-md)", marginTop: -4 }}>
        Edit the draft, then {linear?.enabled ? "create the issue in Linear, or " : ""}copy it into a new Jira issue and paste the issue key back here to link it.
      </div>

      <div className="field">
        <label htmlFor="bug-summary">Summary</label>
        <div className="row">
          <input id="bug-summary" className="input" value={fields.summary} onChange={set("summary")} />
          <button className="btn" onClick={() => doCopy("summary")}>{copied === "summary" ? <Check size={13} /> : <Copy size={13} />} Copy</button>
        </div>
      </div>

      <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
        <div className="field grow">
          <label htmlFor="bug-expected">Expected result</label>
          <textarea id="bug-expected" className="textarea" rows={3} value={fields.expected} onChange={set("expected")} placeholder="What should happen?" />
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
          <label style={{ fontSize: "var(--fs-sm)", color: "var(--text-3)", fontWeight: 500 }}>Description preview</label>
          <span className="spacer" />
          <button className="btn primary sm" onClick={() => doCopy("description")}>
            {copied === "description" ? <Check size={13} /> : <Copy size={13} />} Copy description
          </button>
        </div>
        {/* The HTML is built from escaped text above, so it is safe to render. */}
        <div
          className="card"
          style={{ padding: "12px 16px", maxHeight: 220, overflow: "auto", fontSize: "var(--fs-md)", lineHeight: 1.55 }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>

      <div className="card" style={{ padding: 12, display: "flex", alignItems: "center", gap: 12 }}>
        <Paperclip size={15} className="faint" />
        <div className="grow">
          <div style={{ fontWeight: 500 }}>{attachmentCount} {attachmentCount === 1 ? "attachment" : "attachments"}</div>
          <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>
            {attachmentCount
              ? "Browsers can't paste several files at once. Download them and drag them into the Jira issue."
              : (attachmentHint ?? "Add screenshots on the result first (drop, browse, or paste with ⌘V).")}
          </div>
        </div>
        {attachmentCount > 0 && (
          <a className="btn" href={`/api/results/${resultId}/attachments.zip`}><Download size={13} /> Download .zip</a>
        )}
      </div>

      {linear?.enabled && (
        <div className="card" style={{ padding: 12, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Send size={15} className="faint" />
          <div className="grow" style={{ minWidth: 180 }}>
            <div style={{ fontWeight: 500 }}>Create in Linear</div>
            <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>
              {linear.error ? linear.error : saved ? `Already linked to ${jiraLabel(saved)}. Remove the link below to create a new issue.` : "Creates the issue with this draft and links it here."}
            </div>
          </div>
          {linear.teams.length > 1 && (
            <select className="input" style={{ width: "auto" }} aria-label="Linear team" value={teamId} onChange={(e) => setTeam(e.target.value)}>
              <option value="">Choose team…</option>
              {linear.teams.map((t) => <option key={t.id} value={t.id}>{t.key} · {t.name}</option>)}
            </select>
          )}
          <button
            className="btn primary"
            disabled={!!saved || !fields.summary.trim() || createLinear.isPending || !!linear.error || (linear.teams.length > 1 && !teamId)}
            onClick={() => createLinear.mutate()}
          >
            {createLinear.isPending ? "Creating…" : "Create issue"}
          </button>
        </div>
      )}

      <div className="field">
        <label htmlFor="bug-issue"><Link2 size={11} style={{ verticalAlign: -1 }} /> Linked issue (Jira or Linear)</label>
        <div className="row">
          <input
            id="bug-issue"
            className="input"
            placeholder="PROJ-123 or the issue link (Jira or Linear)"
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

/** A ready-to-paste bug report for a failed or blocked manual result, built from the case as it was when the run started. */
export function BugReportModal({ result, projectKey, run, onClose }: {
  result: ResultDetail;
  projectKey: string;
  run: { title: string; environment: string; milestone: string };
  onClose: () => void;
}) {
  const [draft] = useState(() => manualDraft(result, projectKey, run));
  return <BugReportDialog draft={draft} resultId={result.id} jiraKey={result.jira_key} attachmentCount={result.attachments.length} onClose={onClose} />;
}

/** The same for a failed automated test: error output, location, CI run and branch come from the imported report. */
export function AutomatedBugReportModal({ detail, onClose }: { detail: AutomatedResultDetail; onClose: () => void }) {
  const [draft] = useState(() => automatedDraft(detail));
  return (
    <BugReportDialog
      draft={draft}
      resultId={detail.id}
      jiraKey={detail.jira_key}
      attachmentCount={detail.attachments.length}
      attachmentHint="No screenshots, videos or traces were imported for this test. Import the artifact with test-results/ included."
      onClose={onClose}
    />
  );
}
