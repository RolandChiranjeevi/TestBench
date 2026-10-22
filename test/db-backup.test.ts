import { TEST_DATA } from "./env.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { unzipSync } from "fflate";
import { db, getSetting } from "../server/db.ts";
import { autoBackupInfo, listAutoBackups, runAutoBackup } from "../server/autobackup.ts";
import { makeCase, makeProject } from "./helpers.ts";

const BACKUPS = join(TEST_DATA, "backups-under-test");
process.env.TESTBENCH_BACKUP_DIR = BACKUPS;
process.env.TESTBENCH_BACKUP_KEEP = "3";

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

describe("database indexes", () => {
  const indexes = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name));

  it("exist for the columns that grow with CI imports", () => {
    for (const name of ["results_automated_test", "attachments_result", "runs_project", "cases_project", "cases_suite", "automated_project_case", "suites_project", "results_run", "results_case"]) {
      assert.ok(indexes.has(name), `missing index ${name}`);
    }
  });

  it("are actually used by the per-test counts on the Automated tests page", () => {
    const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM results WHERE automated_test_id = ?").all(1) as { detail: string }[]).map((r) => r.detail).join(" ");
    assert.match(plan, /results_automated_test/);
    assert.doesNotMatch(plan, /SCAN results/);
  });
});

describe("automatic daily backup", () => {
  it("does nothing while there is nothing to protect", async () => {
    const r = await runAutoBackup();
    assert.equal(r.created, null);
    assert.equal(existsSync(BACKUPS), false);
  });

  it("writes a valid backup zip once there is a project", async () => {
    const p = makeProject("B");
    makeCase(p.id, "Add competitor");
    writeFileSync(join(TEST_DATA, "uploads", "evidence.txt"), "hello");

    const r = await runAutoBackup();
    assert.match(r.created ?? "", /^testbench-auto-\d{4}-\d{2}-\d{2}\.zip$/);

    const files = unzipSync(new Uint8Array(readFileSync(join(BACKUPS, r.created!))));
    assert.deepEqual(Object.keys(files).sort(), ["manifest.json", "testbench.db", "uploads/evidence.txt"]);
    const manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString("utf8"));
    assert.equal(manifest.format, "testbench-backup/1");
    assert.equal(manifest.projects, 1);
    assert.equal(manifest.cases, 1);
    assert.equal(Buffer.from(files["uploads/evidence.txt"]).toString(), "hello");
    // SQLite file header, so the snapshot is a real database
    assert.equal(Buffer.from(files["testbench.db"]).subarray(0, 15).toString(), "SQLite format 3");
    assert.ok(getSetting("last_auto_backup_at"));
    assert.equal(getSetting("last_backup_at"), null); // a download is what sets this one
  });

  it("leaves no half-written files behind", () => {
    assert.deepEqual(readdirSync(BACKUPS).filter((f) => f.endsWith(".part")), []);
  });

  it("is not due again within a day", async () => {
    const before = listAutoBackups().length;
    const r = await runAutoBackup();
    assert.equal(r.created, null);
    assert.equal(listAutoBackups().length, before);
  });

  it("takes a new one when the newest is more than a day old", async () => {
    const [newest] = listAutoBackups();
    const old = daysAgo(2);
    utimesSync(join(BACKUPS, newest.name), old, old);
    const r = await runAutoBackup();
    assert.ok(r.created);
    assert.equal(listAutoBackups().length, 2);
  });

  it("keeps only the newest N and reports what it removed", async () => {
    // age everything, then force more backups than we keep (TESTBENCH_BACKUP_KEEP=3)
    listAutoBackups().forEach((f, i) => {
      const t = daysAgo(10 - i);
      utimesSync(join(BACKUPS, f.name), t, t);
    });
    const oldest = listAutoBackups().at(-1)!.name;
    await runAutoBackup({ force: true });
    const r = await runAutoBackup({ force: true });
    assert.equal(listAutoBackups().length, 3);
    assert.ok(r.removed.length >= 1 || !existsSync(join(BACKUPS, oldest)));
    assert.equal(existsSync(join(BACKUPS, oldest)), false);
  });

  it("describes itself for the Backup page", () => {
    const info = autoBackupInfo();
    assert.equal(info.enabled, true);
    assert.equal(info.dir, BACKUPS);
    assert.equal(info.keep, 3);
    assert.equal(info.count, 3);
    assert.ok(info.lastAt && info.lastName);
  });

  it("can be switched off", async () => {
    process.env.TESTBENCH_AUTO_BACKUP = "0";
    try {
      mkdirSync(BACKUPS, { recursive: true });
      const before = listAutoBackups().length;
      const r = await runAutoBackup();
      assert.equal(r.created, null);
      assert.equal(listAutoBackups().length, before);
      assert.equal(autoBackupInfo().enabled, false);
    } finally {
      process.env.TESTBENCH_AUTO_BACKUP = "1";
    }
  });
});
