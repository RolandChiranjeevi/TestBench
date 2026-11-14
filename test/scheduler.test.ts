import "./env.ts";
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { db, migrate } from "../server/db.ts";
import { startSuiteRun } from "../server/runsuites.ts";
import {
  CATCH_UP_MINUTES, fromDbTime, MAX_SCHEDULES_PER_PROJECT, nextRunAfter, previewSchedule, repairNextRuns, runDueSchedules, schedulerEnabled, setSchedule, startScheduler,
  toDbTime, validateSchedule,
} from "../server/scheduler.ts";
import { makeCase, makeProject } from "./helpers.ts";

// Suites on a schedule (server/scheduler.ts). The clock is always a parameter, so nothing here waits for a real minute. Routes go through the real app (app.inject).
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
const key = () => `C${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const newProject = () => makeProject(key());
const at = (s: string) => new Date(s);

/** A suite of `n` cases in a project, created through the API. */
async function suite(projectId: number, name: string, n = 2, extra: Record<string, unknown> = {}) {
  const caseIds = Array.from({ length: n }, (_, i) => makeCase(projectId, `${name} case ${i + 1}`).id);
  const r = await call("POST", `/api/projects/${projectId}/templates`, { name, caseIds, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as Json;
}
const row = (id: number) => db.prepare("SELECT * FROM run_templates WHERE id = ?").get(id) as Json;
const fires = (id: number) => db.prepare("SELECT * FROM suite_schedule_fires WHERE template_id = ? ORDER BY scheduled_for, id").all(id) as Json[];
const runsOf = (id: number) => db.prepare("SELECT * FROM runs WHERE template_id = ? ORDER BY id").all(id) as Json[];
/** A suite with a daily schedule at 08:00 UTC, set as if on 2026-11-13 at 07:00 UTC, so it is first due 2026-11-13 08:00:00. */
async function daily(projectId: number, name: string, n = 2) {
  const s = await suite(projectId, name, n);
  setSchedule(s.id, { schedule: "0 8 * * *", timezone: "UTC" }, "Test", at("2026-11-13T07:00:00Z"));
  return s;
}

describe("what a schedule may say", () => {
  it("takes five fields, with numbers, ranges, lists, steps and the names of months and days, and writes them in one normal form", () => {
    for (const ok of ["0 8 * * 1-5", "*/15 * * * *", "0 8 * * MON-FRI", "30 6 1 JAN,JUL *", "0 0,12 * * *"]) assert.equal(validateSchedule(ok, "UTC", at("2026-11-13T00:00:00Z")), ok, ok);
    assert.equal(validateSchedule("  0   8  * *   * ", "UTC"), "0 8 * * *");
  });

  it("refuses what is not a plain five-field schedule, and says what is wrong", () => {
    const bad: [string, RegExp][] = [
      ["", /empty/],
      ["* * * *", /5 fields.*not 4/],
      ["0 0 8 * * *", /5 fields.*not 6/],
      ["0 0 8 * * * 2030", /5 fields.*not 7/],
      ["@daily", /5 fields/],
      ["@reboot", /5 fields/],
      ["0 8 L * *", /day of month field may only hold numbers/],
      ["0 8 ? * *", /day of month field has characters that are not allowed/],
      ["0 8 * * 5#2", /day of week field has characters that are not allowed/],
      ["0 8 * * FRIDAY", /day of week field may only hold numbers/],
      ["61 * * * *", /minute/],
      ["0 25 * * *", /hour/],
      ["a b c d e", /not allowed|may only hold/],
    ];
    for (const [expression, message] of bad) assert.throws(() => validateSchedule(expression, "UTC"), (e: Error) => message.test(e.message) && (e as { status?: number }).status === 400, `${JSON.stringify(expression)}`);
  });

  it("refuses a schedule that runs more often than every 15 minutes, however it is written, and allows exactly 15", () => {
    const now = at("2026-11-13T00:00:00Z");
    assert.equal(validateSchedule("*/15 * * * *", "UTC", now), "*/15 * * * *");
    for (const fast of ["*/10 * * * *", "* * * * *", "0,10 8 * * *", "0,14 * * * *"]) {
      assert.throws(() => validateSchedule(fast, "UTC", now), /more often than every 15 minutes/, fast);
    }
    assert.throws(() => validateSchedule("0,10 8 1 1 *", "UTC", now), /two runs are 10 minutes apart/);
  });

  it("only takes real time zones (the cron library takes any text)", () => {
    assert.equal(validateSchedule("0 8 * * *", "Europe/Stockholm"), "0 8 * * *");
    assert.equal(validateSchedule("0 8 * * *", "UTC"), "0 8 * * *");
    for (const tz of ["Mars/Olympus", "", "europe/stockholm", "+01:00", "CET2CEST"]) assert.throws(() => validateSchedule("0 8 * * *", tz), /Unknown time zone/, JSON.stringify(tz));
  });

  it("times are kept as UTC text like the rest of the database, and read back the same", () => {
    const d = at("2026-11-13T08:00:00Z");
    assert.equal(toDbTime(d), "2026-11-13 08:00:00");
    assert.equal(fromDbTime("2026-11-13 08:00:00").getTime(), d.getTime());
  });
});

describe("time zones and summer time", () => {
  it("08:00 on weekdays in Stockholm is 07:00 UTC in winter and 06:00 UTC in summer, and skips the weekend", () => {
    assert.equal(nextRunAfter("0 8 * * 1-5", "Europe/Stockholm", at("2026-11-13T10:00:00Z"))?.toISOString(), "2026-11-16T07:00:00.000Z"); // Friday after 08:00: Monday
    assert.equal(nextRunAfter("0 8 * * 1-5", "Europe/Stockholm", at("2027-07-01T10:00:00Z"))?.toISOString(), "2027-07-02T06:00:00.000Z");
    assert.equal(nextRunAfter("0 8 * * 1-5", "UTC", at("2026-11-13T10:00:00Z"))?.toISOString(), "2026-11-16T08:00:00.000Z");
  });

  it("the following time is after the given one, never the given one itself", () => {
    assert.equal(nextRunAfter("0 8 * * *", "UTC", at("2026-11-13T08:00:00Z"))?.toISOString(), "2026-11-14T08:00:00.000Z");
    assert.equal(nextRunAfter("0 8 * * *", "UTC", at("2026-11-13T07:59:59Z"))?.toISOString(), "2026-11-13T08:00:00.000Z");
  });

  it("when the clocks go forward (2027-03-28 in Sweden, 02:30 does not exist) the day still gets one run, at 03:00 local time", () => {
    const runs: string[] = [];
    let t = at("2027-03-26T23:00:00Z");
    for (let i = 0; i < 4; i++) { const n = nextRunAfter("30 2 * * *", "Europe/Stockholm", t)!; runs.push(n.toISOString()); t = n; }
    assert.deepEqual(runs, ["2027-03-27T01:30:00.000Z", "2027-03-28T01:00:00.000Z", "2027-03-29T00:30:00.000Z", "2027-03-30T00:30:00.000Z"]);
  });

  it("when the clocks go back (2026-10-25, 02:30 happens twice) the day gets one run, the first", () => {
    const runs: string[] = [];
    let t = at("2026-10-23T23:00:00Z");
    for (let i = 0; i < 4; i++) { const n = nextRunAfter("30 2 * * *", "Europe/Stockholm", t)!; runs.push(n.toISOString()); t = n; }
    assert.deepEqual(runs, ["2026-10-24T00:30:00.000Z", "2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z", "2026-10-27T01:30:00.000Z"]);
  });

  it("the preview shows the next times, or what is wrong, and saves nothing", () => {
    const before = (db.prepare("SELECT COUNT(*) AS n FROM run_templates WHERE schedule IS NOT NULL").get() as { n: number }).n;
    const ok = previewSchedule("0 8 * * 1-5", "Europe/Stockholm", at("2026-11-13T10:00:00Z"), 3);
    assert.deepEqual(ok.ok && ok.next, ["2026-11-16 07:00:00", "2026-11-17 07:00:00", "2026-11-18 07:00:00"]);
    const no = previewSchedule("* * * * *", "UTC");
    assert.equal(no.ok, false);
    assert.match(!no.ok ? no.error : "", /more often than every 15 minutes/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM run_templates WHERE schedule IS NOT NULL").get() as { n: number }).n, before);
  });
});

describe("setting a schedule", () => {
  it("is saved with its time zone, who set it and when it is next due, through PATCH; saving the same again does not push the next time back", async () => {
    const p = newProject();
    const s = await suite(p.id, "Smoke");
    assert.deepEqual([s.schedule, s.schedule_tz, s.next_run_at], [null, "UTC", null], "a new suite has no schedule");
    const r = await call("PATCH", `/api/templates/${s.id}`, { schedule: "0 8 * * 1-5", scheduleTimezone: "Europe/Stockholm" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.schedule, r.body.schedule_tz], ["0 8 * * 1-5", "Europe/Stockholm"]);
    assert.match(r.body.next_run_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.ok(r.body.next_run_at > toDbTime(new Date()), "in the future");
    assert.ok(r.body.schedule_set_by && r.body.schedule_set_at);
    db.prepare("UPDATE run_templates SET next_run_at = '2030-01-01 08:00:00' WHERE id = ?").run(s.id);
    await call("PATCH", `/api/templates/${s.id}`, { schedule: "0  8 * * 1-5 ", scheduleTimezone: "Europe/Stockholm", description: "same schedule" });
    assert.equal(row(s.id).next_run_at, "2030-01-01 08:00:00", "unchanged: it is the same schedule");
    await call("PATCH", `/api/templates/${s.id}`, { schedule: "0 9 * * 1-5" });
    assert.notEqual(row(s.id).next_run_at, "2030-01-01 08:00:00", "changed: worked out again");
  });

  it("can be given when the suite is made", async () => {
    const p = newProject();
    const made = await call("POST", `/api/projects/${p.id}/templates`, { name: "Born scheduled", caseIds: [makeCase(p.id, "A").id], schedule: "0 2 * * *", scheduleTimezone: "UTC" });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.deepEqual([made.body.schedule, made.body.schedule_tz], ["0 2 * * *", "UTC"]);
    assert.ok(made.body.next_run_at);
    const refused = await call("POST", `/api/projects/${p.id}/templates`, { name: "Too fast", caseIds: [makeCase(p.id, "B").id], schedule: "* * * * *" });
    assert.equal(refused.status, 400);
    assert.equal((await call("GET", `/api/projects/${p.id}/templates`)).body.some((t: Json) => t.name === "Too fast"), false, "nothing was made");
  });

  it("a wrong schedule is a 400 that says why, and nothing is changed, not even the other fields of the same request", async () => {
    const p = newProject();
    const s = await suite(p.id, "Keep");
    await call("PATCH", `/api/templates/${s.id}`, { schedule: "0 8 * * *" });
    const before = row(s.id);
    for (const [body, message] of [
      [{ schedule: "* * * * *" }, /more often than every 15 minutes/],
      [{ schedule: "0 8 * *" }, /5 fields/],
      [{ schedule: "0 8 * * *", scheduleTimezone: "Mars/Olympus" }, /Unknown time zone/],
      [{ scheduleTimezone: "Mars/Olympus" }, /Unknown time zone/],
    ] as const) {
      const r = await call("PATCH", `/api/templates/${s.id}`, { ...body, name: "Renamed by a bad request" });
      assert.deepEqual([r.status, message.test(r.body.error)], [400, true], JSON.stringify(body));
    }
    const after = row(s.id);
    assert.deepEqual([after.name, after.schedule, after.schedule_tz, after.next_run_at], [before.name, before.schedule, before.schedule_tz, before.next_run_at]);
  });

  it("null (or empty) takes the schedule away, and the suite is never run automatically again", async () => {
    const p = newProject();
    const s = await daily(p.id, "Stop me");
    const cleared = await call("PATCH", `/api/templates/${s.id}`, { schedule: null });
    assert.deepEqual([cleared.body.schedule, cleared.body.next_run_at, cleared.body.schedule_set_by], [null, null, null]);
    assert.deepEqual(runDueSchedules(at("2030-01-01T00:00:00Z")).filter((r) => r.templateId === s.id), []);
    await call("PATCH", `/api/templates/${s.id}`, { schedule: "0 8 * * *" });
    await call("PATCH", `/api/templates/${s.id}`, { schedule: "  " });
    assert.equal(row(s.id).schedule, null);
  });

  it(`at most ${MAX_SCHEDULES_PER_PROJECT} scheduled suites in a project, and another project is not counted`, async () => {
    const p = newProject();
    const other = newProject();
    const ids: number[] = [];
    for (let i = 0; i < MAX_SCHEDULES_PER_PROJECT; i++) {
      ids.push((db.prepare("INSERT INTO run_templates (project_id, name, schedule, next_run_at) VALUES (?, ?, '0 8 * * *', '2030-01-01 08:00:00') RETURNING id").get(p.id, `S${i}`) as { id: number }).id);
    }
    const extra = await suite(p.id, "One too many");
    const r = await call("PATCH", `/api/templates/${extra.id}`, { schedule: "0 8 * * *" });
    assert.deepEqual([r.status, r.body.error], [400, `A project can have at most ${MAX_SCHEDULES_PER_PROJECT} scheduled suites`]);
    assert.equal((await call("PATCH", `/api/templates/${ids[0]}`, { schedule: "0 9 * * *" })).status, 200, "one that already has a schedule can still be changed");
    const elsewhere = await suite(other.id, "Other project");
    assert.equal((await call("PATCH", `/api/templates/${elsewhere.id}`, { schedule: "0 8 * * *" })).status, 200);
  });

  it("the suite shows its schedule: the next three times, and what became of the latest times it fell due", async () => {
    const p = newProject();
    const s = await daily(p.id, "Detail");
    runDueSchedules(at("2026-11-13T08:00:00Z"));
    const d = await call("GET", `/api/templates/${s.id}`);
    assert.deepEqual([d.body.schedule, d.body.schedule_tz, d.body.scheduler_enabled], ["0 8 * * *", "UTC", true]);
    assert.equal(d.body.next_runs.length, 3);
    assert.ok(d.body.next_runs.every((t: string) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t)));
    assert.deepEqual(d.body.fires.map((f: Json) => [f.scheduled_for, f.outcome]), [["2026-11-13 08:00:00", "started"]]);
    assert.ok(d.body.fires[0].run_id);
    assert.equal((await call("GET", `/api/projects/${p.id}/templates`)).body[0].schedule, "0 8 * * *", "the list has the schedule too");
  });

  it("the preview route answers with the next times or the reason, and a wrong schedule is not a server error", async () => {
    const p = newProject();
    const ok = await call("GET", `/api/projects/${p.id}/schedule-preview?cron=${encodeURIComponent("0 8 * * 1-5")}&tz=Europe/Stockholm`);
    assert.deepEqual([ok.status, ok.body.ok, ok.body.next.length, ok.body.schedulerEnabled], [200, true, 5, true]);
    const no = await call("GET", `/api/projects/${p.id}/schedule-preview?cron=${encodeURIComponent("*/5 * * * *")}&tz=UTC`);
    assert.deepEqual([no.status, no.body.ok, /more often than every 15 minutes/.test(no.body.error)], [200, false, true]);
    assert.equal((await call("GET", `/api/projects/${p.id}/schedule-preview`)).body.ok, false, "nothing given");
  });
});

describe("what happens when a suite is due", () => {
  // runDueSchedules deals with every suite that is due in the database, so each test starts with nobody else's schedule left over from an earlier one.
  beforeEach(() => { db.prepare("UPDATE run_templates SET schedule = NULL, next_run_at = NULL").run(); });

  it("makes the manual run the Run button makes, from the cases the suite holds then, marked as scheduled, and works out the next time", async () => {
    const p = newProject();
    const s = await daily(p.id, "Nightly", 3);
    assert.equal(row(s.id).next_run_at, "2026-11-13 08:00:00");
    assert.deepEqual(runDueSchedules(at("2026-11-13T07:59:59Z")), [], "not before the time");
    const [r] = runDueSchedules(at("2026-11-13T08:00:00Z"));
    assert.deepEqual([r.templateId, r.scheduledFor, r.outcome, r.note], [s.id, "2026-11-13 08:00:00", "started", ""]);
    const [run] = runsOf(s.id);
    assert.equal(run.id, r.runId);
    assert.deepEqual([run.kind, run.source, run.status, run.title, run.project_id], ["manual", "manual", "in_progress", "Nightly · 2026-11-13 (scheduled)", p.id]);
    const meta = JSON.parse(run.meta);
    assert.deepEqual([meta.scheduled, meta.suite], [{ for: "2026-11-13 08:00:00" }, { id: s.id, name: "Nightly" }]);
    const detail = (await call("GET", `/api/runs/${run.id}`)).body;
    assert.equal(detail.results.length, 3);
    assert.ok(detail.results.every((x: Json) => x.status === "untested"), "nothing is decided: every case is still to be run");
    assert.deepEqual(detail.suite, { id: s.id, name: "Nightly", deleted: false, partial: false, added: 0, removed: 0 });
    assert.equal(row(s.id).next_run_at, "2026-11-14 08:00:00");
    assert.deepEqual(fires(s.id).map((f) => [f.scheduled_for, f.outcome, f.run_id]), [["2026-11-13 08:00:00", "started", run.id]]);
    assert.deepEqual(runDueSchedules(at("2026-11-13T08:00:00Z")), [], "the same minute again makes nothing more");
    assert.equal(runsOf(s.id).length, 1);
    assert.equal((await call("GET", `/api/projects/${p.id}/runs`)).body.find((x: Json) => x.id === run.id).meta.scheduled.for, "2026-11-13 08:00:00");
  });

  it("the title names the day in the suite's own time zone", async () => {
    const p = newProject();
    const s = await suite(p.id, "Late evening");
    setSchedule(s.id, { schedule: "30 23 * * *", timezone: "America/Los_Angeles" }, "Test", at("2026-11-13T00:00:00Z")); // 23:30 PST = 07:30 UTC the next day
    assert.equal(row(s.id).next_run_at, "2026-11-13 07:30:00");
    runDueSchedules(at("2026-11-13T07:30:00Z"));
    assert.equal(runsOf(s.id)[0].title, "Late evening · 2026-11-12 (scheduled)");
  });

  it("a suite with no schedule, a suite whose time has not come, and a suite that no longer exists start nothing", async () => {
    const p = newProject();
    const none = await suite(p.id, "Never");
    const later = await daily(p.id, "Later");
    const gone = await daily(p.id, "Gone");
    await call("DELETE", `/api/templates/${gone.id}`);
    const done = runDueSchedules(at("2026-11-13T07:00:00Z"));
    assert.deepEqual(done.filter((r) => [none.id, later.id, gone.id].includes(r.templateId)), []);
    assert.deepEqual([runsOf(none.id).length, runsOf(later.id).length, runsOf(gone.id).length], [0, 0, 0]);
  });

  it("a time that is up to two hours late is run once; later than that it is recorded as missed and nothing is made", async () => {
    const p = newProject();
    const on = await daily(p.id, "Slightly late");
    const [a] = runDueSchedules(at("2026-11-13T09:30:00Z"));
    assert.deepEqual([a.outcome, a.note], ["started", "Started 90 minutes late"]);
    assert.equal(row(on.id).next_run_at, "2026-11-14 08:00:00");

    const edge = await daily(p.id, "On the limit");
    assert.equal(runDueSchedules(at(`2026-11-13T${String(8 + CATCH_UP_MINUTES / 60).padStart(2, "0")}:00:00Z`)).find((r) => r.templateId === edge.id)?.outcome, "started");

    const off = await daily(p.id, "Too late");
    const r = runDueSchedules(at("2026-11-13T10:01:00Z")).find((x) => x.templateId === off.id)!;
    assert.equal(r.outcome, "missed");
    assert.match(r.note, /121 minutes late \(the limit is 120\)/);
    assert.equal(runsOf(off.id).length, 0);
    assert.equal(row(off.id).next_run_at, "2026-11-14 08:00:00");
  });

  it("several times missed in a row are one: it is run once at most, and the next time is worked out from now", async () => {
    const p = newProject();
    const s = await daily(p.id, "Away for days");
    db.prepare("UPDATE run_templates SET next_run_at = '2026-11-10 08:00:00' WHERE id = ?").run(s.id); // the app was off since the 10th
    const r = runDueSchedules(at("2026-11-13T07:00:00Z"));
    assert.deepEqual(r.map((x) => [x.templateId, x.outcome]), [[s.id, "missed"]], "the 10th is recorded, the 11th and 12th are not made up");
    assert.equal(row(s.id).next_run_at, "2026-11-13 08:00:00");
    assert.deepEqual(runsOf(s.id), []);
    assert.equal(fires(s.id).length, 1);
    const back = runDueSchedules(at("2026-11-13T08:00:00Z"));
    assert.deepEqual(back.map((x) => x.outcome), ["started"], "and it carries on as planned");
  });

  it("is skipped while the previous scheduled run is in progress; once that is completed the next one is made; a run started by hand does not count", async () => {
    const p = newProject();
    const s = await daily(p.id, "Overlap");
    const first = runDueSchedules(at("2026-11-13T08:00:00Z"))[0];
    assert.equal(first.outcome, "started");
    const second = runDueSchedules(at("2026-11-14T08:00:00Z"))[0];
    assert.deepEqual([second.outcome, second.runId, second.note], ["skipped_overlap", null, `Run #${first.runId} from an earlier schedule is still in progress`]);
    assert.equal(runsOf(s.id).length, 1, "nothing was made");
    assert.equal(row(s.id).next_run_at, "2026-11-15 08:00:00", "and the schedule goes on");
    await call("PATCH", `/api/runs/${first.runId}`, { status: "completed" });
    const third = runDueSchedules(at("2026-11-15T08:00:00Z"))[0];
    assert.equal(third.outcome, "started");

    const by = await daily(p.id, "By hand");
    const manual = (await call("POST", `/api/templates/${by.id}/run`, {})).body;
    assert.equal(manual.status, "in_progress");
    assert.equal(runDueSchedules(at("2026-11-13T08:00:00Z")).find((r) => r.templateId === by.id)?.outcome, "started", "a run started by hand does not block the schedule");
  });

  it("a suite with no cases is recorded as skipped and makes no run; cases deleted since are not in the run", async () => {
    const p = newProject();
    const empty = await suite(p.id, "Empty", 0);
    setSchedule(empty.id, { schedule: "0 8 * * *", timezone: "UTC" }, "Test", at("2026-11-13T07:00:00Z"));
    const r = runDueSchedules(at("2026-11-13T08:00:00Z")).find((x) => x.templateId === empty.id)!;
    assert.deepEqual([r.outcome, r.note, r.runId], ["skipped_empty", "The suite has no test cases", null]);
    assert.equal(runsOf(empty.id).length, 0);

    const some = await daily(p.id, "Fewer", 3);
    await call("DELETE", `/api/cases/${some.caseIds[0]}`);
    const made = runDueSchedules(at("2026-11-13T08:00:00Z")).find((x) => x.templateId === some.id)!;
    assert.equal((await call("GET", `/api/runs/${made.runId}`)).body.results.length, 2);
  });

  it("a time that has been dealt with is never dealt with twice: a row for it already there means nothing more is made", async () => {
    const p = newProject();
    const s = await daily(p.id, "Claimed");
    db.prepare("INSERT INTO suite_schedule_fires (template_id, scheduled_for, outcome, note) VALUES (?, '2026-11-13 08:00:00', 'started', 'by another process')").run(s.id);
    const r = runDueSchedules(at("2026-11-13T08:00:00Z"))[0];
    assert.deepEqual([r.outcome, r.note], ["started", "by another process"], "it reports what was already recorded");
    assert.equal(runsOf(s.id).length, 0, "and makes no run of its own");
    assert.equal(fires(s.id).length, 1);
    assert.equal(row(s.id).next_run_at, "2026-11-14 08:00:00");
  });

  it("a failure is recorded as an error, rolls back what it started, is not tried again every minute, and does not stop the other suites", async () => {
    const p = newProject();
    const a = await daily(p.id, "Breaks");
    const b = await daily(p.id, "Fine");
    const done = runDueSchedules(at("2026-11-13T08:00:00Z"), (id, input) => {
      if (id === a.id) throw new Error("boom");
      return startSuiteRun(id, input);
    });
    assert.deepEqual(Object.fromEntries(done.map((r) => [r.templateId, r.outcome])), { [a.id]: "error", [b.id]: "started" });
    assert.deepEqual(fires(a.id).map((f) => [f.outcome, f.note, f.run_id]), [["error", "boom", null]]);
    assert.equal(runsOf(a.id).length, 0);
    assert.equal(runsOf(b.id).length, 1);
    assert.equal(row(a.id).next_run_at, "2026-11-14 08:00:00");
    assert.deepEqual(runDueSchedules(at("2026-11-13T08:01:00Z")), [], "not tried again a minute later");
  });

  it("schedules of different projects stay in their own projects", async () => {
    const one = newProject();
    const two = newProject();
    const a = await daily(one.id, "Project one");
    const b = await daily(two.id, "Project two");
    runDueSchedules(at("2026-11-13T08:00:00Z"));
    assert.deepEqual([runsOf(a.id)[0].project_id, runsOf(b.id)[0].project_id], [one.id, two.id]);
    assert.equal((await call("GET", `/api/projects/${one.id}/runs`)).body.length, 1);
    assert.equal((await call("GET", `/api/projects/${two.id}/runs`)).body.length, 1);
  });

  it("deleting the suite takes its record of times with it, and the runs it made stay", async () => {
    const p = newProject();
    const s = await daily(p.id, "Delete me");
    const r = runDueSchedules(at("2026-11-13T08:00:00Z"))[0];
    await call("DELETE", `/api/templates/${s.id}`);
    assert.equal(fires(s.id).length, 0);
    const run = (await call("GET", `/api/runs/${r.runId}`)).body;
    assert.deepEqual([run.template_id, run.suite?.deleted, run.meta.scheduled.for], [null, true, "2026-11-13 08:00:00"]);
  });
});

describe("the timer", () => {
  it("is on unless TESTBENCH_SCHEDULER=0, and then it says so and starts nothing; the schedules are still saved", async () => {
    assert.equal(schedulerEnabled(), true);
    process.env.TESTBENCH_SCHEDULER = "0";
    try {
      assert.equal(schedulerEnabled(), false);
      const log: string[] = [];
      assert.equal(startScheduler((m) => log.push(m)), false);
      assert.match(log.join(" "), /Scheduler is off \(TESTBENCH_SCHEDULER=0\)/);
      const p = newProject();
      const s = await call("POST", `/api/projects/${p.id}/templates`, { name: "Saved anyway", caseIds: [makeCase(p.id, "A").id], schedule: "0 8 * * *" });
      assert.equal(s.body.schedule, "0 8 * * *");
      assert.equal((await call("GET", `/api/templates/${s.body.id}`)).body.scheduler_enabled, false, "so a screen can say it will not start");
    } finally {
      delete process.env.TESTBENCH_SCHEDULER;
    }
  });

  it("a suite with a schedule and no next time gets one when the app starts", async () => {
    const p = newProject();
    const s = await suite(p.id, "Repair me");
    db.prepare("UPDATE run_templates SET schedule = '0 8 * * *', schedule_tz = 'UTC', next_run_at = NULL WHERE id = ?").run(s.id);
    assert.equal(repairNextRuns(at("2026-11-13T07:00:00Z")) >= 1, true);
    assert.equal(row(s.id).next_run_at, "2026-11-13 08:00:00");
    assert.equal(repairNextRuns(at("2026-11-13T07:00:00Z")), 0, "and nothing the second time");
  });
});

describe("the new columns on a database that has suites already", () => {
  it("are added once, the suites keep what they had and have no schedule, and the record of times is there", () => {
    const d = new Database(":memory:");
    d.pragma("foreign_keys = ON");
    migrate(d);
    d.exec("DROP INDEX run_templates_due");
    d.exec("DROP TABLE suite_schedule_fires");
    for (const c of ["schedule", "schedule_tz", "next_run_at", "schedule_set_by", "schedule_set_at"]) d.exec(`ALTER TABLE run_templates DROP COLUMN ${c}`); // as it was before schedules
    d.exec("INSERT INTO projects (name, key) VALUES ('Old', 'OLD')");
    d.exec("INSERT INTO run_templates (project_id, name, environment, description) VALUES (1, 'Smoke', 'staging', 'kept')");
    migrate(d);
    migrate(d); // another start changes nothing
    assert.deepEqual(d.prepare("SELECT name, environment, description, schedule, schedule_tz, next_run_at, schedule_set_by FROM run_templates").all(), [
      { name: "Smoke", environment: "staging", description: "kept", schedule: null, schedule_tz: "UTC", next_run_at: null, schedule_set_by: null },
    ]);
    d.exec("INSERT INTO suite_schedule_fires (template_id, scheduled_for, outcome) VALUES (1, '2026-11-13 08:00:00', 'started')");
    assert.throws(() => d.exec("INSERT INTO suite_schedule_fires (template_id, scheduled_for, outcome) VALUES (1, '2026-11-13 08:00:00', 'started')"), /UNIQUE/, "a time can be recorded once");
    assert.throws(() => d.exec("INSERT INTO suite_schedule_fires (template_id, scheduled_for, outcome) VALUES (1, '2026-11-14 08:00:00', 'whatever')"), /CHECK/);
    assert.ok((d.prepare("PRAGMA index_list(run_templates)").all() as { name: string }[]).some((i) => i.name === "run_templates_due"));
    d.close();
  });
});
