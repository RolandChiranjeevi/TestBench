import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, FileUp, FolderOpen, GitBranch, Loader2, Paperclip, Plus, RefreshCw, Trash2, Upload, XCircle } from "lucide-react";
import { api, formatDateTime, timeAgo, type CheckResult, type GithubSource, type ImportResult, type Milestone, type Project, type WorkflowRun } from "../api";
import { Github, Modal, useConfirm, useToast } from "../components/ui";
import { Button, buttonClass } from "../components/Button";
import { useCan } from "../components/Access";

export function ImportPage() {
  return (
    <>
      <div className="topbar">
        <h1>Import results</h1>
      </div>
      <div className="content">
        <div style={{ padding: 20, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(420px, 100%), 1fr))", gap: 16, alignItems: "start", maxWidth: 1400 }}>
          <UploadCard />
          <GithubCard />
        </div>
        <div style={{ padding: "0 20px 32px", maxWidth: 1400 }}>
          <SetupGuide />
        </div>
      </div>
    </>
  );
}

function useImportDone() {
  const { pid } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  return (r: ImportResult) => {
    for (const k of ["runs", "automated", "cases"]) qc.invalidateQueries({ queryKey: [k, pid] });
    qc.invalidateQueries({ queryKey: ["projects"] });
    qc.invalidateQueries({ queryKey: ["gh-runs"] });
    qc.invalidateQueries({ queryKey: ["milestones", pid] });
    qc.invalidateQueries({ queryKey: ["dashboard", pid] });
    if (r.duplicate) toast("success", "Already imported, opening the existing run");
    else toast("success", `Imported ${r.total} tests, ${r.linked} linked to cases${r.attachments ? `, ${r.attachments} evidence files` : ""}`);
    navigate(`/p/${pid}/runs/${r.runId}`);
  };
}

/** A file chosen for upload. `path` is its location inside a picked folder, which the server uses to match evidence to tests. */
interface Picked { file: File; path: string; fromFolder: boolean; evidence: boolean }
const REPORT_OR_ZIP = /\.(xml|json|zip)$/i;
const EVIDENCE = /\.(png|jpe?g|gif|webp|webm|mp4|zip|md|txt|log|pdf)$/i;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function UploadCard() {
  const { pid } = useParams();
  const toast = useToast();
  const done = useImportDone();
  const [files, setFiles] = useState<Picked[]>([]);
  const folderInput = useRef<HTMLInputElement>(null);
  const [framework, setFramework] = useState("");
  const [title, setTitle] = useState("");
  const [environment, setEnvironment] = useState("");
  const [milestone, setMilestone] = useState("");
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { data: milestones = [] } = useQuery({ queryKey: ["milestones", pid], queryFn: () => api.get<Milestone[]>(`/api/projects/${pid}/milestones`) });

  const upload = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      // Fields go first so the server has the framework hint before it parses files.
      fd.append("framework", framework);
      fd.append("title", title);
      fd.append("environment", environment);
      fd.append("milestone", milestone);
      for (const p of files) {
        if (p.fromFolder) fd.append("relpath", p.path); // must come right before its file
        fd.append("file", p.file, p.file.name);
      }
      return api.post<ImportResult>(`/api/projects/${pid}/import`, fd);
    },
    onSuccess: done,
    onError: (e: Error) => toast("error", e.message),
  });

  const add = (list: FileList | null, fromFolder = false) => {
    if (!list) return;
    let tooBig = 0;
    const picked: Picked[] = [];
    for (const file of [...list]) {
      const path = (fromFolder && file.webkitRelativePath) || file.name;
      if (path.includes("node_modules/")) continue;
      // From a folder we want the reports plus the evidence beside them; on their own only reports and artifact zips make sense.
      const wanted = fromFolder ? REPORT_OR_ZIP.test(file.name) || EVIDENCE.test(file.name) : REPORT_OR_ZIP.test(file.name);
      if (!wanted) continue;
      if (file.size > MAX_UPLOAD_BYTES) { tooBig++; continue; }
      const evidence = fromFolder && !/\.(xml|json)$/i.test(file.name);
      picked.push({ file, path, fromFolder, evidence });
    }
    if (tooBig) toast("error", `${tooBig} ${tooBig === 1 ? "file was" : "files were"} skipped because they are over 100 MB`);
    setFiles((f) => [...f, ...picked]);
  };
  const reports = files.filter((p) => !p.evidence);
  const evidenceCount = files.length - reports.length;

  return (
    <div className="card">
      <div className="card-header" role="heading" aria-level={2}><FileUp size={15} /> Upload a report</div>
      <div className="card-body col" style={{ gap: 12 }}>
        <div
          className={`dropzone${over ? " over" : ""}`}
          onClick={() => input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && input.current?.click()}
        >
          <Upload size={18} />
          <div style={{ marginTop: 6, color: "var(--text)" }}>Drop a Playwright artifact (.zip), or JUnit XML / JSON files</div>
          <div style={{ fontSize: "var(--fs-sm)" }}>An artifact zip brings its screenshots, videos and traces along. Several files are merged into one run.</div>
          <input ref={input} type="file" multiple hidden accept=".xml,.json,.zip" onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Button size="sm" onClick={() => folderInput.current?.click()}><FolderOpen size={13} /> Choose a test-results folder</Button>
          <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Include the folder with your screenshots, videos and traces next to results.json.</span>
          {/* webkitdirectory is not in React's input typings. */}
          <input
            ref={folderInput}
            type="file"
            hidden
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            onChange={(e) => { add(e.target.files, true); e.target.value = ""; }}
          />
        </div>
        {files.length > 0 && (
          <div className="col" style={{ gap: 4 }}>
            {reports.map((p, i) => (
              <div key={i} className="row" style={{ fontSize: "var(--fs-md)" }}>
                <FileUp size={13} className="faint" />
                <span className="mono truncate grow">{p.path}</span>
                <span className="faint">{Math.max(1, Math.round(p.file.size / 1024))} KB</span>
                <Button variant="ghost" size="sm" icon onClick={() => setFiles(files.filter((x) => x !== p))} aria-label={`Remove ${p.path}`}><Trash2 size={12} /></Button>
              </div>
            ))}
            {evidenceCount > 0 && (
              <div className="row faint" style={{ fontSize: "var(--fs-md)" }}>
                <Paperclip size={13} /> + {evidenceCount} evidence {evidenceCount === 1 ? "file" : "files"} (screenshots, videos, traces)
                <Button variant="ghost" size="sm" onClick={() => setFiles(reports)}>Clear</Button>
              </div>
            )}
          </div>
        )}
        <div className="row" style={{ gap: 12 }}>
          <div className="field grow">
            <label htmlFor="fw">Framework</label>
            <select id="fw" className="select" value={framework} onChange={(e) => setFramework(e.target.value)}>
              <option value="">Detect automatically</option>
              <option value="playwright">Playwright</option>
              <option value="testcafe">TestCafe</option>
              <option value="selenium">Selenium</option>
              <option value="bruno">Bruno (API tests)</option>
              <option value="junit">Other (JUnit)</option>
            </select>
          </div>
          <div className="field grow">
            <label htmlFor="rt">Run title</label>
            <input id="rt" className="input" placeholder="Defaults to framework + file name" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <div className="field grow">
            <label htmlFor="renv">Environment</label>
            <input id="renv" className="input" placeholder="staging" value={environment} onChange={(e) => setEnvironment(e.target.value)} />
          </div>
          <div className="field grow">
            <label htmlFor="rms">Sprint / release</label>
            <input id="rms" className="input" list="milestone-options" placeholder="Sprint 42" value={milestone} onChange={(e) => setMilestone(e.target.value)} />
            <datalist id="milestone-options">{milestones.map((m) => <option key={m.id} value={m.name} />)}</datalist>
          </div>
        </div>
        <div className="row">
          <span className="spacer" />
          <Button needs="tester" variant="primary" disabled={!files.length || upload.isPending} onClick={() => upload.mutate()}>
            {upload.isPending ? <Loader2 size={14} className="spin" /> : <Download size={14} />} Import{files.length > 1 ? ` ${files.length} files` : ""}
          </Button>
        </div>
      </div>
    </div>
  );
}

function GithubCard() {
  const confirm = useConfirm();
  const { pid } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const { data: status } = useQuery({ queryKey: ["gh-status"], queryFn: () => api.get<{ authenticated: boolean; via: string | null }>("/api/github/status") });
  const { data: sources = [] } = useQuery({ queryKey: ["gh-sources", pid], queryFn: () => api.get<GithubSource[]>(`/api/projects/${pid}/github-sources`) });
  const current = sources.find((s) => s.id === active) ?? sources[0];

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/github-sources/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["gh-sources", pid] }),
    onError: (e: Error) => toast("error", e.message),
  });

  return (
    <div className="card">
      <div className="card-header" role="heading" aria-level={2}>
        <Github size={15} /> GitHub Actions
        <span className="spacer" />
        {status && (
          <span className="row faint" style={{ fontSize: "var(--fs-sm)", fontWeight: 400, gap: 4 }}>
            {status.authenticated ? <CheckCircle2 size={12} style={{ color: "var(--passed-fg)" }} /> : <XCircle size={12} style={{ color: "var(--failed-fg)" }} />}
            {status.authenticated ? `Authenticated via ${status.via}` : "Not authenticated"}
          </span>
        )}
      </div>
      <div className="card-body col" style={{ gap: 12 }}>
        {status && !status.authenticated && (
          <div className="muted" style={{ fontSize: "var(--fs-md)" }}>
            Run <code className="inline">gh auth login</code>, or start the server with <code className="inline">GITHUB_TOKEN=…</code>. The token is read from there and never stored.
          </div>
        )}
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          {sources.map((s) => (
            <button key={s.id} className={`tab${current?.id === s.id ? " active" : ""}`} onClick={() => setActive(s.id)}>
              <Github size={12} /> {s.owner}/{s.repo}{s.workflow && <span className="count">{s.workflow}</span>}
            </button>
          ))}
          <Button needs="admin" variant="ghost" size="sm" onClick={() => setAdding(true)}><Plus size={13} /> Connect repository</Button>
        </div>
        {current ? (
          <>
            <AutoImport key={current.id} source={current} />
            <WorkflowRuns key={current.id} source={current} />
            <div className="row faint" style={{ fontSize: "var(--fs-sm)" }}>
              <span>
                {current.artifact_pattern ? <>Artifacts matching <code className="inline">{current.artifact_pattern}</code></> : "All artifacts"} are scanned for .xml and .json reports.
              </span>
              <span className="spacer" />
              <Button needs="admin" variant="danger" size="sm" onClick={async () => (await confirm({ title: `Disconnect ${current.owner}/${current.repo}?`, body: <p style={{ margin: 0 }}>Imported runs are kept.</p>, confirmLabel: "Disconnect" })) && remove.mutate(current.id)}>
                <Trash2 size={12} /> Disconnect
              </Button>
            </div>
          </>
        ) : (
          <div className="muted" style={{ fontSize: "var(--fs-md)", padding: "12px 0" }}>
            Connect a repository to list its workflow runs and import the test reports they upload as artifacts.
          </div>
        )}
      </div>
      {adding && <AddSourceModal onClose={() => setAdding(false)} onAdded={(id) => setActive(id)} />}
    </div>
  );
}

/** Imports new workflow runs by itself, so nobody has to click Import after every CI run. */
function AutoImport({ source }: { source: GithubSource }) {
  const canAdmin = useCan("admin");
  const { pid } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState(source.branch_filter);
  const [sprint, setSprint] = useState(source.default_milestone);
  const [auditWf, setAuditWf] = useState(source.audit_workflows);
  const { data: milestones = [] } = useQuery({ queryKey: ["milestones", pid], queryFn: () => api.get<Milestone[]>(`/api/projects/${pid}/milestones`) });
  const on = !!source.auto_import;

  const refresh = () => {
    for (const k of ["gh-sources", "gh-runs", "runs", "automated", "dashboard", "milestones", "insights"]) qc.invalidateQueries({ queryKey: [k] });
    qc.invalidateQueries({ queryKey: ["projects"] });
  };
  const save = useMutation({
    mutationFn: (body: Partial<{ autoImport: boolean; branchFilter: string; defaultMilestone: string; auditWorkflows: string }>) => api.patch<GithubSource>(`/api/github-sources/${source.id}`, body),
    onSuccess: (s) => { refresh(); setAuditWf(s.audit_workflows); },
    onError: (e: Error) => toast("error", e.message),
  });
  const check = useMutation({
    mutationFn: () => api.post<CheckResult>(`/api/github-sources/${source.id}/check`),
    onSuccess: (r) => {
      refresh();
      if (r.error) toast("error", r.error);
      else toast("success", [r.imported ? `Imported ${r.imported} new ${r.imported === 1 ? "run" : "runs"}` : "No new runs", r.audits ? `${r.audits} audit ${r.audits === 1 ? "package" : "packages"} (see Bug reports)` : "", r.auditsRejected ? `${r.auditsRejected} audit ${r.auditsRejected === 1 ? "package" : "packages"} refused (see Bug reports, Audits)` : "", r.auditsBlocked ? `${r.auditsBlocked} audit ${r.auditsBlocked === 1 ? "package" : "packages"} left alone (workflow not allowed)` : ""].filter(Boolean).join(" · "));
    },
    onError: (e: Error) => toast("error", e.message),
  });

  return (
    <div className="card" style={{ background: "var(--bg)", padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
      <label className="row" style={{ cursor: "pointer" }}>
        <input type="checkbox" className="checkbox" disabled={!canAdmin} checked={on} onChange={(e) => save.mutate({ autoImport: e.target.checked })} />
        <span style={{ fontWeight: 500 }}>Import new runs automatically</span>
        <span className="spacer" />
        {on && (
          <span className="faint" style={{ fontSize: "var(--fs-sm)", color: source.last_error ? "var(--failed-fg)" : undefined }} title={source.last_error || undefined}>
            {source.last_error ? "Last check failed" : source.last_checked_at ? `Checked ${timeAgo(source.last_checked_at)}` : "Waiting for the first check"}
          </span>
        )}
      </label>
      {on && (
        <>
          <div className="row" style={{ gap: 12 }}>
            <div className="field grow">
              <label htmlFor="af">Only these branches</label>
              <input
                id="af" className="input" placeholder="All branches, or e.g. main, release/*" value={filter}
                disabled={!canAdmin} onChange={(e) => setFilter(e.target.value)} onBlur={() => filter.trim() !== source.branch_filter && save.mutate({ branchFilter: filter })}
              />
            </div>
            <div className="field grow">
              <label htmlFor="as">Sprint / release for these runs</label>
              <input
                id="as" className="input" list="auto-milestones" placeholder="Optional" value={sprint}
                disabled={!canAdmin} onChange={(e) => setSprint(e.target.value)} onBlur={() => sprint.trim() !== source.default_milestone && save.mutate({ defaultMilestone: sprint })}
              />
              <datalist id="auto-milestones">{milestones.map((m) => <option key={m.id} value={m.name} />)}</datalist>
            </div>
          </div>
          <div className="field">
            <label htmlFor="aw">Workflows allowed to deliver audit packages</label>
            <input
              id="aw" className="input" placeholder="e.g. audit.yml, 12345678 (workflow file name or id)" value={auditWf}
              disabled={!canAdmin} onChange={(e) => setAuditWf(e.target.value)} onBlur={() => auditWf.trim() !== source.audit_workflows && save.mutate({ auditWorkflows: auditWf })}
            />
            <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
              Only artifacts named testbench-audit-* from these workflows are imported as audit packages. Empty means no audit packages are imported from this repository.
            </span>
          </div>
          <div className="row">
            <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
              Checked every 5 minutes while TestBench is running. Only runs created after {source.auto_since ? formatDateTime(source.auto_since) : "you switched this on"} are
              imported automatically; older runs need Import below.
            </span>
            <span className="spacer" />
            <Button needs="admin" size="sm" disabled={check.isPending} onClick={() => check.mutate()}>
              {check.isPending ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} Check now
            </Button>
          </div>
          {source.last_error && <div style={{ color: "var(--failed-fg)", fontSize: "var(--fs-md)" }}>{source.last_error}</div>}
          <div className="faint" style={{ fontSize: "var(--fs-sm)" }} title={source.last_skip_note || undefined}>
            {source.imported_count || source.skipped_count
              ? `Imported ${source.imported_count ?? 0} automatically${source.skipped_count ? ` · skipped ${source.skipped_count} with no test reports (hover for why)` : ""}`
              : "Nothing imported automatically yet."}
          </div>
        </>
      )}
    </div>
  );
}

function WorkflowRuns({ source }: { source: GithubSource }) {
  const { pid } = useParams();
  const toast = useToast();
  const done = useImportDone();
  const { data: runs, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["gh-runs", source.id],
    queryFn: () => api.get<WorkflowRun[]>(`/api/github-sources/${source.id}/runs`),
    staleTime: 30_000,
  });
  const [importing, setImporting] = useState<number | null>(null);
  const importRun = async (runId: number) => {
    setImporting(runId);
    try {
      done(await api.post<ImportResult>(`/api/github-sources/${source.id}/runs/${runId}/import`));
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setImporting(null);
    }
  };

  if (isLoading) return <div className="row muted"><Loader2 size={14} className="spin" /> Loading workflow runs…</div>;
  if (error) return <div style={{ color: "var(--failed-fg)", fontSize: "var(--fs-md)" }}>{(error as Error).message}</div>;
  if (!runs?.length) return <div className="muted">No workflow runs found.</div>;

  return (
    <div className="card" style={{ background: "var(--bg)", maxHeight: 420, overflow: "auto" }}>
      <div className="group-header" style={{ padding: "0 12px" }}>
        Workflow runs on GitHub <span className="count">{runs.length}</span>
        <span className="spacer" />
        <Button variant="ghost" size="sm" icon onClick={() => refetch()} aria-label="Refresh"><RefreshCw size={12} className={isFetching ? "spin" : ""} /></Button>
      </div>
      {runs.map((r) => (
        <div key={r.id} className="list-row" style={{ height: 50, padding: "0 12px", cursor: "default" }}>
          <ConclusionIcon run={r} />
          <div className="grow col" style={{ gap: 1 }}>
            <span className="truncate">{r.display_title}</span>
            <span className="row faint" style={{ fontSize: "var(--fs-sm)", gap: 6, whiteSpace: "nowrap", overflow: "hidden" }}>
              <span>{r.name} #{r.run_number}</span>·<GitBranch size={10} style={{ flexShrink: 0 }} />
              <span className="truncate" style={{ maxWidth: 180 }}>{r.head_branch}</span>·<span>{timeAgo(r.created_at)}</span>
              {r.artifact_count === 0 && <span style={{ color: "var(--blocked-fg)" }} title="This run uploaded no test artifacts, so there is nothing to import">· no test artifacts</span>}
            </span>
          </div>
          {r.imported_run_id ? (
            <Link to={`/p/${pid}/runs/${r.imported_run_id}`} className={buttonClass("secondary", "sm")}>View run</Link>
          ) : (
            <Button needs="tester" size="sm"
              disabled={r.status !== "completed" || importing != null || r.artifact_count === 0}
              onClick={() => importRun(r.id)}
              title={r.status !== "completed" ? "Still running" : r.artifact_count === 0 ? "No test artifacts on this run. Add an upload-artifact step to the workflow (see Setup below)." : undefined}
            >
              {importing === r.id ? <Loader2 size={12} className="spin" /> : <Download size={12} />} Import
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

function ConclusionIcon({ run }: { run: WorkflowRun }) {
  const style = { flexShrink: 0 };
  if (run.status !== "completed") return <Loader2 size={14} className="spin" style={{ ...style, color: "var(--blocked-fg)" }} />;
  if (run.conclusion === "success") return <CheckCircle2 size={14} style={{ ...style, color: "var(--passed-fg)" }} />;
  if (run.conclusion === "failure") return <XCircle size={14} style={{ ...style, color: "var(--failed-fg)" }} />;
  return <XCircle size={14} style={{ ...style, color: "var(--skipped)" }} />;
}

function AddSourceModal({ onClose, onAdded }: { onClose: () => void; onAdded: (id: number) => void }) {
  const { pid } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [repo, setRepo] = useState("");
  const [workflow, setWorkflow] = useState("");
  const [artifactPattern, setArtifactPattern] = useState("");
  const [auditWorkflows, setAuditWorkflows] = useState("");
  const add = useMutation({
    mutationFn: () =>
      api.post<GithubSource>(`/api/projects/${pid}/github-sources`, {
        repo: repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, ""),
        workflow,
        artifactPattern,
        auditWorkflows,
      }),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ["gh-sources", pid] });
      onAdded(s.id);
      onClose();
    },
    onError: (e: Error) => toast("error", e.message),
  });
  return (
    <Modal
      title="Connect a GitHub repository"
      onClose={onClose}
      width={480}
      footer={<Button needs="admin" variant="primary" disabled={!repo.trim() || add.isPending} onClick={() => add.mutate()}>Connect</Button>}
    >
      <div className="field">
        <label htmlFor="repo">Repository</label>
        <input id="repo" className="input" autoFocus placeholder="owner/repo" value={repo} onChange={(e) => setRepo(e.target.value)} onKeyDown={(e) => e.key === "Enter" && repo.trim() && add.mutate()} />
      </div>
      <div className="field">
        <label htmlFor="wf">Workflow file (optional)</label>
        <input id="wf" className="input" placeholder="e2e.yml — leave empty for all workflows" value={workflow} onChange={(e) => setWorkflow(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ap">Artifact names (optional)</label>
        <input id="ap" className="input" placeholder="test-results*, junit-*" value={artifactPattern} onChange={(e) => setArtifactPattern(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="aw0">Workflows allowed to deliver audit packages (optional)</label>
        <input id="aw0" className="input" placeholder="audit.yml — empty means no audit packages are imported" value={auditWorkflows} onChange={(e) => setAuditWorkflows(e.target.value)} />
      </div>
    </Modal>
  );
}

function SetupGuide() {
  const { pid } = useParams();
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });
  const key = projects?.find((p) => p.id === Number(pid))?.key ?? "KEY";
  const [tab, setTab] = useState<"playwright" | "testcafe" | "selenium" | "bruno">("playwright");
  const snippets = {
    playwright: `// playwright.config.ts
reporter: [
  ["html"],
  ["json", { outputFile: "results.json" }],
],
// Evidence shown in Testbench next to a failing test:
use: { trace: "retain-on-failure", screenshot: "only-on-failure", video: "retain-on-failure" },

// tests/login.spec.ts — the @${key}-1 tag links the test to case ${key}-1
test("@${key}-1 logs in with valid credentials", async ({ page }) => { … });
// or: test("logs in", { tag: "@${key}-1" }, async ({ page }) => { … });`,
    testcafe: `# npm i -D testcafe-reporter-xunit
npx testcafe chrome tests/ --reporter spec,xunit:test-results/xunit.xml

// tests/login.js
test("@${key}-1 logs in with valid credentials", async (t) => { … });`,
    selenium: `# pytest
pytest --junitxml=test-results/junit.xml

# Maven (Surefire writes target/surefire-reports/*.xml)
mvn test

# Put @${key}-1 in the test name or display name to link it.`,
    bruno: `# npm i -g @usebruno/cli — run the collection and write a JUnit report
bru run --env ci --reporter-junit test-results/bruno.xml

// In a request's Tests tab, put @${key}-1 in the test name to link it:
test("@${key}-1 returns the user", function () {
  expect(res.getStatus()).to.equal(200);
});`,
  };
  const workflow = `# .github/workflows/e2e.yml — add after the test step
- uses: actions/upload-artifact@v4
  if: \${{ !cancelled() }}
  with:
    name: test-results
    path: |
      results.json
      test-results/`;
  return (
    <div className="card">
      <div className="card-header" role="heading" aria-level={2}>Setup</div>
      <div className="card-body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(380px, 100%), 1fr))", gap: 16 }}>
        <div className="col">
          <div className="row">
            <span className="section-label" style={{ margin: 0 }}>1. Write a machine-readable report</span>
            <span className="spacer" />
            <div className="tabs">
              {(["playwright", "testcafe", "selenium", "bruno"] as const).map((t) => (
                <button key={t} className={`tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
              ))}
            </div>
          </div>
          <pre className="snippet">{snippets[tab]}</pre>
        </div>
        <div className="col">
          <span className="section-label" style={{ margin: 0, height: 26 }}>2. Upload it as an artifact in GitHub Actions</span>
          <pre className="snippet">{workflow}</pre>
          <span className="muted" style={{ fontSize: "var(--fs-sm)" }}>Then connect the repository above and click Import on a run. Artifacts expire after 90 days by default.</span>
        </div>
      </div>
    </div>
  );
}
