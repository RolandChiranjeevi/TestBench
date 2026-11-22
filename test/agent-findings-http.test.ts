import "./env.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { ACCESS } from "../server/access.ts";

// The real server, started as a separate process with a password set. AG-B: the request token that took a DISCOVER request reports findings on it, one at a time, and every
// finding is a proposal. Nothing else is opened to the token: no specs, no accounts, no decisions, no other project, no request it did not take.

const ROOT = join(import.meta.dirname, "..");
const PORT = 54000 + Math.floor(Math.random() * 1000); // its own range: the other server tests use 41000 to 53000
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "a long test passphrase";
const JSON_H = { "Content-Type": "application/json" };
const DATA = mkdtempSync(join(tmpdir(), "tb-agent-findings-"));
let server: ChildProcess;
let output = "";
let cookie = "";

const call = (path: string, init: RequestInit = {}) => fetch(`${BASE}${path}`, init);
const person = (path: string, body?: unknown, method = "POST") =>
  call(path, { method, headers: { ...JSON_H, "X-Testbench": "1", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const agent = (token: string | undefined, path: string, method = "GET", body?: unknown) =>
  call(path, { method, headers: { ...(token === undefined ? {} : { Authorization: token }), ...(body === undefined ? {} : JSON_H) }, body: body === undefined ? undefined : JSON.stringify(body) });
const ok = async <T>(res: Response) => { const raw = await res.text(); assert.ok(res.ok, raw); return JSON.parse(raw) as T; };
const rows = <T>(sql: string, ...args: unknown[]) => { const d = new Database(join(DATA, "testbench.db"), { readonly: true }); try { return d.prepare(sql).all(...args) as T[]; } finally { d.close(); } };

const finding = (token: string | undefined, projectId: number, rid: number, body: unknown) => agent(token === undefined ? undefined : `Bearer ${token}`, `/api/agent/projects/${projectId}/requests/${rid}/findings`, "POST", body);
const take = (token: string, projectId: number, rid: number) => agent(`Bearer ${token}`, `/api/agent/projects/${projectId}/requests/${rid}/claim`, "POST");
const finish = (token: string, projectId: number, rid: number, what: "complete" | "release") => agent(`Bearer ${token}`, `/api/agent/projects/${projectId}/requests/${rid}/${what}`, "POST", {});
const ask = async (projectId: number, kind = "discover") => ok<{ id: number }>(await person(`/api/projects/${projectId}/agent-requests`, { kind, targetUrl: "http://localhost:3000/", note: "look around" }));
/** A discover request that this token has taken. */
const taken = async (projectId: number, token: string) => { const r = await ask(projectId); await ok(await take(token, projectId, r.id)); return r.id; };
const obs = { kind: "observation", title: "Slow first paint", severity: "low", evidence: "3 s" };

const report = (specs: Record<string, "passed" | "failed">) => ({
  config: { rootDir: "/repo" }, stats: { startTime: "2026-01-02T03:04:05.000Z" },
  suites: [{ title: "shop.spec.ts", file: "shop.spec.ts", specs: Object.entries(specs).map(([title, s]) => ({ title, file: "shop.spec.ts", line: 3, column: 1,
    tests: [{ projectName: "chromium", status: s === "passed" ? "expected" : "unexpected", results: [{ status: s, duration: 12, retry: 0, ...(s === "failed" ? { error: { message: "boom" } } : {}) }] }] })) }],
});
/** A person imports a run with a failed test, then asks for a re-run of it. */
async function rerunRequest(projectId: number) {
  const form = new FormData();
  form.set("environment", "from-import");
  form.set("file", new Blob([JSON.stringify(report({ "checkout works": "failed" }))], { type: "application/json" }), "report.json");
  const { runId } = await ok<{ runId: number }>(await call(`/api/projects/${projectId}/import`, { method: "POST", headers: { "X-Testbench": "1", Cookie: cookie }, body: form }));
  return ok<{ id: number }>(await person(`/api/projects/${projectId}/agent-requests`, { kind: "rerun", runId, environment: "staging" }));
}

let a = 0;
let b = 0;
let tokenA = "";
let tokenA2 = "";
let tokenB = "";
let tokenBusy = "";
let readTokenA = "";
let ciTokenA = "";
let revoked = "";
const issued: string[] = [];
const mk = async (projectId: number, kind: "request" | "agent" | "ci", name: string) => {
  const path = { request: "request-tokens", agent: "agent/tokens", ci: "ci/tokens" }[kind];
  const t = await ok<{ token: string; id: number }>(await person(`/api/projects/${projectId}/${path}`, { name }));
  issued.push(t.token);
  return t;
};
const tokenId = (name: string) => rows<{ id: number }>("SELECT id FROM request_tokens WHERE name = ?", name)[0].id;

before(async () => {
  server = spawn(process.execPath, ["--import", "tsx", join(ROOT, "server", "index.ts")], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TESTBENCH_DATA: DATA, TESTBENCH_PORT: String(PORT), TESTBENCH_PASSWORD: PASSWORD, NODE_ENV: "production", TESTBENCH_AUTO_BACKUP: "0" },
  });
  server.stdout?.on("data", (d) => (output += d));
  server.stderr?.on("data", (d) => (output += d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await call("/api/auth/status")).ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  const login = await call("/api/login", { method: "POST", headers: { ...JSON_H, "X-Testbench": "1" }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(login.status, 200, output);
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  a = (await ok<{ id: number }>(await person("/api/projects", { name: "Findings A", key: "FNA" }))).id;
  b = (await ok<{ id: number }>(await person("/api/projects", { name: "Findings B", key: "FNB" }))).id;
  // A project can have 3 active request tokens: the revoked one is made and revoked first, so that its slot is free again.
  const dead = await mk(a, "request", "to-revoke");
  revoked = dead.token;
  assert.equal((await person(`/api/request-tokens/${dead.id}/revoke`, {})).status, 200);
  tokenA = (await mk(a, "request", "claude-a")).token;
  tokenA2 = (await mk(a, "request", "second-agent")).token;
  tokenBusy = (await mk(a, "request", "busy-agent")).token;
  tokenB = (await mk(b, "request", "claude-b")).token;
  readTokenA = (await mk(a, "agent", "reader")).token;
  ciTokenA = (await mk(a, "ci", "ci")).token;
});
after(() => server?.kill());
// One request runs at a time in a project, so a request one test leaves taken would hold up the next: every test starts with nothing waiting or taken.
beforeEach(async () => {
  for (const projectId of [a, b]) for (const r of await ok<{ id: number; status: string }[]>(await person(`/api/projects/${projectId}/agent-requests`, undefined, "GET"))) if (r.status === "pending" || r.status === "claimed") await person(`/api/agent-requests/${r.id}/cancel`, {});
});

describe("who may report a finding", () => {
  it("refuses a missing, malformed, unknown, revoked, read or CI token with the same 401", async () => {
    const rid = await taken(a, tokenA);
    const bodies = new Set<string>();
    for (const header of [undefined, "Bearer", "Basic abc", `Bearer ${tokenA}x`, `Bearer ${revoked}`, `Bearer ${readTokenA}`, `Bearer ${ciTokenA}`]) {
      const res = await agent(header, `/api/agent/projects/${a}/requests/${rid}/findings`, "POST", obs);
      assert.equal(res.status, 401, String(header));
      bodies.add(await res.text());
    }
    assert.equal(bodies.size, 1, "one neutral answer for every kind of refusal");
    assert.equal([...bodies][0].includes("revoked"), false);
    assert.equal(rows("SELECT 1 FROM observations").length, 0, "nothing was made");
  });

  it("answers 403 to a valid token of another project, and leaks nothing about that project", async () => {
    const rid = await taken(a, tokenA);
    const res = await finding(tokenB, a, rid, obs);
    assert.equal(res.status, 403);
    assert.equal(/FNA|FNB|Findings/.test(await res.text()), false);
    assert.equal((await finding(tokenA, b, rid, obs)).status, 403);
    assert.equal(rows("SELECT 1 FROM observations").length, 0);
  });

  it("is refused for every other route there is, with and without a login: no specs, no accounts, no decisions, no requests made or cancelled", async () => {
    const tokenRoutes = new Set([
      "POST /api/projects/:id/ci/test-results", "GET /api/agent/projects/:id/requirements", "POST /api/agent/projects/:id/requirement-proposals", "GET /api/agent/projects/:id/requests",
      "POST /api/agent/projects/:id/requests/:rid/claim", "POST /api/agent/projects/:id/requests/:rid/release", "POST /api/agent/projects/:id/requests/:rid/result",
      "POST /api/agent/projects/:id/requests/:rid/complete", "POST /api/agent/projects/:id/requests/:rid/findings", "POST /api/agent/projects/:id/requests/:rid/case-results",
      "POST /api/agent/projects/:id/requests/:rid/load-result",
    ]);
    const others = Object.keys(ACCESS).filter((k) => !tokenRoutes.has(k));
    assert.ok(others.length > 200, "the whole table, not a sample");
    for (const key of ["GET /api/projects/:id/specs", "POST /api/specs/:id/compare", "GET /api/users", "POST /api/requirement-proposals/:id/approve", "POST /api/projects/:id/agent-requests", "POST /api/agent-requests/:id/cancel"]) assert.ok(others.includes(key), `${key} is in the table`);
    const failures: string[] = [];
    for (const key of others) {
      const [method, pattern] = key.split(" ");
      const path = pattern.replace(/:\w+/g, "1").replace(/\*/g, "x");
      const auth = { Authorization: `Bearer ${tokenA}` };
      const body = method === "GET" || method === "DELETE" ? undefined : "{}";
      const withLogin = await call(path, { method, headers: { ...JSON_H, ...auth, "X-Testbench": "1", Cookie: cookie }, body });
      if (withLogin.status !== 403) failures.push(`${key} with a login: ${withLogin.status}`);
      const noLogin = await call(path, { method, headers: { ...JSON_H, ...auth, "X-Testbench": "1" }, body });
      if (![401, 403].includes(noLogin.status)) failures.push(`${key} without a login: ${noLogin.status}`);
    }
    assert.deepEqual(failures, []);
    assert.equal(rows("SELECT 1 FROM specs").length, 0, "no spec was made");
  });
});

describe("it must be the request this token took, and a discover", () => {
  it("answers 404 for a request that does not exist or belongs to another project, and 409 for one that is not taken", async () => {
    assert.equal((await finding(tokenA, a, 999999, obs)).status, 404);
    const rb = await ask(b);
    assert.equal((await finding(tokenA, a, rb.id, obs)).status, 404, "another project's request looks like it does not exist");
    const waiting = await ask(a);
    const res = await finding(tokenA, a, waiting.id, obs);
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /not taken/);
  });

  it("answers 409 to another token of the same project, and to the token after it finished, gave it back or the request was cancelled", async () => {
    const rid = await taken(a, tokenA);
    const other = await finding(tokenA2, a, rid, obs);
    assert.equal(other.status, 409);
    assert.match((await other.json()).error, /Another token/);
    assert.equal((await finding(tokenA, a, rid, obs)).status, 201, "the token that took it can");
    await ok(await finish(tokenA, a, rid, "complete"));
    const late = await finding(tokenA, a, rid, obs);
    assert.equal(late.status, 409);
    assert.match((await late.json()).error, /done or cancelled/);

    const gaveBack = await taken(a, tokenA);
    await ok(await finish(tokenA, a, gaveBack, "release"));
    assert.equal((await finding(tokenA, a, gaveBack, obs)).status, 409, "given back: waiting again, not taken");
    const cancelled = await taken(a, tokenA);
    await ok(await person(`/api/agent-requests/${cancelled}/cancel`, {}));
    assert.equal((await finding(tokenA, a, cancelled, obs)).status, 409);
  });

  it("answers 409 for a re-run request and makes nothing: a re-run hands in its report through the result route", async () => {
    const rerun = await rerunRequest(a);
    await ok(await take(tokenA, a, rerun.id));
    const res = await finding(tokenA, a, rerun.id, obs);
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /discover/);
    assert.equal(rows<{ findings_count: number }>("SELECT findings_count FROM agent_requests WHERE id = ?", rerun.id)[0].findings_count, 0);
    assert.equal(rows("SELECT 1 FROM observations WHERE origin_audit_id = ?", `$agent-${rerun.id}`).length, 0);
  });
});

describe("what a finding becomes: a proposal, marked, with no audit", () => {
  it("makes a draft test case marked with the token, a proposed bug and manual test, and an exploratory observation, each with its own number", async () => {
    const rid = await taken(a, tokenA);
    const tc = await ok<{ kind: string; id: number; number: number; sourceId: string }>(await finding(tokenA, a, rid, { kind: "test_case", title: "Sign in", priority: "high", description: "The happy path", steps: [{ action: "Open /login", expected: "A form" }, { action: "Submit" }] }));
    const bug = await ok<{ id: number; sourceId: string }>(await finding(tokenA, a, rid, { kind: "bug_report", title: "Button overlaps", steps: ["Open /"], severity: "medium", url: "http://localhost:3000/" }));
    const ob = await ok<{ id: number; sourceId: string }>(await finding(tokenA, a, rid, { kind: "observation", title: "Slow first paint", severity: "low", evidence: "3 s", source: "home" }));
    const man = await ok<{ id: number; sourceId: string }>(await finding(tokenA, a, rid, { kind: "manual_test_suggestion", title: "Screen reader on checkout", category: "accessibility", priority: "high", steps: ["Tab through the form"] }));
    assert.deepEqual([tc.sourceId, bug.sourceId, ob.sourceId, man.sourceId], [1, 2, 3, 4].map((n) => `$agent-${rid}-${n}`));

    const c = rows<{ status: string; created_by_agent_token_id: number; tags: string; suite_id: number | null; priority: string }>("SELECT status, created_by_agent_token_id, tags, suite_id, priority FROM cases WHERE id = ?", tc.id)[0];
    assert.deepEqual([c.status, c.created_by_agent_token_id, c.tags, c.suite_id, c.priority], ["draft", tokenId("claude-a"), '["agent-proposed"]', null, "high"]);
    assert.deepEqual(rows<{ action: string; expected: string }>("SELECT action, expected FROM case_steps WHERE case_id = ? ORDER BY position", tc.id), [{ action: "Open /login", expected: "A form" }, { action: "Submit", expected: "" }]);

    const bg = rows<{ review_status: string; audit_id: number | null; origin_audit_id: string; source_id: string; agent_severity: string; human_severity: string | null; reviewed_at: string | null }>("SELECT review_status, audit_id, origin_audit_id, source_id, agent_severity, human_severity, reviewed_at FROM bug_reports WHERE id = ?", bug.id)[0];
    assert.deepEqual([bg.review_status, bg.audit_id, bg.origin_audit_id, bg.source_id, bg.agent_severity, bg.human_severity, bg.reviewed_at], ["proposed", null, `$agent-${rid}`, `$agent-${rid}-2`, "medium", null, null]);
    assert.equal(rows("SELECT 1 FROM bug_revisions WHERE bug_report_id = ?", bug.id).length, 1);

    const o = rows<{ kind: string; status: string; audit_id: number | null; origin_audit_id: string; source_id: string; status_set_by: string }>("SELECT kind, status, audit_id, origin_audit_id, source_id, status_set_by FROM observations WHERE id = ?", ob.id)[0];
    assert.deepEqual([o.kind, o.status, o.audit_id, o.origin_audit_id, o.source_id, o.status_set_by], ["exploratory", "observed", null, `$agent-${rid}`, `$agent-${rid}-3`, "agent"]);

    const m = rows<{ review_status: string; audit_id: number | null; origin_audit_id: string; source_id: string; category: string; human_priority: string | null; case_id: number | null }>("SELECT review_status, audit_id, origin_audit_id, source_id, category, human_priority, case_id FROM manual_tests WHERE id = ?", man.id)[0];
    assert.deepEqual([m.review_status, m.audit_id, m.origin_audit_id, m.source_id, m.category, m.human_priority, m.case_id], ["proposed", null, `$agent-${rid}`, `$agent-${rid}-4`, "accessibility", null, null]);
    assert.equal(rows("SELECT 1 FROM manual_test_revisions WHERE manual_test_id = ?", man.id).length, 1);
    assert.equal(rows<{ findings_count: number }>("SELECT findings_count FROM agent_requests WHERE id = ?", rid)[0].findings_count, 4);
  });

  it("shows the findings to a person where they look: the observation under Exploratory, the case with its mark, and a person's own case without one", async () => {
    const list = await ok<{ counts: { kind: Record<string, number> }; items: { kind: string; status: string; title: string }[] }>(await person(`/api/projects/${a}/observations?kind=exploratory`, undefined, "GET"));
    assert.ok(list.counts.kind.exploratory >= 1);
    assert.ok(list.items.every((i) => i.kind === "exploratory" && i.status === "observed"));
    const cases = await ok<{ title: string; status: string; tags: string[]; created_by_agent_token_id: number | null }[]>(await person(`/api/projects/${a}/cases`, undefined, "GET"));
    const mine = cases.find((c) => c.title === "Sign in")!;
    assert.deepEqual([mine.status, mine.tags, mine.created_by_agent_token_id], ["draft", ["agent-proposed"], tokenId("claude-a")]);
    await ok(await person(`/api/projects/${a}/cases`, { title: "By a person" }));
    const again = await ok<{ title: string; tags: string[]; created_by_agent_token_id: number | null }[]>(await person(`/api/projects/${a}/cases`, undefined, "GET"));
    const human = again.find((c) => c.title === "By a person")!;
    assert.deepEqual([human.created_by_agent_token_id, human.tags], [null, []]);
  });

  it("never approves, accepts or decides anything, and an audit package cannot make an exploratory observation", async () => {
    assert.deepEqual(rows("SELECT 1 FROM bug_reports WHERE origin_audit_id LIKE '$agent-%' AND (review_status != 'proposed' OR human_severity IS NOT NULL OR reviewed_by != '')"), []);
    assert.deepEqual(rows("SELECT 1 FROM manual_tests WHERE origin_audit_id LIKE '$agent-%' AND review_status != 'proposed'"), []);
    assert.deepEqual(rows("SELECT 1 FROM cases WHERE created_by_agent_token_id IS NOT NULL AND status != 'draft'"), []);
    assert.deepEqual(rows("SELECT 1 FROM observations WHERE kind = 'exploratory' AND (status != 'observed' OR audit_id IS NOT NULL)"), []);
    const res = await person(`/api/projects/${a}/observations`, { observations: [{ id: "X-1", auditId: "AUD-1", kind: "exploratory", title: "Sneaky", severity: "low" }] });
    assert.equal(res.status, 400);
    assert.equal(rows("SELECT 1 FROM observations WHERE source_id = 'X-1'").length, 0);
  });
});

describe("a refused finding leaves no trace", () => {
  it("answers 400 for a bad kind, an unknown field, a missing title and a bad value, 413 for a huge body, and counts nothing", async () => {
    const rid = await taken(a, tokenA);
    const count = () => ["cases", "bug_reports", "observations", "manual_tests", "audit_log"].map((t) => rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)[0].n);
    const before = count();
    const bad: unknown[] = [
      { kind: "spec", title: "x" }, { title: "no kind" }, {}, { kind: "observation" }, { kind: "observation", title: "" }, { kind: "observation", title: "x", status: "approved" },
      { kind: "observation", title: "x", severity: "catastrophic" }, { kind: "bug_report", title: "x", review_status: "accepted" }, { kind: "bug_report", title: "x", severity: "info" },
      { kind: "test_case", title: "x", priority: "urgent" }, { kind: "test_case", title: "x", steps: ["a string, not a step"] }, { kind: "test_case", title: "x", created_by_agent_token_id: null },
      { kind: "manual_test_suggestion", title: "x", category: "nonsense" }, { kind: "manual_test_suggestion", title: "x", request_id: 5 },
    ];
    for (const body of bad) assert.equal((await finding(tokenA, a, rid, body)).status, 400, JSON.stringify(body));
    assert.equal((await agent(`Bearer ${tokenA}`, `/api/agent/projects/${a}/requests/${rid}/findings`, "POST")).status, 400, "no body at all");
    assert.equal((await finding(tokenA, a, rid, { ...obs, evidence: "y".repeat(300_000) })).status, 413);
    assert.deepEqual(count(), before, "no row, no audit entry");
    assert.equal(rows<{ findings_count: number }>("SELECT findings_count FROM agent_requests WHERE id = ?", rid)[0].findings_count, 0, "the request was not counted");
    const first = await ok<{ sourceId: string }>(await finding(tokenA, a, rid, obs));
    assert.equal(first.sourceId, `$agent-${rid}-1`, "the numbers have no gaps");
  });
});

describe("the plan of a request, through the route", () => {
  type Made = { kind: string; id: number; sourceId: string; auditId: number; findingsOnRequest: number; planItemsOnRequest: number; coverageGapsOnRequest: number };
  type Plan = { audit: { id: number; agentAuditId: string; title: string }; planItems: { sourceId: string; title: string; origin: string; status: string; priority: string; requirements: { raw: string; state: string }[] }[]; coverageGaps: { sourceId: string; description: string; origin: string; status: string }[] };

  it("makes plan items and a coverage gap for the request, answers with their numbers and the audit, and a person sees them as the agent's proposals", async () => {
    const rid = await taken(a, tokenA);
    const one = await ok<Made>(await finding(tokenA, a, rid, { kind: "plan_item", title: "Sign in works", type: "functional", priority: "high", requirements: ["REQ-1"], steps: ["Open /login"], acceptanceCriteria: "A person is signed in" }));
    assert.deepEqual([one.kind, one.sourceId, one.findingsOnRequest, one.planItemsOnRequest, one.coverageGapsOnRequest], ["plan_item", "P-1", 0, 1, 0]);
    const two = await ok<Made>(await finding(tokenA, a, rid, { kind: "plan_item", title: "Sign out works" }));
    assert.deepEqual([two.sourceId, two.auditId], ["P-2", one.auditId], "the same audit");
    const gap = await ok<Made>(await finding(tokenA, a, rid, { kind: "coverage_gap", description: "Password reset was not tried", requirements: ["REQ-1"] }));
    assert.deepEqual([gap.sourceId, gap.auditId, gap.planItemsOnRequest, gap.coverageGapsOnRequest], ["GAP-1", one.auditId, 2, 1]);

    const plan = await ok<Plan>(await person(`/api/audits/${one.auditId}/plan`, undefined, "GET"));
    assert.equal(plan.audit.agentAuditId, `$agent-${rid}`);
    assert.deepEqual(plan.planItems.map((i) => [i.sourceId, i.title, i.origin, i.status]), [["P-1", "Sign in works", "agent", "proposed"], ["P-2", "Sign out works", "agent", "proposed"]]);
    assert.equal(plan.planItems[0].priority, "high");
    assert.deepEqual(plan.planItems[0].requirements.map((r) => r.raw), ["REQ-1"], "kept as written, and matched when shown");
    assert.deepEqual(plan.coverageGaps.map((g) => [g.sourceId, g.description, g.origin, g.status]), [["GAP-1", "Password reset was not tried", "agent", "proposed"]]);

    const mine = (await ok<{ id: number; resultAudit: { id: number; title: string; agentAuditId: string } | null }[]>(await person(`/api/projects/${a}/agent-requests`, undefined, "GET"))).find((r) => r.id === rid)!;
    assert.deepEqual([mine.resultAudit?.id, mine.resultAudit?.title], [one.auditId, "Discover http://localhost:3000/"], "the request's card links its audit");
    const listed = (await ok<{ id: number; source: string; imports: number }[]>(await person(`/api/projects/${a}/audits`, undefined, "GET"))).find((x) => x.id === one.auditId)!;
    assert.deepEqual([listed.source, listed.imports], ["request", 0], "an audit with no import behind it");
  });

  it("links a draft case to a plan item of its own request, and a person's decision on the item is the person's alone", async () => {
    const rid = await taken(a, tokenA);
    const made = await ok<Made>(await finding(tokenA, a, rid, { kind: "plan_item", title: "Pay works" }));
    const tc = await ok<{ id: number; planItem: string }>(await finding(tokenA, a, rid, { kind: "test_case", title: "Pay with a card", planItem: made.sourceId }));
    assert.equal(tc.planItem, "P-1");
    assert.equal(rows<{ plan_item_id: number }>("SELECT plan_item_id FROM cases WHERE id = ?", tc.id)[0].plan_item_id, rows<{ id: number }>("SELECT id FROM audit_plan_items WHERE audit_id = ? AND source_id = 'P-1'", made.auditId)[0].id);
    const decided = await person(`/api/audits/${made.auditId}/plan/items/P-1/decision`, { status: "approved" });
    assert.equal(decided.status, 200, "a person decides it with the route that already exists");
    assert.equal(rows<{ review_status: string; decided_by: string }>("SELECT review_status, decided_by FROM audit_plan_items WHERE audit_id = ? AND source_id = 'P-1'", made.auditId)[0].review_status, "approved");
    assert.equal((await agent(`Bearer ${tokenA}`, `/api/audits/${made.auditId}/plan/items/P-1/decision`, "POST", { status: "rejected" })).status, 403, "the agent cannot");
  });

  it("refuses what is not a plan item or a gap (400), a link to something that is not its own (400), and makes nothing", async () => {
    const rid = await taken(a, tokenA);
    const count = () => [rows<{ n: number }>("SELECT COUNT(*) AS n FROM audits")[0].n, rows<{ n: number }>("SELECT COUNT(*) AS n FROM audit_plan_items")[0].n, rows<{ n: number }>("SELECT COUNT(*) AS n FROM cases")[0].n, rows<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log")[0].n];
    const before = count();
    for (const bad of [
      { kind: "plan_item", title: "x", severity: "high" }, { kind: "plan_item", title: "x", readiness: "maybe" }, { kind: "plan_item", title: "x".repeat(201) },
      { kind: "coverage_gap" }, { kind: "coverage_gap", description: "x", title: "a gap has no title" }, { kind: "test_case", title: "x", planItem: "P-1" },
    ]) assert.equal((await finding(tokenA, a, rid, bad)).status, 400, JSON.stringify(bad));
    assert.deepEqual(count(), before, "the first plan item never made an audit for a refused request");
  });

  it("logs a plan item like any finding, with its number and the audit, as the agent and never with a token", async () => {
    const rid = await taken(a, tokenA);
    const made = await ok<Made>(await finding(tokenA, a, rid, { kind: "plan_item", title: "Logged" }));
    const log = rows<{ actor_label: string; detail: string }>("SELECT actor_label, detail FROM audit_log WHERE action = 'agent_request.finding_created' AND detail LIKE ?", `%"finding_kind":"plan_item"%"request":${rid}%`).concat(
      rows<{ actor_label: string; detail: string }>("SELECT actor_label, detail FROM audit_log WHERE action = 'agent_request.finding_created' AND detail LIKE ?", `%"request":${rid},%"finding_kind":"plan_item"%`));
    const d = log.map((l) => JSON.parse(l.detail)).find((x) => x.id === made.id);
    assert.ok(d, "an entry for it");
    assert.deepEqual([d.finding_kind, d.n, d.audit, d.credential_id], ["plan_item", "P-1", made.auditId, tokenId("claude-a")]);
    assert.ok(log.every((l) => l.actor_label === "agent: claude-a"));
    for (const t of issued) assert.equal(JSON.stringify(log).includes(t), false);
  });

  it("shows a person the link both ways and what the request delivered: the case's plan item, each plan item's cases, and the counts of the card", async () => {
    const rid = await taken(a, tokenA);
    const p1 = await ok<Made>(await finding(tokenA, a, rid, { kind: "plan_item", title: "Checkout works" }));
    const tc = await ok<{ id: number }>(await finding(tokenA, a, rid, { kind: "test_case", title: "Pay with a card", planItem: "P-1" }));
    const loose = await ok<{ id: number }>(await finding(tokenA, a, rid, { kind: "test_case", title: "A loose case" }));
    await ok(await finding(tokenA, a, rid, { kind: "observation", title: "Slow", severity: "low" }));
    type CaseView = { planItem: { sourceId: string; title: string; status: string; auditId: number; auditTitle: string } | null };
    assert.deepEqual((await ok<CaseView>(await person(`/api/cases/${tc.id}`, undefined, "GET"))).planItem, { sourceId: "P-1", title: "Checkout works", status: "proposed", auditId: p1.auditId, auditTitle: "Discover http://localhost:3000/" });
    assert.equal((await ok<CaseView>(await person(`/api/cases/${loose.id}`, undefined, "GET"))).planItem, null, "a case with no plan item says so");

    const plan = await ok<{ planItems: { sourceId: string; cases: { id: number; key: string; title: string; status: string }[] }[] }>(await person(`/api/audits/${p1.auditId}/plan`, undefined, "GET"));
    assert.deepEqual(plan.planItems[0].cases.map((c) => [c.id, c.title, c.status]), [[tc.id, "Pay with a card", "draft"]]);
    assert.match(plan.planItems[0].cases[0].key, /^[A-Z0-9]+-\d+$/);

    assert.equal((await person(`/api/audits/${p1.auditId}/plan/items/P-1/decision`, { status: "approved" })).status, 200);
    assert.equal((await ok<CaseView>(await person(`/api/cases/${tc.id}`, undefined, "GET"))).planItem?.status, "approved", "the note follows the person's decision");

    const mine = (await ok<{ id: number; delivered: Record<string, number> | null }[]>(await person(`/api/projects/${a}/agent-requests`, undefined, "GET"))).find((r) => r.id === rid)!;
    assert.deepEqual(mine.delivered, { planItems: 1, coverageGaps: 0, cases: 2, bugs: 0, observations: 1, manualTests: 0 });
  });
});

describe("the log, the secrets and the limits", () => {
  it("logs who made what as 'agent: <name>' with the token's id, only for findings that were made, and never a token or a hash", async () => {
    const rid = await taken(a, tokenA2);
    const made = await ok<{ id: number }>(await finding(tokenA2, a, rid, { kind: "bug_report", title: "Logged" }));
    assert.equal((await finding(tokenA, a, rid, obs)).status, 409, "a refused finding is not logged");
    const log = rows<{ actor_label: string; actor_user_id: number | null; action: string; detail: string; project_id: number }>("SELECT actor_label, actor_user_id, action, detail, project_id FROM audit_log WHERE action = 'agent_request.finding_created' AND detail LIKE ?", `%"request":${rid},%`);
    assert.equal(log.length, 1);
    assert.deepEqual([log[0].actor_label, log[0].actor_user_id, log[0].project_id], ["agent: second-agent", null, a]);
    assert.deepEqual(JSON.parse(log[0].detail), { request: rid, kind: "discover", finding_kind: "bug_report", id: made.id, n: 1, credential_id: tokenId("second-agent") });
    const all = JSON.stringify(rows("SELECT * FROM audit_log"));
    for (const t of issued) assert.equal(all.includes(t), false, "a token is in the audit log");
    for (const h of rows<{ token_hash: string }>("SELECT token_hash FROM request_tokens").map((r) => r.token_hash)) assert.equal(all.includes(h), false, "a token hash is in the audit log");
  });

  it("answers 429 after 60 findings a minute from one token, and does not slow another token", async () => {
    const rid = await taken(a, tokenBusy);
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++) statuses.push((await finding(tokenBusy, a, rid, { ...obs, title: `n${i}` })).status);
    assert.equal(statuses.filter((s) => s === 201).length, 60);
    assert.deepEqual(statuses.slice(60), [429, 429]);
    assert.equal(rows<{ findings_count: number }>("SELECT findings_count FROM agent_requests WHERE id = ?", rid)[0].findings_count, 60, "the refused ones were not made");
    // One request runs at a time in a project: the first is cancelled, and the other token takes the next.
    assert.equal((await person(`/api/agent-requests/${rid}/cancel`, {})).status, 200);
    const other = await taken(a, tokenA);
    assert.equal((await finding(tokenA, a, other, obs)).status, 201, "another token is not slowed down");
  });

  it("never prints a token to the server's output", () => {
    for (const t of issued) assert.equal(output.includes(t), false, "a token reached the server's output");
  });
});
