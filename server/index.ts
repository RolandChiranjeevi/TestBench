import Fastify, { type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, rmSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { zipSync } from "fflate";
import { extname, join } from "node:path";
import { z } from "zod";
import { checkSource, startAutoImport } from "./autoimport.ts";
import { backupInfo, restoreFromZip, streamBackup } from "./backup.ts";
import { autoBackupInfo, safetyBackup, startAutoBackup } from "./autobackup.ts";
import { deleteCases, deleteProject, describeProject, DeletionError } from "./deletion.ts";
import { moveSuite, SuiteMoveError } from "./suites.ts";
import { bulkUpdateCases, CaseBulkError, duplicateCase } from "./casebulk.ts";
import { authConfigFromEnv, makeLimiter, registerAuth } from "./auth.ts";
import { authenticateCiToken, CI_LIMITS, createCiToken, ingestCiResults, isCiIngest, listCiTokens, revokeCiToken, setTriage, WORKFLOW_STATUSES } from "./ci.ts";
import { DATA_DIR, db, ensureMilestone, parseJson, UPLOAD_DIR } from "./db.ts";
import { seedDemo } from "./demo.ts";
import { artifactsByRun, getToken, importRun, listRuns, parseWorkflowList, REPO_SLUG, type GithubSource } from "./importers/github.ts";
import { bagFromFiles, bagFromZip, dedupeReports, mergeBags, readReports, type FileBag } from "./importers/bag.ts";
import { importReport, mergeReports, relinkAutomatedTests } from "./importers/import.ts";
import type { CaseSnapshot } from "./db.ts";
import { exportCasesCsv, exportJson, exportMarkdownZip, exportRequirementsCsv, exportResultsCsv } from "./exporter.ts";
import { htmlToPdf } from "./pdf.ts";
import { renderReport } from "./reportHtml.ts";
import { automationCandidates, insightsData } from "./insights.ts";
import { addRequirementAttachment, deprecateRequirement, removeRequirementAttachment, requirementAttachmentFiles, RequirementError } from "./requirements.ts";
import { dismissSuggestion, listSuggestions, SuggestError, suggestLinks, typesafeConfig } from "./linksuggest.ts";
import { addChecklistItem, copyChecklist, listChecklist } from "./checklist.ts";
import { createIssue, LinearError, linearEnabled, listTeams } from "./linear.ts";
import { createJiraIssue, JiraError, jiraEnabled, jiraStatus } from "./jira.ts";
import { buildPreview, checkPublication, getDestination, lookupTeams, publishBug, PublishError, removeDestination, retryAttachments, saveDestination } from "./publish.ts";
import {
  applyPendingUpdate, AuditError, auditReportText, deleteAudit, deleteBugReport, getBugReport, ignorePendingUpdate, importAuditPackage, linkExternalIssue,
  addGap, addPlanItem, decideGap, decidePlanItem, editGap, editPlanItem, gapHistory, getAuditPlan, listAudits, planHistory, resolveGapPending, resolvePending, listBugReports, listRejectedPackages, markDuplicate, previewAuditDeletion, relinkBugRefs, reviewBugReport, unlinkExternalIssue, updateBugReport,
} from "./audits.ts";
import { agentRequirements } from "./agentexport.ts";
import { approveImported, importRequirements, RequirementImportError } from "./reqimport.ts";
import { requirementCoverage } from "./reqlinks.ts";
import { normViewports, normWcag, viewportSchema, wcagCriterion, type Viewport } from "./shapes.ts";
import { LIMITS as AUDIT_LIMITS, PackageError } from "./importers/auditpackage.ts";
import { archiveObservation, convertToBug, getObservation, importObservations, listObservations, ObservationError, observationSummary, reopenObservation, resolveObservation, setObservationStatus } from "./observations.ts";
import { listCases } from "./newcases.ts";
import { previewSchedule, scheduleDetails, setSchedule, startScheduler } from "./scheduler.ts";
import { addSuiteCases, createManualRun, getSuite, listSuites, removeSuiteCase, runSuiteInfo, setSuiteCases, startSuiteRun, SuiteError, suiteFromFolder, withAutomation } from "./runsuites.ts";
import { LOGGER_OPTIONS } from "./logging.ts";
import { authenticateAgentToken, createAgentToken, isAgentRead, listAgentTokens, revokeAgentToken } from "./agenttokens.ts";
import { agentCredentialKind, agentProposalsEnabled, authenticateProposeToken, createProposeToken, isAgentPropose, listProposeTokens, revokeProposeToken, setAgentProposalsEnabled } from "./proposetokens.ts";
import { approveProposal, createProposals, editProposal, getProposal, listProposals, rejectProposal } from "./reqproposals.ts";
import { actorName, actorUserId, getDisplayName, setDisplayName } from "./actor.ts";
import { accountsState, AccountError, revokeAllSessions, updateProfile } from "./accounts.ts";
import { currentUser } from "./accountcontext.ts";
import { checkAccessTable, trackRoutes } from "./access.ts";
import { registerAccessGuard } from "./accessguard.ts";
import { roleOf } from "./members.ts";
import { coverageGaps, getObservationLinks, setObservationLinks } from "./coveragegaps.ts";
import { applyBugDraft, bugDraftScreenshot, checkScreenshot, createBugDraft, decideBugDraft, editBugDraft, getBugDraft, listBugDrafts, buildBugDraft, MAX_SCREENSHOT_BYTES } from "./bugdrafts.ts";
import { applyAutomationSuggestion, applySpecSuggestion, specFile, suggestSpecForPlanItem, suggestSpecForRequirement, decideAutomationSuggestion, editAutomationSuggestion, getAutomationSuggestion, listAutomationSuggestions, listRequirementAutomationSuggestions, removeRequirementSuggestions, suggestAutomation, suggestAutomationForRequirement } from "./automation.ts";
import { generateProposals } from "./gapproposals.ts";
import { agentRequirementsForToken, parseAgentQuery } from "./agentapi.ts";
import { applyManualUpdate, addToProject, createCaseFromProposal, deleteManualTest, getManualTest, ignoreManualUpdate, listManualTests, relinkManualRefs, reviewManualTest, updateManualTest } from "./manualtests.ts";
import { addRequirementCases, createRequirement, kindProblem, REQUIREMENT_KINDS, getRequirement, linkCaseByTags, listRequirements, markReviewed, recordRevision, requirementsForCase, requirementSummary, setCaseRequirements, setRequirementCases, type RevisionChange } from "./requirements.ts";
import { dashboardData, listMilestones, milestoneReport } from "./stats.ts";
import { parseReport, type Framework, type ParsedReport } from "./importers/parse.ts";

const PORT = Number(process.env.TESTBENCH_PORT ?? process.env.TESTBENCH_API_PORT ?? 4100);
const HOST = process.env.TESTBENCH_HOST?.trim() || "127.0.0.1";
const auth = authConfigFromEnv();

// Safe by default: listening beyond this computer without a password would put everyone's test data on the network.
if (!["127.0.0.1", "::1", "localhost"].includes(HOST) && !auth && accountsState() === "open" && process.env.TESTBENCH_ALLOW_NO_AUTH !== "1") {
  console.error(
    `Refusing to listen on ${HOST} without a login.\n` +
      "Make the first account on this server (npm run accounts -- create-owner), or set TESTBENCH_PASSWORD (at least 8 characters), or keep the default host (127.0.0.1).\n" +
      "If the port is only published on this computer (for example Docker with 127.0.0.1:4100:4100), TESTBENCH_ALLOW_NO_AUTH=1 skips this check.",
  );
  process.exit(1);
}
// Host names the app answers to. Behind a reverse proxy add your domain: TESTBENCH_ALLOWED_HOSTS=testbench.example.com
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", ...(process.env.TESTBENCH_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)]);

// The Authorization header (an API token) and the cookie (a login) are never written to the log: see server/logging.ts.
const app = Fastify({ logger: LOGGER_OPTIONS, trustProxy: process.env.TESTBENCH_TRUST_PROXY === "1" });
trackRoutes(app); // first, before any route: the access table must know every route (see access.ts)

// Any web page can send "simple" cross-site requests to localhost. Reject foreign Host headers
// (DNS rebinding) and require a custom header on writes, which forces a CORS preflight we never approve.
app.addHook("onRequest", async (req, reply) => {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return reply.code(403).send({ error: "Forbidden host" });
  // CI is not a browser: its route is authenticated by an API token instead of the header (a web page cannot add an Authorization token it does not have).
  if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-testbench"] !== "1" && !isCiIngest(req.method, req.url) && !isAgentPropose(req.method, req.url)) {
    return reply.code(403).send({ error: "Missing X-Testbench header" });
  }
});
// Optional password login (TESTBENCH_PASSWORD). Registered right after the guard above, so it runs before every route and static file.
registerAuth(app, auth);
// An agent credential (a read, proposal or CI token) opens its own route and nothing else. Registered after the login check, so with a password set a stranger still
// gets "sign in" first; whatever is left is refused here, so an agent can never approve, reject, edit or deprecate a requirement, with or without a login being set up.
app.addHook("onRequest", async (req, reply) => {
  if (agentCredentialKind(req.headers.authorization) && !isCiIngest(req.method, req.url) && !isAgentRead(req.method, req.url) && !isAgentPropose(req.method, req.url)) {
    return reply.code(403).send({ error: "An agent token opens only its own route. Requirements are decided by a person." });
  }
});
// Who may do what in which project (server/access.ts), once accounts are on. After the login check and the agent-token check, before every route and file.
registerAccessGuard(app);
// A CI request that is too large is answered 413 only after its body has been read and thrown away. Answering and closing at once makes the
// operating system reset the connection while the client is still writing, so the client sees ECONNRESET or EPIPE and never the 413.
// Reading is bounded: above drainBytes, or if the client is too slow, the connection is dropped instead.
app.addHook("onRequest", async (req, reply) => {
  if (!isCiIngest(req.method, req.url)) return;
  const declared = Number(req.headers["content-length"]);
  if (!(declared > CI_LIMITS.bodyBytes)) return;
  const drop = () => { req.raw.socket.destroy(); return reply.hijack(); };
  if (declared > CI_LIMITS.drainBytes) return drop();
  const drained = await new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => finish(false), 20_000);
    req.raw.once("end", () => finish(true));
    req.raw.once("error", () => finish(false));
    req.raw.once("close", () => finish(false));
    req.raw.resume();
  });
  if (!drained) return drop();
  return reply.code(413).header("Connection", "close").send({ error: `The request is larger than ${CI_LIMITS.bodyBytes / 1024 / 1024} MB, the limit for one CI request. Send fewer passed tests, or split the run.` });
});
// Folder uploads send one file per screenshot/video, so the file count limit is generous.
await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 1000 } });
await app.register(fastifyStatic, { root: UPLOAD_DIR, prefix: "/uploads/", decorateReply: false });

// Playwright's own trace viewer, served locally so traces open in one click without leaving the machine.
const traceViewerDir = join(process.cwd(), "node_modules/playwright-core/lib/vite/traceViewer");
if (existsSync(traceViewerDir)) await app.register(fastifyStatic, { root: traceViewerDir, prefix: "/trace-viewer/", decorateReply: false });

const distDir = join(process.cwd(), "dist");
if (process.env.NODE_ENV === "production" && existsSync(distDir)) {
  await app.register(fastifyStatic, { root: distDir, prefix: "/" });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith("/api") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html", distDir),
  );
}

class HttpError extends Error {
  constructor(public status: number, message: string, public problems?: string[]) {
    super(message);
  }
}

/**
 * With accounts on, some things reach every project and every account (backup, restore, the demo, the agent switch): only the owner may do them. Without accounts nobody
 * is signed in and the installation is as open as before.
 */
function ownerOnly(): void {
  if (accountsState() === "accounts" && !currentUser()?.isOwner) throw new HttpError(403, "Only the owner can do this");
}
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, ...(err.problems?.length ? { problems: err.problems } : {}) });
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) app.log.error(err);
  return reply.code(status).send({ error: (err as Error).message });
});

const idParam = (req: FastifyRequest, name = "id") => {
  const v = Number((req.params as Record<string, string>)[name]);
  if (!Number.isInteger(v)) throw new HttpError(400, `Invalid ${name}`);
  return v;
};
const must = <T>(row: T | undefined, what: string): T => {
  if (!row) throw new HttpError(404, `${what} not found`);
  return row;
};

/** Suites and manual runs (server/runsuites.ts): its errors say which status they mean. */
function suitesApi<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof SuiteError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

const STATUS_COUNTS = `
  COUNT(r.id) AS total,
  COALESCE(SUM(r.status = 'passed'), 0) AS passed,
  COALESCE(SUM(r.status = 'failed'), 0) AS failed,
  COALESCE(SUM(r.status = 'blocked'), 0) AS blocked,
  COALESCE(SUM(r.status = 'skipped'), 0) AS skipped,
  COALESCE(SUM(r.status = 'untested'), 0) AS untested,
  COALESCE(SUM(r.flaky), 0) AS flaky`;

// ---------------- Projects ----------------

const projectBody = z.object({
  name: z.string().trim().min(1).max(100),
  key: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{0,9}$/, "1-10 letters/digits, starting with a letter"),
});

app.get("/api/projects", () => {
  // With accounts a person sees the projects they are a member of (the owner sees all); without accounts, all.
  const u = currentUser();
  const rows = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM cases c WHERE c.project_id = p.id) AS case_count,
           (SELECT COUNT(*) FROM runs r WHERE r.project_id = p.id) AS run_count
    FROM projects p ORDER BY p.created_at`).all() as { id: number }[];
  // `role` is the person's role in each project (the owner is an admin everywhere; without accounts there are no roles and everything is allowed).
  if (!u) return rows.map((p) => ({ ...p, role: "admin" }));
  return rows.flatMap((p) => { const role = roleOf(u, p.id); return role ? [{ ...p, role }] : []; });
});

app.post("/api/projects", (req) => {
  ownerOnly(); // also enforced by the access table; the person who makes a project is the owner, an admin of it by being the owner
  const body = projectBody.parse(req.body);
  if (db.prepare("SELECT 1 FROM projects WHERE key = ?").get(body.key)) throw new HttpError(409, `Key ${body.key} is already used`);
  return db.prepare("INSERT INTO projects (name, key) VALUES (?, ?) RETURNING *").get(body.name, body.key);
});

app.patch("/api/projects/:id", (req) => {
  const id = idParam(req);
  const body = projectBody.pick({ name: true }).parse(req.body);
  return must(db.prepare("UPDATE projects SET name = ? WHERE id = ? RETURNING *").get(body.name, id), "Project");
});

app.post("/api/demo", () => { ownerOnly(); return seedDemo(); });

// ---------------- Suites ----------------

app.get("/api/projects/:id/suites", (req) =>
  db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM cases c WHERE c.suite_id = s.id) AS case_count
    FROM suites s WHERE s.project_id = ? ORDER BY s.position, s.id`).all(idParam(req)),
);

const suiteBody = z.object({
  name: z.string().trim().min(1).max(200),
  parentId: z.number().int().nullable().optional(),
  description: z.string().max(10000).optional(),
});

app.post("/api/projects/:id/suites", (req) => {
  const projectId = idParam(req);
  const body = suiteBody.parse(req.body);
  const pos = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM suites WHERE project_id = ?").get(projectId) as { p: number };
  return db
    .prepare("INSERT INTO suites (project_id, parent_id, name, description, position) VALUES (?, ?, ?, ?, ?) RETURNING *")
    .get(projectId, body.parentId ?? null, body.name, body.description ?? "", pos.p);
});

app.patch("/api/suites/:id", (req) => {
  const id = idParam(req);
  const body = suiteBody.partial().parse(req.body);
  if (body.parentId === id) throw new HttpError(400, "A suite cannot be its own parent");
  const cur = must(db.prepare("SELECT * FROM suites WHERE id = ?").get(id) as Record<string, any> | undefined, "Suite");
  return db
    .prepare("UPDATE suites SET name = ?, parent_id = ?, description = ? WHERE id = ? RETURNING *")
    .get(body.name ?? cur.name, body.parentId === undefined ? cur.parent_id : body.parentId, body.description ?? cur.description, id);
});

// Move a suite: under `parentId` (null = top level), placed before the sibling `beforeId` or last when that is null/omitted.
app.post("/api/suites/:id/move", (req) => {
  const { parentId, beforeId } = z.object({ parentId: z.number().int().nullable(), beforeId: z.number().int().nullable().optional() }).parse(req.body);
  try {
    return moveSuite(idParam(req), parentId, beforeId);
  } catch (e) {
    if (e instanceof SuiteMoveError) throw new HttpError(e.status, e.message);
    throw e;
  }
});

app.delete("/api/suites/:id", (req) => {
  db.prepare("DELETE FROM suites WHERE id = ?").run(idParam(req));
  return { ok: true };
});

// ---------------- Cases ----------------

const caseRow = (row: Record<string, any>) => ({ ...row, tags: parseJson<string[]>(row.tags, []) });

app.get("/api/projects/:id/cases", (req) => listCases(idParam(req)));

const stepSchema = z.object({ id: z.number().int().optional(), action: z.string().max(5000), expected: z.string().max(5000) });
const caseBody = z.object({
  title: z.string().trim().min(1).max(500),
  suiteId: z.number().int().nullable().optional(),
  description: z.string().max(50000).optional(),
  preconditions: z.string().max(20000).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  status: z.enum(["draft", "ready", "deprecated"]).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
  steps: z.array(stepSchema).max(200).optional(),
});

function saveSteps(caseId: number, steps: z.infer<typeof stepSchema>[]) {
  const existing = new Set((db.prepare("SELECT id FROM case_steps WHERE case_id = ?").all(caseId) as { id: number }[]).map((r) => r.id));
  const keep = new Set<number>();
  steps.forEach((s, i) => {
    if (s.id && existing.has(s.id)) {
      db.prepare("UPDATE case_steps SET position = ?, action = ?, expected = ? WHERE id = ?").run(i, s.action, s.expected, s.id);
      keep.add(s.id);
    } else {
      db.prepare("INSERT INTO case_steps (case_id, position, action, expected) VALUES (?, ?, ?, ?)").run(caseId, i, s.action, s.expected);
    }
  });
  for (const id of existing) if (!keep.has(id)) db.prepare("DELETE FROM case_steps WHERE id = ?").run(id);
}

function getCase(id: number) {
  const row = must(
    db.prepare("SELECT c.*, p.key AS project_key FROM cases c JOIN projects p ON p.id = c.project_id WHERE c.id = ?").get(id) as
      | Record<string, any>
      | undefined,
    "Case",
  );
  return {
    ...caseRow(row),
    steps: db.prepare("SELECT * FROM case_steps WHERE case_id = ? ORDER BY position").all(id),
    requirements: requirementsForCase(id),
    // The agent proposal this case was made from, if any.
    proposal: (db.prepare("SELECT id, source_id AS sourceId, title, review_status AS status FROM manual_tests WHERE case_id = ?").get(id) as { id: number; sourceId: string; title: string; status: string } | undefined) ?? null,
    automated: db.prepare("SELECT * FROM automated_tests WHERE case_id = ? ORDER BY title").all(id),
    history: db
      .prepare(`
        SELECT r.id, r.status, r.flaky, r.duration_ms, r.executed_at, ru.id AS run_id, ru.title AS run_title, ru.kind, ru.started_at
        FROM results r JOIN runs ru ON ru.id = r.run_id
        WHERE r.case_id = ? AND r.status != 'untested'
        ORDER BY COALESCE(r.executed_at, ru.started_at) DESC, r.id DESC LIMIT 20`)
      .all(id),
  };
}

app.post("/api/projects/:id/cases", (req) => {
  const projectId = idParam(req);
  const body = caseBody.parse(req.body);
  const id = db.transaction(() => {
    const p = must(
      db.prepare("UPDATE projects SET next_case_number = next_case_number + 1 WHERE id = ? RETURNING next_case_number - 1 AS n").get(projectId) as
        | { n: number }
        | undefined,
      "Project",
    );
    const pos = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM cases WHERE project_id = ?").get(projectId) as { p: number };
    const row = db
      .prepare(`
        INSERT INTO cases (project_id, suite_id, number, title, description, preconditions, priority, status, tags, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .get(
        projectId,
        body.suiteId ?? null,
        p.n,
        body.title,
        body.description ?? "",
        body.preconditions ?? "",
        body.priority ?? "medium",
        body.status ?? "ready",
        JSON.stringify(body.tags ?? []),
        pos.p,
      ) as { id: number };
    if (body.steps) saveSteps(row.id, body.steps);
    linkCaseByTags(row.id);
    return row.id;
  })();
  return getCase(id);
});

const bulkBody = z.object({
  ids: z.array(z.number().int()).min(1).max(2000),
  suiteId: z.number().int().nullable().optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  status: z.enum(["draft", "ready", "deprecated"]).optional(),
  addTags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
  removeTags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
});

// Change many cases at once: move to a suite, set priority/status, add or remove tags.
app.post("/api/projects/:id/cases/bulk", (req) => {
  const projectId = idParam(req);
  must(db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId), "Project");
  const { ids, ...patch } = bulkBody.parse(req.body);
  try {
    return bulkUpdateCases(projectId, ids, patch);
  } catch (e) {
    if (e instanceof CaseBulkError) throw new HttpError(e.status, e.message);
    throw e;
  }
});

app.post("/api/cases/:id/duplicate", (req) => {
  try {
    return getCase(duplicateCase(idParam(req)));
  } catch (e) {
    if (e instanceof CaseBulkError) throw new HttpError(e.status, e.message);
    throw e;
  }
});

app.get("/api/cases/:id", (req) => getCase(idParam(req)));

app.patch("/api/cases/:id", (req) => {
  const id = idParam(req);
  const body = caseBody.partial().parse(req.body);
  const cur = must(db.prepare("SELECT * FROM cases WHERE id = ?").get(id) as Record<string, any> | undefined, "Case");
  db.transaction(() => {
    db.prepare(`
      UPDATE cases SET suite_id = ?, title = ?, description = ?, preconditions = ?, priority = ?, status = ?, tags = ?,
        updated_at = datetime('now') WHERE id = ?`).run(
      body.suiteId === undefined ? cur.suite_id : body.suiteId,
      body.title ?? cur.title,
      body.description ?? cur.description,
      body.preconditions ?? cur.preconditions,
      body.priority ?? cur.priority,
      body.status ?? cur.status,
      body.tags ? JSON.stringify(body.tags) : cur.tags,
      id,
    );
    if (body.steps) saveSteps(id, body.steps);
    linkCaseByTags(id);
  })();
  return getCase(id);
});

app.delete("/api/cases/:id", (req) => {
  db.prepare("DELETE FROM cases WHERE id = ?").run(idParam(req));
  return { ok: true };
});

// ---- Deleting: many cases, and whole projects. Both are irreversible, so a backup is saved first (when automatic backups are on). ----
const SAFETY_BACKUP_FROM_CASES = 5;
const asHttp = (e: unknown) => (e instanceof DeletionError ? new HttpError(e.status, e.message) : e);

app.post("/api/projects/:id/cases/delete", async (req) => {
  const projectId = idParam(req);
  must(db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId), "Project");
  const { ids } = z.object({ ids: z.array(z.number().int()).min(1).max(20000) }).parse(req.body);
  let backup: { created: string | null; dir: string } = { created: null, dir: "" };
  if (ids.length >= SAFETY_BACKUP_FROM_CASES) {
    try {
      backup = await safetyBackup();
    } catch (e) {
      throw new HttpError(500, `Could not save a safety backup first, so nothing was deleted: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  try {
    return { ...deleteCases(projectId, ids), backup: backup.created, backupDir: backup.dir };
  } catch (e) {
    throw asHttp(e);
  }
});

app.get("/api/projects/:id/deletion-preview", (req) => {
  try {
    return describeProject(idParam(req));
  } catch (e) {
    throw asHttp(e);
  }
});

app.post("/api/projects/:id/delete", async (req) => {
  const projectId = idParam(req);
  const { confirm } = z.object({ confirm: z.string().max(100) }).parse(req.body);
  let info;
  try {
    info = describeProject(projectId);
  } catch (e) {
    throw asHttp(e);
  }
  if (confirm !== info.key) throw new HttpError(400, `To delete "${info.name}", confirm with its key ${info.key}.`);
  let backup: { created: string | null; dir: string };
  try {
    backup = await safetyBackup();
  } catch (e) {
    throw new HttpError(500, `Could not save a safety backup first, so nothing was deleted: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const result = deleteProject(projectId, confirm);
    await Promise.all(result.files.map((f) => unlink(join(UPLOAD_DIR, f)).catch(() => {})));
    return { ok: true, name: result.name, key: result.key, deleted: result.counts, files: result.files.length, backup: backup.created, backupDir: backup.dir };
  } catch (e) {
    throw asHttp(e);
  }
});

// ---------------- Runs ----------------

// `template_name` is the suite the run came from: its name now, or the name it had when the run started if the suite has been deleted since.
// ?templateId=<suite id> lists only the runs of that suite.
app.get("/api/projects/:id/runs", (req) => {
  const projectId = idParam(req);
  const templateParam = (req.query as { templateId?: string }).templateId;
  const templateId = templateParam === undefined ? null : Number(templateParam);
  if (templateId !== null && !Number.isInteger(templateId)) throw new HttpError(400, "Invalid templateId");
  const rows = db
    .prepare(`
      SELECT ru.*, ${STATUS_COUNTS},
        COALESCE(SUM(r.duration_ms), 0) AS duration_ms,
        COALESCE(t.name, json_extract(ru.meta, '$.suite.name')) AS template_name
      FROM runs ru LEFT JOIN results r ON r.run_id = ru.id LEFT JOIN run_templates t ON t.id = ru.template_id
      WHERE ru.project_id = ? ${templateId === null ? "" : "AND ru.template_id = ?"} GROUP BY ru.id ORDER BY ru.started_at DESC, ru.id DESC`)
    .all(...(templateId === null ? [projectId] : [projectId, templateId])) as Record<string, any>[];
  return rows.map((r) => ({ ...r, meta: parseJson(r.meta, {}) }));
});

const manualRunBody = z.object({
  title: z.string().trim().min(1).max(200),
  environment: z.string().max(200).optional(),
  milestone: z.string().max(200).optional(),
  caseIds: z.array(z.number().int()).min(1, "Pick at least one case"),
  templateId: z.number().int().nullable().optional(),
  /** The run this one re-tests, e.g. the failures of last night's run. */
  rerunOf: z.number().int().nullable().optional(),
});

// A manual run of chosen cases: one case, a selection, or a suite's cases picked in the dialog. A whole suite is started with POST /api/templates/:id/run.
app.post("/api/projects/:id/runs", (req) => {
  const projectId = idParam(req);
  const body = manualRunBody.parse(req.body);
  return suitesApi(() => createManualRun(projectId, body));
});

app.get("/api/runs/:id", (req) => {
  const id = idParam(req);
  const run = must(
    db.prepare(`SELECT ru.*, p.key AS project_key FROM runs ru JOIN projects p ON p.id = ru.project_id WHERE ru.id = ?`).get(id) as
      | Record<string, any>
      | undefined,
    "Run",
  );
  const counts = db.prepare(`SELECT ${STATUS_COUNTS}, COALESCE(SUM(r.duration_ms), 0) AS duration_ms FROM results r WHERE r.run_id = ?`).get(id);
  const results = db
    .prepare(`
      SELECT r.id, r.run_id, r.case_id, r.automated_test_id, r.status, r.flaky, r.duration_ms, r.error, r.notes, r.position, r.executed_at, r.jira_key,
        (SELECT COUNT(*) FROM attachments att WHERE att.result_id = r.id) AS attachment_count, r.detail IS NOT NULL AS has_detail,
        COALESCE(json_extract(r.snapshot, '$.number'), c.number) AS case_number,
        COALESCE(json_extract(r.snapshot, '$.title'), c.title) AS case_title,
        COALESCE(json_extract(r.snapshot, '$.priority'), c.priority) AS case_priority,
        s.name AS suite_name,
        a.title AS test_title, a.file AS test_file, a.suite_path AS test_suite_path, a.full_name AS test_full_name,
        COALESCE(json_array_length(r.snapshot, '$.steps'), (SELECT COUNT(*) FROM case_steps st WHERE st.case_id = r.case_id)) AS step_count
      FROM results r
      LEFT JOIN cases c ON c.id = r.case_id
      LEFT JOIN suites s ON s.id = c.suite_id
      LEFT JOIN automated_tests a ON a.id = r.automated_test_id
      WHERE r.run_id = ? ORDER BY r.position, r.id`)
    .all(id);
  // `suite`: which suite the run came from and how the suite has changed since (null when it did not come from one). For a manual run each result also says what the
  // automated side knows about its case (information only: nothing is started).
  return {
    ...run,
    meta: parseJson(run.meta, {}),
    counts,
    suite: runSuiteInfo(run as { id: number; template_id: number | null; meta: unknown }),
    results: run.kind === "manual" ? withAutomation(run.project_id, results as { case_id: number | null }[]) : results,
  };
});

app.patch("/api/runs/:id", (req) => {
  const id = idParam(req);
  const body = z
    .object({
      title: z.string().trim().min(1).max(200).optional(),
      environment: z.string().max(200).optional(),
      milestone: z.string().max(200).optional(),
      status: z.enum(["in_progress", "completed"]).optional(),
    })
    .parse(req.body);
  const cur = must(db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, any> | undefined, "Run");
  const status = body.status ?? cur.status;
  if (body.milestone) ensureMilestone(cur.project_id, body.milestone);
  return db
    .prepare(`
      UPDATE runs SET title = ?, environment = ?, milestone = ?, status = ?,
        finished_at = CASE WHEN ? = 'completed' THEN COALESCE(finished_at, datetime('now')) ELSE NULL END
      WHERE id = ? RETURNING *`)
    .get(body.title ?? cur.title, body.environment ?? cur.environment, body.milestone ?? cur.milestone, status, status, id);
});

app.delete("/api/runs/:id", async (req) => {
  const id = idParam(req);
  const files = db
    .prepare("SELECT a.stored_name FROM attachments a JOIN results r ON r.id = a.result_id WHERE r.run_id = ?")
    .all(id) as { stored_name: string }[];
  db.prepare("DELETE FROM runs WHERE id = ?").run(id);
  await Promise.all(files.map((f) => unlink(join(UPLOAD_DIR, f.stored_name)).catch(() => {})));
  return { ok: true };
});

// ---------------- Results (manual execution) ----------------

app.get("/api/results/:id", (req) => {
  const id = idParam(req);
  const { snapshot: rawSnapshot, ...result } = must(db.prepare("SELECT * FROM results WHERE id = ?").get(id) as Record<string, any> | undefined, "Result");
  const snap = parseJson<CaseSnapshot | null>(rawSnapshot, null);
  const live = result.case_id ? getCase(result.case_id) : null;
  const run = db.prepare("SELECT ru.project_id, p.key FROM runs ru JOIN projects p ON p.id = ru.project_id WHERE ru.id = ?").get(result.run_id) as {
    project_id: number;
    key: string;
  };
  // A manual result shows the case as it was when the run started, even if it was edited or deleted since.
  const frozen = snap
    ? {
        ...(live ?? { id: null, project_id: run.project_id, project_key: run.key, tags: [], suite_id: null, status: "ready", automated: [], history: [] }),
        number: snap.number,
        title: snap.title,
        priority: snap.priority,
        description: snap.description,
        preconditions: snap.preconditions,
        steps: snap.steps,
        edited_since: !!live && JSON.stringify(snap.steps.map((s) => [s.action, s.expected])) !== JSON.stringify(live.steps.map((s: any) => [s.action, s.expected])),
      }
    : live;
  return {
    ...result,
    case: frozen,
    stepResults: db.prepare("SELECT * FROM step_results WHERE result_id = ?").all(id),
    attachments: db.prepare("SELECT * FROM attachments WHERE result_id = ? ORDER BY id").all(id),
  };
});

// Everything known about one automated result: attempts, errors, evidence files and how the same test did in earlier runs.
app.get("/api/results/:id/automated", (req) => {
  const id = idParam(req);
  const row = must(
    db
      .prepare(`
        SELECT r.id, r.run_id, r.case_id, r.automated_test_id, r.status, r.flaky, r.duration_ms, r.error, r.jira_key, r.detail,
          a.title AS test_title, a.full_name AS test_full_name, a.file AS test_file, a.suite_path AS test_suite_path, a.framework,
          ru.title AS run_title, ru.environment, ru.milestone, ru.meta, ru.started_at, p.key AS project_key, c.number AS case_number
        FROM results r
        JOIN runs ru ON ru.id = r.run_id
        JOIN projects p ON p.id = ru.project_id
        LEFT JOIN automated_tests a ON a.id = r.automated_test_id
        LEFT JOIN cases c ON c.id = r.case_id
        WHERE r.id = ?`)
      .get(id) as Record<string, any> | undefined,
    "Result",
  );
  const history = row.automated_test_id
    ? (db
        .prepare(`
          SELECT r.id, r.status, r.flaky, r.duration_ms, ru.id AS run_id, ru.title AS run_title, ru.started_at
          FROM results r JOIN runs ru ON ru.id = r.run_id
          WHERE r.automated_test_id = ? ORDER BY ru.started_at DESC, r.id DESC LIMIT 20`)
        .all(row.automated_test_id) as unknown[])
        .reverse()
    : [];
  const { detail, meta, ...rest } = row;
  return {
    ...rest,
    detail: parseJson(detail, null),
    meta: parseJson(meta, {}),
    attachments: db.prepare("SELECT id, filename, stored_name, mime, attempt, label FROM attachments WHERE result_id = ? ORDER BY attempt, id").all(id),
    history,
  };
});

const resultStatus = z.enum(["untested", "passed", "failed", "blocked", "skipped"]);

app.patch("/api/results/:id", (req) => {
  const id = idParam(req);
  const body = z
    .object({
      status: resultStatus.optional(),
      notes: z.string().max(20000).optional(),
      // A Jira key (PROJ-123) or an issue URL. Only http(s) links are accepted, since this is rendered as a link.
      jiraKey: z
        .string()
        .trim()
        .max(300)
        .refine((v) => v === "" || /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(v) || /^https?:\/\/\S+$/.test(v), "Use an issue key like PROJ-123 or a link starting with http(s)://")
        .nullable()
        .optional(),
    })
    .parse(req.body);
  const cur = must(db.prepare("SELECT * FROM results WHERE id = ?").get(id) as Record<string, any> | undefined, "Result");
  // Keys are stored upper-case (proj-1 -> PROJ-1); links are kept exactly as pasted.
  const jiraKey = body.jiraKey === undefined ? cur.jira_key : !body.jiraKey ? null : /^https?:/.test(body.jiraKey) ? body.jiraKey : body.jiraKey.toUpperCase();
  return db
    .prepare(`
      UPDATE results SET status = ?, notes = ?, jira_key = ?,
        executed_at = CASE WHEN ? != status THEN datetime('now') ELSE executed_at END
      WHERE id = ? RETURNING *`)
    .get(body.status ?? cur.status, body.notes ?? cur.notes, jiraKey, body.status ?? cur.status, id);
});

// ---- Optional Linear connection (LINEAR_API_KEY): create an issue from a failed result and keep its link on the result. ----
const asLinearHttp = (e: unknown) => (e instanceof LinearError ? new HttpError(e.status, e.message) : e);

app.get("/api/linear/status", async () => {
  if (!linearEnabled()) return { enabled: false, teams: [], defaultTeam: null };
  try {
    const teams = await listTeams();
    const want = process.env.LINEAR_TEAM_ID?.trim().toLowerCase();
    const def = teams.find((t) => want && (t.id.toLowerCase() === want || t.key.toLowerCase() === want)) ?? (teams.length === 1 ? teams[0] : null);
    return { enabled: true, teams, defaultTeam: def?.id ?? null };
  } catch (e) {
    return { enabled: true, teams: [], defaultTeam: null, error: e instanceof Error ? e.message : String(e) };
  }
});

app.post("/api/results/:id/linear-issue", async (req) => {
  const id = idParam(req);
  const body = z
    .object({ title: z.string().trim().min(1).max(255), description: z.string().max(50000), teamId: z.string().max(100).optional(), replace: z.boolean().optional() })
    .parse(req.body);
  const cur = must(db.prepare("SELECT id, jira_key FROM results WHERE id = ?").get(id) as { id: number; jira_key: string | null } | undefined, "Result");
  // A second click (or a second browser tab) must not create a duplicate issue.
  if (cur.jira_key && !body.replace) throw new HttpError(409, `This result is already linked to ${cur.jira_key}.`);
  try {
    const issue = await createIssue({ title: body.title, description: body.description, teamId: body.teamId });
    db.prepare("UPDATE results SET jira_key = ? WHERE id = ?").run(issue.url, id);
    return { identifier: issue.identifier, url: issue.url };
  } catch (e) {
    throw asLinearHttp(e);
  }
});

// ---- Optional Jira Cloud connection (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY): same idea, the issue link is kept on the result. ----
const asJiraHttp = (e: unknown) => (e instanceof JiraError ? new HttpError(e.status, e.message) : e);

app.get("/api/jira/status", async () => {
  if (!jiraEnabled()) return { enabled: false, project: null, issueType: null };
  try {
    const s = await jiraStatus();
    return { enabled: true, project: s.project, issueType: s.issueType };
  } catch (e) {
    return { enabled: true, project: process.env.JIRA_PROJECT_KEY?.trim() ?? null, issueType: null, error: e instanceof Error ? e.message : String(e) };
  }
});

app.post("/api/results/:id/jira-issue", async (req) => {
  const id = idParam(req);
  const body = z.object({ title: z.string().trim().min(1).max(255), description: z.string().max(30000) }).parse(req.body);
  const cur = must(db.prepare("SELECT id, jira_key FROM results WHERE id = ?").get(id) as { id: number; jira_key: string | null } | undefined, "Result");
  if (cur.jira_key) throw new HttpError(409, `This result is already linked to ${cur.jira_key}.`);
  try {
    const issue = await createJiraIssue(body);
    db.prepare("UPDATE results SET jira_key = ? WHERE id = ?").run(issue.url, id);
    return { identifier: issue.identifier, url: issue.url };
  } catch (e) {
    throw asJiraHttp(e);
  }
});

app.put("/api/results/:id/steps/:stepId", (req) => {
  const id = idParam(req);
  const stepId = idParam(req, "stepId");
  const body = z.object({ status: resultStatus, actual: z.string().max(10000).optional() }).parse(req.body);
  if (body.status === "untested" && !body.actual) {
    db.prepare("DELETE FROM step_results WHERE result_id = ? AND step_id = ?").run(id, stepId);
    return { ok: true };
  }
  return db
    .prepare(`
      INSERT INTO step_results (result_id, step_id, status, actual) VALUES (?, ?, ?, ?)
      ON CONFLICT (result_id, step_id) DO UPDATE SET status = excluded.status, actual = excluded.actual RETURNING *`)
    .get(id, stepId, body.status, body.actual ?? "");
});

const ATTACHMENT_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".webm", ".txt", ".log", ".pdf"]);

app.post("/api/results/:id/attachments", async (req) => {
  const id = idParam(req);
  must(db.prepare("SELECT id FROM results WHERE id = ?").get(id), "Result");
  const saved = [];
  for await (const part of req.files()) {
    const ext = extname(part.filename).toLowerCase();
    if (!ATTACHMENT_EXT.has(ext)) throw new HttpError(400, `File type ${ext || "(none)"} is not allowed`);
    const stored = `${randomUUID()}${ext}`;
    await writeFile(join(UPLOAD_DIR, stored), await part.toBuffer());
    saved.push(
      db
        .prepare("INSERT INTO attachments (result_id, filename, stored_name, mime) VALUES (?, ?, ?, ?) RETURNING *")
        .get(id, part.filename, stored, part.mimetype),
    );
  }
  return saved;
});

// All attachments of a result in one zip, to drag into a Jira ticket.
app.get("/api/results/:id/attachments.zip", async (req, reply) => {
  const id = idParam(req);
  const rows = db.prepare("SELECT filename, stored_name FROM attachments WHERE result_id = ? ORDER BY id").all(id) as { filename: string; stored_name: string }[];
  if (!rows.length) throw new HttpError(404, "This result has no attachments");
  const files: Record<string, Uint8Array> = {};
  for (const r of rows) {
    // Keep the original name, adding a counter when two attachments share one (pasted screenshots are often both "image.png").
    const base = r.filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_") || "attachment";
    const dot = base.lastIndexOf(".");
    let name = base;
    for (let n = 2; name in files; n++) name = dot > 0 ? `${base.slice(0, dot)}-${n}${base.slice(dot)}` : `${base}-${n}`;
    files[name] = new Uint8Array(await readFile(join(UPLOAD_DIR, r.stored_name)));
  }
  reply.type("application/zip").header("Content-Disposition", `attachment; filename="result-${id}-attachments.zip"`);
  return Buffer.from(zipSync(files));
});

app.delete("/api/attachments/:id", async (req) => {
  const row = db.prepare("DELETE FROM attachments WHERE id = ? RETURNING stored_name").get(idParam(req)) as { stored_name: string } | undefined;
  if (row) await unlink(join(UPLOAD_DIR, row.stored_name)).catch(() => {});
  return { ok: true };
});

// ---------------- Automated tests ----------------

app.get("/api/projects/:id/automated", (req) =>
  db
    .prepare(`
      SELECT a.*, c.number AS case_number, c.title AS case_title,
        (SELECT COUNT(*) FROM results r WHERE r.automated_test_id = a.id) AS run_count,
        (SELECT COUNT(*) FROM results r WHERE r.automated_test_id = a.id AND r.status = 'failed') AS fail_count,
        (SELECT COUNT(*) FROM results r WHERE r.automated_test_id = a.id AND r.flaky = 1) AS flaky_count,
        (SELECT AVG(r.duration_ms) FROM results r WHERE r.automated_test_id = a.id) AS avg_duration_ms
      FROM automated_tests a LEFT JOIN cases c ON c.id = a.case_id
      WHERE a.project_id = ? ORDER BY a.file, a.suite_path, a.title`)
    .all(idParam(req)),
);

// ---- Optional AI link suggestions: on only when TYPESAFE_API_KEY is set ----
app.get("/api/features", () => ({ linkSuggestions: !!typesafeConfig() }));

app.get("/api/projects/:id/automated/link-suggestions", (req) => listSuggestions(idParam(req)));

app.post("/api/projects/:id/automated/suggest-links", async (req) => {
  const id = idParam(req);
  must(db.prepare("SELECT id FROM projects WHERE id = ?").get(id), "Project");
  const body = z.object({ limit: z.number().int().optional(), force: z.boolean().optional() }).parse(req.body ?? {});
  try {
    return await suggestLinks(id, body);
  } catch (e) {
    if (e instanceof SuggestError) throw new HttpError(e.status, e.message);
    throw e;
  }
});

app.post("/api/link-suggestions/dismiss", (req) => {
  const { testId, caseId } = z.object({ testId: z.number().int(), caseId: z.number().int() }).parse(req.body);
  dismissSuggestion(testId, caseId);
  return { ok: true };
});

// Re-check unlinked automated tests against the case IDs in their names.
app.post("/api/projects/:id/automated/relink", (req) => ({ linked: relinkAutomatedTests(idParam(req)) }));

app.patch("/api/automated/:id", (req) => {
  const id = idParam(req);
  const body = z.object({ caseId: z.number().int().nullable() }).parse(req.body);
  const test = must(db.prepare("SELECT * FROM automated_tests WHERE id = ?").get(id) as Record<string, any> | undefined, "Test");
  if (body.caseId !== null) {
    const c = db.prepare("SELECT project_id FROM cases WHERE id = ?").get(body.caseId) as { project_id: number } | undefined;
    if (c?.project_id !== test.project_id) throw new HttpError(400, "Case belongs to another project");
  }
  db.transaction(() => {
    db.prepare("UPDATE automated_tests SET case_id = ? WHERE id = ?").run(body.caseId, id);
    // Results already imported for this test follow the link, so case history stays complete.
    db.prepare("UPDATE results SET case_id = ? WHERE automated_test_id = ?").run(body.caseId, id);
  })();
  return { ok: true };
});

// ---------------- Report upload ----------------

const FRAMEWORKS = ["playwright", "testcafe", "selenium", "bruno", "junit"] as const;

app.post("/api/projects/:id/import", async (req) => {
  const projectId = idParam(req);
  const fields: Record<string, string> = {};
  const parsed: ParsedReport[] = [];
  const names: string[] = [];
  const bags: FileBag[] = [];
  const loose = new Map<string, Uint8Array>();
  let relpath = "";
  for await (const part of req.parts()) {
    if (part.type === "field") {
      // A folder upload sends each file's path inside the chosen folder in a "relpath" field, just before the file itself.
      if (part.fieldname === "relpath") relpath = String(part.value ?? "");
      else fields[part.fieldname] = String(part.value ?? "");
      continue;
    }
    const fromFolder = !!relpath;
    const name = relpath || part.filename;
    relpath = "";
    const bytes = new Uint8Array(await part.toBuffer());
    const hint = (FRAMEWORKS as readonly string[]).includes(fields.framework) ? (fields.framework as Framework) : undefined;
    // Inside a picked folder a .zip is a trace to keep as evidence; a zip picked on its own is a downloaded artifact to unpack.
    if (!fromFolder && /\.zip$/i.test(name)) {
      // A downloaded artifact: the reports plus the screenshots, videos and traces next to them.
      try {
        const bag = bagFromZip(bytes);
        bags.push(bag);
        parsed.push(...readReports(bag));
        names.push(part.filename);
      } catch {
        throw new HttpError(400, `${part.filename}: not a readable zip file`);
      }
    } else if (/\.(xml|json)$/i.test(name) && !/(^|\/)(package(-lock)?|tsconfig)\.json$/i.test(name)) {
      try {
        parsed.push(parseReport(Buffer.from(bytes).toString("utf8"), hint));
        names.push(part.filename);
      } catch (e) {
        // A file you picked on its own must be a report; inside a folder, other JSON/XML files (.last-run.json...) are just skipped.
        if (!fromFolder) throw new HttpError(400, `${part.filename}: ${(e as Error).message}`);
      }
    } else {
      loose.set(name, bytes); // evidence (screenshot, video, trace) that belongs to a report in this upload
    }
  }
  const reports = dedupeReports(parsed);
  if (!reports.length) throw new HttpError(400, "No test reports found. Add a JUnit XML or Playwright JSON file, or a zip containing one.");
  bags.push(bagFromFiles(loose));
  const merged = mergeReports(reports);
  const title = fields.title?.trim() || `${merged.framework} · ${names.join(", ")}`.slice(0, 200);
  return importReport(
    merged,
    { projectId, source: "upload", title, environment: fields.environment ?? "", milestone: fields.milestone ?? "", meta: { files: names } },
    mergeBags(bags),
  );
});

// ---------------- Audit packages and bug reports ----------------
// Reports from a test agent arrive as a package (a GitHub artifact named testbench-audit-*, or an upload) and start as "proposed".
// Nothing here sends anything to Jira or Linear; accepting a report is only a decision made in Testbench.

const asAuditHttp = (e: unknown) => (e instanceof AuditError ? new HttpError(e.status, e.message) : e instanceof PackageError ? new HttpError(400, e.message) : e);
function audited<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw asAuditHttp(e);
  }
}

// A zip, or a picked folder (each file preceded by its "relpath" field). ?dryRun=1 only reports what would happen.
app.post("/api/projects/:id/audit-import", async (req) => {
  const projectId = idParam(req);
  const dryRun = (req.query as { dryRun?: string }).dryRun === "1";
  const loose = new Map<string, Uint8Array>();
  let zip: FileBag | null = null;
  let relpath = "";
  let total = 0;
  for await (const part of req.parts()) {
    if (part.type === "field") {
      if (part.fieldname === "relpath") relpath = String(part.value ?? "");
      continue;
    }
    const fromFolder = !!relpath;
    const name = relpath || part.filename;
    relpath = "";
    const bytes = new Uint8Array(await part.toBuffer());
    total += bytes.length;
    if (total > AUDIT_LIMITS.totalBytes) throw new HttpError(400, `The upload is larger than ${AUDIT_LIMITS.totalBytes / 1024 / 1024} MB`);
    if (!fromFolder && /\.zip$/i.test(name)) {
      if (zip) throw new HttpError(400, "Upload one audit package at a time");
      try {
        zip = bagFromZip(bytes);
      } catch {
        throw new HttpError(400, `${part.filename}: not a readable zip file`);
      }
    } else {
      loose.set(name, bytes);
    }
  }
  if (zip && loose.size) throw new HttpError(400, "Upload either one zip or one folder, not both");
  if (!zip && !loose.size) throw new HttpError(400, "Choose a zip file or a folder with the audit package");
  return audited(() => importAuditPackage(zip ?? bagFromFiles(loose), { projectId, source: "upload" }, { dryRun }));
});

// ---- Observations: results of load tests and security reviews that are not bugs. Their own list and status model; turning one into a bug is a manual action. ----
const asObservationHttp = (e: unknown) => (e instanceof ObservationError ? new HttpError(e.status, e.message, e.problems) : e);
function observed<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw asObservationHttp(e);
  }
}

// A JSON array of observations (or { observations, evidence } to translate EV-... labels). ?dryRun=1 only reports what would happen.
app.post("/api/projects/:id/observations", { bodyLimit: 6 * 1024 * 1024 }, (req) =>
  observed(() => importObservations(idParam(req), req.body, { dryRun: (req.query as { dryRun?: string }).dryRun === "1" })));

app.get("/api/projects/:id/observations", (req) => {
  const q = req.query as Record<string, string | undefined>;
  return observed(() => listObservations(idParam(req), { kind: q.kind || undefined, severity: q.severity || undefined, status: q.status || undefined, audit: Number(q.audit) || undefined, q: q.q }));
});

// The figures for the counters: how many are active (observed, needs_review, confirmed) and how many of them need a review.
app.get("/api/projects/:id/observations/summary", (req) => observed(() => observationSummary(idParam(req))));

app.get("/api/observations/:id", (req) => must(getObservation(idParam(req)), "Observation"));

app.patch("/api/observations/:id", (req) => observed(() => setObservationStatus(idParam(req), (req.body as { status?: unknown } | null)?.status)));

// Closing and reopening are separate actions. A converted observation (tracked as a bug report) cannot be archived or resolved: 409.
app.post("/api/observations/:id/archive", (req) => observed(() => archiveObservation(idParam(req))));
app.post("/api/observations/:id/resolve", (req) => observed(() => resolveObservation(idParam(req))));
app.post("/api/observations/:id/reopen", (req) => observed(() => reopenObservation(idParam(req))));

app.post("/api/observations/:id/convert-to-bug", (req) => observed(() => convertToBug(idParam(req))));

app.get("/api/projects/:id/bug-reports", (req) => {
  const q = req.query as Record<string, string | undefined>;
  return audited(() => listBugReports(idParam(req), {
    status: q.status, q: q.q, presence: q.presence, source: q.source || undefined, workflow: q.workflow || undefined, severity: q.severity || undefined,
    tag: q.tag || undefined, testKey: q.testKey || undefined, assignee: q.assignee || undefined, new: q.new || undefined,
  }));
});

// ---- CI results: failed tests become bugs, keyed by the test's stable key (see server/ci.ts) ----
const ciLimiter = makeLimiter({ max: 20, windowMs: 15 * 60_000 });
app.post("/api/projects/:id/ci/test-results", { bodyLimit: CI_LIMITS.bodyBytes }, async (req, reply) => {
  const id = idParam(req);
  if (ciLimiter.blockedFor(req.ip) > 0) return reply.code(429).send({ error: "Too many failed attempts. Try again later." });
  if (!authenticateCiToken(req.headers.authorization, id)) {
    ciLimiter.fail(req.ip);
    throw new HttpError(401, "A valid API token for this project is required: send it as Authorization: Bearer <token>");
  }
  return audited(() => ingestCiResults(id, req.body));
});
app.get("/api/projects/:id/ci/tokens", (req) => listCiTokens(idParam(req)));
app.post("/api/projects/:id/ci/tokens", (req) => {
  const id = idParam(req);
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id)) throw new HttpError(404, "Project not found");
  const body = z.object({ name: z.string().max(80) }).parse(req.body);
  return audited(() => createCiToken(id, body.name));
});
app.post("/api/ci-tokens/:id/revoke", (req) => {
  audited(() => revokeCiToken(idParam(req)));
  return { ok: true };
});
// ---- Agent tokens: read-only tokens for a test agent. The token route below is separate from the login-protected export
// (GET /api/projects/:id/agent/requirements, unchanged) and works for nothing else. See server/agenttokens.ts and server/agentapi.ts. ----
const agentLimiter = makeLimiter({ max: 20, windowMs: 15 * 60_000 });
app.get("/api/agent/projects/:id/requirements", async (req, reply) => {
  const id = idParam(req);
  if (agentLimiter.blockedFor(req.ip) > 0) return reply.code(429).send({ error: "Too many failed attempts. Try again later." });
  const auth = authenticateAgentToken(req.headers.authorization, id);
  if (auth === "invalid") {
    agentLimiter.fail(req.ip);
    throw new HttpError(401, "A valid agent token is required: send it as Authorization: Bearer <token>");
  }
  if (auth === "other_project") {
    agentLimiter.fail(req.ip);
    throw new HttpError(403, "This token does not belong to this project");
  }
  const opts = audited(() => parseAgentQuery(req.query));
  reply.header("Cache-Control", "no-store");
  return audited(() => agentRequirementsForToken(id, opts));
});
// Made and revoked by whoever is signed in (there are no roles). The token is in the answer to the creating call only; the list never has it.
app.get("/api/projects/:id/agent/tokens", (req) => listAgentTokens(idParam(req)));
app.post("/api/projects/:id/agent/tokens", (req, reply) => {
  const id = idParam(req);
  const body = z.object({ name: z.string().max(200) }).parse(req.body);
  reply.header("Cache-Control", "no-store");
  return audited(() => createAgentToken(id, body.name));
});
app.post("/api/agent-tokens/:id/revoke", (req) => {
  audited(() => revokeAgentToken(idParam(req)));
  return { ok: true };
});
app.post("/api/bug-reports/:id/triage", (req) => {
  const id = idParam(req);
  const body = z.object({ assignee: z.string().max(100).optional(), workflowStatus: z.enum(WORKFLOW_STATUSES).optional() }).parse(req.body);
  audited(() => setTriage(id, body));
  return getBugReport(id);
});
app.get("/api/projects/:id/audits", (req) => listAudits(idParam(req)));
app.get("/api/projects/:id/audit-rejections", (req) => listRejectedPackages(idParam(req)));
app.get("/api/bug-reports/:id", (req) => audited(() => getBugReport(idParam(req))));

const severity = z.enum(["low", "medium", "high", "critical"]);
app.patch("/api/bug-reports/:id", (req) => {
  const id = idParam(req);
  const body = z
    .object({
      title: z.string().trim().min(1).max(200).optional(), description: z.string().max(20000).optional(), steps: z.array(z.string().max(1000)).max(50).optional(),
      expected: z.string().max(5000).optional(), actual: z.string().max(5000).optional(), environment: z.string().max(200).optional(), url: z.string().max(2000).optional(),
      humanSeverity: severity.nullable().optional(), severityReason: z.string().trim().max(200).optional(),
    })
    .parse(req.body);
  audited(() => updateBugReport(id, body));
  return getBugReport(id);
});
app.post("/api/bug-reports/:id/review", (req) => {
  const id = idParam(req);
  const body = z.object({ status: z.enum(["proposed", "accepted", "rejected"]), note: z.string().max(2000).optional(), severity: severity.optional(), severityReason: z.string().trim().max(200).optional() }).parse(req.body);
  audited(() => reviewBugReport(id, body.status, body.note, body.severity ? { value: body.severity, reason: body.severityReason } : undefined));
  return getBugReport(id);
});
app.post("/api/bug-reports/:id/duplicate", (req) => {
  const id = idParam(req);
  const body = z.object({ ofId: z.number().int(), note: z.string().max(2000).optional() }).parse(req.body);
  audited(() => markDuplicate(id, body.ofId, body.note));
  return getBugReport(id);
});
app.post("/api/bug-reports/:id/external-link", (req) => {
  const id = idParam(req);
  const body = z.object({ destination: z.enum(["jira", "linear", "other"]), url: z.string().max(2000), externalId: z.string().max(100).optional() }).parse(req.body);
  audited(() => linkExternalIssue(id, body));
  return getBugReport(id);
});
app.delete("/api/bug-publications/:id", (req) => audited(() => (unlinkExternalIssue(idParam(req)), { ok: true })));

// ---- Publishing an accepted report to the project's destination (Linear). Nothing is sent without a preview and an explicit approval of it. ----
const asPublishHttp = (e: unknown) => (e instanceof PublishError ? new HttpError(e.status, e.message) : e);
async function publishing<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw asPublishHttp(e);
  }
}
const selection = { refIds: z.array(z.number().int()).max(200).optional(), attachmentIds: z.array(z.number().int()).max(200).optional() };

// The key itself is never returned: only where it comes from and its last four characters.
app.get("/api/projects/:id/destination", (req) => ({ destination: getDestination(idParam(req)), serverKey: linearEnabled() }));
app.post("/api/projects/:id/destination/teams", async (req) => {
  const id = idParam(req);
  const body = z.object({ token: z.string().max(500).optional() }).parse(req.body ?? {});
  return publishing(() => lookupTeams(id, body.token));
});
app.put("/api/projects/:id/destination", async (req) => {
  const id = idParam(req);
  const body = z.object({ token: z.string().max(500).optional(), team: z.string().max(100).optional() }).parse(req.body);
  return publishing(async () => ({ destination: await saveDestination(id, body), serverKey: linearEnabled() }));
});
app.delete("/api/projects/:id/destination", (req) => (removeDestination(idParam(req)), { ok: true }));

app.post("/api/bug-reports/:id/publish-preview", (req) => {
  const id = idParam(req);
  const body = z.object(selection).parse(req.body ?? {});
  return publishing(() => buildPreview(id, body));
});
app.post("/api/bug-reports/:id/publish", async (req) => {
  const id = idParam(req);
  const body = z.object({ ...selection, previewHash: z.string().min(1).max(100), approve: z.boolean() }).parse(req.body);
  return publishing(async () => {
    const publication = await publishBug(id, body);
    return { publication, report: getBugReport(id) };
  });
});
app.post("/api/bug-publications/:id/check", async (req) => publishing(() => checkPublication(idParam(req))));
app.post("/api/bug-publications/:id/retry-attachments", async (req) => publishing(() => retryAttachments(idParam(req))));
app.post("/api/bug-reports/:id/apply-update", (req) => {
  const id = idParam(req);
  audited(() => applyPendingUpdate(id));
  return getBugReport(id);
});
app.post("/api/bug-reports/:id/ignore-update", (req) => {
  const id = idParam(req);
  audited(() => ignorePendingUpdate(id));
  return getBugReport(id);
});
app.post("/api/bug-reports/:id/relink", (req) => {
  const id = idParam(req);
  const b = audited(() => getBugReport(id));
  relinkBugRefs(b.projectId, id);
  return getBugReport(id);
});
app.delete("/api/bug-reports/:id", (req) => audited(() => (deleteBugReport(idParam(req), (req.query as { force?: string }).force === "1"), { ok: true })));

app.get("/api/audits/:id/plan", (req) => audited(() => getAuditPlan(idParam(req))));
// The plan is a workspace a person owns. Only a signed-in person with the tester role reaches these; an agent, CI or propose token never does (see access.ts).
const planFields = z.object({
  title: z.string().trim().min(1).max(300), type: z.string().trim().max(100), risk: z.string().trim().max(100), priority: z.string().trim().max(100),
  readiness: z.enum(["", "ready", "needs-clarification"]), preconditions: z.string().max(5000), testData: z.string().max(5000),
  steps: z.array(z.string().max(2000)).max(100), acceptanceCriteria: z.string().max(5000), automation: z.string().max(1000), requirements: z.array(z.string().trim().max(200)).max(50),
});
const sourceParam = (req: { params: unknown }) => z.object({ sourceId: z.string().min(1).max(200) }).parse(req.params).sourceId;
app.post("/api/audits/:id/plan/items", (req) => {
  const id = idParam(req);
  const body = planFields.partial().required({ title: true }).strict().parse(req.body);
  audited(() => addPlanItem(id, body));
  return getAuditPlan(id);
});
app.patch("/api/audits/:id/plan/items/:sourceId", (req) => {
  const id = idParam(req);
  const body = planFields.partial().strict().parse(req.body);
  audited(() => editPlanItem(id, sourceParam(req), body));
  return getAuditPlan(id);
});
app.post("/api/audits/:id/plan/items/:sourceId/decision", (req) => {
  const id = idParam(req);
  const body = z.object({ status: z.enum(["draft", "approved", "rejected"]), note: z.string().max(500).optional() }).strict().parse(req.body);
  audited(() => decidePlanItem(id, sourceParam(req), body.status, body.note));
  return getAuditPlan(id);
});
app.post("/api/audits/:id/plan/items/:sourceId/pending", (req) => {
  const id = idParam(req);
  const body = z.object({ action: z.enum(["apply", "ignore"]) }).strict().parse(req.body);
  audited(() => resolvePending(id, sourceParam(req), body.action));
  return getAuditPlan(id);
});
app.get("/api/audits/:id/history", (req) => audited(() => planHistory(idParam(req))));
// Coverage gaps work the same way as plan items, with the same rules and the same access.
const gapFields = z.object({ description: z.string().trim().min(1).max(5000), requirements: z.array(z.string().trim().max(200)).max(50) });
app.post("/api/audits/:id/gaps", (req) => {
  const id = idParam(req);
  const body = gapFields.partial().required({ description: true }).strict().parse(req.body);
  audited(() => addGap(id, body));
  return getAuditPlan(id);
});
app.patch("/api/audits/:id/gaps/:sourceId", (req) => {
  const id = idParam(req);
  const body = gapFields.partial().strict().parse(req.body);
  audited(() => editGap(id, sourceParam(req), body));
  return getAuditPlan(id);
});
app.post("/api/audits/:id/gaps/:sourceId/decision", (req) => {
  const id = idParam(req);
  const body = z.object({ status: z.enum(["draft", "approved", "rejected"]), note: z.string().max(500).optional() }).strict().parse(req.body);
  audited(() => decideGap(id, sourceParam(req), body.status, body.note));
  return getAuditPlan(id);
});
app.post("/api/audits/:id/gaps/:sourceId/pending", (req) => {
  const id = idParam(req);
  const body = z.object({ action: z.enum(["apply", "ignore"]) }).strict().parse(req.body);
  audited(() => resolveGapPending(id, sourceParam(req), body.action));
  return getAuditPlan(id);
});
app.get("/api/audits/:id/gaps/history", (req) => audited(() => gapHistory(idParam(req))));
// Automation suggestions for an approved plan item: made by a fixed rule, decided by a person. Nothing is generated, run or changed until a person decides; Apply makes a DRAFT test case.
const suggestionFields = z.object({ summary: z.string().trim().min(1).max(300), steps: z.array(z.string().max(1000)).min(1).max(100), assertions: z.array(z.string().max(500)).max(50), testData: z.string().max(5000), plan: z.string().max(5000), artifactText: z.string().max(100000) });
app.post("/api/audits/:id/plan/items/:sourceId/automation-suggestions", (req) => {
  const id = idParam(req);
  z.object({}).strict().parse(req.body ?? {});
  const made = audited(() => suggestAutomation(id, sourceParam(req)));
  return { ...made, suggestions: listAutomationSuggestions(id) };
});
app.get("/api/audits/:id/automation-suggestions", (req) => audited(() => listAutomationSuggestions(idParam(req))));
// The same for an approved requirement. Editing, deciding and applying use the routes below, which work on the suggestion's own id.
app.post("/api/requirements/:id/automation-suggestions", (req) => {
  const id = idParam(req);
  z.object({}).strict().parse(req.body ?? {});
  const made = audited(() => suggestAutomationForRequirement(id));
  return { ...made, suggestions: listRequirementAutomationSuggestions(id) };
});
app.get("/api/requirements/:id/automation-suggestions", (req) => audited(() => listRequirementAutomationSuggestions(idParam(req))));
// A Playwright spec suggestion for an approved requirement. The file is downloaded with the route below, after a person has applied it.
app.post("/api/requirements/:id/spec-suggestions", (req) => {
  const id = idParam(req);
  z.object({}).strict().parse(req.body ?? {});
  const made = audited(() => suggestSpecForRequirement(id));
  return { ...made, suggestions: listRequirementAutomationSuggestions(id) };
});
app.patch("/api/automation-suggestions/:id", (req) => {
  const id = idParam(req);
  const body = suggestionFields.partial().strict().parse(req.body);
  audited(() => editAutomationSuggestion(id, body));
  return getAutomationSuggestion(id);
});
app.post("/api/automation-suggestions/:id/decision", (req) => {
  const id = idParam(req);
  const body = z.object({ status: z.enum(["draft", "approved", "rejected", "ignored", "proposed"]), note: z.string().max(500).optional() }).strict().parse(req.body);
  audited(() => decideAutomationSuggestion(id, body.status, body.note));
  return getAutomationSuggestion(id);
});
app.post("/api/automation-suggestions/:id/apply", (req) => {
  const id = idParam(req);
  z.object({}).strict().parse(req.body ?? {});
  // A spec suggestion is applied as a draft spec (the file can then be downloaded); anything else as a draft test case.
  const isSpec = audited(() => getAutomationSuggestion(id).isSpec);
  if (isSpec) {
    const spec = audited(() => applySpecSuggestion(id));
    return { spec, suggestion: getAutomationSuggestion(id) };
  }
  const made = audited(() => applyAutomationSuggestion(id));
  return { case: made, suggestion: getAutomationSuggestion(id) };
});
// Bug drafts (G): a screenshot and a short note become a draft bug report by a fixed rule. A person edits, decides and applies it; Apply makes a bug report that stays proposed.
app.get("/api/projects/:id/bug-drafts", (req) => audited(() => listBugDrafts(idParam(req))));
app.post("/api/projects/:id/bug-drafts", async (req) => {
  const id = idParam(req);
  must(db.prepare("SELECT id FROM projects WHERE id = ?").get(id), "Project");
  let note = "";
  let buf: Buffer | null = null;
  let truncated = false;
  let filename = "";
  for await (const part of req.parts({ limits: { fileSize: MAX_SCREENSHOT_BYTES + 1, files: 1, fields: 4, fieldSize: 20000 } })) {
    if (part.type === "file") {
      if (buf) throw new HttpError(400, "Attach one screenshot");
      buf = await part.toBuffer();
      truncated = part.file.truncated;
      filename = part.filename;
    } else if (part.fieldname === "note") note = String(part.value);
  }
  const made = buildBugDraft(note);
  if ("reason" in made) throw new HttpError(400, made.reason);
  const shot = audited(() => checkScreenshot(buf, truncated));
  const stored = `draft-${randomUUID()}.${shot.ext}`;
  await writeFile(join(UPLOAD_DIR, stored), buf as Buffer);
  try {
    return audited(() => createBugDraft(id, note, { storedName: stored, filename, mime: shot.mime, size: shot.size, sha256: shot.sha256 }));
  } catch (e) {
    await unlink(join(UPLOAD_DIR, stored)).catch(() => {});
    throw e;
  }
});
app.get("/api/bug-drafts/:id/screenshot", async (req, reply) => {
  const s = audited(() => bugDraftScreenshot(idParam(req)));
  const data = await readFile(join(UPLOAD_DIR, s.storedName)).catch(() => null);
  if (!data) throw new HttpError(404, "The screenshot file is missing");
  reply.type(s.mime).header("Content-Disposition", `attachment; filename="${s.fileName}"`).header("X-Content-Type-Options", "nosniff").header("Content-Security-Policy", "default-src 'none'; sandbox").header("Cache-Control", "private, no-store");
  return data;
});
const bugDraftFields = z.object({ title: z.string().max(1000), description: z.string().max(20000), steps: z.array(z.string().max(2000)).max(100), expected: z.string().max(10000), actual: z.string().max(10000) });
app.patch("/api/bug-drafts/:id", (req) => {
  const id = idParam(req);
  const body = bugDraftFields.partial().strict().parse(req.body);
  audited(() => editBugDraft(id, body));
  return getBugDraft(id);
});
app.post("/api/bug-drafts/:id/decision", (req) => {
  const id = idParam(req);
  const body = z.object({ status: z.enum(["draft", "approved", "rejected", "ignored", "proposed"]), note: z.string().max(500).optional() }).strict().parse(req.body);
  audited(() => decideBugDraft(id, body.status, body.note));
  return getBugDraft(id);
});
app.post("/api/bug-drafts/:id/apply", (req) => {
  const id = idParam(req);
  z.object({}).strict().parse(req.body ?? {});
  const made = audited(() => applyBugDraft(id));
  return { bugId: made.bugId, draft: getBugDraft(id) };
});
// A Playwright spec suggestion for an approved plan item, and the file of an applied spec (a text download: nothing is run, and nothing is written to disk or to git by the server).
app.post("/api/audits/:id/plan/items/:sourceId/spec-suggestions", (req) => {
  const id = idParam(req);
  z.object({}).strict().parse(req.body ?? {});
  const made = audited(() => suggestSpecForPlanItem(id, sourceParam(req)));
  return { ...made, suggestions: listAutomationSuggestions(id) };
});
app.get("/api/automation-suggestions/:id/spec", (req, reply) => {
  const f = audited(() => specFile(idParam(req)));
  reply.type("text/plain; charset=utf-8").header("Content-Disposition", `attachment; filename="${f.fileName}"`).header("X-Content-Type-Options", "nosniff");
  return f.text;
});
app.get("/api/audits/:id/deletion-preview", (req) => {
  const { removable: _ids, manualRemovable: _mids, ...preview } = audited(() => previewAuditDeletion(idParam(req)));
  return preview;
});
app.delete("/api/audits/:id", (req) => audited(() => deleteAudit(idParam(req))));
app.get("/api/audits/:id/report", (req, reply) => {
  const text = audited(() => auditReportText(idParam(req)));
  // Shown as plain text: the agent's report is never interpreted as markup.
  reply.type("text/plain; charset=utf-8").header("X-Content-Type-Options", "nosniff");
  return text;
});

// ---- Manual test cases proposed by a test agent (manual-tests.json in an audit package). A person reviews and runs them; nothing here runs a test. ----
app.get("/api/projects/:id/manual-tests", (req) => {
  const q = req.query as { status?: string; q?: string; category?: string; priority?: string; wcag?: string; presence?: string; new?: string };
  return audited(() => listManualTests(idParam(req), q));
});
app.get("/api/manual-tests/:id", (req) => audited(() => getManualTest(idParam(req))));
app.patch("/api/manual-tests/:id", (req) => {
  const id = idParam(req);
  const body = z
    .object({
      title: z.string().trim().min(1).max(200).optional(), description: z.string().max(20000).optional(), preconditions: z.string().max(5000).optional(),
      steps: z.array(z.string().max(1000)).min(1).max(50).optional(), expected: z.string().trim().min(1).max(5000).optional(),
      humanPriority: severity.nullable().optional(), requirements: z.array(z.string().max(120)).max(50).optional(),
    })
    .parse(req.body);
  audited(() => updateManualTest(id, body));
  return getManualTest(id);
});
app.post("/api/manual-tests/:id/review", (req) => {
  const id = idParam(req);
  const body = z.object({ status: z.enum(["proposed", "accepted", "rejected"]), note: z.string().max(2000).optional() }).parse(req.body);
  audited(() => reviewManualTest(id, body.status, body.note));
  return getManualTest(id);
});
// A person takes a suggestion into the project in one step: accepted and made into a test case, as a draft.
app.post("/api/manual-tests/:id/add-to-project", (req) => {
  const id = idParam(req);
  const body = z.object({ note: z.string().max(2000).optional() }).parse(req.body ?? {});
  const made = audited(() => addToProject(id, body.note));
  return { case: made, manualTest: getManualTest(id) };
});
// A person turns an accepted proposal into a test case of the project (to be run in Runs).
app.post("/api/manual-tests/:id/create-case", (req) => {
  const id = idParam(req);
  const made = audited(() => createCaseFromProposal(id));
  return { case: made, manualTest: getManualTest(id) };
});
app.post("/api/manual-tests/:id/apply-update", (req) => {
  const id = idParam(req);
  audited(() => applyManualUpdate(id));
  return getManualTest(id);
});
app.post("/api/manual-tests/:id/ignore-update", (req) => {
  const id = idParam(req);
  audited(() => ignoreManualUpdate(id));
  return getManualTest(id);
});
app.post("/api/manual-tests/:id/relink", (req) => {
  const id = idParam(req);
  const m = audited(() => getManualTest(id));
  relinkManualRefs(m.projectId, id);
  return getManualTest(id);
});
app.delete("/api/manual-tests/:id", (req) => audited(() => (deleteManualTest(idParam(req), (req.query as { force?: string }).force === "1"), { ok: true })));


// ---------------- GitHub ----------------

app.get("/api/github/status", async () => {
  const token = await getToken();
  return { authenticated: !!token, via: process.env.GITHUB_TOKEN ? "GITHUB_TOKEN" : token ? "gh CLI" : null };
});

app.get("/api/projects/:id/github-sources", (req) =>
  db
    .prepare(`
      SELECT gs.*,
        (SELECT COUNT(*) FROM github_seen s WHERE s.source_id = gs.id AND s.outcome = 'imported') AS imported_count,
        (SELECT COUNT(*) FROM github_seen s WHERE s.source_id = gs.id AND s.outcome = 'skipped') AS skipped_count,
        (SELECT s.note FROM github_seen s WHERE s.source_id = gs.id AND s.outcome = 'skipped' ORDER BY s.seen_at DESC LIMIT 1) AS last_skip_note
      FROM github_sources gs WHERE gs.project_id = ? ORDER BY gs.id`)
    .all(idParam(req)),
);

/** Workflow ids or file names allowed to deliver audit packages, stored as a normalised comma separated list. */
const auditWorkflowsField = z.string().max(500).transform((text, ctx) => {
  try {
    return parseWorkflowList(text).join(", ");
  } catch (e) {
    ctx.addIssue({ code: "custom", message: (e as Error).message });
    return z.NEVER;
  }
});

app.post("/api/projects/:id/github-sources", (req) => {
  const projectId = idParam(req);
  const body = z
    .object({
      repo: z.string().trim().regex(REPO_SLUG, "Use owner/repo"),
      workflow: z.string().trim().max(200).optional(),
      artifactPattern: z.string().trim().max(200).optional(),
      auditWorkflows: auditWorkflowsField.optional(),
    })
    .parse(req.body);
  const [owner, repo] = body.repo.split("/");
  try {
    return db
      .prepare("INSERT INTO github_sources (project_id, owner, repo, workflow, artifact_pattern, audit_workflows) VALUES (?, ?, ?, ?, ?, ?) RETURNING *")
      .get(projectId, owner, repo, body.workflow ?? "", body.artifactPattern ?? "", body.auditWorkflows ?? "");
  } catch {
    throw new HttpError(409, "This repository/workflow is already connected");
  }
});

app.delete("/api/github-sources/:id", (req) => {
  db.prepare("DELETE FROM github_sources WHERE id = ?").run(idParam(req));
  return { ok: true };
});

const getSource = (id: number) => must(db.prepare("SELECT * FROM github_sources WHERE id = ?").get(id) as GithubSource | undefined, "Source");

app.get("/api/github-sources/:id/runs", async (req) => {
  const src = getSource(idParam(req));
  const runs = await listRuns(src);
  // null = couldn't find out (the run list still works without it)
  const artifacts = await artifactsByRun(src).catch(() => null);
  const imported = new Map(
    (
      db
        .prepare("SELECT id, external_id FROM runs WHERE project_id = ? AND source = 'github' AND external_id LIKE ?")
        .all(src.project_id, `${src.owner}/${src.repo}#%`) as { id: number; external_id: string }[]
    ).map((r) => [r.external_id, r.id]),
  );
  return runs.map((r) => ({
    ...r,
    imported_run_id: imported.get(`${src.owner}/${src.repo}#${r.id}`) ?? null,
    artifact_count: artifacts ? (artifacts.get(r.id) ?? 0) : null,
  }));
});

app.post("/api/github-sources/:id/runs/:runId/import", async (req) => {
  const src = getSource(idParam(req));
  try {
    return await importRun(src, idParam(req, "runId"));
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});

// ---------------- Run templates = Suites (runnable groups of cases; see server/runsuites.ts) ----------------

const templateBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(10000).optional(),
  environment: z.string().max(200).optional(),
  caseIds: z.array(z.number().int()).max(5000),
  /** A 5-field cron expression, or null (or empty) for no schedule. See server/scheduler.ts. The time zone is the suite's own. */
  schedule: z.string().max(100).nullable().optional(),
  scheduleTimezone: z.string().max(64).optional(),
});

app.get("/api/projects/:id/templates", (req) => listSuites(idParam(req)));

// What a schedule means: the next times it runs, or what is wrong with it. Saves nothing.
app.get("/api/projects/:id/schedule-preview", (req) => {
  idParam(req);
  const q = req.query as { cron?: string; tz?: string };
  return previewSchedule(q.cron ?? "", q.tz ?? "UTC");
});

// A copy of the cases a folder holds now. Later changes to the folder do not change the suite.
app.post("/api/projects/:id/templates/from-folder", (req) => {
  const projectId = idParam(req);
  const body = z
    .object({
      folderId: z.number().int(),
      name: z.string().trim().min(1).max(100).optional(),
      description: z.string().max(10000).optional(),
      environment: z.string().max(200).optional(),
      includeSubfolders: z.boolean().optional(),
    })
    .parse(req.body);
  return suitesApi(() => suiteFromFolder(projectId, body));
});

app.post("/api/projects/:id/templates", (req) => {
  const projectId = idParam(req);
  const body = templateBody.parse(req.body);
  if (db.prepare("SELECT 1 FROM run_templates WHERE project_id = ? AND name = ?").get(projectId, body.name)) throw new HttpError(409, `A template named "${body.name}" already exists`);
  const id = suitesApi(() => db.transaction(() => {
    const t = db
      .prepare("INSERT INTO run_templates (project_id, name, description, environment) VALUES (?, ?, ?, ?) RETURNING id")
      .get(projectId, body.name, body.description ?? "", body.environment ?? "") as { id: number };
    setSuiteCases(t.id, projectId, body.caseIds);
    if (body.schedule !== undefined || body.scheduleTimezone !== undefined) setSchedule(t.id, { schedule: body.schedule, timezone: body.scheduleTimezone }, actorName());
    return t.id;
  })());
  return listSuites(projectId, id)[0];
});

// One suite with its cases (in run order), what the automated side knows about each, its latest runs, and its schedule: the next times and what became of the latest ones.
app.get("/api/templates/:id", (req) => suitesApi(() => { const id = idParam(req); return { ...getSuite(id), ...scheduleDetails(id) }; }));

app.patch("/api/templates/:id", (req) => {
  const id = idParam(req);
  const body = templateBody.partial().parse(req.body);
  const cur = must(db.prepare("SELECT * FROM run_templates WHERE id = ?").get(id) as Record<string, any> | undefined, "Template");
  const name = body.name ?? cur.name;
  if (name !== cur.name && db.prepare("SELECT 1 FROM run_templates WHERE project_id = ? AND name = ?").get(cur.project_id, name)) throw new HttpError(409, `A template named "${name}" already exists`);
  suitesApi(() => db.transaction(() => {
    db.prepare("UPDATE run_templates SET name = ?, description = ?, environment = ?, updated_at = datetime('now') WHERE id = ?")
      .run(name, body.description ?? cur.description, body.environment ?? cur.environment, id);
    if (body.caseIds) setSuiteCases(id, cur.project_id, body.caseIds);
    if (body.schedule !== undefined || body.scheduleTimezone !== undefined) setSchedule(id, { schedule: body.schedule, timezone: body.scheduleTimezone }, actorName());
  })());
  return listSuites(cur.project_id, id)[0];
});

app.delete("/api/templates/:id", (req) => {
  db.prepare("DELETE FROM run_templates WHERE id = ?").run(idParam(req));
  return { ok: true };
});

// Add or remove single cases. Two people editing at once do not overwrite each other, as they would with the whole list in PATCH.
app.post("/api/templates/:id/cases", (req) => {
  const id = idParam(req);
  const body = z.object({ caseIds: z.array(z.number().int()).min(1, "Pick at least one case").max(5000) }).parse(req.body);
  return suitesApi(() => addSuiteCases(id, body.caseIds));
});
app.delete("/api/templates/:id/cases/:caseId", (req) => suitesApi(() => removeSuiteCase(idParam(req), idParam(req, "caseId"))));

// Runs the suite: a manual run of the cases it holds now, in the order of the case list. Nothing is started automatically.
app.post("/api/templates/:id/run", (req) => {
  const id = idParam(req);
  const body = z
    .object({ title: z.string().trim().min(1).max(200).optional(), environment: z.string().max(200).optional(), milestone: z.string().max(200).optional() })
    .parse(req.body ?? {});
  return suitesApi(() => startSuiteRun(id, body));
});

// ---------------- Requirements ----------------

const requirementBody = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(50000).optional(),
  /** One criterion per line. */
  acceptanceCriteria: z.string().max(20000).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  status: z.enum(["draft", "approved", "deprecated"]).optional(),
  /** Free text: a Jira story key, a link, a document name. */
  source: z.string().trim().max(300).optional(),
  kind: z.enum(REQUIREMENT_KINDS).optional(),
  /** The stable id used when requirements are imported and exported. Not a Testbench number (REQ-3), and unique within the project. */
  externalId: z.string().trim().max(120).regex(/^[\w.:\-/]+$/, "use letters, digits and . _ : - /").refine((v) => !/^REQ-\d+$/i.test(v), "REQ-n is a Testbench number, not a stable id").nullable().optional(),
  wcag: z.array(wcagCriterion).max(20).optional(),
  viewports: z.array(viewportSchema).max(10).optional(),
  caseIds: z.array(z.number().int()).max(5000).optional(),
});
const requirementProblem = (kind: string, wcag: string[], viewports: Viewport[]) => {
  const why = kindProblem(kind, wcag, viewports);
  if (why) throw new HttpError(400, why);
};
const externalIdTaken = (projectId: number, externalId: string | null | undefined, exceptId?: number) => {
  if (!externalId) return;
  const row = db.prepare("SELECT number FROM requirements WHERE project_id = ? AND external_id = ? AND id != ?").get(projectId, externalId, exceptId ?? 0) as { number: number } | undefined;
  if (row) throw new HttpError(409, `REQ-${row.number} already has the id ${externalId} in this project.`);
};

app.get("/api/projects/:id/requirements", (req) => listRequirements(idParam(req)));

app.post("/api/projects/:id/requirements", (req) => {
  const projectId = idParam(req);
  const { caseIds, ...input } = requirementBody.parse(req.body);
  must(db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId), "Project");
  requirementProblem(input.kind ?? "functional", input.wcag ?? [], input.viewports ?? []);
  externalIdTaken(projectId, input.externalId);
  const id = createRequirement(projectId, { ...input, wcag: input.wcag ? normWcag(input.wcag) : undefined, viewports: input.viewports ? normViewports(input.viewports) : undefined });
  if (caseIds?.length) setRequirementCases(id, projectId, caseIds);
  return getRequirement(id);
});

// Requirements as a test agent reads them (read-only). By default the active ones. ?download=1 saves it as a file.
app.get("/api/projects/:id/agent/requirements", (req, reply) => {
  const q = req.query as { status?: string; kind?: string; download?: string };
  const out = audited(() => agentRequirements(idParam(req), q));
  if (q.download === "1") reply.header("Content-Disposition", `attachment; filename="${out.project}-requirements.json"`);
  return out;
});
app.get("/api/projects/:id/requirements/coverage", (req) => requirementCoverage(idParam(req)));

// Import requirements from a structured file. {"content": "<the file's text>"}, or the file's own JSON. ?dryRun=1 only says what would happen.
app.post("/api/projects/:id/requirements/import", { bodyLimit: 6 * 1024 * 1024 }, (req) => {
  const projectId = idParam(req);
  const body = req.body as { content?: unknown; fileName?: unknown } | null;
  const content = typeof body?.content === "string" ? body.content : JSON.stringify(body ?? {});
  try {
    return importRequirements(projectId, content, { dryRun: (req.query as { dryRun?: string }).dryRun === "1", fileName: typeof body?.fileName === "string" ? body.fileName : "" });
  } catch (e) {
    throw e instanceof RequirementImportError ? new HttpError(e.status, e.message, e.problems) : e;
  }
});

app.get("/api/requirements/:id", (req) => must(getRequirement(idParam(req)) ?? undefined, "Requirement"));

app.patch("/api/requirements/:id", (req) => {
  const id = idParam(req);
  const body = requirementBody.partial().parse(req.body);
  const cur = must(db.prepare("SELECT * FROM requirements WHERE id = ?").get(id) as Record<string, any> | undefined, "Requirement");
  const wcag = body.wcag ? normWcag(body.wcag) : parseJson<string[]>(cur.wcag, []);
  const viewports = body.viewports ? normViewports(body.viewports) : parseJson<Viewport[]>(cur.viewports, []);
  const kind = body.kind ?? cur.kind;
  requirementProblem(kind, wcag, viewports);
  const externalId = body.externalId === undefined ? cur.external_id : body.externalId;
  if (externalId !== cur.external_id) externalIdTaken(cur.project_id, externalId, id);
  db.transaction(() => {
    const next = { title: body.title ?? cur.title, description: body.description ?? cur.description, acceptance_criteria: body.acceptanceCriteria ?? cur.acceptance_criteria, priority: body.priority ?? cur.priority, status: body.status ?? cur.status, source: body.source ?? cur.source, kind, external_id: externalId, wcag: JSON.stringify(wcag), viewports: JSON.stringify(viewports) };
    // Who approved it: the person who makes it approved now. Taking it back to draft clears that; deprecating keeps it.
    const becomesApproved = next.status === "approved" && cur.status !== "approved";
    const backToDraft = next.status === "draft" && cur.status !== "draft";
    const approvedBy: string = becomesApproved ? actorName() : backToDraft ? "" : cur.approved_by;
    const approvedUid: number | null = becomesApproved ? actorUserId() : backToDraft ? null : (cur.approved_by_user_id ?? null);
    const approvedAt: string | null = becomesApproved ? new Date().toISOString().slice(0, 19).replace("T", " ") : backToDraft ? null : cur.approved_at;
    db.prepare("UPDATE requirements SET title = ?, description = ?, acceptance_criteria = ?, priority = ?, status = ?, source = ?, kind = ?, external_id = ?, wcag = ?, viewports = ?, approved_by = ?, approved_by_user_id = ?, approved_at = ?, updated_at = datetime('now') WHERE id = ?").run(
      next.title, next.description, next.acceptance_criteria, next.priority, next.status, next.source, next.kind, next.external_id, next.wcag, next.viewports, approvedBy, approvedUid, approvedAt, id,
    );
    // Wording changes ask for a second look at the linked cases; the rest is just recorded.
    const changes: RevisionChange[] = (["title", "description", "acceptance_criteria", "priority", "status", "source", "kind", "external_id", "wcag", "viewports"] as const)
      .filter((f) => next[f] !== cur[f])
      .map((f) => ({ field: f === "external_id" ? "id" : f === "acceptance_criteria" ? "acceptance criteria" : f, from: String(cur[f] ?? ""), to: String(next[f] ?? "") }));
    if (approvedBy !== cur.approved_by) changes.push({ field: "approved by", from: String(cur.approved_by ?? ""), to: approvedBy });
    // Wording changes (the title, the description and the acceptance criteria) ask for a second look at the linked cases; the rest is just recorded.
    recordRevision(id, changes, changes.some((c) => c.field === "title" || c.field === "description" || c.field === "acceptance criteria"));
    if (body.caseIds) setRequirementCases(id, cur.project_id, body.caseIds);
  })();
  return getRequirement(id);
});

// After an import: a person approves the imported drafts (all, or the ids given). Nothing else is approved by this.
app.post("/api/projects/:id/requirements/approve-imported", (req) => {
  try {
    return approveImported(idParam(req), (req.body as { ids?: unknown } | null)?.ids, req.ip);
  } catch (e) {
    throw e instanceof RequirementImportError ? new HttpError(e.status, e.message, e.problems) : e;
  }
});

// Add cases to a requirement without replacing the ones already linked (bulk link from the case list).
app.post("/api/requirements/:id/cases", (req) => {
  const id = idParam(req);
  const { caseIds } = z.object({ caseIds: z.array(z.number().int()).min(1).max(5000) }).parse(req.body);
  const cur = must(db.prepare("SELECT project_id FROM requirements WHERE id = ?").get(id) as { project_id: number } | undefined, "Requirement");
  addRequirementCases(id, cur.project_id, caseIds);
  return getRequirement(id);
});

// Confirm linked cases still match the requirement's current wording (all of them unless caseIds is given).
app.post("/api/requirements/:id/review", (req) => {
  const id = idParam(req);
  const { caseIds } = z.object({ caseIds: z.array(z.number().int()).max(5000).optional() }).parse(req.body ?? {});
  must(db.prepare("SELECT id FROM requirements WHERE id = ?").get(id), "Requirement");
  markReviewed(id, caseIds);
  return getRequirement(id);
});

// Specs, mockups, mails and the like. SVG and HTML are left out: they would run scripts when opened from /uploads.
const REQUIREMENT_ATTACHMENT_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".csv", ".txt", ".md", ".log", ".zip", ".mp4", ".webm", ".eml", ".msg",
]);

app.post("/api/requirements/:id/attachments", async (req) => {
  const id = idParam(req);
  must(db.prepare("SELECT id FROM requirements WHERE id = ?").get(id), "Requirement");
  const saved = [];
  for await (const part of req.files()) {
    const ext = extname(part.filename).toLowerCase();
    if (!REQUIREMENT_ATTACHMENT_EXT.has(ext)) throw new HttpError(400, `File type ${ext || "(none)"} is not allowed`);
    const buf = await part.toBuffer();
    const stored = `${randomUUID()}${ext}`;
    await writeFile(join(UPLOAD_DIR, stored), buf);
    saved.push(addRequirementAttachment(id, { filename: part.filename, storedName: stored, mime: part.mimetype, size: buf.length }));
  }
  return saved;
});

app.delete("/api/requirement-attachments/:id", async (req) => {
  const row = removeRequirementAttachment(idParam(req));
  if (row) await unlink(join(UPLOAD_DIR, row.stored_name)).catch(() => {});
  return { ok: true };
});

app.delete("/api/requirements/:id", async (req) => {
  const id = idParam(req);
  const files = requirementAttachmentFiles(id);
  removeRequirementSuggestions(id); // its automation suggestions go with it; the draft test cases made from them stay
  db.prepare("DELETE FROM requirements WHERE id = ?").run(id);
  await Promise.all(files.map((f) => unlink(join(UPLOAD_DIR, f)).catch(() => {})));
  return { ok: true };
});

// ---- Who made a change, requirement proposals from a test agent, and the proposal tokens. A proposal is not a requirement until a person approves it. ----
const asRequirementHttp = (e: unknown) => (e instanceof RequirementError ? new HttpError(e.status, e.message, e.problems) : e instanceof AuditError ? new HttpError(e.status, e.message) : e);
function requirementsApi<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw asRequirementHttp(e);
  }
}

// What is not covered yet: requirements without a test case, test cases without a requirement, observations without a link. Only lists; nothing is made.
app.get("/api/projects/:id/coverage-gaps", (req) => requirementsApi(() => coverageGaps(idParam(req))));
// Proposals made by fixed rules from the coverage gaps (no model, no network). They go into the ordinary proposal flow as `proposed`. ?dryRun=1 only says what would be made.
app.post("/api/projects/:id/generate-proposals", (req) => requirementsApi(() => generateProposals(idParam(req), { dryRun: (req.query as { dryRun?: string }).dryRun === "1" })));
// The requirements and test cases an observation is linked to (a person's decision).
app.get("/api/observations/:id/links", (req) => requirementsApi(() => getObservationLinks(idParam(req))));
app.put("/api/observations/:id/links", (req) => requirementsApi(() => setObservationLinks(idParam(req), req.body)));

// Take a requirement out of use without deleting it (it keeps its links and history). A person's action.
app.post("/api/requirements/:id/deprecate", (req) => requirementsApi(() => {
  const id = idParam(req);
  const body = z.object({ reason: z.string().max(2000).optional() }).parse(req.body ?? {});
  deprecateRequirement(id, body.reason ?? "");
  return getRequirement(id);
}));

// The name recorded on what a person does (created by, approved by, the change log). `source` says where it comes from: "account" is the name of the account that is
// signed in, "typed" is the display name entered in Settings. Neither is checked against a real person (the email address of an account is not verified either).
const nameInfo = () => { const u = currentUser(); return { name: u ? u.name : getDisplayName(), recordedAs: actorName(), source: u ? "account" as const : "typed" as const }; };
app.get("/api/settings/display-name", () => nameInfo());
app.put("/api/settings/display-name", (req, reply) => {
  try {
    const name = (req.body as { name?: unknown } | null)?.name;
    const u = currentUser();
    if (u) updateProfile(u, { name }, req.ip);
    else requirementsApi(() => setDisplayName(name));
    return { ...nameInfo(), ...(u ? { name: String(name).trim(), recordedAs: String(name).trim() } : {}) };
  } catch (e) {
    if (e instanceof AccountError) return reply.code(e.status).send({ error: e.message });
    throw e;
  }
});

// Whether a test agent may make proposals at all. Off until a person switches it on.
app.get("/api/settings/agent-proposals", () => ({ enabled: agentProposalsEnabled() }));
app.put("/api/settings/agent-proposals", (req) => {
  ownerOnly();
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  setAgentProposalsEnabled(enabled);
  return { enabled: agentProposalsEnabled() };
});
app.get("/api/projects/:id/propose-tokens", (req) => listProposeTokens(idParam(req)));
app.post("/api/projects/:id/propose-tokens", (req, reply) => {
  const id = idParam(req);
  const body = z.object({ name: z.string().max(200) }).parse(req.body);
  reply.header("Cache-Control", "no-store");
  return audited(() => createProposeToken(id, body.name));
});
app.post("/api/propose-tokens/:id/revoke", (req) => {
  audited(() => revokeProposeToken(idParam(req)));
  return { ok: true };
});

// The test agent's route: it makes proposals with a proposal token and can do nothing else. The proposals start as `proposed` and change nothing until a person approves.
const proposeLimiter = makeLimiter({ max: 20, windowMs: 15 * 60_000 });
app.post("/api/agent/projects/:id/requirement-proposals", { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
  const id = idParam(req);
  if (proposeLimiter.blockedFor(req.ip) > 0) return reply.code(429).send({ error: "Too many failed attempts. Try again later." });
  const auth = authenticateProposeToken(req.headers.authorization, id);
  if (auth.state === "off") throw new HttpError(403, "Agent proposals are switched off on this installation");
  if (auth.state === "invalid") {
    proposeLimiter.fail(req.ip);
    throw new HttpError(401, "A valid proposal token is required: send it as Authorization: Bearer <token>");
  }
  if (auth.state === "other_project") {
    proposeLimiter.fail(req.ip);
    throw new HttpError(403, "This token does not belong to this project");
  }
  if (auth.state !== "ok") throw new HttpError(401, "A valid proposal token is required");
  reply.header("Cache-Control", "no-store");
  return requirementsApi(() => createProposals(id, req.body, `agent: ${auth.name}`));
});

app.get("/api/projects/:id/requirement-proposals", (req) => requirementsApi(() => listProposals(idParam(req), (req.query as { status?: string }).status || undefined)));
app.get("/api/requirement-proposals/:id", (req) => must(getProposal(idParam(req)), "Proposal"));
app.patch("/api/requirement-proposals/:id", (req) => requirementsApi(() => editProposal(idParam(req), req.body)));
app.post("/api/requirement-proposals/:id/approve", (req) => requirementsApi(() => approveProposal(idParam(req))));
app.post("/api/requirement-proposals/:id/reject", (req) => requirementsApi(() => rejectProposal(idParam(req), (req.body as { reason?: unknown } | null)?.reason)));

// Set the requirements a test case covers (the same links, edited from the case's side).
app.put("/api/cases/:id/requirements", (req) => {
  const id = idParam(req);
  const { requirementIds } = z.object({ requirementIds: z.array(z.number().int()).max(1000) }).parse(req.body);
  const c = must(db.prepare("SELECT project_id FROM cases WHERE id = ?").get(id) as { project_id: number } | undefined, "Case");
  setCaseRequirements(id, c.project_id, requirementIds);
  return requirementsForCase(id);
});

// ---------------- Backup & restore ----------------

app.get("/api/backup/info", () => {
  const info = backupInfo();
  const auto = autoBackupInfo();
  // "Backed up" in the sidebar means the newest of a download and an automatic backup.
  const newest = [info.lastBackupAt, auto.lastAt].filter((x): x is string => !!x).sort().at(-1) ?? null;
  return { ...info, lastBackupAt: newest, lastManualBackupAt: info.lastBackupAt, auto };
});

app.get("/api/backup", async (_req, reply) => {
  ownerOnly(); // the zip holds every account's password hash and every project
  const stamp = new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  reply.hijack(); // the zip is streamed straight to the socket
  reply.raw.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="testbench-backup-${stamp}.zip"`,
    "Cache-Control": "no-store",
  });
  try {
    await streamBackup(reply.raw);
  } catch (e) {
    app.log.error(e);
    reply.raw.destroy(e as Error);
  }
});

// Replaces ALL data with a backup. The current data is moved to data/previous/<time>, never deleted.
app.post("/api/restore", async (req) => {
  ownerOnly(); // replaces the accounts too, so anyone allowed to restore could make themselves the owner
  const part = await req.file({ limits: { fileSize: 2 * 1024 ** 3 } });
  if (!part) throw new HttpError(400, "Choose a backup .zip file");
  const tmp = join(DATA_DIR, `.upload-${Date.now()}.zip`);
  try {
    await pipeline(part.file, createWriteStream(tmp));
    if (part.file.truncated) throw new HttpError(400, "That file is too large to restore from the app");
    const restored = await restoreFromZip(tmp);
    // Sessions that came with the backup may be older than what was revoked since: nobody stays signed in on them. (The person restoring signs in again.)
    try { revokeAllSessions(); } catch { /* a backup from before accounts has no sessions table until the next start migrates it */ }
    return restored;
  } catch (e) {
    throw e instanceof HttpError ? e : new HttpError(400, (e as Error).message);
  } finally {
    rmSync(tmp, { force: true });
  }
});

// ---------------- Dashboard ----------------

app.get("/api/projects/:id/dashboard", (req) => {
  const id = idParam(req);
  return { ...must(dashboardData(id) ?? undefined, "Project"), ...automationCandidates(id, 5), requirements: requirementSummary(id) };
});

// Flaky tests, test-time trend, slowdowns and manual cases worth automating next.
app.get("/api/projects/:id/insights", (req) => {
  const id = idParam(req);
  must(db.prepare("SELECT id FROM projects WHERE id = ?").get(id), "Project");
  const { runs } = z.object({ runs: z.coerce.number().int().refine((n) => [10, 20, 50].includes(n), "runs must be 10, 20 or 50").default(20) }).parse(req.query);
  return insightsData(id, runs);
});

// ---------------- Sprints & releases ----------------

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").nullable();
const milestoneBody = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(["sprint", "release"]),
  startDate: dateField,
  endDate: dateField,
});

app.get("/api/projects/:id/milestones", (req) => listMilestones(idParam(req)));

app.post("/api/projects/:id/milestones", (req) => {
  const projectId = idParam(req);
  const body = milestoneBody.partial({ kind: true, startDate: true, endDate: true }).parse(req.body);
  if (db.prepare("SELECT 1 FROM milestones WHERE project_id = ? AND name = ?").get(projectId, body.name)) throw new HttpError(409, `"${body.name}" already exists`);
  return db
    .prepare("INSERT INTO milestones (project_id, name, kind, start_date, end_date) VALUES (?, ?, ?, ?, ?) RETURNING *")
    .get(projectId, body.name, body.kind ?? "sprint", body.startDate ?? null, body.endDate ?? null);
});

app.patch("/api/milestones/:id", (req) => {
  const id = idParam(req);
  const body = milestoneBody.partial().parse(req.body);
  const cur = must(db.prepare("SELECT * FROM milestones WHERE id = ?").get(id) as Record<string, any> | undefined, "Milestone");
  const name = body.name ?? cur.name;
  if (name !== cur.name && db.prepare("SELECT 1 FROM milestones WHERE project_id = ? AND name = ?").get(cur.project_id, name)) throw new HttpError(409, `"${name}" already exists`);
  if (body.startDate && body.endDate && body.endDate < body.startDate) throw new HttpError(400, "End date is before start date");
  return db.transaction(() => {
    // Runs reference a milestone by name, so a rename has to follow them.
    if (name !== cur.name) db.prepare("UPDATE runs SET milestone = ? WHERE project_id = ? AND milestone = ?").run(name, cur.project_id, cur.name);
    return db
      .prepare("UPDATE milestones SET name = ?, kind = ?, start_date = ?, end_date = ? WHERE id = ? RETURNING *")
      .get(
        name,
        body.kind ?? cur.kind,
        body.startDate === undefined ? cur.start_date : body.startDate,
        body.endDate === undefined ? cur.end_date : body.endDate,
        id,
      );
  })();
});

// Only empty sprints can go: runs reference a sprint by name, so deleting a used one would orphan them.
// ---- Release checklist: manual tasks on a sprint/release, ticked off with a timestamp ----
const checklistRow = (id: number) => must(db.prepare("SELECT * FROM milestone_checklist WHERE id = ?").get(id) as Record<string, any> | undefined, "Checklist item");

app.get("/api/milestones/:id/checklist", (req) => listChecklist(idParam(req)));

app.post("/api/milestones/:id/checklist", (req) => {
  const id = idParam(req);
  const { title } = z.object({ title: z.string().trim().min(1).max(300) }).parse(req.body);
  must(db.prepare("SELECT id FROM milestones WHERE id = ?").get(id), "Milestone");
  addChecklistItem(id, title);
  return listChecklist(id);
});

app.post("/api/milestones/:id/checklist/copy", (req) => {
  const id = idParam(req);
  const { fromId } = z.object({ fromId: z.number().int() }).parse(req.body);
  const to = must(db.prepare("SELECT project_id FROM milestones WHERE id = ?").get(id) as { project_id: number } | undefined, "Milestone");
  const from = db.prepare("SELECT project_id FROM milestones WHERE id = ?").get(fromId) as { project_id: number } | undefined;
  if (!from || from.project_id !== to.project_id) throw new HttpError(400, "Pick a sprint or release from this project");
  copyChecklist(id, fromId);
  return listChecklist(id);
});

// `done: true` stamps the time it was ticked (or `doneAt` to record when it really happened); `done: false` clears it.
app.patch("/api/checklist/:id", (req) => {
  const id = idParam(req);
  const body = z.object({
    title: z.string().trim().min(1).max(300).optional(),
    done: z.boolean().optional(),
    doneAt: z.string().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/).optional(),
  }).parse(req.body);
  const cur = checklistRow(id);
  let doneAt: string | null = cur.done_at;
  if (body.doneAt) doneAt = body.doneAt.replace("T", " ").padEnd(19, ":00");
  else if (body.done === true && !cur.done_at) doneAt = new Date().toISOString().slice(0, 19).replace("T", " ");
  else if (body.done === false) doneAt = null;
  db.prepare("UPDATE milestone_checklist SET title = ?, done_at = ? WHERE id = ?").run(body.title ?? cur.title, doneAt, id);
  return listChecklist(cur.milestone_id);
});

app.delete("/api/checklist/:id", (req) => {
  const cur = checklistRow(idParam(req));
  db.prepare("DELETE FROM milestone_checklist WHERE id = ?").run(cur.id);
  return listChecklist(cur.milestone_id);
});

app.delete("/api/milestones/:id", (req) => {
  const id = idParam(req);
  const m = must(db.prepare("SELECT * FROM milestones WHERE id = ?").get(id) as Record<string, any> | undefined, "Milestone");
  const used = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND milestone = ?").get(m.project_id, m.name) as { n: number };
  if (used.n) throw new HttpError(409, `"${m.name}" has ${used.n} ${used.n === 1 ? "run" : "runs"}. Delete or move those runs first.`);
  db.prepare("DELETE FROM milestones WHERE id = ?").run(id);
  return { ok: true };
});

// ---------------- Reports ----------------

const reportFor = (req: FastifyRequest) => must(milestoneReport(idParam(req)) ?? undefined, "Milestone");
const fileSafe = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "report";

app.get("/api/milestones/:id/report", (req) => reportFor(req));

app.get("/api/milestones/:id/report.html", (req, reply) => {
  const r = reportFor(req);
  const html = renderReport(r);
  reply.type("text/html; charset=utf-8").header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  if ((req.query as Record<string, string>).download) reply.header("Content-Disposition", `attachment; filename="${fileSafe(`${r.project.key}-${r.milestone.name}`)}-report.html"`);
  return html;
});

app.get("/api/milestones/:id/report.pdf", async (req, reply) => {
  const r = reportFor(req);
  const pdf = await htmlToPdf(renderReport(r), `${r.project.name} · ${r.milestone.name} test report`);
  reply.type("application/pdf").header("Content-Disposition", `attachment; filename="${fileSafe(`${r.project.key}-${r.milestone.name}`)}-report.pdf"`);
  return Buffer.from(pdf);
});

// ---------------- Export ----------------

function download(reply: import("fastify").FastifyReply, name: string, type: string, data: string | Uint8Array | object | null) {
  if (data == null) throw new HttpError(404, "Project not found");
  reply.type(type).header("Content-Disposition", `attachment; filename="${name}"`);
  return typeof data === "string" || data instanceof Uint8Array ? Buffer.from(data as string | Uint8Array) : JSON.stringify(data, null, 2);
}
const projectKey = (id: number) => (db.prepare("SELECT key FROM projects WHERE id = ?").get(id) as { key: string } | undefined)?.key.toLowerCase() ?? "project";

app.get("/api/projects/:id/export.json", (req, reply) => {
  const id = idParam(req);
  return download(reply, `${projectKey(id)}-export.json`, "application/json", exportJson(id));
});
app.get("/api/projects/:id/export-cases.csv", (req, reply) => {
  const id = idParam(req);
  return download(reply, `${projectKey(id)}-cases.csv`, "text/csv; charset=utf-8", exportCasesCsv(id));
});
app.get("/api/projects/:id/export-requirements.csv", (req, reply) => {
  const id = idParam(req);
  return download(reply, `${projectKey(id)}-requirements.csv`, "text/csv; charset=utf-8", exportRequirementsCsv(id));
});
app.get("/api/projects/:id/export-results.csv", (req, reply) => {
  const id = idParam(req);
  return download(reply, `${projectKey(id)}-results.csv`, "text/csv; charset=utf-8", exportResultsCsv(id));
});
app.get("/api/projects/:id/export-markdown.zip", (req, reply) => {
  const id = idParam(req);
  return download(reply, `${projectKey(id)}-cases-markdown.zip`, "application/zip", exportMarkdownZip(id));
});

// Settings for importing new workflow runs automatically.
app.patch("/api/github-sources/:id", (req) => {
  const id = idParam(req);
  const body = z
    .object({
      autoImport: z.boolean().optional(),
      branchFilter: z.string().trim().max(200).optional(),
      defaultMilestone: z.string().trim().max(100).optional(),
      auditWorkflows: auditWorkflowsField.optional(),
    })
    .parse(req.body);
  const cur = getSource(id);
  const on = body.autoImport ?? !!cur.auto_import;
  // Only runs created after it is switched on are imported, so turning it on never floods the app with old runs.
  const since = on ? (cur.auto_import ? cur.auto_since : new Date().toISOString().slice(0, 19).replace("T", " ")) : null;
  const milestone = body.defaultMilestone ?? cur.default_milestone;
  if (milestone) ensureMilestone(cur.project_id, milestone);
  return db
    .prepare("UPDATE github_sources SET auto_import = ?, auto_since = ?, branch_filter = ?, default_milestone = ?, audit_workflows = ? WHERE id = ? RETURNING *")
    .get(on ? 1 : 0, since, body.branchFilter ?? cur.branch_filter, milestone, body.auditWorkflows ?? cur.audit_workflows, id);
});

// Look for new runs right now instead of waiting for the next scheduled check.
app.post("/api/github-sources/:id/check", async (req) => {
  const src = getSource(idParam(req));
  if (!src.auto_import) throw new HttpError(400, "Turn on automatic import first");
  const result = await checkSource(src);
  return { ...result, source: getSource(src.id) };
});

// Every route must have a line in server/access.ts saying who may use it; a route without one stops the server from starting.
app.addHook("onReady", async () => checkAccessTable());

// Tests load this file to call the real app with app.inject; TESTBENCH_NO_LISTEN=1 then skips the timers and the port.
export { app };
if (process.env.TESTBENCH_NO_LISTEN !== "1") {
  startAutoImport();
  startAutoBackup();
  startScheduler();
  await app.listen({ port: PORT, host: HOST });
  const state = accountsState();
  console.log(`Testbench API on http://${HOST}:${PORT}${state === "accounts" ? " (accounts: sign in required)" : state === "locked" ? " (LOCKED: accounts are on but none exists; run npm run accounts -- create-owner)" : auth ? " (password login on)" : " (no login: anyone who reaches this port has full access)"}`);
}
