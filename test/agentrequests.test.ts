import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db } from "../server/db.ts";
import { AuditError } from "../server/auditcommon.ts";
import { cancelRequest, claimRequest, cleanTargetUrl, completeRequest, createRequest, DEFAULT_REQUEST_OPTIONS, listRequests, optionsNeedAdmin, pendingForAgent, releaseRequest, REQUEST_LIMITS, runNextRequest } from "../server/agentrequests.ts";
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
  it("a discover without an environment is made, with an empty one: the dialog says production with a button and sends no environment", () => {
    const p = makeProject(key());
    const r = createRequest(p.id, { kind: "discover", targetUrl: "https://staging.example.com", options: { production: true } }, me);
    assert.deepEqual([r.kind, r.environment, r.status, r.options?.production], ["discover", "", "pending", true]);
  });

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

describe("giving a request back (release)", () => {
  const taken = (kind: "discover" | "rerun" = "discover", tok = token(1)) => {
    const p = makeProject(key());
    const r = kind === "discover" ? createRequest(p.id, { kind, targetUrl: "https://staging.example.com" }, me) : createRequest(p.id, { kind, runId: automatedRun(p.id, { a: "failed" }) }, me);
    claimRequest(p.id, r.id, tok);
    return { p, r };
  };

  it("makes it wait again, with the note, who gave it back and when, and nothing of who took it", () => {
    const { p, r } = taken();
    const back = releaseRequest(p.id, r.id, token(1, "qa-agent"), { note: "  the target asked for a login I do not have  " });
    assert.deepEqual([back.status, back.releaseNote, back.releasedBy, back.claimedBy, back.claimedAt], ["pending", "the target asked for a login I do not have", "agent: qa-agent", null, null]);
    assert.ok(back.releasedAt);
    assert.deepEqual(pendingForAgent(p.id).map((x) => x.id), [r.id], "it is in the waiting list again");
  });

  it("another agent can take it, and only that agent can give it back or finish it", () => {
    const { p, r } = taken("discover", token(1));
    releaseRequest(p.id, r.id, token(1), {});
    assert.equal(claimRequest(p.id, r.id, token(2, "other")).claimedBy, "agent: other");
    refused(() => releaseRequest(p.id, r.id, token(1), {}), 409, /Another token/);
    refused(() => completeRequest(p.id, r.id, token(1), {}), 409, /Another token/);
    assert.equal(completeRequest(p.id, r.id, token(2), {}).status, "done");
  });

  it("is refused for a request that is not taken, is done or cancelled, is taken by another token, or in another project", () => {
    const { p, r } = taken("discover", token(1));
    refused(() => releaseRequest(p.id, r.id, token(2, "other"), {}), 409, /Another token/);
    refused(() => releaseRequest(makeProject(key()).id, r.id, token(1), {}), 404, /not found/);
    releaseRequest(p.id, r.id, token(1), {});
    refused(() => releaseRequest(p.id, r.id, token(1), {}), 409, /not taken/);
    claimRequest(p.id, r.id, token(1));
    completeRequest(p.id, r.id, token(1), {});
    refused(() => releaseRequest(p.id, r.id, token(1), {}), 409, /already done or cancelled/);
    const c = taken();
    cancelRequest(c.r.id);
    refused(() => releaseRequest(c.p.id, c.r.id, token(1), {}), 409, /already done or cancelled/);
  });

  it("is refused once a report was handed in, because a re-run that has its result is finished, not repeated", () => {
    const { p, r } = taken("rerun");
    db.prepare("UPDATE agent_requests SET result_delivered_at = datetime('now') WHERE id = ?").run(r.id);
    refused(() => releaseRequest(p.id, r.id, token(1), {}), 409, /already handed in/);
    assert.equal(listRequests(p.id)[0].status, "claimed");
  });

  it("checks the note, and a refused release changes nothing", () => {
    const { p, r } = taken();
    refused(() => releaseRequest(p.id, r.id, token(1), { note: 5 }), 400, /must be text/);
    refused(() => releaseRequest(p.id, r.id, token(1), { note: "x".repeat(REQUEST_LIMITS.resultNoteMax + 1) }), 400, /at most/);
    assert.deepEqual([listRequests(p.id)[0].status, listRequests(p.id)[0].releasedAt], ["claimed", null]);
  });

  it("when it is taken again the history stays on the row (the screen shows it only while the request waits)", () => {
    const { p, r } = taken("discover", token(1));
    releaseRequest(p.id, r.id, token(1), { note: "later" });
    claimRequest(p.id, r.id, token(1));
    const row = listRequests(p.id)[0];
    assert.equal(row.status, "claimed");
    assert.equal(row.releaseNote, "later");
  });
});

describe("a discover that links the audit it made", () => {
  const audit = (projectId: number, imported = "2999-01-01 00:00:00") =>
    (db.prepare("INSERT INTO audits (project_id, agent_audit_id, title, source, last_imported_at) VALUES (?, ?, 'The audit', 'upload', ?) RETURNING id").get(projectId, `a-${Math.random()}`, imported) as { id: number }).id;
  const taken = (kind: "discover" | "rerun" = "discover") => {
    const p = makeProject(key());
    const r = kind === "discover" ? createRequest(p.id, { kind, targetUrl: "https://staging.example.com" }, me) : createRequest(p.id, { kind, runId: automatedRun(p.id, { a: "failed" }) }, me);
    claimRequest(p.id, r.id, token());
    return { p, r };
  };

  it("keeps the audit, and the person's list names it", () => {
    const { p, r } = taken();
    const id = audit(p.id);
    const done = completeRequest(p.id, r.id, token(), { note: "done", resultAuditId: id });
    assert.equal(done.resultAuditId, id);
    const shown = listRequests(p.id)[0];
    assert.equal(shown.resultAudit?.title, "The audit");
    assert.equal(shown.resultAudit?.id, id);
  });

  it("is refused for a re-run, an audit of another project, one imported before the request was taken, and something that is not a whole number", () => {
    const d = taken();
    refused(() => completeRequest(d.p.id, d.r.id, token(), { resultAuditId: audit(makeProject(key()).id) }), 400, /not an audit in this project/);
    refused(() => completeRequest(d.p.id, d.r.id, token(), { resultAuditId: audit(d.p.id, "2000-01-01 00:00:00") }), 400, /before this request was taken/);
    refused(() => completeRequest(d.p.id, d.r.id, token(), { resultAuditId: 1.5 }), 400, /whole number/);
    refused(() => completeRequest(d.p.id, d.r.id, token(), { resultAuditId: 999999 }), 400, /not an audit in this project/);
    assert.equal(listRequests(d.p.id)[0].status, "claimed", "none of that finished it");
    const rr = taken("rerun");
    refused(() => completeRequest(rr.p.id, rr.r.id, token(), { resultAuditId: audit(rr.p.id) }), 400, /Only a discover/);
  });

  it("a request finished without an audit has none, and removing the audit empties the link but keeps the request", () => {
    const a = taken();
    assert.equal(completeRequest(a.p.id, a.r.id, token(), {}).resultAuditId, null);
    const b = taken();
    const id = audit(b.p.id);
    completeRequest(b.p.id, b.r.id, token(), { resultAuditId: id });
    db.prepare("DELETE FROM audits WHERE id = ?").run(id);
    const row = listRequests(b.p.id)[0];
    assert.deepEqual([row.status, row.resultAuditId, row.resultAudit], ["done", null, null]);
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

describe("the options of a discover request", () => {
  // What the person chose when asking: a preselection for the agent's one confirmation, never a permission. Enumerations only, no free text.
  const ask = (projectId: number, options?: unknown, by: { name: string; userId: number | null; mayWiden?: boolean } = me) =>
    createRequest(projectId, { kind: "discover", targetUrl: "https://staging.example.com", options }, by);

  it("without options a discover gets the defaults: read only, a local branch, a plan, cases, observations and bugs, all three viewports", () => {
    const p = makeProject(key());
    const r = ask(p.id);
    assert.deepEqual(r.options, { targetMode: "observe_only", gitMode: "local", deliverables: ["plan", "cases", "observations", "bugs"], viewports: ["desktop", "tablet", "mobile"], checks: [], depth: "normal", production: false });
    assert.notEqual(r.options?.deliverables, DEFAULT_REQUEST_OPTIONS.deliverables, "a copy: one request's options never change the defaults");
  });

  it("has a depth of quick, normal or thorough: normal when it is not given, kept as chosen, and nothing else is accepted", () => {
    const p = makeProject(key());
    assert.equal(ask(p.id, {}).options?.depth, "normal", "a request without a depth, such as one made before depth existed");
    for (const depth of ["quick", "normal", "thorough"]) assert.equal(ask(p.id, { depth }).options?.depth, depth);
    refused(() => ask(p.id, { depth: "deep" }), 400, /depth must be one of quick, normal, thorough/);
    refused(() => ask(p.id, { depth: 3 }), 400, /depth must be one of/);
    refused(() => ask(p.id, { depth: ["thorough"] }), 400, /depth must be one of/);
  });

  it("does not let the depth widen what the agent may do: acting on the target still needs an admin, and a production address can still only be read, at any depth", () => {
    const p = makeProject(key());
    const tester = { ...me, mayWiden: false };
    for (const depth of ["quick", "normal", "thorough"]) {
      assert.equal(ask(p.id, { depth }, tester).options?.targetMode, "observe_only", "the depth alone changes no mode");
      refused(() => ask(p.id, { depth, targetMode: "full" }, tester), 403, /Only an admin/);
      refused(() => ask(p.id, { depth, production: true, targetMode: "full" }), 400, /production target can only be read/);
    }
  });

  it("keeps what the person chose, each value once and in a fixed order, and gives the same to the person's list, the agent's list and the claim", () => {
    const p = makeProject(key());
    const r = ask(p.id, { targetMode: "full", gitMode: "pr", deliverables: ["specs", "plan", "plan"], viewports: ["mobile", "desktop"], checks: ["security", "visual", "visual"] });
    const want = { targetMode: "full", gitMode: "pr", deliverables: ["plan", "specs"], viewports: ["desktop", "mobile"], checks: ["visual", "security"], depth: "normal", production: false };
    assert.deepEqual(r.options, want);
    assert.deepEqual(listRequests(p.id)[0].options, want);
    assert.deepEqual(pendingForAgent(p.id)[0].options, want);
    assert.deepEqual(claimRequest(p.id, r.id, token()).options, want);
    const stored = JSON.parse((db.prepare("SELECT payload FROM agent_requests WHERE id = ?").get(r.id) as { payload: string }).payload) as { options: unknown };
    assert.deepEqual(stored.options, want, "what is stored is what was checked, not what was sent");
  });

  it("refuses what is not one of the choices: an unknown option, a value out of range, an empty or unknown list, and options that are not an object", () => {
    const p = makeProject(key());
    refused(() => ask(p.id, { color: "red" }), 400, /Unknown option "color"/);
    refused(() => ask(p.id, { targetMode: "write" }), 400, /targetMode must be one of/);
    refused(() => ask(p.id, { targetMode: 1 }), 400, /targetMode must be one of/);
    refused(() => ask(p.id, { gitMode: "push" }), 400, /gitMode must be one of/);
    refused(() => ask(p.id, { deliverables: [] }), 400, /deliverables must be a list/);
    refused(() => ask(p.id, { deliverables: "plan" }), 400, /deliverables must be a list/);
    refused(() => ask(p.id, { deliverables: ["plan", "everything"] }), 400, /deliverables can only hold/);
    refused(() => ask(p.id, { viewports: ["desktop", "tablet", "mobile", "watch"] }), 400, /viewports must be a list/);
    refused(() => ask(p.id, { viewports: ["fridge"] }), 400, /viewports can only hold/);
    refused(() => ask(p.id, { production: "yes" }), 400, /production must be true or false/);
    refused(() => ask(p.id, "full"), 400, /must be an object/);
    refused(() => ask(p.id, ["full"]), 400, /must be an object/);
    assert.equal(listRequests(p.id).length, 0, "nothing was made");
  });

  it("a production target can only be read: production with full is refused, production with observe_only is kept, and git is a separate choice", () => {
    const p = makeProject(key());
    refused(() => ask(p.id, { production: true, targetMode: "full" }), 400, /production target can only be read/);
    refused(() => ask(p.id, { production: true, checks: ["security"] }), 400, /only visual is allowed/);
    assert.deepEqual(ask(p.id, { production: true, checks: ["visual"] }).options?.checks, ["visual"]);
    refused(() => ask(p.id, { checks: ["nope"] }), 400, /checks must be a list/);
    assert.equal(ask(p.id, { production: true }).options?.production, true);
    assert.equal(ask(p.id, { production: true, gitMode: "pr" }).options?.gitMode, "pr");
  });

  it("with accounts on, only an admin can ask for full or pr: someone who may not widen is refused (403), and nothing is made", () => {
    const p = makeProject(key());
    const tester = { ...me, mayWiden: false };
    refused(() => ask(p.id, { targetMode: "full" }, tester), 403, /Only an admin/);
    refused(() => ask(p.id, { gitMode: "pr" }, tester), 403, /Only an admin/);
    assert.equal(listRequests(p.id).length, 0, "nothing was made");
    assert.equal(ask(p.id, { targetMode: "observe_only", gitMode: "off" }, tester).options?.gitMode, "off");
    assert.equal(ask(p.id, { gitMode: "local" }, tester).options?.gitMode, "local");
    assert.equal(ask(p.id, undefined, tester).options?.targetMode, "observe_only", "no options: the defaults, which anyone may ask for");
    assert.equal(ask(p.id, { targetMode: "full", gitMode: "pr" }, { ...me, mayWiden: true }).options?.targetMode, "full");
    assert.equal(optionsNeedAdmin(DEFAULT_REQUEST_OPTIONS), false);
  });

  it("only a discover has options: a re-run or a run that is given some is refused, and a re-run has none", () => {
    const p = makeProject(key());
    const run = automatedRun(p.id, { "a works": "failed" });
    refused(() => createRequest(p.id, { kind: "rerun", runId: run, options: { gitMode: "off" } }, me), 400, /only for a discover/);
    refused(() => createRequest(p.id, { kind: "run", targetUrl: "https://a.example", caseIds: [1], options: {} }, me), 400, /only for a discover/);
    assert.equal(createRequest(p.id, { kind: "rerun", runId: run }, me).options, null);
  });

  it("a discover made before options existed has none stored and reads as the defaults", () => {
    const p = makeProject(key());
    const row = db
      .prepare("INSERT INTO agent_requests (project_id, kind, target_url, environment, note, run_id, payload, created_by, created_by_user_id) VALUES (?, 'discover', 'https://old.example.com/', '', '', NULL, ?, 'Tess', NULL) RETURNING id")
      .get(p.id, JSON.stringify({ tests: [] })) as { id: number };
    assert.deepEqual(listRequests(p.id).find((r) => r.id === row.id)?.options, DEFAULT_REQUEST_OPTIONS);
    assert.deepEqual(pendingForAgent(p.id)[0].options, DEFAULT_REQUEST_OPTIONS);
  });
});

describe("one request at a time, in the order a person chooses", () => {
  const three = () => {
    const p = makeProject(key());
    const mk = (note: string) => createRequest(p.id, { kind: "discover", targetUrl: "https://staging.example.com", note }, me);
    return { p, a: mk("a"), b: mk("b"), c: mk("c") };
  };
  const order = (projectId: number) => pendingForAgent(projectId).map((r) => r.id);

  it("while one request is taken, no other of the project can be, by another agent or by the same one, and the refusal names the one that runs", () => {
    const { p, a, b } = three();
    claimRequest(p.id, a.id, token(1, "qa-agent"));
    refused(() => claimRequest(p.id, b.id, token(2, "other")), 409, new RegExp(`Request #${a.id} is already being worked on \\(agent: qa-agent\\)`));
    refused(() => claimRequest(p.id, b.id, token(1, "qa-agent")), 409, /Only one request runs at a time/);
    assert.equal(listRequests(p.id).find((r) => r.id === b.id)?.status, "pending", "the second is untouched");
  });

  it("the next can be taken once the one that runs is done, given back or cancelled by a person", () => {
    for (const finish of [
      (p: number, id: number) => completeRequest(p, id, token(1), {}),
      (p: number, id: number) => releaseRequest(p, id, token(1), { note: "no browser" }),
      (_p: number, id: number) => cancelRequest(id),
    ]) {
      const { p, a, b } = three();
      claimRequest(p.id, a.id, token(1));
      refused(() => claimRequest(p.id, b.id, token(1)), 409, /already being worked on/);
      finish(p.id, a.id);
      assert.equal(claimRequest(p.id, b.id, token(1)).status, "claimed");
    }
  });

  it("is a rule of the project: a request taken in another project holds nothing up", () => {
    const one = three();
    const other = three();
    claimRequest(one.p.id, one.a.id, token(1));
    assert.equal(claimRequest(other.p.id, other.a.id, token(2, "elsewhere")).status, "claimed");
  });

  it("an agent is given the oldest first, until a person puts another first; the one put first last goes first", () => {
    const { p, a, b, c } = three();
    assert.deepEqual(order(p.id), [a.id, b.id, c.id]);
    runNextRequest(c.id);
    assert.deepEqual(order(p.id), [c.id, a.id, b.id]);
    runNextRequest(b.id);
    assert.deepEqual(order(p.id), [b.id, c.id, a.id]);
    runNextRequest(a.id);
    assert.deepEqual(order(p.id), [a.id, b.id, c.id]);
  });

  it("putting a request first changes only its place: it is not taken, and its text is as it was", () => {
    const { p, b } = three();
    const made = runNextRequest(b.id);
    assert.deepEqual([made.status, made.queuePosition, made.note, made.claimedBy], ["pending", 1, "b", null]);
    assert.equal(listRequests(p.id).filter((r) => r.status === "claimed").length, 0);
  });

  it("putting a request first that is already first changes nothing, so the number does not climb", () => {
    const { b, a } = three();
    runNextRequest(b.id);
    assert.equal(runNextRequest(b.id).queuePosition, 1);
    assert.equal(db.prepare("SELECT priority FROM agent_requests WHERE id = ?").pluck().get(b.id), 1);
    assert.equal(runNextRequest(a.id).queuePosition, 1, "and the oldest, put first over one that was put first, goes above it");
    assert.equal(db.prepare("SELECT priority FROM agent_requests WHERE id = ?").pluck().get(a.id), 2);
    const { a: oldest } = three();
    runNextRequest(oldest.id);
    assert.equal(db.prepare("SELECT priority FROM agent_requests WHERE id = ?").pluck().get(oldest.id), 0, "the oldest is first by age: left alone");
  });

  it("only a waiting request can be put first: not one that is taken, done or cancelled (409), and not one that is not there (404)", () => {
    const { p, a, b, c } = three();
    claimRequest(p.id, a.id, token(1));
    refused(() => runNextRequest(a.id), 409, /Only a request that is waiting/);
    completeRequest(p.id, a.id, token(1), {});
    refused(() => runNextRequest(a.id), 409, /Only a request that is waiting/);
    cancelRequest(b.id);
    refused(() => runNextRequest(b.id), 409, /Only a request that is waiting/);
    refused(() => runNextRequest(999999), 404, /not found/);
    assert.deepEqual(order(p.id), [c.id], "nothing changed for the one that waits");
  });

  it("is per project: putting a request first in one project leaves the order of another", () => {
    const one = three();
    const other = three();
    runNextRequest(one.c.id);
    assert.deepEqual(order(other.p.id), [other.a.id, other.b.id, other.c.id]);
  });

  it("a person's list says where each waiting request stands in line (1 is next), and nothing for the others", () => {
    const { p, a, b, c } = three();
    const place = () => Object.fromEntries(listRequests(p.id).map((r) => [r.id, r.queuePosition]));
    assert.deepEqual(place(), { [a.id]: 1, [b.id]: 2, [c.id]: 3 });
    runNextRequest(c.id);
    assert.deepEqual(place(), { [c.id]: 1, [a.id]: 2, [b.id]: 3 });
    claimRequest(p.id, c.id, token(1));
    assert.deepEqual(place(), { [c.id]: null, [a.id]: 1, [b.id]: 2 }, "the one that runs is not in line");
    assert.equal(listRequests(p.id, "pending").every((r) => r.queuePosition !== null), true, "a filtered list still has the places");
  });

  it("a request that was never put first has priority 0", () => {
    const { p, a } = three();
    assert.equal(listRequests(p.id).find((r) => r.id === a.id)?.priority, 0);
  });
});

describe("the name of a request", () => {
  const ask = (projectId: number, extra: Record<string, unknown> = {}) => createRequest(projectId, { kind: "discover", targetUrl: "https://a.example.com", ...extra }, me);

  it("is kept as typed (trimmed) and comes back in the list; a request without one has an empty name", () => {
    const p = makeProject(key());
    const named = ask(p.id, { name: "  Login flow  " });
    const plain = ask(p.id);
    assert.equal(named.name, "Login flow");
    assert.equal(plain.name, "");
    const listed = listRequests(p.id);
    assert.equal(listed.find((r) => r.id === named.id)?.name, "Login flow");
    assert.equal(listed.find((r) => r.id === plain.id)?.name, "");
  });

  it("belongs to a re-run as well as a discover, and a name is not the note", () => {
    const p = makeProject(key());
    const run = automatedRun(p.id, { "a one": "failed" });
    const r = createRequest(p.id, { kind: "rerun", runId: run, name: "Nightly again", note: "the details" }, me);
    assert.deepEqual([r.name, r.note], ["Nightly again", "the details"]);
  });

  it("takes letters of any language and an emoji, and is at most 60 characters", () => {
    const p = makeProject(key());
    assert.equal(ask(p.id, { name: "Inloggning, åäö é 日本語 🔒" }).name, "Inloggning, åäö é 日本語 🔒");
    assert.equal(ask(p.id, { name: "x".repeat(REQUEST_LIMITS.nameMax) }).name.length, 60);
    refused(() => ask(p.id, { name: "x".repeat(REQUEST_LIMITS.nameMax + 1) }), 400, /name can be at most 60/);
  });

  it("refuses a name that is not text, that runs over two lines, or that holds a control or direction character", () => {
    const p = makeProject(key());
    refused(() => ask(p.id, { name: 7 }), 400, /name must be text/);
    const before = listRequests(p.id).length;
    for (const [what, name] of [["a line break", "a\nb"], ["a carriage return", "a\rb"], ["a tab", "a\tb"], ["a delete character", "a\x7fb"], ["a line separator", "a\u2028b"],
      ["a paragraph separator", "a\u2029b"], ["a right-to-left override", "a\u202eb"], ["an isolate", "a\u2066b"]] as const) {
      assert.throws(() => ask(p.id, { name }), (e: unknown) => e instanceof AuditError && e.status === 400 && /one line/.test(e.message), what);
    }
    assert.equal(listRequests(p.id).length, before, "nothing was made by a refused name");
  });
});
