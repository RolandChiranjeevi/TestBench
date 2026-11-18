import "./env.ts";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import { db, migrate } from "../server/db.ts";

// Who decided on a manual test suggestion, who finished a run, and who made a test case from an accepted suggestion is kept on the row (not only in the audit log): reviewed_by,
// finished_by and created_by, each with the account behind the name when there are accounts. The real app (server/index.ts) is called in the process with app.inject, first on an
// installation with no accounts (the name is the display name from Settings, as typed), then with an owner (the name of the account, and the account).
process.env.TESTBENCH_NO_LISTEN = "1";
const { app } = await import("../server/index.ts");
await app.ready();
after(() => app.close());

const HOME = "127.0.0.1"; // this computer: the only place the first account can be made from
const GOOD = "a long passphrase here";
const call = (method: "GET" | "PATCH" | "POST" | "PUT", url: string, o: { cookie?: string; body?: unknown } = {}) =>
  app.inject({ method, url, remoteAddress: HOME, headers: { "x-testbench": "1", ...(o.cookie ? { cookie: o.cookie } : {}) }, payload: o.body as object | undefined });

let n = 0;
const project = async (cookie?: string) => {
  n++;
  const res = await call("POST", "/api/projects", { cookie, body: { name: `Identity ${n}`, key: `ID${n}` } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { id: number; key: string };
};
const makeCase = async (pid: number, cookie?: string) => {
  const res = await call("POST", `/api/projects/${pid}/cases`, { cookie, body: { title: `A case ${++n}`, status: "ready" } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { id: number };
};
let bn = 0;
const manual = (pid: number) => (db.prepare("INSERT INTO manual_tests (project_id, origin_audit_id, source_id, title, agent_priority, category) VALUES (?, 'a1', ?, 'A manual test', 'medium', 'functional') RETURNING id").get(pid, `M-${++bn}`) as { id: number }).id;
const review = (id: number, status: string, cookie?: string) => call("POST", `/api/manual-tests/${id}/review`, { cookie, body: { status } });
const named = async (name: string, cookie?: string) => assert.equal((await call("PUT", "/api/settings/display-name", { cookie, body: { name } })).statusCode, 200);
const suggestion = (id: number) => db.prepare("SELECT review_status AS status, reviewed_at AS at, reviewed_by AS by, reviewed_by_user_id AS uid FROM manual_tests WHERE id = ?").get(id) as { status: string; at: string | null; by: string; uid: number | null };
const run = (id: number) => db.prepare("SELECT status, finished_at AS at, finished_by AS by, finished_by_user_id AS uid FROM runs WHERE id = ?").get(id) as { status: string; at: string | null; by: string; uid: number | null };
const made = (id: number) => db.prepare("SELECT created_by AS by, created_by_user_id AS uid FROM cases WHERE id = ?").get(id) as { by: string; uid: number | null };
const startRun = async (pid: number, cookie?: string) => {
  const c = await makeCase(pid, cookie);
  const res = await call("POST", `/api/projects/${pid}/runs`, { cookie, body: { title: `Run ${++n}`, caseIds: [c.id] } });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { id: number }).id;
};
const patchRun = (id: number, body: object, cookie?: string) => call("PATCH", `/api/runs/${id}`, { cookie, body });

describe("with no accounts: the name from Settings, as typed, and no account", () => {
  let p: { id: number; key: string };

  it("a decision on a manual test suggestion keeps who decided it, and the view shows it; putting it back to Suggested is a decision of its own", async () => {
    p = await project();
    const id = manual(p.id);
    assert.deepEqual(suggestion(id), { status: "proposed", at: null, by: "", uid: null }, "nobody has decided yet");
    assert.equal((await call("GET", `/api/manual-tests/${id}`)).json().reviewedBy, null);
    await named("Tess Tester");
    assert.equal((await review(id, "accepted")).statusCode, 200);
    assert.deepEqual([suggestion(id).status, suggestion(id).by, suggestion(id).uid], ["accepted", "Tess Tester", null]);
    assert.equal((await call("GET", `/api/manual-tests/${id}`)).json().reviewedBy, "Tess Tester");
    await named("Ben Boss");
    assert.equal((await review(id, "rejected")).statusCode, 200);
    assert.deepEqual([suggestion(id).status, suggestion(id).by], ["rejected", "Ben Boss"]);
    assert.equal((await review(id, "proposed")).statusCode, 200);
    assert.deepEqual([suggestion(id).status, suggestion(id).at, suggestion(id).by], ["proposed", null, "Ben Boss"], "who put it back; the time of a decision is gone, as before");
  });

  it("with no name in Settings it is 'unnamed user', as for a requirement, so it always says something", async () => {
    await named("");
    const id = manual(p.id);
    await review(id, "accepted");
    assert.equal(suggestion(id).by, "unnamed user");
  });

  it("adding a suggestion to the project: the reviewer and the creator of the case are the person who added it", async () => {
    await named("Tess Tester");
    const id = manual(p.id);
    const res = await call("POST", `/api/manual-tests/${id}/add-to-project`, { body: {} });
    assert.equal(res.statusCode, 200, res.body);
    const caseId = res.json().case.caseId as number;
    assert.deepEqual([suggestion(id).status, suggestion(id).by, suggestion(id).uid], ["accepted", "Tess Tester", null]);
    assert.deepEqual(made(caseId), { by: "Tess Tester", uid: null });
    assert.equal((await call("GET", `/api/cases/${caseId}`)).json().created_by, "Tess Tester", "the case shows it too");
  });

  it("the two-step way: the reviewer is who accepted, and the creator is who took the second step", async () => {
    const id = manual(p.id);
    await named("Anna Accepts");
    assert.equal((await review(id, "accepted")).statusCode, 200);
    await named("Ben Builds");
    const res = await call("POST", `/api/manual-tests/${id}/create-case`, { body: {} });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(suggestion(id).by, "Anna Accepts");
    assert.deepEqual(made(res.json().case.caseId), { by: "Ben Builds", uid: null });
  });

  it("a case made by hand has no creator recorded here: nothing is claimed for it", async () => {
    await named("Tess Tester");
    assert.deepEqual(made((await makeCase(p.id)).id), { by: "", uid: null });
  });

  it("a refused decision records nothing", async () => {
    const id = manual(p.id);
    assert.equal((await review(id, "maybe")).statusCode, 400);
    assert.equal((await review(999999, "accepted")).statusCode, 404);
    assert.deepEqual(suggestion(id), { status: "proposed", at: null, by: "", uid: null });
  });

  it("finishing a run records who, once; the same status, a rename, and a run that was finished before change nothing; reopening clears it", async () => {
    await named("Tess Tester");
    const id = await startRun(p.id);
    assert.deepEqual(run(id), { status: "in_progress", at: null, by: "", uid: null });
    const done = await patchRun(id, { status: "completed" });
    assert.equal(done.statusCode, 200, done.body);
    assert.deepEqual([done.json().finished_by, done.json().finished_by_user_id], ["Tess Tester", null], "the answer shows it");
    const first = run(id);
    assert.deepEqual([first.status, first.by, first.uid], ["completed", "Tess Tester", null]);
    assert.ok(first.at);
    await named("Ben Boss");
    assert.equal((await patchRun(id, { status: "completed" })).statusCode, 200);
    assert.equal((await patchRun(id, { title: "Renamed" })).statusCode, 200);
    assert.deepEqual(run(id), first, "still who finished it, and when");
    assert.equal((await patchRun(id, { status: "in_progress" })).statusCode, 200);
    assert.deepEqual(run(id), { status: "in_progress", at: null, by: "", uid: null }, "reopened: cleared, as finished_at is");
    assert.equal((await patchRun(id, { status: "completed" })).statusCode, 200);
    assert.deepEqual([run(id).status, run(id).by], ["completed", "Ben Boss"], "finished again, by who finished it now");
  });

  it("a run that was finished before (by an import, or before this was recorded) keeps nobody: it is not made to say who finished it by being saved again", async () => {
    const old = (db.prepare("INSERT INTO runs (project_id, title, kind, source, status, finished_at) VALUES (?, 'From CI', 'automated', 'upload', 'completed', '2026-01-01 00:00:00') RETURNING id").get(p.id) as { id: number }).id;
    await named("Tess Tester");
    assert.equal((await patchRun(old, { status: "completed", title: "From CI, renamed" })).statusCode, 200);
    assert.deepEqual(run(old), { status: "completed", at: "2026-01-01 00:00:00", by: "", uid: null });
  });

  it("a refused change to a run records nothing", async () => {
    const id = await startRun(p.id);
    assert.equal((await patchRun(id, { status: "finished" })).statusCode, 400);
    assert.equal((await patchRun(999999, { status: "completed" })).statusCode, 404);
    assert.deepEqual(run(id), { status: "in_progress", at: null, by: "", uid: null });
  });
});

describe("with an owner account: the name of the account, and the account", () => {
  const state: { cookie: string; id: number } = { cookie: "", id: 0 };

  it("an owner is made", async () => {
    const setup = await call("POST", "/api/setup", { body: { name: "Anna Owner", email: "anna@example.com", password: GOOD } });
    assert.equal(setup.statusCode, 200);
    state.id = setup.json().user.id;
    state.cookie = `tb_sid=${/tb_sid=([^;]*)/.exec(String(setup.headers["set-cookie"]))?.[1]}`;
  });

  it("a suggestion decided, a case made from it and a run finished are under the account, not a typed name", async () => {
    const p = await project(state.cookie);
    const id = manual(p.id);
    assert.equal((await review(id, "rejected", state.cookie)).statusCode, 200);
    assert.deepEqual([suggestion(id).by, suggestion(id).uid], ["Anna Owner", state.id]);
    assert.equal((await call("GET", `/api/manual-tests/${id}`, { cookie: state.cookie })).json().reviewedBy, "Anna Owner");

    const other = manual(p.id);
    const res = await call("POST", `/api/manual-tests/${other}/add-to-project`, { cookie: state.cookie, body: {} });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual([suggestion(other).by, suggestion(other).uid], ["Anna Owner", state.id]);
    assert.deepEqual(made(res.json().case.caseId), { by: "Anna Owner", uid: state.id });

    const runId = await startRun(p.id, state.cookie);
    assert.equal((await patchRun(runId, { status: "completed" }, state.cookie)).statusCode, 200);
    assert.deepEqual([run(runId).by, run(runId).uid], ["Anna Owner", state.id]);
    assert.equal((await patchRun(runId, { status: "in_progress" }, state.cookie)).statusCode, 200);
    assert.deepEqual([run(runId).by, run(runId).uid], ["", null]);
  });

  it("without a session nothing is decided, and nothing is recorded", async () => {
    const p = await project(state.cookie);
    const id = manual(p.id);
    const runId = await startRun(p.id, state.cookie);
    assert.equal((await review(id, "accepted")).statusCode, 401);
    assert.equal((await patchRun(runId, { status: "completed" })).statusCode, 401);
    assert.deepEqual(suggestion(id), { status: "proposed", at: null, by: "", uid: null });
    assert.deepEqual(run(runId), { status: "in_progress", at: null, by: "", uid: null });
  });
});

describe("a database from before the identity columns", () => {
  const NEW = [["manual_tests", "reviewed_by"], ["manual_tests", "reviewed_by_user_id"], ["runs", "finished_by"], ["runs", "finished_by_user_id"], ["cases", "created_by"], ["cases", "created_by_user_id"]] as const;

  it("gets the six columns, and every row is as it was, with nobody recorded (not made up)", () => {
    const d = new Database(":memory:");
    d.pragma("foreign_keys = ON");
    migrate(d);
    d.exec("INSERT INTO projects (name, key) VALUES ('Old', 'OLD')");
    d.exec("INSERT INTO cases (project_id, number, title) VALUES (1, 1, 'Old case')");
    d.exec("INSERT INTO runs (project_id, title, kind, source, status, finished_at) VALUES (1, 'Old run', 'manual', 'manual', 'completed', '2026-01-01 00:00:00')");
    d.exec("INSERT INTO manual_tests (project_id, origin_audit_id, source_id, title, agent_priority, category, review_status, reviewed_at) VALUES (1, 'a1', 'M-1', 'Old', 'medium', 'functional', 'accepted', '2026-01-01 00:00:00')");
    for (const [t, c] of NEW) d.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`);
    const has = () => NEW.filter(([t, c]) => (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((x) => x.name === c)).length;
    assert.equal(has(), 0, "the test builds old tables");
    const snapshot = () => JSON.stringify([d.prepare("SELECT id, title, status FROM cases").all(), d.prepare("SELECT id, status, finished_at FROM runs").all(), d.prepare("SELECT id, review_status, reviewed_at FROM manual_tests").all()]);
    const before = snapshot();
    migrate(d);
    migrate(d); // and again: nothing to do
    assert.equal(has(), 6);
    assert.equal(snapshot(), before);
    assert.deepEqual(d.prepare("SELECT created_by AS by, created_by_user_id AS uid FROM cases").all(), [{ by: "", uid: null }]);
    assert.deepEqual(d.prepare("SELECT finished_by AS by, finished_by_user_id AS uid FROM runs").all(), [{ by: "", uid: null }]);
    assert.deepEqual(d.prepare("SELECT reviewed_by AS by, reviewed_by_user_id AS uid FROM manual_tests").all(), [{ by: "", uid: null }]);
  });
});
