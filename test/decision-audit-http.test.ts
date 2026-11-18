import "./env.ts";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { db } from "../server/db.ts";

// A person's decision that makes a project, finishes a run, or turns what an agent proposed into trusted material (a test case made ready, a bug proposal or a manual test suggestion
// accepted or rejected) is in the audit log: who took it, in which project, about which thing, and from what to what. Only a real change is written. The real app (server/index.ts) is
// called in the process with app.inject, first on an installation with no accounts, then with an owner (the database refuses a decision without an account once there is one).
process.env.TESTBENCH_NO_LISTEN = "1";
const { app } = await import("../server/index.ts");
await app.ready();
after(() => app.close());

const HOME = "127.0.0.1"; // this computer: the only place the first account can be made from
const GOOD = "a long passphrase here";
const call = (method: "GET" | "PATCH" | "POST", url: string, o: { cookie?: string; body?: unknown } = {}) =>
  app.inject({ method, url, remoteAddress: HOME, headers: { "x-testbench": "1", ...(o.cookie ? { cookie: o.cookie } : {}) }, payload: o.body as object | undefined });

type Row = { action: string; userId: number | null; actor: string; projectId: number | null; target: number | null; detail: string };
const ACTIONS = ["case.status_changed", "project.created", "proposal.accepted", "proposal.case_created", "proposal.rejected", "proposal.restored", "run.finished", "run.reopened"];
/** The decision entries in the audit log, newest first. */
const rows = (): Row[] =>
  db.prepare(`SELECT action, actor_user_id AS userId, actor_label AS actor, project_id AS projectId, target_user_id AS target, detail FROM audit_log WHERE action IN (${ACTIONS.map(() => "?").join(",")}) ORDER BY id DESC`).all(...ACTIONS) as Row[];
const detail = (r: Row) => JSON.parse(r.detail) as Record<string, unknown>;
const count = () => rows().length;

let n = 0;
const project = async (cookie?: string) => {
  n++;
  const res = await call("POST", "/api/projects", { cookie, body: { name: `Decisions ${n}`, key: `DC${n}` } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { id: number; key: string };
};
const makeCase = async (pid: number, status: "draft" | "ready" | "deprecated", cookie?: string) => {
  const res = await call("POST", `/api/projects/${pid}/cases`, { cookie, body: { title: `A case ${++n}`, status } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { id: number; number: number };
};
let bn = 0;
const bug = (pid: number) => (db.prepare("INSERT INTO bug_reports (project_id, origin_audit_id, source_id, title) VALUES (?, 'a1', ?, 'A bug') RETURNING id").get(pid, `B-${++bn}`) as { id: number }).id;
const manual = (pid: number) => (db.prepare("INSERT INTO manual_tests (project_id, origin_audit_id, source_id, title, agent_priority, category) VALUES (?, 'a1', ?, 'A manual test', 'medium', 'functional') RETURNING id").get(pid, `M-${++bn}`) as { id: number }).id;
const review = (kind: "bug-reports" | "manual-tests", id: number, status: string, cookie?: string) => call("POST", `/api/${kind}/${id}/review`, { cookie, body: { status } });

describe("with no accounts: a decision is written once, and only when it changes something", () => {
  let p: { id: number; key: string };

  it("making a project writes who, the project, and its key and name; a refused one writes nothing", async () => {
    assert.deepEqual(rows(), [], "nothing is written before a decision");
    p = await project();
    const [r] = rows();
    assert.equal(r.action, "project.created");
    assert.equal(r.projectId, p.id);
    assert.deepEqual(detail(r), { key: p.key, name: `Decisions ${n}` });
    assert.ok(r.actor.length > 0, "the entry says who, even when nobody has a name yet");
    assert.equal(r.userId, null);
    const before = count();
    assert.equal((await call("POST", "/api/projects", { body: { name: "Again", key: p.key } })).statusCode, 409, "the key is used");
    assert.equal(count(), before);
  });

  it("a test case made ready is written with its key, from and to; the same status, or another field, writes nothing", async () => {
    const c = await makeCase(p.id, "draft");
    const before = count();
    assert.equal((await call("PATCH", `/api/cases/${c.id}`, { body: { status: "ready" } })).statusCode, 200);
    const [r] = rows();
    assert.equal(count(), before + 1);
    assert.deepEqual([r.action, r.projectId, detail(r)], ["case.status_changed", p.id, { case: c.id, key: `${p.key}-${c.number}`, from: "draft", to: "ready" }]);
    assert.equal((await call("PATCH", `/api/cases/${c.id}`, { body: { status: "ready" } })).statusCode, 200);
    assert.equal((await call("PATCH", `/api/cases/${c.id}`, { body: { title: "A new title" } })).statusCode, 200);
    assert.equal(count(), before + 1, "no change of status, no entry");
    assert.equal((await call("PATCH", `/api/cases/${c.id}`, { body: { status: "deprecated", title: "Retired" } })).statusCode, 200);
    assert.deepEqual(detail(rows()[0]), { case: c.id, key: `${p.key}-${c.number}`, from: "ready", to: "deprecated" });
    assert.equal((await call("PATCH", "/api/cases/999999", { body: { status: "ready" } })).statusCode, 404);
    assert.equal(count(), before + 2);
  });

  it("changing the status of many cases is one entry with the number that moved; nothing moving writes nothing", async () => {
    const a = await makeCase(p.id, "draft");
    const b = await makeCase(p.id, "draft");
    const ready = await makeCase(p.id, "ready");
    const before = count();
    const res = await call("POST", `/api/projects/${p.id}/cases/bulk`, { body: { ids: [a.id, b.id, ready.id], status: "ready" } });
    assert.deepEqual([res.statusCode, res.json()], [200, { updated: 3 }], "the answer is as it was");
    const [r] = rows();
    assert.equal(count(), before + 1);
    assert.deepEqual([r.action, r.projectId, detail(r)], ["case.status_changed", p.id, { count: 2, to: "ready", cases: [a.id, b.id] }]);
    assert.equal((await call("POST", `/api/projects/${p.id}/cases/bulk`, { body: { ids: [a.id, b.id, ready.id], status: "ready" } })).statusCode, 200);
    assert.equal((await call("POST", `/api/projects/${p.id}/cases/bulk`, { body: { ids: [a.id, b.id], priority: "high" } })).statusCode, 200);
    assert.equal((await call("POST", `/api/projects/${p.id}/cases/bulk`, { body: { ids: [], status: "ready" } })).statusCode, 400);
    assert.equal(count(), before + 1, "no change of status, no entry");
  });

  it("a bug proposal: accepted, rejected, restored and marked a duplicate are each written, from and to", async () => {
    const one = bug(p.id);
    const before = count();
    assert.equal((await review("bug-reports", one, "accepted")).statusCode, 200);
    assert.deepEqual([rows()[0].action, rows()[0].projectId, detail(rows()[0])], ["proposal.accepted", p.id, { kind: "bug_report", proposal: one, from: "proposed", to: "accepted" }]);
    assert.equal((await review("bug-reports", one, "accepted")).statusCode, 200);
    assert.equal(count(), before + 1, "the same decision again writes nothing");
    assert.equal((await review("bug-reports", one, "rejected")).statusCode, 200);
    assert.deepEqual([rows()[0].action, detail(rows()[0])], ["proposal.rejected", { kind: "bug_report", proposal: one, from: "accepted", to: "rejected" }]);
    assert.equal((await review("bug-reports", one, "proposed")).statusCode, 200);
    assert.deepEqual([rows()[0].action, detail(rows()[0])], ["proposal.restored", { kind: "bug_report", proposal: one, from: "rejected", to: "proposed" }]);
    const two = bug(p.id);
    assert.equal((await call("POST", `/api/bug-reports/${two}/duplicate`, { body: { ofId: one } })).statusCode, 200);
    assert.deepEqual([rows()[0].action, detail(rows()[0])], ["proposal.rejected", { kind: "bug_report", proposal: two, from: "proposed", to: "duplicate", duplicate_of: one }]);
    assert.equal(count(), before + 4);
    assert.equal((await review("bug-reports", 999999, "accepted")).statusCode, 404);
    assert.equal(count(), before + 4, "an unknown proposal writes nothing");
  });

  it("a manual test suggestion: accepted, rejected and restored are written, and adding it to the project names the test case it became", async () => {
    const one = manual(p.id);
    const before = count();
    assert.equal((await review("manual-tests", one, "rejected")).statusCode, 200);
    assert.deepEqual([rows()[0].action, rows()[0].projectId, detail(rows()[0])], ["proposal.rejected", p.id, { kind: "manual_test", proposal: one, from: "proposed", to: "rejected" }]);
    assert.equal((await review("manual-tests", one, "proposed")).statusCode, 200);
    assert.equal(rows()[0].action, "proposal.restored");
    const two = manual(p.id);
    const res = await call("POST", `/api/manual-tests/${two}/add-to-project`, { body: {} });
    assert.equal(res.statusCode, 200, res.body);
    const key = res.json().case.key as string;
    assert.match(key, new RegExp(`^${p.key}-\\d+$`));
    assert.deepEqual([rows()[0].action, detail(rows()[0])], ["proposal.accepted", { kind: "manual_test", proposal: two, from: "proposed", to: "accepted", case: key }]);
    assert.equal(count(), before + 3);
    assert.equal((await call("POST", `/api/manual-tests/${two}/add-to-project`, { body: {} })).statusCode, 409, "already a test case");
    assert.equal(count(), before + 3, "a refused request writes nothing");
  });

  it("the second step of the two-step way (an accepted suggestion made a test case) is written with the case it became", async () => {
    const one = manual(p.id);
    assert.equal((await call("POST", `/api/manual-tests/${one}/create-case`, { body: {} })).statusCode, 409, "accept it first");
    assert.equal((await review("manual-tests", one, "accepted")).statusCode, 200);
    const before = count();
    const res = await call("POST", `/api/manual-tests/${one}/create-case`, { body: {} });
    assert.equal(res.statusCode, 200, res.body);
    const key = res.json().case.key as string;
    assert.deepEqual([rows()[0].action, rows()[0].projectId, detail(rows()[0])], ["proposal.case_created", p.id, { kind: "manual_test", proposal: one, case: key }]);
    assert.equal((await call("POST", `/api/manual-tests/${one}/create-case`, { body: {} })).statusCode, 409, "already a test case");
    assert.equal(count(), before + 1, "a refused request writes nothing");
  });

  it("a requirement proposal: approved and rejected are written, with the requirement it became; a decided one cannot be decided again", async () => {
    const make = () => (db.prepare("INSERT INTO requirement_proposals (project_id, title) VALUES (?, 'A requirement') RETURNING id").get(p.id) as { id: number }).id;
    const [a, b] = [make(), make()];
    const before = count();
    const ok = await call("POST", `/api/requirement-proposals/${a}/approve`);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.deepEqual([rows()[0].action, rows()[0].projectId, detail(rows()[0])], ["proposal.accepted", p.id, { kind: "requirement", proposal: a, from: "proposed", to: "approved", requirement: ok.json().requirementId }]);
    assert.equal((await call("POST", `/api/requirement-proposals/${b}/reject`, { body: { reason: "Not needed" } })).statusCode, 200);
    assert.deepEqual([rows()[0].action, rows()[0].projectId, detail(rows()[0])], ["proposal.rejected", p.id, { kind: "requirement", proposal: b, from: "proposed", to: "rejected" }]);
    assert.doesNotMatch(rows()[0].detail, /Not needed/, "the reason stays with the proposal, not in the log");
    assert.equal(count(), before + 2);
    assert.equal((await call("POST", `/api/requirement-proposals/${a}/approve`)).statusCode, 409);
    assert.equal((await call("POST", `/api/requirement-proposals/${b}/reject`, { body: { reason: "Again" } })).statusCode, 409);
    assert.equal((await call("POST", `/api/requirement-proposals/${make()}/reject`, { body: { reason: "" } })).statusCode, 400, "a reason is needed");
    assert.equal((await call("POST", "/api/requirement-proposals/999999/approve")).statusCode, 404);
    assert.equal(count(), before + 2, "a refused decision writes nothing");
  });

  it("finishing a run is written, and so is reopening it; the same status, or another field, writes nothing", async () => {
    const c = await makeCase(p.id, "ready");
    const res = await call("POST", `/api/projects/${p.id}/runs`, { body: { title: "Nightly", caseIds: [c.id] } });
    assert.equal(res.statusCode, 200, res.body);
    const run = res.json() as { id: number };
    const before = count();
    assert.equal((await call("PATCH", `/api/runs/${run.id}`, { body: { status: "completed" } })).statusCode, 200);
    assert.deepEqual([rows()[0].action, rows()[0].projectId, detail(rows()[0])], ["run.finished", p.id, { run: run.id }]);
    assert.equal((await call("PATCH", `/api/runs/${run.id}`, { body: { status: "completed" } })).statusCode, 200);
    assert.equal((await call("PATCH", `/api/runs/${run.id}`, { body: { title: "Renamed" } })).statusCode, 200);
    assert.equal(count(), before + 1, "no change of status, no entry");
    assert.equal((await call("PATCH", `/api/runs/${run.id}`, { body: { status: "in_progress" } })).statusCode, 200);
    assert.deepEqual([rows()[0].action, detail(rows()[0])], ["run.reopened", { run: run.id }]);
    assert.equal(count(), before + 2);
  });

  it("no entry holds more than the facts of the decision (no token, hash, secret or cookie)", () => {
    for (const r of rows()) assert.doesNotMatch(r.detail, /tb(rq|ag|pr|ci)_|token|hash|secret|cookie/i);
  });
});

describe("with an owner account: the decisions are written under the owner's name and account", () => {
  const state: { cookie: string; id: number } = { cookie: "", id: 0 };

  it("an owner is made", async () => {
    const setup = await call("POST", "/api/setup", { body: { name: "Anna Owner", email: "anna@example.com", password: GOOD } });
    assert.equal(setup.statusCode, 200);
    state.id = setup.json().user.id;
    state.cookie = `tb_sid=${/tb_sid=([^;]*)/.exec(String(setup.headers["set-cookie"]))?.[1]}`;
  });

  it("making a project, a case ready, a proposal accepted and rejected, and a run finished are each under the owner", async () => {
    const p = await project(state.cookie);
    const c = await makeCase(p.id, "draft", state.cookie);
    assert.equal((await call("PATCH", `/api/cases/${c.id}`, { cookie: state.cookie, body: { status: "ready" } })).statusCode, 200);
    assert.equal((await review("bug-reports", bug(p.id), "rejected", state.cookie)).statusCode, 200);
    assert.equal((await review("manual-tests", manual(p.id), "accepted", state.cookie)).statusCode, 200);
    const run = (await call("POST", `/api/projects/${p.id}/runs`, { cookie: state.cookie, body: { title: "Owned", caseIds: [c.id] } })).json() as { id: number };
    assert.equal((await call("PATCH", `/api/runs/${run.id}`, { cookie: state.cookie, body: { status: "completed" } })).statusCode, 200);
    const mine = rows().slice(0, 5).reverse();
    assert.deepEqual(mine.map((r) => r.action), ["project.created", "case.status_changed", "proposal.rejected", "proposal.accepted", "run.finished"]);
    for (const r of mine) assert.deepEqual([r.actor, r.userId, r.projectId], ["Anna Owner", state.id, p.id]);
  });

  it("the owner can read them, and each prefix finds its own", async () => {
    const find = async (prefix: string) => (await call("GET", `/api/audit-log?limit=500${prefix ? `&action=${prefix}` : ""}`, { cookie: state.cookie })).json() as { action: string; actor: string }[];
    for (const [prefix, expected] of [["case.", ["case.status_changed"]], ["proposal.", ["proposal.accepted", "proposal.case_created", "proposal.rejected", "proposal.restored"]], ["run.", ["run.finished", "run.reopened"]], ["project.", ["project.created"]]] as const) {
      const found = await find(prefix);
      assert.ok(found.length > 0, `${prefix} finds entries`);
      assert.ok(found.every((x) => (expected as readonly string[]).includes(x.action)), `${prefix} finds only its own`);
    }
    assert.equal((await find("")).filter((x) => ACTIONS.includes(x.action)).length, count(), "and they are all in the log");
  });

  it("writes nothing when someone without a session tries to decide", async () => {
    const p = await project(state.cookie);
    const c = await makeCase(p.id, "draft", state.cookie);
    const b = bug(p.id);
    const before = count();
    assert.equal((await call("PATCH", `/api/cases/${c.id}`, { body: { status: "ready" } })).statusCode, 401);
    assert.equal((await review("bug-reports", b, "accepted")).statusCode, 401);
    assert.equal((await call("POST", "/api/projects", { body: { name: "No", key: "NO" } })).statusCode, 401);
    assert.equal(count(), before);
  });
});
