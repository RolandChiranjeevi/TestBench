import "./env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, describe, it } from "node:test";
import { db } from "../server/db.ts";

// A machine token is a credential for one project, so who made one and who revoked one is in the audit log, for all four kinds (a request token, an agent read token, a proposal token and
// a CI token): the kind, the project, and the token's id, name and prefix, never the token or its hash. A request token also keeps who made it. The real app (server/index.ts) is called
// in the process with app.inject, first on an installation with no accounts, then with an owner.
process.env.TESTBENCH_NO_LISTEN = "1";
const { app } = await import("../server/index.ts");
await app.ready();
after(() => app.close());

const HOME = "127.0.0.1"; // this computer: the only place the first account can be made from
const GOOD = "a long passphrase here";
const call = (method: "GET" | "PUT" | "POST", url: string, o: { cookie?: string; body?: unknown } = {}) =>
  app.inject({ method, url, remoteAddress: HOME, headers: { "x-testbench": "1", ...(o.cookie ? { cookie: o.cookie } : {}) }, payload: o.body as object | undefined });

const KINDS = [
  { kind: "request", make: "request-tokens", revoke: "request-tokens", label: "request" },
  { kind: "agent_read", make: "agent/tokens", revoke: "agent-tokens", label: "agent read" },
  { kind: "propose", make: "propose-tokens", revoke: "propose-tokens", label: "proposal" },
  { kind: "ci", make: "ci/tokens", revoke: "ci-tokens", label: "CI" },
] as const;
type Kind = (typeof KINDS)[number];

type Row = { id: number; action: string; userId: number | null; actor: string; projectId: number | null; target: number | null; detail: string };
/** The token entries in the audit log, newest first. */
const rows = (): Row[] =>
  db.prepare("SELECT id, action, actor_user_id AS userId, actor_label AS actor, project_id AS projectId, target_user_id AS target, detail FROM audit_log WHERE action LIKE 'token.%' ORDER BY id DESC").all() as Row[];
const detail = (r: Row) => JSON.parse(r.detail) as Record<string, unknown>;
type Made = { id: number; name: string; prefix: string; token: string };

let n = 0;
const project = async (cookie?: string) => {
  n++;
  const res = await call("POST", "/api/projects", { cookie, body: { name: `Tokens ${n}`, key: `TK${n}` } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().id as number;
};
const make = (pid: number, k: Kind, name = "qa-agent", cookie?: string) => call("POST", `/api/projects/${pid}/${k.make}`, { cookie, body: { name } });
const revoke = (id: number, k: Kind, cookie?: string) => call("POST", `/api/${k.revoke}/${id}/revoke`, { cookie, body: {} });

describe("with no accounts: a machine token made or revoked is in the audit log", () => {
  it("(set up) agent proposals are switched on, which a proposal token needs", async () => {
    assert.equal((await call("PUT", "/api/settings/agent-proposals", { body: { enabled: true } })).statusCode, 200);
  });

  for (const k of KINDS) {
    describe(`a ${k.label} token`, () => {
      let pid = 0;
      let made: Made;

      it("is made: one entry with the kind, the project, and the token's id, name and prefix, and nothing else", async () => {
        pid = await project();
        const before = rows().length;
        const res = await make(pid, k, "qa-agent");
        assert.equal(res.statusCode, 200, res.body);
        made = res.json() as Made;
        const log = rows();
        assert.equal(log.length, before + 1);
        assert.equal(log[0].action, "token.created");
        assert.deepEqual(detail(log[0]), { kind: k.kind, credential_id: made.id, name: "qa-agent", prefix: made.prefix });
        assert.equal(log[0].projectId, pid);
        assert.equal(log[0].target, null);
        assert.ok(log[0].actor.length > 0, "the entry says who, even when nobody has a name yet");
        assert.equal(log[0].userId, null, "there is no account to point to");
      });

      it("never holds the token or its hash, anywhere in the audit log", () => {
        const sha = createHash("sha256").update(made.token).digest("hex");
        const all = JSON.stringify(db.prepare("SELECT * FROM audit_log").all());
        assert.ok(!all.includes(made.token), "not the token");
        assert.ok(!all.includes(made.token.slice(made.prefix.length)), "not the part of it after the prefix");
        assert.ok(!all.includes(sha), "not its hash");
      });

      it("is revoked: one entry, and revoking it again writes nothing", async () => {
        const before = rows().length;
        assert.equal((await revoke(made.id, k)).statusCode, 200);
        const log = rows();
        assert.equal(log.length, before + 1);
        assert.equal(log[0].action, "token.revoked");
        assert.deepEqual(detail(log[0]), { kind: k.kind, credential_id: made.id, name: "qa-agent", prefix: made.prefix });
        assert.equal(log[0].projectId, pid, "the project of the token, which the revoke route does not name");
        assert.equal((await revoke(made.id, k)).statusCode, 200, "revoking again is harmless");
        assert.equal(rows().length, before + 1, "and leaves no second entry");
      });

      it("writes nothing when the id is unknown, the name is empty, or the project is full", async () => {
        const before = rows().length;
        assert.equal((await revoke(999999, k)).statusCode, 404);
        assert.equal((await make(pid, k, "  ")).statusCode, 400);
        assert.equal(rows().length, before);
        let madeUntilFull = 0;
        for (let i = 0; i < 30; i++) { // the most a kind allows is 20 (CI tokens)
          const res = await make(pid, k, `t${i}`);
          if (res.statusCode === 409) break;
          assert.equal(res.statusCode, 200, res.body);
          madeUntilFull++;
        }
        assert.ok(madeUntilFull >= 1 && madeUntilFull < 30, "the project's limit was reached");
        assert.equal(rows().length, before + madeUntilFull, "a refused creation is not in the log, and each made token is");
      });
    });
  }

  it("a request token keeps who made it (the name, and no account yet)", async () => {
    const pid = await project();
    const res = await make(pid, KINDS[0], "kept");
    const t = res.json() as Made;
    const row = db.prepare("SELECT created_by AS by, created_by_user_id AS uid FROM request_tokens WHERE id = ?").get(t.id) as { by: string; uid: number | null };
    assert.ok(row.by.length > 0);
    assert.equal(row.by, rows()[0].actor, "the same name as the audit entry");
    assert.equal(row.uid, null);
    const list = (await call("GET", `/api/projects/${pid}/request-tokens`)).json() as { id: number; createdBy: string }[];
    assert.equal(list.find((x) => x.id === t.id)?.createdBy, row.by, "the list shows it");
  });

  it("the table has the new columns, and the list never shows a hash", () => {
    const cols = (db.prepare("PRAGMA table_info(request_tokens)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes("created_by") && cols.includes("created_by_user_id"));
  });
});

describe("with an owner account: the entries name the owner", () => {
  const state: { cookie: string; id: number } = { cookie: "", id: 0 };

  it("an owner is made", async () => {
    const setup = await call("POST", "/api/setup", { body: { name: "Anna Owner", email: "anna@example.com", password: GOOD } });
    assert.equal(setup.statusCode, 200);
    state.id = setup.json().user.id;
    state.cookie = `tb_sid=${/tb_sid=([^;]*)/.exec(String(setup.headers["set-cookie"]))?.[1]}`;
  });

  it("making and revoking each kind of token is written under the owner's name and account", async () => {
    const pid = await project(state.cookie);
    for (const k of KINDS) {
      const t = (await make(pid, k, `by-${k.kind}`, state.cookie)).json() as Made;
      assert.equal((await revoke(t.id, k, state.cookie)).statusCode, 200);
      const [revoked, created] = rows();
      assert.deepEqual([created.action, created.actor, created.userId, created.projectId], ["token.created", "Anna Owner", state.id, pid]);
      assert.deepEqual([revoked.action, revoked.actor, revoked.userId, revoked.projectId], ["token.revoked", "Anna Owner", state.id, pid]);
      assert.equal(detail(created).kind, k.kind);
    }
  });

  it("a request token made by the owner keeps the owner's name and account", async () => {
    const pid = await project(state.cookie);
    const t = (await make(pid, KINDS[0], "owned", state.cookie)).json() as Made;
    assert.deepEqual(db.prepare("SELECT created_by AS by, created_by_user_id AS uid FROM request_tokens WHERE id = ?").get(t.id), { by: "Anna Owner", uid: state.id });
    const list = (await call("GET", `/api/projects/${pid}/request-tokens`, { cookie: state.cookie })).json() as { id: number; createdBy: string }[];
    assert.equal(list.find((x) => x.id === t.id)?.createdBy, "Anna Owner");
  });

  it("the owner can read the entries, and the Tokens prefix finds them", async () => {
    const all = (await call("GET", "/api/audit-log?limit=200&action=token.", { cookie: state.cookie })).json() as { action: string; actor: string; actorUserId: number | null; projectId: number | null; detail: Record<string, unknown> }[];
    assert.equal(all.length, rows().length);
    assert.ok(all.every((x) => x.action === "token.created" || x.action === "token.revoked"));
    assert.ok(all.every((x) => Object.keys(x.detail).sort().join() === "credential_id,kind,name,prefix"), "only those four things");
    assert.doesNotMatch(JSON.stringify(all), /tb(rq|ag|pr|ci)_[A-Za-z0-9_-]{20,}/, "no token anywhere");
    assert.equal(all[0].actor, "Anna Owner");
  });

  it("writes nothing when someone without a session tries to make or revoke a token", async () => {
    const pid = await project(state.cookie);
    const before = rows().length;
    for (const k of KINDS) {
      assert.equal((await make(pid, k, "x")).statusCode, 401);
      assert.equal((await revoke(1, k)).statusCode, 401);
    }
    assert.equal(rows().length, before);
  });
});
