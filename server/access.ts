import type { FastifyInstance } from "fastify";

/**
 * Who may call which route. Every route that exists is listed in ACCESS below, with what it needs. A route that is not listed stops the server from starting
 * (see checkAccessTable), so a new route can never be added without deciding who may use it. This is deny-by-default at build time, and the test in
 * test/access-table.test.ts keeps it honest.
 *
 * What a route can need:
 *  - "anon":    nobody has to be signed in (the login, the first account, invitation and reset pages, the status).
 *  - "user":    any signed-in account (or, without accounts, anyone who got in). Not tied to a project.
 *  - "owner":   the owner of the installation: accounts, the audit log, backups, the demo, the agent switch, new projects.
 *  - "token":   a machine token authenticates it (CI, agent read, agent propose); the handler checks the token, and the token belongs to one project.
 *  - "custom":  the handler decides, because the answer depends on the body (invitations: the owner, or the admin of the project the invitation is for).
 *  - project:   a role in the project the request is about: viewer (read), tester (change test data) or admin (members, tokens, integrations, deleting things).
 *               `kind` says how the project is found from the route: "project" is the :id of the route itself; any other kind is the thing whose :id it is
 *               (a case, a run, a result ...), looked up to its project; "file" is a stored file, found by its name. `via` names the body field when the id is not in the path.
 * The owner is an admin of every project. Without accounts there are no roles and nothing here applies.
 */
export type Level = "viewer" | "tester" | "admin";
export const LEVELS: readonly Level[] = ["viewer", "tester", "admin"];
export const levelRank = (l: Level) => LEVELS.indexOf(l);

export const KINDS = [
  "project", "case", "run", "result", "attachment", "automated", "requirement", "reqattachment", "proposal", "observation", "bug", "bugpublication", "manualtest", "automationsuggestion", "bugdraft",
  "audit", "milestone", "checklist", "suite", "template", "githubsource", "agenttoken", "citoken", "proposetoken", "file",
] as const;
export type Kind = (typeof KINDS)[number];
export type Need = "anon" | "user" | "owner" | "token" | "custom" | { level: Level; kind: Kind; via?: string };

const v = (kind: Kind = "project"): Need => ({ level: "viewer", kind });
const t = (kind: Kind = "project", via?: string): Need => ({ level: "tester", kind, ...(via ? { via } : {}) });
const a = (kind: Kind = "project"): Need => ({ level: "admin", kind });

/** One line per route: "METHOD /pattern" exactly as the route is registered. */
export const ACCESS: Record<string, Need> = {
  // ---- anyone: the way in ----
  "GET /api/auth/status": "anon", "GET /login": "anon", "POST /api/login": "anon", "GET /api/setup/status": "anon", "POST /api/setup": "anon", "GET /setup": "anon",
  "GET /api/join/:token": "anon", "POST /api/join/:token": "anon", "GET /join/:token": "anon",
  "GET /api/reset/:token": "anon", "POST /api/reset/:token": "anon", "GET /reset/:token": "anon",
  // ---- a signed-in account: its own things, and what is the same for everyone ----
  "POST /api/logout": "user", "GET /api/me": "user", "PATCH /api/me": "user", "POST /api/me/password": "user", "GET /api/me/sessions": "user", "POST /api/me/sessions/:id/revoke": "user", "POST /api/me/sessions/revoke-others": "user",
  "GET /api/projects": "user", // lists only the projects the account is a member of
  "GET /api/features": "user", "GET /api/github/status": "user", "GET /api/jira/status": "user", "GET /api/linear/status": "user",
  "GET /api/settings/display-name": "user", "PUT /api/settings/display-name": "user", "GET /api/settings/agent-proposals": "user", "GET /api/backup/info": "user",
  "GET /trace-viewer/*": "user", // Playwright's viewer: code only, it opens a trace the person already has
  // ---- the owner ----
  "POST /api/projects": "owner", "POST /api/demo": "owner", "GET /api/backup": "owner", "POST /api/restore": "owner", "PUT /api/settings/agent-proposals": "owner",
  "GET /api/users": "owner", "GET /api/users/:id/memberships": "owner", "POST /api/users/:id/disable": "owner", "POST /api/users/:id/enable": "owner", "POST /api/users/:id/reset-link": "owner", "GET /api/audit-log": "owner",
  // ---- invitations: the owner, or the admin of the project an invitation is for ----
  "GET /api/invitations": "custom", "POST /api/invitations": "custom", "POST /api/invitations/:id/revoke": "custom",
  // ---- machine tokens: each opens one route of one project and nothing else ----
  "POST /api/projects/:id/ci/test-results": "token", "GET /api/agent/projects/:id/requirements": "token", "POST /api/agent/projects/:id/requirement-proposals": "token",

  // ---- a project ----
  "PATCH /api/projects/:id": a(), "POST /api/projects/:id/delete": a(), "GET /api/projects/:id/deletion-preview": a(),
  "GET /api/projects/:id/dashboard": v(), "GET /api/projects/:id/insights": v(),
  "GET /api/projects/:id/export.json": v(), "GET /api/projects/:id/export-cases.csv": v(), "GET /api/projects/:id/export-results.csv": v(),
  "GET /api/projects/:id/export-requirements.csv": v(), "GET /api/projects/:id/export-markdown.zip": v(),
  "GET /api/projects/:id/agent/requirements": v(),
  // members: everyone in a project sees who is in it (an admin also sees addresses); an admin looks after them
  "GET /api/projects/:id/members": v(), "GET /api/projects/:id/me": v(), "POST /api/projects/:id/members": a(), "PATCH /api/projects/:id/members/:userId": a(), "DELETE /api/projects/:id/members/:userId": a(),
  // tokens and integrations
  "GET /api/projects/:id/agent/tokens": a(), "POST /api/projects/:id/agent/tokens": a(), "POST /api/agent-tokens/:id/revoke": a("agenttoken"),
  "GET /api/projects/:id/ci/tokens": a(), "POST /api/projects/:id/ci/tokens": a(), "POST /api/ci-tokens/:id/revoke": a("citoken"),
  "GET /api/projects/:id/propose-tokens": a(), "POST /api/projects/:id/propose-tokens": a(), "POST /api/propose-tokens/:id/revoke": a("proposetoken"),
  "GET /api/projects/:id/destination": a(), "PUT /api/projects/:id/destination": a(), "DELETE /api/projects/:id/destination": a(), "POST /api/projects/:id/destination/teams": a(),
  "GET /api/projects/:id/github-sources": a(), "POST /api/projects/:id/github-sources": a(), "PATCH /api/github-sources/:id": a("githubsource"), "DELETE /api/github-sources/:id": a("githubsource"),
  "POST /api/github-sources/:id/check": a("githubsource"), "GET /api/github-sources/:id/runs": t("githubsource"), "POST /api/github-sources/:id/runs/:runId/import": t("githubsource"),
  // cases, suites, templates
  "GET /api/projects/:id/cases": v(), "POST /api/projects/:id/cases": t(), "POST /api/projects/:id/cases/bulk": t(), "POST /api/projects/:id/cases/delete": t(), "POST /api/projects/:id/import": t(),
  "GET /api/cases/:id": v("case"), "PATCH /api/cases/:id": t("case"), "DELETE /api/cases/:id": t("case"), "POST /api/cases/:id/duplicate": t("case"), "PUT /api/cases/:id/requirements": t("case"),
  "GET /api/projects/:id/suites": v(), "POST /api/projects/:id/suites": t(), "PATCH /api/suites/:id": t("suite"), "DELETE /api/suites/:id": a("suite"), "POST /api/suites/:id/move": t("suite"),
  "GET /api/projects/:id/templates": v(), "POST /api/projects/:id/templates": t(), "PATCH /api/templates/:id": t("template"), "DELETE /api/templates/:id": a("template"),
  // templates are what the app calls Suites: runnable groups of cases (server/runsuites.ts)
  "GET /api/templates/:id": v("template"), "POST /api/projects/:id/templates/from-folder": t(), "POST /api/templates/:id/cases": t("template"),
  "DELETE /api/templates/:id/cases/:caseId": t("template"), "POST /api/templates/:id/run": t("template"),
  // runs and results
  "GET /api/projects/:id/runs": v(), "POST /api/projects/:id/runs": t(), "GET /api/runs/:id": v("run"), "PATCH /api/runs/:id": t("run"), "DELETE /api/runs/:id": t("run"),
  "GET /api/results/:id": v("result"), "PATCH /api/results/:id": t("result"), "GET /api/results/:id/automated": v("result"), "GET /api/results/:id/attachments.zip": v("result"),
  "POST /api/results/:id/attachments": t("result"), "PUT /api/results/:id/steps/:stepId": t("result"), "POST /api/results/:id/jira-issue": t("result"), "POST /api/results/:id/linear-issue": t("result"),
  "DELETE /api/attachments/:id": t("attachment"),
  // automated tests
  "GET /api/projects/:id/automated": v(), "GET /api/projects/:id/automated/link-suggestions": v(), "POST /api/projects/:id/automated/relink": t(), "POST /api/projects/:id/automated/suggest-links": t(),
  "PATCH /api/automated/:id": t("automated"), "POST /api/link-suggestions/dismiss": t("automated", "testId"),
  // milestones and their checklists
  "GET /api/projects/:id/milestones": v(), "POST /api/projects/:id/milestones": t(), "PATCH /api/milestones/:id": t("milestone"), "DELETE /api/milestones/:id": a("milestone"),
  "GET /api/milestones/:id/report": v("milestone"), "GET /api/milestones/:id/report.html": v("milestone"), "GET /api/milestones/:id/report.pdf": v("milestone"),
  "GET /api/milestones/:id/checklist": v("milestone"), "POST /api/milestones/:id/checklist": t("milestone"), "POST /api/milestones/:id/checklist/copy": t("milestone"),
  "PATCH /api/checklist/:id": t("checklist"), "DELETE /api/checklist/:id": t("checklist"),
  // observations
  "GET /api/projects/:id/observations": v(), "GET /api/projects/:id/observations/summary": v(), "POST /api/projects/:id/observations": t(),
  "GET /api/observations/:id": v("observation"), "GET /api/observations/:id/links": v("observation"), "PUT /api/observations/:id/links": t("observation"), "PATCH /api/observations/:id": t("observation"),
  "POST /api/observations/:id/archive": t("observation"), "POST /api/observations/:id/reopen": t("observation"), "POST /api/observations/:id/resolve": t("observation"), "POST /api/observations/:id/convert-to-bug": t("observation"),
  // bug reports
  "GET /api/projects/:id/bug-drafts": v(), "POST /api/projects/:id/bug-drafts": t(), "GET /api/bug-drafts/:id/screenshot": v("bugdraft"),
  "PATCH /api/bug-drafts/:id": t("bugdraft"), "POST /api/bug-drafts/:id/decision": t("bugdraft"), "POST /api/bug-drafts/:id/apply": t("bugdraft"),
  "GET /api/projects/:id/bug-reports": v(), "GET /api/bug-reports/:id": v("bug"), "PATCH /api/bug-reports/:id": t("bug"), "DELETE /api/bug-reports/:id": t("bug"),
  "POST /api/bug-reports/:id/apply-update": t("bug"), "POST /api/bug-reports/:id/duplicate": t("bug"), "POST /api/bug-reports/:id/external-link": t("bug"), "POST /api/bug-reports/:id/ignore-update": t("bug"),
  "POST /api/bug-reports/:id/publish": t("bug"), "POST /api/bug-reports/:id/publish-preview": t("bug"), "POST /api/bug-reports/:id/relink": t("bug"), "POST /api/bug-reports/:id/review": t("bug"), "POST /api/bug-reports/:id/triage": t("bug"),
  "POST /api/bug-publications/:id/check": t("bugpublication"), "POST /api/bug-publications/:id/retry-attachments": t("bugpublication"), "DELETE /api/bug-publications/:id": t("bugpublication"),
  // manual tests
  "GET /api/projects/:id/manual-tests": v(), "GET /api/manual-tests/:id": v("manualtest"), "PATCH /api/manual-tests/:id": t("manualtest"), "DELETE /api/manual-tests/:id": t("manualtest"),
  "POST /api/manual-tests/:id/apply-update": t("manualtest"), "POST /api/manual-tests/:id/create-case": t("manualtest"), "POST /api/manual-tests/:id/add-to-project": t("manualtest"), "POST /api/manual-tests/:id/ignore-update": t("manualtest"),
  "POST /api/manual-tests/:id/relink": t("manualtest"), "POST /api/manual-tests/:id/review": t("manualtest"),
  // audits
  "GET /api/projects/:id/audits": v(), "GET /api/projects/:id/audit-rejections": v(), "POST /api/projects/:id/audit-import": t(), "GET /api/projects/:id/coverage-gaps": v(),
  "GET /api/audits/:id/plan": v("audit"), "GET /api/audits/:id/history": v("audit"), "GET /api/audits/:id/gaps/history": v("audit"), "GET /api/audits/:id/automation-suggestions": v("audit"), "POST /api/audits/:id/plan/items/:sourceId/automation-suggestions": t("audit"), "POST /api/audits/:id/plan/items/:sourceId/spec-suggestions": t("audit"),
  "GET /api/automation-suggestions/:id/spec": v("automationsuggestion"),
  "GET /api/requirements/:id/automation-suggestions": v("requirement"), "POST /api/requirements/:id/automation-suggestions": t("requirement"), "POST /api/requirements/:id/spec-suggestions": t("requirement"),
  "PATCH /api/automation-suggestions/:id": t("automationsuggestion"), "POST /api/automation-suggestions/:id/decision": t("automationsuggestion"), "POST /api/automation-suggestions/:id/apply": t("automationsuggestion"), "POST /api/audits/:id/gaps": t("audit"), "PATCH /api/audits/:id/gaps/:sourceId": t("audit"),
  "POST /api/audits/:id/gaps/:sourceId/decision": t("audit"), "POST /api/audits/:id/gaps/:sourceId/pending": t("audit"), "POST /api/audits/:id/plan/items": t("audit"), "PATCH /api/audits/:id/plan/items/:sourceId": t("audit"),
  "POST /api/audits/:id/plan/items/:sourceId/decision": t("audit"), "POST /api/audits/:id/plan/items/:sourceId/pending": t("audit"), "GET /api/audits/:id/report": v("audit"), "GET /api/audits/:id/deletion-preview": a("audit"), "DELETE /api/audits/:id": a("audit"),
  // requirements, their proposals, and generating proposals
  "GET /api/projects/:id/requirements": v(), "GET /api/projects/:id/requirements/coverage": v(), "POST /api/projects/:id/requirements": t(), "POST /api/projects/:id/requirements/import": t(), "POST /api/projects/:id/requirements/approve-imported": t(),
  "GET /api/requirements/:id": v("requirement"), "PATCH /api/requirements/:id": t("requirement"), "DELETE /api/requirements/:id": a("requirement"),
  "POST /api/requirements/:id/attachments": t("requirement"), "POST /api/requirements/:id/cases": t("requirement"), "POST /api/requirements/:id/deprecate": t("requirement"), "POST /api/requirements/:id/review": t("requirement"),
  "DELETE /api/requirement-attachments/:id": t("reqattachment"),
  "GET /api/projects/:id/requirement-proposals": v(), "GET /api/requirement-proposals/:id": v("proposal"), "PATCH /api/requirement-proposals/:id": t("proposal"),
  "POST /api/requirement-proposals/:id/approve": t("proposal"), "POST /api/requirement-proposals/:id/reject": t("proposal"),
  "POST /api/projects/:id/generate-proposals": t(),
  // the built web app (its pages, scripts and styles, and index.html for every page of it): only registered by a production build, see PRODUCTION_ONLY
  "GET /*": "user",
  // the files themselves: the name is looked up to the project it belongs to (result attachments, requirement attachments, bug evidence, audit narratives)
  "GET /uploads/*": v("file"),
};

/**
 * Lines of the table for routes that exist only in a production build (NODE_ENV=production with the web app built into dist/): they are registered there and not
 * while developing or testing, so their absence is not a stale line. test/access-production.test.ts starts the app that way and checks the table against it.
 */
export const PRODUCTION_ONLY: ReadonlySet<string> = new Set(["GET /*"]);

/** The routes that exist and are not in the table, and the table's lines that are not routes. Both lists are empty when the table is right. */
export function accessTableProblems(registered: readonly string[]): { missing: string[]; stale: string[] } {
  const have = new Set(registered);
  return { missing: [...have].filter((r) => !(r in ACCESS)).sort(), stale: Object.keys(ACCESS).filter((r) => !have.has(r) && !PRODUCTION_ONLY.has(r)).sort() };
}

/** Every route that was registered, as "METHOD /pattern" (HEAD and OPTIONS are left out: HEAD is its GET). Filled by trackRoutes. */
export const REGISTERED: string[] = [];
export function trackRoutes(app: FastifyInstance) {
  app.addHook("onRoute", (r) => {
    for (const m of ([] as string[]).concat(r.method)) if (m !== "HEAD" && m !== "OPTIONS") REGISTERED.push(`${m} ${r.url}`);
  });
}

/** Run when the server is ready: a route without a line in the table stops it from starting. */
export function checkAccessTable(): void {
  const { missing } = accessTableProblems(REGISTERED);
  if (missing.length) throw new Error(`These routes have no entry in server/access.ts, so nobody has decided who may use them:\n  ${missing.join("\n  ")}`);
}
