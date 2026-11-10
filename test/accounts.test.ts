import "./env.ts";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DATA_DIR, db } from "../server/db.ts";
import { setDisplayName } from "../server/actor.ts";
import {
  AccountError, acceptInvite, acceptReset, accountsState, audit, changePassword, checkLogin, createFirstOwner, createLink, createSession, emailProblem, getUser, hashPassword,
  listAudit, listLinks, listSessions, listUsers, MAX_SESSIONS_PER_USER, nameProblem, normalizeEmail, passwordProblem, peekLink, resetPasswordFromCli, revokeAllSessions,
  revokeLink, revokeSessionById, revokeSessionToken, revokeUserSessions, sessionFromToken, setDisabled, updateProfile, verifyPassword,
} from "../server/accounts.ts";
import type { AccountUser } from "../server/accountcontext.ts";
import { accountCookie } from "../server/accountroutes.ts";

// Accounts on function level: passwords, the three states, sessions, links, a person's own account, what the owner does, and the audit log.
// Everything runs against a throwaway data folder (see env.ts). Each test file has its own process, so the users made here are only seen here.

const MARKER = join(DATA_DIR, ".accounts-enabled");
const GOOD = "a long passphrase here";
/** Back to an installation without accounts. The audit log is append-only and stays. */
const reset = () => { db.prepare("DELETE FROM users").run(); rmSync(MARKER, { force: true }); };
let n = 0;
const fails = (fn: () => unknown, status: number, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof AccountError && e.status === status && re.test(e.message));
const owner = (): AccountUser => createFirstOwner({ email: `owner${++n}@example.com`, name: "Olle Owner", password: GOOD }, { label: "test" });
const person = (name = "Pia Person"): AccountUser => {
  const o = listUsers().find((u) => u.isOwner) ?? owner();
  const link = createLink({ kind: "invite", createdBy: o });
  return acceptInvite(link.token, { email: `p${++n}@example.com`, name, password: GOOD });
};
const sessionsOf = (userId: number) => (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL").get(userId) as { n: number }).n;
const actions = () => listAudit({ limit: 500 }).map((a) => a.action);

describe("passwords", () => {
  it("are hashed with scrypt and a salt of their own, and only the right one verifies", () => {
    const a = hashPassword(GOOD); const b = hashPassword(GOOD);
    assert.match(a, /^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
    assert.notEqual(a, b, "each hash has its own salt");
    assert.ok(!a.includes(GOOD));
    assert.equal(verifyPassword(GOOD, a), true);
    assert.equal(verifyPassword(GOOD + "x", a), false);
    assert.equal(verifyPassword("", a), false);
  });

  it("a stored value that is not a scrypt hash, or has crazy parameters, never verifies", () => {
    for (const bad of ["", "plain", "scrypt$1$2", "bcrypt$32768$8$1$AAAA$BBBB", "scrypt$abc$8$1$AAAA$BBBB", "scrypt$99999999999$8$1$AAAA$BBBB", "scrypt$32768$999$1$AAAA$BBBB", "scrypt$32768$8$99$AAAA$BBBB", "scrypt$32768$8$1$$"]) {
      assert.equal(verifyPassword(GOOD, bad), false, bad);
    }
  });

  it("must be long enough, not too long, not trivial, and not the email or the name", () => {
    assert.equal(passwordProblem(GOOD, { email: "a@b.co", name: "Anna" }), null);
    assert.match(passwordProblem("short")!, /at least 10/);
    assert.match(passwordProblem("x".repeat(1025))!, /at most 1024/);
    assert.match(passwordProblem("          ")!, /only spaces/);
    assert.match(passwordProblem("aaaaaaaaaaaa")!, /too simple/);
    assert.match(passwordProblem("ababababab")!, /too simple/);
    assert.match(passwordProblem("Anna.Berg@Example.com", { email: "anna.berg@example.com" })!, /email or your name/);
    assert.match(passwordProblem("Anna Berg Anna", { name: "anna berg anna" })!, /email or your name/);
    assert.match(passwordProblem(12345678901234 as unknown)!, /must be text/);
  });

  it("emails are lower-cased and checked, and names are checked", () => {
    assert.equal(normalizeEmail("  Anna@Example.COM "), "anna@example.com");
    assert.equal(normalizeEmail(42), "");
    assert.equal(emailProblem("anna@example.com"), null);
    for (const bad of ["", "anna", "anna@", "@example.com", "an na@example.com", `${"a".repeat(250)}@x.co`]) assert.ok(emailProblem(bad), bad);
    assert.equal(nameProblem("Anna Berg"), null);
    assert.ok(nameProblem("") && nameProblem("  ") && nameProblem("x".repeat(81)) && nameProblem("Anna\u0007") && nameProblem(7 as unknown));
  });

  it("the cookie is HttpOnly and SameSite=Strict, and Secure when the request came over https", () => {
    const plain = accountCookie("abc", 100, false);
    assert.match(plain, /^tb_sid=abc; Path=\/; HttpOnly; SameSite=Strict; Max-Age=100$/);
    assert.match(accountCookie("abc", 100, true), /; Secure$/);
  });
});

describe("the three states and the first account", () => {
  it("an installation without accounts is open; the first account makes it accounts, for good, and writes the marker", () => {
    reset();
    assert.equal(accountsState(), "open");
    const u = createFirstOwner({ email: "  Anna@Example.com ", name: " Anna Berg ", password: GOOD }, { label: "test" });
    assert.deepEqual([u.email, u.name, u.isOwner, u.disabledAt], ["anna@example.com", "Anna Berg", true, null]);
    assert.equal(accountsState(), "accounts");
    assert.ok(existsSync(MARKER));
    fails(() => createFirstOwner({ email: "b@example.com", password: GOOD }, { label: "test" }), 409, /already on/);
    assert.deepEqual(actions().slice(0, 1), ["account.setup"]);
  });

  it("the first account takes the name that was set in Settings before accounts, when none is given", () => {
    reset();
    setDisplayName("Anna Berg");
    assert.equal(createFirstOwner({ email: "anna@example.com", password: GOOD }, { label: "test" }).name, "Anna Berg");
    reset();
    setDisplayName("");
    assert.equal(createFirstOwner({ email: "anna@example.com", password: GOOD }, { label: "test" }).name, "Owner");
  });

  it("a weak password, a bad email or a missing name makes no account", () => {
    reset();
    fails(() => createFirstOwner({ email: "anna@example.com", name: "Anna", password: "short" }, { label: "test" }), 400, /at least 10/);
    fails(() => createFirstOwner({ email: "nope", name: "Anna", password: GOOD }, { label: "test" }), 400, /email/);
    assert.equal(listUsers().length, 0);
    assert.equal(accountsState(), "open");
  });

  it("when accounts were on but none exist (a backup was restored), the installation is locked, and only the server's command line can make the owner", () => {
    reset();
    owner();
    db.prepare("DELETE FROM users").run(); // an older backup restored over the database
    assert.equal(accountsState(), "locked");
    fails(() => createFirstOwner({ email: "x@example.com", name: "X", password: GOOD }, { label: "web" }), 409, /no account exists/);
    assert.equal(accountsState(), "locked");
    const u = createFirstOwner({ email: "x@example.com", name: "X", password: GOOD }, { label: "cli" }, { allowLocked: true });
    assert.equal(u.isOwner, true);
    assert.equal(accountsState(), "accounts");
  });

  it("the marker is written again if it goes missing while accounts exist", () => {
    reset();
    owner();
    rmSync(MARKER, { force: true });
    assert.equal(accountsState(), "accounts");
    assert.ok(existsSync(MARKER));
  });
});

describe("signing in and sessions", () => {
  it("the right email and password sign in (the email in any case); a wrong password, an unknown email and a turned-off account all look the same", () => {
    reset();
    const o = owner();
    assert.equal(checkLogin(o.email.toUpperCase(), GOOD)?.id, o.id);
    assert.equal(checkLogin(o.email, "wrong password!!"), null);
    assert.equal(checkLogin("nobody@example.com", GOOD), null);
    assert.equal(checkLogin(o.email, undefined), null);
    assert.equal(checkLogin(undefined, GOOD), null);
    const p = person();
    setDisabled(o, p.id, true);
    assert.equal(checkLogin(p.email, GOOD), null);
    assert.ok(getUser(o.id)!.lastLoginAt, "a successful sign-in is remembered");
  });

  it("a session is a random value of which only a hash is kept, and it finds its user until it is revoked or expires", () => {
    reset();
    const o = owner();
    const s = createSession(o.id, { ip: "10.0.0.1", userAgent: "TestBrowser" });
    assert.match(s.token, /^[\w-]{40,}$/);
    const row = db.prepare("SELECT token_hash FROM sessions WHERE id = ?").get(s.id) as { token_hash: string };
    assert.ok(row.token_hash !== s.token && !row.token_hash.includes(s.token) && /^[0-9a-f]{64}$/.test(row.token_hash));
    assert.equal(sessionFromToken(s.token)?.user.id, o.id);
    assert.equal(sessionFromToken(s.token + "x"), null);
    assert.equal(sessionFromToken(undefined), null);
    assert.equal(sessionFromToken("x".repeat(300)), null);
    revokeSessionToken(s.token);
    assert.equal(sessionFromToken(s.token), null);
    const t = createSession(o.id);
    db.prepare("UPDATE sessions SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(t.id);
    assert.equal(sessionFromToken(t.token), null, "an expired session is no session");
  });

  it("a session ends when its user is turned off, and comes back with no session of its own when turned on", () => {
    reset();
    const o = owner(); const p = person();
    const s = createSession(p.id);
    setDisabled(o, p.id, true);
    assert.equal(sessionFromToken(s.token), null);
    setDisabled(o, p.id, false);
    assert.equal(sessionFromToken(s.token), null, "the session was revoked, not only hidden");
  });

  it("a person has at most 20 open sessions: the oldest go first", () => {
    reset();
    const o = owner();
    const first = createSession(o.id);
    for (let i = 0; i < MAX_SESSIONS_PER_USER + 1; i++) createSession(o.id);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(o.id) as { n: number }).n, MAX_SESSIONS_PER_USER);
    assert.equal(sessionFromToken(first.token), null);
  });

  it("sessions are listed with the current one marked, ended one at a time, all but one, or all at once", () => {
    reset();
    const o = owner(); const p = person();
    const a = createSession(o.id, { ip: "1.1.1.1", userAgent: "A" }); const b = createSession(o.id); createSession(o.id);
    const other = createSession(p.id);
    const list = listSessions(o.id, a.id);
    assert.equal(list.length, 3);
    assert.deepEqual(list.filter((x) => x.current).map((x) => x.id), [a.id]);
    assert.deepEqual([list.find((x) => x.id === a.id)!.ip, list.find((x) => x.id === a.id)!.userAgent], ["1.1.1.1", "A"]);
    revokeSessionById(o.id, b.id);
    assert.equal(listSessions(o.id).length, 2);
    fails(() => revokeSessionById(o.id, other.id), 404, /not found/);
    fails(() => revokeSessionById(o.id, b.id), 404, /not found/);
    assert.equal(revokeUserSessions(o.id, a.id), 1);
    assert.equal(sessionFromToken(a.token)?.user.id, o.id);
    assert.equal(sessionsOf(o.id), 1);
    assert.ok(revokeAllSessions() >= 2);
    assert.equal(sessionFromToken(other.token), null);
  });
});

describe("invitation and reset links", () => {
  it("an invitation makes one ordinary account, once; the link is a random value of which only a hash is kept", () => {
    reset();
    const o = owner();
    const link = createLink({ kind: "invite", createdBy: o, note: "for Pia" });
    assert.match(link.token, /^[\w-]{40,}$/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM account_links WHERE token_hash = ?").get(link.token) as { n: number }).n, 0, "the token itself is not stored");
    assert.equal(peekLink(link.token, "invite")?.createdBy, "Olle Owner");
    assert.equal(peekLink(link.token, "reset"), null, "an invitation is not a reset link");
    const u = acceptInvite(link.token, { email: "Pia@Example.com", name: "Pia", password: GOOD }, "10.0.0.2");
    assert.deepEqual([u.email, u.isOwner], ["pia@example.com", false]);
    assert.equal(peekLink(link.token, "invite"), null);
    fails(() => acceptInvite(link.token, { email: "other@example.com", name: "X", password: GOOD }), 410, /already been used/);
    assert.deepEqual(actions().slice(0, 2), ["invitation.used", "account.created"]);
  });

  it("an invitation that is revoked, expired or unknown makes no account", () => {
    reset();
    const o = owner();
    const revoked = createLink({ kind: "invite", createdBy: o });
    revokeLink(revoked.id);
    fails(() => acceptInvite(revoked.token, { email: "a@example.com", name: "A", password: GOOD }), 410, /revoked/);
    fails(() => revokeLink(revoked.id), 404, /no open link/);
    const old = createLink({ kind: "invite", createdBy: o });
    db.prepare("UPDATE account_links SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(old.id);
    fails(() => acceptInvite(old.token, { email: "a@example.com", name: "A", password: GOOD }), 410, /expired/);
    fails(() => acceptInvite("nonsense", { email: "a@example.com", name: "A", password: GOOD }), 410, /already been used/);
    assert.equal(listUsers().length, 1);
  });

  it("an invitation for an email only works for that email, and a failure leaves the link usable", () => {
    reset();
    const o = owner();
    const link = createLink({ kind: "invite", createdBy: o, email: "Pia@Example.com" });
    fails(() => acceptInvite(link.token, { email: "other@example.com", name: "X", password: GOOD }), 400, /another email/);
    fails(() => acceptInvite(link.token, { email: "pia@example.com", name: "Pia", password: "short" }), 400, /at least 10/);
    assert.ok(peekLink(link.token, "invite"), "still usable after the failures");
    assert.equal(acceptInvite(link.token, { email: "PIA@example.com", name: "Pia", password: GOOD }).email, "pia@example.com");
    // an email that already has an account
    const second = createLink({ kind: "invite", createdBy: o });
    fails(() => acceptInvite(second.token, { email: "pia@example.com", name: "Again", password: GOOD }), 409, /already exists/);
    assert.ok(peekLink(second.token, "invite"), "a clash does not use the link up");
  });

  it("lists the links with their status, and never the token", () => {
    reset();
    const o = owner();
    const open = createLink({ kind: "invite", createdBy: o, email: "a@example.com" });
    const used = createLink({ kind: "invite", createdBy: o });
    acceptInvite(used.token, { email: "b@example.com", name: "B", password: GOOD });
    const gone = createLink({ kind: "invite", createdBy: o });
    revokeLink(gone.id);
    const status = Object.fromEntries(listLinks().map((l) => [l.id, l.status]));
    assert.deepEqual([status[open.id], status[used.id], status[gone.id]], ["open", "used", "revoked"]);
    assert.ok(!JSON.stringify(listLinks()).includes(open.token));
    fails(() => createLink({ kind: "invite", createdBy: o, email: "not an email" }), 400, /email/);
    fails(() => createLink({ kind: "invite", createdBy: o, note: "x".repeat(201) }), 400, /note/);
  });

  it("a reset link sets a new password once, ends every session of that account, and a weak password leaves it usable", () => {
    reset();
    const o = owner(); const p = person();
    const s = createSession(p.id);
    const link = createLink({ kind: "reset", createdBy: o, userId: p.id });
    fails(() => acceptReset(link.token, "short"), 400, /at least 10/);
    assert.ok(peekLink(link.token, "reset"));
    const NEW = "a brand new passphrase";
    assert.equal(acceptReset(link.token, NEW, "10.0.0.3").id, p.id);
    assert.equal(sessionFromToken(s.token), null);
    assert.equal(checkLogin(p.email, GOOD), null);
    assert.equal(checkLogin(p.email, NEW)?.id, p.id);
    fails(() => acceptReset(link.token, NEW), 410, /already been used/);
    assert.ok(actions().includes("password.reset"));
  });

  it("a reset link for a turned-off account does not work", () => {
    reset();
    const o = owner(); const p = person();
    const link = createLink({ kind: "reset", createdBy: o, userId: p.id });
    setDisabled(o, p.id, true);
    fails(() => acceptReset(link.token, "a brand new passphrase"), 410, /already been used/);
  });
});

describe("a person's own account", () => {
  it("changing the password needs the current one, ends every other session, keeps this one, and the old password stops working", () => {
    reset();
    const o = owner();
    const here = createSession(o.id); const elsewhere = createSession(o.id);
    fails(() => changePassword(o, "wrong password!!", "a brand new passphrase", here.id), 400, /current password is wrong/);
    fails(() => changePassword(o, GOOD, "short", here.id), 400, /at least 10/);
    fails(() => changePassword(o, undefined, "a brand new passphrase", here.id), 400, /current password is wrong/);
    changePassword(o, GOOD, "a brand new passphrase", here.id, "10.0.0.4");
    assert.equal(sessionFromToken(here.token)?.user.id, o.id);
    assert.equal(sessionFromToken(elsewhere.token), null);
    assert.equal(checkLogin(o.email, GOOD), null);
    assert.equal(checkLogin(o.email, "a brand new passphrase")?.id, o.id);
    assert.ok(actions().includes("password.changed"));
  });

  it("the profile can change the name and the email; an email that is taken or invalid is refused; the log says which fields changed, not their values", () => {
    reset();
    const o = owner(); const p = person();
    fails(() => updateProfile(o, { email: "OLLE@example.com" }), 400, /current password/);
    fails(() => updateProfile(o, { email: "OLLE@example.com", currentPassword: "wrong password!!" }), 400, /current password/);
    assert.equal(getUser(o.id)!.email, o.email, "nothing changed without the password");
    const changed = updateProfile(o, { name: "  Olle Ny  ", email: "OLLE@example.com", currentPassword: GOOD }, "10.0.0.5");
    assert.deepEqual([changed.name, changed.email], ["Olle Ny", "olle@example.com"]);
    assert.equal(updateProfile(changed, { name: "Olle Ny" }), changed, "nothing changed, nothing is logged");
    fails(() => updateProfile(changed, { email: p.email, currentPassword: GOOD }), 409, /already uses/);
    fails(() => updateProfile(changed, { email: "nope", currentPassword: GOOD }), 400, /email/);
    fails(() => updateProfile(changed, { name: "" }), 400, /name/);
    const entry = listAudit({ limit: 50 }).find((a) => a.action === "profile.changed")!;
    assert.deepEqual(entry.detail, { fields: ["name", "email"] });
    assert.ok(!JSON.stringify(listAudit({ limit: 500 })).includes("olle@example.com"));
  });
});

describe("what the owner does", () => {
  it("turns an account off and on; sessions end at once; nobody turns off their own account or the last owner", () => {
    reset();
    const o = owner(); const p = person();
    const s = createSession(p.id);
    fails(() => setDisabled(o, o.id, true), 409, /your own account/);
    fails(() => setDisabled(p, o.id, true), 409, /last owner/);
    fails(() => setDisabled(o, 999999, true), 404, /not found/);
    const off = setDisabled(o, p.id, true, "10.0.0.6");
    assert.ok(off.disabledAt);
    assert.equal(sessionFromToken(s.token), null);
    assert.equal(setDisabled(o, p.id, true).disabledAt, off.disabledAt, "turning off twice changes nothing");
    assert.equal(setDisabled(o, p.id, false).disabledAt, null);
    assert.equal(checkLogin(p.email, GOOD)?.id, p.id);
    assert.deepEqual(actions().slice(0, 2), ["account.enabled", "account.disabled"]);
  });

  it("the command line can set a password, which ends every session; an unknown account or a weak password is refused", () => {
    reset();
    const o = owner();
    const s = createSession(o.id);
    fails(() => resetPasswordFromCli("nobody@example.com", GOOD), 404, /no account/);
    fails(() => resetPasswordFromCli(o.email, "short"), 400, /at least 10/);
    resetPasswordFromCli(o.email.toUpperCase(), "a brand new passphrase");
    assert.equal(sessionFromToken(s.token), null);
    assert.equal(checkLogin(o.email, "a brand new passphrase")?.id, o.id);
    const entry = listAudit({ limit: 5 }).find((a) => a.action === "password.reset" && a.actor === "cli");
    assert.ok(entry);
  });
});

describe("the audit log", () => {
  it("is append-only: an update or a delete is refused by the database", () => {
    audit({ label: "test" }, "test.entry");
    assert.throws(() => db.prepare("UPDATE audit_log SET action = 'x'").run(), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM audit_log").run(), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM audit_log WHERE id = 1").run(), /append-only/);
  });

  it("never keeps a password, a token, a hash or a cookie, whatever it is given", () => {
    audit({ label: "test" }, "test.secrets", { detail: { password: "p1", newPassword: "p2", token: "t", sessionToken: "t2", passwordHash: "h", cookie: "c", secret: "s", ok: "kept" } });
    const entry = listAudit({ limit: 1 })[0];
    assert.deepEqual(entry.detail, { ok: "kept" });
  });

  it("everything that happened in these tests left no password and no token in the log", () => {
    const text = JSON.stringify(listAudit({ limit: 500 }));
    for (const secret of [GOOD, "a brand new passphrase", "wrong password!!"]) assert.ok(!text.includes(secret), secret);
    const rows = db.prepare("SELECT action, detail FROM audit_log").all() as { action: string; detail: string }[];
    for (const r of rows) assert.ok(!/passw|token|secret|hash/i.test(r.detail), `${r.action}: ${r.detail}`);
  });

  it("is listed newest first, in pages, with a limit", () => {
    for (let i = 0; i < 5; i++) audit({ label: "test" }, `test.page${i}`);
    const page = listAudit({ limit: 3 });
    assert.equal(page.length, 3);
    assert.deepEqual(page.map((a) => a.action), ["test.page4", "test.page3", "test.page2"]);
    assert.deepEqual(listAudit({ limit: 2, before: page[2].id }).map((a) => a.action), ["test.page1", "test.page0"]);
    assert.equal(listAudit({ limit: 100000 }).length <= 500, true);
    assert.equal(listAudit({ limit: 0 }).length, 1, "a limit below one is one");
  });
});
