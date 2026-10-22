import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { finished } from "node:stream/promises";
import { join } from "node:path";
import { db, DATA_DIR } from "./db.ts";
import { streamBackup } from "./backup.ts";

/**
 * Automatic daily backup: the same zip as "Download backup", written to a folder, newest N kept. Taken shortly after start-up when
 * the last one is more than a day old, then re-checked hourly while the app runs. TESTBENCH_AUTO_BACKUP=0 turns it off,
 * TESTBENCH_BACKUP_DIR picks the folder (point it at a synced folder such as iCloud Drive or Dropbox for an off-disk copy),
 * TESTBENCH_BACKUP_KEEP sets how many to keep (default 7).
 */

const NAME = /^testbench-auto-\d{4}-\d{2}-\d{2}.*\.zip$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export const autoBackupConfig = () => ({
  enabled: process.env.TESTBENCH_AUTO_BACKUP !== "0",
  dir: process.env.TESTBENCH_BACKUP_DIR?.trim() || join(DATA_DIR, "backups"),
  keep: Math.max(1, Math.floor(Number(process.env.TESTBENCH_BACKUP_KEEP)) || 7),
});

/** Existing automatic backups, newest first. */
export function listAutoBackups() {
  const { dir } = autoBackupConfig();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => NAME.test(f))
    .map((f) => ({ name: f, bytes: statSync(join(dir, f)).size, at: statSync(join(dir, f)).mtime.toISOString() }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.name.localeCompare(a.name)));
}

export function autoBackupInfo() {
  const cfg = autoBackupConfig();
  const files = listAutoBackups();
  return { enabled: cfg.enabled, dir: cfg.dir, keep: cfg.keep, count: files.length, lastAt: files[0]?.at ?? null, lastName: files[0]?.name ?? null };
}

let running = false;

/** Takes a backup if the newest one is older than a day (or `force`). Returns the file name written, if any. */
export async function runAutoBackup(opts: { force?: boolean; now?: Date } = {}): Promise<{ created: string | null; removed: string[] }> {
  const cfg = autoBackupConfig();
  const none = { created: null, removed: [] as string[] };
  if (running || (!cfg.enabled && !opts.force)) return none;
  const now = opts.now ?? new Date();
  const last = listAutoBackups()[0];
  if (!opts.force && last && now.getTime() - new Date(last.at).getTime() < DAY_MS) return none;
  // Nothing to protect yet: don't litter the folder with empty backups.
  if ((db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n === 0) return none;

  running = true;
  mkdirSync(cfg.dir, { recursive: true });
  const stamp = now.toISOString().slice(0, 10);
  let name = `testbench-auto-${stamp}.zip`;
  for (let n = 2; existsSync(join(cfg.dir, name)); n++) name = `testbench-auto-${stamp}-${n}.zip`;
  const tmp = join(cfg.dir, `.${name}.part`);
  try {
    const out = createWriteStream(tmp);
    await streamBackup(out, { record: "last_auto_backup_at" });
    await finished(out);
    renameSync(tmp, join(cfg.dir, name));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  } finally {
    running = false;
  }

  const removed: string[] = [];
  for (const old of listAutoBackups().slice(cfg.keep)) {
    rmSync(join(cfg.dir, old.name), { force: true });
    removed.push(old.name);
  }
  return { created: name, removed };
}

/** Called once at start-up. Failures are logged and retried at the next check, never thrown. */
export function startAutoBackup(log: (msg: string) => void = console.log) {
  if (!autoBackupConfig().enabled) return;
  const check = () =>
    runAutoBackup()
      .then((r) => r.created && log(`Automatic backup written: ${r.created}`))
      .catch((e) => log(`Automatic backup failed: ${e instanceof Error ? e.message : String(e)}`));
  setTimeout(() => void check(), 15_000).unref();
  setInterval(() => void check(), 60 * 60 * 1000).unref();
}
