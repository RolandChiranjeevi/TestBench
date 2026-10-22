import { TEST_DATA } from "./env.ts";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { db } from "../server/db.ts";
import { addChecklistItem } from "../server/checklist.ts";
import { deleteCases, deleteProject, describeProject, DeletionError } from "../server/deletion.ts";
import { autoBackupConfig, listAutoBackups, listBackups, safetyBackup } from "../server/autobackup.ts";
import { addRequirementAttachment, createRequirement, listRequirements, setRequirementCases } from "../server/requirements.ts";
import { makeCase, makeManualRun, makeProject, makeSuite } from "./helpers.ts";

const BACKUPS = join(TEST_DATA, "backups-deletion");
process.env.TESTBENCH_BACKUP_DIR = BACKUPS;

const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;

describe("deleteCases", () => {
  const p = makeProject("DX");
  const other = makeProject("DY");
  const a = makeCase(p.id, "A", { steps: [["step", "ok"]] });
  const b = makeCase(p.id, "B");
  const keep = makeCase(p.id, "Keep");
  const foreign = makeCase(other.id, "Foreign");
  const req = createRequirement(p.id, { title: "R" });
  setRequirementCases(req, p.id, [a.id, b.id, keep.id]);
  db.prepare("INSERT INTO run_templates (project_id, name) VALUES (?, 'Smoke')").run(p.id);
  const tpl = (db.prepare("SELECT id FROM run_templates WHERE project_id = ?").get(p.id) as { id: number }).id;
  db.prepare("INSERT INTO run_template_cases (template_id, case_id) VALUES (?, ?)").run(tpl, a.id);
  const auto = (db.prepare("INSERT INTO automated_tests (project_id, framework, title, full_name, case_id) VALUES (?, 'playwright', 'auto A', 'auto A', ?) RETURNING id").get(p.id, a.id) as { id: number }).id;
  const run = makeManualRun(p.id, [[a.id, "passed"], [keep.id, "failed"]]);
  db.prepare("UPDATE results SET snapshot = ? WHERE run_id = ? AND case_id = ?").run(JSON.stringify({ number: a.number, title: "A", steps: [] }), run, a.id);

  it("deletes the chosen cases and their steps, and reports how many", () => {
    assert.deepEqual(deleteCases(p.id, [a.id, b.id]), { deleted: 2 });
    assert.equal(count("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?", p.id), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM case_steps WHERE case_id = ?", a.id), 0);
  });

  it("removes links to requirements and templates, but not the requirement itself", () => {
    assert.deepEqual(listRequirements(p.id)[0].caseIds, [keep.id]);
    assert.equal(count("SELECT COUNT(*) AS n FROM run_template_cases WHERE template_id = ?", tpl), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM requirements WHERE id = ?", req), 1);
  });

  it("keeps history: results stay in their run, and linked automated tests become unlinked", () => {
    assert.equal(count("SELECT COUNT(*) AS n FROM results WHERE run_id = ?", run), 2);
    const r = db.prepare("SELECT case_id, snapshot FROM results WHERE run_id = ? AND snapshot IS NOT NULL").get(run) as { case_id: number | null; snapshot: string };
    assert.equal(r.case_id, null);
    assert.equal(JSON.parse(r.snapshot).title, "A");
    assert.equal((db.prepare("SELECT case_id FROM automated_tests WHERE id = ?").get(auto) as { case_id: number | null }).case_id, null);
  });

  it("never touches cases of another project, and ignores unknown ids", () => {
    assert.deepEqual(deleteCases(p.id, [foreign.id, 999999]), { deleted: 0 });
    assert.equal(count("SELECT COUNT(*) AS n FROM cases WHERE id = ?", foreign.id), 1);
  });

  it("refuses an empty selection, and repeated ids count once", () => {
    assert.throws(() => deleteCases(p.id, []), (e: unknown) => e instanceof DeletionError && e.status === 400);
    assert.deepEqual(deleteCases(p.id, [keep.id, keep.id, keep.id]), { deleted: 1 });
  });
});

describe("deleteProject", () => {
  const victim = makeProject("DV");
  const survivor = makeProject("DS");
  const suite = makeSuite(victim.id, "Auth");
  const c = makeCase(victim.id, "Login", { suiteId: suite });
  makeCase(survivor.id, "Survivor case");
  const run = makeManualRun(victim.id, [[c.id, "failed"]]);
  const resultId = (db.prepare("SELECT id FROM results WHERE run_id = ?").get(run) as { id: number }).id;
  db.prepare("INSERT INTO attachments (result_id, filename, stored_name, mime) VALUES (?, 'shot.png', 'evidence-1.png', 'image/png')").run(resultId);
  const req = createRequirement(victim.id, { title: "Customers can log in" });
  addRequirementAttachment(req, { filename: "spec.pdf", storedName: "spec-1.pdf", mime: "application/pdf", size: 10 });
  db.prepare("INSERT INTO milestones (project_id, name) VALUES (?, 'Sprint 1')").run(victim.id);
  const ms = (db.prepare("SELECT id FROM milestones WHERE project_id = ?").get(victim.id) as { id: number }).id;
  addChecklistItem(ms, "Sign off");
  db.prepare("INSERT INTO run_templates (project_id, name) VALUES (?, 'T')").run(victim.id);
  db.prepare("INSERT INTO github_sources (project_id, owner, repo) VALUES (?, 'o', 'r')").run(victim.id);
  db.prepare("INSERT INTO automated_tests (project_id, framework, title, full_name) VALUES (?, 'playwright', 't', 't')").run(victim.id);
  const survivorReq = createRequirement(survivor.id, { title: "Keep me" });

  it("describes what a deletion would remove", () => {
    const d = describeProject(victim.id);
    assert.equal(d.key, "DV");
    assert.deepEqual(d.counts, { cases: 1, runs: 1, requirements: 1, automatedTests: 1 });
    assert.throws(() => describeProject(999999), (e: unknown) => e instanceof DeletionError && e.status === 404);
  });

  it("refuses without the right key, and deletes nothing", () => {
    assert.throws(() => deleteProject(victim.id, ""), /confirm with its key DV/);
    assert.throws(() => deleteProject(victim.id, "dv"), (e: unknown) => e instanceof DeletionError && e.status === 400); // case matters
    assert.throws(() => deleteProject(victim.id, "DS"), /confirm with its key DV/); // another project's key does not work
    assert.equal(count("SELECT COUNT(*) AS n FROM projects WHERE id = ?", victim.id), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?", victim.id), 1);
  });

  it("removes the project with everything in it, and returns the files to delete", () => {
    const r = deleteProject(victim.id, "DV");
    assert.deepEqual(r.counts, { cases: 1, runs: 1, requirements: 1, automatedTests: 1 });
    assert.deepEqual([...r.files].sort(), ["evidence-1.png", "spec-1.pdf"]);

    // every table with a project_id column is empty for it
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((t) => t.name)
      .filter((t) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((col) => col.name === "project_id"));
    assert.ok(tables.length >= 8, `expected many project tables, found ${tables.join(", ")}`);
    for (const t of tables) assert.equal(count(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?`, victim.id), 0, t);

    // and the tables hanging below those, for this project's own rows
    assert.equal(count("SELECT COUNT(*) AS n FROM results WHERE run_id = ?", run), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM attachments WHERE result_id = ?", resultId), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM requirement_attachments WHERE requirement_id = ?", req), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM milestone_checklist WHERE milestone_id = ?", ms), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM case_steps WHERE case_id = ?", c.id), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM requirement_revisions WHERE requirement_id = ?", req), 0);
  });

  it("leaves other projects completely alone", () => {
    assert.equal(count("SELECT COUNT(*) AS n FROM projects WHERE id = ?", survivor.id), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?", survivor.id), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM requirements WHERE id = ?", survivorReq), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM requirement_revisions WHERE requirement_id = ?", survivorReq), 1);
  });

  it("cannot delete a project twice", () => {
    assert.throws(() => deleteProject(victim.id, "DV"), (e: unknown) => e instanceof DeletionError && e.status === 404);
  });
});

describe("safety backup before deleting", () => {
  it("is a real backup with its own name, kept apart from the daily ones", async () => {
    const p = makeProject("DB");
    makeCase(p.id, "Something worth keeping");
    const r = await safetyBackup();
    assert.match(r.created ?? "", /^testbench-before-delete-\d{4}-\d{2}-\d{2}\.zip$/);
    assert.equal(r.dir, BACKUPS);
    assert.ok(existsSync(join(BACKUPS, r.created!)));
    assert.equal(listBackups("before-delete").length, 1);
    assert.equal(listAutoBackups().length, 0); // the daily rotation does not see it
  });

  it("can be taken repeatedly, and only the newest ten are kept", async () => {
    for (let i = 0; i < 12; i++) await safetyBackup();
    assert.equal(listBackups("before-delete").length, 10);
    assert.ok(readdirSync(BACKUPS).every((f) => !f.endsWith(".part")));
  });

  it("is skipped when automatic backups are turned off", async () => {
    process.env.TESTBENCH_AUTO_BACKUP = "0";
    try {
      const before = listBackups("before-delete").length;
      const r = await safetyBackup();
      assert.equal(r.created, null);
      assert.equal(listBackups("before-delete").length, before);
      assert.equal(autoBackupConfig().enabled, false);
    } finally {
      process.env.TESTBENCH_AUTO_BACKUP = "1";
    }
  });
});
