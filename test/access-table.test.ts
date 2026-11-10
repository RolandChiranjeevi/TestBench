import "./env.ts";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { ACCESS, KINDS, PRODUCTION_ONLY, REGISTERED, accessTableProblems, checkAccessTable, type Need } from "../server/access.ts";
import { isAgentRead } from "../server/agenttokens.ts";
import { isCiIngest } from "../server/ci.ts";
import { isAgentPropose } from "../server/proposetokens.ts";

// The access table (server/access.ts) says who may call each route. These tests keep it complete and sensible: they read the routes that the real app registered,
// so a route added without a decision fails here (and stops the server from starting). Nothing is called; no port, no network.
process.env.TESTBENCH_NO_LISTEN = "1";
const { app } = await import("../server/index.ts");
await app.ready();
after(() => app.close());

const routes = [...new Set(REGISTERED)].sort();
const mutating = (r: string) => !r.startsWith("GET ");
const need = (r: string): Need => ACCESS[r];
const isProject = (n: Need): n is Exclude<Need, string> => typeof n === "object";
const list = (pick: (n: Need, r: string) => boolean) => routes.filter((r) => pick(need(r), r));

describe("every route has a decision, and every decision has a route", () => {
  it("the real app registered routes, and the table covers exactly those", () => {
    assert.ok(routes.length > 150, `only ${routes.length} routes were seen: the tracker is not installed first`);
    assert.deepEqual(accessTableProblems(REGISTERED), { missing: [], stale: [] });
    assert.equal(Object.keys(ACCESS).length, routes.length + PRODUCTION_ONLY.size, "the table holds the routes seen here, plus the ones only a production build has");
    assert.deepEqual([...PRODUCTION_ONLY], ["GET /*"], "the production-only routes are named on purpose");
    assert.doesNotThrow(() => checkAccessTable());
  });

  it("a route without a line, or a line without a route, is found (and a missing one would stop the server)", () => {
    const withExtra = accessTableProblems([...REGISTERED, "POST /api/projects/:id/new-thing", "GET /api/secrets"]);
    assert.deepEqual(withExtra.missing, ["GET /api/secrets", "POST /api/projects/:id/new-thing"]);
    assert.deepEqual(accessTableProblems(REGISTERED.filter((r) => r !== "GET /api/me")).stale, ["GET /api/me"]);
    const real = REGISTERED.length;
    REGISTERED.push("GET /api/not-decided");
    try { assert.throws(() => checkAccessTable(), /no entry in server\/access\.ts[\s\S]*GET \/api\/not-decided/); } finally { REGISTERED.length = real; }
  });

  it("only known kinds are used, and each kind is used", () => {
    const used = new Set(routes.map(need).filter(isProject).map((n) => n.kind));
    for (const k of used) assert.ok((KINDS as readonly string[]).includes(k), k);
    assert.deepEqual([...KINDS].filter((k) => !used.has(k)), [], "a kind nothing uses is dead weight");
  });

  it("a route with the project's own :id has kind project; any other has a kind that says what its id is", () => {
    for (const r of routes) {
      const n = need(r);
      if (!isProject(n)) continue;
      const path = r.split(" ")[1];
      const projectId = /^\/api\/projects\/:id(\/|$)/.test(path);
      if (n.via) { assert.notEqual(n.kind, "project", r); continue; }
      assert.equal(n.kind === "project", projectId, `${r} is ${projectId ? "" : "not "}under /api/projects/:id but has kind ${n.kind}`);
    }
  });
});

describe("the table is sensible", () => {
  it("a viewer can only read: no change needs less than tester", () => {
    assert.deepEqual(list((n, r) => mutating(r) && isProject(n) && n.level === "viewer"), []);
  });

  it("changes need a project role or the owner; the other cases are named one by one", () => {
    const own = new Set(["POST /api/logout", "PATCH /api/me", "POST /api/me/password", "POST /api/me/sessions/:id/revoke", "POST /api/me/sessions/revoke-others", "PUT /api/settings/display-name"]);
    const way = new Set(["POST /api/login", "POST /api/setup", "POST /api/join/:token", "POST /api/reset/:token"]);
    const tokenRoutes = new Set(["POST /api/projects/:id/ci/test-results", "POST /api/agent/projects/:id/requirement-proposals"]);
    const custom = new Set(["POST /api/invitations", "POST /api/invitations/:id/revoke"]);
    for (const r of routes.filter(mutating)) {
      const n = need(r);
      if (isProject(n) || n === "owner") continue;
      const ok = (n === "user" && own.has(r)) || (n === "anon" && way.has(r)) || (n === "token" && tokenRoutes.has(r)) || (n === "custom" && custom.has(r));
      assert.ok(ok, `${r} changes things but needs only ${JSON.stringify(n)}`);
    }
  });

  it("the owner-only set is exactly this (a change here is a decision, not an accident)", () => {
    assert.deepEqual(list((n) => n === "owner"), [
      "GET /api/audit-log", "GET /api/backup", "GET /api/users", "POST /api/demo", "POST /api/projects", "POST /api/restore", "POST /api/users/:id/disable",
      "POST /api/users/:id/enable", "POST /api/users/:id/reset-link", "PUT /api/settings/agent-proposals",
    ].sort());
  });

  it("the routes open without a login are exactly the way in", () => {
    assert.deepEqual(list((n) => n === "anon"), [
      "GET /api/auth/status", "GET /api/join/:token", "GET /api/reset/:token", "GET /api/setup/status", "GET /join/:token", "GET /login", "GET /reset/:token", "GET /setup",
      "POST /api/join/:token", "POST /api/login", "POST /api/reset/:token", "POST /api/setup",
    ].sort());
  });

  it("tokens, integrations, deleting whole things and the project itself need an admin; testing work needs a tester; reading needs a viewer", () => {
    const level = (r: string) => { const n = need(r); return isProject(n) ? n.level : null; };
    const adminRoutes = routes.filter((r) =>
      /\/(agent|ci|propose)\/tokens$/.test(r) || /^POST \/api\/(agent|ci|propose)-tokens\/:id\/revoke$/.test(r) || /\/destination/.test(r) ||
      /\/github-sources$/.test(r) || /^(PATCH|DELETE) \/api\/github-sources\/:id$/.test(r) || r === "POST /api/github-sources/:id/check" ||
      r === "POST /api/projects/:id/delete" || r === "PATCH /api/projects/:id" || r === "GET /api/projects/:id/deletion-preview");
    assert.equal(adminRoutes.length, 19, "the set of admin-only integration and token routes changed: decide that on purpose");
    for (const r of adminRoutes) assert.equal(level(r), "admin", r);
    for (const r of ["POST /api/projects/:id/generate-proposals", "POST /api/requirement-proposals/:id/approve", "POST /api/requirement-proposals/:id/reject", "POST /api/projects/:id/runs", "POST /api/projects/:id/cases"]) assert.equal(level(r), "tester", r);
    for (const r of ["GET /api/projects/:id/requirements", "GET /api/projects/:id/export.json", "GET /api/milestones/:id/report.pdf", "GET /api/cases/:id"]) assert.equal(level(r), "viewer", r);
  });

  it("the token routes in the table are exactly the ones the token checks recognise, and no others", () => {
    const concrete = (r: string) => { const [m, p] = r.split(" "); return [m, p.replace(/:\w+/g, "1")] as const; };
    const recognised = routes.filter((r) => { const [m, u] = concrete(r); return isCiIngest(m, u) || isAgentRead(m, u) || isAgentPropose(m, u); });
    assert.deepEqual(recognised, list((n) => n === "token"));
    assert.equal(recognised.length, 3);
  });
});
