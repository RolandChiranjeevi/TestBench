import "./env.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { db, UPLOAD_DIR } from "../server/db.ts";
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
    case "automationsuggestion": {
      const audit = one("INSERT INTO audits (project_id, agent_audit_id, source) VALUES (?, ?, 'test') RETURNING id", project, `a${n}`);
      return { id: one("INSERT INTO automation_suggestions (project_id, audit_id, subject_ref, rule, proposed_by, summary, steps) VALUES (?, ?, 'TPI-1', 'scripted_from_plan_item', 'rule', 'Automate it', '[\"A step\"]') RETURNING id", project, audit) };
    }
    case "bugdraft": return { id: one("INSERT INTO bug_drafts (project_id, number, proposed_by, title, steps, screenshot_name) VALUES (?, ?, 'rule', 'Draft', '[\"A step\"]', ?) RETURNING id", project, n, `draft-${n}.png`) };
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

describe("confirming a bug suggestion", () => {
  const rowOf = (id: number | string) => db.prepare("SELECT review_status AS s, reviewed_by AS by, reviewed_by_user_id AS uid FROM bug_reports WHERE id = ?").get(id) as { s: string; by: string; uid: number | null };

  it("a tester confirms, dismisses, restores and marks a duplicate, and the account is saved each time; a viewer gets 403 and a stranger 404, and nothing changes", async () => {
    const id = fixture("bug", projects.A).id;
    const url = `/api/bug-reports/${id}/review`;
    assert.ok(denied403(await call("POST", url, { cookie: people.vie.cookie, body: { status: "accepted" } })), "a viewer cannot");
    assert.ok(denied404(await call("POST", url, { cookie: people.bob.cookie, body: { status: "accepted" } })), "nor someone from another project");
    assert.equal(rowOf(id).s, "proposed");

    assert.equal((await call("POST", url, { cookie: people.tes.cookie, body: { status: "accepted" } })).statusCode, 200);
    assert.deepEqual([rowOf(id).s, rowOf(id).uid], ["accepted", people.tes.id]);
    assert.ok(rowOf(id).by, "the name is saved too");
    assert.equal((await call("POST", url, { cookie: people.adm.cookie, body: { status: "rejected", note: "not a bug" } })).statusCode, 200);
    assert.deepEqual([rowOf(id).s, rowOf(id).uid], ["rejected", people.adm.id]);
    assert.equal((await call("POST", url, { cookie: people.tes.cookie, body: { status: "proposed" } })).statusCode, 200, "restored");
    assert.deepEqual([rowOf(id).s, rowOf(id).uid], ["proposed", people.tes.id]);
    assert.equal((await call("POST", url, { cookie: people.tes.cookie, body: { status: "accepted" } })).statusCode, 200);
    const back = await call("POST", url, { cookie: people.tes.cookie, body: { status: "proposed" } });
    assert.equal(back.statusCode, 409, "a confirmed bug is not restored");
    assert.equal(rowOf(id).s, "accepted");
    assert.equal((await call("POST", url, { cookie: people.tes.cookie, body: { status: "rejected" } })).statusCode, 200);
    assert.equal((await call("POST", url, { cookie: people.tes.cookie, body: { status: "proposed" } })).statusCode, 200, "a dismissed one is");

    const other = fixture("bug", projects.A).id;
    assert.ok(denied403(await call("POST", `/api/bug-reports/${id}/duplicate`, { cookie: people.vie.cookie, body: { ofId: other } })));
    assert.equal((await call("POST", `/api/bug-reports/${id}/duplicate`, { cookie: people.tes.cookie, body: { ofId: other } })).statusCode, 200);
    assert.deepEqual([rowOf(id).s, rowOf(id).uid], ["duplicate", people.tes.id]);
  });

  it("the detail says who confirmed it", async () => {
    const id = fixture("bug", projects.A).id;
    await call("POST", `/api/bug-reports/${id}/review`, { cookie: people.tes.cookie, body: { status: "accepted" } });
    const detail = await call("GET", `/api/bug-reports/${id}`, { cookie: people.vie.cookie });
    assert.equal(detail.json().reviewedBy, rowOf(id).by);
    assert.ok(detail.json().reviewedAt);
  });
});

describe("deciding a bug's severity", () => {
  const sevOf = (id: number | string) => db.prepare("SELECT human_severity AS s, agent_severity AS a, severity_by_user_id AS uid, severity_reason AS r FROM bug_reports WHERE id = ?").get(id) as { s: string | null; a: string | null; uid: number | null; r: string };

  it("a tester sets it, with a reason, and changes it; an admin too; a viewer gets 403 and a stranger 404, and nothing changes", async () => {
    const id = fixture("bug", projects.A).id;
    const url = `/api/bug-reports/${id}`;
    assert.ok(denied403(await call("PATCH", url, { cookie: people.vie.cookie, body: { humanSeverity: "critical" } })), "a viewer cannot");
    assert.ok(denied404(await call("PATCH", url, { cookie: people.bob.cookie, body: { humanSeverity: "critical" } })), "nor someone from another project");
    assert.equal(sevOf(id).s, null);
    const set = await call("PATCH", url, { cookie: people.tes.cookie, body: { humanSeverity: "high", severityReason: "checkout" } });
    assert.equal(set.statusCode, 200, set.body);
    assert.deepEqual([sevOf(id).s, sevOf(id).uid, sevOf(id).r], ["high", people.tes.id, "checkout"]);
    assert.deepEqual([set.json().severity.human, set.json().severity.source], ["high", "human"]);
    assert.equal((await call("PATCH", url, { cookie: people.adm.cookie, body: { humanSeverity: "critical" } })).statusCode, 200);
    assert.deepEqual([sevOf(id).s, sevOf(id).uid], ["critical", people.adm.id]);
    assert.equal((await call("PATCH", url, { cookie: people.tes.cookie, body: { humanSeverity: "urgent" } })).statusCode, 400, "only the four values");
    assert.equal((await call("PATCH", url, { cookie: people.tes.cookie, body: { humanSeverity: "low", severityReason: "x".repeat(201) } })).statusCode, 400, "a short reason");
    assert.equal((await call("PATCH", url, { cookie: people.tes.cookie, body: { humanSeverity: null } })).statusCode, 200, "taken back");
    assert.equal(sevOf(id).s, null);
  });

  it("Confirm bug carries the severity: both are saved, a viewer's try saves neither, and a severity needs a confirmation", async () => {
    const id = fixture("bug", projects.A).id;
    const url = `/api/bug-reports/${id}/review`;
    assert.ok(denied403(await call("POST", url, { cookie: people.vie.cookie, body: { status: "accepted", severity: "low" } })));
    assert.deepEqual([sevOf(id).s, db.prepare("SELECT review_status AS s FROM bug_reports WHERE id = ?").get(id)], [null, { s: "proposed" }]);
    assert.equal((await call("POST", url, { cookie: people.tes.cookie, body: { status: "rejected", severity: "low" } })).statusCode, 400);
    const ok = await call("POST", url, { cookie: people.tes.cookie, body: { status: "accepted", severity: "medium", severityReason: "seen it" } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.deepEqual([sevOf(id).s, sevOf(id).uid, ok.json().status, ok.json().severity.decidedBy === ok.json().reviewedBy], ["medium", people.tes.id, "accepted", true]);
  });

  it("an agent, CI or proposal token cannot decide a severity, with or without a login", async () => {
    const id = fixture("bug", projects.A).id;
    assert.equal((await call("PUT", "/api/settings/agent-proposals", { cookie: ownerCookie, body: { enabled: true } })).statusCode, 200);
    const fresh = (await call("POST", "/api/projects", { cookie: ownerCookie, body: { name: "Delta", key: "DEL" } })).json().id as number;
    const tokens = [
      (await call("POST", `/api/projects/${fresh}/agent/tokens`, { cookie: ownerCookie, body: { name: "r" } })).json().token,
      (await call("POST", `/api/projects/${fresh}/ci/tokens`, { cookie: ownerCookie, body: { name: "c" } })).json().token,
      (await call("POST", `/api/projects/${fresh}/propose-tokens`, { cookie: ownerCookie, body: { name: "p" } })).json().token,
    ] as string[];
    assert.ok(tokens.every((t) => typeof t === "string" && t.length > 20));
    for (const token of tokens) {
      for (const cookie of [undefined, people.tes.cookie, ownerCookie]) {
        for (const [method, url, body] of [["PATCH", `/api/bug-reports/${id}`, { humanSeverity: "critical" }], ["POST", `/api/bug-reports/${id}/review`, { status: "accepted", severity: "critical" }]] as const) {
          const r = await call(method, url, { cookie, headers: { authorization: `Bearer ${token}` }, body });
          assert.ok([401, 403].includes(r.statusCode), `${method} ${url} answered ${r.statusCode}`);
        }
      }
    }
    assert.deepEqual([sevOf(id).s, sevOf(id).uid], [null, null], "nothing was decided");
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

describe("the test plan is a workspace a person owns", () => {
  const item = (audit: number | string) => db.prepare("INSERT INTO audit_plan_items (audit_id, source_id, position, title) VALUES (?, 'TPI-1', 0, 'Add a todo') RETURNING id").get(audit) as { id: number };
  const row = (audit: number | string, src = "TPI-1") => db.prepare("SELECT title, review_status AS s, decided_by_user_id AS d, edited_by_user_id AS e, origin FROM audit_plan_items WHERE audit_id = ? AND source_id = ?").get(audit, src) as { title: string; s: string; d: number | null; e: number | null; origin: string } | undefined;
  const base = (audit: number | string) => `/api/audits/${audit}/plan/items`;

  it("a tester edits, saves a draft, approves and rejects, with their account; an admin too; a viewer gets 403 and a stranger 404, and nothing changes", async () => {
    const audit = fixture("audit", projects.A).id; item(audit);
    for (const [who, deny] of [["vie", denied403], ["bob", denied404]] as const) {
      assert.ok(deny(await call("PATCH", `${base(audit)}/TPI-1`, { cookie: people[who].cookie, body: { title: "Changed" } })), `${who} cannot edit`);
      assert.ok(deny(await call("POST", `${base(audit)}/TPI-1/decision`, { cookie: people[who].cookie, body: { status: "approved" } })), `${who} cannot decide`);
      assert.ok(deny(await call("POST", base(audit), { cookie: people[who].cookie, body: { title: "Mine" } })), `${who} cannot add`);
    }
    assert.deepEqual(row(audit), { title: "Add a todo", s: "proposed", d: null, e: null, origin: "agent" }, "nothing changed");
    const edit = await call("PATCH", `${base(audit)}/TPI-1`, { cookie: people.tes.cookie, body: { title: "Add a todo item", steps: ["Type", "Enter"] } });
    assert.equal(edit.statusCode, 200, edit.body);
    assert.deepEqual(row(audit), { title: "Add a todo item", s: "draft", d: null, e: people.tes.id, origin: "agent" });
    const approve = await call("POST", `${base(audit)}/TPI-1/decision`, { cookie: people.tes.cookie, body: { status: "approved" } });
    assert.equal(approve.statusCode, 200, approve.body);
    assert.deepEqual([row(audit)!.s, row(audit)!.d], ["approved", people.tes.id]);
    assert.equal((await call("POST", `${base(audit)}/TPI-1/decision`, { cookie: people.adm.cookie, body: { status: "rejected" } })).statusCode, 200);
    assert.deepEqual([row(audit)!.s, row(audit)!.d], ["rejected", people.adm.id]);
    assert.equal((await call("POST", `${base(audit)}/TPI-1/decision`, { cookie: people.tes.cookie, body: { status: "proposed" } })).statusCode, 400, "a person cannot make it the agent's proposal again");
    assert.equal((await call("PATCH", `${base(audit)}/TPI-1`, { cookie: people.tes.cookie, body: { title: "" } })).statusCode, 400);
    assert.equal((await call("PATCH", `${base(audit)}/TPI-1`, { cookie: people.tes.cookie, body: { origin: "human" } })).statusCode, 400, "only the plan's own fields");
    assert.equal((await call("PATCH", `${base(audit)}/NOPE`, { cookie: people.tes.cookie, body: { title: "x" } })).statusCode, 404);
    const added = await call("POST", base(audit), { cookie: people.tes.cookie, body: { title: "Mine" } });
    assert.equal(added.statusCode, 200, added.body);
    assert.deepEqual([row(audit, "H-1")?.origin, row(audit, "H-1")?.s, row(audit, "H-1")?.e], ["human", "draft", people.tes.id]);
    assert.ok(denied403(await call("GET", `/api/audits/${audit}/history`, { cookie: people.nob.cookie })) || denied404(await call("GET", `/api/audits/${audit}/history`, { cookie: people.nob.cookie })));
    const history = await call("GET", `/api/audits/${audit}/history`, { cookie: people.vie.cookie });
    assert.equal(history.statusCode, 200, "a viewer reads the history");
    assert.ok(history.json().length >= 4);
  });

  it("an agent, CI or proposal token cannot edit, decide, add or apply anything in the plan, with or without a login", async () => {
    const audit = fixture("audit", projects.A).id; item(audit);
    assert.equal((await call("PUT", "/api/settings/agent-proposals", { cookie: ownerCookie, body: { enabled: true } })).statusCode, 200);
    const fresh = (await call("POST", "/api/projects", { cookie: ownerCookie, body: { name: "Plan tokens", key: "PTK" } })).json().id as number;
    const tokens = [
      (await call("POST", `/api/projects/${fresh}/agent/tokens`, { cookie: ownerCookie, body: { name: "r" } })).json().token,
      (await call("POST", `/api/projects/${fresh}/ci/tokens`, { cookie: ownerCookie, body: { name: "c" } })).json().token,
      (await call("POST", `/api/projects/${fresh}/propose-tokens`, { cookie: ownerCookie, body: { name: "p" } })).json().token,
    ] as string[];
    assert.ok(tokens.every((t) => typeof t === "string" && t.length > 20));
    for (const token of tokens) {
      for (const cookie of [undefined, people.tes.cookie, ownerCookie]) {
        for (const [method, url, body] of [
          ["PATCH", `${base(audit)}/TPI-1`, { title: "Agent" }], ["POST", `${base(audit)}/TPI-1/decision`, { status: "approved" }],
          ["POST", `${base(audit)}/TPI-1/pending`, { action: "apply" }], ["POST", base(audit), { title: "Agent" }],
        ] as const) {
          const r = await call(method, url, { cookie, headers: { authorization: `Bearer ${token}` }, body });
          assert.ok([401, 403].includes(r.statusCode), `${method} ${url} answered ${r.statusCode}`);
        }
      }
    }
    assert.deepEqual(row(audit), { title: "Add a todo", s: "proposed", d: null, e: null, origin: "agent" }, "nothing changed");
  });
});

describe("coverage gaps are a workspace a person owns, like plan items", () => {
  const seed = (audit: number | string) => db.prepare("INSERT INTO audit_coverage_gaps (audit_id, source_id, position, description) VALUES (?, 'CG-1', 0, 'Validation is not verified') RETURNING id").get(audit) as { id: number };
  const row = (audit: number | string, src = "CG-1") => db.prepare("SELECT description AS t, review_status AS s, decided_by_user_id AS d, edited_by_user_id AS e, origin FROM audit_coverage_gaps WHERE audit_id = ? AND source_id = ?").get(audit, src) as { t: string; s: string; d: number | null; e: number | null; origin: string } | undefined;
  const base = (audit: number | string) => `/api/audits/${audit}/gaps`;

  it("a tester edits, saves a draft, approves and rejects, with their account; an admin too; a viewer gets 403 and a stranger 404, and nothing changes", async () => {
    const audit = fixture("audit", projects.A).id; seed(audit);
    for (const [who, deny] of [["vie", denied403], ["bob", denied404]] as const) {
      assert.ok(deny(await call("PATCH", `${base(audit)}/CG-1`, { cookie: people[who].cookie, body: { description: "Changed" } })), `${who} cannot edit`);
      assert.ok(deny(await call("POST", `${base(audit)}/CG-1/decision`, { cookie: people[who].cookie, body: { status: "approved" } })), `${who} cannot decide`);
      assert.ok(deny(await call("POST", `${base(audit)}/CG-1/pending`, { cookie: people[who].cookie, body: { action: "apply" } })), `${who} cannot resolve`);
      assert.ok(deny(await call("POST", base(audit), { cookie: people[who].cookie, body: { description: "Mine" } })), `${who} cannot add`);
    }
    assert.deepEqual(row(audit), { t: "Validation is not verified", s: "proposed", d: null, e: null, origin: "agent" }, "nothing changed");
    const edit = await call("PATCH", `${base(audit)}/CG-1`, { cookie: people.tes.cookie, body: { description: "Validation is not verified for dates", requirements: ["REQ-1"] } });
    assert.equal(edit.statusCode, 200, edit.body);
    assert.deepEqual(row(audit), { t: "Validation is not verified for dates", s: "draft", d: null, e: people.tes.id, origin: "agent" });
    assert.equal(edit.json().coverageGaps[0].editedBy, "tes", "the answer is the plan, with who edited");
    const approve = await call("POST", `${base(audit)}/CG-1/decision`, { cookie: people.tes.cookie, body: { status: "approved" } });
    assert.equal(approve.statusCode, 200, approve.body);
    assert.deepEqual([row(audit)!.s, row(audit)!.d], ["approved", people.tes.id]);
    assert.equal((await call("POST", `${base(audit)}/CG-1/decision`, { cookie: people.adm.cookie, body: { status: "rejected" } })).statusCode, 200);
    assert.deepEqual([row(audit)!.s, row(audit)!.d], ["rejected", people.adm.id]);
    assert.equal((await call("POST", `${base(audit)}/CG-1/decision`, { cookie: people.tes.cookie, body: { status: "proposed" } })).statusCode, 400, "a person cannot make it the agent's proposal again");
    assert.equal((await call("PATCH", `${base(audit)}/CG-1`, { cookie: people.tes.cookie, body: { description: "" } })).statusCode, 400);
    assert.equal((await call("PATCH", `${base(audit)}/CG-1`, { cookie: people.tes.cookie, body: { origin: "human" } })).statusCode, 400, "only the gap's own fields");
    assert.equal((await call("PATCH", `${base(audit)}/NOPE`, { cookie: people.tes.cookie, body: { description: "x" } })).statusCode, 404);
    assert.equal((await call("POST", `${base(audit)}/CG-1/pending`, { cookie: people.tes.cookie, body: { action: "apply" } })).statusCode, 409, "nothing waits");
    const added = await call("POST", base(audit), { cookie: people.tes.cookie, body: { description: "Mine" } });
    assert.equal(added.statusCode, 200, added.body);
    assert.deepEqual([row(audit, "G-1")?.origin, row(audit, "G-1")?.s, row(audit, "G-1")?.e], ["human", "draft", people.tes.id]);
    const history = await call("GET", `${base(audit)}/history`, { cookie: people.vie.cookie });
    assert.equal(history.statusCode, 200, "a viewer reads the history");
    assert.ok(history.json().length >= 4);
    const noRole = await call("GET", `${base(audit)}/history`, { cookie: people.bob.cookie });
    assert.ok(denied404(noRole), "and someone from another project does not");
  });

  it("an agent, CI or proposal token cannot edit, decide, add or apply anything in the gaps, with or without a login", async () => {
    const audit = fixture("audit", projects.A).id; seed(audit);
    assert.equal((await call("PUT", "/api/settings/agent-proposals", { cookie: ownerCookie, body: { enabled: true } })).statusCode, 200);
    const fresh = (await call("POST", "/api/projects", { cookie: ownerCookie, body: { name: "Gap tokens", key: "GTK" } })).json().id as number;
    const tokens = [
      (await call("POST", `/api/projects/${fresh}/agent/tokens`, { cookie: ownerCookie, body: { name: "r" } })).json().token,
      (await call("POST", `/api/projects/${fresh}/ci/tokens`, { cookie: ownerCookie, body: { name: "c" } })).json().token,
      (await call("POST", `/api/projects/${fresh}/propose-tokens`, { cookie: ownerCookie, body: { name: "p" } })).json().token,
    ] as string[];
    assert.ok(tokens.every((t) => typeof t === "string" && t.length > 20));
    for (const token of tokens) {
      for (const cookie of [undefined, people.tes.cookie, ownerCookie]) {
        for (const [method, url, body] of [
          ["PATCH", `${base(audit)}/CG-1`, { description: "Agent" }], ["POST", `${base(audit)}/CG-1/decision`, { status: "approved" }],
          ["POST", `${base(audit)}/CG-1/pending`, { action: "apply" }], ["POST", base(audit), { description: "Agent" }],
        ] as const) {
          const r = await call(method, url, { cookie, headers: { authorization: `Bearer ${token}` }, body });
          assert.ok([401, 403].includes(r.statusCode), `${method} ${url} answered ${r.statusCode}`);
        }
      }
    }
    assert.deepEqual(row(audit), { t: "Validation is not verified", s: "proposed", d: null, e: null, origin: "agent" }, "nothing changed");
  });
});

describe("automation suggestions: made by a rule, decided by a person", () => {
  const plan = (audit: number | string, status: string, src = "TPI-1") => db.prepare("INSERT INTO audit_plan_items (audit_id, source_id, position, title, steps, acceptance_criteria, review_status, decided_by, decided_by_user_id) VALUES (?, ?, 0, 'Add a todo', '[\"Type\",\"Enter\"]', 'Shown in the list', ?, 'tes', ?)").run(audit, src, status, status === "approved" ? people.tes.id : null);
  const sug = (audit: number | string) => db.prepare("SELECT id, review_status AS s, case_id AS c, decided_by_user_id AS d, edited_by_user_id AS e FROM automation_suggestions WHERE audit_id = ?").get(audit) as { id: number; s: string; c: number | null; d: number | null; e: number | null } | undefined;
  const ask = (audit: number | string, cookie?: string, src = "TPI-1") => call("POST", `/api/audits/${audit}/plan/items/${src}/automation-suggestions`, { cookie, body: {} });

  it("a tester asks, edits, approves and applies; a viewer gets 403 and a stranger 404 on every write; a viewer can read", async () => {
    const audit = fixture("audit", projects.A).id; plan(audit, "approved");
    assert.ok(denied403(await ask(audit, people.vie.cookie)), "a viewer cannot ask");
    assert.ok(denied404(await ask(audit, people.bob.cookie)), "nor someone from another project");
    assert.equal(sug(audit), undefined, "nothing was made");
    const made = await ask(audit, people.tes.cookie);
    assert.equal(made.statusCode, 200, made.body);
    assert.deepEqual([made.json().created.length, made.json().created[0].label, made.json().created[0].status], [1, "Suggested by rule", "proposed"]);
    const id = sug(audit)!.id;
    assert.equal(made.json().suggestions.length, 1, "the answer is the list");
    for (const [who, deny] of [["vie", denied403], ["bob", denied404]] as const) {
      const c = people[who].cookie;
      assert.ok(deny(await call("PATCH", `/api/automation-suggestions/${id}`, { cookie: c, body: { summary: "x" } })), `${who} cannot edit`);
      assert.ok(deny(await call("POST", `/api/automation-suggestions/${id}/decision`, { cookie: c, body: { status: "approved" } })), `${who} cannot decide`);
      assert.ok(deny(await call("POST", `/api/automation-suggestions/${id}/apply`, { cookie: c, body: {} })), `${who} cannot apply`);
    }
    assert.deepEqual([sug(audit)!.s, sug(audit)!.c], ["proposed", null], "nothing changed");
    assert.equal((await call("GET", `/api/audits/${audit}/automation-suggestions`, { cookie: people.vie.cookie })).statusCode, 200, "a viewer reads the suggestions");
    assert.ok(denied404(await call("GET", `/api/audits/${audit}/automation-suggestions`, { cookie: people.bob.cookie })));

    const edit = await call("PATCH", `/api/automation-suggestions/${id}`, { cookie: people.tes.cookie, body: { summary: "Mine", steps: ["One"] } });
    assert.equal(edit.statusCode, 200, edit.body);
    assert.deepEqual([sug(audit)!.s, sug(audit)!.e], ["draft", people.tes.id]);
    assert.equal((await call("PATCH", `/api/automation-suggestions/${id}`, { cookie: people.tes.cookie, body: { origin: "agent" } })).statusCode, 400, "only the suggestion's own fields");
    assert.equal((await call("PATCH", `/api/automation-suggestions/${id}`, { cookie: people.tes.cookie, body: { steps: [] } })).statusCode, 400);
    assert.equal((await call("POST", `/api/automation-suggestions/${id}/decision`, { cookie: people.tes.cookie, body: { status: "proposed" } })).statusCode, 409, "only an ignored one can be put back");
    assert.equal((await call("POST", `/api/automation-suggestions/${id}/decision`, { cookie: people.tes.cookie, body: { status: "nonsense" } })).statusCode, 400);
    const approve = await call("POST", `/api/automation-suggestions/${id}/decision`, { cookie: people.adm.cookie, body: { status: "approved" } });
    assert.equal(approve.statusCode, 200, approve.body);
    assert.deepEqual([sug(audit)!.s, sug(audit)!.d], ["approved", people.adm.id]);
    const applied = await call("POST", `/api/automation-suggestions/${id}/apply`, { cookie: people.tes.cookie, body: {} });
    assert.equal(applied.statusCode, 200, applied.body);
    assert.equal((db.prepare("SELECT status FROM cases WHERE id = ?").get(applied.json().case.caseId) as { status: string }).status, "draft", "a draft test case, never ready");
    assert.equal(sug(audit)!.s, "approved", "and Apply approved nothing");
    assert.equal((await call("POST", `/api/automation-suggestions/${id}/apply`, { cookie: people.tes.cookie, body: {} })).statusCode, 409, "applying twice makes no second test case");
  });

  it("an unapproved plan item gets no suggestion (409), and an unknown one is 404", async () => {
    const audit = fixture("audit", projects.A).id; plan(audit, "proposed");
    const refused = await ask(audit, people.tes.cookie);
    assert.equal(refused.statusCode, 409);
    assert.match(refused.json().error, /Approve the plan item first/);
    assert.equal((await ask(audit, people.tes.cookie, "NOPE")).statusCode, 404);
    assert.equal(sug(audit), undefined);
  });

  it("an agent, CI or proposal token cannot ask for, edit, decide or apply a suggestion, with or without a login", async () => {
    const audit = fixture("audit", projects.A).id; plan(audit, "approved");
    const id = ((await ask(audit, people.tes.cookie)).json().created[0] as { id: number }).id;
    assert.equal((await call("PUT", "/api/settings/agent-proposals", { cookie: ownerCookie, body: { enabled: true } })).statusCode, 200);
    const fresh = (await call("POST", "/api/projects", { cookie: ownerCookie, body: { name: "Auto tokens", key: "ATK" } })).json().id as number;
    const tokens = [
      (await call("POST", `/api/projects/${fresh}/agent/tokens`, { cookie: ownerCookie, body: { name: "r" } })).json().token,
      (await call("POST", `/api/projects/${fresh}/ci/tokens`, { cookie: ownerCookie, body: { name: "c" } })).json().token,
      (await call("POST", `/api/projects/${fresh}/propose-tokens`, { cookie: ownerCookie, body: { name: "p" } })).json().token,
    ] as string[];
    assert.ok(tokens.every((t) => typeof t === "string" && t.length > 20));
    for (const token of tokens) {
      for (const cookie of [undefined, people.tes.cookie, ownerCookie]) {
        for (const [method, url, body] of [
          ["POST", `/api/audits/${audit}/plan/items/TPI-1/automation-suggestions`, {}], ["PATCH", `/api/automation-suggestions/${id}`, { summary: "Agent" }],
          ["POST", `/api/automation-suggestions/${id}/decision`, { status: "approved" }], ["POST", `/api/automation-suggestions/${id}/apply`, {}],
        ] as const) {
          const r = await call(method, url, { cookie, headers: { authorization: `Bearer ${token}` }, body });
          assert.ok([401, 403].includes(r.statusCode), `${method} ${url} answered ${r.statusCode}`);
        }
      }
    }
    assert.deepEqual([sug(audit)!.s, sug(audit)!.c, sug(audit)!.d], ["proposed", null, null], "nothing changed");
  });
});

describe("automation suggestions for a requirement", () => {
  const approvedReq = (project: number) => { const id = fixture("requirement", project).id as number; db.prepare("UPDATE requirements SET acceptance_criteria = '- Shown in the list' WHERE id = ?").run(id); return id; };
  const ask = (id: number | string, cookie?: string) => call("POST", `/api/requirements/${id}/automation-suggestions`, { cookie, body: {} });
  const sugOf = (reqId: number) => db.prepare("SELECT id, review_status AS s, case_id AS c, decided_by_user_id AS d FROM automation_suggestions WHERE subject_kind = 'requirement' AND subject_ref = ?").get(String(reqId)) as { id: number; s: string; c: number | null; d: number | null } | undefined;

  it("a tester asks, edits, approves and applies; a viewer gets 403 to ask and can read; a stranger gets 404 on both; an unapproved requirement is 409", async () => {
    const req = approvedReq(projects.A);
    assert.ok(denied403(await ask(req, people.vie.cookie)), "a viewer cannot ask");
    assert.ok(denied404(await ask(req, people.bob.cookie)), "nor someone from another project");
    assert.equal(sugOf(req), undefined, "nothing was made");
    const made = await ask(req, people.tes.cookie);
    assert.equal(made.statusCode, 200, made.body);
    assert.deepEqual([made.json().created.length, made.json().created[0].label, made.json().created[0].subjectKind, made.json().suggestions.length], [1, "Suggested by rule", "requirement", 1]);
    const id = sugOf(req)!.id;
    assert.equal((await call("GET", `/api/requirements/${req}/automation-suggestions`, { cookie: people.vie.cookie })).statusCode, 200, "a viewer reads");
    assert.ok(denied404(await call("GET", `/api/requirements/${req}/automation-suggestions`, { cookie: people.bob.cookie })));
    for (const [who, deny] of [["vie", denied403], ["bob", denied404]] as const) {
      assert.ok(deny(await call("POST", `/api/automation-suggestions/${id}/decision`, { cookie: people[who].cookie, body: { status: "approved" } })), `${who} cannot decide`);
      assert.ok(deny(await call("POST", `/api/automation-suggestions/${id}/apply`, { cookie: people[who].cookie, body: {} })), `${who} cannot apply`);
    }
    assert.equal(sugOf(req)!.s, "proposed", "nothing changed");
    assert.equal((await call("POST", `/api/automation-suggestions/${id}/decision`, { cookie: people.adm.cookie, body: { status: "approved" } })).statusCode, 200);
    const applied = await call("POST", `/api/automation-suggestions/${id}/apply`, { cookie: people.tes.cookie, body: {} });
    assert.equal(applied.statusCode, 200, applied.body);
    const caseId = applied.json().case.caseId as number;
    assert.equal((db.prepare("SELECT status FROM cases WHERE id = ?").get(caseId) as { status: string }).status, "draft", "a draft test case, never ready");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM requirement_cases WHERE requirement_id = ? AND case_id = ?").get(req, caseId) as { n: number }).n, 1, "linked to the requirement");
    assert.equal(sugOf(req)!.s, "approved", "and Apply approved nothing");

    const draftReq = approvedReq(projects.A);
    db.prepare("UPDATE requirements SET status = 'draft' WHERE id = ?").run(draftReq);
    const refused = await ask(draftReq, people.tes.cookie);
    assert.equal(refused.statusCode, 409);
    assert.match(refused.json().error, /Approve the requirement first/);
    assert.equal((await ask(99999999, people.tes.cookie)).statusCode, 404);

    // Deleting the requirement (an admin's decision) takes its suggestions with it; the draft test case stays.
    assert.equal((await call("DELETE", `/api/requirements/${req}`, { cookie: people.adm.cookie })).statusCode, 200);
    assert.equal(sugOf(req), undefined, "its suggestions are gone");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM cases WHERE id = ?").get(caseId) as { n: number }).n, 1, "the draft test case stays");
  });

  it("an agent, CI or proposal token cannot ask for a suggestion for a requirement, with or without a login", async () => {
    const req = approvedReq(projects.A);
    assert.equal((await call("PUT", "/api/settings/agent-proposals", { cookie: ownerCookie, body: { enabled: true } })).statusCode, 200);
    const fresh = (await call("POST", "/api/projects", { cookie: ownerCookie, body: { name: "Req tokens", key: "RTK" } })).json().id as number;
    const tokens = [
      (await call("POST", `/api/projects/${fresh}/agent/tokens`, { cookie: ownerCookie, body: { name: "r" } })).json().token,
      (await call("POST", `/api/projects/${fresh}/ci/tokens`, { cookie: ownerCookie, body: { name: "c" } })).json().token,
      (await call("POST", `/api/projects/${fresh}/propose-tokens`, { cookie: ownerCookie, body: { name: "p" } })).json().token,
    ] as string[];
    assert.ok(tokens.every((t) => typeof t === "string" && t.length > 20));
    for (const token of tokens) {
      for (const cookie of [undefined, people.tes.cookie, ownerCookie]) {
        const r = await call("POST", `/api/requirements/${req}/automation-suggestions`, { cookie, headers: { authorization: `Bearer ${token}` }, body: {} });
        assert.ok([401, 403].includes(r.statusCode), `answered ${r.statusCode}`);
      }
    }
    assert.equal(sugOf(req), undefined, "nothing was made");
  });
});

describe("Playwright spec suggestions for a plan item", () => {
  const planOf = (audit: number | string, status = "approved") => db.prepare("INSERT INTO audit_plan_items (audit_id, source_id, position, title, steps, acceptance_criteria, review_status, decided_by, decided_by_user_id) VALUES (?, 'TPI-1', 0, 'Add a todo', '[\"Type\",\"Enter\"]', 'Shown in the list', ?, 'tes', ?)").run(audit, status, status === "approved" ? people.tes.id : null);
  const ask = (audit: number | string, cookie?: string) => call("POST", `/api/audits/${audit}/plan/items/TPI-1/spec-suggestions`, { cookie, body: {} });
  const specOf = (audit: number | string) => db.prepare("SELECT id, review_status AS s, applied_at AS at, applied_by_user_id AS by, case_id AS c FROM automation_suggestions WHERE audit_id = ? AND artifact_name != ''").get(audit) as { id: number; s: string; at: string | null; by: number | null; c: number | null } | undefined;
  const download = (id: number, cookie?: string, headers: Record<string, string> = {}) => call("GET", `/api/automation-suggestions/${id}/spec`, { cookie, headers });

  it("a tester asks, edits, approves and applies; a viewer can read but not ask, decide or apply; a stranger gets 404; the file can only be downloaded after Apply, by someone who is signed in with a role", async () => {
    const audit = fixture("audit", projects.A).id; planOf(audit);
    assert.ok(denied403(await ask(audit, people.vie.cookie)), "a viewer cannot ask");
    assert.ok(denied404(await ask(audit, people.bob.cookie)), "nor someone from another project");
    assert.equal(specOf(audit), undefined, "nothing was made");
    const made = await ask(audit, people.tes.cookie);
    assert.equal(made.statusCode, 200, made.body);
    assert.deepEqual([made.json().created.length, made.json().created[0].label, made.json().created[0].isSpec, made.json().created[0].artifactName], [1, "Suggested by rule", true, "tpi-1-add-a-todo.spec.ts"]);
    assert.match(made.json().created[0].artifactText, /test\.fixme\(true,/);
    const id = specOf(audit)!.id;
    assert.equal((await call("GET", `/api/audits/${audit}/automation-suggestions`, { cookie: people.vie.cookie })).statusCode, 200, "a viewer reads");

    // Nothing can be downloaded before Apply, whoever asks.
    for (const who of ["tes", "vie", "adm"]) assert.equal((await download(id, people[who].cookie)).statusCode, 409, `${who} before Apply`);
    assert.ok(denied404(await download(id, people.bob.cookie)), "a stranger gets 404");
    assert.ok([401, 403].includes((await download(id)).statusCode), "and nobody who is not signed in gets anything");

    for (const [who, deny] of [["vie", denied403], ["bob", denied404]] as const) {
      assert.ok(deny(await call("PATCH", `/api/automation-suggestions/${id}`, { cookie: people[who].cookie, body: { artifactText: "// x\n" } })), `${who} cannot edit`);
      assert.ok(deny(await call("POST", `/api/automation-suggestions/${id}/decision`, { cookie: people[who].cookie, body: { status: "approved" } })), `${who} cannot decide`);
      assert.ok(deny(await call("POST", `/api/automation-suggestions/${id}/apply`, { cookie: people[who].cookie, body: {} })), `${who} cannot apply`);
    }
    assert.deepEqual([specOf(audit)!.s, specOf(audit)!.at], ["proposed", null], "nothing changed");

    const edit = await call("PATCH", `/api/automation-suggestions/${id}`, { cookie: people.tes.cookie, body: { artifactText: "// edited by tes\nawait x();\n" } });
    assert.equal(edit.statusCode, 200, edit.body);
    assert.equal(edit.json().artifactText, "// edited by tes\nawait x();\n");
    assert.equal(edit.json().history.at(-1).changes[0].field, "Spec text", "the edit is in the history");
    assert.equal((await call("PATCH", `/api/automation-suggestions/${id}`, { cookie: people.tes.cookie, body: { artifactText: "  " } })).statusCode, 400, "the text cannot be empty");
    assert.equal((await call("PATCH", `/api/automation-suggestions/${id}`, { cookie: people.tes.cookie, body: { artifactName: "../x.ts" } })).statusCode, 400, "the file name cannot be set");
    assert.equal((await call("POST", `/api/automation-suggestions/${id}/decision`, { cookie: people.adm.cookie, body: { status: "approved" } })).statusCode, 200);

    const applied = await call("POST", `/api/automation-suggestions/${id}/apply`, { cookie: people.tes.cookie, body: {} });
    assert.equal(applied.statusCode, 200, applied.body);
    assert.equal(applied.json().spec.fileName, "tpi-1-add-a-todo.spec.ts");
    assert.deepEqual([specOf(audit)!.s, specOf(audit)!.by, specOf(audit)!.c], ["approved", people.tes.id, null], "applied by the tester's account, still only approved by the admin's decision, and no test case");
    assert.equal((await call("POST", `/api/automation-suggestions/${id}/apply`, { cookie: people.tes.cookie, body: {} })).statusCode, 409, "applying twice is refused");

    for (const who of ["vie", "tes", "adm"]) {
      const f = await download(id, people[who].cookie);
      assert.equal(f.statusCode, 200, who);
      assert.equal(f.body, "// edited by tes\nawait x();\n", "the file is the text as it is now");
      assert.equal(f.headers["content-disposition"], 'attachment; filename="tpi-1-add-a-todo.spec.ts"');
      assert.match(String(f.headers["content-type"]), /^text\/plain/);
      assert.equal(f.headers["x-content-type-options"], "nosniff");
    }
    assert.ok(denied404(await download(id, people.bob.cookie)), "a stranger still gets 404");
    assert.ok([401, 403].includes((await download(id)).statusCode), "and so does someone who is not signed in");
  });

  it("an unapproved plan item gets no spec suggestion (409), and an unknown one is 404", async () => {
    const audit = fixture("audit", projects.A).id; planOf(audit, "proposed");
    const refused = await ask(audit, people.tes.cookie);
    assert.equal(refused.statusCode, 409);
    assert.match(refused.json().error, /Approve the plan item first/);
    assert.equal((await call("POST", `/api/audits/${audit}/plan/items/NOPE/spec-suggestions`, { cookie: people.tes.cookie, body: {} })).statusCode, 404);
    assert.equal(specOf(audit), undefined);
  });

  it("an agent, CI or proposal token cannot ask for a spec, apply it or download it, with or without a login", async () => {
    const audit = fixture("audit", projects.A).id; planOf(audit);
    const id = ((await ask(audit, people.tes.cookie)).json().created[0] as { id: number }).id;
    assert.equal((await call("POST", `/api/automation-suggestions/${id}/apply`, { cookie: people.tes.cookie, body: {} })).statusCode, 200);
    assert.equal((await call("PUT", "/api/settings/agent-proposals", { cookie: ownerCookie, body: { enabled: true } })).statusCode, 200);
    const fresh = (await call("POST", "/api/projects", { cookie: ownerCookie, body: { name: "Spec tokens", key: "STK" } })).json().id as number;
    const tokens = [
      (await call("POST", `/api/projects/${fresh}/agent/tokens`, { cookie: ownerCookie, body: { name: "r" } })).json().token,
      (await call("POST", `/api/projects/${fresh}/ci/tokens`, { cookie: ownerCookie, body: { name: "c" } })).json().token,
      (await call("POST", `/api/projects/${fresh}/propose-tokens`, { cookie: ownerCookie, body: { name: "p" } })).json().token,
    ] as string[];
    assert.ok(tokens.every((t) => typeof t === "string" && t.length > 20));
    const audit2 = fixture("audit", projects.A).id; planOf(audit2);
    for (const token of tokens) {
      for (const cookie of [undefined, people.tes.cookie, ownerCookie]) {
        const h = { authorization: `Bearer ${token}` };
        for (const r of [await download(id, cookie, h), await call("POST", `/api/audits/${audit2}/plan/items/TPI-1/spec-suggestions`, { cookie, headers: h, body: {} }), await call("POST", `/api/automation-suggestions/${id}/apply`, { cookie, headers: h, body: {} })]) {
          assert.ok([401, 403].includes(r.statusCode), `answered ${r.statusCode}`);
        }
      }
    }
    assert.equal(specOf(audit2), undefined, "nothing was made");
  });
});

describe("Playwright spec suggestions for a requirement", () => {
  const reqOf = (project: number, status = "approved", criteria = "- The text is shown\n- The input is cleared") =>
    db.prepare("INSERT INTO requirements (project_id, number, title, status, acceptance_criteria) VALUES (?, (SELECT COALESCE(MAX(number), 0) + 1 FROM requirements WHERE project_id = ?), 'Todo can be added', ?, ?) RETURNING id, number").get(project, project, status, criteria) as { id: number; number: number };
  const ask = (id: number, cookie?: string, headers: Record<string, string> = {}) => call("POST", `/api/requirements/${id}/spec-suggestions`, { cookie, headers, body: {} });
  const specOf = (id: number) => db.prepare("SELECT id, review_status AS s, applied_at AS at, applied_by_user_id AS by, case_id AS c FROM automation_suggestions WHERE subject_kind = 'requirement' AND subject_ref = ? AND artifact_name != ''").get(String(id)) as { id: number; s: string; at: string | null; by: number | null; c: number | null } | undefined;
  const download = (id: number, cookie?: string, headers: Record<string, string> = {}) => call("GET", `/api/automation-suggestions/${id}/spec`, { cookie, headers });

  it("a tester asks, edits, approves and applies; a viewer reads but cannot ask, decide or apply; a stranger gets 404; the file needs Apply, a login and a role", async () => {
    const q = reqOf(projects.A);
    assert.ok(denied403(await ask(q.id, people.vie.cookie)), "a viewer cannot ask");
    assert.ok(denied404(await ask(q.id, people.bob.cookie)), "nor someone from another project");
    assert.equal(specOf(q.id), undefined, "nothing was made");
    const made = await ask(q.id, people.tes.cookie);
    assert.equal(made.statusCode, 200, made.body);
    assert.deepEqual([made.json().created.length, made.json().created[0].isSpec, made.json().created[0].artifactName], [1, true, `req-${q.number}-todo-can-be-added.spec.ts`]);
    assert.match(made.json().created[0].artifactText, /test\.fixme\(true,/);
    const id = specOf(q.id)!.id;
    assert.equal((await call("GET", `/api/requirements/${q.id}/automation-suggestions`, { cookie: people.vie.cookie })).statusCode, 200, "a viewer reads");

    for (const who of ["tes", "vie", "adm"]) assert.equal((await download(id, people[who].cookie)).statusCode, 409, `${who} before Apply`);
    assert.ok(denied404(await download(id, people.bob.cookie)));
    assert.ok([401, 403].includes((await download(id)).statusCode));

    for (const [who, deny] of [["vie", denied403], ["bob", denied404]] as const) {
      assert.ok(deny(await call("PATCH", `/api/automation-suggestions/${id}`, { cookie: people[who].cookie, body: { artifactText: "// x\n" } })), `${who} cannot edit`);
      assert.ok(deny(await call("POST", `/api/automation-suggestions/${id}/decision`, { cookie: people[who].cookie, body: { status: "approved" } })), `${who} cannot decide`);
      assert.ok(deny(await call("POST", `/api/automation-suggestions/${id}/apply`, { cookie: people[who].cookie, body: {} })), `${who} cannot apply`);
    }
    assert.deepEqual([specOf(q.id)!.s, specOf(q.id)!.at], ["proposed", null], "nothing changed");

    assert.equal((await call("PATCH", `/api/automation-suggestions/${id}`, { cookie: people.tes.cookie, body: { artifactText: "// edited by tes\nawait x();\n" } })).statusCode, 200);
    assert.equal((await call("POST", `/api/automation-suggestions/${id}/decision`, { cookie: people.adm.cookie, body: { status: "approved" } })).statusCode, 200);
    const applied = await call("POST", `/api/automation-suggestions/${id}/apply`, { cookie: people.tes.cookie, body: {} });
    assert.equal(applied.statusCode, 200, applied.body);
    assert.deepEqual([specOf(q.id)!.s, specOf(q.id)!.by, specOf(q.id)!.c], ["approved", people.tes.id, null], "applied by the tester's account, approved only by the admin's decision, and no test case");

    for (const who of ["vie", "tes", "adm"]) {
      const f = await download(id, people[who].cookie);
      assert.equal(f.statusCode, 200, who);
      assert.equal(f.body, "// edited by tes\nawait x();\n");
      assert.equal(f.headers["content-disposition"], `attachment; filename="req-${q.number}-todo-can-be-added.spec.ts"`);
      assert.match(String(f.headers["content-type"]), /^text\/plain/);
      assert.equal(f.headers["x-content-type-options"], "nosniff");
    }
    assert.ok(denied404(await download(id, people.bob.cookie)));
    assert.ok([401, 403].includes((await download(id)).statusCode));
  });

  it("a draft requirement gets 409, one without criteria gets a message and nothing is stored, an unknown one is 404", async () => {
    const draft = reqOf(projects.A, "draft"), bare = reqOf(projects.A, "approved", "");
    const refused = await ask(draft.id, people.tes.cookie);
    assert.equal(refused.statusCode, 409);
    assert.match(refused.json().error, /Approve the requirement first/);
    const none = await ask(bare.id, people.tes.cookie);
    assert.equal(none.statusCode, 200);
    assert.match(none.json().message, /no acceptance criteria/);
    assert.equal((await ask(999999, people.tes.cookie)).statusCode, 404);
    assert.equal(specOf(draft.id), undefined);
    assert.equal(specOf(bare.id), undefined);
  });

  it("deleting the requirement removes its spec suggestion", async () => {
    const q = reqOf(projects.A);
    assert.equal((await ask(q.id, people.tes.cookie)).statusCode, 200);
    assert.ok(specOf(q.id));
    assert.equal((await call("DELETE", `/api/requirements/${q.id}`, { cookie: people.adm.cookie })).statusCode, 200);
    assert.equal(specOf(q.id), undefined);
  });

  it("an agent, CI or proposal token cannot ask for a requirement spec, apply it or download it, with or without a login", async () => {
    const q = reqOf(projects.A);
    const id = ((await ask(q.id, people.tes.cookie)).json().created[0] as { id: number }).id;
    assert.equal((await call("POST", `/api/automation-suggestions/${id}/apply`, { cookie: people.tes.cookie, body: {} })).statusCode, 200);
    assert.equal((await call("PUT", "/api/settings/agent-proposals", { cookie: ownerCookie, body: { enabled: true } })).statusCode, 200);
    const fresh = (await call("POST", "/api/projects", { cookie: ownerCookie, body: { name: "Req spec tokens", key: "RST" } })).json().id as number;
    const tokens = [
      (await call("POST", `/api/projects/${fresh}/agent/tokens`, { cookie: ownerCookie, body: { name: "r" } })).json().token,
      (await call("POST", `/api/projects/${fresh}/ci/tokens`, { cookie: ownerCookie, body: { name: "c" } })).json().token,
      (await call("POST", `/api/projects/${fresh}/propose-tokens`, { cookie: ownerCookie, body: { name: "p" } })).json().token,
    ] as string[];
    assert.ok(tokens.every((t) => typeof t === "string" && t.length > 20));
    const q2 = reqOf(projects.A);
    for (const token of tokens) {
      for (const cookie of [undefined, people.tes.cookie, ownerCookie]) {
        const h = { authorization: `Bearer ${token}` };
        for (const r of [await download(id, cookie, h), await ask(q2.id, cookie, h), await call("POST", `/api/automation-suggestions/${id}/apply`, { cookie, headers: h, body: {} })]) {
          assert.ok([401, 403].includes(r.statusCode), `answered ${r.statusCode}`);
        }
      }
    }
    assert.equal(specOf(q2.id), undefined, "nothing was made");
  });
});

describe("Bug drafts from a screenshot", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("not really a picture, but it starts like one")]);
  const multipart = (note: string, file: Buffer | null, filename = "shot.png") => {
    const b = "----tbtest" + Math.random().toString(16).slice(2);
    const parts: Buffer[] = [Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="note"\r\n\r\n${note}\r\n`)];
    if (file) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`), file, Buffer.from("\r\n"));
    parts.push(Buffer.from(`--${b}--\r\n`));
    return { body: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${b}` } };
  };
  const make = (project: number, note: string, file: Buffer | null, cookie?: string, filename?: string, extra: Record<string, string> = {}) => {
    const m = multipart(note, file, filename);
    return call("POST", `/api/projects/${project}/bug-drafts`, { cookie, body: m.body, headers: { ...m.headers, ...extra } });
  };
  const draftFiles = () => readdirSync(UPLOAD_DIR).filter((f) => f.startsWith("draft-")).length;
  const rows = (project: number) => (db.prepare("SELECT COUNT(*) AS n FROM bug_drafts WHERE project_id = ?").get(project) as { n: number }).n;
  const shotOf = (id: number) => call("GET", `/api/bug-drafts/${id}/screenshot`, { cookie: people.vie.cookie });

  it("a tester makes a draft; a viewer can read but not make, edit, decide or apply; a stranger gets 404; the picture needs a login and a role in the project", async () => {
    const before = [draftFiles(), rows(projects.A)];
    assert.ok(denied403(await make(projects.A, "A bug", PNG, people.vie.cookie)), "a viewer cannot make one");
    assert.ok(denied404(await make(projects.A, "A bug", PNG, people.bob.cookie)), "nor someone from another project");
    assert.ok([401, 403].includes((await make(projects.A, "A bug", PNG)).statusCode), "nor someone who is not signed in");
    assert.deepEqual([draftFiles(), rows(projects.A)], before, "nothing was stored");

    const made = await make(projects.A, "The total is wrong\nAfter removing an item.", PNG, people.tes.cookie, "my shot.png");
    assert.equal(made.statusCode, 200, made.body);
    const d = made.json();
    assert.deepEqual([d.suggestedBy, d.status, d.title, d.createdBy, d.label.startsWith("SCR-"), d.screenshot.mime], ["Suggested by rule", "proposed", "The total is wrong", "tes", true, "image/png"]);
    assert.deepEqual([draftFiles(), rows(projects.A)], [before[0] + 1, before[1] + 1]);
    const id = d.id as number;

    assert.equal((await call("GET", `/api/projects/${projects.A}/bug-drafts`, { cookie: people.vie.cookie })).statusCode, 200, "a viewer reads");
    assert.ok(denied404(await call("GET", `/api/projects/${projects.A}/bug-drafts`, { cookie: people.bob.cookie })));

    const shot = await shotOf(id);
    assert.equal(shot.statusCode, 200);
    assert.deepEqual([shot.headers["content-type"], shot.headers["x-content-type-options"], String(shot.headers["content-disposition"]).startsWith("attachment; filename=\"scr-")], ["image/png", "nosniff", true]);
    assert.ok(shot.rawPayload.equals(PNG), "the picture as it was sent");
    assert.ok(denied404(await call("GET", `/api/bug-drafts/${id}/screenshot`, { cookie: people.bob.cookie })));
    assert.ok([401, 403].includes((await call("GET", `/api/bug-drafts/${id}/screenshot`)).statusCode), "not signed in");

    for (const [who, deny] of [["vie", denied403], ["bob", denied404]] as const) {
      assert.ok(deny(await call("PATCH", `/api/bug-drafts/${id}`, { cookie: people[who].cookie, body: { title: "x" } })), `${who} cannot edit`);
      assert.ok(deny(await call("POST", `/api/bug-drafts/${id}/decision`, { cookie: people[who].cookie, body: { status: "approved" } })), `${who} cannot decide`);
      assert.ok(deny(await call("POST", `/api/bug-drafts/${id}/apply`, { cookie: people[who].cookie, body: {} })), `${who} cannot apply`);
    }
    const stillProposed = db.prepare("SELECT review_status AS s, applied_at AS a, bug_id AS b FROM bug_drafts WHERE id = ?").get(id) as { s: string; a: string | null; b: number | null };
    assert.deepEqual(stillProposed, { s: "proposed", a: null, b: null }, "nothing changed");

    assert.equal((await call("PATCH", `/api/bug-drafts/${id}`, { cookie: people.tes.cookie, body: { unknown: 1 } })).statusCode, 400, "an unknown field");
    assert.equal((await call("PATCH", `/api/bug-drafts/${id}`, { cookie: people.tes.cookie, body: { title: "  " } })).statusCode, 400, "an empty title");
    const edited = await call("PATCH", `/api/bug-drafts/${id}`, { cookie: people.tes.cookie, body: { title: "Total ignores removals", expected: "The total drops" } });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal(edited.json().history.at(-1).changes[0].field, "Title", "the edit is in the history");
    assert.equal((await call("POST", `/api/bug-drafts/${id}/decision`, { cookie: people.adm.cookie, body: { status: "approved" } })).statusCode, 200);

    const applied = await call("POST", `/api/bug-drafts/${id}/apply`, { cookie: people.tes.cookie, body: {} });
    assert.equal(applied.statusCode, 200, applied.body);
    const bugId = applied.json().bugId as number;
    const bug = db.prepare("SELECT review_status AS s, source, origin_audit_id AS o, title, reviewed_at AS r FROM bug_reports WHERE id = ?").get(bugId) as Record<string, unknown>;
    assert.deepEqual(bug, { s: "proposed", source: "manual", o: "$screenshot", title: "Total ignores removals", r: null }, "a proposed bug report, never accepted");
    const after = db.prepare("SELECT review_status AS s, applied_by_user_id AS by FROM bug_drafts WHERE id = ?").get(id) as { s: string; by: number };
    assert.deepEqual(after, { s: "approved", by: people.tes.id }, "applied by the tester's account, approved only by the admin's decision");
    assert.equal((await call("POST", `/api/bug-drafts/${id}/apply`, { cookie: people.tes.cookie, body: {} })).statusCode, 409, "a second Apply is refused");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?").get(projects.A) as { n: number }).n >= 1, true);
    const view = await call("GET", `/api/bug-reports/${bugId}`, { cookie: people.vie.cookie });
    assert.equal(view.statusCode, 200);
    assert.equal(view.json().attachments.length, 1, "the screenshot is attached to the bug report");
    const stored = db.prepare("SELECT screenshot_name AS n FROM bug_drafts WHERE id = ?").get(id) as { n: string };
    assert.equal((await call("GET", `/uploads/${stored.n}`, { cookie: people.vie.cookie })).statusCode, 200, "now a member of the project can open it with the bug");
    const anon = await call("GET", `/uploads/${stored.n}`);
    assert.notEqual(anon.statusCode, 200, `not signed in got ${anon.statusCode}`);
  });

  it("only a real picture of the right size is taken: text, svg, a missing file, an empty note and an enormous file are refused (400, or 413 for the enormous file), and no file or row is left", async () => {
    const before = [draftFiles(), rows(projects.A)];
    const cases: [string, Buffer | null, string][] = [
      ["A note", Buffer.from("just text"), "fake.png"],
      ["A note", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>"), "shot.svg"],
      ["A note", Buffer.from("<html><script>1</script></html>"), "shot.png"],
      ["A note", null, "x.png"],
      ["   ", PNG, "shot.png"],
      ["A note", Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]), "big.png"],
    ];
    for (const [note, file, name] of cases) {
      const r = await make(projects.A, note, file, people.tes.cookie, name);
      assert.equal(r.statusCode, name === "big.png" ? 413 : 400, `${name}: ${r.statusCode} ${r.body.slice(0, 120)}`);
    }
    assert.deepEqual([draftFiles(), rows(projects.A)], before);
  });

  it("before Apply the picture is served only by its own route, not by /uploads", async () => {
    const d = (await make(projects.A, "Not applied yet", PNG, people.tes.cookie)).json();
    const stored = db.prepare("SELECT screenshot_name AS n FROM bug_drafts WHERE id = ?").get(d.id) as { n: string };
    assert.ok(existsSync(join(UPLOAD_DIR, stored.n)));
    for (const cookie of [people.vie.cookie, people.tes.cookie, people.bob.cookie, undefined]) assert.notEqual((await call("GET", `/uploads/${stored.n}`, { cookie })).statusCode, 200);
  });

  it("an agent, CI or proposal token cannot make a draft, read or decide on one, or fetch its picture, with or without a login", async () => {
    const d = (await make(projects.A, "Token test", PNG, people.tes.cookie)).json();
    assert.equal((await call("PUT", "/api/settings/agent-proposals", { cookie: ownerCookie, body: { enabled: true } })).statusCode, 200);
    const fresh = (await call("POST", "/api/projects", { cookie: ownerCookie, body: { name: "Draft tokens", key: "BDT" } })).json().id as number;
    const tokens = [
      (await call("POST", `/api/projects/${fresh}/agent/tokens`, { cookie: ownerCookie, body: { name: "r" } })).json().token,
      (await call("POST", `/api/projects/${fresh}/ci/tokens`, { cookie: ownerCookie, body: { name: "c" } })).json().token,
      (await call("POST", `/api/projects/${fresh}/propose-tokens`, { cookie: ownerCookie, body: { name: "p" } })).json().token,
    ] as string[];
    assert.ok(tokens.every((t) => typeof t === "string" && t.length > 20));
    const before = rows(projects.A);
    for (const token of tokens) {
      for (const cookie of [undefined, people.tes.cookie, ownerCookie]) {
        const h = { authorization: `Bearer ${token}` };
        const results = [
          await make(projects.A, "By token", PNG, cookie, undefined, h),
          await call("GET", `/api/projects/${projects.A}/bug-drafts`, { cookie, headers: h }),
          await call("GET", `/api/bug-drafts/${d.id}/screenshot`, { cookie, headers: h }),
          await call("PATCH", `/api/bug-drafts/${d.id}`, { cookie, headers: h, body: { title: "x" } }),
          await call("POST", `/api/bug-drafts/${d.id}/decision`, { cookie, headers: h, body: { status: "approved" } }),
          await call("POST", `/api/bug-drafts/${d.id}/apply`, { cookie, headers: h, body: {} }),
        ];
        for (const r of results) assert.ok([401, 403].includes(r.statusCode), `answered ${r.statusCode}`);
      }
    }
    assert.equal(rows(projects.A), before, "nothing was made");
    assert.equal((db.prepare("SELECT review_status AS s FROM bug_drafts WHERE id = ?").get(d.id) as { s: string }).s, "proposed");
  });
});

describe("nothing left this process", () => {
  it("the routes that were let through asked for outside addresses, and every one was refused by the stub", () => {
    assert.ok(outbound.every((u) => /^https?:\/\//.test(u)), outbound.join(", "));
  });
});
