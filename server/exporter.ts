import { strToU8, zipSync } from "fflate";
import { db, parseJson } from "./db.ts";

interface CaseRow {
  id: number; number: number; title: string; description: string; preconditions: string; priority: string; status: string;
  tags: string; suite_id: number | null; created_at: string; updated_at: string;
}
interface StepRow { id: number; case_id: number; position: number; action: string; expected: string }
interface SuiteRow { id: number; parent_id: number | null; name: string }

function project(projectId: number) {
  return db.prepare("SELECT id, name, key FROM projects WHERE id = ?").get(projectId) as { id: number; name: string; key: string } | undefined;
}

/** Everything in a project, as plain JSON that can be diffed, backed up or re-imported later. */
export function exportJson(projectId: number) {
  const p = project(projectId);
  if (!p) return null;
  const suites = db.prepare("SELECT id, parent_id, name, description, position FROM suites WHERE project_id = ? ORDER BY position, id").all(projectId);
  const cases = (db.prepare("SELECT * FROM cases WHERE project_id = ? ORDER BY number").all(projectId) as CaseRow[]).map((c) => ({
    id: `${p.key}-${c.number}`,
    suiteId: c.suite_id,
    title: c.title,
    description: c.description,
    preconditions: c.preconditions,
    priority: c.priority,
    status: c.status,
    tags: parseJson<string[]>(c.tags, []),
    steps: (db.prepare("SELECT action, expected FROM case_steps WHERE case_id = ? ORDER BY position").all(c.id) as StepRow[]).map((s) => ({ action: s.action, expected: s.expected })),
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  }));
  const milestones = db.prepare("SELECT name, kind, start_date AS startDate, end_date AS endDate FROM milestones WHERE project_id = ? ORDER BY id").all(projectId);
  const runs = (db.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY id").all(projectId) as Record<string, any>[]).map((r) => ({
    title: r.title, kind: r.kind, source: r.source, status: r.status, framework: r.framework, environment: r.environment, milestone: r.milestone,
    startedAt: r.started_at, finishedAt: r.finished_at, meta: parseJson(r.meta, {}),
    results: (db
      .prepare(`
        SELECT r.status, r.flaky, r.duration_ms AS durationMs, r.error, r.notes, r.executed_at AS executedAt,
          c.number AS caseNumber, a.full_name AS testName
        FROM results r LEFT JOIN cases c ON c.id = r.case_id LEFT JOIN automated_tests a ON a.id = r.automated_test_id
        WHERE r.run_id = ? ORDER BY r.position, r.id`)
      .all(r.id) as Record<string, any>[]).map((x) => ({
      case: x.caseNumber ? `${p.key}-${x.caseNumber}` : null,
      test: x.testName,
      status: x.status, flaky: !!x.flaky, durationMs: x.durationMs, error: x.error || undefined, notes: x.notes || undefined, executedAt: x.executedAt,
    })),
  }));
  return { exportedAt: new Date().toISOString(), format: "testbench-export/1", project: { name: p.name, key: p.key }, suites, milestones, cases, runs };
}

/** Spreadsheet apps run cells that start with = + - @ as formulas, so neutralise them. */
function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (rows: unknown[][]) => "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

export function exportCasesCsv(projectId: number) {
  const p = project(projectId);
  if (!p) return null;
  const rows = db
    .prepare(`
      SELECT c.*, s.name AS suite,
        (SELECT COUNT(*) FROM case_steps st WHERE st.case_id = c.id) AS steps,
        (SELECT COUNT(*) FROM automated_tests a WHERE a.case_id = c.id) AS automated
      FROM cases c LEFT JOIN suites s ON s.id = c.suite_id WHERE c.project_id = ? ORDER BY c.number`)
    .all(projectId) as (CaseRow & { suite: string | null; steps: number; automated: number })[];
  return csv([
    ["ID", "Title", "Suite", "Priority", "Status", "Tags", "Steps", "Automated tests", "Preconditions", "Description", "Updated"],
    ...rows.map((c) => [`${p.key}-${c.number}`, c.title, c.suite ?? "", c.priority, c.status, parseJson<string[]>(c.tags, []).join("; "), c.steps, c.automated, c.preconditions, c.description, c.updated_at]),
  ]);
}

export function exportResultsCsv(projectId: number) {
  const p = project(projectId);
  if (!p) return null;
  const rows = db
    .prepare(`
      SELECT ru.title AS run, ru.kind, ru.framework, ru.milestone, ru.environment, ru.started_at,
        c.number AS case_number, COALESCE(json_extract(r.snapshot, '$.title'), c.title) AS case_title,
        a.full_name AS test, r.status, r.flaky, r.duration_ms, r.error, r.notes
      FROM results r JOIN runs ru ON ru.id = r.run_id
      LEFT JOIN cases c ON c.id = r.case_id LEFT JOIN automated_tests a ON a.id = r.automated_test_id
      WHERE ru.project_id = ? ORDER BY ru.started_at, ru.id, r.position, r.id`)
    .all(projectId) as Record<string, any>[];
  return csv([
    ["Run", "Type", "Framework", "Sprint/release", "Environment", "Started", "Case", "Case title", "Automated test", "Status", "Flaky", "Duration ms", "Error", "Notes"],
    ...rows.map((r) => [r.run, r.kind, r.framework ?? "", r.milestone, r.environment, r.started_at, r.case_number ? `${p.key}-${r.case_number}` : "", r.case_title ?? "", r.test ?? "", r.status, r.flaky ? "yes" : "", r.duration_ms ?? "", r.error, r.notes]),
  ]);
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "untitled";
const yaml = (s: string) => JSON.stringify(s); // JSON strings are valid YAML scalars

/** One Markdown file per case, in a folder per suite. Meant to be committed to git or read by humans. */
export function exportMarkdownZip(projectId: number): Uint8Array | null {
  const p = project(projectId);
  if (!p) return null;
  const suites = db.prepare("SELECT id, parent_id, name FROM suites WHERE project_id = ?").all(projectId) as SuiteRow[];
  const pathOf = (id: number | null): string => {
    const parts: string[] = [];
    let cur = suites.find((s) => s.id === id);
    for (let guard = 0; cur && guard < 20; guard++) {
      parts.unshift(safeName(cur.name));
      const parent: number | null = cur.parent_id;
      cur = suites.find((s) => s.id === parent);
    }
    return parts.join("/");
  };

  const files: Record<string, Uint8Array> = {};
  const cases = db.prepare("SELECT * FROM cases WHERE project_id = ? ORDER BY number").all(projectId) as CaseRow[];
  for (const c of cases) {
    const id = `${p.key}-${c.number}`;
    const steps = db.prepare("SELECT action, expected FROM case_steps WHERE case_id = ? ORDER BY position").all(c.id) as StepRow[];
    const tags = parseJson<string[]>(c.tags, []);
    const body = [
      "---",
      `id: ${id}`,
      `title: ${yaml(c.title)}`,
      `priority: ${c.priority}`,
      `status: ${c.status}`,
      `tags: [${tags.map(yaml).join(", ")}]`,
      "---",
      "",
      `# ${id} ${c.title}`,
      "",
      c.description ? `${c.description}\n` : "",
      c.preconditions ? `## Preconditions\n\n${c.preconditions}\n` : "",
      steps.length ? "## Steps\n" : "",
      ...steps.map((s, i) => `${i + 1}. ${s.action.replace(/\n/g, "\n   ")}${s.expected ? `\n   - **Expected:** ${s.expected.replace(/\n/g, "\n     ")}` : ""}`),
      "",
    ].join("\n");
    const dir = pathOf(c.suite_id);
    files[`${p.key}/${dir ? dir + "/" : ""}${id} ${safeName(c.title)}.md`] = strToU8(body);
  }
  files[`${p.key}/README.md`] = strToU8(`# ${p.name}\n\n${cases.length} test cases exported from Testbench on ${new Date().toISOString().slice(0, 10)}.\n`);
  return zipSync(files);
}
