import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Download, History, Loader2, RotateCcw, ShieldAlert } from "lucide-react";
import { api, timeAgo, type BackupInfo, type RestoreSummary } from "../api";
import { useToast } from "../components/ui";

const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);

export function BackupPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState<RestoreSummary | null>(null);
  const { data: info } = useQuery({ queryKey: ["backup-info"], queryFn: () => api.get<BackupInfo>("/api/backup/info") });

  const restore = async (file: File) => {
    const ok = confirm(
      `Replace ALL current data with "${file.name}"?\n\nEvery project, case, run and uploaded file is swapped for what's in the backup. ` +
        `Your current data is not deleted: it is moved to the data/previous folder so you can get it back.`,
    );
    if (!ok) return;
    setRestoring(true);
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      const summary = await api.post<RestoreSummary>("/api/restore", fd);
      setRestored(summary);
      qc.clear(); // everything on screen is from the old data
      toast("success", `Restored ${summary.projects} ${summary.projects === 1 ? "project" : "projects"}, ${summary.cases} cases, ${summary.runs} runs`);
      qc.invalidateQueries();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setRestoring(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <>
      <div className="topbar">
        <h1>Backup &amp; restore</h1>
      </div>
      <div className="content">
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16, maxWidth: 760 }}>
          <div className="card">
            <div className="card-header" role="heading" aria-level={2}><Archive size={15} /> Back up everything</div>
            <div className="card-body col" style={{ gap: 12 }}>
              <div className="muted">
                One zip with all your projects: the database plus every uploaded screenshot, video and trace. Keep a copy somewhere safe, and restore it here
                on this or another computer. Your data is not stored in git.
              </div>
              {info && (
                <div className="row" style={{ gap: 28, flexWrap: "wrap" }}>
                  <div className="stat"><span className="value">{info.projects}</span><span className="label">{info.projects === 1 ? "project" : "projects"}</span></div>
                  <div className="stat"><span className="value">{info.cases}</span><span className="label">cases</span></div>
                  <div className="stat"><span className="value">{info.runs}</span><span className="label">runs</span></div>
                  <div className="stat"><span className="value">{formatBytes(info.dbBytes + info.uploadBytes)}</span><span className="label">{info.uploadFiles} uploaded files</span></div>
                </div>
              )}
              <div className="row">
                <a className="btn primary" href="/api/backup" onClick={() => setTimeout(() => qc.invalidateQueries({ queryKey: ["backup-info"] }), 4000)}>
                  <Download size={14} /> Download backup
                </a>
                <span className="faint" style={{ fontSize: "var(--fs-md)" }}>{info?.lastBackupAt ? `Last backup ${timeAgo(info.lastBackupAt)}` : "No backup made yet"}</span>
              </div>
            </div>
          </div>

          {info && (
            <div className="card">
              <div className="card-header" role="heading" aria-level={2}><Archive size={15} /> Automatic daily backup</div>
              <div className="card-body col" style={{ gap: 8 }}>
                {info.auto.enabled ? (
                  <>
                    <div className="muted">
                      Testbench saves a backup about once a day while it is running and keeps the newest {info.auto.keep}.{" "}
                      {info.auto.lastAt ? `The last one was made ${timeAgo(info.auto.lastAt)}.` : "The first one is made shortly after start-up once you have a project."}
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <span className="faint">Saved in</span> <code className="inline">{info.auto.dir}</code>
                      <span className="faint">({info.auto.count} {info.auto.count === 1 ? "copy" : "copies"})</span>
                    </div>
                    <div className="faint" style={{ fontSize: "var(--fs-md)" }}>
                      This folder is on the same disk as your data, which protects against mistakes and a damaged database but not a lost disk. For an extra copy
                      elsewhere, start Testbench with <code className="inline">TESTBENCH_BACKUP_DIR</code> set to a synced folder such as iCloud Drive or Dropbox.
                      To restore one, use "Choose backup .zip" below.
                    </div>
                  </>
                ) : (
                  <div className="muted">Automatic backups are turned off (<code className="inline">TESTBENCH_AUTO_BACKUP=0</code>).</div>
                )}
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-header" role="heading" aria-level={2}><RotateCcw size={15} /> Restore from a backup</div>
            <div className="card-body col" style={{ gap: 12 }}>
              <div className="row" style={{ alignItems: "flex-start", gap: 12, color: "var(--blocked-fg)" }}>
                <ShieldAlert size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                <span style={{ color: "var(--text-2)" }}>
                  Restoring replaces <strong>everything</strong> currently in TestBench. Your present data is kept in <code className="inline">data/previous/</code>, not deleted,
                  and the app switches over without a restart.
                </span>
              </div>
              <div className="row">
                <button className="btn" disabled={restoring} onClick={() => input.current?.click()}>
                  {restoring ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />} {restoring ? "Restoring…" : "Choose backup .zip…"}
                </button>
                <input ref={input} type="file" accept=".zip" hidden onChange={(e) => e.target.files?.[0] && restore(e.target.files[0])} />
              </div>
              {restored && (
                <div className="card" style={{ padding: 12, background: "var(--bg)" }}>
                  <div style={{ fontWeight: 500 }}>Restore complete</div>
                  <div className="muted" style={{ marginTop: 2 }}>
                    {restored.projects} {restored.projects === 1 ? "project" : "projects"}, {restored.cases} cases, {restored.runs} runs and {restored.uploadFiles} files.
                    The data that was replaced is in <code className="inline">data/{restored.previous}</code>.
                  </div>
                  <button className="btn sm" style={{ marginTop: 8 }} onClick={() => navigate("/")}>Open TestBench</button>
                </div>
              )}
            </div>
          </div>

          {info && info.previousCopies.length > 0 && (
            <div className="card">
              <div className="card-header" role="heading" aria-level={2}><History size={15} /> Data kept from earlier restores</div>
              <div className="card-body col" style={{ gap: 6 }}>
                <div className="muted">
                  Each is a full copy of what was replaced. To go back to one, copy its <code className="inline">testbench.db</code> and <code className="inline">uploads</code> folder
                  into <code className="inline">data/</code> (with TestBench stopped). Delete the folders once you no longer need them.
                </div>
                {info.previousCopies.map((p) => <code key={p} className="inline" style={{ width: "fit-content" }}>data/previous/{p}</code>)}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
