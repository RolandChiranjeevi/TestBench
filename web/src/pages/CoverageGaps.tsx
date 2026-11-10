import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Link2, Sparkles } from "lucide-react";
import { api, type CoverageGaps, type GenerateResult, type Project, type Requirement } from "../api";
import { Empty, ListSkeleton, Modal, PriorityIcon, useConfirm, useToast } from "../components/ui";
import { Button } from "../components/Button";
import { CasePicker } from "../components/CasePicker";
import { OriginBadge } from "../components/RequirementBits";
import { SeverityBadge } from "../components/Badge";
import { LinkToRequirementModal } from "./Requirements";

const KIND_NAME: Record<string, string> = { load_test: "Load test", security_review: "Security review" };

/**
 * What is not covered yet, in three lists: requirements without a test case, test cases without a requirement, and observations that are linked to neither.
 * It is groundwork for proposals and nothing here makes or changes a requirement: "Link" only connects things that already exist, as a person decides.
 */
export function CoverageGapsTab() {
  const { pid } = useParams();
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({ queryKey: ["coverage-gaps", pid], queryFn: () => api.get<CoverageGaps>(`/api/projects/${pid}/coverage-gaps`) });
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });
  const key = projects?.find((p) => p.id === Number(pid))?.key ?? "";
  const [linkCase, setLinkCase] = useState<number | null>(null);
  const [linkReq, setLinkReq] = useState<number | null>(null);
  const [linkObs, setLinkObs] = useState<CoverageGaps["observationsWithoutLink"][number] | null>(null);
  const toast = useToast();
  const confirm = useConfirm();
  const [generating, setGenerating] = useState(false);
  /**
   * "Generate proposals": fixed rules turn the gaps into requirement proposals (no AI model, no network). It asks first, with a dry run that says what would be made;
   * what it makes only starts as proposals under Proposals, and nothing becomes a requirement until a person approves it.
   */
  const generate = async () => {
    setGenerating(true);
    try {
      const url = `/api/projects/${pid}/generate-proposals`;
      const dry = await api.post<GenerateResult>(`${url}?dryRun=1`);
      const c = dry.counts;
      if (c.created === 0) {
        toast("success", c.skipped ? `Nothing new to propose: ${c.skipped} gap${c.skipped === 1 ? " is" : "s are"} skipped (already proposed, or only informational).` : "Nothing to propose: no test case or observation is waiting for a requirement.");
        return;
      }
      const fromCases = dry.created.filter((x) => x.gap.startsWith("case:")).length;
      const ok = await confirm({
        title: `Create ${c.created} proposal${c.created === 1 ? "" : "s"}?`,
        tone: "primary",
        confirmLabel: `Create ${c.created}`,
        body: (
          <div className="col" style={{ gap: 8 }}>
            <p style={{ margin: 0 }}>Fixed rules, not an AI model, turn the gaps into proposals for new requirements: {fromCases} from test cases without a requirement and {c.created - fromCases} from observations without a link.</p>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {dry.created.slice(0, 6).map((x) => <li key={x.gap}>{x.title}</li>)}
              {dry.created.length > 6 && <li className="faint">…and {dry.created.length - 6} more</li>}
            </ul>
            <p className="muted" style={{ margin: 0 }}>They start as proposals under Proposals. Nothing becomes a requirement until you approve it.</p>
            {c.skipped > 0 && <p className="faint" style={{ margin: 0 }}>{c.skipped} gap{c.skipped === 1 ? " is" : "s are"} skipped: already proposed, or only informational (severity info).</p>}
            {c.notGenerated > 0 && <p className="faint" style={{ margin: 0 }}>{c.notGenerated} requirement{c.notGenerated === 1 ? " needs" : "s need"} a test case (not generated): link an existing one, or write one.</p>}
            {c.more > 0 && <p className="faint" style={{ margin: 0 }}>Only the first {c.created} are made now; {c.more} more can be made by running it again.</p>}
          </div>
        ),
      });
      if (!ok) return;
      const made = await api.post<GenerateResult>(url);
      for (const k of [["requirement-proposals", pid], ["coverage-gaps", pid]]) qc.invalidateQueries({ queryKey: k });
      toast("success", `${made.counts.created} proposal${made.counts.created === 1 ? "" : "s"} created. Review them under Proposals.`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setGenerating(false);
    }
  };
  const refresh = () => {
    for (const k of [["coverage-gaps", pid], ["requirements", pid], ["requirement-coverage", pid], ["cases", pid], ["requirement"], ["dashboard", pid], ["observations", pid]]) qc.invalidateQueries({ queryKey: k });
  };
  if (isLoading) return <ListSkeleton rows={4} />;
  if (isError || !data) return <Empty icon={<CheckCircle2 size={20} />} title="Could not load the coverage gaps">{(error as Error | null)?.message}</Empty>;
  const none = data.counts.requirementsWithoutCases + data.counts.casesWithoutRequirement + data.counts.observationsWithoutLink === 0;
  return (
    <div className="col" style={{ gap: 20, padding: "16px 20px", maxWidth: 960 }}>
      <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
        <p className="muted" style={{ margin: 0, flex: "1 1 360px" }}>What is not covered yet. These lists are groundwork for proposals; nothing here creates or changes a requirement. Link what already exists, or write the missing requirement.</p>
        <Button disabled={generating || data.counts.casesWithoutRequirement + data.counts.observationsWithoutLink === 0}
          title="Fixed rules turn test cases without a requirement and observations without a link into proposals for new requirements. They start as proposals: you approve, edit or reject them."
          onClick={generate}><Sparkles size={14} /> Generate proposals</Button>
      </div>
      {none && <Empty icon={<CheckCircle2 size={20} />} title="No gaps">Every approved requirement has a test case, every test case has a requirement, and every open observation is linked.</Empty>}

      <section aria-labelledby="gap-req">
        <h2 id="gap-req" className="section-label" style={{ fontSize: "var(--fs-md)" }}>Requirements without a test case <span className="faint">{data.counts.requirementsWithoutCases}</span></h2>
        {data.requirementsWithoutCases.length === 0 ? <p className="faint" style={{ margin: "6px 0 0" }}>Every approved requirement has a test case.</p> : (
          <div role="list">
            {data.requirementsWithoutCases.map((r) => (
              <div key={r.id} role="listitem" className="list-row" style={{ cursor: "default" }}>
                <PriorityIcon priority={r.priority} />
                <Link className="id mono" to={`/p/${pid}/requirements?req=${r.id}`}>REQ-{r.number}</Link>
                <span className="title">{r.title}</span>
                <span className="meta"><OriginBadge origin={r.origin} /><Button size="sm" onClick={() => setLinkReq(r.id)}><Link2 size={12} /> Link test cases</Button></span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="gap-case">
        <h2 id="gap-case" className="section-label" style={{ fontSize: "var(--fs-md)" }}>Test cases without a requirement <span className="faint">{data.counts.casesWithoutRequirement}</span></h2>
        {data.casesWithoutRequirement.length === 0 ? <p className="faint" style={{ margin: "6px 0 0" }}>Every test case in use is linked to a requirement.</p> : (
          <div role="list">
            {data.casesWithoutRequirement.map((c) => (
              <div key={c.id} role="listitem" className="list-row" style={{ cursor: "default" }}>
                <PriorityIcon priority={c.priority} />
                <Link className="id mono" to={`/p/${pid}/cases?case=${c.id}`}>{key}-{c.number}</Link>
                <span className="title">{c.title}</span>
                <span className="meta"><Button size="sm" onClick={() => setLinkCase(c.id)}><Link2 size={12} /> Link to a requirement</Button></span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="gap-obs">
        <h2 id="gap-obs" className="section-label" style={{ fontSize: "var(--fs-md)" }}>Observations not linked to anything <span className="faint">{data.counts.observationsWithoutLink}</span></h2>
        {data.observationsWithoutLink.length === 0 ? <p className="faint" style={{ margin: "6px 0 0" }}>Every open observation is linked to a requirement or a test case.</p> : (
          <div role="list">
            {data.observationsWithoutLink.map((o) => (
              <div key={o.id} role="listitem" className="list-row" style={{ cursor: "default" }}>
                <Link className="id mono" to={`/p/${pid}/observations#obs-${o.label}`}>{o.label}</Link>
                <span className="title">{o.title}</span>
                <span className="meta"><span className="faint">{KIND_NAME[o.kind] ?? o.kind}</span><SeverityBadge value={o.severity as Parameters<typeof SeverityBadge>[0]["value"]} /><Button size="sm" onClick={() => setLinkObs(o)}><Link2 size={12} /> Link</Button></span>
              </div>
            ))}
          </div>
        )}
      </section>

      {linkCase != null && <LinkToRequirementModal caseIds={[linkCase]} onClose={() => setLinkCase(null)} onDone={() => { setLinkCase(null); refresh(); }} />}
      {linkReq != null && <LinkCasesToRequirement requirementId={linkReq} onClose={() => setLinkReq(null)} onDone={() => { setLinkReq(null); refresh(); }} />}
      {linkObs && <LinkObservationModal observation={linkObs} onClose={() => setLinkObs(null)} onDone={() => { setLinkObs(null); refresh(); }} />}
    </div>
  );
}

/** Pick test cases for one requirement. The links already there are kept. */
function LinkCasesToRequirement({ requirementId, onClose, onDone }: { requirementId: number; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [ids, setIds] = useState<Set<number>>(new Set());
  const save = useMutation({
    mutationFn: () => api.post(`/api/requirements/${requirementId}/cases`, { caseIds: [...ids] }),
    onSuccess: () => { toast("success", `Linked ${ids.size} test case${ids.size === 1 ? "" : "s"}`); onDone(); },
    onError: (e: Error) => toast("error", e.message),
  });
  return (
    <Modal title="Link test cases to this requirement" onClose={onClose} width={560}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={ids.size === 0 || save.isPending} onClick={() => save.mutate()}>Link {ids.size || ""} test case{ids.size === 1 ? "" : "s"}</Button></>}>
      <CasePicker selected={ids} onChange={setIds} />
    </Modal>
  );
}

/** Link an observation to a requirement and/or a test case. A link is a person's decision; it takes the observation off this list. */
function LinkObservationModal({ observation, onClose, onDone }: { observation: CoverageGaps["observationsWithoutLink"][number]; onClose: () => void; onDone: () => void }) {
  const { pid } = useParams();
  const toast = useToast();
  const { data: reqs = [] } = useQuery({ queryKey: ["requirements", pid], queryFn: () => api.get<Requirement[]>(`/api/projects/${pid}/requirements`) });
  const [reqIds, setReqIds] = useState<Set<number>>(new Set());
  const [caseIds, setCaseIds] = useState<Set<number>>(new Set());
  const active = reqs.filter((r) => r.status !== "deprecated");
  const save = useMutation({
    mutationFn: () => api.put(`/api/observations/${observation.id}/links`, { requirementIds: [...reqIds], caseIds: [...caseIds] }),
    onSuccess: () => { toast("success", `${observation.label} is linked`); onDone(); },
    onError: (e: Error) => toast("error", e.message),
  });
  const toggle = (id: number) => setReqIds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Modal title={`Link ${observation.label}`} onClose={onClose} width={600}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={reqIds.size + caseIds.size === 0 || save.isPending} onClick={() => save.mutate()}>Save links</Button></>}>
      <div className="col" style={{ gap: 14 }}>
        <p style={{ margin: 0 }}>“{observation.title}”. Choose the requirements and test cases it is about. This only links them; it does not make a bug or change anything else.</p>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="section-label">Requirements</legend>
          {active.length === 0 ? <p className="faint" style={{ margin: "4px 0 0" }}>There are no requirements in use.</p> : (
            <div style={{ maxHeight: 180, overflow: "auto", display: "grid", gap: 4, marginTop: 4 }}>
              {active.map((r) => (
                <label key={r.id} className="row" style={{ gap: 8 }}>
                  <input type="checkbox" checked={reqIds.has(r.id)} onChange={() => toggle(r.id)} />
                  <span className="mono muted">REQ-{r.number}</span><span>{r.title}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <div>
          <div className="section-label">Test cases</div>
          <CasePicker selected={caseIds} onChange={setCaseIds} />
        </div>
      </div>
    </Modal>
  );
}
