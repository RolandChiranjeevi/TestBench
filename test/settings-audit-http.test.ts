import "./env.ts";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { db } from "../server/db.ts";

// The two switches decide what an agent may write (make proposals, hand in results), so the owner's decision to change one is in the audit log: who, and from what to what.
// Only a real change is written (the same value again decides nothing), and the entry holds no more than the two values. The real app (server/index.ts) is called in the
// process with app.inject. The tests are in order: first an installation with no accounts, where every change is the one person's, then one with an owner.
process.env.TESTBENCH_NO_LISTEN = "1";
const { app } = await import("../server/index.ts");
await app.ready();
after(() => app.close());

const HOME = "127.0.0.1"; // this computer: the only place the first account can be made from
const GOOD = "a long passphrase here";
const call = (method: "GET" | "PUT" | "POST", url: string, o: { cookie?: string; body?: unknown } = {}) =>
  app.inject({ method, url, remoteAddress: HOME, headers: { "x-testbench": "1", ...(o.cookie ? { cookie: o.cookie } : {}) }, payload: o.body as object | undefined });

type Row = { action: string; userId: number | null; actor: string; projectId: number | null; target: number | null; detail: string };
/** What the database holds for the entries whose action starts with `prefix`, newest first. */
const rows = (prefix = "settings."): Row[] =>
  db.prepare("SELECT action, actor_user_id AS userId, actor_label AS actor, project_id AS projectId, target_user_id AS target, detail FROM audit_log WHERE action LIKE ? ORDER BY id DESC").all(`${prefix}%`) as Row[];
const detail = (r: Row) => JSON.parse(r.detail) as Record<string, unknown>;

describe("with no accounts: the change of an agent switch is in the audit log", () => {
  it("writes one entry when agent results is switched on: from off to on, and nothing else", async () => {
    assert.deepEqual(rows(), [], "nothing is written before a switch is touched");
    const res = await call("PUT", "/api/settings/agent-results", { body: { enabled: true } });
    assert.deepEqual([res.statusCode, res.json()], [200, { enabled: true }]);
    const log = rows();
    assert.equal(log.length, 1);
    assert.equal(log[0].action, "settings.agent_results_changed");
    assert.deepEqual(detail(log[0]), { from: false, to: true });
    assert.ok(log[0].actor.length > 0, "the entry says who, even when nobody has a name yet");
    assert.equal(log[0].userId, null, "there is no account to point to");
    assert.equal(log[0].projectId, null, "the switch belongs to the installation, not to a project");
    assert.equal(log[0].target, null);
  });

  it("writes nothing when the same value is put again", async () => {
    assert.equal((await call("PUT", "/api/settings/agent-results", { body: { enabled: true } })).statusCode, 200);
    assert.equal(rows().length, 1);
  });

  it("writes a second entry when it is switched off again, newest first", async () => {
    assert.equal((await call("PUT", "/api/settings/agent-results", { body: { enabled: false } })).statusCode, 200);
    const log = rows();
    assert.equal(log.length, 2);
    assert.deepEqual(log.map(detail), [{ from: true, to: false }, { from: false, to: true }]);
    assert.ok(log.every((r) => r.action === "settings.agent_results_changed"));
  });

  it("does the same for agent proposals, as an action of its own", async () => {
    assert.equal((await call("PUT", "/api/settings/agent-proposals", { body: { enabled: true } })).statusCode, 200);
    assert.equal((await call("PUT", "/api/settings/agent-proposals", { body: { enabled: true } })).statusCode, 200);
    const proposals = rows("settings.agent_proposals");
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].action, "settings.agent_proposals_changed");
    assert.deepEqual(detail(proposals[0]), { from: false, to: true });
    assert.equal(rows("settings.agent_results").length, 2, "a prefix keeps the two switches apart");
    assert.equal(rows().length, 3);
  });

  it("holds no token, hash or other secret: only the two values", () => {
    for (const r of rows()) {
      assert.deepEqual(Object.keys(detail(r)).sort(), ["from", "to"]);
      assert.doesNotMatch(JSON.stringify(r), /tbrq_|tbpr_|token|hash|secret|cookie/i);
    }
  });

  it("writes nothing when the value is not a yes or a no", async () => {
    const n = rows().length;
    assert.equal((await call("PUT", "/api/settings/agent-results", { body: { enabled: "yes" } })).statusCode, 400);
    assert.equal((await call("PUT", "/api/settings/agent-proposals", { body: {} })).statusCode, 400);
    assert.equal(rows().length, n);
  });
});

describe("with an owner account: the entry names the owner, and the owner can read it", () => {
  const state: { cookie: string; id: number } = { cookie: "", id: 0 };

  it("an owner is made, and switching agent results on is written under their name", async () => {
    const setup = await call("POST", "/api/setup", { body: { name: "Anna Owner", email: "anna@example.com", password: GOOD } });
    assert.equal(setup.statusCode, 200);
    state.id = setup.json().user.id;
    state.cookie = `tb_sid=${/tb_sid=([^;]*)/.exec(String(setup.headers["set-cookie"]))?.[1]}`;
    const res = await call("PUT", "/api/settings/agent-results", { cookie: state.cookie, body: { enabled: true } });
    assert.deepEqual([res.statusCode, res.json()], [200, { enabled: true }]);
    const [newest] = rows();
    assert.equal(newest.action, "settings.agent_results_changed");
    assert.deepEqual(detail(newest), { from: false, to: true });
    assert.equal(newest.userId, state.id);
    assert.equal(newest.actor, "Anna Owner");
  });

  it("is shown by the audit log of the owner, and found through the Settings prefix", async () => {
    const all = (await call("GET", "/api/audit-log?limit=50&action=settings.", { cookie: state.cookie })).json() as { action: string; actor: string; actorUserId: number | null; detail: Record<string, unknown> }[];
    assert.equal(all.length, 4, "three from the open installation (results on, results off, proposals on) and the owner's");
    assert.deepEqual([all[0].action, all[0].actor, all[0].actorUserId, all[0].detail], ["settings.agent_results_changed", "Anna Owner", state.id, { from: false, to: true }]);
    assert.equal((await call("GET", "/api/audit-log?limit=50&action=settings.agent_proposals", { cookie: state.cookie })).json().length, 1);
  });

  it("writes nothing when someone without a session tries to change a switch", async () => {
    const n = rows().length;
    const res = await call("PUT", "/api/settings/agent-results", { body: { enabled: false } });
    assert.equal(res.statusCode, 401);
    assert.equal(rows().length, n);
    assert.deepEqual((await call("GET", "/api/settings/agent-results", { cookie: state.cookie })).json(), { enabled: true }, "the switch did not move");
  });
});
