import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db } from "../server/db.ts";
import { makeProject } from "./helpers.ts";
import { authenticateCiToken, bugEvents, ciDetail, createCiToken, ingestCiResults, isCiIngest, redact, revokeCiToken, setTriage } from "../server/ci.ts";
import { getBugReport, listBugReports } from "../server/audits.ts";

let n = 0;
const proj = () => makeProject(`CI${++n}`, `CI project ${n}`);
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
const bugOf = (projectId: number, key: string) => db.prepare("SELECT * FROM bug_reports WHERE project_id = ? AND origin_audit_id = '$ci' AND source_id = ?").get(projectId, key) as Record<string, any>;

let runs = 0;
const result = (over: Record<string, unknown> = {}) => ({
  testKey: "e2e-checkout-empty-cart", title: "Empty cart checkout fails", status: "failed", durationMs: 4210, error: "Expected checkout button to be enabled",
  steps: ["Add product to cart", "Remove product", "Open checkout"], attachments: [], tags: ["checkout", "e2e"], ...over,
});
const run = (p: { id: number }, results: unknown[], over: Record<string, unknown> = {}) =>
  ingestCiResults(p.id, {
    runId: `gha-${++runs}`, commitSha: "abc1234567", branch: "main", repository: "org/repo", pipelineUrl: "https://github.com/org/repo/actions/runs/1",
    startedAt: "2026-11-04T07:00:00Z", finishedAt: "2026-11-04T07:04:00Z", results, ...over,
  });

describe("a failed test becomes one bug per testKey", () => {
  it("creates a bug the first time, with CI as its source, an open workflow and a proposed review", () => {
    const p = proj();
    const s = run(p, [result()]);
    assert.deepEqual([s.bugsCreated, s.bugsUpdated, s.counts.failed], [1, 0, 1]);
    const b = bugOf(p.id, "e2e-checkout-empty-cart");
    assert.deepEqual([b.source, b.test_key, b.workflow_status, b.review_status, b.last_ci_status, b.audit_id], ["ci", "e2e-checkout-empty-cart", "open", "proposed", "failed", null]);
    assert.equal(b.agent_severity, "medium");
    assert.equal(b.human_severity, null, "CI never sets the person's severity");
    assert.deepEqual(JSON.parse(b.tags), ["checkout", "e2e"]);
    assert.equal(b.actual, "Expected checkout button to be enabled");
  });

  it("the same test failing again updates the open bug and adds an occurrence, not a second bug", () => {
    const p = proj();
    run(p, [result()]);
    const s = run(p, [result({ error: "Expected checkout button to be enabled (again)" })], { commitSha: "def7654321" });
    assert.deepEqual([s.bugsCreated, s.bugsUpdated], [0, 1]);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), 1);
    const b = bugOf(p.id, "e2e-checkout-empty-cart");
    assert.equal(b.actual, "Expected checkout button to be enabled (again)");
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_occurrences WHERE bug_report_id = ?", b.id), 2);
    assert.equal(ciDetail(b as any)!.failedRuns, 2);
  });

  it("failures on several branches are grouped under the same testKey", () => {
    const p = proj();
    run(p, [result()], { branch: "main" });
    run(p, [result()], { branch: "refs/heads/feature/checkout", commitSha: "fff0000" });
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), 1);
    const d = ciDetail(bugOf(p.id, "e2e-checkout-empty-cart") as any)!;
    assert.deepEqual(d.branches.map((x) => x.branch).sort(), ["feature/checkout", "main"]);
  });

  it("several failing tests make one bug each, not one per run; other projects are separate", () => {
    const p = proj();
    const other = proj();
    run(p, [result({ testKey: "a" }), result({ testKey: "b" }), result({ testKey: "c", status: "passed" }), result({ testKey: "d", status: "skipped" })]);
    run(p, [result({ testKey: "a" }), result({ testKey: "b" })]);
    run(other, [result({ testKey: "a" })]);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), 2);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", other.id), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM ci_results WHERE project_id = ?", p.id), 4, "passes and skips of tests without a bug are counted, not stored");
  });

  it("a person's edits to the text stay; severity and assignee are never changed by CI", () => {
    const p = proj();
    run(p, [result()]);
    const id = bugOf(p.id, "e2e-checkout-empty-cart").id;
    db.prepare("UPDATE bug_reports SET title = 'My title', human_severity = 'critical', edited_at = datetime('now') WHERE id = ?").run(id);
    setTriage(id, { assignee: "Sam" });
    run(p, [result({ title: "Changed in code", error: "new" })]);
    const b = bugOf(p.id, "e2e-checkout-empty-cart");
    assert.deepEqual([b.title, b.human_severity, b.assignee], ["My title", "critical", "Sam"]);
  });
});

describe("idempotency", () => {
  it("sending the same run again changes nothing and says it was replayed", () => {
    const p = proj();
    const payload = { runId: "same-run", commitSha: "abc", branch: "main", repository: "org/repo", results: [result()] };
    const first = ingestCiResults(p.id, payload);
    const again = ingestCiResults(p.id, payload);
    assert.deepEqual([first.replayed, first.bugsCreated, first.bugs[0].action], [false, 1, "created"]);
    assert.deepEqual([again.replayed, again.bugsCreated, again.bugsUpdated, again.reopened, again.resolvedSuspected], [true, 0, 0, 0, 0], "a replay reports that nothing was done");
    assert.deepEqual(again.bugs, [{ testKey: "e2e-checkout-empty-cart", bugId: first.bugs[0].bugId, action: "already_processed" }]);
    assert.deepEqual(again.counts, first.counts, "what the run contained is still reported");
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), 1, "no new bug");
    assert.equal(count("SELECT COUNT(*) AS n FROM ci_runs WHERE project_id = ?", p.id), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_occurrences o JOIN bug_reports b ON b.id = o.bug_report_id WHERE b.project_id = ?", p.id), 1, "no new occurrence");
    assert.equal(count("SELECT COUNT(*) AS n FROM ci_results WHERE project_id = ?", p.id), 1);
    // Asking a third time gives the same answer, and a new runId still updates the existing bug.
    assert.deepEqual(ingestCiResults(p.id, payload).bugs, again.bugs);
    const next = ingestCiResults(p.id, { ...payload, runId: "next-run" });
    assert.deepEqual([next.replayed, next.bugsCreated, next.bugsUpdated, next.bugs[0].action, next.bugs[0].bugId], [false, 0, 1, "updated", first.bugs[0].bugId]);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_occurrences o JOIN bug_reports b ON b.id = o.bug_report_id WHERE b.project_id = ?", p.id), 2);
  });

  it("the same runId with other content is refused, and nothing is changed", () => {
    const p = proj();
    ingestCiResults(p.id, { runId: "r1", results: [result()] });
    assert.throws(() => ingestCiResults(p.id, { runId: "r1", results: [result({ testKey: "other" })] }), /received before with other content/);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), 1);
  });

  it("the same runId in two projects is two runs", () => {
    const a = proj();
    const b = proj();
    ingestCiResults(a.id, { runId: "shared", results: [result()] });
    assert.equal(ingestCiResults(b.id, { runId: "shared", results: [result()] }).replayed, false);
  });

  it("a refused payload leaves no half-written run behind", () => {
    const p = proj();
    assert.throws(() => ingestCiResults(p.id, { runId: "bad", results: [result(), result()] }), /appears more than once/);
    assert.throws(() => ingestCiResults(p.id, { runId: "bad2", results: [result({ status: "exploded" })] }), /status/);
    assert.equal(count("SELECT COUNT(*) AS n FROM ci_runs WHERE project_id = ?", p.id), 0);
  });
});

describe("what the counters of an answer mean", () => {
  it("a reopened bug is counted as reopened and not as updated", () => {
    const p = proj();
    run(p, [result()]);
    run(p, [result({ status: "passed" })]);
    const s = run(p, [result()]);
    assert.deepEqual([s.bugsCreated, s.bugsUpdated, s.reopened, s.resolvedSuspected], [0, 0, 1, 0]);
    assert.deepEqual(s.bugs.map((b) => b.action), ["reopened"]);
    // The same goes for a bug that a person closed.
    setTriage(bugOf(p.id, "e2e-checkout-empty-cart").id, { workflowStatus: "closed" });
    const t = run(p, [result()]);
    assert.deepEqual([t.bugsCreated, t.bugsUpdated, t.reopened, t.resolvedSuspected], [0, 0, 1, 0]);
  });

  it("each bug is counted under exactly one counter, and the four add up to the bugs that had an event", () => {
    const p = proj();
    const failed = (k: string) => result({ testKey: k });
    const passed = (k: string) => result({ testKey: k, status: "passed" });
    run(p, [failed("A"), failed("B"), failed("C"), failed("F"), failed("G"), failed("H")], { branch: "main" });
    run(p, [failed("G")], { branch: "feature/x" });
    run(p, [passed("B"), passed("C"), passed("F")], { branch: "main" }); // B, C and F are now resolved_suspected
    setTriage(bugOf(p.id, "C").id, { workflowStatus: "closed" });
    const s = run(p, [failed("A"), failed("B"), failed("C"), failed("E"), passed("F"), passed("G"), passed("H")], { branch: "main" });
    const actions = Object.fromEntries(s.bugs.map((b) => [b.testKey, b.action]));
    assert.deepEqual(actions, { A: "updated", B: "reopened", C: "reopened", E: "created", F: "recorded", G: "recorded", H: "resolved_suspected" });
    assert.deepEqual([s.bugsCreated, s.bugsUpdated, s.reopened, s.resolvedSuspected], [1, 1, 2, 1]);
    const counted = s.bugsCreated + s.bugsUpdated + s.reopened + s.resolvedSuspected;
    assert.equal(counted, s.bugs.filter((b) => b.action !== "recorded").length, "the counters cover every bug with an event, none twice");
    assert.equal(s.bugs.length, 7, "recorded bugs are listed but in no counter");
  });
});

describe("a result without an error", () => {
  it("accepts error as null or missing for a passed test, and stores it as an empty string", () => {
    const p = proj();
    run(p, [result({ testKey: "k" })]);
    const s = run(p, [result({ testKey: "k", status: "passed", error: null }), result({ testKey: "other", status: "passed", error: undefined }), result({ testKey: "skipped-one", status: "skipped", error: null })]);
    assert.deepEqual([s.counts.passed, s.counts.skipped, s.resolvedSuspected], [2, 1, 1]);
    assert.equal((db.prepare("SELECT error FROM ci_results WHERE project_id = ? AND test_key = 'k' ORDER BY id DESC").get(p.id) as { error: string }).error, "");
  });

  it("accepts error: null on a failed test too, and still makes the bug", () => {
    const p = proj();
    const s = run(p, [result({ testKey: "f", error: null })]);
    assert.equal(s.bugsCreated, 1);
    assert.equal(bugOf(p.id, "f").actual, "");
  });

  it("still refuses an error that is not text", () => {
    const p = proj();
    assert.throws(() => run(p, [result({ error: 42 })]), /error/);
  });
});

describe("flaky tests", () => {
  it("are marked flaky and start at low severity, never high", () => {
    const p = proj();
    run(p, [result({ testKey: "flaky-one", status: "flaky" })]);
    const b = bugOf(p.id, "flaky-one");
    assert.deepEqual([b.ci_flaky, b.agent_severity, b.last_ci_status], [1, "low", "flaky"]);
    const list = listBugReports(p.id, {}).items.find((i) => i.testKey === "flaky-one")!;
    assert.equal(list.ci?.flaky, true);
  });

  it("a test that was failing and is flaky now keeps its severity and shows as flaky", () => {
    const p = proj();
    run(p, [result({ testKey: "k" })]);
    const id = bugOf(p.id, "k").id;
    db.prepare("UPDATE bug_reports SET human_severity = 'high' WHERE id = ?").run(id);
    run(p, [result({ testKey: "k", status: "flaky" })]);
    const b = bugOf(p.id, "k");
    assert.deepEqual([b.ci_flaky, b.agent_severity, b.human_severity, b.workflow_status], [1, "medium", "high", "open"]);
  });

  it("a flaky result puts a resolved_suspected bug back to open, but does not reopen a closed one", () => {
    const p = proj();
    run(p, [result({ testKey: "k" })]);
    run(p, [result({ testKey: "k", status: "passed" })]);
    assert.equal(bugOf(p.id, "k").workflow_status, "resolved_suspected");
    run(p, [result({ testKey: "k", status: "flaky" })]);
    assert.equal(bugOf(p.id, "k").workflow_status, "open");
    setTriage(bugOf(p.id, "k").id, { workflowStatus: "closed" });
    run(p, [result({ testKey: "k", status: "flaky" })]);
    assert.equal(bugOf(p.id, "k").workflow_status, "closed");
  });
});

describe("a test that goes green", () => {
  it("is only marked resolved_suspected: CI never closes a bug", () => {
    const p = proj();
    run(p, [result()]);
    const s = run(p, [result({ status: "passed" })]);
    assert.equal(s.resolvedSuspected, 1);
    const b = bugOf(p.id, "e2e-checkout-empty-cart");
    assert.deepEqual([b.workflow_status, b.last_ci_status, b.closed_at], ["resolved_suspected", "passed", null]);
    assert.equal(b.review_status, "proposed");
    run(p, [result({ status: "passed" })]);
    assert.equal(bugOf(p.id, "e2e-checkout-empty-cart").workflow_status, "resolved_suspected", "more green runs do not close it either");
    assert.equal(bugEvents(b.id).some((e) => e.kind === "resolved_suspected" && e.actor === "ci"), true);
  });

  it("while another branch still fails, a pass on one branch does not suggest it is resolved", () => {
    const p = proj();
    run(p, [result()], { branch: "main" });
    run(p, [result()], { branch: "feature/x" });
    run(p, [result({ status: "passed" })], { branch: "main" });
    assert.equal(bugOf(p.id, "e2e-checkout-empty-cart").workflow_status, "open");
    run(p, [result({ status: "passed" })], { branch: "feature/x" });
    assert.equal(bugOf(p.id, "e2e-checkout-empty-cart").workflow_status, "resolved_suspected");
  });

  it("failing again after resolved_suspected sets it back to open with a new occurrence", () => {
    const p = proj();
    run(p, [result()]);
    run(p, [result({ status: "passed" })]);
    const s = run(p, [result()], { commitSha: "9999999" });
    assert.equal(s.reopened, 1);
    const b = bugOf(p.id, "e2e-checkout-empty-cart");
    assert.deepEqual([b.workflow_status, b.resolved_suspected_at], ["open", null]);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_occurrences WHERE bug_report_id = ?", b.id), 2);
    assert.equal(bugEvents(b.id)[0].kind, "reopened");
  });

  it("a bug that a person closed is reopened by a new failure, and a passing test does nothing to it", () => {
    const p = proj();
    run(p, [result()]);
    const id = bugOf(p.id, "e2e-checkout-empty-cart").id;
    setTriage(id, { workflowStatus: "closed" });
    run(p, [result({ status: "passed" })]);
    assert.equal(bugOf(p.id, "e2e-checkout-empty-cart").workflow_status, "closed");
    run(p, [result()]);
    assert.equal(bugOf(p.id, "e2e-checkout-empty-cart").workflow_status, "open");
  });

  it("a rejected bug only collects occurrences and keeps its workflow", () => {
    const p = proj();
    run(p, [result()]);
    const id = bugOf(p.id, "e2e-checkout-empty-cart").id;
    db.prepare("UPDATE bug_reports SET review_status = 'rejected' WHERE id = ?").run(id);
    setTriage(id, { workflowStatus: "closed" });
    run(p, [result()]);
    const b = bugOf(p.id, "e2e-checkout-empty-cart");
    assert.deepEqual([b.workflow_status, b.review_status], ["closed", "rejected"]);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_occurrences WHERE bug_report_id = ?", id), 2);
  });
});

describe("history, display and filters", () => {
  it("the bug shows its source, last status, failed runs, branch, commit, pipeline link, error and attachment links", () => {
    const p = proj();
    run(p, [result({ attachments: [{ name: "trace.zip", url: "https://github.com/org/repo/actions/runs/1/artifacts/9?token=SECRET", type: "trace" }] })], { branch: "feature/checkout", commitSha: "abcdef0123456" });
    const id = bugOf(p.id, "e2e-checkout-empty-cart").id;
    const d = getBugReport(id) as any;
    assert.deepEqual([d.source, d.ci.lastStatus, d.ci.failedRuns], ["ci", "failed", 1]);
    assert.deepEqual([d.ci.lastFailure.branch, d.ci.lastFailure.commit, d.ci.lastFailure.pipelineUrl], ["feature/checkout", "abcdef0123456", "https://github.com/org/repo/actions/runs/1"]);
    assert.equal(d.ci.lastFailure.error, "Expected checkout button to be enabled");
    assert.deepEqual(d.ci.lastFailure.attachments, [{ name: "trace.zip", url: "https://github.com/org/repo/actions/runs/1/artifacts/9", type: "trace" }], "a signed query string is dropped from links");
    const item = listBugReports(p.id, {}).items[0];
    assert.deepEqual([item.source, item.ci?.branch, item.ci?.failedRuns], ["ci", "feature/checkout", 1]);
  });

  it("lists can be filtered by source, workflow, severity, tag, testKey and assignee, and audit bugs are unaffected", () => {
    const p = proj();
    run(p, [result({ testKey: "a", tags: ["checkout"] }), result({ testKey: "b", tags: ["login"], status: "flaky" })]);
    db.prepare("INSERT INTO bug_reports (project_id, origin_audit_id, source_id, title) VALUES (?, 'aud-1', 'x', 'An audit bug')").run(p.id);
    const list = (f: Record<string, string>) => listBugReports(p.id, f).items.map((i) => i.testKey ?? i.sourceId).sort();
    assert.deepEqual(list({}), ["a", "b", "x"]);
    assert.deepEqual(list({ source: "ci" }), ["a", "b"]);
    assert.deepEqual(list({ source: "agent_audit" }), ["x"]);
    assert.deepEqual(list({ tag: "login" }), ["b"]);
    assert.deepEqual(list({ testKey: "a" }), ["a"]);
    assert.deepEqual(list({ severity: "low" }), ["b"]);
    assert.deepEqual(list({ severity: "none" }), ["x"]);
    setTriage(bugOf(p.id, "a").id, { assignee: "Sam", workflowStatus: "closed" });
    assert.deepEqual(list({ assignee: "Sam" }), ["a"]);
    assert.deepEqual(list({ assignee: "none" }), ["b", "x"]);
    assert.deepEqual(list({ workflow: "closed" }), ["a"]);
    assert.deepEqual(list({ workflow: "open" }), ["b", "x"]);
    assert.throws(() => listBugReports(p.id, { source: "nope" }), /source must be/);
    assert.throws(() => listBugReports(p.id, { workflow: "nope" }), /workflow must be/);
  });

  it("assignee and workflow changes are recorded as events and are not edits of the text", () => {
    const p = proj();
    run(p, [result()]);
    const id = bugOf(p.id, "e2e-checkout-empty-cart").id;
    setTriage(id, { assignee: "  Sam  ", workflowStatus: "closed" });
    const b = bugOf(p.id, "e2e-checkout-empty-cart");
    assert.deepEqual([b.assignee, b.workflow_status, b.edited_at === null, b.closed_at !== null], ["Sam", "closed", true, true]);
    assert.deepEqual(bugEvents(id).filter((e) => e.actor === "user").map((e) => e.kind).sort(), ["assignee", "workflow"]);
    setTriage(id, { workflowStatus: "open" });
    assert.equal(bugOf(p.id, "e2e-checkout-empty-cart").closed_at, null);
    assert.throws(() => setTriage(id, {}), /Nothing to change/);
  });

  it("existing bugs get the open workflow and agent_audit as their source", () => {
    const p = proj();
    db.prepare("INSERT INTO bug_reports (project_id, origin_audit_id, source_id, title) VALUES (?, 'aud-9', 'y', 'Old bug')").run(p.id);
    const b = db.prepare("SELECT source, workflow_status, assignee, tags FROM bug_reports WHERE project_id = ?").get(p.id) as Record<string, unknown>;
    assert.deepEqual({ ...b }, { source: "agent_audit", workflow_status: "open", assignee: "", tags: "[]" });
  });
});

describe("what is kept and what is not", () => {
  it("hides secrets in errors, steps and attachment names, and keeps the rest", () => {
    assert.equal(redact("Authorization: Bearer abcdefghijklmnop1234"), "Authorization: [redacted]");
    assert.match(redact("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked"), /\[redacted\]/);
    assert.equal(redact("password=hunter2 and more"), "password=[redacted] and more");
    assert.equal(redact("API_KEY: 'abc def' ok"), "API_KEY: [redacted] ok");
    assert.equal(redact("postgres://user:pw@host/db"), "postgres://[redacted]@host/db");
    assert.equal(redact("AKIAABCDEFGHIJKLMNOP"), "[redacted]");
    assert.equal(redact("Expected checkout button to be enabled"), "Expected checkout button to be enabled");
    const p = proj();
    run(p, [result({ error: "request failed with Authorization: Bearer abcdefghijklmnop1234 at line 3", steps: ["login with password=hunter2"] })]);
    const b = bugOf(p.id, "e2e-checkout-empty-cart");
    assert.doesNotMatch(b.actual, /abcdefghijklmnop/);
    assert.doesNotMatch(b.steps, /hunter2/);
    assert.doesNotMatch(JSON.stringify(db.prepare("SELECT error FROM ci_results WHERE project_id = ?").get(p.id)), /abcdefghijklmnop/);
  });

  it("limits what it stores: long errors are cut, bad links and too many results are refused", () => {
    const p = proj();
    run(p, [result({ error: "x".repeat(50_000) })]);
    assert.ok(bugOf(p.id, "e2e-checkout-empty-cart").actual.length <= 8000);
    assert.throws(() => run(p, [result({ testKey: "z", attachments: [{ name: "n", url: "javascript:alert(1)" }] })]), /not an http\(s\) link/);
    assert.throws(() => run(p, Array.from({ length: 5001 }, (_, i) => result({ testKey: `t${i}` }))), /results/);
    assert.throws(() => run(p, [result({ testKey: "bad key\u0000" })]), /testKey/);
  });
});

describe("API tokens", () => {
  it("are shown once, stored only as a hash, bound to one project, and can be revoked", () => {
    const a = proj();
    const b = proj();
    const t = createCiToken(a.id, "GitHub Actions");
    assert.match(t.token, /^tbci_/);
    assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM ci_tokens WHERE id = ?").get(t.id)), new RegExp(t.token.slice(9)), "the token itself is not stored");
    assert.equal(authenticateCiToken(`Bearer ${t.token}`, a.id), true);
    assert.equal(authenticateCiToken(`bearer ${t.token}`, a.id), true);
    assert.equal(authenticateCiToken(`Bearer ${t.token}`, b.id), false, "a token works only for its own project");
    assert.equal(authenticateCiToken(t.token, a.id), false, "must be a Bearer header");
    assert.equal(authenticateCiToken(undefined, a.id), false);
    assert.equal(authenticateCiToken("Bearer tbci_wrong", a.id), false);
    assert.notEqual((db.prepare("SELECT last_used_at FROM ci_tokens WHERE id = ?").get(t.id) as any).last_used_at, null);
    revokeCiToken(t.id);
    assert.equal(authenticateCiToken(`Bearer ${t.token}`, a.id), false);
    assert.throws(() => createCiToken(a.id, "  "), /name/);
  });

  it("the CI route is the only one that is exempt from the browser guards", () => {
    assert.equal(isCiIngest("POST", "/api/projects/3/ci/test-results"), true);
    assert.equal(isCiIngest("POST", "/api/projects/3/ci/test-results?x=1"), true);
    assert.equal(isCiIngest("GET", "/api/projects/3/ci/test-results"), false);
    assert.equal(isCiIngest("POST", "/api/projects/3/ci/tokens"), false);
    assert.equal(isCiIngest("POST", "/api/projects/3/bug-reports"), false);
    assert.equal(isCiIngest("POST", "/api/projects/x/ci/test-results"), false);
  });
});
