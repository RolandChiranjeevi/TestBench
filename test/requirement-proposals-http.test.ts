import "./env.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// The requirement routes as a browser and as an agent reach them: who is recorded, how a requirement is approved or deprecated, and what an agent token can do.
// A server of its own, on this machine only, with an empty data folder and no password: nothing of a real installation is reached.

describe("requirement and proposal routes", () => {
  const ROOT = join(import.meta.dirname, "..");
  const PORT = 47000 + Math.floor(Math.random() * 2000);
  const BASE = `http://127.0.0.1:${PORT}`;
  const DATA = mkdtempSync(join(tmpdir(), "tb-requirements-http-"));
  let server: ChildProcess;
  let output = "";
  let projectId = 0;
  const HUMAN = { "X-Testbench": "1" };
  const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = HUMAN) =>
    fetch(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async <T = any>(res: Response) => (await res.json()) as T;
  const proposal = (over: Record<string, unknown> = {}) => ({ title: "Passwords are never shown", description: "Masked.", acceptanceCriteria: "- masked", rationale: "OBS-1", suggestedPriority: "high", basis: "observation", ...over });

  before(async () => {
    server = spawn(process.execPath, ["--import", "tsx", join(ROOT, "server", "index.ts")], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TESTBENCH_DATA: DATA, TESTBENCH_PORT: String(PORT), TESTBENCH_PASSWORD: "", NODE_ENV: "production", TESTBENCH_AUTO_BACKUP: "0" },
    });
    server.stdout?.on("data", (d) => (output += d));
    server.stderr?.on("data", (d) => (output += d));
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${BASE}/api/auth/status`)).ok) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    const res = await call("/api/projects", "POST", { name: "Req HTTP", key: "RQH" });
    assert.equal(res.status, 200, output);
    projectId = (await json(res)).id;
  });
  after(() => server?.kill());

  it("records the display name on what a person does, as typed (source: typed)", async () => {
    assert.deepEqual(await json(await call("/api/settings/display-name")), { name: "", recordedAs: "unnamed user", source: "typed" });
    assert.equal((await call("/api/settings/display-name", "PUT", { name: "x".repeat(81) })).status, 400);
    assert.equal((await json(await call("/api/settings/display-name", "PUT", { name: "Anna Berg" }))).recordedAs, "Anna Berg");
    const r = await json(await call(`/api/projects/${projectId}/requirements`, "POST", { title: "Login", acceptanceCriteria: "- works", status: "approved" }));
    assert.deepEqual([r.origin, r.created_by, r.approved_by, r.acceptance_criteria, r.history[0].by], ["human", "Anna Berg", "Anna Berg", "- works", "Anna Berg"]);
  });

  it("a request cannot set the origin or the approver: they are the server's to set", async () => {
    const r = await json(await call(`/api/projects/${projectId}/requirements`, "POST", { title: "Sneaky", status: "draft", origin: "ai_suggestion", approvedBy: "Someone Else", createdBy: "Someone Else" }));
    assert.deepEqual([r.origin, r.created_by, r.approved_by, r.status], ["human", "Anna Berg", "", "draft"]);
  });

  it("approving a draft records who, taking it back clears that, and the change log shows each step", async () => {
    const d = await json(await call(`/api/projects/${projectId}/requirements`, "POST", { title: "Draft rule", status: "draft" }));
    const approved = await json(await call(`/api/requirements/${d.id}`, "PATCH", { status: "approved" }));
    assert.deepEqual([approved.status, approved.approved_by], ["approved", "Anna Berg"]);
    assert.ok(approved.approved_at);
    const back = await json(await call(`/api/requirements/${d.id}`, "PATCH", { status: "draft", acceptanceCriteria: "- new criterion" }));
    assert.deepEqual([back.approved_by, back.approved_at], ["", null]);
    const fields = back.history.flatMap((h: { changes: { field: string }[] }) => h.changes.map((c) => c.field));
    assert.ok(["approved by", "status", "acceptance criteria"].every((f) => fields.includes(f)), JSON.stringify(fields));
    assert.ok(back.history.every((h: { by: string }) => h.by === "Anna Berg"));
  });

  it("deprecating is a person's action: it keeps the requirement, and does it once", async () => {
    const r = await json(await call(`/api/projects/${projectId}/requirements`, "POST", { title: "Old rule" }));
    const res = await call(`/api/requirements/${r.id}/deprecate`, "POST", { reason: "Replaced" });
    assert.equal((await json(res)).status, "deprecated");
    assert.equal((await call(`/api/requirements/${r.id}/deprecate`, "POST", {})).status, 409);
    assert.equal((await call(`/api/requirements/999999/deprecate`, "POST", {})).status, 404);
    assert.equal((await call(`/api/requirements/${r.id}/deprecate`, "POST", {}, {})).status, 403); // no X-Testbench header
  });

  it("agent proposals are off by default: the route refuses, and no token can be made", async () => {
    assert.deepEqual(await json(await call("/api/settings/agent-proposals")), { enabled: false });
    assert.equal((await call(`/api/projects/${projectId}/propose-tokens`, "POST", { name: "skill" })).status, 409);
    const res = await call(`/api/agent/projects/${projectId}/requirement-proposals`, "POST", proposal(), { Authorization: "Bearer tbpr_nothing" });
    assert.equal(res.status, 403);
  });

  it("an agent with a proposal token makes proposals and nothing else; a person decides", async () => {
    assert.equal((await json(await call("/api/settings/agent-proposals", "PUT", { enabled: true }))).enabled, true);
    const made = await json(await call(`/api/projects/${projectId}/propose-tokens`, "POST", { name: "skill run 12" }));
    const AGENT = { Authorization: `Bearer ${made.token}` }; // the agent sends no X-Testbench header: its token is what authenticates it
    assert.equal(JSON.stringify(await json(await call(`/api/projects/${projectId}/propose-tokens`))).includes(made.token), false);

    // it can propose, in a batch, and the proposals start as proposed
    const res = await call(`/api/agent/projects/${projectId}/requirement-proposals`, "POST", [proposal(), proposal({ title: "Second" })], AGENT);
    assert.equal(res.status, 200, output);
    const ids: number[] = (await json(res)).created.map((c: { id: number }) => c.id);
    const list = await json(await call(`/api/projects/${projectId}/requirement-proposals`));
    assert.deepEqual([list.counts.proposed, list.items[0].status, list.items[0].proposedBy], [2, "proposed", "agent: skill run 12"]);
    assert.equal((await json(await call(`/api/projects/${projectId}/requirements`))).some((r: { title: string }) => r.title === "Second"), false);

    // it cannot ask for a status, and a wrong or missing token is refused
    assert.equal((await call(`/api/agent/projects/${projectId}/requirement-proposals`, "POST", proposal({ status: "approved" }), AGENT)).status, 400);
    assert.equal((await call(`/api/agent/projects/${projectId}/requirement-proposals`, "POST", proposal(), { Authorization: "Bearer tbpr_wrong" })).status, 401);
    assert.equal((await call(`/api/agent/projects/${projectId}/requirement-proposals`, "POST", proposal(), {})).status, 401);

    // and its token opens no other route: approve, reject, edit, create, deprecate and read are all refused, even with the X-Testbench header
    for (const [path, method, body] of [
      [`/api/requirement-proposals/${ids[0]}/approve`, "POST", {}], [`/api/requirement-proposals/${ids[0]}/reject`, "POST", { reason: "no thanks" }],
      [`/api/requirement-proposals/${ids[0]}`, "PATCH", { title: "x" }], [`/api/projects/${projectId}/requirements`, "POST", { title: "By an agent" }],
      ["/api/requirements/1", "PATCH", { status: "approved" }], ["/api/requirements/1/deprecate", "POST", {}], [`/api/projects/${projectId}/requirements`, "GET", undefined],
    ] as const) {
      const r = await call(path, method, body, { ...HUMAN, ...AGENT });
      assert.equal(r.status, 403, `${method} ${path}`);
    }
    assert.equal((await json(await call(`/api/requirement-proposals/${ids[0]}`))).status, "proposed");

    // a person edits, approves one and rejects the other
    const edited = await json(await call(`/api/requirement-proposals/${ids[0]}`, "PATCH", { suggestedPriority: "critical" }));
    assert.deepEqual([edited.edited, edited.original.suggestedPriority], [true, "high"]);
    const approved = await json(await call(`/api/requirement-proposals/${ids[0]}/approve`, "POST", {}));
    assert.equal(approved.proposal.status, "approved");
    const req = await json(await call(`/api/requirements/${approved.requirementId}`));
    assert.deepEqual([req.origin, req.status, req.priority, req.created_by, req.approved_by], ["ai_suggestion", "approved", "critical", "agent: skill run 12", "Anna Berg"]);
    assert.equal((await call(`/api/requirement-proposals/${ids[0]}/approve`, "POST", {})).status, 409);
    assert.equal((await call(`/api/requirement-proposals/${ids[1]}/reject`, "POST", { reason: "" })).status, 400);
    const rejected = await json(await call(`/api/requirement-proposals/${ids[1]}/reject`, "POST", { reason: "Covered by REQ-1" }));
    assert.deepEqual([rejected.status, rejected.rejectReason], ["rejected", "Covered by REQ-1"]);
    assert.equal((await call(`/api/requirement-proposals/${ids[1]}/approve`, "POST", {})).status, 409);

    // the read token and the proposal token are different things
    const read = await json(await call(`/api/projects/${projectId}/agent/tokens`, "POST", { name: "reader" }));
    assert.equal((await call(`/api/agent/projects/${projectId}/requirement-proposals`, "POST", proposal(), { Authorization: `Bearer ${read.token}` })).status, 401);
    assert.equal((await call(`/api/agent/projects/${projectId}/requirements`, "GET", undefined, AGENT)).status, 401);

    // revoked, and switched off again
    await call(`/api/propose-tokens/${made.id}/revoke`, "POST", {});
    assert.equal((await call(`/api/agent/projects/${projectId}/requirement-proposals`, "POST", proposal(), AGENT)).status, 401);
    await call("/api/settings/agent-proposals", "PUT", { enabled: false });
    assert.equal((await call(`/api/agent/projects/${projectId}/requirement-proposals`, "POST", proposal(), AGENT)).status, 403);
  });

  it("coverage gaps and observation links: the lists are right, links stay in the project, and an agent token reaches none of it", async () => {
    const other = await json(await call("/api/projects", "POST", { name: "Other", key: "OTH" }));
    const mine = await json(await call(`/api/projects/${projectId}/requirements`, "POST", { title: "Needs a test", status: "approved" }));
    const theirs = await json(await call(`/api/projects/${other.id}/requirements`, "POST", { title: "Theirs", status: "approved" }));
    const gaps = await json(await call(`/api/projects/${projectId}/coverage-gaps`));
    assert.ok(gaps.requirementsWithoutCases.some((r: { id: number }) => r.id === mine.id));
    assert.equal(gaps.requirementsWithoutCases.some((r: { id: number }) => r.id === theirs.id), false, "another project's requirement is not listed");
    assert.equal((await call(`/api/projects/999999/coverage-gaps`)).status, 404);
    assert.equal((await call(`/api/observations/999999/links`)).status, 404);
    assert.equal((await call(`/api/observations/999999/links`, "PUT", { requirementIds: [] })).status, 404);

    // Linking a real observation needs an audit, which only an audit import makes; that is covered on function level (coverage-gaps.test.ts). Here: an agent
    // credential reaches none of these routes, and a write without the X-Testbench header is refused.
    const AGENT_READ = { Authorization: "Bearer tbag_whatever" };
    for (const [path, method, body] of [[`/api/projects/${projectId}/coverage-gaps`, "GET", undefined], ["/api/observations/1/links", "PUT", { requirementIds: [] }], ["/api/observations/1/links", "GET", undefined]] as const) {
      assert.equal((await call(path, method, body, { ...HUMAN, ...AGENT_READ })).status, 403, `${method} ${path}`);
    }
    assert.equal((await call("/api/observations/1/links", "PUT", { requirementIds: [] }, {})).status, 403, "no X-Testbench header");
  });

  it("generate-proposals: a dry run changes nothing, a run makes proposed proposals from the gaps, a second run makes none, and no agent token can start it", async () => {
    const url = `/api/projects/${projectId}/generate-proposals`;
    const made = await json(await call(`/api/projects/${projectId}/cases`, "POST", { title: "Search by name" }));
    assert.ok(made.id, output);
    const before = (await json(await call(`/api/projects/${projectId}/requirement-proposals`))).items.length;

    const dry = await json(await call(`${url}?dryRun=1`, "POST", {}));
    assert.deepEqual([dry.dryRun, dry.counts.created >= 1, dry.created.every((c: { id: number | null }) => c.id === null)], [true, true, true]);
    assert.equal((await json(await call(`/api/projects/${projectId}/requirement-proposals`))).items.length, before, "a dry run writes nothing");

    const run = await json(await call(url, "POST", {}));
    assert.equal(run.dryRun, false);
    assert.ok(run.counts.created >= 1 && run.created.every((c: { id: number | null; gap: string }) => typeof c.id === "number" && /^(case|obs):\d+$/.test(c.gap)), JSON.stringify(run.counts));
    assert.ok(run.notGenerated.every((g: { gap: string; reason: string }) => /^req:\d+$/.test(g.gap) && /not generated/.test(g.reason)), "requirements without a test are reported, not turned into proposals");
    const proposals = await json(await call(`/api/projects/${projectId}/requirement-proposals?status=proposed`));
    const mine = proposals.items.filter((p: { proposedBy: string }) => p.proposedBy.startsWith("rule:"));
    assert.equal(mine.length, run.counts.created);
    assert.ok(mine.every((p: { status: string; basis: string }) => p.status === "proposed" && p.basis === "coverage_gap"));
    assert.equal((await json(await call(`/api/projects/${projectId}/requirements`))).some((r: { created_by: string }) => r.created_by.startsWith("rule:")), false, "a proposal is not a requirement");

    const again = await json(await call(url, "POST", {}));
    assert.deepEqual([again.counts.created, again.counts.skipped >= 1], [0, true]);

    // only a person starts it: no X-Testbench header, and no kind of agent token
    assert.equal((await call(url, "POST", {}, {})).status, 403);
    for (const token of ["tbag_x", "tbpr_x", "tbci_x"]) assert.equal((await call(url, "POST", {}, { ...HUMAN, Authorization: `Bearer ${token}` })).status, 403, token);
    assert.equal((await call(`/api/projects/999999/generate-proposals`, "POST", {})).status, 404);

    // a person approves one, and it becomes an AI-suggested requirement approved by that person
    const approved = await json(await call(`/api/requirement-proposals/${mine[0].id}/approve`, "POST", {}));
    const req = await json(await call(`/api/requirements/${approved.requirementId}`));
    assert.deepEqual([req.origin, req.status, req.created_by.startsWith("rule:"), req.approved_by], ["ai_suggestion", "approved", true, "Anna Berg"]);
  });
});
