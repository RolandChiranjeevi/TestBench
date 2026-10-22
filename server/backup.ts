import Database from "better-sqlite3";
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from "fflate";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import type { Writable } from "node:stream";
import { join } from "node:path";
import { bagFromZip } from "./importers/bag.ts";
import { closeDatabase, DATA_DIR, DB_FILE, db, getSetting, reopenDatabase, setSetting, UPLOAD_DIR } from "./db.ts";

const FORMAT = "testbench-backup/1";
const PREVIOUS_DIR = join(DATA_DIR, "previous");
/** Already-compressed media is stored as is; compressing it again only costs time. */
const ALREADY_COMPRESSED = /\.(png|jpe?g|gif|webp|webm|mp4|zip|pdf)$/i;
/** A restore reads the whole zip into memory, so very large backups have to be restored by hand. */
const MAX_RESTORE_BYTES = 1.5 * 1024 * 1024 * 1024;
const MAX_RESTORE_FILE_BYTES = 500 * 1024 * 1024;

const counts = () => ({
  projects: (db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n,
  cases: (db.prepare("SELECT COUNT(*) AS n FROM cases").get() as { n: number }).n,
  runs: (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n,
});

const uploadFiles = () => readdirSync(UPLOAD_DIR).filter((f) => statSync(join(UPLOAD_DIR, f)).isFile());

export function backupInfo() {
  const files = uploadFiles();
  const size = (p: string) => (existsSync(p) ? statSync(p).size : 0);
  return {
    ...counts(),
    dbBytes: size(DB_FILE) + size(DB_FILE + "-wal"),
    uploadFiles: files.length,
    uploadBytes: files.reduce((sum, f) => sum + size(join(UPLOAD_DIR, f)), 0),
    lastBackupAt: getSetting("last_backup_at"),
    previousCopies: existsSync(PREVIOUS_DIR) ? readdirSync(PREVIOUS_DIR).sort() : [],
  };
}

/**
 * Streams a zip of everything (database snapshot + uploaded files) to the response without holding it in memory.
 * The database is copied with SQLite's online backup, so the snapshot is consistent even while the app is in use.
 */
export async function streamBackup(res: Writable, opts: { record?: string } = {}): Promise<void> {
  const snapshot = join(DATA_DIR, `.snapshot-${process.pid}-${Date.now()}.db`);
  await db.backup(snapshot);
  try {
    const files = uploadFiles();
    const manifest = { format: FORMAT, createdAt: new Date().toISOString(), ...counts(), uploadFiles: files.length };

    let closed = false;
    res.on("close", () => (closed = true));
    let needDrain = false;
    const drain = async () => {
      if (closed) throw new Error("The download was cancelled");
      if (needDrain) {
        needDrain = false;
        await Promise.race([once(res, "drain"), once(res, "close")]);
        if (closed) throw new Error("The download was cancelled");
      }
    };

    const zip = new Zip((err, chunk, final) => {
      if (err) return void res.destroy(err);
      if (!res.write(chunk)) needDrain = true;
      if (final) res.end();
    });
    const add = async (name: string, source: Uint8Array | string, deflate: boolean) => {
      const entry = deflate ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
      zip.add(entry);
      if (typeof source === "string") {
        for await (const chunk of createReadStream(source, { highWaterMark: 1 << 20 })) {
          entry.push(chunk as Buffer);
          await drain();
        }
        entry.push(new Uint8Array(0), true);
      } else {
        entry.push(source, true);
      }
      await drain();
    };

    await add("manifest.json", strToU8(JSON.stringify(manifest, null, 2)), true);
    await add("testbench.db", snapshot, true);
    for (const f of files) await add(`uploads/${f}`, join(UPLOAD_DIR, f), !ALREADY_COMPRESSED.test(f));
    zip.end();
    setSetting(opts.record ?? "last_backup_at", manifest.createdAt);
  } finally {
    rmSync(snapshot, { force: true });
  }
}

export interface RestoreSummary {
  projects: number;
  cases: number;
  runs: number;
  uploadFiles: number;
  /** Where the data that was replaced was moved, relative to the data folder. */
  previous: string;
}

/**
 * Replaces all current data with the contents of a backup zip. The backup is unpacked and checked first, the current data is
 * moved aside (never deleted), and the app switches to the restored database without a restart.
 */
export async function restoreFromZip(zipPath: string): Promise<RestoreSummary> {
  if (statSync(zipPath).size > MAX_RESTORE_BYTES) throw new Error("This backup is too large to restore from the app. Unzip it into the data folder by hand.");
  let bag: ReturnType<typeof bagFromZip>;
  try {
    bag = bagFromZip(new Uint8Array(readFileSync(zipPath)), MAX_RESTORE_FILE_BYTES);
  } catch {
    throw new Error("That file isn't a readable zip. Choose a backup made with Download backup.");
  }
  if (!bag.names.includes("manifest.json") || !bag.names.includes("testbench.db")) throw new Error("This isn't a TestBench backup: manifest.json or testbench.db is missing.");
  let manifest: { format?: string };
  try {
    manifest = JSON.parse(Buffer.from(bag.read("manifest.json") ?? new Uint8Array()).toString("utf8"));
  } catch {
    throw new Error("The backup's manifest.json can't be read.");
  }
  if (!manifest.format?.startsWith("testbench-backup/")) throw new Error("This isn't a TestBench backup (unknown format).");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stage = join(DATA_DIR, `.restore-${stamp}`);
  mkdirSync(join(stage, "uploads"), { recursive: true });
  try {
    const dbBytes = bag.read("testbench.db");
    if (!dbBytes) throw new Error("testbench.db in the backup is unreadable or too large.");
    writeFileSync(join(stage, "testbench.db"), dbBytes);

    // Make sure the database is sound before anything of the current data is touched.
    let summary: { projects: number; cases: number; runs: number };
    try {
      const check = new Database(join(stage, "testbench.db"), { readonly: true });
      try {
        if (check.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("The database in the backup is damaged.");
      const tables = new Set((check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
      for (const t of ["projects", "cases", "runs", "results"]) if (!tables.has(t)) throw new Error(`The database in the backup has no "${t}" table.`);
      const n = (t: string) => (check.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      summary = { projects: n("projects"), cases: n("cases"), runs: n("runs") };
      } finally {
        check.close();
      }
    } catch (e) {
      const msg = (e as Error).message;
      throw new Error(msg.startsWith("The database") ? msg : "The database in the backup is damaged and can't be read.");
    }

    // Only plain file names are accepted, so a crafted zip can't write outside the uploads folder.
    let uploads = 0;
    for (const name of bag.names) {
      const m = /^uploads\/([A-Za-z0-9._-]{1,200})$/.exec(name);
      if (!m) continue;
      const bytes = bag.read(name);
      if (!bytes) throw new Error(`${name} in the backup is unreadable or too large.`);
      writeFileSync(join(stage, "uploads", m[1]), bytes);
      uploads++;
    }

    // Swap: current data moves to data/previous/<stamp>, the restored data takes its place.
    const previous = join(PREVIOUS_DIR, stamp);
    mkdirSync(previous, { recursive: true });
    closeDatabase();
    const moved: [string, string][] = [];
    const move = (from: string, to: string) => {
      renameSync(from, to);
      moved.push([from, to]);
    };
    try {
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(DB_FILE + suffix)) move(DB_FILE + suffix, join(previous, "testbench.db" + suffix));
      move(UPLOAD_DIR, join(previous, "uploads"));
      renameSync(join(stage, "testbench.db"), DB_FILE);
      renameSync(join(stage, "uploads"), UPLOAD_DIR);
      reopenDatabase();
    } catch (e) {
      // Put everything back the way it was.
      try {
        closeDatabase();
      } catch {
        /* already closed */
      }
      rmSync(DB_FILE, { force: true });
      rmSync(DB_FILE + "-wal", { force: true });
      rmSync(DB_FILE + "-shm", { force: true });
      if (moved.some(([from]) => from === UPLOAD_DIR)) rmSync(UPLOAD_DIR, { recursive: true, force: true });
      for (const [from, to] of moved.reverse()) renameSync(to, from);
      reopenDatabase();
      throw new Error(`Restore failed and your data was left as it was: ${(e as Error).message}`);
    }
    return { ...summary, uploadFiles: uploads, previous: `previous/${stamp}` };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
