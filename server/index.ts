import Fastify, { type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";
import { db, ensureMilestone, parseJson, snapshotCase, UPLOAD_DIR } from "./db.ts";
import { seedDemo } from "./demo.ts";
import { getToken, importRun, listRuns, type GithubSource } from "./importers/github.ts";
import { importReport, mergeReports } from "./importers/import.ts";
import type { CaseSnapshot } from "./db.ts";
import { parseReport, type Framework, type ParsedReport } from "./importers/parse.ts";

const PORT = Number(process.env.TESTBENCH_API_PORT ?? 4100);
const app = Fastify({ logger: { level: "warn" } });

// Any web page can send "simple" cross-site requests to localhost. Reject foreign Host headers
// (DNS rebinding) and require a custom header on writes, which forces a CORS preflight we never approve.
app.addHook("onRequest", async (req, reply) => {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return reply.code(403).send({ error: "Forbidden host" });
  if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-testbench"] !== "1") {
    return reply.code(403).send({ error: "Missing X-Testbench header" });
  }
});
await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 20 } });
await app.register(fastifyStatic, { root: UPLOAD_DIR, prefix: "/uploads/", decorateReply: false });

const distDir = join(process.cwd(), "dist");
if (process.env.NODE_ENV === "production" && existsSync(distDir)) {
  await app.register(fastifyStatic, { root: distDir, prefix: "/" });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith("/api") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html", distDir),
  );
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
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

app.get("/api/projects", () =>
  db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM cases c WHERE c.project_id = p.id) AS case_count,
           (SELECT COUNT(*) FROM runs r WHERE r.project_id = p.id) AS run_count
    FROM projects p ORDER BY p.created_at`).all(),
);

app.post("/api/projects", (req) => {
  const body = projectBody.parse(req.body);
  if (db.prepare("SELECT 1 FROM projects WHERE key = ?").get(body.key)) throw new HttpError(409, `Key ${body.key} is already used`);
  return db.prepare("INSERT INTO projects (name, key) VALUES (?, ?) RETURNING *").get(body.name, body.key);
});

app.patch("/api/projects/:id", (req) => {
  const id = idParam(req);
  const body = projectBody.pick({ name: true }).parse(req.body);
  return must(db.prepare("UPDATE projects SET name = ? WHERE id = ? RETURNING *").get(body.name, id), "Project");
});

app.post("/api/demo", () => seedDemo());

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

app.delete("/api/suites/:id", (req) => {
  db.prepare("DELETE FROM suites WHERE id = ?").run(idParam(req));
  return { ok: true };
});

// ---------------- Cases ----------------

const caseRow = (row: Record<string, any>) => ({ ...row, tags: parseJson<string[]>(row.tags, []) });

app.get("/api/projects/:id/cases", (req) => {
  const rows = db
    .prepare(`
      SELECT c.*, s.name AS suite_name,
        (SELECT COUNT(*) FROM automated_tests a WHERE a.case_id = c.id) AS automated_count,
        (SELECT COUNT(*) FROM case_steps st WHERE st.case_id = c.id) AS step_count,
        (SELECT r.status FROM results r JOIN runs ru ON ru.id = r.run_id
          WHERE r.case_id = c.id AND r.status != 'untested'
          ORDER BY COALESCE(r.executed_at, ru.started_at) DESC, r.id DESC LIMIT 1) AS last_status
      FROM cases c LEFT JOIN suites s ON s.id = c.suite_id
      WHERE c.project_id = ? ORDER BY c.position, c.number`)
    .all(idParam(req)) as Record<string, any>[];
  return rows.map(caseRow);
});

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
    return row.id;
  })();
  return getCase(id);
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
  })();
  return getCase(id);
});

app.delete("/api/cases/:id", (req) => {
  db.prepare("DELETE FROM cases WHERE id = ?").run(idParam(req));
  return { ok: true };
});

// ---------------- Runs ----------------

app.get("/api/projects/:id/runs", (req) => {
  const rows = db
    .prepare(`
      SELECT ru.*, ${STATUS_COUNTS},
        COALESCE(SUM(r.duration_ms), 0) AS duration_ms
      FROM runs ru LEFT JOIN results r ON r.run_id = ru.id
      WHERE ru.project_id = ? GROUP BY ru.id ORDER BY ru.started_at DESC, ru.id DESC`)
    .all(idParam(req)) as Record<string, any>[];
  return rows.map((r) => ({ ...r, meta: parseJson(r.meta, {}) }));
});

const manualRunBody = z.object({
  title: z.string().trim().min(1).max(200),
  environment: z.string().max(200).optional(),
  milestone: z.string().max(200).optional(),
  caseIds: z.array(z.number().int()).min(1, "Pick at least one case"),
});

app.post("/api/projects/:id/runs", (req) => {
  const projectId = idParam(req);
  const body = manualRunBody.parse(req.body);
  return db.transaction(() => {
    const run = db
      .prepare(`
        INSERT INTO runs (project_id, title, kind, source, environment, milestone)
        VALUES (?, ?, 'manual', 'manual', ?, ?) RETURNING *`)
      .get(projectId, body.title, body.environment ?? "", body.milestone ?? "") as { id: number };
    // Keep the same order as the case list, not the order of selection.
    const placeholders = body.caseIds.map(() => "?").join(",");
    const cases = db
      .prepare(`SELECT id FROM cases WHERE project_id = ? AND id IN (${placeholders}) ORDER BY position, number`)
      .all(projectId, ...body.caseIds) as { id: number }[];
    const ins = db.prepare("INSERT INTO results (run_id, case_id, position, snapshot) VALUES (?, ?, ?, ?)");
    cases.forEach((c, i) => ins.run(run.id, c.id, i, JSON.stringify(snapshotCase(c.id))));
    ensureMilestone(projectId, body.milestone ?? "");
    return run;
  })();
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
      SELECT r.id, r.run_id, r.case_id, r.automated_test_id, r.status, r.flaky, r.duration_ms, r.error, r.notes, r.position, r.executed_at,
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
  return { ...run, meta: parseJson(run.meta, {}), counts, results };
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

const resultStatus = z.enum(["untested", "passed", "failed", "blocked", "skipped"]);

app.patch("/api/results/:id", (req) => {
  const id = idParam(req);
  const body = z.object({ status: resultStatus.optional(), notes: z.string().max(20000).optional() }).parse(req.body);
  const cur = must(db.prepare("SELECT * FROM results WHERE id = ?").get(id) as Record<string, any> | undefined, "Result");
  return db
    .prepare(`
      UPDATE results SET status = ?, notes = ?,
        executed_at = CASE WHEN ? != status THEN datetime('now') ELSE executed_at END
      WHERE id = ? RETURNING *`)
    .get(body.status ?? cur.status, body.notes ?? cur.notes, body.status ?? cur.status, id);
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

const FRAMEWORKS = ["playwright", "testcafe", "selenium", "junit"] as const;

app.post("/api/projects/:id/import", async (req) => {
  const projectId = idParam(req);
  const fields: Record<string, string> = {};
  const reports: ParsedReport[] = [];
  const names: string[] = [];
  for await (const part of req.parts()) {
    if (part.type === "field") {
      fields[part.fieldname] = String(part.value ?? "");
      continue;
    }
    const content = (await part.toBuffer()).toString("utf8");
    const hint = (FRAMEWORKS as readonly string[]).includes(fields.framework) ? (fields.framework as Framework) : undefined;
    try {
      reports.push(parseReport(content, hint));
      names.push(part.filename);
    } catch (e) {
      throw new HttpError(400, `${part.filename}: ${(e as Error).message}`);
    }
  }
  const merged = mergeReports(reports);
  const title = fields.title?.trim() || `${merged.framework} · ${names.join(", ")}`.slice(0, 200);
  return importReport(merged, {
    projectId,
    source: "upload",
    title,
    environment: fields.environment ?? "",
    milestone: fields.milestone ?? "",
    meta: { files: names },
  });
});

// ---------------- GitHub ----------------

app.get("/api/github/status", async () => {
  const token = await getToken();
  return { authenticated: !!token, via: process.env.GITHUB_TOKEN ? "GITHUB_TOKEN" : token ? "gh CLI" : null };
});

app.get("/api/projects/:id/github-sources", (req) =>
  db.prepare("SELECT * FROM github_sources WHERE project_id = ? ORDER BY id").all(idParam(req)),
);

app.post("/api/projects/:id/github-sources", (req) => {
  const projectId = idParam(req);
  const body = z
    .object({
      repo: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/, "Use owner/repo"),
      workflow: z.string().trim().max(200).optional(),
      artifactPattern: z.string().trim().max(200).optional(),
    })
    .parse(req.body);
  const [owner, repo] = body.repo.split("/");
  try {
    return db
      .prepare("INSERT INTO github_sources (project_id, owner, repo, workflow, artifact_pattern) VALUES (?, ?, ?, ?, ?) RETURNING *")
      .get(projectId, owner, repo, body.workflow ?? "", body.artifactPattern ?? "");
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
  const imported = new Map(
    (
      db
        .prepare("SELECT id, external_id FROM runs WHERE project_id = ? AND source = 'github' AND external_id LIKE ?")
        .all(src.project_id, `${src.owner}/${src.repo}#%`) as { id: number; external_id: string }[]
    ).map((r) => [r.external_id, r.id]),
  );
  return runs.map((r) => ({ ...r, imported_run_id: imported.get(`${src.owner}/${src.repo}#${r.id}`) ?? null }));
});

app.post("/api/github-sources/:id/runs/:runId/import", async (req) => {
  const src = getSource(idParam(req));
  try {
    return await importRun(src, idParam(req, "runId"));
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});

await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`Testbench API on http://127.0.0.1:${PORT}`);
