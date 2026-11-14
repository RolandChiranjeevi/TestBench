import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { api, parseDate, timeAgo, type RunTemplate, type SchedulePreview, type Suite } from "../api";
import { DAY_NAMES, DEFAULT_FORM, WEEK, browserTimezone, fromCron, timezoneNames, toCron, type Preset, type ScheduleForm } from "../schedule";
import { casesInFolder } from "../folders";
import { CasePicker, useRunnableCases } from "../components/CasePicker";
import { Empty, Modal, useToast } from "../components/ui";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { EditScope } from "../components/Access";

// A run template is what the app calls a SUITE: a saved list of cases that is run as a unit, as a manual run. (The tree on the Test cases page is made of FOLDERS,
// which only organise cases.) The table and the routes keep the old name, so these components keep it too.

export function useTemplates() {
  const { pid } = useParams();
  return useQuery({ queryKey: ["templates", pid], queryFn: () => api.get<RunTemplate[]>(`/api/projects/${pid}/templates`) });
}

export function TemplatesPanel({ templates, onStart, onEdit, onNew }: { templates: RunTemplate[]; onStart: (t: RunTemplate) => void; onEdit: (t: RunTemplate) => void; onNew: () => void }) {
  const { pid } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const runnable = useRunnableCases();
  const runnableIds = new Set(runnable.map((c) => c.id));

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/templates/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["templates", pid] });
      qc.invalidateQueries({ queryKey: ["runs", pid] });
    },
    onError: (e: Error) => toast("error", e.message),
  });

  if (templates.length === 0) {
    return (
      <Empty
        icon={<ClipboardList size={20} />}
        title="No suites yet"
        action={<Button needs="tester" variant="primary" onClick={onNew}><Plus size={14} /> New suite</Button>}
      >
        A suite is a saved list of test cases, like “Smoke test” or “Release regression”. Start a run from it in one click instead of ticking the same cases every sprint.
        Folders on the Test cases page only organise cases; a suite is what you run.
      </Empty>
    );
  }

  return (
    <>
      {templates.map((t) => {
        const count = t.caseIds.filter((id) => runnableIds.has(id)).length;
        const lr = t.last_run;
        return (
          <div key={t.id} className="list-row" style={{ height: "auto", minHeight: 58, padding: "8px 16px", cursor: "default" }} data-suite={t.name}>
            <ClipboardList size={15} className="faint" />
            <div className="grow col" style={{ gap: 2, minWidth: 0 }}>
              <div className="row" style={{ gap: 8 }}>
                <span className="truncate" style={{ fontWeight: 500 }}>{t.name}</span>
                {t.environment && <span className="chip">{t.environment}</span>}
              </div>
              {t.description && <span className="muted truncate" style={{ fontSize: "var(--fs-sm)" }}>{t.description}</span>}
              <span className="faint row" style={{ fontSize: "var(--fs-sm)", gap: 6, flexWrap: "wrap" }}>
                <span>{count} {count === 1 ? "case" : "cases"}</span>
                <span>·</span>
                {lr ? (
                  <>
                    <span>
                      last run <Link to={`/p/${pid}/runs/${lr.id}`} style={{ color: "var(--accent-text)" }}>{timeAgo(lr.started_at)}</Link>:
                    </span>
                    <span style={{ color: "var(--passed-fg)" }}>{lr.passed} passed</span>
                    <span>·</span>
                    <span style={{ color: lr.failed ? "var(--failed-fg)" : undefined }}>{lr.failed} failed</span>
                    {lr.blocked > 0 && <><span>·</span><span style={{ color: "var(--blocked-fg)" }}>{lr.blocked} blocked</span></>}
                    {lr.untested > 0 && <><span>·</span><span>{lr.untested} not run</span></>}
                    {lr.status === "in_progress" && <Badge tone="accent" icon="eye">In progress</Badge>}
                    <span>·</span>
                    <span>{t.run_count} {t.run_count === 1 ? "run" : "runs"}</span>
                  </>
                ) : (
                  <span>never run</span>
                )}
              </span>
            </div>
            <Button needs="tester" variant="primary" size="sm" disabled={count === 0} onClick={() => onStart(t)} aria-label={`Run ${t.name}`} title={count === 0 ? "This suite has no runnable cases" : "Start a manual run of this suite"}>
              <Play size={12} /> Run
            </Button>
            <Button needs="tester" variant="ghost" size="sm" icon onClick={() => onEdit(t)} aria-label={`Edit ${t.name}`} title="Edit"><Pencil size={13} /></Button>
            <Button needs="admin" variant="danger" size="sm" icon
              onClick={() => confirm(`Delete suite "${t.name}"? Runs already started from it are kept.`) && remove.mutate(t.id)}
              aria-label={`Delete ${t.name}`}
              title="Delete"
            >
              <Trash2 size={13} />
            </Button>
          </div>
        );
      })}
    </>
  );
}

/** Create a suite, or edit an existing one: its name, description, default environment and cases. `initialCaseIds` pre-selects cases for a new suite. */
export function TemplateModal({ template, initialCaseIds = [], onClose }: { template?: RunTemplate; initialCaseIds?: number[]; onClose: () => void }) {
  const { pid } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const runnable = useRunnableCases();
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [environment, setEnvironment] = useState(template?.environment ?? "");
  const [selected, setSelected] = useState<Set<number>>(() => new Set(template ? template.caseIds : initialCaseIds));
  const [onSchedule, setOnSchedule] = useState(!!template?.schedule);
  const [form, setForm] = useState<ScheduleForm>(() => (template?.schedule ? fromCron(template.schedule) : DEFAULT_FORM));
  const [timezone, setTimezone] = useState(template?.schedule_tz ?? browserTimezone());
  const [startRun, setStartRun] = useState(false);
  const navigate = useNavigate();
  const runnableIds = new Set(runnable.map((c) => c.id));
  const count = [...selected].filter((id) => runnableIds.has(id)).length;
  const cron = onSchedule ? toCron(form) : "";
  const preview = useSchedulePreview(onSchedule ? cron : "", timezone);
  const scheduleBad = onSchedule && (!cron || preview.data?.ok === false);

  const save = useMutation({
    // Two steps: the suite and its schedule are saved, then (if asked) a manual run is started. A run that cannot start does not undo the first step.
    mutationFn: async () => {
      const body = { name, description, environment, caseIds: [...selected].filter((id) => runnableIds.has(id)), schedule: onSchedule ? cron : null, scheduleTimezone: timezone };
      const saved = await (template ? api.patch<RunTemplate>(`/api/templates/${template.id}`, body) : api.post<RunTemplate>(`/api/projects/${pid}/templates`, body));
      if (!startRun) return { started: null, startError: null };
      try {
        return { started: await api.post<{ id: number }>(`/api/templates/${saved.id}/run`, {}), startError: null };
      } catch (e) {
        return { started: null, startError: (e as Error).message };
      }
    },
    onSuccess: ({ started, startError }) => {
      qc.invalidateQueries({ queryKey: ["templates", pid] });
      qc.invalidateQueries({ queryKey: ["runs", pid] });
      if (startError) toast("error", `The suite${onSchedule ? " and its schedule are" : " is"} saved, but the run did not start: ${startError}`);
      onClose();
      if (started) navigate(`/p/${pid}/runs/${started.id}`);
    },
    onError: (e: Error) => toast("error", e.message),
  });

  return (
    <Modal
      title={template ? "Edit suite" : "New suite"}
      onClose={onClose}
      width={680}
      footer={
        <>
          <span className="muted" style={{ marginRight: "auto" }}>{count} of {runnable.length} cases</span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button needs="tester" variant="primary" disabled={!name.trim() || count === 0 || scheduleBad || save.isPending} onClick={() => save.mutate()}>
            {template ? "Save changes" : "Create suite"}
          </Button>
        </>
      }
    >
      <input className="bare title-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Suite name, e.g. Smoke test" aria-label="Suite name" autoFocus />
      <div className="field">
        <label htmlFor="tdesc">Description (optional)</label>
        <textarea id="tdesc" className="textarea" rows={2} placeholder="What it is for, and when to run it" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="tenv">Default environment (optional)</label>
        <input id="tenv" className="input" placeholder="staging, prod…" value={environment} onChange={(e) => setEnvironment(e.target.value)} />
      </div>
      <WhenToRun onSchedule={onSchedule} setOnSchedule={setOnSchedule} form={form} setForm={setForm} timezone={timezone} setTimezone={setTimezone} preview={preview} startRun={startRun} setStartRun={setStartRun} />
      <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>
        Tick the cases in the suite. A run takes them in the order of the case list. The chip on each case shows whether an automated test is linked to it.
      </div>
      <CasePicker selected={selected} onChange={setSelected} />
    </Modal>
  );
}

/** The next times of a schedule, or what is wrong with it, as the server works them out (GET .../schedule-preview). Waits until the typing has stopped. */
function useSchedulePreview(cron: string, timezone: string) {
  const { pid } = useParams();
  const [wanted, setWanted] = useState({ cron, timezone });
  useEffect(() => {
    const t = setTimeout(() => setWanted({ cron, timezone }), 400);
    return () => clearTimeout(t);
  }, [cron, timezone]);
  return useQuery({
    queryKey: ["schedule-preview", pid, wanted.cron, wanted.timezone],
    queryFn: () => api.get<SchedulePreview>(`/api/projects/${pid}/schedule-preview?cron=${encodeURIComponent(wanted.cron)}&tz=${encodeURIComponent(wanted.timezone)}`),
    enabled: !!wanted.cron && wanted.cron === cron && wanted.timezone === timezone,
  });
}

const inZone = (utc: string, timezone: string) =>
  parseDate(utc)?.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: timezone }) ?? utc;

/** "When to run" in the suite form: by hand, or on a schedule (a preset, a time and weekdays, or a cron expression of one's own). */
function WhenToRun({ onSchedule, setOnSchedule, form, setForm, timezone, setTimezone, preview, startRun, setStartRun }: {
  onSchedule: boolean; setOnSchedule: (v: boolean) => void; form: ScheduleForm; setForm: (f: ScheduleForm) => void; timezone: string; setTimezone: (z: string) => void;
  preview: { data?: SchedulePreview; isFetching: boolean }; startRun: boolean; setStartRun: (v: boolean) => void;
}) {
  const zones = timezoneNames();
  const set = (patch: Partial<ScheduleForm>) => setForm({ ...form, ...patch });
  const toggleDay = (d: number) => set({ days: form.days.includes(d) ? form.days.filter((x) => x !== d) : [...form.days, d] });
  const p = preview.data;
  return (
    <EditScope>
      <fieldset className="col" style={{ gap: 10, border: 0, padding: 0, margin: 0, minWidth: 0 }} data-when-to-run>
        <legend className="field" style={{ padding: 0, fontSize: "var(--fs-sm)", color: "var(--text-3)", fontWeight: 500 }}>When to run</legend>
        <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
          <label className="row" style={{ gap: 6 }}><input type="radio" name="when" checked={!onSchedule} onChange={() => setOnSchedule(false)} /> Run by hand</label>
          <label className="row" style={{ gap: 6 }}><input type="radio" name="when" checked={onSchedule} onChange={() => setOnSchedule(true)} /> On a schedule</label>
        </div>
        {onSchedule && (
          <>
            <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div className="field">
                <label htmlFor="wpreset">Repeat</label>
                <select id="wpreset" className="select" value={form.preset} onChange={(e) => set({ preset: e.target.value as Preset, cron: form.preset === "custom" ? form.cron : toCron(form) })}>
                  <option value="daily">Every day</option>
                  <option value="weekly">Certain weekdays</option>
                  <option value="custom">Custom (cron)</option>
                </select>
              </div>
              {form.preset !== "custom" && (
                <div className="field">
                  <label htmlFor="wtime">At</label>
                  <input id="wtime" className="input" type="time" value={form.time} onChange={(e) => set({ time: e.target.value })} />
                </div>
              )}
              <div className="field" style={{ minWidth: 0, flex: "1 1 180px" }}>
                <label htmlFor="wtz">Time zone</label>
                <select id="wtz" className="select" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                  {(zones.includes(timezone) ? zones : [timezone, ...zones]).map((z) => <option key={z} value={z}>{z}</option>)}
                </select>
              </div>
            </div>
            {form.preset === "weekly" && (
              <div className="row" style={{ gap: 12, flexWrap: "wrap" }} role="group" aria-label="Weekdays">
                {WEEK.map((d) => (
                  <label key={d} className="row" style={{ gap: 4 }}>
                    <input type="checkbox" className="checkbox" checked={form.days.includes(d)} onChange={() => toggleDay(d)} /> {DAY_NAMES[d].slice(0, 3)}
                  </label>
                ))}
              </div>
            )}
            {form.preset === "custom" && (
              <div className="field">
                <label htmlFor="wcron">Cron expression (minute hour day-of-month month day-of-week)</label>
                <input id="wcron" className="input mono" placeholder="0 8 * * 1-5" value={form.cron} onChange={(e) => set({ cron: e.target.value })} spellCheck={false} />
              </div>
            )}
            <div aria-live="polite" style={{ fontSize: "var(--fs-sm)" }}>
              {!toCron(form) ? (
                <span className="muted">{form.preset === "custom" ? "Write a schedule to see when it runs." : "Choose a time and at least one weekday."}</span>
              ) : !p ? (
                <span className="muted">{preview.isFetching ? "Working out the next times…" : ""}</span>
              ) : p.ok ? (
                <div className="col" style={{ gap: 2 }}>
                  <span className="muted">Next runs ({timezone}):</span>
                  {p.next.map((t) => <span key={t} className="tabular">{inZone(t, timezone)}</span>)}
                </div>
              ) : (
                <span role="alert" style={{ color: "var(--failed-fg)" }}>{p.error}</span>
              )}
              {p && !p.schedulerEnabled && (
                <div style={{ color: "var(--blocked-fg)", marginTop: 4 }}>The scheduler is turned off on this server (TESTBENCH_SCHEDULER=0): the schedule is saved, but nothing is started from it.</div>
              )}
            </div>
            <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>
              A scheduled run prepares a manual run with the suite's cases, ready for a person to go through. Nothing is run automatically.
            </div>
          </>
        )}
        <label className="row" style={{ gap: 6, alignItems: "flex-start" }}>
          <input type="checkbox" className="checkbox" checked={startRun} onChange={(e) => setStartRun(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            Start a run when I save
            <span className="muted" style={{ display: "block", fontSize: "var(--fs-sm)" }}>
              Two steps: first the suite{onSchedule ? " and its schedule are" : " is"} saved, then a manual run is started. If the run cannot start, the save still stands.
            </span>
          </span>
        </label>
      </fieldset>
    </EditScope>
  );
}

/** Save the cases of a folder (and by default its subfolders) as a new suite. It is a copy: later changes to the folder do not change the suite. */
export function FolderToSuiteModal({ folder, onClose }: { folder: Suite; onClose: () => void }) {
  const { pid } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const runnable = useRunnableCases();
  const { data: folders = [] } = useQuery({ queryKey: ["suites", pid], queryFn: () => api.get<Suite[]>(`/api/projects/${pid}/suites`) });
  const [name, setName] = useState(folder.name);
  const [include, setInclude] = useState(true);
  const hasSub = folders.some((f) => f.parent_id === folder.id);
  const count = casesInFolder(runnable, folders, folder.id, include).length;

  const save = useMutation({
    mutationFn: () => api.post<RunTemplate>(`/api/projects/${pid}/templates/from-folder`, { folderId: folder.id, name, includeSubfolders: include }),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ["templates", pid] });
      toast("success", `Suite “${t.name}” saved with ${t.caseIds.length} ${t.caseIds.length === 1 ? "case" : "cases"}`);
      onClose();
      navigate(`/p/${pid}/runs?kind=suites`);
    },
    onError: (e: Error) => toast("error", e.message),
  });

  return (
    <Modal
      title={`Save folder “${folder.name}” as a suite`}
      onClose={onClose}
      width={520}
      footer={
        <>
          <span className="muted" style={{ marginRight: "auto" }}>{count} {count === 1 ? "case" : "cases"}</span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button needs="tester" variant="primary" disabled={!name.trim() || count === 0 || save.isPending} onClick={() => save.mutate()}>Create suite</Button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="f2s-name">Suite name</label>
        <input id="f2s-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      {hasSub && (
        <label className="row muted" style={{ fontSize: "var(--fs-md)", cursor: "pointer" }}>
          <input type="checkbox" className="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} /> Include the cases in subfolders
        </label>
      )}
      <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>
        The suite gets a copy of the cases the folder holds now. Cases added to the folder later are not added to the suite, and the folder is left as it is.
        {count === 0 && " This folder has no cases that can be run."}
      </div>
    </Modal>
  );
}
