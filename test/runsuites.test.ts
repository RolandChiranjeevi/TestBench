import "./env.ts";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import { db, migrate } from "../server/db.ts";
import { automationByCase } from "../server/runsuites.ts";
import { makeCase, makeProject, makeSuite } from "./helpers.ts";

// Suites: runnable groups of cases (table run_templates). Through the real app (app.inject, no port, no network), plus the step that adds the new column to a database
// that has templates already. Folders (table suites) only organise cases and are tested in suites.test.ts.
process.env.TESTBENCH_NO_LISTEN = "1";
const { app } = await import("../server/index.ts");
await app.ready();
after(() => app.close());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const call = async (method: string, url: string, body?: unknown): Promise<{ status: number; body: Json }> => {
  const res = await app.inject({ method: method as "GET", url, headers: { "x-testbench": "1" }, ...(body === undefined ? {} : { payload: body as object }) });
  return { status: res.statusCode, body: res.json() };
};
const key = () => `S${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const newProject = () => makeProject(key());
const createSuite = async (projectId: number, name: string, caseIds: number[], extra: Record<string, unknown> = {}) => {
  const r = await call("POST", `/api/projects/${projectId}/templates`, { name, caseIds, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as Json;
};
const caseNumbers = (detail: Json) => detail.results.map((r: Json) => r.case_number);

/** An automated test linked to a case, with the results it had (each [status, time]). */
function linkAutomated(projectId: number, caseId: number, results: [string, string][]) {
  const t = db
    .prepare("INSERT INTO automated_tests (project_id, framework, title, full_name, case_id) VALUES (?, 'playwright', 'a test', ?, ?) RETURNING id")
    .get(projectId, `t-${Math.random()}`, caseId) as { id: number };
  results.forEach(([status, at], i) => {
    const run = db
      .prepare("INSERT INTO runs (project_id, title, kind, source, status, started_at) VALUES (?, 'ci', 'automated', 'upload', 'completed', ?) RETURNING id")
      .get(projectId, at) as { id: number };
    db.prepare("INSERT INTO results (run_id, case_id, automated_test_id, status, position, executed_at) VALUES (?, ?, ?, ?, ?, ?)").run(run.id, caseId, t.id, status, i, at);
  });
  return t.id;
}

describe("a suite is a saved list of cases, run in the order of the case list", () => {
  it("is created with a description, lists its cases in case order whatever order they were given in, and is renamed and described by PATCH", async () => {
    const p = newProject();
    const [a, b, c] = [makeCase(p.id, "A"), makeCase(p.id, "B"), makeCase(p.id, "C")];
    const s = await createSuite(p.id, "Smoke", [c.id, a.id, b.id], { description: "Before every release", environment: "staging" });
    assert.deepEqual([s.name, s.description, s.environment, s.case_count], ["Smoke", "Before every release", "staging", 3]);
    assert.deepEqual(s.caseIds, [a.id, b.id, c.id]);
    const patched = await call("PATCH", `/api/templates/${s.id}`, { name: "Smoke test", description: "Changed" });
    assert.deepEqual([patched.body.name, patched.body.description, patched.body.environment, patched.body.caseIds], ["Smoke test", "Changed", "staging", [a.id, b.id, c.id]]);
    const list = await call("GET", `/api/projects/${p.id}/templates`);
    assert.deepEqual(list.body.map((x: Json) => x.name), ["Smoke test"]);
    assert.equal((await call("POST", `/api/projects/${p.id}/templates`, { name: "Smoke test", caseIds: [] })).status, 409);
  });

  it("add puts cases in and does nothing for the ones already there; a case of another project is refused and then nothing is added", async () => {
    const p = newProject();
    const other = newProject();
    const [a, b, c] = [makeCase(p.id, "A"), makeCase(p.id, "B"), makeCase(p.id, "C")];
    const stranger = makeCase(other.id, "Stranger");
    const s = await createSuite(p.id, "S", [a.id]);
    const added = await call("POST", `/api/templates/${s.id}/cases`, { caseIds: [b.id, a.id, b.id] });
    assert.equal(added.status, 200);
    assert.deepEqual(added.body.cases.map((x: Json) => x.id), [a.id, b.id]);
    const refused = await call("POST", `/api/templates/${s.id}/cases`, { caseIds: [c.id, stranger.id] });
    assert.deepEqual([refused.status, refused.body.error], [400, "1 of the test cases is not in this project"]);
    assert.deepEqual((await call("GET", `/api/templates/${s.id}`)).body.cases.map((x: Json) => x.id), [a.id, b.id], "c was not added either");
    assert.equal((await call("POST", `/api/templates/${s.id}/cases`, { caseIds: [] })).status, 400);
    assert.equal((await call("POST", `/api/templates/${s.id}/cases`, {})).status, 400);
  });

  it("remove takes one case out; a case that is not in the suite is a 404", async () => {
    const p = newProject();
    const [a, b] = [makeCase(p.id, "A"), makeCase(p.id, "B")];
    const s = await createSuite(p.id, "S", [a.id, b.id]);
    const r = await call("DELETE", `/api/templates/${s.id}/cases/${a.id}`);
    assert.deepEqual([r.status, r.body.cases.map((x: Json) => x.id)], [200, [b.id]]);
    const again = await call("DELETE", `/api/templates/${s.id}/cases/${a.id}`);
    assert.deepEqual([again.status, again.body.error], [404, "That test case is not in the suite"]);
    assert.equal((await call("GET", `/api/templates/${s.id}`)).body.case_count, 1);
  });

  it("deleting a case takes it out of its suites", async () => {
    const p = newProject();
    const [a, b] = [makeCase(p.id, "A"), makeCase(p.id, "B")];
    const s = await createSuite(p.id, "S", [a.id, b.id]);
    await call("DELETE", `/api/cases/${a.id}`);
    assert.deepEqual((await call("GET", `/api/templates/${s.id}`)).body.cases.map((x: Json) => x.id), [b.id]);
  });
});

describe("a suite copied from a folder", () => {
  it("holds the cases of the folder and its subfolders, in case order, and later changes to the folder do not change it", async () => {
    const p = newProject();
    const top = makeSuite(p.id, "Checkout");
    const sub = makeSuite(p.id, "Payment", top);
    const elsewhere = makeSuite(p.id, "Other");
    const c1 = makeCase(p.id, "In sub", { suiteId: sub });
    const c2 = makeCase(p.id, "In top", { suiteId: top });
    makeCase(p.id, "Elsewhere", { suiteId: elsewhere });
    makeCase(p.id, "No folder");
    const r = await call("POST", `/api/projects/${p.id}/templates/from-folder`, { folderId: top });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.name, r.body.cases.map((x: Json) => x.id)], ["Checkout", [c1.id, c2.id]], "named after the folder, in case order");
    const late = makeCase(p.id, "Added later", { suiteId: top });
    db.prepare("UPDATE cases SET suite_id = ? WHERE id = ?").run(elsewhere, c2.id);
    const after = await call("GET", `/api/templates/${r.body.id}`);
    assert.deepEqual(after.body.cases.map((x: Json) => x.id), [c1.id, c2.id], "a copy, not a live link");
    assert.ok(!after.body.cases.some((x: Json) => x.id === late.id));
  });

  it("can leave out the subfolders, takes a name of its own, and refuses an empty folder, a folder of another project and a name that is taken", async () => {
    const p = newProject();
    const other = newProject();
    const top = makeSuite(p.id, "Top");
    const sub = makeSuite(p.id, "Sub", top);
    const direct = makeCase(p.id, "Direct", { suiteId: top });
    makeCase(p.id, "Deep", { suiteId: sub });
    const only = await call("POST", `/api/projects/${p.id}/templates/from-folder`, { folderId: top, name: "Just the top", includeSubfolders: false });
    assert.deepEqual([only.body.name, only.body.cases.map((x: Json) => x.id)], ["Just the top", [direct.id]]);
    const emptyFolder = makeSuite(p.id, "Empty");
    assert.deepEqual([(await call("POST", `/api/projects/${p.id}/templates/from-folder`, { folderId: emptyFolder })).status], [400]);
    assert.equal((await call("POST", `/api/projects/${p.id}/templates/from-folder`, { folderId: makeSuite(other.id, "Theirs") })).status, 404);
    assert.equal((await call("POST", `/api/projects/${p.id}/templates/from-folder`, { folderId: top, name: "Just the top" })).status, 409);
    assert.equal((await call("POST", `/api/projects/${p.id}/templates/from-folder`, {})).status, 400);
  });
});

describe("running a suite", () => {
  it("makes a manual run of the cases it holds now, in case order, frozen as they are, and remembers the suite", async () => {
    const p = newProject();
    const [a, b, c] = [makeCase(p.id, "A", { steps: [["do", "ok"]] }), makeCase(p.id, "B"), makeCase(p.id, "C")];
    const s = await createSuite(p.id, "Smoke", [c.id, b.id, a.id], { environment: "staging" });
    const started = await call("POST", `/api/templates/${s.id}/run`, {});
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.deepEqual([started.body.kind, started.body.template_id, started.body.environment], ["manual", s.id, "staging"]);
    assert.match(started.body.title, /^Smoke · \d{4}-\d{2}-\d{2}$/);
    db.prepare("UPDATE cases SET title = 'Renamed since' WHERE id = ?").run(a.id);
    const detail = await call("GET", `/api/runs/${started.body.id}`);
    assert.deepEqual(caseNumbers(detail.body), [a.number, b.number, c.number]);
    assert.equal(detail.body.results[0].case_title, "A", "frozen when the run started");
    assert.equal(detail.body.results[0].step_count, 1);
    assert.deepEqual(detail.body.meta.suite, { id: s.id, name: "Smoke" });
    assert.deepEqual(detail.body.suite, { id: s.id, name: "Smoke", deleted: false, partial: false, added: 0, removed: 0 });
    const own = await call("POST", `/api/templates/${s.id}/run`, { title: "Release 4", environment: "prod", milestone: "R4" });
    assert.deepEqual([own.body.title, own.body.environment, own.body.milestone], ["Release 4", "prod", "R4"]);
  });

  it("an empty suite cannot be run, and a suite that does not exist is a 404", async () => {
    const p = newProject();
    const s = await createSuite(p.id, "Empty", []);
    const r = await call("POST", `/api/templates/${s.id}/run`, {});
    assert.deepEqual([r.status, r.body.error], [400, "The suite has no test cases"]);
    assert.equal((await call("POST", "/api/templates/99999999/run", {})).status, 404);
    assert.equal((await call("GET", "/api/templates/99999999")).status, 404);
    assert.equal((await call("GET", `/api/projects/${p.id}/runs`)).body.length, 0, "nothing was started");
  });

  it("running again takes the cases the suite holds now, not the ones of the last run, and the old run says how the suite has changed", async () => {
    const p = newProject();
    const [a, b, c] = [makeCase(p.id, "A"), makeCase(p.id, "B"), makeCase(p.id, "C")];
    const s = await createSuite(p.id, "S", [a.id, b.id]);
    const first = (await call("POST", `/api/templates/${s.id}/run`, {})).body;
    await call("POST", `/api/templates/${s.id}/cases`, { caseIds: [c.id] });
    await call("DELETE", `/api/templates/${s.id}/cases/${a.id}`);
    const oldRun = await call("GET", `/api/runs/${first.id}`);
    assert.deepEqual(oldRun.body.suite, { id: s.id, name: "S", deleted: false, partial: false, added: 1, removed: 1 });
    const second = (await call("POST", `/api/templates/${s.id}/run`, {})).body;
    assert.deepEqual(caseNumbers((await call("GET", `/api/runs/${second.id}`)).body), [b.number, c.number]);
    assert.deepEqual(caseNumbers((await call("GET", `/api/runs/${first.id}`)).body), [a.number, b.number], "the first run is as it was");
    const list = (await call("GET", `/api/projects/${p.id}/templates`)).body[0];
    assert.deepEqual([list.run_count, list.last_run.id, list.last_run.total], [2, second.id, 2]);
  });

  it("a run of part of a suite, chosen in the dialog, is marked partial and never reported as missing cases", async () => {
    const p = newProject();
    const [a, b] = [makeCase(p.id, "A"), makeCase(p.id, "B")];
    const s = await createSuite(p.id, "S", [a.id, b.id]);
    const run = await call("POST", `/api/projects/${p.id}/runs`, { title: "Some of it", caseIds: [a.id], templateId: s.id });
    assert.equal(run.status, 200);
    const detail = (await call("GET", `/api/runs/${run.body.id}`)).body;
    assert.deepEqual([detail.meta.suite.partial, detail.suite.partial, detail.suite.added, detail.suite.removed], [true, true, 0, 0]);
    const whole = await call("POST", `/api/projects/${p.id}/runs`, { title: "All of it", caseIds: [b.id, a.id], templateId: s.id });
    assert.equal((await call("GET", `/api/runs/${whole.body.id}`)).body.suite.partial, false);
  });

  it("a run from before suites knew about it (a template and no meta) still says which suite it came from", async () => {
    const p = newProject();
    const [a, b] = [makeCase(p.id, "A"), makeCase(p.id, "B")];
    const s = await createSuite(p.id, "Old", [a.id, b.id]);
    const run = db.prepare("INSERT INTO runs (project_id, title, kind, source, template_id, meta) VALUES (?, 'old', 'manual', 'manual', ?, '{}') RETURNING id").get(p.id, s.id) as { id: number };
    db.prepare("INSERT INTO results (run_id, case_id, position) VALUES (?, ?, 0)").run(run.id, a.id);
    assert.deepEqual((await call("GET", `/api/runs/${run.id}`)).body.suite, { id: s.id, name: "Old", deleted: false, partial: false, added: 1, removed: 0 });
  });

  it("deleting the suite keeps its runs, with the name it had", async () => {
    const p = newProject();
    const a = makeCase(p.id, "A");
    const s = await createSuite(p.id, "Gone soon", [a.id]);
    const run = (await call("POST", `/api/templates/${s.id}/run`, {})).body;
    assert.equal((await call("DELETE", `/api/templates/${s.id}`)).status, 200);
    const detail = (await call("GET", `/api/runs/${run.id}`)).body;
    assert.deepEqual([detail.template_id, detail.suite], [null, { id: null, name: "Gone soon", deleted: true, partial: false, added: 0, removed: 0 }]);
    const row = (await call("GET", `/api/projects/${p.id}/runs`)).body.find((r: Json) => r.id === run.id);
    assert.equal(row.template_name, "Gone soon");
    assert.equal(caseNumbers(detail).length, 1, "its results are still there");
  });

  it("the list of runs names the suite and can be filtered by it", async () => {
    const p = newProject();
    const [a, b] = [makeCase(p.id, "A"), makeCase(p.id, "B")];
    const one = await createSuite(p.id, "One", [a.id]);
    const two = await createSuite(p.id, "Two", [b.id]);
    const r1 = (await call("POST", `/api/templates/${one.id}/run`, {})).body;
    const r2 = (await call("POST", `/api/templates/${two.id}/run`, {})).body;
    const loose = (await call("POST", `/api/projects/${p.id}/runs`, { title: "Loose", caseIds: [a.id] })).body;
    const all = (await call("GET", `/api/projects/${p.id}/runs`)).body;
    assert.deepEqual(Object.fromEntries(all.map((r: Json) => [r.id, r.template_name])), { [r1.id]: "One", [r2.id]: "Two", [loose.id]: null });
    assert.deepEqual((await call("GET", `/api/projects/${p.id}/runs?templateId=${two.id}`)).body.map((r: Json) => r.id), [r2.id]);
    assert.equal((await call("GET", `/api/projects/${p.id}/runs?templateId=abc`)).status, 400);
  });

  it("a run of chosen cases works as before: another project's cases are left out, and a template or run of another project is refused", async () => {
    const p = newProject();
    const other = newProject();
    const mine = makeCase(p.id, "Mine");
    const theirs = makeCase(other.id, "Theirs");
    const foreignSuite = await createSuite(other.id, "Theirs", [theirs.id]);
    const foreignRun = (await call("POST", `/api/projects/${other.id}/runs`, { title: "x", caseIds: [theirs.id] })).body;
    const ok = await call("POST", `/api/projects/${p.id}/runs`, { title: "Chosen", caseIds: [theirs.id, mine.id, mine.id] });
    assert.deepEqual(caseNumbers((await call("GET", `/api/runs/${ok.body.id}`)).body), [mine.number]);
    assert.deepEqual((await call("GET", `/api/runs/${ok.body.id}`)).body.suite, null, "not from a suite");
    const t = await call("POST", `/api/projects/${p.id}/runs`, { title: "x", caseIds: [mine.id], templateId: foreignSuite.id });
    assert.deepEqual([t.status, t.body.error], [400, "Template belongs to another project"]);
    const r = await call("POST", `/api/projects/${p.id}/runs`, { title: "x", caseIds: [mine.id], rerunOf: foreignRun.id });
    assert.deepEqual([r.status, r.body.error], [400, "The run to re-test belongs to another project"]);
    const again = await call("POST", `/api/projects/${p.id}/runs`, { title: "Re-test", caseIds: [mine.id], rerunOf: ok.body.id });
    assert.deepEqual((await call("GET", `/api/runs/${again.body.id}`)).body.meta.rerunOf, { id: ok.body.id, title: "Chosen" });
  });
});

describe("what the automated side knows about a case (information only, nothing is started)", () => {
  it("manual when no test is linked; both when tests are linked and the case has steps; automated when it has none", () => {
    const p = newProject();
    const manual = makeCase(p.id, "Manual", { steps: [["a", "b"]] });
    const both = makeCase(p.id, "Both", { steps: [["a", "b"]] });
    const auto = makeCase(p.id, "Auto");
    linkAutomated(p.id, both.id, []);
    linkAutomated(p.id, auto.id, []);
    linkAutomated(p.id, auto.id, []);
    const m = automationByCase(p.id, [manual.id, both.id, auto.id]);
    assert.deepEqual([m.get(manual.id)?.automation, m.get(both.id)?.automation, m.get(auto.id)?.automation], ["manual", "both", "automated"]);
    assert.deepEqual([m.get(manual.id)?.automatedTests, m.get(both.id)?.automatedTests, m.get(auto.id)?.automatedTests], [0, 1, 2]);
    assert.deepEqual([m.get(both.id)?.lastAutomated, m.get(auto.id)?.lastAutomated], [null, null], "linked but never run: no result to show");
    assert.equal(automationByCase(p.id, []).size, 0);
  });

  it("last automated is the latest result of each linked test; it is failed when any of them last failed; skipped and untested results do not count", () => {
    const p = newProject();
    const c = makeCase(p.id, "C");
    linkAutomated(p.id, c.id, [["failed", "2026-11-01 09:00:00"], ["passed", "2026-11-02 09:00:00"], ["skipped", "2026-11-03 09:00:00"]]);
    const one = automationByCase(p.id, [c.id]).get(c.id)!.lastAutomated!;
    assert.deepEqual([one.status, one.at, one.tests], ["passed", "2026-11-02 09:00:00", 1], "the latest counted result is the pass, not the older failure or the later skip");
    linkAutomated(p.id, c.id, [["passed", "2026-11-04 09:00:00"], ["failed", "2026-11-05 09:00:00"]]);
    const last = automationByCase(p.id, [c.id]).get(c.id)!;
    assert.deepEqual([last.automatedTests, last.lastAutomated?.status, last.lastAutomated?.at, last.lastAutomated?.tests], [2, "failed", "2026-11-05 09:00:00", 2]);
  });

  it("is shown for the cases of a suite and for the results of a manual run, and a case of another project is never counted", async () => {
    const p = newProject();
    const other = newProject();
    const both = makeCase(p.id, "Both", { steps: [["a", "b"]] });
    const manual = makeCase(p.id, "Manual");
    const stray = makeCase(other.id, "Stray");
    linkAutomated(p.id, both.id, [["failed", "2026-11-05 09:00:00"]]);
    linkAutomated(other.id, stray.id, [["passed", "2026-11-05 09:00:00"]]);
    assert.equal(automationByCase(p.id, [stray.id]).get(stray.id)?.automatedTests, 0, "asked in the wrong project");
    const s = await createSuite(p.id, "Mixed", [both.id, manual.id]);
    const detail = (await call("GET", `/api/templates/${s.id}`)).body;
    const row = (n: number) => detail.cases.find((c: Json) => c.id === n);
    assert.deepEqual([row(both.id).automation, row(both.id).automated_tests, row(both.id).last_automated.status, row(both.id).last_status], ["both", 1, "failed", "failed"]);
    assert.deepEqual([row(manual.id).automation, row(manual.id).last_automated, row(manual.id).last_status], ["manual", null, null]);
    const run = (await call("POST", `/api/templates/${s.id}/run`, {})).body;
    const results = (await call("GET", `/api/runs/${run.id}`)).body.results;
    assert.deepEqual(results.map((r: Json) => [r.case_number, r.automation, r.last_automated?.status ?? null]), [[both.number, "both", "failed"], [manual.number, "manual", null]]);
    assert.ok(results.every((r: Json) => r.status === "untested"), "the automated result is information; the manual result is still to be given");
  });
});

describe("the new column on a database that has templates already", () => {
  it("is added once, keeps the templates and their cases, and the index is there", () => {
    const d = new Database(":memory:");
    d.pragma("foreign_keys = ON");
    migrate(d);
    d.exec("DROP INDEX runs_template");
    d.exec("ALTER TABLE run_templates DROP COLUMN description"); // as it was before suites
    d.exec("INSERT INTO projects (name, key) VALUES ('Old', 'OLD')");
    d.exec("INSERT INTO cases (project_id, number, title) VALUES (1, 1, 'Case')");
    d.exec("INSERT INTO run_templates (project_id, name, environment) VALUES (1, 'Smoke', 'staging')");
    d.exec("INSERT INTO run_template_cases (template_id, case_id) VALUES (1, 1)");
    migrate(d);
    migrate(d); // another start changes nothing
    const columns = (d.prepare("PRAGMA table_info(run_templates)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(columns.includes("description"));
    assert.deepEqual(d.prepare("SELECT name, environment, description FROM run_templates").all(), [{ name: "Smoke", environment: "staging", description: "" }]);
    assert.equal((d.prepare("SELECT COUNT(*) AS n FROM run_template_cases").get() as { n: number }).n, 1);
    assert.ok((d.prepare("PRAGMA index_list(runs)").all() as { name: string }[]).some((i) => i.name === "runs_template"));
    d.close();
  });
});
