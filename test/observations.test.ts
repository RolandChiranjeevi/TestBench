import "./env.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import Database from "better-sqlite3";
import { db } from "../server/db.ts";
import { makeProject } from "./helpers.ts";
import { convertToBug, getObservation, importObservations, listObservations, ObservationError, setObservationStatus } from "../server/observations.ts";

// Observations: load-test and security-review results that are not bugs. Everything here runs against a throwaway data folder (see env.ts).

let n = 0;
const proj = () => makeProject(`OB${++n}`, `Observations ${n}`);
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);

/** An audit of the project, as an import would have left it. */
function audit(p: { id: number }, agentId = "a1") {
  return (db.prepare("INSERT INTO audits (project_id, agent_audit_id, title, source) VALUES (?, ?, ?, 'upload') RETURNING id").get(p.id, agentId, `Audit ${agentId}`) as { id: number }).id;
}
let bugN = 0;
/** One evidence file of the audit (it belongs to a bug report of the audit, as evidence does). */
function evidence(p: { id: number }, auditRow: number, agentAudit: string, path: string, sha: string | null = SHA, state = "stored") {
  const bug = db.prepare("INSERT INTO bug_reports (project_id, audit_id, origin_audit_id, source_id, title) VALUES (?, ?, ?, ?, 'bug') RETURNING id").get(p.id, auditRow, agentAudit, `B-${++bugN}`) as { id: number };
  db.prepare("INSERT INTO bug_attachments (bug_report_id, declared_path, filename, sha256, state, active, reason) VALUES (?, ?, ?, ?, ?, 1, ?)")
    .run(bug.id, path, path.split("/").pop(), sha, state, state === "stored" ? "" : "the file is not there");
}

const load = (over: Record<string, unknown> = {}) => ({ id: "LT-1", auditId: "a1", kind: "load_test", title: "p95 latency on /api/todos", severity: "high", status: "observed", metric: "p95_ms", value: 840, threshold: 500, evidence: "k6, 50 users, 2 minutes", evidenceIds: [], recommendation: "Add an index on todos(user_id)", source: "k6-skill run 12", ...over });
const sec = (over: Record<string, unknown> = {}) => ({ id: "SR-1", auditId: "a1", kind: "security_review", title: "Missing CSP header", severity: "medium", evidence: "Response has no Content-Security-Policy", recommendation: "Set a CSP", source: "security-review skill", ...over });
const problems = (fn: () => unknown): string[] => {
  try { fn(); } catch (e) { assert.ok(e instanceof ObservationError, String(e)); return e.problems; }
  assert.fail("expected an ObservationError");
};

describe("importing observations", () => {
  it("creates load-test and security-review observations, numbered OBS-n per project, with the agent's id kept", () => {
    const p = proj(); audit(p);
    const r = importObservations(p.id, [load(), sec()]);
    assert.deepEqual(r.counts, { new: 2, unchanged: 0, updated: 0, pending: 0 });
    assert.equal(r.dryRun, false);
    const all = listObservations(p.id).items;
    assert.deepEqual(all.map((o) => [o.label, o.sourceId, o.kind]).sort(), [["OBS-1", "LT-1", "load_test"], ["OBS-2", "SR-1", "security_review"]]);
    const lt = all.find((o) => o.sourceId === "LT-1")!;
    assert.deepEqual([lt.metric, lt.value, lt.threshold, lt.status, lt.statusSetBy], ["p95_ms", 840, 500, "observed", "agent"]);
    const other = proj(); audit(other);
    importObservations(other.id, [load()]); // the same agent id in another project is its own observation, and the numbering starts again
    assert.equal(listObservations(other.id).items[0].label, "OBS-1");
  });

  it("accepts the observations inside an object, next to a list that says which file an EV-... label means", () => {
    const p = proj(); const a = audit(p);
    evidence(p, a, "a1", "evidence/k6.json");
    const r = importObservations(p.id, { observations: [load({ evidenceIds: ["EV-1"] })], evidence: [{ id: "EV-1", path: "evidence/k6.json", sha256: SHA }] });
    assert.deepEqual(r.evidence, { ok: 1, problems: 0 });
    assert.equal(r.unresolved_refs, 0);
    const f = listObservations(p.id).items[0].evidenceFiles;
    assert.deepEqual(f.map((x) => [x.ref, x.path, x.state]), [["EV-1", "evidence/k6.json", "ok"]]);
  });

  it("a dry run reports the counts and the evidence and writes nothing", () => {
    const p = proj(); const a = audit(p);
    evidence(p, a, "a1", "evidence/k6.json");
    const before = [count("SELECT COUNT(*) AS n FROM observations"), count("SELECT COUNT(*) AS n FROM observation_evidence")];
    const r = importObservations(p.id, [load({ evidenceIds: ["evidence/k6.json", "evidence/gone.json"] }), sec()], { dryRun: true });
    assert.equal(r.dryRun, true);
    assert.deepEqual(r.counts, { new: 2, unchanged: 0, updated: 0, pending: 0 });
    assert.deepEqual(r.evidence, { ok: 1, problems: 0 });
    assert.equal(r.unresolved_refs, 1);
    assert.deepEqual(r.items.map((i) => [i.id, i.number, i.action]), [["LT-1", null, "new"], ["SR-1", null, "new"]]);
    assert.deepEqual([count("SELECT COUNT(*) AS n FROM observations"), count("SELECT COUNT(*) AS n FROM observation_evidence")], before);
    // ... and the real import afterwards says the same thing
    const real = importObservations(p.id, [load({ evidenceIds: ["evidence/k6.json", "evidence/gone.json"] }), sec()]);
    assert.deepEqual([real.counts, real.evidence, real.unresolved_refs], [r.counts, r.evidence, r.unresolved_refs]);
  });

  it("a dry run of observations that are already there says unchanged or updated, also without writing", () => {
    const p = proj(); audit(p);
    importObservations(p.id, [load(), sec()]);
    const r = importObservations(p.id, [load(), sec({ severity: "high" })], { dryRun: true });
    assert.deepEqual(r.counts, { new: 0, unchanged: 1, updated: 1, pending: 0 });
    assert.equal(listObservations(p.id).items.find((o) => o.sourceId === "SR-1")!.severity, "medium");
  });

  it("evidence that is not found does not reject the import: it is reported as unresolved_refs, as in the audit import", () => {
    const p = proj(); audit(p);
    const r = importObservations(p.id, [load({ evidenceIds: ["evidence/nowhere.json"] })]);
    assert.deepEqual([r.counts.new, r.unresolved_refs], [1, 1]);
  });
});

describe("validation", () => {
  it("rejects a kind, severity or status that is not allowed, and writes nothing, even for the good items in the same request", () => {
    const p = proj(); audit(p);
    const list = problems(() => importObservations(p.id, [load(), sec({ id: "X-1", kind: "pentest" }), sec({ id: "X-2", severity: "urgent" }), sec({ id: "X-3", status: "done" })]));
    assert.equal(list.length, 3);
    assert.match(list.join("\n"), /X-1[^\n]*kind/);
    assert.match(list.join("\n"), /X-2[^\n]*severity/);
    assert.match(list.join("\n"), /X-3[^\n]*status/);
    assert.equal(count("SELECT COUNT(*) AS n FROM observations WHERE project_id = ?", p.id), 0);
  });

  it("rejects an auditId that is not an audit of this project, also one that belongs to another project", () => {
    const p = proj(); audit(p, "mine");
    const other = proj(); audit(other, "theirs");
    assert.match(problems(() => importObservations(p.id, [load({ auditId: "nope" })]))[0], /auditId "nope" is not an audit of this project/);
    assert.match(problems(() => importObservations(p.id, [load({ auditId: "theirs" })]))[0], /not an audit of this project/);
  });

  it("requires metric, value and threshold for a load test, and forbids them for a security review", () => {
    const p = proj(); audit(p);
    const a = problems(() => importObservations(p.id, [load({ metric: undefined, value: undefined, threshold: undefined })]));
    assert.equal(a.length, 3);
    const b = problems(() => importObservations(p.id, [sec({ metric: "p95_ms", value: 1, threshold: 2 })]));
    assert.equal(b.length, 3);
    assert.match(b[0], /only for a load_test/);
    assert.ok(problems(() => importObservations(p.id, [load({ value: "fast" })])).length > 0);
  });

  it("rejects an id that appears twice in one request, a field it does not know, an empty request and a body that is not a list", () => {
    const p = proj(); audit(p);
    assert.match(problems(() => importObservations(p.id, [load(), load()]))[0], /appears more than once/);
    assert.ok(problems(() => importObservations(p.id, [load({ colour: "red" })])).length > 0);
    assert.throws(() => importObservations(p.id, []), /no observations/);
    assert.throws(() => importObservations(p.id, { title: "x" }), /JSON array/);
    assert.throws(() => importObservations(p.id, { observations: [load()], extra: 1 }), /Unknown field/);
    assert.throws(() => importObservations(999999, [load()]), /Project not found/);
  });

  it("the id stays unique per project: the same id again is the same observation, not a second one", () => {
    const p = proj(); audit(p);
    importObservations(p.id, [load()]);
    importObservations(p.id, [load()]);
    assert.equal(count("SELECT COUNT(*) AS n FROM observations WHERE project_id = ?", p.id), 1);
  });
});

describe("evidence", () => {
  it("finds a file by path, checks the checksum, and tells a missing path from a damaged file", () => {
    const p = proj(); const a = audit(p);
    evidence(p, a, "a1", "evidence/ok.json", SHA);
    evidence(p, a, "a1", "evidence/broken.json", SHA, "missing");
    const r = importObservations(p.id, { observations: [load({ evidenceIds: ["EV-1", "EV-2", "EV-3", "EV-4"] })], evidence: [
      { id: "EV-1", path: "evidence/ok.json", sha256: SHA }, { id: "EV-2", path: "evidence/ok.json", sha256: SHA2 },
      { id: "EV-3", path: "evidence/broken.json", sha256: SHA }, { id: "EV-4", path: "evidence/never.json" },
    ] });
    // evidence/ok.json is counted once, and its last state wins: EV-2 names it with the wrong checksum
    assert.equal(r.unresolved_refs, 1);
    assert.equal(r.evidence.ok + r.evidence.problems, 2);
    const f = Object.fromEntries(listObservations(p.id).items[0].evidenceFiles.map((x) => [x.ref, x.state]));
    assert.deepEqual(f, { "EV-1": "ok", "EV-2": "problem", "EV-3": "problem", "EV-4": "unresolved" });
  });

  it("a label that is not in the list is taken as a path; evidence of another audit does not count", () => {
    const p = proj(); const a1 = audit(p, "a1"); const a2 = audit(p, "a2");
    evidence(p, a2, "a2", "evidence/only-in-a2.json");
    evidence(p, a1, "a1", "evidence/in-a1.json");
    const r = importObservations(p.id, [load({ evidenceIds: ["evidence/in-a1.json", "evidence/only-in-a2.json"] })]);
    assert.deepEqual([r.evidence.ok, r.unresolved_refs], [1, 1]);
  });

  it("looks again when an observation is sent again, so evidence that arrived later is found", () => {
    const p = proj(); const a = audit(p);
    importObservations(p.id, [load({ evidenceIds: ["evidence/late.json"] })]);
    assert.equal(listObservations(p.id).items[0].evidenceFiles[0].state, "unresolved");
    evidence(p, a, "a1", "evidence/late.json");
    const r = importObservations(p.id, [load({ evidenceIds: ["evidence/late.json"] })]);
    assert.equal(r.counts.unchanged, 1);
    assert.equal(listObservations(p.id).items[0].evidenceFiles[0].state, "ok");
  });
});

describe("sending an observation again", () => {
  it("unchanged content is unchanged; changed content that nobody judged is updated, status included", () => {
    const p = proj(); audit(p);
    importObservations(p.id, [load()]);
    assert.equal(importObservations(p.id, [load()]).counts.unchanged, 1);
    const r = importObservations(p.id, [load({ value: 610, status: "needs_review" })]);
    assert.deepEqual(r.counts, { new: 0, unchanged: 0, updated: 1, pending: 0 });
    const o = listObservations(p.id).items[0];
    assert.deepEqual([o.value, o.status, o.changedSinceReview], [610, "needs_review", false]);
  });

  it("keeps a status that a person set, updates the agent's fields, and shows the change as pending until a person looks again", () => {
    const p = proj(); audit(p);
    importObservations(p.id, [load()]);
    const id = listObservations(p.id).items[0].id;
    setObservationStatus(id, "confirmed");
    const r = importObservations(p.id, [load({ value: 990, recommendation: "Add a cache", status: "observed" })]);
    assert.deepEqual(r.counts, { new: 0, unchanged: 0, updated: 0, pending: 1 });
    const o = getObservation(id)!;
    assert.deepEqual([o.status, o.statusSetBy, o.value, o.recommendation, o.changedSinceReview], ["confirmed", "human", 990, "Add a cache", true]);
    // the same content again is unchanged and keeps the mark; a person setting the status clears it
    assert.equal(importObservations(p.id, [load({ value: 990, recommendation: "Add a cache", status: "observed" })]).counts.unchanged, 1);
    assert.equal(getObservation(id)!.changedSinceReview, true);
    setObservationStatus(id, "resolved");
    assert.deepEqual([getObservation(id)!.status, getObservation(id)!.changedSinceReview], ["resolved", false]);
  });

  it("a status is set through setObservationStatus, and only to an allowed one", () => {
    const p = proj(); audit(p);
    importObservations(p.id, [sec()]);
    const id = listObservations(p.id).items[0].id;
    assert.throws(() => setObservationStatus(id, "fixed"), /status must be one of/);
    assert.throws(() => setObservationStatus(999999, "resolved"), /not found/);
    assert.equal(setObservationStatus(id, "needs_review").status, "needs_review");
  });
});

describe("filters", () => {
  it("filters by kind, severity and status, counts the whole project for the chips, and rejects values that do not exist", () => {
    const p = proj(); audit(p);
    importObservations(p.id, [load(), load({ id: "LT-2", severity: "low" }), sec(), sec({ id: "SR-2", severity: "critical", status: "needs_review" })]);
    const ids = (f: Parameters<typeof listObservations>[1]) => listObservations(p.id, f).items.map((o) => o.sourceId).sort();
    assert.deepEqual(ids({ kind: "load_test" }), ["LT-1", "LT-2"]);
    assert.deepEqual(ids({ severity: "critical" }), ["SR-2"]);
    assert.deepEqual(ids({ status: "needs_review" }), ["SR-2"]);
    assert.deepEqual(ids({ kind: "security_review", status: "observed" }), ["SR-1"]);
    assert.deepEqual(ids({ q: "latency" }), ["LT-1", "LT-2"]);
    const all = listObservations(p.id, { kind: "load_test" });
    assert.equal(all.counts.total, 4);
    assert.deepEqual(all.counts.kind, { load_test: 2, security_review: 2 });
    assert.equal(all.counts.severity.critical, 1);
    assert.equal(listObservations(p.id).items[0].sourceId, "SR-2"); // most severe first
    assert.throws(() => listObservations(p.id, { kind: "pentest" }), /Unknown kind/);
    assert.throws(() => listObservations(p.id, { severity: "urgent" }), /Unknown severity/);
    assert.throws(() => listObservations(p.id, { status: "done" }), /Unknown status/);
  });
});

describe("turning an observation into a bug", () => {
  it("never happens by itself: importing observations makes no bug report", () => {
    const p = proj(); audit(p);
    const before = count("SELECT COUNT(*) AS n FROM bug_reports");
    importObservations(p.id, [load(), sec()]);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports"), before);
  });

  it("makes one proposed bug report when a person asks, remembers it, and leaves the observation and its status alone", () => {
    const p = proj(); const a = audit(p);
    evidence(p, a, "a1", "evidence/k6.json");
    importObservations(p.id, [load({ evidenceIds: ["evidence/k6.json"] })]);
    const o = listObservations(p.id).items[0];
    const bugsBefore = count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id);
    const { bugId } = convertToBug(o.id);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), bugsBefore + 1);
    const bug = db.prepare("SELECT * FROM bug_reports WHERE id = ?").get(bugId) as Record<string, any>;
    assert.deepEqual([bug.review_status, bug.source, bug.agent_severity, bug.audit_id, bug.source_id, bug.title], ["proposed", "manual", "high", a, "OBS-1", o.title]);
    assert.match(bug.description, /p95_ms = 840, threshold 500/);
    assert.match(bug.description, /Add an index on todos/);
    assert.match(bug.description, /evidence\/k6\.json/);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_revisions WHERE bug_report_id = ?", bugId), 1);
    const after = getObservation(o.id)!;
    assert.deepEqual([after.convertedBugId, after.status, after.statusSetBy], [bugId, "observed", "agent"]);
    assert.throws(() => convertToBug(o.id), /already been turned into a bug/);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), bugsBefore + 1);
  });

  it("an info observation has no bug severity, and a missing observation is a 404", () => {
    const p = proj(); audit(p);
    importObservations(p.id, [sec({ severity: "info" })]);
    const { bugId } = convertToBug(listObservations(p.id).items[0].id);
    assert.equal((db.prepare("SELECT agent_severity AS s FROM bug_reports WHERE id = ?").get(bugId) as { s: string | null }).s, null);
    assert.throws(() => convertToBug(999999), (e: unknown) => e instanceof ObservationError && e.status === 404);
  });
});

describe("an observation outlives its audit and goes with its project", () => {
  it("keeps the observation, and links it to the audit again when the audit comes back", () => {
    const p = proj(); const a = audit(p);
    importObservations(p.id, [load()]);
    db.prepare("DELETE FROM audits WHERE id = ?").run(a);
    const o = listObservations(p.id).items[0];
    assert.deepEqual([o.auditId, o.agentAuditId], [null, "a1"]);
    const back = audit(p);
    importObservations(p.id, [load()]);
    assert.equal(listObservations(p.id).items[0].auditId, back);
  });

  it("is deleted with the project", () => {
    const p = proj(); audit(p);
    importObservations(p.id, [load()]);
    db.prepare("DELETE FROM projects WHERE id = ?").run(p.id);
    assert.equal(count("SELECT COUNT(*) AS n FROM observations WHERE project_id = ?", p.id), 0);
  });
});

describe("the observation routes", () => {
  const ROOT = join(import.meta.dirname, "..");
  const PORT = 45000 + Math.floor(Math.random() * 2000);
  const BASE = `http://127.0.0.1:${PORT}`;
  const DATA = mkdtempSync(join(tmpdir(), "tb-observations-http-"));
  let server: ChildProcess;
  let output = "";
  let projectId = 0;
  const call = (path: string, method: string, body?: unknown, headers: Record<string, string> = { "X-Testbench": "1" }) =>
    fetch(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

  before(async () => {
    // A server of its own, on this machine only, with an empty data folder and no password: nothing of a real installation is reached.
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
    const res = await call("/api/projects", "POST", { name: "Obs HTTP", key: "OBH" });
    assert.equal(res.status, 200, output);
    projectId = ((await res.json()) as { id: number }).id;
    const side = new Database(join(DATA, "testbench.db")); // the audit an import would have made
    side.prepare("INSERT INTO audits (project_id, agent_audit_id, title, source) VALUES (?, 'a1', 'Audit', 'upload')").run(projectId);
    side.close();
  });
  after(() => server?.kill());

  it("?dryRun=1 answers with the counts, the evidence and unresolved_refs, and keeps nothing", async () => {
    const res = await call(`/api/projects/${projectId}/observations?dryRun=1`, "POST", [load({ evidenceIds: ["evidence/none.json"] }), sec()]);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.dryRun, true);
    assert.deepEqual(body.counts, { new: 2, unchanged: 0, updated: 0, pending: 0 });
    assert.deepEqual(body.evidence, { ok: 0, problems: 0 });
    assert.equal(body.unresolved_refs, 1);
    const list = (await (await call(`/api/projects/${projectId}/observations`, "GET")).json()) as { items: unknown[] };
    assert.equal(list.items.length, 0);
  });

  it("imports for real, lists with filters, changes a status, and turns one into a bug on request", async () => {
    const res = await call(`/api/projects/${projectId}/observations`, "POST", [load(), sec()]);
    assert.equal(res.status, 200, output);
    assert.deepEqual(((await res.json()) as { counts: unknown }).counts, { new: 2, unchanged: 0, updated: 0, pending: 0 });
    const list = (await (await call(`/api/projects/${projectId}/observations?kind=load_test&severity=high`, "GET")).json()) as { items: { id: number; label: string }[] };
    assert.deepEqual(list.items.map((o) => o.label), ["OBS-1"]);
    const patched = await call(`/api/observations/${list.items[0].id}`, "PATCH", { status: "confirmed" });
    assert.equal(((await patched.json()) as { status: string }).status, "confirmed");
    assert.equal((await call(`/api/observations/${list.items[0].id}`, "PATCH", { status: "nope" })).status, 400);
    const conv = await call(`/api/observations/${list.items[0].id}/convert-to-bug`, "POST", {});
    assert.equal(conv.status, 200, output);
    assert.equal((await call(`/api/observations/${list.items[0].id}/convert-to-bug`, "POST", {})).status, 409);
    assert.equal((await call(`/api/projects/${projectId}/observations?kind=pentest`, "GET")).status, 400);
  });

  it("answers 400 with the list of problems for a bad request, and 403 without the X-Testbench header", async () => {
    const bad = await call(`/api/projects/${projectId}/observations`, "POST", [load({ id: "BAD-1", severity: "urgent" }), load({ id: "BAD-2", auditId: "ghost" })]);
    const body = (await bad.json()) as { error: string; problems: string[] };
    assert.equal(bad.status, 400);
    assert.ok(body.problems.length >= 2, JSON.stringify(body));
    assert.equal((await call(`/api/projects/${projectId}/observations`, "POST", [load()], {})).status, 403);
  });
});
