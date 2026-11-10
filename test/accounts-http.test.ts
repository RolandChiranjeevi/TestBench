import "./env.ts";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { db } from "../server/db.ts";
import { createFirstOwner } from "../server/accounts.ts";

// Accounts through the real app (server/index.ts), called in the process with app.inject: no port, no network. The tests are in order: they follow one installation
// from "open" to "accounts" to "locked" and back, as it would happen. The address of a request is set with remoteAddress, because the limits and the setup rule use it.
process.env.TESTBENCH_NO_LISTEN = "1";
const { app } = await import("../server/index.ts");
await app.ready();
after(() => app.close());

const GOOD = "a long passphrase here";
const NEW = "a brand new passphrase";
const HOME = "127.0.0.1"; // this computer
const A = "10.1.1.1"; // a person on the network
type Opts = { ip?: string; cookie?: string; body?: unknown; headers?: Record<string, string>; guard?: boolean };
const call = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, o: Opts = {}) =>
  app.inject({ method, url, remoteAddress: o.ip ?? A, headers: { ...(o.guard === false ? {} : { "x-testbench": "1" }), ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.headers ?? {}) }, payload: o.body as object | undefined });
const sid = (res: { headers: Record<string, unknown> }) => /tb_sid=([^;]*)/.exec(String(res.headers["set-cookie"] ?? ""))?.[1];
const ck = (token: string | undefined) => `tb_sid=${token}`;
const login = async (email: string, password = GOOD, ip = A) => { const r = await call("POST", "/api/login", { ip, body: { email, password } }); return { res: r, cookie: sid(r) ? ck(sid(r)) : undefined }; };
const status = async (res: Promise<{ statusCode: number }> | { statusCode: number }) => (await res).statusCode;
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

const state: { owner?: string; ownerEmail: string; pia?: string; piaEmail: string; piaId?: number; project?: number } = { ownerEmail: "anna@example.com", piaEmail: "pia@example.com" };

describe("before there is any account: open", () => {
  it("everything is open and says so, and there is no login page", async () => {
    assert.deepEqual((await call("GET", "/api/auth/status")).json(), { enabled: false, authenticated: true });
    assert.equal(await status(call("GET", "/api/projects")), 200);
    assert.equal(await status(call("GET", "/login")), 404);
    assert.equal(await status(call("POST", "/api/login", { body: { email: "a@b.co", password: GOOD } })), 404);
  });

  it("the first account can be made from this computer, and only from there", async () => {
    const away = (await call("GET", "/api/setup/status", { ip: A })).json();
    assert.equal(away.available, false);
    assert.match(away.reason, /only offered from the computer/);
    assert.deepEqual((await call("GET", "/api/setup/status", { ip: HOME })).json(), { available: true, needsSetupPassword: false });
    const refused = await call("POST", "/api/setup", { ip: A, body: { name: "Anna", email: state.ownerEmail, password: GOOD } });
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.headers["set-cookie"], undefined);
    assert.equal(count("SELECT COUNT(*) AS n FROM users"), 0);
  });

  it("a weak password or a bad email makes no account", async () => {
    assert.match((await call("POST", "/api/setup", { ip: HOME, body: { name: "Anna", email: state.ownerEmail, password: "short" } })).json().error, /at least 10/);
    assert.match((await call("POST", "/api/setup", { ip: HOME, body: { name: "Anna", email: "nope", password: GOOD } })).json().error, /email/);
    assert.equal(await status(call("POST", "/api/setup", { ip: HOME, guard: false, body: { name: "Anna", email: state.ownerEmail, password: GOOD } })), 403, "the X-Testbench guard still applies");
    assert.equal(count("SELECT COUNT(*) AS n FROM users"), 0);
  });

  it("setting up makes the owner and signs them in with a cookie that cannot be read by a script", async () => {
    const res = await call("POST", "/api/setup", { ip: HOME, body: { name: "Anna Owner", email: state.ownerEmail, password: GOOD } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual([res.json().user.isOwner, res.json().user.email], [true, state.ownerEmail]);
    assert.ok(!JSON.stringify(res.json()).includes("scrypt"), "no hash in the answer");
    const cookie = String(res.headers["set-cookie"]);
    assert.match(cookie, /^tb_sid=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    state.owner = ck(sid(res));
  });
});

describe("with accounts: everything needs a login", () => {
  it("an anonymous request is refused, a page goes to the login, and the owner's cookie works", async () => {
    const r = await call("GET", "/api/projects");
    assert.deepEqual([r.statusCode, r.json()], [401, { error: "Sign in required" }]);
    const page = await call("GET", "/somewhere");
    assert.deepEqual([page.statusCode, page.headers.location], [302, "/login"]);
    assert.equal(await status(call("GET", "/api/projects", { cookie: state.owner })), 200);
    assert.equal(await status(call("GET", "/api/projects", { cookie: "tb_sid=forged-value" })), 401);
  });

  it("the status says who is signed in, and setup is closed for good", async () => {
    const anon = (await call("GET", "/api/auth/status")).json();
    assert.deepEqual(anon, { enabled: true, authenticated: false, mode: "accounts" });
    const me = (await call("GET", "/api/auth/status", { cookie: state.owner })).json();
    assert.deepEqual([me.authenticated, me.mode, me.user.name, me.user.isOwner], [true, "accounts", "Anna Owner", true]);
    assert.equal(await status(call("POST", "/api/setup", { ip: HOME, body: { name: "X", email: "x@example.com", password: GOOD } })), 409);
    assert.equal((await call("GET", "/api/setup/status", { ip: HOME })).json().available, false);
    const setup = await call("GET", "/setup");
    assert.deepEqual([setup.statusCode, setup.headers.location], [302, "/login"]);
  });

  it("the login page is served with strict headers, and posting to the login needs the X-Testbench header", async () => {
    const page = await call("GET", "/login");
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Sign in with your email and password/);
    assert.match(String(page.headers["content-security-policy"]), /default-src 'none'/);
    assert.equal(page.headers["x-frame-options"], "DENY");
    assert.equal(page.headers["cache-control"], "no-store");
    assert.equal(await status(call("POST", "/api/login", { guard: false, body: { email: state.ownerEmail, password: GOOD } })), 403);
  });

  it("a wrong password and an unknown email get the same answer, and neither sets a cookie", async () => {
    const wrong = await call("POST", "/api/login", { body: { email: state.ownerEmail, password: "wrong password!!" } });
    const unknown = await call("POST", "/api/login", { body: { email: "nobody@example.com", password: GOOD } });
    assert.deepEqual([wrong.statusCode, unknown.statusCode], [401, 401]);
    assert.deepEqual(wrong.json(), unknown.json());
    assert.equal(wrong.json().error, "Wrong email or password");
    assert.equal(wrong.headers["set-cookie"], undefined);
  });

  it("an address is blocked after five wrong attempts, even for a right password, and another address is not", async () => {
    const bad = "10.2.2.2";
    for (let i = 0; i < 5; i++) assert.equal(await status(call("POST", "/api/login", { ip: bad, body: { email: `nobody${i}@example.com`, password: "wrong password!!" } })), 401);
    const blocked = await call("POST", "/api/login", { ip: bad, body: { email: state.ownerEmail, password: GOOD } });
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers["retry-after"]) > 0);
    assert.equal((await login(state.ownerEmail, GOOD, A)).res.statusCode, 200);
  });

  it("signing in (the email in any case) gives a session, /api/me says who, and signing out ends it", async () => {
    const { res, cookie } = await login(state.ownerEmail.toUpperCase());
    assert.equal(res.statusCode, 200);
    const me = (await call("GET", "/api/me", { cookie })).json();
    assert.deepEqual([me.user.name, me.user.email, typeof me.sessionId], ["Anna Owner", state.ownerEmail, "number"]);
    assert.ok(!JSON.stringify(me).includes("scrypt"));
    const out = await call("POST", "/api/logout", { cookie });
    assert.match(String(out.headers["set-cookie"]), /^tb_sid=; .*Max-Age=0/);
    assert.equal(await status(call("GET", "/api/me", { cookie })), 401, "the old cookie is dead on the server, not only cleared in the browser");
    assert.equal(await status(call("GET", "/api/me", { cookie: state.owner })), 200, "another session of the same person is untouched");
  });
});

describe("invitations: the only way in after the first account, and there is no email", () => {
  let inviteUrl = "";
  const tokenOf = (url: string) => url.split("/").pop()!;

  it("the owner makes an invitation link, which is shown once and never listed", async () => {
    const res = await call("POST", "/api/invitations", { cookie: state.owner, body: { email: state.piaEmail, note: "for Pia" } });
    assert.equal(res.statusCode, 200);
    inviteUrl = res.json().url;
    assert.match(inviteUrl, /\/join\/[\w-]{40,}$/);
    const list = await call("GET", "/api/invitations", { cookie: state.owner });
    assert.ok(!list.body.includes(tokenOf(inviteUrl)), "the list does not hold the token");
    assert.deepEqual(list.json().map((l: { status: string; email: string }) => [l.status, l.email]), [["open", state.piaEmail]]);
  });

  it("anyone with the link can see what it is for, on a page that does not pass the link on", async () => {
    const info = await call("GET", `/api/join/${tokenOf(inviteUrl)}`, { ip: "10.3.3.3" });
    assert.deepEqual(info.json(), { invitedBy: "Anna Owner", email: state.piaEmail, note: "for Pia" });
    const page = await call("GET", `/join/${tokenOf(inviteUrl)}`, { ip: "10.3.3.3" });
    assert.equal(page.statusCode, 200);
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.ok(!page.body.includes(tokenOf(inviteUrl)), "the token is not written into the page");
    assert.equal(await status(call("GET", "/api/join/not-a-real-token", { ip: "10.3.3.3" })), 410);
  });

  it("the invitation makes one account, for its own email, and signs the person in", async () => {
    const other = await call("POST", `/api/join/${tokenOf(inviteUrl)}`, { ip: "10.3.3.3", body: { name: "Pia", email: "other@example.com", password: GOOD } });
    assert.equal(other.statusCode, 400);
    const res = await call("POST", `/api/join/${tokenOf(inviteUrl)}`, { ip: "10.3.3.3", body: { name: "Pia Person", email: "PIA@example.com", password: GOOD } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().user.isOwner, false);
    state.pia = ck(sid(res));
    state.piaId = res.json().user.id;
    assert.equal(await status(call("GET", "/api/me", { cookie: state.pia })), 200);
    assert.equal(await status(call("POST", `/api/join/${tokenOf(inviteUrl)}`, { ip: "10.3.3.3", body: { name: "Pia", email: state.piaEmail, password: GOOD } })), 410, "the link works once");
  });

  it("an ordinary account cannot make invitations, list or turn off accounts, or read the audit log", async () => {
    for (const [m, url] of [["POST", "/api/invitations"], ["GET", "/api/invitations"], ["GET", "/api/users"], ["POST", "/api/users/1/disable"], ["POST", "/api/users/1/reset-link"], ["GET", "/api/audit-log"], ] as const) {
      assert.equal(await status(call(m, url, { cookie: state.pia, body: {} })), 403, `${m} ${url}`);
    }
    assert.equal(await status(call("POST", "/api/invitations/1/revoke", { cookie: state.pia })), 404, "an invitation of no project of hers is not hers to see");
  });

  it("a link that is revoked cannot be used", async () => {
    const made = (await call("POST", "/api/invitations", { cookie: state.owner, body: {} })).json();
    assert.equal(await status(call("POST", `/api/invitations/${made.id}/revoke`, { cookie: state.owner })), 200);
    assert.equal(await status(call("GET", `/api/join/${tokenOf(made.url)}`, { ip: "10.3.3.4" })), 410);
    assert.equal(await status(call("POST", `/api/invitations/${made.id}/revoke`, { cookie: state.owner })), 404);
  });
});

describe("who made a change: the signed-in person, for each request on its own", () => {
  it("a requirement is recorded under the name of whoever made it, with the approval too", async () => {
    const project = (await call("POST", "/api/projects", { cookie: state.owner, body: { name: "Acme", key: "AC" } })).json();
    state.project = project.id;
    assert.equal(await status(call("GET", `/api/projects/${project.id}/requirements`, { cookie: state.pia })), 404, "not a member yet: the project does not exist for her");
    assert.equal(await status(call("POST", `/api/projects/${project.id}/members`, { cookie: state.owner, body: { email: state.piaEmail, role: "tester" } })), 200);
    const mine = (await call("POST", `/api/projects/${project.id}/requirements`, { cookie: state.owner, body: { title: "By Anna", status: "approved" } })).json();
    assert.deepEqual([mine.created_by, mine.approved_by, mine.history[0].by], ["Anna Owner", "Anna Owner", "Anna Owner"]);
    const hers = (await call("POST", `/api/projects/${project.id}/requirements`, { cookie: state.pia, body: { title: "By Pia", status: "approved" } })).json();
    assert.deepEqual([hers.created_by, hers.approved_by], ["Pia Person", "Pia Person"]);
  });

  it("requests at the same time do not borrow each other's name", async () => {
    const make = (cookie: string, title: string) => call("POST", `/api/projects/${state.project}/requirements`, { cookie, body: { title, status: "approved" } });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => make(i % 2 ? state.pia! : state.owner!, `Parallel ${i}`)));
    assert.deepEqual(results.map((r) => r.json().created_by), ["Anna Owner", "Pia Person", "Anna Owner", "Pia Person", "Anna Owner", "Pia Person"]);
  });

  it("the name in Settings is the account's own (source: account, never called verified); changing it changes the account", async () => {
    const info = (await call("GET", "/api/settings/display-name", { cookie: state.pia })).json();
    assert.deepEqual([info.name, info.recordedAs, info.source, "verified" in info], ["Pia Person", "Pia Person", "account", false]);
    const changed = (await call("PUT", "/api/settings/display-name", { cookie: state.pia, body: { name: "Pia P." } })).json();
    assert.deepEqual([changed.name, changed.source], ["Pia P.", "account"]);
    assert.equal((await call("GET", "/api/me", { cookie: state.pia })).json().user.name, "Pia P.");
    const r = (await call("POST", `/api/projects/${state.project}/requirements`, { cookie: state.pia, body: { title: "Renamed", status: "draft" } })).json();
    assert.equal(r.created_by, "Pia P.");
  });
});

describe("a person's own account", () => {
  it("the profile can change name and email, and an email that is taken is refused", async () => {
    const noPassword = await call("PATCH", "/api/me", { cookie: state.pia, body: { name: "Pia Person", email: "pia.new@example.com" } });
    assert.deepEqual([noPassword.statusCode, noPassword.json().error], [400, "Changing the email address takes your current password"]);
    assert.equal(await status(call("PATCH", "/api/me", { cookie: state.pia, body: { email: "pia.new@example.com", currentPassword: "not the password" } })), 400);
    assert.equal((await call("GET", "/api/me", { cookie: state.pia })).json().user.email, state.piaEmail, "nothing changed");
    assert.equal(await status(call("PATCH", "/api/me", { cookie: state.pia, body: { name: "Pia Person" } })), 200, "the name needs no password");
    const ok = await call("PATCH", "/api/me", { cookie: state.pia, body: { name: "Pia Person", email: "pia.new@example.com", currentPassword: GOOD } });
    assert.deepEqual([ok.statusCode, ok.json().user.email], [200, "pia.new@example.com"]);
    assert.equal(await status(call("PATCH", "/api/me", { cookie: state.pia, body: { email: state.ownerEmail, currentPassword: GOOD } })), 409);
    assert.equal(await status(call("PATCH", "/api/me", { cookie: state.pia, body: { email: "nope", currentPassword: GOOD } })), 400);
    state.piaEmail = "pia.new@example.com";
  });

  it("changing the password needs the current one, ends the person's other sessions, and the old password stops working", async () => {
    const other = (await login(state.piaEmail)).cookie!;
    assert.equal(await status(call("POST", "/api/me/password", { cookie: state.pia, body: { current: "wrong password!!", next: NEW } })), 400);
    assert.equal(await status(call("POST", "/api/me/password", { cookie: state.pia, body: { current: GOOD, next: "short" } })), 400);
    assert.equal(await status(call("POST", "/api/me/password", { cookie: state.pia, body: { current: GOOD, next: NEW } })), 200);
    assert.equal(await status(call("GET", "/api/me", { cookie: state.pia })), 200, "this session stays");
    assert.equal(await status(call("GET", "/api/me", { cookie: other })), 401, "the other one ended");
    assert.equal((await login(state.piaEmail, GOOD)).res.statusCode, 401);
    assert.equal((await login(state.piaEmail, NEW)).res.statusCode, 200);
  });

  it("sessions are listed, with this one marked, and one can be ended", async () => {
    await login(state.piaEmail, NEW);
    const list = (await call("GET", "/api/me/sessions", { cookie: state.pia })).json();
    assert.ok(list.length >= 2 && list.filter((s: { current: boolean }) => s.current).length === 1);
    const victim = list.find((s: { current: boolean }) => !s.current);
    assert.equal(await status(call("POST", `/api/me/sessions/${victim.id}/revoke`, { cookie: state.pia })), 200);
    assert.equal(await status(call("POST", `/api/me/sessions/${victim.id}/revoke`, { cookie: state.pia })), 404);
    const mine = (await call("GET", "/api/me/sessions", { cookie: state.owner })).json();
    assert.ok(mine.every((s: { id: number }) => s.id !== victim.id), "a person only sees their own sessions");
  });
});

describe("the owner looks after the accounts", () => {
  it("lists them without secrets, and makes a one-time link for a new password", async () => {
    const users = await call("GET", "/api/users", { cookie: state.owner });
    assert.deepEqual(users.json().map((u: { email: string; isOwner: boolean }) => [u.email, u.isOwner]), [[state.ownerEmail, true], [state.piaEmail, false]]);
    assert.ok(!users.body.includes("scrypt"));
    const link = (await call("POST", `/api/users/${state.piaId}/reset-link`, { cookie: state.owner })).json();
    assert.match(link.url, /\/reset\/[\w-]{40,}$/);
    const token = link.url.split("/").pop();
    assert.deepEqual((await call("GET", `/api/reset/${token}`, { ip: "10.4.4.4" })).json(), { email: state.piaEmail });
    assert.equal(await status(call("POST", `/api/reset/${token}`, { ip: "10.4.4.4", body: { password: "short" } })), 400);
    assert.equal(await status(call("POST", `/api/reset/${token}`, { ip: "10.4.4.4", body: { password: "a reset passphrase" } })), 200);
    assert.equal(await status(call("POST", `/api/reset/${token}`, { ip: "10.4.4.4", body: { password: "another passphrase" } })), 410, "once");
    assert.equal(await status(call("GET", "/api/me", { cookie: state.pia })), 401, "every session of that account ended");
    assert.equal((await login(state.piaEmail, "a reset passphrase")).res.statusCode, 200);
    assert.equal(await status(call("POST", "/api/users/999999/reset-link", { cookie: state.owner })), 404);
  });

  it("turning an account off ends its sessions at once, and it cannot sign in until turned on; the owner cannot turn off their own account", async () => {
    const session = (await login(state.piaEmail, "a reset passphrase")).cookie!;
    assert.equal(await status(call("POST", `/api/users/${state.piaId}/disable`, { cookie: state.owner })), 200);
    assert.equal(await status(call("GET", "/api/me", { cookie: session })), 401);
    assert.equal((await login(state.piaEmail, "a reset passphrase")).res.statusCode, 401);
    const me = (await call("GET", "/api/me", { cookie: state.owner })).json().user.id;
    assert.equal(await status(call("POST", `/api/users/${me}/disable`, { cookie: state.owner })), 409);
    assert.equal(await status(call("POST", `/api/users/${state.piaId}/enable`, { cookie: state.owner })), 200);
    assert.equal((await login(state.piaEmail, "a reset passphrase")).res.statusCode, 200);
  });

  it("the audit log has what happened, newest first, and no password or token", async () => {
    const log = (await call("GET", "/api/audit-log?limit=200", { cookie: state.owner })).json() as { id: number; action: string }[];
    const seen = new Set(log.map((e) => e.action));
    for (const a of ["account.setup", "login.failed", "login.succeeded", "invitation.created", "invitation.used", "invitation.revoked", "account.created", "profile.changed", "password.changed",
      "password.reset_link_created", "password.reset", "account.disabled", "account.enabled"]) assert.ok(seen.has(a), a);
    const text = JSON.stringify(log);
    for (const secret of [GOOD, NEW, "a reset passphrase", "wrong password!!", String(state.owner).replace("tb_sid=", ""), String(state.pia).replace("tb_sid=", ""), "scrypt$"]) assert.ok(!text.includes(secret), secret);
    const ids = log.map((e) => e.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
    assert.equal((await call("GET", "/api/audit-log?limit=2&before=999999", { cookie: state.owner })).json().length, 2);
  });
});

describe("machine tokens still work, and open nothing else", () => {
  it("an agent token reads its own route with no login, and a wrong one is refused by that route", async () => {
    const made = (await call("POST", `/api/projects/${state.project}/agent/tokens`, { cookie: state.owner, body: { name: "reader" } })).json();
    const read = await call("GET", `/api/agent/projects/${state.project}/requirements`, { headers: { authorization: `Bearer ${made.token}` } });
    assert.equal(read.statusCode, 200);
    assert.equal(await status(call("GET", `/api/agent/projects/${state.project}/requirements`, { headers: { authorization: "Bearer tbag_wrong" } })), 401);
    // the same token anywhere else: refused, with a login or without
    for (const cookie of [undefined, state.owner]) {
      const r = await call("POST", "/api/requirement-proposals/1/approve", { cookie, headers: { authorization: `Bearer ${made.token}` } });
      assert.ok([401, 403].includes(r.statusCode), String(r.statusCode));
    }
    const asHuman = await call("POST", "/api/requirement-proposals/1/approve", { cookie: state.owner, headers: { authorization: `Bearer ${made.token}` } });
    assert.equal(asHuman.statusCode, 403, "a login next to an agent token does not make the token a person");
    assert.match(asHuman.json().error, /only its own route/);
  });

  it("a CI token reaches the CI route without a login (it fails on its own validation, not on 'sign in')", async () => {
    const made = (await call("POST", `/api/projects/${state.project}/ci/tokens`, { cookie: state.owner, body: { name: "ci" } })).json();
    const res = await call("POST", `/api/projects/${state.project}/ci/test-results`, { guard: false, headers: { authorization: `Bearer ${made.token}`, "content-type": "application/json" }, body: {} });
    assert.notEqual(res.statusCode, 401);
    assert.ok(!/Sign in required/.test(res.body));
    assert.equal(await status(call("POST", `/api/projects/${state.project}/ci/test-results`, { guard: false, body: {} })), 401, "no token, no login: refused");
  });

  it("a proposal token is off until switched on, and reaches only its route without a login", async () => {
    const off = await call("POST", `/api/agent/projects/${state.project}/requirement-proposals`, { guard: false, headers: { authorization: "Bearer tbpr_x" }, body: [{ title: "x" }] });
    assert.equal(off.statusCode, 403);
    assert.match(off.json().error, /switched off/);
  });
});

describe("locked: accounts were on but none exist", () => {
  it("everything is refused, including the setup, until an owner is made on the server", async () => {
    db.prepare("DELETE FROM users").run(); // an older backup restored over the database
    const status0 = (await call("GET", "/api/auth/status")).json();
    assert.deepEqual(status0, { enabled: true, authenticated: false, mode: "locked" });
    for (const [m, url] of [["GET", "/api/projects"], ["POST", "/api/setup"], ["POST", "/api/login"], ["GET", "/login"], ["GET", "/setup"], ["GET", "/api/agent/projects/1/requirements"]] as const) {
      assert.equal(await status(call(m, url, { ip: HOME, body: {} })), 503, `${m} ${url}`);
    }
    assert.equal(await status(call("GET", "/api/projects", { cookie: state.owner })), 503, "no old cookie opens it");
  });

  it("the server's command line is the way back; the old sessions are gone with the old accounts", async () => {
    createFirstOwner({ email: "back@example.com", name: "Back Owner", password: GOOD }, { label: "cli" }, { allowLocked: true });
    assert.equal(await status(call("GET", "/api/projects", { cookie: state.owner })), 401);
    const { res, cookie } = await login("back@example.com");
    assert.equal(res.statusCode, 200);
    assert.equal(await status(call("GET", "/api/projects", { cookie })), 200);
  });
});
