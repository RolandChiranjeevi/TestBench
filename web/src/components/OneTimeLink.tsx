import { useState } from "react";
import { Check, Copy, ShieldAlert } from "lucide-react";
import { Button } from "./Button";
import { useToast } from "./ui";

/**
 * A link that the server shows only once (an invitation, a password reset): the text to say what it is for, the link itself, and a button to copy it.
 * The link lives in the component that holds it and nowhere else: not in the query cache, not in storage. `onDone` clears it.
 */
export function OneTimeLink({ what, url, doneLabel, onDone }: { what: string; url: string; doneLabel: string; onDone: () => void }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); } catch { toast("error", "Could not copy. Select the link and copy it by hand."); }
  };
  return (
    <div role="status" className="card" style={{ padding: 12, background: "var(--bg)", borderColor: "var(--blocked-fg)" }}>
      <div className="row" style={{ gap: 8, alignItems: "flex-start", color: "var(--blocked-fg)" }}>
        <ShieldAlert size={16} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
        <span style={{ color: "var(--text-2)" }}>{what} Copy it now: it is not shown again, and anyone who has it can use it once.</span>
      </div>
      <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <code className="inline mono" style={{ wordBreak: "break-all", userSelect: "all" }}>{url}</code>
        <Button size="sm" onClick={copy}>{copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}</Button>
        <Button variant="ghost" size="sm" onClick={onDone}>{doneLabel}</Button>
      </div>
    </div>
  );
}
