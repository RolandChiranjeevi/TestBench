import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PASSWORD_MAX, PASSWORD_MIN, PASSWORD_RULES, deviceLabel, passwordFormProblem, passwordProblem } from "../web/src/accounts.ts";
import { PASSWORD_MAX as SERVER_MAX, PASSWORD_MIN as SERVER_MIN, passwordProblem as serverProblem } from "../server/accounts.ts";

// The helpers of the account screens. Pure logic: no browser, no network.

describe("deviceLabel", () => {
  const cases: [string, string][] = [
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", "Chrome on macOS"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0", "Edge on Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/110.0.0.0", "Opera on Windows"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0", "Firefox on Linux"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", "Safari on macOS"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", "Safari on iPhone"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1", "Chrome on iPhone"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
    ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", "Chrome on ChromeOS"],
    ["curl/8.7.1", "curl"],
    ["node", "Node.js"],
  ];
  for (const [ua, expected] of cases) it(expected, () => assert.equal(deviceLabel(ua), expected));

  it("says so plainly when it does not know, and never throws", () => {
    for (const ua of ["", "   ", null, undefined, "Totally Unknown/1.0", "\u0000\u0001"]) assert.equal(deviceLabel(ua), "Unknown device");
    assert.equal(deviceLabel("Mozilla/5.0 (Macintosh)"), "macOS", "a system without a browser name");
    assert.equal(deviceLabel("Safari/1"), "Safari", "a browser without a system");
    assert.doesNotThrow(() => deviceLabel("x".repeat(100_000)));
  });
});

describe("the password rules are the server's", () => {
  it("the numbers are the same", () => {
    assert.deepEqual([PASSWORD_MIN, PASSWORD_MAX], [SERVER_MIN, SERVER_MAX]);
    assert.ok(PASSWORD_RULES[0].includes(String(SERVER_MIN)));
  });

  it("for a long list of passwords, the hint says what the server says", () => {
    const who = { email: "pia@example.com", name: "Pia Person" };
    const samples = [
      "", "short", "123456789", "1234567890", "aaaaaaaaaaaa", "ababababab", "abcabcabcabc", "          ", "   a      b   ", "a long passphrase here", "Pia Person", "pia person", "PIA@EXAMPLE.COM", "pia@example.com ",
      "x".repeat(PASSWORD_MAX), "x".repeat(PASSWORD_MAX + 1), "åäö åäö åäö åäö", "pässwörd with ünicode", "\t\t\t\t\t\t\t\t\t\t\ta",
    ];
    for (const p of samples) assert.equal(passwordProblem(p, who), serverProblem(p, who), JSON.stringify(p.slice(0, 30)));
    assert.equal(passwordProblem("a long passphrase here", who), null);
  });
});

describe("what the password form checks before it sends", () => {
  const who = { email: "pia@example.com", name: "Pia Person" };
  const ok = { current: "the old passphrase", next: "a brand new passphrase", again: "a brand new passphrase" };
  it("lets a good change go", () => assert.equal(passwordFormProblem(ok, who), null));
  it("asks for the current password first", () => assert.equal(passwordFormProblem({ ...ok, current: "" }, who), "Type your current password"));
  it("notices two different new passwords", () => assert.equal(passwordFormProblem({ ...ok, again: "a brand new passphrasX" }, who), "The two new passwords are not the same"));
  it("notices an unchanged password", () => assert.equal(passwordFormProblem({ current: "same passphrase", next: "same passphrase", again: "same passphrase" }, who), "The new password is the same as the current one"));
  it("passes on the rule that is broken", () => {
    assert.equal(passwordFormProblem({ ...ok, next: "short", again: "short" }, who), `The password must be at least ${PASSWORD_MIN} characters`);
    assert.equal(passwordFormProblem({ ...ok, next: "pia@example.com", again: "pia@example.com" }, who), "The password cannot be your email or your name");
  });
});

// ---------- the audit log, in words ----------
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_ACTIONS, AUDIT_FILTERS, describeAudit, type NameLookup } from "../web/src/accounts.ts";

describe("the audit log in words", () => {
  const names: NameLookup = { user: (id) => ({ 2: "Pia Person", 3: "Ola Owner" } as Record<number, string>)[id ?? -1], project: (id) => ({ 7: "Acme" } as Record<number, string>)[id ?? -1] };
  const e = (action: string, over: Record<string, unknown> = {}) => ({ action, actor: "Ola Owner", targetUserId: 2, projectId: null as number | null, detail: {} as Record<string, unknown>, ...over });

  it("every action the server writes has words, found by reading the server's own source", () => {
    const sources = [...readdirSync("server").filter((f) => f.endsWith(".ts")).map((f) => join("server", f)), "scripts/accounts.ts"];
    const found = new Set<string>();
    for (const f of sources) for (const m of readFileSync(f, "utf8").matchAll(/["'`]((?:account|login|password|profile|invitation|member|members|requirements|sessions?)\.[a-z_]+)["'`]/g)) found.add(m[1]);
    assert.deepEqual([...found].sort(), [...AUDIT_ACTIONS].sort(), "the list in web/src/accounts.ts is the server's list");
    for (const a of AUDIT_ACTIONS) assert.ok(!describeAudit(e(a), names).includes(a), `${a} has words of its own`);
  });

  it("says what happened, with names", () => {
    assert.equal(describeAudit(e("member.role_changed", { projectId: 7, detail: { from: "viewer", to: "tester" } }), names), "Ola Owner changed Pia Person's role in Acme from viewer to tester");
    assert.equal(describeAudit(e("member.added", { projectId: 7, detail: { role: "admin", via: "invitation" } }), names), "Ola Owner added Pia Person to Acme as admin (with an invitation)");
    assert.equal(describeAudit(e("account.disabled", { detail: { sessionsEnded: 1 } }), names), "Ola Owner switched off Pia Person's account, which ended 1 session");
    assert.equal(describeAudit(e("account.disabled", { detail: { sessionsEnded: 3 } }), names), "Ola Owner switched off Pia Person's account, which ended 3 sessions");
    assert.equal(describeAudit(e("password.reset", { actor: "cli", detail: { via: "command line", sessionsEnded: 2 } }), names), "Pia Person set a new password (set on the server), which ended 2 sessions");
    assert.equal(describeAudit(e("invitation.created", { projectId: 7, detail: { email: "x@y.io", role: "viewer" } }), names), "Ola Owner made an invitation link for x@y.io to Acme as viewer");
    assert.equal(describeAudit(e("invitation.created"), names), "Ola Owner made an invitation link, for an account with no project");
    assert.equal(describeAudit(e("profile.changed", { detail: { fields: ["name", "email"] } }), names), "Ola Owner changed their name and email");
    assert.equal(describeAudit(e("members.migrated", { actor: "migration", detail: { role: "tester", memberships: 4 } }), names), "When roles were introduced, existing accounts became tester in 4 project memberships");
  });

  it("says so when an account or a project is gone, and never shows a bare number", () => {
    assert.equal(describeAudit(e("member.removed", { targetUserId: 99, projectId: 98 }), names), "Ola Owner removed an account that no longer exists from a project that no longer exists");
    assert.equal(describeAudit(e("account.enabled", { targetUserId: null }), names), "Ola Owner switched on an account's account");
    for (const a of AUDIT_ACTIONS) assert.doesNotMatch(describeAudit(e(a, { targetUserId: 99, projectId: 98 }), names), /\b(98|99)\b/);
  });

  it("an action it does not know is shown as it is rather than hidden", () => assert.equal(describeAudit(e("something.new"), names), "Ola Owner: something.new"));

  it("the filters are prefixes the server accepts, and together they reach every action", () => {
    for (const f of AUDIT_FILTERS) assert.match(f.prefix, /^[a-z_.]{0,60}$/);
    for (const a of AUDIT_ACTIONS) assert.ok(AUDIT_FILTERS.some((f) => f.prefix && a.startsWith(f.prefix)), `${a} is reachable through a filter`);
  });
});
