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
    for (const f of sources) for (const m of readFileSync(f, "utf8").matchAll(/["'`]((?:account|login|password|profile|invitation|member|members|requirements|sessions?|settings|token|case|proposal|run|project|agent_request|spec)\.[a-z_]+)["'`]/g)) found.add(m[1]);
    assert.deepEqual([...found].sort(), [...AUDIT_ACTIONS].sort(), "the list in web/src/accounts.ts is the server's list");
    for (const a of AUDIT_ACTIONS) assert.ok(!describeAudit(e(a), names).includes(a), `${a} has words of its own`);
  });

  it("says what a person asked an agent to do, for a run with the number of test cases", () => {
    const f = (detail: Record<string, unknown>) => describeAudit(e("agent_request.created", { actor: "Tess Tester", projectId: 7, detail }), names);
    assert.equal(f({ request: 3, kind: "run", run: 9, cases: 12 }), "Tess Tester asked an agent to run 12 test cases in Acme");
    assert.equal(f({ request: 3, kind: "run", run: 9, cases: 1 }), "Tess Tester asked an agent to run 1 test case in Acme");
    assert.equal(f({ request: 3, kind: "rerun" }), "Tess Tester asked an agent to run failed automated tests again in Acme");
    assert.equal(f({ request: 3, kind: "discover" }), "Tess Tester asked an agent to look at a target in Acme");
  });

  it("says what an agent reported, by kind, and names the agent", () => {
    const f = (kind: string) => describeAudit(e("agent_request.finding_created", { actor: "agent: claude-a", projectId: 7, detail: { request: 5, kind: "discover", finding_kind: kind, id: 9, n: 1, credential_id: 3 } }), names);
    assert.equal(f("test_case"), "agent: claude-a reported a test case (a draft) for a discover request in Acme");
    assert.equal(f("bug_report"), "agent: claude-a reported a bug report (a proposal) for a discover request in Acme");
    assert.equal(f("observation"), "agent: claude-a reported an observation for a discover request in Acme");
    assert.equal(f("manual_test_suggestion"), "agent: claude-a reported a manual test suggestion (a proposal) for a discover request in Acme");
    assert.equal(f("something_new"), "agent: claude-a reported a finding for a discover request in Acme", "a kind the page does not know still reads well");
  });

  it("says what an agent reported for a run: how many test cases, and how they went", () => {
    const f = (detail: Record<string, unknown>) => describeAudit(e("agent_request.results_reported", { actor: "agent: claude-a", projectId: 7, detail: { request: 5, kind: "run", run: 9, credential_id: 3, ...detail } }), names);
    assert.equal(f({ reported: 5, passed: 3, failed: 1, blocked: 1, skipped: 0 }), "agent: claude-a reported results for 5 test cases (3 passed, 1 failed, 1 blocked) in Acme");
    assert.equal(f({ reported: 1, passed: 0, failed: 0, blocked: 0, skipped: 1 }), "agent: claude-a reported results for 1 test case (1 skipped) in Acme");
    assert.equal(f({}), "agent: claude-a reported results for 0 test cases in Acme", "an entry without counts still reads well");
  });

  it("says what an agent handed in: the report of a re-run, or for a run request the automated test report and what came in", () => {
    const f = (detail: Record<string, unknown>) => describeAudit(e("agent_request.result_delivered", { actor: "agent: claude-a", projectId: 7, detail }), names);
    assert.equal(f({ request: 3, kind: "rerun" }), "agent: claude-a handed in the report of a re-run in Acme");
    assert.equal(f({ request: 3 }), "agent: claude-a handed in the report of a re-run in Acme", "an entry from before there was a kind");
    assert.equal(f({ request: 3, kind: "run", run: 9, result_run: 10, credential_id: 1, tests: 4, new_tests: 1, linked: 3, passed: 2, failed: 1, skipped: 1 }), "agent: claude-a handed in an automated test report for a run request (4 tests: 2 passed, 1 failed, 1 skipped) in Acme");
    assert.equal(f({ kind: "run", tests: 1, passed: 1 }), "agent: claude-a handed in an automated test report for a run request (1 test: 1 passed) in Acme");
    assert.equal(f({ kind: "run" }), "agent: claude-a handed in an automated test report for a run request (0 tests) in Acme", "an entry without counts still reads well");
  });

  it("says who switched agent results or agent proposals on or off", () => {
    const f = (action: string, to: boolean) => describeAudit(e(action, { targetUserId: null, detail: { from: !to, to } }), names);
    assert.equal(f("settings.agent_results_changed", true), "Ola Owner switched agent results on");
    assert.equal(f("settings.agent_results_changed", false), "Ola Owner switched agent results off");
    assert.equal(f("settings.agent_proposals_changed", true), "Ola Owner switched agent proposals on");
    assert.equal(f("settings.agent_proposals_changed", false), "Ola Owner switched agent proposals off");
  });

  it("says who made or revoked which kind of machine token, by name and prefix, never by its id", () => {
    const f = (action: string, kind: string, extra: Record<string, unknown> = { name: "qa-agent", prefix: "tbrq_x1bB" }) =>
      describeAudit(e(action, { targetUserId: null, projectId: 7, detail: { kind, credential_id: 12, ...extra } }), names);
    assert.equal(f("token.created", "request"), 'Ola Owner made the request token "qa-agent" (tbrq_x1bB…) in Acme');
    assert.equal(f("token.revoked", "request"), 'Ola Owner revoked the request token "qa-agent" (tbrq_x1bB…) in Acme');
    assert.equal(f("token.created", "agent_read", { name: "reader", prefix: "tbag_abcd" }), 'Ola Owner made the agent read token "reader" (tbag_abcd…) in Acme');
    assert.equal(f("token.created", "propose", { name: "skill", prefix: "tbpr_abcd" }), 'Ola Owner made the agent proposal token "skill" (tbpr_abcd…) in Acme');
    assert.equal(f("token.revoked", "ci", { name: "GitHub Actions", prefix: "tbci_abcd" }), 'Ola Owner revoked the CI token "GitHub Actions" (tbci_abcd…) in Acme');
    assert.equal(f("token.created", "something_new", {}), "Ola Owner made the token in Acme", "a kind and details the page does not know still read well");
  });

  it("says what a person decided about a test case, a proposal, a run or a project", () => {
    const f = (action: string, detail: Record<string, unknown>) => describeAudit(e(action, { targetUserId: null, projectId: 7, detail }), names);
    assert.equal(f("case.status_changed", { case: 9, key: "AGE-9", from: "draft", to: "ready" }), "Ola Owner changed the status of AGE-9 from draft to ready in Acme");
    assert.equal(f("case.status_changed", { count: 12, to: "ready", cases: [1, 2] }), "Ola Owner changed the status of 12 test cases to ready in Acme");
    assert.equal(f("case.status_changed", { count: 1, to: "deprecated" }), "Ola Owner changed the status of 1 test case to deprecated in Acme");
    assert.equal(f("proposal.accepted", { kind: "manual_test", from: "proposed", to: "accepted" }), "Ola Owner accepted a manual test suggestion in Acme");
    assert.equal(f("proposal.accepted", { kind: "manual_test", case: "AGE-10" }), "Ola Owner accepted a manual test suggestion in Acme, and made it the test case AGE-10");
    assert.equal(f("proposal.rejected", { kind: "bug_report", to: "rejected" }), "Ola Owner rejected a bug proposal in Acme");
    assert.equal(f("proposal.rejected", { kind: "bug_report", to: "duplicate", duplicate_of: 3 }), "Ola Owner rejected a bug proposal as a duplicate in Acme");
    assert.equal(f("proposal.accepted", { kind: "requirement", requirement: 4, to: "approved" }), "Ola Owner accepted a requirement proposal in Acme");
    assert.equal(f("proposal.rejected", { kind: "requirement", to: "rejected" }), "Ola Owner rejected a requirement proposal in Acme");
    assert.equal(f("proposal.case_created", { kind: "manual_test", case: "AGE-10" }), "Ola Owner made the test case AGE-10 from a manual test suggestion in Acme");
    assert.equal(f("proposal.case_created", {}), "Ola Owner made a test case from a proposal in Acme");
    assert.equal(f("proposal.restored", { kind: "bug_report" }), "Ola Owner moved a bug proposal back to Suggested in Acme");
    assert.equal(f("run.finished", { run: 5 }), "Ola Owner finished run #5 in Acme");
    assert.equal(f("run.reopened", { run: 5 }), "Ola Owner reopened run #5 in Acme");
    assert.equal(f("project.created", { key: "ACM", name: "Acme" }), 'Ola Owner made the project "Acme" (ACM)');
    assert.equal(f("proposal.accepted", {}), "Ola Owner accepted a proposal in Acme", "an entry without details still reads well");
    assert.equal(f("run.finished", {}), "Ola Owner finished a run in Acme");
    assert.equal(f("project.created", {}), "Ola Owner made a project");
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
