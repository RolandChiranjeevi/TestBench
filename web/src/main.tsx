import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ChevronDown, FlaskConical, Menu, Plus, Sparkles } from "lucide-react";
import { api, parseDate, timeAgo, type BackupInfo, type Project } from "./api";
import { ConfirmProvider, Empty, Modal, ToastProvider, useHotkeys, useToast } from "./components/ui";
import { CasesPage } from "./pages/Cases";
import { RequirementsPage } from "./pages/Requirements";
import { RunsPage } from "./pages/Runs";
import { RunDetailPage } from "./pages/RunDetail";
import { AutomatedPage } from "./pages/Automated";
import { ImportPage } from "./pages/Import";
import { DashboardPage } from "./pages/Dashboard";
import { ReportsPage } from "./pages/Reports";
import { SettingsPage } from "./pages/Settings";
import { applyTheme } from "./theme";
import { NAV_SHORTCUTS } from "./shortcuts";
import { SidebarNav } from "./components/SidebarNav";
import { BugReportsPage } from "./pages/BugReports";
import { ManualTestsPage } from "./pages/ManualTests";
import { TestPlanPage } from "./pages/TestPlan";
import { ObservationsPage } from "./pages/Observations";
import { useObservationSummary } from "./observations";
import "./styles.css";

const LAST_PROJECT = "testbench:lastProject";
const storage = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

const useProjects = () => useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });

function Home() {
  const { data, isLoading } = useProjects();
  if (isLoading) return null;
  if (!data?.length) return <Welcome />;
  const last = Number(storage.get(LAST_PROJECT));
  const project = data.find((p) => p.id === last) ?? data[0];
  return <Navigate to={`/p/${project.id}/dashboard`} replace />;
}

function Welcome() {
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const demo = useMutation({
    mutationFn: () => api.post<Project>("/api/demo"),
    onSuccess: async (p) => {
      await qc.invalidateQueries({ queryKey: ["projects"] });
      navigate(`/p/${p.id}/cases`);
    },
    onError: (e: Error) => toast("error", e.message),
  });
  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
      <Empty
        icon={<FlaskConical size={20} />}
        title="Welcome to Testbench"
        action={
          <div className="row">
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Plus size={14} /> Create project
            </button>
            <button className="btn" onClick={() => demo.mutate()} disabled={demo.isPending}>
              <Sparkles size={14} /> Load demo project
            </button>
          </div>
        }
      >
        Write manual test cases, run them, and bring in Playwright, TestCafe and Selenium results from GitHub Actions.
      </Empty>
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const derivedKey = keyTouched
    ? key
    : name.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).map((w) => w[0]).join("").toUpperCase().replace(/^[0-9]+/, "").slice(0, 4);
  const valid = !!name.trim() && /^[A-Z][A-Z0-9]{0,9}$/.test(derivedKey);
  const create = useMutation({
    mutationFn: () => api.post<Project>("/api/projects", { name, key: derivedKey }),
    onSuccess: async (p) => {
      await qc.invalidateQueries({ queryKey: ["projects"] });
      onClose();
      navigate(`/p/${p.id}/cases`);
    },
    onError: (e: Error) => toast("error", e.message),
  });
  return (
    <Modal
      title="New project"
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
            Create project
          </button>
        </>
      }
    >
      <form className="col" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); if (valid) create.mutate(); }}>
        <div className="field">
          <label htmlFor="pname">Name</label>
          <input id="pname" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Web shop" />
        </div>
        <div className="field">
          <label htmlFor="pkey">Key</label>
          <input
            id="pkey"
            className="input mono"
            value={derivedKey}
            maxLength={10}
            onChange={(e) => { setKeyTouched(true); setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "")); }}
            placeholder="WS"
          />
          <span className="muted" style={{ fontSize: "var(--fs-sm)" }}>
            Case IDs look like <code className="inline">{derivedKey || "KEY"}-12</code>. Put <code className="inline">@{derivedKey || "KEY"}-12</code> in an automated test's title to link it.
          </span>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function ProjectLayout() {
  const { data: projects, isLoading } = useProjects();
  const { pid } = useParams();
  const project = projects?.find((p) => p.id === Number(pid));
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const { data: backup } = useQuery({ queryKey: ["backup-info"], queryFn: () => api.get<BackupInfo>("/api/backup/info"), staleTime: 60_000 });
  const [creating, setCreating] = useState(false);
  // On phone-sized screens the sidebar is a menu that slides over the page. Any navigation or Escape closes it.
  const loc = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => setNavOpen(false), [loc.pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setNavOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  useEffect(() => {
    if (pid) storage.set(LAST_PROJECT, pid);
  }, [pid]);

  // Browser tab title: "Test cases · Demo Shop · Testbench", so tabs, history and screen readers say where you are.
  const section = loc.pathname.split("/")[3] ?? "";
  useEffect(() => {
    const label = NAV_SHORTCUTS.find((s) => s.to === section)?.label;
    document.title = [label, project?.name, "Testbench"].filter(Boolean).join(" · ");
    return () => { document.title = "Testbench"; };
  }, [section, project?.name]);

  useHotkeys(Object.fromEntries(NAV_SHORTCUTS.map((s) => [s.key, () => navigate(`/p/${pid}/${s.to}`)])), true, { yieldToPages: true });
  // How many reports from test agents wait for a decision (the same query the Bug reports page uses for its default tab).
  const { data: proposedBugs } = useQuery({ queryKey: ["bug-reports", pid, "proposed"], queryFn: () => api.get<{ counts: Record<string, number> }>(`/api/projects/${pid}/bug-reports?status=proposed`), staleTime: 30_000, enabled: !!pid });

  // Proposals (manual test cases) from the agent that wait for a decision.
  const { data: proposedManual } = useQuery({ queryKey: ["manual-tests", pid, "proposed"], queryFn: () => api.get<{ counts: Record<string, number> }>(`/api/projects/${pid}/manual-tests?status=proposed`), staleTime: 30_000, enabled: !!pid });

  // Active observations (load tests, security reviews that are still being looked at: observed, needs review, confirmed). Archived, resolved and converted are not counted.
  const { data: obsSummary } = useObservationSummary(pid);

  if (isLoading) return null;
  if (!project) return <Navigate to="/" replace />;

  // The numbers beside some pages: what waits for a decision, and what is still active.
  const navCounts = {
    "manual-tests": { n: proposedManual?.counts.proposed ?? 0, meaning: "waiting for review" },
    observations: { n: obsSummary?.active ?? 0, meaning: "active" },
    bugs: { n: proposedBugs?.counts.proposed ?? 0, meaning: "waiting for review" },
  };

  return (
    <div className="app">
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>
      <header className="mobile-bar">
        <button className="btn ghost icon" aria-label="Open navigation menu" aria-expanded={navOpen} onClick={() => setNavOpen(true)}>
          <Menu size={18} />
        </button>
        <span className="project-badge">{project.key.slice(0, 2)}</span>
        <span className="truncate" style={{ fontWeight: 600 }}>{project.name}</span>
      </header>
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
      <aside className={`sidebar${navOpen ? " open" : ""}`}>
        <div className="brand">
          <img src="/apple-touch-icon.png" alt="" width={28} height={28} />
          <span className="brand-name">Testbench</span>
        </div>
        <div className="project-wrap" style={{ position: "relative" }}>
          <button className="project-switch" onClick={() => setMenu((m) => !m)} aria-expanded={menu}>
            <span className="project-badge">{project.key.slice(0, 2)}</span>
            <span className="truncate">{project.name}</span>
            <ChevronDown size={13} className="muted" />
          </button>
          {menu && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 9 }} onClick={() => setMenu(false)} />
              <div className="card project-menu" style={{ position: "absolute", top: 38, left: 0, right: 0, zIndex: 10, padding: 4, boxShadow: "var(--shadow)", background: "var(--bg-elev)" }}>
                {projects?.map((p) => (
                  <button key={p.id} className={`nav-item${p.id === project.id ? " active" : ""}`} onClick={() => { setMenu(false); navigate(`/p/${p.id}/cases`); }}>
                    <span className="project-badge">{p.key.slice(0, 2)}</span>
                    <span className="truncate">{p.name}</span>
                  </button>
                ))}
                <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />
                <button className="nav-item" onClick={() => { setMenu(false); setCreating(true); }}>
                  <Plus size={14} /> New project
                </button>
              </div>
            </>
          )}
        </div>

        <SidebarNav pid={project.id} counts={navCounts} />

        <div className="sidebar-footer">
          {/* Nudge when there is no recent backup: the data lives only on this computer. */}
          {backup && (() => {
            const last = parseDate(backup.lastBackupAt);
            const stale = !last || Date.now() - last.getTime() > 7 * 864e5;
            const text = last ? `Backed up ${timeAgo(backup.lastBackupAt)}` : "Not backed up yet";
            return (
              <NavLink to={`/p/${project.id}/settings/data`} className={`backup-nudge${stale ? " stale" : ""}`} title={`${text}. Open Settings, Data`} aria-label={`${text}. Open Settings, Data`}>
                <Archive size={14} /> <span className="nav-label">{text}</span>
              </NavLink>
            );
          })()}
          <span className="footer-text">{project.case_count} cases · {project.run_count} runs</span>
        </div>
      </aside>
      <main className="main" id="main" tabIndex={-1}>
        <Outlet />
      </main>
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
    </div>
  );
}

applyTheme();

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: true, staleTime: 5_000, retry: 1 } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ConfirmProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/p/:pid" element={<ProjectLayout />}>
              <Route index element={<Navigate to="dashboard" replace />} />
              <Route path="dashboard" element={<DashboardPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="settings/:section" element={<SettingsPage />} />
              <Route path="backup" element={<Navigate to="../settings/data" replace />} />
              <Route path="reports" element={<ReportsPage />} />
              <Route path="reports/:mid" element={<ReportsPage />} />
              <Route path="requirements" element={<RequirementsPage />} />
              <Route path="cases" element={<CasesPage />} />
              <Route path="runs" element={<RunsPage />} />
              <Route path="runs/:runId" element={<RunDetailPage />} />
              <Route path="automated" element={<AutomatedPage />} />
              <Route path="import" element={<ImportPage />} />
              <Route path="bugs" element={<BugReportsPage />} />
              <Route path="manual-tests" element={<ManualTestsPage />} />
              <Route path="test-plan" element={<TestPlanPage />} />
              <Route path="observations" element={<ObservationsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
