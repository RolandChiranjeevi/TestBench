import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db } from "../server/db.ts";
import { AuditError } from "../server/auditcommon.ts";
import { cancelRequest, claimRequest, cleanTargetUrl, completeRequest, createRequest, listRequests, pendingForAgent, REQUEST_LIMITS } from "../server/agentrequests.ts";
import { makeProject } from "./helpers.ts";

// What a person can ask of a test agent, and what the agent can do with it (server/agentrequests.ts). Testbench starts nothing; these are rows and their states.

const me = { name: "Tess Tester", userId: null };
const key = () => `R${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const refused = (fn: () => unknown, status: number, text: RegExp) => assert.throws(fn, (e: unknown) => e instanceof AuditError && e.status === status && text.test(e.message), `${status} ${text}`);
const token = (id = 1, name = "qa-agent") => ({ id, name });

/** An automated run with the given results (status per test name). */
function automatedRun(projectId: number, results: Record<string, string>, environment = "staging") {
  const run = db.prepare("INSERT INTO runs (project_id, title, kind, source, environment) VALUES (?, 'CI', 'automated', 'upload', ?) RETURNING id").get(projectId, environment) as { id: number };
  for (const [name, status] of Object.entries(results)) {
    const t = db.prepare("INSERT INTO automated_tests (project_id, framework, file, title, full_name) VALUES (?, 'playwright', 'a.spec.ts', ?, ?) RETURNING id").get(projectId, name, `a.spec.ts > ${name}`) as { id: number };
    db.prepare("INSERT INTO results (run_id, automated_test_id, status) VALUES (?, ?, ?)").run(run.id, t.id, status);
  }
  return run.id;
}

describe("the address of a discover request", () => {
  it("takes an http or https address and writes it in one normal form", () => {
    assert.equal(cleanTargetUrl("  https://staging.example.com  "), "https://staging.example.com/");
    assert.equal(cleanTargetUrl("http://localhost:3000/app?lang=sv"), "http://localhost:3000/app?lang=sv");
  });

  it("refuses what is not a web address, one with a password in it, and a query that looks like a secret", () => {
    refused(() => cleanTargetUrl(""), 400, /needs the address/);
    refused(() => cleanTargetUrl(undefined), 400, /needs the address/);
    refused(() => cleanTargetUrl("not a url"), 400, /not a web address/);
    refused(() => cleanTargetUrl("ftp://example.com"), 400, /http:\/\/ or https:\/\//);
    refused(() => cleanTargetUrl("https://user:pw@example.com"), 400, /user name or password/);
    refused(() => cleanTargetUrl("https://user@example.com"), 400, /user name or password/);
    refused(() => cleanTargetUrl("https://example.com/?api_key=abc"), 400, /looks like a secret/);
    refused(() => cleanTargetUrl("https://example.com/?access_token=abc"), 400, /looks like a secret/);
    refused(() => cleanTargetUrl(`https://example.com/${"a".repeat(REQUEST_LIMITS.urlMax)}`), 400, /at most/);
  });
});

describe("making a request", () => {
  it("a discover request keeps the address, environment and note, and starts pending", () => {
    const p = makeProject(key());
    const r = createRequest(p.id, { kind: "discover", targetUrl: "https://staging.example.com", environment: " staging ", note: "  the checkout is new  " }, me);
    assert.deepEqual([r.kind, r.targetUrl, r.environment, r.note, r.status, r.createdBy, r.runId, r.tests], ["discover", "https://staging.example.com/", "staging", "the checkout is new", "pending", "Tess Tester", null, []]);
    assert.equal(r.claimedBy, null);
    assert.equal(r.finishedAt, null);
  });

  it("refuses an unknown kind, a project that is not there, text that is too long and values that are not text", () => {
    const p = makeProject(key());
    refused(() => createRequest(p.id, { kind: "run-everything" }, me), 400, /kind must be/);
    refused(() => createRequest(999999, { kind: "discover", targetUrl: "https://a.example" }, me), 404, /Project not found/);
    refused(() => createRequest(p.id, { kind: "discover", targetUrl: "https://a.example", note: "x".repeat(REQUEST_LIMITS.noteMax + 1) }, me), 400, /note can be at most/);
    refused(() => createRequest(p.id, { kind: "discover", targetUrl: "https://a.example", environment: 7 }, me), 400, /must be text/);
    refused(() => createRequest(p.id, { kind: "discover" }, me), 400, /needs the address/);
    assert.equal(listRequests(p.id).length, 0, "nothing was made");
  });

  it("at most 20 can wait; taking one frees a place", () => {
    const p = makeProject(key());
    for (let i = 0; i < REQUEST_LIMITS.pendingPerProject; i++) createRequest(p.id, { kind: "discover", targetUrl: `https://a${i}.example.com` }, me);
    refused(() => createRequest(p.id, { kind: "discover", targetUrl: "https://one-too-many.example.com" }, me), 409, /At most 20/);
    const first = pendingForAgent(p.id)[0];
    claimRequest(p.id, first.id, token());
    assert.doesNotThrow(() => createRequest(p.id, { kind: "discover", targetUrl: "https://now-there-is-room.example.com" }, me));
    const other = makeProject(key());
    assert.doesNotThrow(() => createRequest(other.id, { kind: "discover", targetUrl: "https://other-project.example.com" }, me), "another project has its own places");
  });
});

describe("a re-run request", () => {
  it("lists the failed and blocked automated tests of the run as they were, and takes the environment of the run", () => {
    const p = makeProject(key());
    const run = automatedRun(p.id, { "logs in": "failed", "logs out": "passed", "pays": "blocked", "searches": "skipped" }, "ci");
    const r = createRequest(p.id, { kind: "rerun", runId: run }, me);
    assert.deepEqual(r.tests.map((t) => t.title), ["logs in", "pays"]);
    assert.deepEqual([r.runId, r.environment, r.targetUrl, r.kind], [run, "ci", "", "rerun"]);
    assert.ok(r.tests.every((t) => t.framework === "playwright" && t.file === "a.spec.ts" && t.fullName.startsWith("a.spec.ts > ")));
    assert.equal(createRequest(p.id, { kind: "rerun", runId: run, environment: "prod-like" }, me).environment, "prod-like", "what is written wins over the run's");
  });

  it("is kept as it was asked for, even if the run changes or goes", () => {
    const p = makeProject(key());
    const run = automatedRun(p.id, { a: "failed", b: "failed" });
    const r = createRequest(p.id, { kind: "rerun", runId: run }, me);
    db.prepare("UPDATE results SET status = 'passed' WHERE run_id = ?").run(run);
    db.prepare("DELETE FROM runs WHERE id = ?").run(run);
    const now = listRequests(p.id)[0];
    assert.equal(now.id, r.id);
    assert.equal(now.runId, null, "the link to the run goes");
    assert.equal(now.tests.length, 2, "the tests that were asked for stay");
  });

  it("is refused for a run that is not automated, has nothing failed, is in another project, is not there, or has too many failures", () => {
    const p = makeProject(key());
    const other = makeProject(key());
    const manual = (db.prepare("INSERT INTO runs (project_id, title, kind, source) VALUES (?, 'M', 'manual', 'manual') RETURNING id").get(p.id) as { id: number }).id;
    refused(() => createRequest(p.id, { kind: "rerun", runId: manual }, me), 400, /Only an automated run/);
    refused(() => createRequest(p.id, { kind: "rerun", runId: automatedRun(p.id, { a: "passed", b: "skipped" }) }, me), 409, /no failed or blocked/);
    refused(() => createRequest(p.id, { kind: "rerun", runId: automatedRun(other.id, { a: "failed" }) }, me), 404, /Run not found/);
    refused(() => createRequest(p.id, { kind: "rerun", runId: 999999 }, me), 404, /Run not found/);
    refused(() => createRequest(p.id, { kind: "rerun" }, me), 400, /needs the run/);
    refused(() => createRequest(p.id, { kind: "rerun", runId: "7" }, me), 400, /needs the run/);
    const many: Record<string, string> = {};
    for (let i = 0; i <= REQUEST_LIMITS.rerunTestsMax; i++) many[`t${i}`] = "failed";
    refused(() => createRequest(p.id, { kind: "rerun", runId: automatedRun(p.id, many) }, me), 400, /More than 500/);
    assert.equal(listRequests(p.id).length, 0, "none of them made a request");
  });
});

describe("what happens to a request", () => {
  const fresh = () => {
    const p = makeProject(key());
    return { p, r: createRequest(p.id, { kind: "discover", targetUrl: "https://staging.example.com" }, me) };
  };

  it("pending, then taken by one agent, then done with a note and the run that came in", () => {
    const { p, r } = fresh();
    const taken = claimRequest(p.id, r.id, token(1, "qa-agent"));
    assert.deepEqual([taken.status, taken.claimedBy], ["claimed", "agent: qa-agent"]);
    assert.ok(taken.claimedAt);
    const run = automatedRun(p.id, { a: "passed" });
    const done = completeRequest(p.id, r.id, token(1, "qa-agent"), { note: "  3 pages looked at  ", resultRunId: run });
    assert.deepEqual([done.status, done.resultNote, done.resultRunId], ["done", "3 pages looked at", run]);
    assert.ok(done.finishedAt);
  });

  it("only one agent can take a request, and a second try is told it is not waiting any more", () => {
    const { p, r } = fresh();
    claimRequest(p.id, r.id, token(1));
    refused(() => claimRequest(p.id, r.id, token(2, "other")), 409, /not waiting any more/);
    assert.equal(listRequests(p.id)[0].claimedBy, "agent: qa-agent", "the first one still holds it");
  });

  it("a request in another project, or one that is not there, is 404 for an agent", () => {
    const { r } = fresh();
    const other = makeProject(key());
    refused(() => claimRequest(other.id, r.id, token()), 404, /not found/);
    refused(() => claimRequest(other.id, 999999, token()), 404, /not found/);
    refused(() => completeRequest(other.id, r.id, token(), {}), 404, /not found/);
  });

  it("can only be finished after it was taken, and only by the token that took it", () => {
    const { p, r } = fresh();
    refused(() => completeRequest(p.id, r.id, token(), {}), 409, /Take the request first/);
    claimRequest(p.id, r.id, token(1));
    refused(() => completeRequest(p.id, r.id, token(2, "other"), {}), 409, /Another token/);
    assert.equal(completeRequest(p.id, r.id, token(1), {}).status, "done");
    refused(() => completeRequest(p.id, r.id, token(1), {}), 409, /already done/);
  });

  it("checks the note and the run it is finished with", () => {
    const { p, r } = fresh();
    claimRequest(p.id, r.id, token());
    refused(() => completeRequest(p.id, r.id, token(), { note: 5 }), 400, /must be text/);
    refused(() => completeRequest(p.id, r.id, token(), { note: "x".repeat(REQUEST_LIMITS.resultNoteMax + 1) }), 400, /at most/);
    refused(() => completeRequest(p.id, r.id, token(), { resultRunId: 1.5 }), 400, /whole number/);
    refused(() => completeRequest(p.id, r.id, token(), { resultRunId: automatedRun(makeProject(key()).id, { a: "passed" }) }), 400, /not a run in this project/);
    assert.equal(listRequests(p.id)[0].status, "claimed", "none of that finished it");
  });

  it("a person can withdraw a request that is pending or taken, and nothing leaves done or cancelled", () => {
    const a = fresh();
    assert.equal(cancelRequest(a.r.id).status, "cancelled");
    refused(() => claimRequest(a.p.id, a.r.id, token()), 409, /not waiting any more/);
    refused(() => cancelRequest(a.r.id), 409, /already done or cancelled/);

    const b = fresh();
    claimRequest(b.p.id, b.r.id, token());
    assert.equal(cancelRequest(b.r.id).status, "cancelled");
    refused(() => completeRequest(b.p.id, b.r.id, token(), {}), 409, /already done or cancelled/);

    const c = fresh();
    claimRequest(c.p.id, c.r.id, token());
    completeRequest(c.p.id, c.r.id, token(), {});
    refused(() => cancelRequest(c.r.id), 409, /already done or cancelled/);
    refused(() => cancelRequest(999999), 404, /not found/);
  });
});

describe("listing", () => {
  it("shows the newest first, can keep one status, and refuses a status that does not exist", () => {
    const p = makeProject(key());
    const first = createRequest(p.id, { kind: "discover", targetUrl: "https://one.example.com" }, me);
    const second = createRequest(p.id, { kind: "discover", targetUrl: "https://two.example.com" }, me);
    claimRequest(p.id, first.id, token());
    assert.deepEqual(listRequests(p.id).map((r) => r.id), [second.id, first.id]);
    assert.deepEqual(listRequests(p.id, "claimed").map((r) => r.id), [first.id]);
    assert.deepEqual(listRequests(p.id, "done"), []);
    refused(() => listRequests(p.id, "finished"), 400, /status must be one of/);
  });

  it("gives an agent only the waiting ones, oldest first, and only of that project", () => {
    const p = makeProject(key());
    const other = makeProject(key());
    const one = createRequest(p.id, { kind: "discover", targetUrl: "https://one.example.com" }, me);
    const two = createRequest(p.id, { kind: "discover", targetUrl: "https://two.example.com" }, me);
    const three = createRequest(p.id, { kind: "discover", targetUrl: "https://three.example.com" }, me);
    createRequest(other.id, { kind: "discover", targetUrl: "https://elsewhere.example.com" }, me);
    claimRequest(p.id, two.id, token());
    cancelRequest(three.id);
    assert.deepEqual(pendingForAgent(p.id).map((r) => r.id), [one.id]);
  });
});

describe("when the project goes", () => {
  it("its requests and request tokens go with it", () => {
    const p = makeProject(key());
    createRequest(p.id, { kind: "discover", targetUrl: "https://staging.example.com" }, me);
    db.prepare("INSERT INTO request_tokens (project_id, name, prefix, token_hash) VALUES (?, 't', 'tbrq_xxxx', ?)").run(p.id, `h-${p.id}`);
    db.prepare("DELETE FROM projects WHERE id = ?").run(p.id);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM agent_requests WHERE project_id = ?").get(p.id) as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM request_tokens WHERE project_id = ?").get(p.id) as { n: number }).n, 0);
  });
});
