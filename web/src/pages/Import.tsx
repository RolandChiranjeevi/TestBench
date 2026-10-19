import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, FileUp, GitBranch, Loader2, Plus, RefreshCw, Trash2, Upload, XCircle } from "lucide-react";
import { api, timeAgo, type GithubSource, type ImportResult, type Project, type WorkflowRun } from "../api";
import { Github, Modal, useToast } from "../components/ui";

export function ImportPage() {
  return (
    <>
      <div className="topbar">
        <h1>Import results</h1>
      </div>
      <div className="content">
        <div style={{ padding: 20, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 16, alignItems: "start", maxWidth: 1400 }}>
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
    if (r.duplicate) toast("success", "Already imported, opening the existing run");
    else toast("success", `Imported ${r.total} tests, ${r.linked} linked to cases`);
    navigate(`/p/${pid}/runs/${r.runId}`);
  };
}

function UploadCard() {
  const { pid } = useParams();
  const toast = useToast();
  const done = useImportDone();
  const [files, setFiles] = useState<File[]>([]);
  const [framework, setFramework] = useState("");
  const [title, setTitle] = useState("");
  const [environment, setEnvironment] = useState("");
  const [milestone, setMilestone] = useState("");
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      // Fields go first so the server has the framework hint before it parses files.
      fd.append("framework", framework);
      fd.append("title", title);
      fd.append("environment", environment);
      fd.append("milestone", milestone);
      files.forEach((f) => fd.append("file", f, f.name));
      return api.post<ImportResult>(`/api/projects/${pid}/import`, fd);
    },
    onSuccess: done,
    onError: (e: Error) => toast("error", e.message),
  });

  const add = (list: FileList | null) => list && setFiles((f) => [...f, ...[...list].filter((x) => /\.(xml|json)$/i.test(x.name))]);

  return (
    <div className="card">
      <div className="card-header"><FileUp size={15} /> Upload a report</div>
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
          <div style={{ marginTop: 6, color: "var(--text)" }}>Drop JUnit XML or Playwright JSON files</div>
          <div style={{ fontSize: 12 }}>Several files are merged into one run (e.g. one per browser)</div>
          <input ref={input} type="file" multiple hidden accept=".xml,.json" onChange={(e) => add(e.target.files)} />
        </div>
        {files.length > 0 && (
          <div className="col" style={{ gap: 4 }}>
            {files.map((f, i) => (
              <div key={i} className="row" style={{ fontSize: 12.5 }}>
                <FileUp size={13} className="faint" />
                <span className="mono truncate grow">{f.name}</span>
                <span className="faint">{Math.max(1, Math.round(f.size / 1024))} KB</span>
                <button className="btn ghost icon sm" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
        )}
        <div className="row" style={{ gap: 10 }}>
          <div className="field grow">
            <label htmlFor="fw">Framework</label>
            <select id="fw" className="select" value={framework} onChange={(e) => setFramework(e.target.value)}>
              <option value="">Detect automatically</option>
              <option value="playwright">Playwright</option>
              <option value="testcafe">TestCafe</option>
              <option value="selenium">Selenium</option>
              <option value="junit">Other (JUnit)</option>
            </select>
          </div>
          <div className="field grow">
            <label htmlFor="rt">Run title</label>
            <input id="rt" className="input" placeholder="Defaults to framework + file name" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <div className="field grow">
            <label htmlFor="renv">Environment</label>
            <input id="renv" className="input" placeholder="staging" value={environment} onChange={(e) => setEnvironment(e.target.value)} />
          </div>
          <div className="field grow">
            <label htmlFor="rms">Sprint / release</label>
            <input id="rms" className="input" placeholder="Sprint 42" value={milestone} onChange={(e) => setMilestone(e.target.value)} />
          </div>
        </div>
        <div className="row">
          <span className="spacer" />
          <button className="btn primary" disabled={!files.length || upload.isPending} onClick={() => upload.mutate()}>
            {upload.isPending ? <Loader2 size={14} className="spin" /> : <Download size={14} />} Import{files.length > 1 ? ` ${files.length} files` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

function GithubCard() {
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
      <div className="card-header">
        <Github size={15} /> GitHub Actions
        <span className="spacer" />
        {status && (
          <span className="row faint" style={{ fontSize: 12, fontWeight: 400, gap: 4 }}>
            {status.authenticated ? <CheckCircle2 size={12} style={{ color: "var(--passed)" }} /> : <XCircle size={12} style={{ color: "var(--failed)" }} />}
            {status.authenticated ? `Authenticated via ${status.via}` : "Not authenticated"}
          </span>
        )}
      </div>
      <div className="card-body col" style={{ gap: 12 }}>
        {status && !status.authenticated && (
          <div className="muted" style={{ fontSize: 12.5 }}>
            Run <code className="inline">gh auth login</code>, or start the server with <code className="inline">GITHUB_TOKEN=…</code>. The token is read from there and never stored.
          </div>
        )}
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          {sources.map((s) => (
            <button key={s.id} className={`tab${current?.id === s.id ? " active" : ""}`} onClick={() => setActive(s.id)}>
              <Github size={12} /> {s.owner}/{s.repo}{s.workflow && <span className="count">{s.workflow}</span>}
            </button>
          ))}
          <button className="btn ghost sm" onClick={() => setAdding(true)}><Plus size={13} /> Connect repository</button>
        </div>
        {current ? (
          <>
            <WorkflowRuns key={current.id} source={current} />
            <div className="row faint" style={{ fontSize: 12 }}>
              <span>
                {current.artifact_pattern ? <>Artifacts matching <code className="inline">{current.artifact_pattern}</code></> : "All artifacts"} are scanned for .xml and .json reports.
              </span>
              <span className="spacer" />
              <button className="btn ghost sm danger" onClick={() => confirm(`Disconnect ${current.owner}/${current.repo}? Imported runs are kept.`) && remove.mutate(current.id)}>
                <Trash2 size={12} /> Disconnect
              </button>
            </div>
          </>
        ) : (
          <div className="muted" style={{ fontSize: 12.5, padding: "12px 0" }}>
            Connect a repository to list its workflow runs and import the test reports they upload as artifacts.
          </div>
        )}
      </div>
      {adding && <AddSourceModal onClose={() => setAdding(false)} onAdded={(id) => setActive(id)} />}
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
  if (error) return <div style={{ color: "var(--failed)", fontSize: 12.5 }}>{(error as Error).message}</div>;
  if (!runs?.length) return <div className="muted">No workflow runs found.</div>;

  return (
    <div className="card" style={{ background: "var(--bg)", maxHeight: 420, overflow: "auto" }}>
      <div className="group-header" style={{ padding: "0 12px" }}>
        Recent runs <span className="count">{runs.length}</span>
        <span className="spacer" />
        <button className="btn ghost icon sm" onClick={() => refetch()} aria-label="Refresh"><RefreshCw size={12} className={isFetching ? "spin" : ""} /></button>
      </div>
      {runs.map((r) => (
        <div key={r.id} className="list-row" style={{ height: 50, padding: "0 12px", cursor: "default" }}>
          <ConclusionIcon run={r} />
          <div className="grow col" style={{ gap: 1 }}>
            <span className="truncate">{r.display_title}</span>
            <span className="row faint" style={{ fontSize: 11.5, gap: 6 }}>
              <span>{r.name} #{r.run_number}</span>·<GitBranch size={10} />{r.head_branch}·<span>{timeAgo(r.created_at)}</span>
            </span>
          </div>
          {r.imported_run_id ? (
            <Link to={`/p/${pid}/runs/${r.imported_run_id}`} className="btn sm">View run</Link>
          ) : (
            <button
              className="btn sm"
              disabled={r.status !== "completed" || importing != null}
              onClick={() => importRun(r.id)}
              title={r.status !== "completed" ? "Still running" : undefined}
            >
              {importing === r.id ? <Loader2 size={12} className="spin" /> : <Download size={12} />} Import
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function ConclusionIcon({ run }: { run: WorkflowRun }) {
  const style = { flexShrink: 0 };
  if (run.status !== "completed") return <Loader2 size={14} className="spin" style={{ ...style, color: "var(--blocked)" }} />;
  if (run.conclusion === "success") return <CheckCircle2 size={14} style={{ ...style, color: "var(--passed)" }} />;
  if (run.conclusion === "failure") return <XCircle size={14} style={{ ...style, color: "var(--failed)" }} />;
  return <XCircle size={14} style={{ ...style, color: "var(--skipped)" }} />;
}

function AddSourceModal({ onClose, onAdded }: { onClose: () => void; onAdded: (id: number) => void }) {
  const { pid } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [repo, setRepo] = useState("");
  const [workflow, setWorkflow] = useState("");
  const [artifactPattern, setArtifactPattern] = useState("");
  const add = useMutation({
    mutationFn: () =>
      api.post<GithubSource>(`/api/projects/${pid}/github-sources`, {
        repo: repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, ""),
        workflow,
        artifactPattern,
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
      footer={<button className="btn primary" disabled={!repo.trim() || add.isPending} onClick={() => add.mutate()}>Connect</button>}
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
    </Modal>
  );
}

function SetupGuide() {
  const { pid } = useParams();
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });
  const key = projects?.find((p) => p.id === Number(pid))?.key ?? "KEY";
  const [tab, setTab] = useState<"playwright" | "testcafe" | "selenium">("playwright");
  const snippets = {
    playwright: `// playwright.config.ts
reporter: [
  ["html"],
  ["json", { outputFile: "test-results/results.json" }],
],

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
  };
  const workflow = `# .github/workflows/e2e.yml — add after the test step
- uses: actions/upload-artifact@v4
  if: \${{ !cancelled() }}
  with:
    name: test-results
    path: test-results/`;
  return (
    <div className="card">
      <div className="card-header">Setup</div>
      <div className="card-body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 16 }}>
        <div className="col">
          <div className="row">
            <span className="section-label" style={{ margin: 0 }}>1. Write a machine-readable report</span>
            <span className="spacer" />
            <div className="tabs">
              {(["playwright", "testcafe", "selenium"] as const).map((t) => (
                <button key={t} className={`tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
              ))}
            </div>
          </div>
          <pre className="snippet">{snippets[tab]}</pre>
        </div>
        <div className="col">
          <span className="section-label" style={{ margin: 0, height: 26 }}>2. Upload it as an artifact in GitHub Actions</span>
          <pre className="snippet">{workflow}</pre>
          <span className="muted" style={{ fontSize: 12 }}>Then connect the repository above and click Import on a run. Artifacts expire after 90 days by default.</span>
        </div>
      </div>
    </div>
  );
}
