import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Lightbulb, Pencil, X } from "lucide-react";
import { api, KIND_LABEL, timeAgo, type DisplayName, type Priority, type ProposalList, type ProposalStatus, type RequirementKind, type RequirementProposal } from "../api";
import { Empty, ListSkeleton, Modal, PriorityIcon, PRIORITY_LABEL, useConfirm, useToast } from "../components/ui";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { FilterChip } from "../components/FilterChip";
import { ProposalBadge, RecordedAs } from "../components/RequirementBits";

type View = ProposalStatus | "all";
const VIEW_LABEL: Record<View, string> = { proposed: "Needs review", approved: "Approved", rejected: "Rejected", all: "All" };
const BASIS_LABEL: Record<RequirementProposal["basis"], string> = { observation: "an observation", coverage_gap: "a coverage gap", prompt: "a prompt", other: "the agent's own analysis" };
const when = (s: string | null) => (s ? timeAgo(s.replace(" ", "T") + "Z") : "");

/**
 * What a test agent suggests as new requirements. A proposal is not a requirement: it is kept apart, it is not in the requirement list or in coverage, and
 * nothing changes until a person approves it. Rejected ones stay, with the reason. A decided proposal cannot be changed.
 */
export function RequirementProposalsTab() {
  const { pid } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [view, setView] = useState<View>("proposed");
  const [editing, setEditing] = useState<RequirementProposal | null>(null);
  const [rejecting, setRejecting] = useState<RequirementProposal | null>(null);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["requirement-proposals", pid, view],
    queryFn: () => api.get<ProposalList>(`/api/projects/${pid}/requirement-proposals${view === "all" ? "" : `?status=${view}`}`),
  });
  const { data: me } = useQuery({ queryKey: ["display-name"], queryFn: () => api.get<DisplayName>("/api/settings/display-name"), staleTime: 60_000 });
  const refresh = () => {
    for (const key of [["requirement-proposals", pid], ["requirements", pid], ["requirement-coverage", pid], ["coverage-gaps", pid], ["dashboard", pid]]) qc.invalidateQueries({ queryKey: key });
  };
  const approve = useMutation({
    mutationFn: (p: RequirementProposal) => api.post<{ requirementId: number; proposal: RequirementProposal }>(`/api/requirement-proposals/${p.id}/approve`),
    onSuccess: (r) => { refresh(); toast("success", `Approved. It is now ${r.proposal.requirementLabel ?? "a requirement"}.`); },
    onError: (e: Error) => toast("error", e.message),
  });
  const ask = async (p: RequirementProposal) => {
    const ok = await confirm({
      title: "Approve this proposal?",
      body: (
        <div className="col" style={{ gap: 8 }}>
          <p style={{ margin: 0 }}>“{p.title}” becomes an approved requirement, marked as AI-suggested, and it counts in coverage from now on.</p>
          <p className="muted" style={{ margin: 0 }}>It is recorded as approved by <b>{me?.recordedAs ?? "you"}</b>{me?.source === "account" ? " (your account)" : me?.name ? ", as typed" : " (no name is set in Settings)"}. Test cases linked to the proposal are linked to the requirement.</p>
        </div>
      ),
      confirmLabel: "Approve",
      tone: "primary",
    });
    if (ok) approve.mutate(p);
  };

  const counts = data?.counts;
  const total = counts ? counts.proposed + counts.approved + counts.rejected : 0;
  return (
    <div className="col" style={{ gap: 12, padding: "16px 20px", maxWidth: 960 }}>
      <p className="muted" style={{ margin: 0 }}>
        Suggested by a test agent. <strong>A proposal is not a requirement</strong>: nothing changes until you approve it, and nothing here was written by a person. Rejected proposals are kept with the reason.
      </p>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }} role="group" aria-label="Proposals">
        {(["proposed", "approved", "rejected", "all"] as const).map((v) => (
          <FilterChip key={v} pressed={view === v} count={v === "all" ? total : counts?.[v] ?? 0} onClick={() => setView(v)}>{VIEW_LABEL[v]}</FilterChip>
        ))}
      </div>
      {isLoading ? <ListSkeleton rows={3} /> : isError || !data ? (
        <Empty icon={<Lightbulb size={20} />} title="Could not load the proposals">{(error as Error | null)?.message}</Empty>
      ) : data.items.length === 0 ? (
        <Empty icon={<Lightbulb size={20} />} title={view === "proposed" ? "Nothing waiting for review" : "No proposals here"}>
          {total === 0
            ? "A test agent with a proposal token can suggest requirements. Switch that on under Settings, Agent access. Until then this stays empty."
            : "Change the filter to see the others."}
        </Empty>
      ) : (
        data.items.map((p) => (
          <article key={p.id} className="card" aria-label={p.title}>
            <div className="card-header" style={{ gap: 8, flexWrap: "wrap" }}>
              <strong style={{ flex: "1 1 280px" }}>{p.title}</strong>
              {p.status === "proposed" && <ProposalBadge />}
              {p.status === "approved" && <Badge tone="ok" icon="circle-check">Approved</Badge>}
              {p.status === "rejected" && <Badge tone="neutral" icon="circle-x">Rejected</Badge>}
              {p.edited && <span className="chip" title="A person changed it before deciding. The agent's version is kept.">Edited</span>}
            </div>
            <div className="card-body col" style={{ gap: 10 }}>
              <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                <span className="muted" title="Suggested priority"><PriorityIcon priority={p.suggestedPriority} /> {PRIORITY_LABEL[p.suggestedPriority]}</span>
                <span className="chip">{KIND_LABEL[p.kind]}</span>
                <span className="faint">
                  {p.proposedBy.startsWith("rule:")
                    ? <>Generated by {p.proposedBy} {when(p.createdAt)}, from {BASIS_LABEL[p.basis]}. Fixed rules, not an AI model.</>
                    : <>Proposed by {p.proposedBy || "an agent"} {when(p.createdAt)}, based on {BASIS_LABEL[p.basis]}</>}
                </span>
              </div>
              {p.description && <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{p.description}</p>}
              {p.acceptanceCriteria.trim() && (
                <div>
                  <div className="section-label">Acceptance criteria</div>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                    {p.acceptanceCriteria.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, "").trim()).filter(Boolean).map((l, i) => <li key={i}>{l}</li>)}
                  </ul>
                </div>
              )}
              {p.rationale && <div><div className="section-label">Why it is suggested</div><p className="muted" style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{p.rationale}</p></div>}
              {(p.observations.length > 0 || p.cases.length > 0) && (
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }} aria-label="Linked to">
                  <span className="faint">Linked to</span>
                  {p.observations.map((o) => <Link key={o.id} className="chip" title={o.title} to={`/p/${pid}/observations?status=all#obs-${o.label}`}>{o.label}</Link>)}
                  {p.cases.map((c) => <Link key={c.id} className="chip" title={c.title} to={`/p/${pid}/cases?case=${c.id}`}>Case {c.number}: {c.title}</Link>)}
                </div>
              )}
              {p.status === "rejected" && (
                <div role="note"><div className="section-label">Why it was rejected</div><p style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{p.rejectReason}</p><span className="faint">By {p.decidedBy} {when(p.decidedAt)}</span></div>
              )}
              {p.status === "approved" && (
                <span className="muted">Approved by <b>{p.decidedBy}</b> {when(p.decidedAt)}{p.requirementId && <> · <Link to={`/p/${pid}/requirements?req=${p.requirementId}`}>{p.requirementLabel ?? "Open the requirement"}</Link></>}</span>
              )}
              {p.status === "proposed" && (
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <Button variant="primary" size="sm" disabled={approve.isPending} onClick={() => ask(p)}><Check size={13} /> Approve</Button>
                  <Button size="sm" onClick={() => setEditing(p)}><Pencil size={13} /> Edit</Button>
                  <Button size="sm" onClick={() => setRejecting(p)}><X size={13} /> Reject</Button>
                </div>
              )}
            </div>
          </article>
        ))
      )}
      {editing && <EditProposalModal proposal={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {rejecting && <RejectProposalModal proposal={rejecting} onClose={() => setRejecting(null)} onDone={refresh} />}
    </div>
  );
}

function EditProposalModal({ proposal, onClose, onSaved }: { proposal: RequirementProposal; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ title: proposal.title, description: proposal.description, acceptanceCriteria: proposal.acceptanceCriteria, rationale: proposal.rationale, kind: proposal.kind, suggestedPriority: proposal.suggestedPriority });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => api.patch<RequirementProposal>(`/api/requirement-proposals/${proposal.id}`, f),
    onSuccess: () => { onSaved(); toast("success", "Saved. It is still a proposal: approve it when it reads right."); onClose(); },
    onError: (e: Error) => toast("error", e.message),
  });
  return (
    <Modal title="Edit proposal" onClose={onClose} width={620}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.title.trim() || save.isPending} onClick={() => save.mutate()}>Save changes</Button></>}>
      <div className="col" style={{ gap: 12 }}>
        <p className="muted" style={{ margin: 0 }}>Change what you need before approving. The agent's version stays on record, and saving does not approve it.</p>
        <div className="field"><label htmlFor="ep-title">Title</label><input id="ep-title" className="input" autoFocus value={f.title} onChange={(e) => set("title", e.target.value)} /></div>
        <div className="field"><label htmlFor="ep-desc">Description</label><textarea id="ep-desc" className="textarea" rows={3} value={f.description} onChange={(e) => set("description", e.target.value)} /></div>
        <div className="field"><label htmlFor="ep-crit">Acceptance criteria (one per line)</label><textarea id="ep-crit" className="textarea" rows={3} value={f.acceptanceCriteria} onChange={(e) => set("acceptanceCriteria", e.target.value)} /></div>
        <div className="field"><label htmlFor="ep-why">Why it is suggested</label><textarea id="ep-why" className="textarea" rows={2} value={f.rationale} onChange={(e) => set("rationale", e.target.value)} /></div>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div className="field"><label htmlFor="ep-pri">Priority</label>
            <select id="ep-pri" className="select" value={f.suggestedPriority} onChange={(e) => set("suggestedPriority", e.target.value as Priority)}>
              {(["critical", "high", "medium", "low"] as const).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select></div>
          <div className="field"><label htmlFor="ep-kind">Kind</label>
            <select id="ep-kind" className="select" value={f.kind} onChange={(e) => set("kind", e.target.value as RequirementKind)}>
              {(Object.keys(KIND_LABEL) as RequirementKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select></div>
        </div>
      </div>
    </Modal>
  );
}

/** A reason is required: a rejected proposal is kept, and the reason is what makes that useful later. */
function RejectProposalModal({ proposal, onClose, onDone }: { proposal: RequirementProposal; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const ok = reason.trim().length >= 3;
  const reject = useMutation({
    mutationFn: () => api.post<RequirementProposal>(`/api/requirement-proposals/${proposal.id}/reject`, { reason: reason.trim() }),
    onSuccess: () => { onDone(); toast("success", "Rejected. It is kept with your reason."); onClose(); },
    onError: (e: Error) => toast("error", e.message),
  });
  return (
    <Modal title={`Reject “${proposal.title}”?`} onClose={onClose} width={520}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger-solid" disabled={!ok || reject.isPending} onClick={() => reject.mutate()}>Reject proposal</Button></>}>
      <div className="col" style={{ gap: 10 }}>
        <p style={{ margin: 0 }}>No requirement is made. The proposal stays under Rejected, with the reason, and cannot be approved afterwards.</p>
        <div className="field">
          <label htmlFor="rj-reason">Reason (required)</label>
          <textarea id="rj-reason" className="textarea" rows={3} autoFocus value={reason} placeholder="e.g. Already covered by REQ-4" onChange={(e) => setReason(e.target.value)} />
        </div>
        <RecordedAs what="Rejected as" />
      </div>
    </Modal>
  );
}

