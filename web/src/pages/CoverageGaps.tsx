import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Link2 } from "lucide-react";
import { api, type CoverageGaps, type Project, type Requirement } from "../api";
import { Empty, ListSkeleton, Modal, PriorityIcon, useToast } from "../components/ui";
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
  const refresh = () => {
    for (const k of [["coverage-gaps", pid], ["requirements", pid], ["requirement-coverage", pid], ["cases", pid], ["requirement"], ["dashboard", pid], ["observations", pid]]) qc.invalidateQueries({ queryKey: k });
  };
  if (isLoading) return <ListSkeleton rows={4} />;
  if (isError || !data) return <Empty icon={<CheckCircle2 size={20} />} title="Could not load the coverage gaps">{(error as Error | null)?.message}</Empty>;
  const none = data.counts.requirementsWithoutCases + data.counts.casesWithoutRequirement + data.counts.observationsWithoutLink === 0;
  return (
    <div className="col" style={{ gap: 20, padding: "16px 20px", maxWidth: 960 }}>
      <p className="muted" style={{ margin: 0 }}>What is not covered yet. These lists are groundwork for proposals; nothing here creates or changes a requirement. Link what already exists, or write the missing requirement.</p>
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
