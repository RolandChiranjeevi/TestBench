import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, BookOpenCheck, Bot, ChevronDown, Download, FileBarChart, FlaskConical, LayoutDashboard, ListChecks, LogOut, Menu, Pencil, Play, Plus, Sparkles, Trash2 } from "lucide-react";
import { api, timeAgo, type BackupInfo, type Project } from "./api";
import { ConfirmModal, Empty, Modal, ToastProvider, useHotkeys, useToast } from "./components/ui";
import { CasesPage } from "./pages/Cases";
import { RequirementsPage } from "./pages/Requirements";
import { RunsPage } from "./pages/Runs";
import { RunDetailPage } from "./pages/RunDetail";
import { AutomatedPage } from "./pages/Automated";
import { ImportPage } from "./pages/Import";
import { DashboardPage } from "./pages/Dashboard";
import { ReportsPage } from "./pages/Reports";
import { BackupPage } from "./pages/Backup";
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
          <span className="muted" style={{ fontSize: 12 }}>
            Case IDs look like <code className="inline">{derivedKey || "KEY"}-12</code>. Put <code className="inline">@{derivedKey || "KEY"}-12</code> in an automated test's title to link it.
          </span>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function RenameProjectModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const qc = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: () => api.patch<Project>(`/api/projects/${project.id}`, { name: name.trim() }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const valid = !!name.trim() && name.trim() !== project.name;
  return (
    <Modal
      title="Rename project"
      onClose={onClose}
      width={440}
      footer={<button className="btn primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>Save</button>}
    >
      <form className="col" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(); }}>
        <div className="field">
          <label htmlFor="rname">Name</label>
          <input id="rname" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          <span className="muted" style={{ fontSize: 12 }}>
            The key <code className="inline">{project.key}</code> stays the same, because case IDs and <code className="inline">@{project.key}-12</code> tags in your tests use it.
          </span>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** Deleting a project is permanent: the key has to be typed, and the server saves a backup first when automatic backups are on. */
function DeleteProjectModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: backup } = useQuery({ queryKey: ["backup-info"], queryFn: () => api.get<BackupInfo>("/api/backup/info"), staleTime: 60_000 });
  const { data: preview } = useQuery({
    queryKey: ["deletion-preview", project.id],
    queryFn: () => api.get<{ counts: { cases: number; runs: number; requirements: number; automatedTests: number } }>(`/api/projects/${project.id}/deletion-preview`),
  });
  const del = useMutation({
    mutationFn: () => api.post<{ name: string; deleted: { cases: number; runs: number }; backup: string | null }>(`/api/projects/${project.id}/delete`, { confirm: project.key }),
    onSuccess: (r) => {
      qc.clear();
      toast("success", `Deleted "${r.name}" (${r.deleted.cases} cases, ${r.deleted.runs} runs).${r.backup ? ` A backup was saved first (${r.backup}).` : ""}`);
      onClose();
      navigate("/");
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const c = preview?.counts;
  return (
    <ConfirmModal
      title={`Delete "${project.name}"?`}
      confirmLabel="Delete project permanently"
      requireText={project.key}
      busy={del.isPending}
      onConfirm={() => del.mutate()}
      onClose={onClose}
    >
      <p style={{ margin: 0 }}>
        This permanently deletes the project and everything in it
        {c ? `: ${c.cases} test cases, ${c.runs} runs, ${c.requirements} requirements and ${c.automatedTests} automated tests` : ""}.
        Sprints, templates, the release checklists, and all uploaded screenshots, traces and attachments go too.
      </p>
      <p className="muted" style={{ margin: 0 }}>
        {backup?.auto.enabled
          ? "A backup is saved first. To get the project back, restore that backup from Backup & restore."
          : "Automatic backups are turned off, so nothing is saved first. This cannot be undone."}
      </p>
    </ConfirmModal>
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
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { data: auth } = useQuery({ queryKey: ["auth"], queryFn: () => api.get<{ enabled: boolean; authenticated: boolean }>("/api/auth/status"), staleTime: 60_000 });
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
    const label = ({ dashboard: "Dashboard", requirements: "Requirements", cases: "Test cases", runs: "Runs", automated: "Automated tests", import: "Import results", reports: "Sprint reports", backup: "Backup & restore" } as Record<string, string>)[section];
    document.title = [label, project?.name, "Testbench"].filter(Boolean).join(" · ");
    return () => { document.title = "Testbench"; };
  }, [section, project?.name]);

  useHotkeys({
    "1": () => navigate(`/p/${pid}/dashboard`),
    "2": () => navigate(`/p/${pid}/requirements`),
    "3": () => navigate(`/p/${pid}/cases`),
    "4": () => navigate(`/p/${pid}/runs`),
    "5": () => navigate(`/p/${pid}/automated`),
    "6": () => navigate(`/p/${pid}/import`),
    "7": () => navigate(`/p/${pid}/reports`),
    "8": () => navigate(`/p/${pid}/backup`),
  });

  if (isLoading) return null;
  if (!project) return <Navigate to="/" replace />;

  const link = (to: string, icon: ReactNode, label: string, shortcut: string) => (
    <NavLink to={`/p/${project.id}/${to}`} className={({ isActive }) => `nav-item${isActive ? " active" : ""}`} title={label}>
      {icon}
      <span className="nav-label">{label}</span>
      <span className="count"><kbd className="kbd">{shortcut}</kbd></span>
    </NavLink>
  );

  return (
    <div className="app">
      <header className="mobile-bar">
        <button className="btn ghost icon" aria-label="Open navigation menu" aria-expanded={navOpen} onClick={() => setNavOpen(true)}>
          <Menu size={18} />
        </button>
        <span className="project-badge">{project.key.slice(0, 2)}</span>
        <span className="truncate" style={{ fontWeight: 600 }}>{project.name}</span>
      </header>
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
      <aside className={`sidebar${navOpen ? " open" : ""}`}>
        <div style={{ position: "relative" }}>
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
                <button className="nav-item" onClick={() => { setMenu(false); setRenaming(true); }}>
                  <Pencil size={14} /> Rename this project
                </button>
                <button className="nav-item" onClick={() => { setMenu(false); setCreating(true); }}>
                  <Plus size={14} /> New project
                </button>
                <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />
                <button className="nav-item" style={{ color: "var(--failed-fg)" }} onClick={() => { setMenu(false); setDeleting(true); }}>
                  <Trash2 size={14} /> Delete this project…
                </button>
              </div>
            </>
          )}
        </div>

        <div className="sidebar-section">Workspace</div>
        {link("dashboard", <LayoutDashboard size={15} />, "Dashboard", "1")}
        {link("requirements", <BookOpenCheck size={15} />, "Requirements", "2")}
        {link("cases", <ListChecks size={15} />, "Test cases", "3")}
        {link("runs", <Play size={15} />, "Runs", "4")}
        {link("automated", <Bot size={15} />, "Automated tests", "5")}
        {link("import", <Download size={15} />, "Import results", "6")}
        <div className="sidebar-section">Reporting</div>
        {link("reports", <FileBarChart size={15} />, "Sprint reports", "7")}
        <div className="sidebar-section">Data</div>
        {link("backup", <Archive size={15} />, "Backup & restore", "8")}

        <div className="sidebar-footer">
          {/* Nudge when there is no recent backup: the data lives only on this computer. */}
          {backup && (
            <NavLink
              to={`/p/${project.id}/backup`}
              className="row"
              title={backup.lastBackupAt ? `Backed up ${timeAgo(backup.lastBackupAt)}` : "Not backed up yet"}
              style={{ gap: 6, marginBottom: 4, color: !backup.lastBackupAt || Date.now() - new Date(backup.lastBackupAt).getTime() > 7 * 864e5 ? "var(--blocked-fg)" : undefined }}
            >
              <Archive size={12} /> <span className="nav-label">{backup.lastBackupAt ? `Backed up ${timeAgo(backup.lastBackupAt)}` : "Not backed up yet"}</span>
            </NavLink>
          )}
          <span className="footer-text">{project.case_count} cases · {project.run_count} runs</span>
          {auth?.enabled && (
            <button className="btn ghost sm signout" title="Sign out" style={{ marginTop: 6 }} onClick={async () => { await api.post("/api/logout"); window.location.href = "/login"; }}>
              <LogOut size={13} /> <span className="nav-label">Sign out</span>
            </button>
          )}
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
      {renaming && <RenameProjectModal project={project} onClose={() => setRenaming(false)} />}
      {deleting && <DeleteProjectModal project={project} onClose={() => setDeleting(false)} />}
    </div>
  );
}

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: true, staleTime: 5_000, retry: 1 } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/p/:pid" element={<ProjectLayout />}>
              <Route index element={<Navigate to="dashboard" replace />} />
              <Route path="dashboard" element={<DashboardPage />} />
              <Route path="backup" element={<BackupPage />} />
              <Route path="reports" element={<ReportsPage />} />
              <Route path="reports/:mid" element={<ReportsPage />} />
              <Route path="requirements" element={<RequirementsPage />} />
              <Route path="cases" element={<CasesPage />} />
              <Route path="runs" element={<RunsPage />} />
              <Route path="runs/:runId" element={<RunDetailPage />} />
              <Route path="automated" element={<AutomatedPage />} />
              <Route path="import" element={<ImportPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
