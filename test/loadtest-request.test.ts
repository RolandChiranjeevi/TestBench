import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { db, migrate } from "../server/db.ts";
import { AuditError } from "../server/auditcommon.ts";
import { claimRequest, completeRequest, createRequest, getLoadResult, listRequests, pendingForAgent, releaseRequest, submitLoadResult } from "../server/agentrequests.ts";
import { cleanLoadOptions, cleanLoadResult, DEFAULT_LOAD_OPTIONS, isLocalHost, LOAD_LIMITS } from "../server/loadtest.ts";
import { makeProject } from "./helpers.ts";

// A load test as a request (kind loadtest): the parameters and their ceilings, who may ask, where, and the result the agent hands in (server/loadtest.ts, server/agentrequests.ts).

const admin = { name: "Ada Admin", userId: null, mayWiden: true };
const tester = { name: "Tess Tester", userId: null, mayWiden: false };
const key = () => `L${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const token = (id = 1, name = "qa-agent") => ({ id, name });
const refused = (fn: () => unknown, status: number, text: RegExp) => assert.throws(fn, (e: unknown) => e instanceof AuditError && e.status === status && text.test(e.message), `${status} ${text}`);
const ask = (projectId: number, loadOptions?: unknown, targetUrl = "http://localhost:3000") => createRequest(projectId, { kind: "loadtest", targetUrl, loadOptions }, admin);

const totals = { requests: 1200, errors: 3, errorRate: 0.25, rps: 20, p50Ms: 40, p95Ms: 120, p99Ms: 200, maxMs: 350 };
const result = (over: Record<string, unknown> = {}) => ({
  version: 1, outcome: "completed", startedAt: "2026-11-21T10:00:00Z", endedAt: "2026-11-21T10:01:00Z",
  params: { vus: 10, durationSeconds: 60, rampUpSeconds: 10, paths: ["/"] },
  totals, paths: [{ path: "/", ...totals, statuses: { "200": 1197, "503": 3 } }],
  timeline: [{ t: 0, vus: 1, requests: 10, errors: 0, p95Ms: 80 }, { t: 5, vus: 10, requests: 100, errors: 3, p95Ms: 120 }],
  verdict: "pass", verdictReason: "Error rate 0.25 %, p95 120 ms", ...over,
});

describe("the parameters of a load test", () => {
  it("start from the defaults and keep what was chosen, each path once", () => {
    assert.deepEqual(cleanLoadOptions(undefined), DEFAULT_LOAD_OPTIONS);
    const o = cleanLoadOptions({ vus: 50, durationSeconds: 120, rampUpSeconds: 30, paths: ["/", "/api/health", "/"], maxErrorRatePercent: 1, maxP95Ms: 2000 });
    assert.deepEqual(o, { vus: 50, durationSeconds: 120, rampUpSeconds: 30, paths: ["/", "/api/health"], maxErrorRatePercent: 1, maxP95Ms: 2000 });
  });

  it("refuse what is above the ceilings or not one of the choices", () => {
    refused(() => cleanLoadOptions({ vus: 100 }), 400, /vus must be one of 5, 10, 25, 50/);
    refused(() => cleanLoadOptions({ durationSeconds: 600 }), 400, /durationSeconds must be one of/);
    refused(() => cleanLoadOptions({ maxErrorRatePercent: 50 }), 400, /maxErrorRatePercent must be one of/);
    refused(() => cleanLoadOptions({ maxP95Ms: 10 }), 400, /maxP95Ms must be one of/);
    refused(() => cleanLoadOptions({ durationSeconds: 30, rampUpSeconds: 30 }), 400, /at most half/);
    refused(() => cleanLoadOptions({ method: "POST" }), 400, /Unknown load option "method"/);
    refused(() => cleanLoadOptions([]), 400, /must be an object/);
  });

  it("take only plain paths: one slash, no spaces, no secret in the query, at most ten", () => {
    for (const bad of ["x", "//evil.example.com/", "/a b", "/a#frag", "/a\\b", "/?api_key=abc", `/${"a".repeat(LOAD_LIMITS.pathMax)}`, 7]) refused(() => cleanLoadOptions({ paths: [bad] }), 400, /path|Every path/);
    refused(() => cleanLoadOptions({ paths: [] }), 400, /1 to 10 paths/);
    refused(() => cleanLoadOptions({ paths: Array.from({ length: 11 }, (_, i) => `/p${i}`) }), 400, /1 to 10 paths/);
    assert.deepEqual(cleanLoadOptions({ paths: ["/search?q=shoes"] }).paths, ["/search?q=shoes"]);
  });
});

describe("where a load test may be asked for", () => {
  it("only a local or private address", () => {
    for (const h of ["localhost", "app.localhost", "build.local", "127.0.0.1", "127.9.9.9", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.20", "[::1]"]) assert.equal(isLocalHost(h), true, h);
    for (const h of ["example.com", "staging.example.com", "8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.0.1", "11.0.0.1", "[::ffff:808:808]", "localhost.example.com"]) assert.equal(isLocalHost(h), false, h);
  });

  it("is refused for a public address, and for anyone who is not an admin of the project", () => {
    const p = makeProject(key());
    refused(() => ask(p.id, undefined, "https://staging.example.com"), 400, /local or private/);
    refused(() => createRequest(p.id, { kind: "loadtest", targetUrl: "http://localhost:3000" }, tester), 403, /Only an admin/);
    refused(() => createRequest(p.id, { kind: "loadtest" }, admin), 400, /needs the address/);
    refused(() => createRequest(p.id, { kind: "discover", targetUrl: "http://localhost:3000", loadOptions: {} }, admin), 400, /only for a loadtest/);
  });

  it("keeps the parameters on the request, in the list and in the claim, and the list never carries a result", () => {
    const p = makeProject(key());
    const r = ask(p.id, { vus: 25, paths: ["/", "/api/ping"] });
    assert.equal(r.kind, "loadtest");
    assert.equal(r.loadOptions?.vus, 25);
    assert.equal(r.options, null);
    assert.deepEqual(listRequests(p.id)[0].loadOptions?.paths, ["/", "/api/ping"]);
    assert.deepEqual(pendingForAgent(p.id)[0].loadOptions?.paths, ["/", "/api/ping"]);
    assert.deepEqual(claimRequest(p.id, r.id, token()).loadOptions?.paths, ["/", "/api/ping"]);
    assert.equal(JSON.stringify(listRequests(p.id)).includes("verdictReason"), false);
  });
});

describe("the result of a load test", () => {
  const claimed = (loadOptions?: unknown) => {
    const p = makeProject(key());
    const r = ask(p.id, loadOptions);
    claimRequest(p.id, r.id, token());
    return { p, r };
  };

  it("is kept once, rebuilt from the known fields, and shown to a person with the request", () => {
    const { p, r } = claimed();
    assert.deepEqual(submitLoadResult(p.id, r.id, token(), result()), { verdict: "pass", outcome: "completed" });
    const got = getLoadResult(r.id);
    assert.equal(got.result.totals.p95Ms, 120);
    assert.deepEqual(got.result.paths[0].statuses, { "200": 1197, "503": 3 });
    assert.equal(got.request.id, r.id);
    assert.ok(got.deliveredAt);
    refused(() => submitLoadResult(p.id, r.id, token(), result()), 409, /already handed in/);
  });

  it("is refused for another token, for a request that is not taken, and for another kind", () => {
    const { p, r } = claimed();
    refused(() => submitLoadResult(p.id, r.id, token(2, "other"), result()), 409, /Another token/);
    const waiting = ask(p.id);
    refused(() => submitLoadResult(p.id, waiting.id, token(), result()), 409, /Take the request first/);
    const d = createRequest(p.id, { kind: "discover", targetUrl: "http://localhost:3000" }, admin);
    refused(() => submitLoadResult(p.id, d.id, token(), result()), 400, /Only a load test/);
    refused(() => getLoadResult(waiting.id), 404, /no result yet/);
  });

  it("can never claim more than was asked: more users, a longer test or another path is refused, and nothing is kept", () => {
    const { p, r } = claimed({ vus: 10, durationSeconds: 60, paths: ["/"] });
    refused(() => submitLoadResult(p.id, r.id, token(), result({ params: { vus: 50, durationSeconds: 60, rampUpSeconds: 10, paths: ["/"] } })), 400, /params.vus/);
    refused(() => submitLoadResult(p.id, r.id, token(), result({ params: { vus: 10, durationSeconds: 120, rampUpSeconds: 10, paths: ["/"] } })), 400, /params.durationSeconds/);
    refused(() => submitLoadResult(p.id, r.id, token(), result({ params: { vus: 10, durationSeconds: 60, rampUpSeconds: 10, paths: ["/admin"] } })), 400, /did not ask for/);
    refused(() => submitLoadResult(p.id, r.id, token(), result({ paths: [{ path: "/admin", ...totals, statuses: {} }] })), 400, /not a path the request asked for/);
    refused(() => submitLoadResult(p.id, r.id, token(), result({ timeline: [{ t: 0, vus: 11, requests: 1, errors: 0, p95Ms: 1 }] })), 400, /timeline\[0\].vus/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM agent_load_results WHERE request_id = ?").get(r.id) as { n: number }).n, 0);
    assert.equal(submitLoadResult(p.id, r.id, token(), result()).verdict, "pass", "a correct result is still taken after the refused ones");
  });

  it("is checked field by field: unknown or missing fields, impossible numbers, a bad verdict and a long reason", () => {
    const asked = cleanLoadOptions(undefined);
    assert.throws(() => cleanLoadResult({ ...result(), extra: 1 }, asked), /unknown field "extra"/);
    assert.throws(() => cleanLoadResult({ ...result(), totals: { ...totals, errors: 5000 } }, asked), /totals.errors/);
    assert.throws(() => cleanLoadResult({ ...result(), totals: { ...totals, errorRate: 120 } }, asked), /totals.errorRate/);
    assert.throws(() => cleanLoadResult({ ...result(), totals: { ...totals, p95Ms: Number.NaN } }, asked), /totals.p95Ms/);
    assert.throws(() => cleanLoadResult({ ...result(), verdict: "great" }, asked), /verdict must be one of/);
    assert.throws(() => cleanLoadResult({ ...result(), outcome: "crashed" }, asked), /outcome must be one of/);
    assert.throws(() => cleanLoadResult({ ...result(), verdictReason: "a\nb" }, asked), /one line/);
    assert.throws(() => cleanLoadResult({ ...result(), verdictReason: "x".repeat(301) }, asked), /at most 300/);
    assert.throws(() => cleanLoadResult({ ...result(), startedAt: "yesterday" }, asked), /startedAt/);
    assert.throws(() => cleanLoadResult({ ...result(), paths: [{ path: "/", ...totals, statuses: { "<b>": 1 } }] }, asked), /not a status code/);
    assert.throws(() => cleanLoadResult({ ...result(), timeline: Array.from({ length: LOAD_LIMITS.timelineMax + 1 }, () => ({ t: 0, vus: 1, requests: 1, errors: 0, p95Ms: 1 })) }, asked), /at most 300/);
    const { version: _v, ...noVersion } = result();
    assert.throws(() => cleanLoadResult(noVersion, asked), /missing "version"/);
  });

  it("must be handed in before the request can be finished, and a request with a result cannot be given back", () => {
    const { p, r } = claimed();
    refused(() => completeRequest(p.id, r.id, token(), { note: "done" }), 409, /Hand in the result/);
    submitLoadResult(p.id, r.id, token(), result());
    refused(() => releaseRequest(p.id, r.id, token(), { note: "no" }), 409, /already handed in/);
    assert.equal(completeRequest(p.id, r.id, token(), { note: "p95 120 ms" }).status, "done");
  });
});

describe("the table of requests after the load test kind was added", () => {
  const OLD_KINDS = "'discover', 'rerun', 'run'";

  /** A database as it was before: the same table, but with a CHECK that refuses `loadtest`. */
  function oldDatabase() {
    const d = new Database(":memory:");
    migrate(d);
    const ddl = d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_requests'").pluck().get() as string;
    d.pragma("foreign_keys = OFF");
    d.exec(ddl.replace(/^CREATE TABLE\s+"?agent_requests"?/i, "CREATE TABLE agent_requests_old").replace(", 'loadtest'", ""));
    d.exec("DROP TABLE agent_requests; ALTER TABLE agent_requests_old RENAME TO agent_requests; CREATE INDEX agent_requests_project ON agent_requests(project_id, status)");
    d.pragma("foreign_keys = ON");
    return d;
  }

  it("is rebuilt without losing a row, a column that was added later, or the link from a test case", () => {
    const d = oldDatabase();
    assert.ok((d.prepare("SELECT sql FROM sqlite_master WHERE name = 'agent_requests'").pluck().get() as string).includes(OLD_KINDS + ")"));
    assert.throws(() => d.prepare("INSERT INTO agent_requests (project_id, kind) VALUES (1, 'loadtest')").run());
    const proj = d.prepare("INSERT INTO projects (name, key) VALUES ('Old', 'OLD') RETURNING id").pluck().get() as number;
    const req = d.prepare("INSERT INTO agent_requests (project_id, kind, target_url, name, priority, payload, findings_count) VALUES (?, 'discover', 'https://a.example/', 'Login', 3, '{\"tests\":[]}', 4) RETURNING id").pluck().get(proj) as number;
    d.prepare("INSERT INTO cases (project_id, number, title, status, tags, position, agent_request_id) VALUES (?, 1, 'from the agent', 'ready', '[]', 1, ?)").run(proj, req);

    migrate(d);

    const row = d.prepare("SELECT kind, target_url, name, priority, payload, findings_count FROM agent_requests WHERE id = ?").get(req);
    assert.deepEqual(row, { kind: "discover", target_url: "https://a.example/", name: "Login", priority: 3, payload: '{"tests":[]}', findings_count: 4 });
    assert.equal(d.prepare("SELECT agent_request_id FROM cases WHERE project_id = ?").pluck().get(proj), req, "the link from the test case survives");
    assert.ok(d.prepare("INSERT INTO agent_requests (project_id, kind) VALUES (?, 'loadtest') RETURNING id").pluck().get(proj), "the new kind is accepted");
    assert.ok(d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'agent_requests_project'").get(), "the index is back");
    assert.equal(d.pragma("foreign_keys", { simple: true }), 1, "foreign keys are on again");
    assert.deepEqual(d.pragma("foreign_key_check"), []);
    d.prepare("INSERT INTO agent_load_results (request_id, project_id, result) VALUES (?, ?, '{}')").run(req, proj);
    d.prepare("DELETE FROM agent_requests WHERE id = ?").run(req);
    assert.equal(d.prepare("SELECT COUNT(*) FROM agent_load_results").pluck().get(), 0, "a result goes with its request");
  });

  it("is left alone when it already allows the kind, and running the migration again changes nothing", () => {
    const d = new Database(":memory:");
    migrate(d);
    const before = d.prepare("SELECT sql FROM sqlite_master WHERE name = 'agent_requests'").pluck().get();
    migrate(d);
    assert.equal(d.prepare("SELECT sql FROM sqlite_master WHERE name = 'agent_requests'").pluck().get(), before);
  });
});
