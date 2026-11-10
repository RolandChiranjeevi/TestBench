import "./env.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { db } from "../server/db.ts";
import { ACCESS, levelRank, type Kind, type Level } from "../server/access.ts";
import { createFirstOwner } from "../server/accounts.ts";

// Roles per project, through the real app (app.inject, no port, no network): the access table is walked route by route against every kind of person, so a route that
// lets a person do more than their role (or see another project) is found by name. Rows are put straight into the database, one fresh set for every call, so a route
// that deletes something cannot spoil the next one.
process.env.TESTBENCH_NO_LISTEN = "1";
// Routes that are let through (GitHub runs, Jira and Linear issues, publishing a bug) would call out. Nothing may leave this process: fetch is replaced by a stub that
// records the address and refuses, and the last test checks what was asked.
const outbound: string[] = [];
globalThis.fetch = (async (input: unknown) => { outbound.push(String((input as { url?: string })?.url ?? input)); throw new Error("no network in tests"); }) as typeof fetch;
const { app } = await import("../server/index.ts");
await app.ready();
after(() => app.close());

const GOOD = "a long passphrase here";
type Opts = { cookie?: string; body?: unknown; headers?: Record<string, string>; ip?: string };
const call = (method: string, url: string, o: Opts = {}) =>
  app.inject({ method: method as "GET", url, remoteAddress: o.ip ?? "10.1.1.1", headers: { "x-testbench": "1", ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.headers ?? {}) }, payload: o.body as object | undefined });
const sid = (res: { headers: Record<string, unknown> }) => /tb_sid=([^;]*)/.exec(String(res.headers["set-cookie"] ?? ""))?.[1];

// ---------- people and projects ----------
interface Person { cookie: string; id: number; email: string }
const people: Record<string, Person> = {};
const projects: { A: number; B: number } = { A: 0, B: 0 };
let ownerCookie = "";

async function joinWith(name: string, invite: { projectId?: number; role?: Level }): Promise<Person> {
  const made = await call("POST", "/api/invitations", { cookie: ownerCookie, body: invite });
  assert.equal(made.statusCode, 200, made.body);
  const email = `${name}@example.com`;
  const joined = await call("POST", `/api/join/${made.json().url.split("/").pop()}`, { ip: `10.2.2.${Object.keys(people).length + 1}`, body: { name, email, password: GOOD } });
  assert.equal(joined.statusCode, 200, joined.body);
  return { cookie: `tb_sid=${sid(joined)}`, id: joined.json().user.id, email };
}

describe("setting up: an owner, two projects, and people with different roles", () => {
  it("the owner makes two projects; invitations bring in an admin, a tester and a viewer of A, a tester of B, and someone with no project", async () => {
    createFirstOwner({ email: "anna@example.com", name: "Anna Owner", password: GOOD }, { label: "test" });
    const login = await call("POST", "/api/login", { body: { email: "anna@example.com", password: GOOD } });
    ownerCookie = `tb_sid=${sid(login)}`;
    projects.A = (await call("POST", "/api/projects", { cookie: ownerCookie, body: { name: "Alpha", key: "ALP" } })).json().id;
    projects.B = (await call("POST", "/api/projects", { cookie: ownerCookie, body: { name: "Beta", key: "BET" } })).json().id;
    people.adm = await joinWith("adm", { projectId: projects.A, role: "admin" });
    people.tes = await joinWith("tes", { projectId: projects.A, role: "tester" });
    people.vie = await joinWith("vie", { projectId: projects.A, role: "viewer" });
    people.bob = await joinWith("bob", { projectId: projects.B, role: "tester" });
    people.nob = await joinWith("nob", {});
    const roles = db.prepare("SELECT u.name, m.project_id AS p, m.role FROM project_members m JOIN users u ON u.id = m.user_id ORDER BY u.name").all();
    assert.deepEqual(roles, [
      { name: "adm", p: projects.A, role: "admin" }, { name: "bob", p: projects.B, role: "tester" }, { name: "tes", p: projects.A, role: "tester" }, { name: "vie", p: projects.A, role: "viewer" },
    ]);
  });

  it("each person sees exactly the projects they belong to, with their role; the owner sees all", async () => {
    const list = async (p: string) => ((await call("GET", "/api/projects", { cookie: p === "owner" ? ownerCookie : people[p].cookie })).json() as { key: string; role: string }[]).map((x) => `${x.key}:${x.role}`);
    assert.deepEqual(await list("adm"), ["ALP:admin"]);
    assert.deepEqual(await list("tes"), ["ALP:tester"]);
    assert.deepEqual(await list("vie"), ["ALP:viewer"]);
    assert.deepEqual(await list("bob"), ["BET:tester"]);
    assert.deepEqual(await list("nob"), []);
    assert.deepEqual(await list("owner"), ["ALP:admin", "BET:admin"]);
  });

  it("who was added to what is in the audit log", async () => {
    const log = (await call("GET", "/api/audit-log?limit=200", { cookie: ownerCookie })).json() as { action: string }[];
    assert.ok(log.filter((e) => e.action === "member.added").length >= 4);
  });
});

// ---------- one fresh row of a kind, in a project ----------
let seq = 0;
function fixture(kind: Kind, project: number): { id: number | string } {
  const n = ++seq;
  const one = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { id: number }).id;
  const run = () => one("INSERT INTO runs (project_id, title, kind, source) VALUES (?, ?, 'manual', 'test') RETURNING id", project, `r${n}`);
  const bug = () => one("INSERT INTO bug_reports (project_id, origin_audit_id, source_id, title) VALUES (?, ?, ?, 'Bug') RETURNING id", project, `o${n}`, `s${n}`);
  const requirement = () => one("INSERT INTO requirements (project_id, number, title) VALUES (?, ?, 'Req') RETURNING id", project, n);
  const milestone = () => one("INSERT INTO milestones (project_id, name) VALUES (?, ?) RETURNING id", project, `m${n}`);
  const result = () => one("INSERT INTO results (run_id) VALUES (?) RETURNING id", run());
  const token = (table: string) => one(`INSERT INTO ${table} (project_id, name, prefix, token_hash) VALUES (?, 't', 'x', ?) RETURNING id`, project, `h${n}`);
  switch (kind) {
    case "project": return { id: project };
    case "case": return { id: one("INSERT INTO cases (project_id, number, title) VALUES (?, ?, 'Case') RETURNING id", project, n) };
    case "run": return { id: run() };
    case "result": return { id: result() };
    case "attachment": return { id: one("INSERT INTO attachments (result_id, filename, stored_name, mime) VALUES (?, 'a.txt', ?, 'text/plain') RETURNING id", result(), `att-${n}.txt`) };
    case "automated": return { id: one("INSERT INTO automated_tests (project_id, framework, title, full_name) VALUES (?, 'playwright', 't', ?) RETURNING id", project, `f${n}`) };
    case "requirement": return { id: requirement() };
    case "reqattachment": return { id: one("INSERT INTO requirement_attachments (requirement_id, filename, stored_name, mime) VALUES (?, 'r.txt', ?, 'text/plain') RETURNING id", requirement(), `req-${n}.txt`) };
    case "proposal": return { id: one("INSERT INTO requirement_proposals (project_id, title) VALUES (?, 'Prop') RETURNING id", project) };
    case "observation": return { id: one("INSERT INTO observations (project_id, number, source_id, origin_audit_id, kind, title, severity, content_hash) VALUES (?, ?, ?, 'o', 'load_test', 'Obs', 'low', 'h') RETURNING id", project, n, `s${n}`) };
    case "bug": return { id: bug() };
    case "bugpublication": return { id: one("INSERT INTO bug_publications (bug_report_id, destination, mode, state) VALUES (?, 'github', 'create', 'pending') RETURNING id", bug()) };
    case "manualtest": return { id: one("INSERT INTO manual_tests (project_id, origin_audit_id, source_id, title, category, agent_priority) VALUES (?, 'o', ?, 'MT', 'c', 'p') RETURNING id", project, `s${n}`) };
    case "audit": return { id: one("INSERT INTO audits (project_id, agent_audit_id, source) VALUES (?, ?, 'test') RETURNING id", project, `a${n}`) };
    case "milestone": return { id: milestone() };
    case "checklist": return { id: one("INSERT INTO milestone_checklist (milestone_id, title) VALUES (?, 'c') RETURNING id", milestone()) };
    case "suite": return { id: one("INSERT INTO suites (project_id, name) VALUES (?, ?) RETURNING id", project, `s${n}`) };
    case "template": return { id: one("INSERT INTO run_templates (project_id, name) VALUES (?, ?) RETURNING id", project, `t${n}`) };
    case "githubsource": return { id: one("INSERT INTO github_sources (project_id, owner, repo) VALUES (?, 'o', ?) RETURNING id", project, `r${n}`) };
    case "agenttoken": return { id: token("agent_tokens") };
    case "citoken": return { id: token("ci_tokens") };
    case "proposetoken": return { id: token("propose_tokens") };
    case "file": {
      const name = `file-${n}.txt`;
      db.prepare("INSERT INTO attachments (result_id, filename, stored_name, mime) VALUES (?, 'f.txt', ?, 'text/plain')").run(result(), name);
      return { id: name };
    }
  }
}
const projectNeeds = Object.entries(ACCESS).filter((e): e is [string, { level: Level; kind: Kind; via?: string }] => typeof e[1] === "object");
const kindsInTable = [...new Set(projectNeeds.map(([, n]) => n.kind))];

describe("every kind of id leads to the right project", () => {
  it("a thing made in A is A's, one made in B is B's (all kinds, and a stored file); odd ids lead nowhere", async () => {
    const { projectOf, projectOfFile } = await import("../server/resolve.ts");
    for (const kind of kindsInTable) {
      for (const [label, project] of [["A", projects.A], ["B", projects.B]] as const) {
        const f = fixture(kind, project);
        const found = kind === "file" ? projectOfFile(String(f.id)) : projectOf(kind, f.id);
        assert.equal(found, project, `${kind} made in ${label}`);
      }
    }
    assert.equal(projectOf("case", 999999), null);
    assert.equal(projectOf("case", "12abc"), null);
    assert.equal(projectOf("case", "1; DROP TABLE cases"), null);
    assert.equal(projectOfFile("../../etc/passwd"), null);
    assert.equal(projectOfFile("no-such-file"), null);
  });
});

// ---------- the matrix: every project route against every kind of person ----------
type Res = { statusCode: number; body: string };
const denied404 = (r: Res) => r.statusCode === 404 && r.body === JSON.stringify({ error: "Not found" });
const denied403 = (r: Res) => r.statusCode === 403 && /This needs the (viewer|tester|admin) role in this project; you are a (viewer|tester|admin)/.test(r.body);

function aim(route: string, kind: Kind, project: number) {
  const [method, pattern] = route.split(" ");
  const f = fixture(kind, project);
  const url = pattern.replace(/:id\b|\*$/, String(f.id)).replace(/:(stepId|runId|userId)\b/g, "1");
  return { method, url, id: f.id };
}
const bodyFor = (route: string, project: number): unknown => {
  if (route.startsWith("GET ")) return undefined;
  if (route === "POST /api/link-suggestions/dismiss") return { testId: fixture("automated", project).id, caseId: 1 };
  return {};
};

describe("the matrix: each person gets what their role allows, on every project route", () => {
  const actors: [string, () => string | undefined][] = [
    ["owner", () => ownerCookie], ["adm", () => people.adm.cookie], ["tes", () => people.tes.cookie], ["vie", () => people.vie.cookie], ["bob", () => people.bob.cookie], ["nob", () => people.nob.cookie], ["anon", () => undefined],
  ];
  const roleIn = (who: string, project: number): Level | "owner" | null =>
    who === "owner" ? "owner" : who === "bob" ? (project === projects.B ? "tester" : null) : who === "nob" || who === "anon" ? null : project === projects.A ? ({ adm: "admin", tes: "tester", vie: "viewer" } as Record<string, Level>)[who] : null;

  it("every project route × 7 people × 2 projects: denied by role, denied by project, or let through to the route", async () => {
    let checks = 0;
    for (const [route, need] of projectNeeds) {
      for (const [project, label] of [[projects.A, "A"], [projects.B, "B"]] as const) {
        for (const [who, cookie] of actors) {
          const { method, url } = aim(route, need.kind, project);
          const res = await call(method, url, { cookie: cookie(), body: bodyFor(route, project) });
          const role = roleIn(who, project);
          const where = `${who} ${route} in ${label}`;
          const shown = `${res.statusCode} ${res.body.slice(0, 120)}`;
          if (who === "anon") assert.equal(res.statusCode, url.startsWith("/api/") ? 401 : 302, where); // a page or file goes to the login, the API says 401
          else if (role === null) assert.ok(denied404(res), `${where}: a stranger to the project must get the plain 404, got ${shown}`);
          else if (role === "owner" || levelRank(role) >= levelRank(need.level)) assert.ok(!denied404(res) && !denied403(res), `${where}: should reach the route, got ${shown}`);
          else assert.ok(denied403(res), `${where}: a ${role} needs ${need.level}, got ${shown}`);
          checks++;
        }
      }
    }
    assert.ok(checks > 1500, `only ${checks} checks ran`);
  });

  it("a stranger cannot tell a thing of another project from a thing that does not exist", async () => {
    for (const [route, need] of projectNeeds.filter(([, n]) => n.kind !== "project" && !n.via)) {
      const real = aim(route, need.kind, projects.B);
      const missing = await call(real.method, real.url.replace(String(real.id), "99999999"), { cookie: people.adm.cookie, body: bodyFor(route, projects.B) });
      const other = await call(real.method, real.url, { cookie: people.adm.cookie, body: bodyFor(route, projects.B) });
      assert.deepEqual([other.statusCode, other.body], [missing.statusCode, missing.body], route);
    }
  });
});

describe("uploaded files follow their project", () => {
  it("a stored file is served to a member of its project and to nobody else; a name nobody owns is not served", async () => {
    const inA = fixture("file", projects.A).id as string;
    const inB = fixture("file", projects.B).id as string;
    for (const [who, name, ok] of [["vie", inA, true], ["adm", inA, true], ["bob", inA, false], ["nob", inA, false], ["tes", inB, false], ["bob", inB, true]] as const) {
      const r = await call("GET", `/uploads/${name}`, { cookie: people[who].cookie });
      assert.equal(denied404(r), !ok, `${who} ${name}: ${r.statusCode} ${r.body.slice(0, 80)}`);
    }
    assert.equal((await call("GET", `/uploads/${inA}`)).statusCode, 302, "not signed in: sent to the login");
    assert.ok(denied404(await call("GET", "/uploads/not-a-stored-name.png", { cookie: people.adm.cookie })));
    assert.ok(!denied404(await call("GET", `/uploads/${inA}`, { cookie: ownerCookie })), "the owner reaches every file");
  });
});

describe("members: who may add, change and remove, and what takes effect at once", () => {
  const members = (cookie: string, project = projects.A) => call("GET", `/api/projects/${project}/members`, { cookie });

  it("everyone in a project sees who is in it; only an admin sees the email addresses", async () => {
    const asViewer = (await members(people.vie.cookie)).json() as Record<string, unknown>[];
    assert.deepEqual(asViewer.map((m) => [m.name, m.role]), [["adm", "admin"], ["tes", "tester"], ["vie", "viewer"]]);
    assert.ok(asViewer.every((m) => !("email" in m)));
    const asAdmin = (await members(people.adm.cookie)).json() as Record<string, unknown>[];
    assert.ok(asAdmin.every((m) => typeof m.email === "string"));
    assert.deepEqual((await call("GET", `/api/projects/${projects.A}/me`, { cookie: people.tes.cookie })).json(), { role: "tester", isOwner: false });
    assert.ok(denied404(await members(people.bob.cookie)), "another project's members are not visible");
  });

  it("an admin adds an existing account by email; a tester or viewer cannot; the answer says when there is no such account", async () => {
    const add = (cookie: string, email: string, role = "viewer") => call("POST", `/api/projects/${projects.A}/members`, { cookie, body: { email, role } });
    assert.ok(denied403(await add(people.tes.cookie, people.nob.email)));
    assert.ok(denied403(await add(people.vie.cookie, people.nob.email)));
    assert.equal((await add(people.adm.cookie, "nobody@example.com")).statusCode, 404);
    assert.equal((await add(people.adm.cookie, people.nob.email, "superuser")).statusCode, 400);
    assert.equal((await add(people.adm.cookie, "anna@example.com")).statusCode, 400, "the owner needs no role");
    assert.equal((await add(people.adm.cookie, people.tes.email)).statusCode, 409, "already a member");
    const ok = await add(people.adm.cookie, people.nob.email, "viewer");
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal((await call("GET", `/api/projects/${projects.A}/requirements`, { cookie: people.nob.cookie })).statusCode, 200, "the new member reads at once, with the session they already had");
    assert.ok(denied403(await call("POST", `/api/projects/${projects.A}/requirements`, { cookie: people.nob.cookie, body: { title: "x" } })), "as a viewer, writing is refused");
  });

  it("changing a role takes effect on the next request, up and down", async () => {
    const patch = (role: string) => call("PATCH", `/api/projects/${projects.A}/members/${people.nob.id}`, { cookie: people.adm.cookie, body: { role } });
    const write = () => call("POST", `/api/projects/${projects.A}/requirements`, { cookie: people.nob.cookie, body: { title: "From nob" } });
    assert.equal((await patch("tester")).statusCode, 200);
    assert.equal((await write()).statusCode, 200);
    assert.equal((await patch("viewer")).statusCode, 200);
    assert.ok(denied403(await write()));
    assert.ok(denied403(await call("PATCH", `/api/projects/${projects.A}/members/${people.nob.id}`, { cookie: people.tes.cookie, body: { role: "admin" } })), "a tester cannot make an admin");
    assert.equal((await call("PATCH", `/api/projects/${projects.A}/members/999999`, { cookie: people.adm.cookie, body: { role: "viewer" } })).statusCode, 404);
  });

  it("removing a member ends their access at once, though their session lives on", async () => {
    assert.equal((await call("DELETE", `/api/projects/${projects.A}/members/${people.nob.id}`, { cookie: people.adm.cookie })).statusCode, 200);
    assert.ok(denied404(await call("GET", `/api/projects/${projects.A}/requirements`, { cookie: people.nob.cookie })));
    assert.equal((await call("GET", "/api/me", { cookie: people.nob.cookie })).statusCode, 200, "still signed in; just without the project");
    assert.deepEqual((await call("GET", "/api/projects", { cookie: people.nob.cookie })).json(), []);
  });

  it("the last admin cannot be removed or lowered by an admin; the owner can; with another admin first it works", async () => {
    const adm = people.adm;
    assert.equal((await call("DELETE", `/api/projects/${projects.A}/members/${adm.id}`, { cookie: adm.cookie })).statusCode, 409);
    assert.equal((await call("PATCH", `/api/projects/${projects.A}/members/${adm.id}`, { cookie: adm.cookie, body: { role: "tester" } })).statusCode, 409);
    assert.equal((await call("PATCH", `/api/projects/${projects.A}/members/${people.tes.id}`, { cookie: adm.cookie, body: { role: "admin" } })).statusCode, 200);
    assert.equal((await call("PATCH", `/api/projects/${projects.A}/members/${adm.id}`, { cookie: adm.cookie, body: { role: "tester" } })).statusCode, 200, "now there is another admin");
    assert.equal((await call("PATCH", `/api/projects/${projects.A}/members/${adm.id}`, { cookie: ownerCookie, body: { role: "admin" } })).statusCode, 200);
    assert.equal((await call("PATCH", `/api/projects/${projects.A}/members/${people.tes.id}`, { cookie: ownerCookie, body: { role: "tester" } })).statusCode, 200);
    const now = (await members(ownerCookie)).json() as { name: string; role: string }[];
    assert.deepEqual(now.map((m) => [m.name, m.role]), [["adm", "admin"], ["tes", "tester"], ["vie", "viewer"]]);
  });

  it("a switched-off account loses its projects at once; switched on again it has them back", async () => {
    assert.equal((await call("POST", `/api/users/${people.vie.id}/disable`, { cookie: ownerCookie })).statusCode, 200);
    assert.equal((await call("GET", `/api/projects/${projects.A}/requirements`, { cookie: people.vie.cookie })).statusCode, 401);
    assert.equal((await call("POST", `/api/users/${people.vie.id}/enable`, { cookie: ownerCookie })).statusCode, 200);
    const again = await call("POST", "/api/login", { body: { email: people.vie.email, password: GOOD } });
    people.vie.cookie = `tb_sid=${sid(again)}`; // the old session ended with the switch-off
    assert.equal((await call("GET", `/api/projects/${projects.A}/requirements`, { cookie: people.vie.cookie })).statusCode, 200);
  });

  it("member changes are in the audit log, with the project", async () => {
    const log = (await call("GET", "/api/audit-log?limit=500", { cookie: ownerCookie })).json() as { action: string; projectId: number | null }[];
    for (const a of ["member.added", "member.role_changed", "member.removed"]) assert.ok(log.some((e) => e.action === a && e.projectId === projects.A), a);
  });
});

describe("invitations for a project", () => {
  it("an admin invites to their own project with a role, and sees and revokes only those; nobody invites to a project they do not administer", async () => {
    const adm = people.adm.cookie;
    const made = await call("POST", "/api/invitations", { cookie: adm, body: { projectId: projects.A, role: "viewer", note: "for Carol" } });
    assert.equal(made.statusCode, 200, made.body);
    const mine = (await call("GET", "/api/invitations", { cookie: adm })).json() as { project: { id: number } | null }[];
    assert.ok(mine.length >= 1 && mine.every((l) => l.project?.id === projects.A), "an admin sees only the invitations of their own projects");
    assert.equal((await call("POST", "/api/invitations", { cookie: adm, body: {} })).statusCode, 403, "an account that belongs to no project is the owner's to make");
    assert.equal((await call("POST", "/api/invitations", { cookie: adm, body: { projectId: projects.B, role: "viewer" } })).statusCode, 404, "not their project");
    assert.equal((await call("POST", "/api/invitations", { cookie: people.tes.cookie, body: { projectId: projects.A, role: "viewer" } })).statusCode, 404, "a tester cannot invite");
    assert.equal((await call("POST", "/api/invitations", { cookie: adm, body: { projectId: projects.A, role: "boss" } })).statusCode, 400);
    assert.equal((await call("GET", "/api/invitations", { cookie: people.tes.cookie })).statusCode, 403);
    assert.equal((await call("POST", `/api/invitations/${made.json().id}/revoke`, { cookie: people.bob.cookie })).statusCode, 404, "another project's member cannot revoke it");
    assert.equal((await call("POST", `/api/invitations/${made.json().id}/revoke`, { cookie: adm })).statusCode, 200);
  });

  it("the person who accepts becomes a member with the role, and only of that project", async () => {
    const made = (await call("POST", "/api/invitations", { cookie: people.adm.cookie, body: { projectId: projects.A, role: "tester" } })).json();
    const joined = await call("POST", `/api/join/${made.url.split("/").pop()}`, { ip: "10.9.9.9", body: { name: "Carol", email: "carol@example.com", password: GOOD } });
    assert.equal(joined.statusCode, 200);
    const cookie = `tb_sid=${sid(joined)}`;
    assert.deepEqual(((await call("GET", "/api/projects", { cookie })).json() as { key: string; role: string }[]).map((p) => [p.key, p.role]), [["ALP", "tester"]]);
    assert.ok(denied404(await call("GET", `/api/projects/${projects.B}/cases`, { cookie })));
  });
});

describe("only the owner makes projects and runs the installation", () => {
  it("an admin of a project cannot make a project, back up, restore, load the demo or read the accounts", async () => {
    for (const [m, url] of [["POST", "/api/projects"], ["POST", "/api/demo"], ["GET", "/api/backup"], ["POST", "/api/restore"], ["GET", "/api/users"], ["GET", "/api/audit-log"], ["PUT", "/api/settings/agent-proposals"], ["POST", `/api/users/${people.tes.id}/disable`]] as const) {
      const r = await call(m, url, { cookie: people.adm.cookie, body: m === "GET" ? undefined : { name: "X", key: "XX" } });
      assert.equal(r.statusCode, 403, `${m} ${url}`);
      assert.equal(r.json().error, "Only the owner can do this");
    }
  });
});

describe("a requirement keeps the account next to the name", () => {
  it("created by and approved by name the person and the account; a proposal's decision too", async () => {
    const made = (await call("POST", `/api/projects/${projects.A}/requirements`, { cookie: people.tes.cookie, body: { title: "Traced", status: "approved" } })).json();
    const row = db.prepare("SELECT created_by, created_by_user_id AS c, approved_by, approved_by_user_id AS a FROM requirements WHERE id = ?").get(made.id);
    assert.deepEqual(row, { created_by: "tes", c: people.tes.id, approved_by: "tes", a: people.tes.id });
    const proposal = fixture("proposal", projects.A).id;
    assert.equal((await call("POST", `/api/requirement-proposals/${proposal}/reject`, { cookie: people.tes.cookie, body: { reason: "not needed" } })).statusCode, 200);
    assert.equal((db.prepare("SELECT decided_by_user_id AS d FROM requirement_proposals WHERE id = ?").get(proposal) as { d: number }).d, people.tes.id);
  });

  it("the database refuses an AI-suggested requirement approved by a name alone once accounts exist", () => {
    assert.throws(() => db.prepare("INSERT INTO requirements (project_id, number, title, origin, status, created_by, approved_by) VALUES (?, 9000, 'AI', 'ai_suggestion', 'approved', 'agent', 'Someone')").run(projects.A), /person with an account/);
    assert.doesNotThrow(() => db.prepare("INSERT INTO requirements (project_id, number, title, origin, status, created_by, approved_by, approved_by_user_id) VALUES (?, 9001, 'AI', 'ai_suggestion', 'approved', 'agent', 'tes', ?)").run(projects.A, people.tes.id));
  });
});

describe("an import is drafts until a person approves them, with their account", () => {
  const file = (key: string) => JSON.stringify({ format: "testbench-requirements", version: 1, project: key, requirements: [
    { id: "IMP-1", title: "Imported one", status: "active" }, { id: "IMP-2", title: "Imported two", status: "approved" },
  ] });

  it("a tester imports, the requirements are drafts that name who imported them; a viewer cannot approve; the tester approves and the account is recorded and logged", async () => {
    const key = (db.prepare("SELECT key FROM projects WHERE id = ?").get(projects.A) as { key: string }).key;
    const imported = await call("POST", `/api/projects/${projects.A}/requirements/import`, { cookie: people.tes.cookie, body: { content: file(key), fileName: "shop.json" } });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.equal(imported.json().asDrafts, 2);
    const rows = db.prepare("SELECT id, status, imported_by, imported_by_user_id AS uid, import_ref, approved_by FROM requirements WHERE project_id = ? AND external_id LIKE 'IMP-%' ORDER BY external_id").all(projects.A) as { id: number; status: string; imported_by: string; uid: number; import_ref: string; approved_by: string }[];
    assert.deepEqual(rows.map((r) => [r.status, r.imported_by, r.uid, r.import_ref, r.approved_by]), [["draft", "tes", people.tes.id, "shop.json", ""], ["draft", "tes", people.tes.id, "shop.json", ""]]);

    assert.ok(denied403(await call("POST", `/api/projects/${projects.A}/requirements/approve-imported`, { cookie: people.vie.cookie, body: {} })), "a viewer cannot");
    assert.ok(denied404(await call("POST", `/api/projects/${projects.A}/requirements/approve-imported`, { cookie: people.bob.cookie, body: {} })), "nor someone outside the project");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM requirements WHERE project_id = ? AND status = 'draft' AND origin = 'import'").get(projects.A) as { n: number }).n >= 2, true, "nothing was approved");

    const one = await call("POST", `/api/projects/${projects.A}/requirements/approve-imported`, { cookie: people.adm.cookie, body: { ids: [rows[0].id] } });
    assert.deepEqual([one.statusCode, one.json().approved], [200, 1]);
    const all = await call("POST", `/api/projects/${projects.A}/requirements/approve-imported`, { cookie: people.tes.cookie, body: {} });
    assert.equal(all.json().approved >= 1, true);
    const done = db.prepare("SELECT approved_by, approved_by_user_id AS uid, status FROM requirements WHERE id IN (?, ?) ORDER BY id").all(rows[0].id, rows[1].id);
    assert.deepEqual(done, [{ approved_by: "adm", uid: people.adm.id, status: "approved" }, { approved_by: "tes", uid: people.tes.id, status: "approved" }], "each approver is an account");

    const log = (await call("GET", "/api/audit-log?limit=20&action=requirements.", { cookie: ownerCookie })).json() as { actorUserId: number; projectId: number; detail: { count: number } }[];
    assert.deepEqual(log.slice(0, 2).map((e) => [e.actorUserId, e.projectId, e.detail.count]), [[people.tes.id, projects.A, all.json().approved], [people.adm.id, projects.A, 1]], "newest first, with the account");
  });
});

describe("adding a suggestion to the project", () => {
  const stateOf = (id: number | string) => db.prepare("SELECT review_status AS s, case_id AS c FROM manual_tests WHERE id = ?").get(id) as { s: string; c: number | null };

  it("a tester adds it as a draft; a viewer and a stranger cannot; repeating it, or adding a dismissed one, is 409", async () => {
    const id = fixture("manualtest", projects.A).id;
    const url = `/api/manual-tests/${id}/add-to-project`;
    assert.ok(denied403(await call("POST", url, { cookie: people.vie.cookie, body: {} })), "a viewer cannot");
    assert.ok(denied404(await call("POST", url, { cookie: people.bob.cookie, body: {} })), "nor someone from another project");
    assert.deepEqual(stateOf(id), { s: "proposed", c: null }, "nothing changed");

    const added = await call("POST", url, { cookie: people.tes.cookie, body: { note: "Checked it" } });
    assert.equal(added.statusCode, 200, added.body);
    assert.deepEqual([added.json().manualTest.status, added.json().manualTest.testCase.status, added.json().manualTest.reviewNote], ["accepted", "draft", "Checked it"]);
    assert.match(added.json().case.key, /^ALP-\d+$/);

    const again = await call("POST", url, { cookie: people.tes.cookie, body: {} });
    assert.equal(again.statusCode, 409);
    assert.match(again.json().error, /already the test case/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM cases WHERE id IN (SELECT case_id FROM manual_tests WHERE id = ?)").get(id) as { n: number }).n, 1);

    const dismissed = fixture("manualtest", projects.A).id;
    assert.equal((await call("POST", `/api/manual-tests/${dismissed}/review`, { cookie: people.tes.cookie, body: { status: "rejected" } })).statusCode, 200);
    const refused = await call("POST", `/api/manual-tests/${dismissed}/add-to-project`, { cookie: people.tes.cookie, body: {} });
    assert.equal(refused.statusCode, 409);
    assert.match(refused.json().error, /Restore it to Suggested first/);
    assert.equal((await call("POST", `/api/manual-tests/${dismissed}/review`, { cookie: people.tes.cookie, body: { status: "proposed" } })).statusCode, 200, "restored");
    assert.equal((await call("POST", `/api/manual-tests/${dismissed}/add-to-project`, { cookie: people.tes.cookie, body: {} })).statusCode, 200);
  });

  it("an admin of another project cannot add a suggestion of this one, and gets the same 404 as for one that does not exist", async () => {
    const inB = fixture("manualtest", projects.B).id;
    const other = await call("POST", `/api/manual-tests/${inB}/add-to-project`, { cookie: people.adm.cookie, body: {} });
    const missing = await call("POST", "/api/manual-tests/99999999/add-to-project", { cookie: people.adm.cookie, body: {} });
    assert.deepEqual([other.statusCode, other.body], [missing.statusCode, missing.body]);
    assert.deepEqual(stateOf(inB), { s: "proposed", c: null });
  });
});

describe("an agent can never approve, reject, generate or change anything but its own route", () => {
  it("every route except the three token routes refuses an agent, CI or proposal token, with or without a login", async () => {
    assert.equal((await call("PUT", "/api/settings/agent-proposals", { cookie: ownerCookie, body: { enabled: true } })).statusCode, 200);
    // a project of its own: the matrix above filled A with token rows, and a project holds only a few active tokens
    const fresh = (await call("POST", "/api/projects", { cookie: ownerCookie, body: { name: "Gamma", key: "GAM" } })).json().id as number;
    const made = [
      await call("POST", `/api/projects/${fresh}/agent/tokens`, { cookie: ownerCookie, body: { name: "r" } }),
      await call("POST", `/api/projects/${fresh}/ci/tokens`, { cookie: ownerCookie, body: { name: "c" } }),
      await call("POST", `/api/projects/${fresh}/propose-tokens`, { cookie: ownerCookie, body: { name: "p" } }),
    ];
    const tokens = made.map((r) => r.json().token as string);
    assert.ok(tokens.every((t) => typeof t === "string" && t.length > 20), `the three tokens were made: ${made.map((r) => r.statusCode + " " + r.body.slice(0, 80)).join(" | ")}`);
    const routes = Object.entries(ACCESS).filter(([, n]) => n !== "token");
    let refused = 0;
    for (const token of tokens) {
      for (const cookie of [undefined, ownerCookie, people.adm.cookie]) {
        for (const [route, need] of routes) {
          const { method, url } = typeof need === "object" ? aim(route, need.kind, projects.A) : { method: route.split(" ")[0], url: route.split(" ")[1].replace(/:\w+|\*/g, "1") };
          const r = await call(method, url, { cookie, headers: { authorization: `Bearer ${token}` }, body: method === "GET" ? undefined : {} });
          assert.ok([401, 403].includes(r.statusCode) || (r.statusCode === 302 && !cookie && !url.startsWith("/api/")), `${method} ${url} with a token${cookie ? " and a login" : ""} answered ${r.statusCode}`); // 302: a page or file goes to the login
          refused++;
        }
      }
    }
    assert.ok(refused > 1500, `only ${refused} requests were made`);
  });

  it("generating proposals and deciding them need a person with a role: a viewer cannot, a tester can, a stranger sees nothing", async () => {
    assert.ok(denied403(await call("POST", `/api/projects/${projects.A}/generate-proposals`, { cookie: people.vie.cookie })));
    assert.ok(!denied403(await call("POST", `/api/projects/${projects.A}/generate-proposals`, { cookie: people.tes.cookie })));
    const p = fixture("proposal", projects.A).id;
    assert.ok(denied403(await call("POST", `/api/requirement-proposals/${p}/approve`, { cookie: people.vie.cookie })));
    assert.ok(denied404(await call("POST", `/api/requirement-proposals/${p}/approve`, { cookie: people.bob.cookie })));
  });
});

describe("restoring a backup keeps who is a member of what", () => {
  const scratch = mkdtempSync(join(tmpdir(), "tb-roles-restore-"));
  after(() => rmSync(scratch, { recursive: true, force: true }));
  const members = () => db.prepare("SELECT u.name, m.project_id AS p, m.role FROM project_members m JOIN users u ON u.id = m.user_id ORDER BY m.project_id, u.name").all();

  it("a backup with members, restored through the real route as the owner, brings the memberships back and access works for each role; a stranger still gets 404", async () => {
    // 1. a backup that holds the members (a synthetic one: a copy of the live database in a zip)
    const before = members();
    assert.ok(before.length >= 5, "the backup has members to keep");
    const file = join(scratch, "with-members.db");
    await db.backup(file);
    const manifest = { format: "testbench-backup/1", createdAt: new Date().toISOString(), projects: 0, cases: 0, runs: 0, uploadFiles: 0 };
    const zip = Buffer.from(zipSync({ "manifest.json": strToU8(JSON.stringify(manifest)), "testbench.db": new Uint8Array(readFileSync(file)) }));

    // memberships change after the backup: the restore must undo that
    assert.equal((await call("DELETE", `/api/projects/${projects.A}/members/${people.tes.id}`, { cookie: ownerCookie })).statusCode, 200);
    assert.equal((await call("PATCH", `/api/projects/${projects.A}/members/${people.vie.id}`, { cookie: ownerCookie, body: { role: "admin" } })).statusCode, 200);
    assert.notDeepEqual(members(), before);

    // 2. restore through the real route
    const boundary = "----tbroles" + Date.now();
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.zip"\r\nContent-Type: application/zip\r\n\r\n`);
    const res = await app.inject({
      method: "POST", url: "/api/restore", remoteAddress: "10.1.1.1",
      headers: { "x-testbench": "1", cookie: ownerCookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([head, zip, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    });
    assert.equal(res.statusCode, 200, res.body);

    // 3. the memberships are those of the backup, not those of before the restore
    assert.deepEqual(members(), before);
    assert.equal((await call("GET", `/api/projects/${projects.A}/requirements`, { cookie: people.adm.cookie })).statusCode, 401, "every session ended with the restore: everyone signs in again");

    // 4. access works after the restore, for each role
    const again = async (p: Person) => `tb_sid=${sid(await call("POST", "/api/login", { body: { email: p.email, password: GOOD } }))}`;
    const [adm, tes, vie, bob, nob] = [await again(people.adm), await again(people.tes), await again(people.vie), await again(people.bob), await again(people.nob)];
    const read = (cookie: string) => call("GET", `/api/projects/${projects.A}/requirements`, { cookie });
    const write = (cookie: string) => call("POST", `/api/projects/${projects.A}/requirements`, { cookie, body: { title: "After restore" } });
    const administer = (cookie: string) => call("GET", `/api/projects/${projects.A}/agent/tokens`, { cookie });
    assert.deepEqual([(await read(adm)).statusCode, (await write(adm)).statusCode, (await administer(adm)).statusCode], [200, 200, 200], "admin");
    assert.deepEqual([(await read(tes)).statusCode, (await write(tes)).statusCode], [200, 200], "tester reads and writes");
    assert.ok(denied403(await administer(tes)), "a tester does not administer");
    assert.equal((await read(vie)).statusCode, 200, "viewer reads");
    assert.ok(denied403(await write(vie)), "a viewer does not write (the role in the backup was viewer, not the admin it was changed to)");

    // 5. someone who is not a member of the project is told it does not exist
    assert.ok(denied404(await read(bob)), "a member of another project");
    assert.ok(denied404(await read(nob)), "an account with no project");
    assert.ok(denied404(await call("GET", `/uploads/${fixture("file", projects.A).id}`, { cookie: bob })), "a file of the project");
    assert.deepEqual(((await call("GET", "/api/projects", { cookie: bob })).json() as { key: string }[]).map((p) => p.key), ["BET"]);
    people.adm.cookie = adm; people.tes.cookie = tes; people.vie.cookie = vie; people.bob.cookie = bob; people.nob.cookie = nob;
    ownerCookie = `tb_sid=${sid(await call("POST", "/api/login", { body: { email: "anna@example.com", password: GOOD } }))}`;
  });
});

describe("nothing left this process", () => {
  it("the routes that were let through asked for outside addresses, and every one was refused by the stub", () => {
    assert.ok(outbound.every((u) => /^https?:\/\//.test(u)), outbound.join(", "));
  });
});
