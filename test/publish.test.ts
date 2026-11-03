import "./env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { db, UPLOAD_DIR } from "../server/db.ts";
import { makeCase, makeProject } from "./helpers.ts";
import { bagFromFiles } from "../server/importers/bag.ts";
import { getBugReport, importAuditPackage, linkExternalIssue, reviewBugReport, updateBugReport } from "../server/audits.ts";
import { buildPreview, checkPublication, getDestination, lookupTeams, publishBug, PublishError, removeDestination, retryAttachments, saveDestination } from "../server/publish.ts";
import { unseal } from "../server/secrets.ts";

const KEY = "lin_api_SECRETKEY1234";
const NOENV = {} as NodeJS.ProcessEnv;
const PNG = Buffer.from("89504e470d0a1a0a00000000", "hex");
const TEAMS = [{ id: "team-eng-uuid", key: "ENG", name: "Engineering" }, { id: "team-qa-uuid", key: "QA", name: "Quality" }];

let n = 0;
const proj = () => makeProject(`PB${++n}`, `Publish project ${n}`);
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

/** A stand-in for Linear and for its file storage. `behave.create` decides what happens to the next issueCreate. */
function fakeLinear() {
  type Call = { url: string; method: string; auth: string | null; query: string; variables: any };
  const calls: Call[] = [];
  const issues = new Map<string, { id: string; identifier: string; url: string }>();
  const behave = { create: "ok" as "ok" | "reject" | "network" | "lost" | "http500" | "badjson", teams: "ok" as "ok" | "401" | "network", put: "ok" as "ok" | "fail", delay: 0 };
  let seq = 11;
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
  const f = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (!url.startsWith("https://api.linear.app/")) {
      calls.push({ url, method: init.method ?? "GET", auth: headers.Authorization ?? null, query: "", variables: null });
      return behave.put === "fail" ? new Response("no", { status: 403 }) : new Response("", { status: 200 });
    }
    const body = JSON.parse(String(init.body));
    calls.push({ url, method: "POST", auth: headers.Authorization ?? null, query: body.query, variables: body.variables });
    const q: string = body.query;
    if (q.includes("teams")) {
      if (behave.teams === "401") return new Response("no", { status: 401 });
      if (behave.teams === "network") throw new TypeError("fetch failed");
      return json({ data: { teams: { nodes: TEAMS } } });
    }
    if (q.includes("issueCreate")) {
      if (behave.delay) await new Promise((r) => setTimeout(r, behave.delay));
      const input = body.variables.input;
      if (behave.create === "reject") return json({ errors: [{ message: "Argument Validation Error" }] });
      if (behave.create === "network") throw new TypeError("fetch failed");
      const issue = { id: input.id, identifier: `ENG-${seq++}`, url: `https://linear.app/acme/issue/ENG-${seq - 1}` };
      if (issues.has(input.id)) return json({ errors: [{ message: "Issue already exists" }] });
      issues.set(input.id, issue);
      if (behave.create === "lost") throw new TypeError("fetch failed");
      if (behave.create === "http500") return new Response("boom", { status: 500 });
      if (behave.create === "badjson") return new Response("<html>", { status: 200 });
      return json({ data: { issueCreate: { success: true, issue } } });
    }
    if (q.includes("issue(id")) {
      const found = issues.get(body.variables.id);
      return found ? json({ data: { issue: found } }) : json({ errors: [{ message: "Entity not found: Issue" }] });
    }
    if (q.includes("fileUpload")) return json({ data: { fileUpload: { success: true, uploadFile: { uploadUrl: `https://storage.example/up/${calls.length}`, assetUrl: "https://uploads.linear.app/x", headers: [{ key: "x-goog-meta", value: "1" }] } } } });
    if (q.includes("attachmentCreate")) return json({ data: { attachmentCreate: { success: true } } });
    return json({ errors: [{ message: "unexpected query" }] });
  }) as unknown as typeof fetch;
  const created = () => calls.filter((c) => c.query.includes("issueCreate"));
  return { f, calls, issues, behave, created };
}

function pkgBag(project: string, bugs: unknown[], files: Record<string, Uint8Array> = {}) {
  const m = new Map<string, Uint8Array>();
  for (const [p, b] of Object.entries(files)) m.set(p, b);
  m.set("manifest.json", Buffer.from(JSON.stringify({
    format: "testbench-audit-package", version: 1,
    audit: { id: `pub-${n}`, title: "Checkout audit", project, agent: { name: "test-agent", version: "1.0" } },
    files: Object.entries(files).map(([path, b]) => ({ path, sha256: createHash("sha256").update(b).digest("hex"), size: b.length })), parts: {},
  })));
  m.set("bugs.json", Buffer.from(JSON.stringify({ version: 1, bugs })));
  return bagFromFiles(m);
}

/** A project with a destination set up, and one bug report that is accepted. */
async function setup(f: ReturnType<typeof fakeLinear>, opts: { accept?: boolean; files?: Record<string, Uint8Array>; refs?: object; severity?: string } = {}) {
  const p = proj();
  const kase = makeCase(p.id, "Discount is applied");
  await saveDestination(p.id, { token: KEY, team: "ENG" }, f.f, NOENV);
  importAuditPackage(pkgBag(p.key, [{
    sourceId: "discount-zero", title: "Cart total is zero after a discount", description: "After SAVE10 the total drops to 0 kr.",
    steps: ["Add two products", "Apply SAVE10"], expected: "10 % less", actual: "0 kr", environment: "staging", url: "https://staging.example.test/cart",
    agentSeverity: opts.severity ?? "high", refs: opts.refs ?? { cases: [`${p.key}-${kase.number}`, `${p.key}-999`], requirements: [], tests: [] },
    evidence: Object.keys(opts.files ?? {}).map((path) => ({ path, label: path })),
  }], opts.files), { projectId: p.id, source: "upload" });
  const bug = (db.prepare("SELECT id FROM bug_reports WHERE project_id = ?").get(p.id) as { id: number }).id;
  if (opts.accept !== false) reviewBugReport(bug, "accepted");
  return { p, bug, kase };
}
const approve = (bug: number, f: ReturnType<typeof fakeLinear>, extra: object = {}) => {
  const pv = buildPreview(bug, extra as any, NOENV);
  return publishBug(bug, { previewHash: pv.hash, approve: true, ...extra }, f.f, NOENV);
};
const rejectsWith = (p: Promise<unknown>, status: number, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof PublishError && e.status === status && re.test(e.message));
const pubs = (bug: number) => db.prepare("SELECT * FROM bug_publications WHERE bug_report_id = ?").all(bug) as Record<string, any>[];

describe("destination of a project", () => {
  it("is checked against Linear when saved, and the key is stored sealed and never shown", async () => {
    const f = fakeLinear();
    const p = proj();
    const v = await saveDestination(p.id, { token: KEY, team: "eng" }, f.f, NOENV);
    assert.deepEqual([v.kind, v.team.key, v.tokenSource, v.ready, v.baseUrl], ["linear", "ENG", "stored", true, "https://api.linear.app/graphql"]);
    assert.equal(v.tokenHint, "…1234");
    assert.ok(!JSON.stringify(v).includes("SECRETKEY"), "the key is not in what the API returns");
    const raw = db.prepare("SELECT * FROM project_destinations WHERE project_id = ?").get(p.id) as Record<string, string>;
    assert.ok(!JSON.stringify(raw).includes("SECRETKEY"), "the key is not readable in the database");
    assert.equal(unseal(raw.token_enc), KEY);
    assert.deepEqual(getDestination(p.id, NOENV), v);
    // Changing only the team keeps the stored key.
    const v2 = await saveDestination(p.id, { team: "QA" }, f.f, NOENV);
    assert.equal(v2.team.key, "QA");
    assert.equal(unseal((db.prepare("SELECT token_enc FROM project_destinations WHERE project_id = ?").get(p.id) as { token_enc: string }).token_enc), KEY);
    removeDestination(p.id);
    assert.equal(getDestination(p.id, NOENV), null);
  });

  it("gives clear errors for a wrong key, an unreachable Linear, an unknown team and a missing key, and saves nothing", async () => {
    const f = fakeLinear();
    const p = proj();
    f.behave.teams = "401";
    await rejectsWith(saveDestination(p.id, { token: KEY, team: "ENG" }, f.f, NOENV), 400, /Linear rejected the API key/);
    f.behave.teams = "network";
    await rejectsWith(saveDestination(p.id, { token: KEY, team: "ENG" }, f.f, NOENV), 502, /Could not reach Linear/);
    f.behave.teams = "ok";
    await rejectsWith(saveDestination(p.id, { token: KEY, team: "NOPE" }, f.f, NOENV), 400, /No Linear team matches "NOPE"/);
    await rejectsWith(saveDestination(p.id, { token: KEY }, f.f, NOENV), 400, /Choose which Linear team/);
    await rejectsWith(saveDestination(p.id, { team: "ENG" }, f.f, NOENV), 400, /Enter a Linear API key/);
    await rejectsWith(saveDestination(999999, { token: KEY, team: "ENG" }, f.f, NOENV), 404, /Project not found/);
    assert.equal(count("SELECT COUNT(*) AS n FROM project_destinations WHERE project_id = ?", p.id), 0);
    for (const call of f.calls) assert.ok(!JSON.stringify(call).includes("undefined"), "no half-built request");
    assert.deepEqual((await lookupTeams(p.id, KEY, f.f, NOENV)).map((t) => t.key), ["ENG", "QA"]);
  });

  it("falls back to the server's own key when none is stored, and says so", async () => {
    const f = fakeLinear();
    const p = proj();
    const v = await saveDestination(p.id, { team: "ENG" }, f.f, { LINEAR_API_KEY: "lin_api_server" } as NodeJS.ProcessEnv);
    assert.deepEqual([v.tokenSource, v.ready, v.tokenHint], ["environment", true, ""]);
    assert.equal(f.calls[0].auth, "lin_api_server");
  });

  it("is removed with its project, and a key that cannot be opened blocks publishing with a clear reason", async () => {
    const f = fakeLinear();
    const { p, bug } = await setup(f);
    db.prepare("UPDATE project_destinations SET token_enc = 'v1:AAAA:AAAA:AAAA' WHERE project_id = ?").run(p.id);
    const pv = buildPreview(bug, {}, NOENV);
    assert.equal(pv.canPublish, false);
    assert.match(pv.blockers.join(" "), /cannot be read here/);
    await rejectsWith(publishBug(bug, { previewHash: pv.hash, approve: true }, f.f, NOENV), 409, /cannot be read here/);
    db.prepare("DELETE FROM projects WHERE id = ?").run(p.id);
    assert.equal(count("SELECT COUNT(*) AS n FROM project_destinations WHERE project_id = ?", p.id), 0);
  });
});

describe("preview", () => {
  it("shows exactly what would be sent: title, description, severity mapping, links, files and the target team", async () => {
    const f = fakeLinear();
    const { bug, kase, p } = await setup(f, { files: { "evidence/shot.png": PNG, "evidence/notes.txt": Buffer.from("synthetic") } });
    const pv = buildPreview(bug, {}, NOENV);
    assert.equal(pv.title, "Cart total is zero after a discount");
    assert.deepEqual(pv.destination?.team, { id: "team-eng-uuid", key: "ENG", name: "Engineering" });
    assert.equal(pv.priority.mapping, "high → Linear priority High (2)");
    assert.match(pv.description, /After SAVE10 the total drops to 0 kr\./);
    assert.match(pv.description, /1\. Add two products\n2\. Apply SAVE10/);
    assert.match(pv.description, /\*\*Expected result\*\*\n10 % less/);
    assert.match(pv.description, new RegExp(`Test case: ${p.key}-${kase.number} .*Discount is applied`));
    assert.match(pv.description, /- shot\.png \(image\/png|- shot\.png \(file/);
    assert.deepEqual(pv.refs.map((r) => [r.sendable, r.included]), [[true, true], [false, false]], "the unresolved link is shown but not sendable");
    assert.deepEqual(pv.attachments.map((a) => [a.filename, a.included]), [["shot.png", true], ["notes.txt", true]]);
    assert.match(pv.warnings.join(" "), /1 link cannot be sent/);
    assert.equal(pv.canPublish, true);

    // What is later sent is this text, character for character.
    await approve(bug, f);
    const sent = f.created()[0].variables.input;
    assert.equal(sent.title, pv.title);
    assert.equal(sent.description, pv.description);
    assert.equal(sent.priority, 2);
    assert.equal(sent.teamId, "team-eng-uuid");
  });

  it("follows the person's choices of links and files, and refuses ones that are not this report's", async () => {
    const f = fakeLinear();
    const { bug } = await setup(f, { files: { "evidence/a.png": PNG, "evidence/b.txt": Buffer.from("x") } });
    const all = buildPreview(bug, {}, NOENV);
    const some = buildPreview(bug, { refIds: [], attachmentIds: [all.attachments[1].id] }, NOENV);
    assert.ok(!some.description.includes("Related in Testbench"));
    assert.deepEqual(some.attachments.map((a) => a.included), [false, true]);
    assert.notEqual(some.hash, all.hash, "the hash covers the selection");
    assert.throws(() => buildPreview(bug, { attachmentIds: [999999] }, NOENV), /cannot be sent with this report/);
    assert.throws(() => buildPreview(bug, { refIds: [999999] }, NOENV), /Reference 999999/);
    assert.deepEqual(buildPreview(bug, { severity: "x" } as any, NOENV).hash, all.hash);
  });

  it("maps every severity to a Linear priority, and no severity to none", async () => {
    const f = fakeLinear();
    const got: Record<string, string> = {};
    for (const s of ["critical", "high", "medium", "low"]) got[s] = buildPreview((await setup(f, { severity: s })).bug, {}, NOENV).priority.mapping;
    assert.deepEqual(got, {
      critical: "critical → Linear priority Urgent (1)", high: "high → Linear priority High (2)",
      medium: "medium → Linear priority Medium (3)", low: "low → Linear priority Low (4)",
    });
    const { bug } = await setup(f);
    db.prepare("UPDATE bug_reports SET agent_severity = NULL, human_severity = NULL WHERE id = ?").run(bug);
    assert.equal(buildPreview(bug, {}, NOENV).priority.mapping, "no severity → Linear priority No priority (0)");
  });

  it("uses the person's severity over the agent's, and does not send anything itself", async () => {
    const f = fakeLinear();
    const { bug } = await setup(f);
    updateBugReport(bug, { humanSeverity: "low" });
    const before = f.calls.length;
    assert.equal(buildPreview(bug, {}, NOENV).priority.value, 4);
    assert.equal(f.calls.length, before, "a preview makes no request");
  });
});

describe("publishing needs approval", () => {
  it("does nothing without explicit approval, for a report that is not accepted, or when the preview is out of date", async () => {
    const f = fakeLinear();
    const { bug } = await setup(f);
    const pv = buildPreview(bug, {}, NOENV);
    await rejectsWith(publishBug(bug, { previewHash: pv.hash, approve: false }, f.f, NOENV), 400, /explicit approval/);
    await rejectsWith(publishBug(bug, { previewHash: pv.hash, approve: undefined as unknown as boolean }, f.f, NOENV), 400, /explicit approval/);
    updateBugReport(bug, { title: "Changed after the preview" });
    await rejectsWith(publishBug(bug, { previewHash: pv.hash, approve: true }, f.f, NOENV), 409, /changed after the preview/);

    const other = await setup(f, { accept: false });
    await rejectsWith(approve(other.bug, f), 409, /Only reports you have accepted.*"proposed"/);
    reviewBugReport(other.bug, "rejected");
    await rejectsWith(approve(other.bug, f), 409, /"rejected"/);
    assert.equal(f.created().length, 0, "nothing was sent");
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_publications WHERE bug_report_id IN (?, ?)", bug, other.bug), 0);
  });

  it("is not triggered by accepting a report", async () => {
    const f = fakeLinear();
    const { bug } = await setup(f, { accept: false });
    const before = f.calls.length;
    reviewBugReport(bug, "accepted");
    assert.equal(f.calls.length, before);
    assert.equal(pubs(bug).length, 0);
  });
});

describe("publishing", () => {
  it("creates the issue once approved, and keeps its id, link, time and the content that was sent", async () => {
    const f = fakeLinear();
    const { bug } = await setup(f);
    const done = await approve(bug, f);
    assert.deepEqual([done.state, done.externalId, done.externalUrl], ["sent", "ENG-11", "https://linear.app/acme/issue/ENG-11"]);
    assert.ok(done.completedAt);
    assert.equal(done.content?.title, "Cart total is zero after a discount");
    assert.equal(done.content?.team.key, "ENG");
    assert.match(done.content?.description, /After SAVE10/);
    const row = pubs(bug)[0];
    assert.equal(row.mode, "created");
    assert.equal(row.destination_ref, "team-eng-uuid");
    assert.equal(f.created()[0].variables.input.id, row.idempotency_key, "the issue is created under the id that was stored first");
    const shown = (getBugReport(bug).publications as { external_id: string; external_url: string; state: string }[])[0];
    assert.deepEqual([shown.state, shown.external_id], ["sent", "ENG-11"]);
  });

  it("does not leave a local record when Linear refuses, and a later try works", async () => {
    const f = fakeLinear();
    const { bug } = await setup(f);
    f.behave.create = "reject";
    await rejectsWith(approve(bug, f), 502, /Linear: Argument Validation Error/);
    assert.equal(pubs(bug).length, 0);
    f.behave.create = "ok";
    assert.equal((await approve(bug, f)).state, "sent");
    assert.equal(pubs(bug).length, 1);
  });

  it("keeps an unclear outcome as 'unknown' with its id, never retries by itself, and a check that finds the issue settles it without a duplicate", async () => {
    for (const mode of ["lost", "http500", "badjson"] as const) {
      const f = fakeLinear();
      const { bug } = await setup(f);
      f.behave.create = mode;
      await rejectsWith(approve(bug, f), 502, /may already have created the issue/);
      const [row] = pubs(bug);
      assert.equal(row.state, "unknown", mode);
      assert.ok(row.idempotency_key);
      assert.equal(f.created().length, 1, "no automatic second attempt");
      assert.deepEqual(getBugReport(bug).publications.map((p: any) => p.state), ["unknown"]);
      // The first request did create it (modes lost, http500, badjson store the issue before the answer goes wrong).
      const checked = await checkPublication(row.id, f.f, NOENV);
      assert.deepEqual([checked.state, checked.externalId], ["sent", "ENG-11"]);
      assert.equal(f.issues.size, 1);
      assert.equal(f.created().length, 1, "checking only reads");
    }
  });

  it("when an unclear attempt created nothing, checking says so and publishing again reuses the same id", async () => {
    const f = fakeLinear();
    const { bug } = await setup(f);
    f.behave.create = "network";
    await rejectsWith(approve(bug, f), 502, /Could not reach Linear/);
    const [row] = pubs(bug);
    assert.equal(row.state, "unknown");
    const checked = await checkPublication(row.id, f.f, NOENV);
    assert.equal(checked.state, "failed");
    assert.match(checked.error, /nothing was created/);
    f.behave.create = "ok";
    const done = await approve(bug, f);
    assert.equal(done.state, "sent");
    assert.equal(pubs(bug).length, 1, "the same record was reused");
    assert.deepEqual(f.created().map((c) => c.variables.input.id), [row.idempotency_key, row.idempotency_key]);
    assert.equal(f.issues.size, 1);
  });

  it("publishing again after an unclear attempt first looks for the issue and does not create a second one", async () => {
    const f = fakeLinear();
    const { bug } = await setup(f);
    f.behave.create = "lost";
    await rejectsWith(approve(bug, f), 502, /may already have created/);
    f.behave.create = "ok";
    const done = await approve(bug, f);
    assert.deepEqual([done.state, done.externalId], ["sent", "ENG-11"]);
    assert.equal(f.created().length, 1, "found the first issue instead of creating another");
    assert.equal(f.issues.size, 1);
  });

  it("does not make a duplicate when published twice, in a row or at the same time", async () => {
    const f = fakeLinear();
    const { bug } = await setup(f);
    f.behave.delay = 20;
    const pv = buildPreview(bug, {}, NOENV);
    const results = await Promise.allSettled([publishBug(bug, { previewHash: pv.hash, approve: true }, f.f, NOENV), publishBug(bug, { previewHash: pv.hash, approve: true }, f.f, NOENV)]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    f.behave.delay = 0;
    await rejectsWith(approve(bug, f), 409, /Already published as ENG-11/);
    assert.equal(f.issues.size, 1);
    assert.equal(pubs(bug).length, 1);
  });

  it("will not publish a report that is already linked to a Linear issue", async () => {
    const f = fakeLinear();
    const { bug } = await setup(f);
    linkExternalIssue(bug, { destination: "linear", url: "https://linear.app/acme/issue/ENG-5" });
    await rejectsWith(approve(bug, f), 409, /already linked to a Linear issue/);
    assert.equal(f.created().length, 0);
  });

  it("sends the files after the issue exists, keeps a failure per file without undoing the issue, and retries only those", async () => {
    const f = fakeLinear();
    const { bug } = await setup(f, { files: { "evidence/a.png": PNG, "evidence/b.txt": Buffer.from("x") } });
    f.behave.put = "fail";
    const done = await approve(bug, f);
    assert.equal(done.state, "sent", "the issue stands");
    assert.deepEqual(Object.values(done.attachments).map((v) => v.split(":")[0]), ["failed", "failed"]);
    assert.ok(f.calls.findIndex((c) => c.query.includes("issueCreate")) < f.calls.findIndex((c) => c.query.includes("fileUpload")), "issue first, files after");
    f.behave.put = "ok";
    const again = await retryAttachments(done.id, f.f, NOENV);
    assert.deepEqual(Object.values(again.attachments), ["ok", "ok"]);
    await rejectsWith(retryAttachments(done.id, f.f, NOENV), 400, /already been attached/);
    assert.equal(f.created().length, 1);
  });

  it("sends the key only to api.linear.app, never to the file storage, and never puts it in an error", async () => {
    const f = fakeLinear();
    const { bug } = await setup(f, { files: { "evidence/a.png": PNG } });
    await approve(bug, f);
    for (const c of f.calls) {
      if (c.url.startsWith("https://api.linear.app/")) assert.equal(c.auth, KEY);
      else assert.equal(c.auth, null, c.url);
    }
    assert.ok(f.calls.some((c) => c.method === "PUT"));
    const g = fakeLinear();
    const s2 = await setup(g);
    g.behave.create = "reject";
    await assert.rejects(approve(s2.bug, g), (e: Error) => !e.message.includes("SECRETKEY"));
  });

  it("leaves no stray files in the uploads folder", async () => {
    const f = fakeLinear();
    const { bug } = await setup(f, { files: { "evidence/a.png": PNG } });
    const before = readdirSync(UPLOAD_DIR).length;
    f.behave.create = "reject";
    await assert.rejects(approve(bug, f));
    assert.equal(readdirSync(UPLOAD_DIR).length, before);
  });
});
