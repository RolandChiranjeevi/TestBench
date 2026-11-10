import "./env.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import { strToU8, zipSync } from "fflate";
import * as dbm from "../server/db.ts";
import { createFirstOwner, createLink, getUser } from "../server/accounts.ts";

// What 5a must hold when someone is not friendly: who may back up and restore, restoring over accounts, several requests at the same instant, setup behind a proxy,
// the browser guard on every write route, and what a switched-off account does not take with it. Everything runs in this process through app.inject, on a temporary
// data folder (see env.ts): nothing here touches real data, opens a port or makes a network request.
process.env.TESTBENCH_NO_LISTEN = "1";
process.env.TESTBENCH_ALLOWED_HOSTS = "testbench.example.com";
const { app } = await import("../server/index.ts");
await app.ready();
const SCRATCH = mkdtempSync(join(tmpdir(), "tb-hardening-"));
after(async () => { await app.close(); rmSync(SCRATCH, { recursive: true, force: true }); });

const live = () => dbm.db; // the database is replaced by a restore: always ask for the current one
const count = (sql: string) => (live().prepare(sql).get() as { n: number }).n;
const ownerId = () => (live().prepare("SELECT id FROM users WHERE is_owner = 1").get() as { id: number }).id;
const GOOD = "a long passphrase here";
const HOME = "127.0.0.1";
const AWAY = "10.1.1.1";
type Opts = { ip?: string; cookie?: string; body?: unknown; headers?: Record<string, string>; guard?: boolean; raw?: Buffer; type?: string };
const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, o: Opts = {}) =>
  app.inject({
    method, url, remoteAddress: o.ip ?? AWAY,
    headers: { ...(o.guard === false ? {} : { "x-testbench": "1" }), ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.type ? { "content-type": o.type } : {}), ...(o.headers ?? {}) },
    payload: (o.raw ?? o.body) as object | undefined,
  });
const sid = (res: { headers: Record<string, unknown> }) => /tb_sid=([^;]*)/.exec(String(res.headers["set-cookie"] ?? ""))?.[1];
const login = async (email: string, password = GOOD, ip = AWAY) => { const r = await call("POST", "/api/login", { ip, body: { email, password } }); return sid(r) ? `tb_sid=${sid(r)}` : undefined; };
const status = async (res: Promise<{ statusCode: number }> | { statusCode: number }) => (await res).statusCode;

const s: { owner?: string; ownerEmail?: string; pia?: string; piaId?: number; piaEmail?: string; piaPw?: string } = {};

describe("setup is only offered from this computer, also behind a proxy and in Docker", () => {
  const setupBody = { name: "Anna Owner", email: "anna@example.com", password: GOOD };
  it("a request through a proxy that was not addressed to localhost is refused, even when it arrives from 127.0.0.1", async () => {
    const viaProxy = { "x-forwarded-for": "203.0.113.9", host: "testbench.example.com" };
    assert.equal((await call("GET", "/api/setup/status", { ip: HOME, headers: viaProxy })).json().available, false);
    assert.equal(await status(call("POST", "/api/setup", { ip: HOME, headers: viaProxy, body: setupBody })), 403);
    assert.equal(await status(call("POST", "/api/setup", { ip: HOME, headers: { forwarded: "for=203.0.113.9", host: "testbench.example.com" }, body: setupBody })), 403);
    assert.equal(await status(call("POST", "/api/setup", { ip: HOME, headers: { "x-forwarded-host": "testbench.example.com", host: "testbench.example.com" }, body: setupBody })), 403);
    assert.equal(count("SELECT COUNT(*) AS n FROM users"), 0);
  });
  it("Docker's network address is not this computer; a proxy header next to a localhost Host still is", async () => {
    assert.equal((await call("GET", "/api/setup/status", { ip: "172.17.0.1" })).json().available, false);
    assert.equal((await call("GET", "/api/setup/status", { ip: HOME, headers: { "x-forwarded-for": "127.0.0.1", host: "localhost:4100" } })).json().available, true);
    assert.equal((await call("GET", "/api/setup/status", { ip: HOME })).json().available, true);
  });
  it("five setups at the same instant make one account", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => call("POST", "/api/setup", { ip: HOME, body: { ...setupBody, email: `anna${i}@example.com` } })));
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409, 409, 409, 409]);
    assert.equal(count("SELECT COUNT(*) AS n FROM users"), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM users WHERE is_owner = 1"), 1);
    const winner = results.find((r) => r.statusCode === 200)!;
    s.owner = `tb_sid=${sid(winner)}`;
    s.ownerEmail = winner.json().user.email;
    assert.equal(await status(call("GET", "/api/me", { cookie: s.owner })), 200);
  });
});

describe("links used by several people at the same instant", () => {
  it("one invitation makes one account", async () => {
    const link = createLink({ kind: "invite", createdBy: getUser(ownerId())! });
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => call("POST", `/api/join/${link.token}`, { ip: `10.7.7.${i + 1}`, body: { name: `Pia ${i}`, email: `pia${i}@example.com`, password: GOOD } })));
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 410, 410, 410, 410]);
    assert.equal(count("SELECT COUNT(*) AS n FROM users WHERE is_owner = 0"), 1);
    const winner = results.find((r) => r.statusCode === 200)!;
    s.pia = `tb_sid=${sid(winner)}`;
    s.piaId = winner.json().user.id;
    s.piaEmail = winner.json().user.email;
  });

  it("one reset link sets one password, ends the old sessions, and only that password works", async () => {
    const link = createLink({ kind: "reset", createdBy: getUser(ownerId())!, userId: s.piaId });
    const passwords = Array.from({ length: 5 }, (_, i) => `reset passphrase number ${i}`);
    const results = await Promise.all(passwords.map((password, i) => call("POST", `/api/reset/${link.token}`, { ip: `10.8.8.${i + 1}`, body: { password } })));
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 410, 410, 410, 410]);
    assert.equal(await status(call("GET", "/api/me", { cookie: s.pia })), 401, "the old session ended");
    const tried = await Promise.all(passwords.map(async (p, i) => ({ p, cookie: await login(s.piaEmail!, p, `10.9.9.${i + 1}`) })));
    const works = tried.filter((t) => t.cookie);
    assert.equal(works.length, 1, "exactly one of the five passwords was set");
    s.pia = works[0].cookie;
    s.piaPw = works[0].p;
  });
});

describe("a new password cancels the reset links still open", () => {
  it("changing the password revokes the person's open reset links, and using one revokes the others", async () => {
    const owner = getUser(ownerId())!;
    const a = createLink({ kind: "reset", createdBy: owner, userId: s.piaId });
    const b = createLink({ kind: "reset", createdBy: owner, userId: s.piaId });
    const other = createLink({ kind: "reset", createdBy: owner, userId: owner.id });
    const changed = await call("POST", "/api/me/password", { cookie: s.pia, body: { current: s.piaPw, next: "yet another passphrase" } });
    assert.equal(changed.statusCode, 200);
    assert.equal(await status(call("GET", `/api/reset/${a.token}`, { ip: "10.4.4.4" })), 410);
    assert.equal(await status(call("POST", `/api/reset/${b.token}`, { ip: "10.4.4.4", body: { password: "an attacker's passphrase" } })), 410);
    assert.equal(await status(call("GET", `/api/reset/${other.token}`, { ip: "10.4.4.4" })), 200, "another person's link is untouched");
    const c = createLink({ kind: "reset", createdBy: owner, userId: s.piaId });
    const d = createLink({ kind: "reset", createdBy: owner, userId: s.piaId });
    assert.equal(await status(call("POST", `/api/reset/${c.token}`, { ip: "10.4.4.5", body: { password: "the final passphrase!" } })), 200);
    assert.equal(await status(call("GET", `/api/reset/${d.token}`, { ip: "10.4.4.5" })), 410);
    assert.equal(count(`SELECT COUNT(*) AS n FROM account_links WHERE kind = 'reset' AND user_id = ${s.piaId} AND used_at IS NULL AND revoked_at IS NULL`), 0);
    s.pia = await login(s.piaEmail!, "the final passphrase!");
    assert.ok(s.pia);
  });
});

/** POST /api/restore with a file, the way the browser sends it. */
function restore(file: Buffer, cookie?: string) {
  const boundary = "----tbtest" + Date.now();
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.zip"\r\nContent-Type: application/zip\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return call("POST", "/api/restore", { cookie, raw: Buffer.concat([head, file, tail]), type: `multipart/form-data; boundary=${boundary}` });
}

/** A backup zip made from a copy of the live database, which `edit` may change first (a synthetic backup: made here, never downloaded). */
async function syntheticBackup(name: string, edit?: (d: Database.Database) => void): Promise<Buffer> {
  const file = join(SCRATCH, `${name}.db`);
  await live().backup(file);
  if (edit) { const d = new Database(file); try { edit(d); } finally { d.close(); } }
  const manifest = { format: "testbench-backup/1", createdAt: new Date().toISOString(), projects: 0, cases: 0, runs: 0, uploadFiles: 0 };
  return Buffer.from(zipSync({ "manifest.json": strToU8(JSON.stringify(manifest)), "testbench.db": new Uint8Array(readFileSync(file)) }));
}

describe("only the owner may back up, restore, load the demo or switch agent proposals", () => {
  const forbidden = { error: "Only the owner can do this" };
  it("an ordinary account gets 403 on all four, and nothing changes", async () => {
    const projects = count("SELECT COUNT(*) AS n FROM projects");
    const before = (await call("GET", "/api/settings/agent-proposals", { cookie: s.pia })).json().enabled;
    const tries: ["GET" | "POST" | "PUT", string, unknown?][] = [["GET", "/api/backup"], ["POST", "/api/demo"], ["PUT", "/api/settings/agent-proposals", { enabled: !before }]];
    for (const [m, url, body] of tries) {
      const r = await call(m, url, { cookie: s.pia, body });
      assert.deepEqual([r.statusCode, r.json()], [403, forbidden], `${m} ${url}`);
    }
    const r = await restore(Buffer.from("not a zip"), s.pia);
    assert.deepEqual([r.statusCode, r.json()], [403, forbidden], "restore");
    assert.equal(count("SELECT COUNT(*) AS n FROM projects"), projects, "no demo was loaded");
    assert.equal((await call("GET", "/api/settings/agent-proposals", { cookie: s.pia })).json().enabled, before);
  });
  it("the owner can switch agent proposals, and everyone can read the switch", async () => {
    assert.equal(await status(call("PUT", "/api/settings/agent-proposals", { cookie: s.owner, body: { enabled: true } })), 200);
    assert.equal((await call("GET", "/api/settings/agent-proposals", { cookie: s.pia })).json().enabled, true);
    assert.equal(await status(call("PUT", "/api/settings/agent-proposals", { cookie: s.owner, body: { enabled: false } })), 200);
  });
});

describe("restoring a backup through the real route", () => {
  const marker = () => join(dbm.DATA_DIR, ".accounts-enabled");

  it("A. a damaged file is refused and nothing changes", async () => {
    const users = count("SELECT COUNT(*) AS n FROM users");
    for (const junk of [Buffer.from("this is not a zip at all"), Buffer.from(zipSync({ "readme.txt": strToU8("no manifest, no database") }))]) {
      const r = await restore(junk, s.owner);
      assert.equal(r.statusCode, 400, r.body);
    }
    const whole = await syntheticBackup("damaged");
    assert.equal((await restore(whole.subarray(0, Math.floor(whole.length / 2)), s.owner)).statusCode, 400);
    assert.equal(count("SELECT COUNT(*) AS n FROM users"), users);
    assert.equal(await status(call("GET", "/api/me", { cookie: s.owner })), 200, "still signed in: nothing was replaced");
  });

  it("C and E. the owner restores a backup that carries sessions: none of them is alive afterwards, and the owner signs in again", async () => {
    const piaCookie = s.pia!;
    const backup = await syntheticBackup("with-sessions");
    const inBackup = new Database(join(SCRATCH, "with-sessions.db"), { readonly: true });
    assert.ok((inBackup.prepare("SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL").get() as { n: number }).n >= 2, "the backup really has live sessions");
    inBackup.close();
    const users = count("SELECT COUNT(*) AS n FROM users");
    const r = await restore(backup, s.owner);
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(existsSync(join(dbm.DATA_DIR, r.json().previous)), "the replaced data was moved aside, not deleted");
    assert.equal(count("SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL"), 0, "no session from the backup is alive");
    assert.equal(count("SELECT COUNT(*) AS n FROM users"), users, "the accounts of the backup are the accounts now");
    for (const cookie of [s.owner, piaCookie]) assert.equal(await status(call("GET", "/api/projects", { cookie })), 401);
    assert.equal(existsSync(marker()), true);
    s.owner = await login(s.ownerEmail!);
    assert.ok(s.owner, "a restored account signs in with its own password");
    assert.equal(await status(call("GET", "/api/projects", { cookie: s.owner })), 200);
  });

  it("D. an ordinary account cannot restore, not even a crafted backup that would make it the owner", async () => {
    const pia = await login(s.piaEmail!, "the final passphrase!");
    assert.ok(pia);
    const crafted = await syntheticBackup("crafted", (d) => d.prepare("UPDATE users SET is_owner = 1 WHERE email = ?").run(s.piaEmail));
    assert.equal((await restore(crafted, pia)).statusCode, 403);
    assert.equal(count("SELECT COUNT(*) AS n FROM users WHERE is_owner = 1"), 1);
    assert.equal((live().prepare("SELECT is_owner FROM users WHERE email = ?").get(s.piaEmail) as { is_owner: number }).is_owner, 0);
  });

  it("B. a backup from before accounts does not reopen the installation, and the command line is the way back", async () => {
    const old = await syntheticBackup("pre-accounts", (d) => { for (const t of ["sessions", "account_links", "audit_log", "users"]) d.exec(`DROP TABLE IF EXISTS ${t}`); });
    assert.equal((await restore(old, s.owner)).statusCode, 200);
    assert.equal(existsSync(marker()), true, "the marker survives the restore");
    assert.deepEqual((await call("GET", "/api/auth/status")).json(), { enabled: true, authenticated: false, mode: "locked" });
    for (const [m, url] of [["GET", "/api/projects"], ["POST", "/api/setup"], ["POST", "/api/login"], ["GET", "/setup"], ["GET", "/api/backup"], ["POST", "/api/restore"]] as const) {
      assert.equal(await status(call(m, url, { ip: HOME, body: {}, cookie: s.owner })), 503, `${m} ${url}`);
    }
    assert.equal(count("SELECT COUNT(*) AS n FROM users"), 0, "no account came with it");
    createFirstOwner({ email: "back@example.com", name: "Back Owner", password: GOOD }, { label: "cli" }, { allowLocked: true });
    assert.equal(await status(call("GET", "/api/projects", { cookie: s.owner })), 401, "an old cookie opens nothing");
    s.owner = await login("back@example.com");
    assert.ok(s.owner);
    assert.equal(await status(call("GET", "/api/projects", { cookie: s.owner })), 200);
    assert.ok(readdirSync(join(dbm.DATA_DIR, "previous")).length >= 2, "each restore kept what it replaced");
  });
});

describe("the browser guard covers every write route", () => {
  it("without the X-Testbench header, each of these gets 403 for a signed-in owner, and nothing changes", async () => {
    const routes: ["POST" | "PUT" | "PATCH" | "DELETE", string, unknown?][] = [
      ["POST", "/api/projects", { name: "x", key: "XX" }], ["POST", "/api/demo"], ["POST", "/api/restore"], ["PUT", "/api/settings/agent-proposals", { enabled: true }],
      ["PUT", "/api/settings/display-name", { name: "x" }], ["PATCH", "/api/me", { name: "x" }], ["POST", "/api/me/password", { current: GOOD, next: "x".repeat(12) }],
      ["POST", "/api/me/sessions/1/revoke"], ["POST", "/api/me/sessions/revoke-others"], ["POST", "/api/users/2/disable"], ["POST", "/api/users/2/enable"], ["POST", "/api/users/2/reset-link"],
      ["POST", "/api/invitations", { email: "a@b.co" }], ["POST", "/api/invitations/1/revoke"], ["POST", "/api/logout"], ["POST", "/api/login", { email: "a@b.co", password: GOOD }],
      ["POST", "/api/setup", { email: "a@b.co", password: GOOD }], ["POST", "/api/join/x", { name: "n", email: "a@b.co", password: GOOD }], ["POST", "/api/reset/x", { password: GOOD }],
      ["POST", "/api/projects/1/agent/tokens", { name: "x" }], ["POST", "/api/projects/1/ci/tokens", { name: "x" }], ["DELETE", "/api/projects/1"],
    ];
    const snapshot = () => [count("SELECT COUNT(*) AS n FROM projects"), count("SELECT COUNT(*) AS n FROM users"), count("SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL")];
    const before = snapshot();
    for (const [m, url, body] of routes) {
      const r = await call(m, url, { ip: HOME, cookie: s.owner, guard: false, body });
      assert.equal(r.statusCode, 403, `${m} ${url} answered ${r.statusCode}`);
    }
    assert.deepEqual(snapshot(), before);
  });
});

describe("turning an account off does not take project tokens with it (deliberate: they belong to the project)", () => {
  it("an agent token made by an account still reads after that account is switched off; its sessions do not", async () => {
    const project = (await call("POST", "/api/projects", { cookie: s.owner, body: { name: "Tokens", key: "TOK" } })).json();
    const invite = (await call("POST", "/api/invitations", { cookie: s.owner, body: { projectId: project.id, role: "admin" } })).json();
    invite.token = invite.url.split("/").pop();
    const joined = await call("POST", `/api/join/${invite.token}`, { ip: "10.5.5.5", body: { name: "Tess", email: "tess@example.com", password: GOOD } });
    assert.equal(joined.statusCode, 200, joined.body);
    const tess = `tb_sid=${sid(joined)}`;
    const made = (await call("POST", `/api/projects/${project.id}/agent/tokens`, { cookie: tess, body: { name: "reader" } })).json();
    const read = () => call("GET", `/api/agent/projects/${project.id}/requirements`, { headers: { authorization: `Bearer ${made.token}` } });
    assert.equal((await read()).statusCode, 200);
    assert.equal(await status(call("POST", `/api/users/${joined.json().user.id}/disable`, { cookie: s.owner })), 200);
    assert.equal(await status(call("GET", "/api/me", { cookie: tess })), 401, "the person's sessions ended at once");
    assert.equal((await read()).statusCode, 200, "the machine token is still valid");
  });
});
