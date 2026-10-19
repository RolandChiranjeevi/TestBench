import { db, parseJson, type CaseSnapshot } from "./db.ts";
import { classify, listRequirements } from "./requirements.ts";

export interface Totals {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  untested: number;
}

const emptyTotals = (): Totals => ({ total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, untested: 0 });

function add(t: Totals, status: string) {
  t.total++;
  if (status in t) (t as unknown as Record<string, number>)[status]++;
}

/** Share of executed tests that passed, one decimal; null when nothing was executed. */
export function passRate(t: Pick<Totals, "passed" | "failed" | "blocked">): number | null {
  const executed = t.passed + t.failed + t.blocked;
  return executed ? Math.round((t.passed / executed) * 1000) / 10 : null;
}

const sumTotals = (a: Totals, b: Totals): Totals => ({
  total: a.total + b.total,
  passed: a.passed + b.passed,
  failed: a.failed + b.failed,
  blocked: a.blocked + b.blocked,
  skipped: a.skipped + b.skipped,
  untested: a.untested + b.untested,
});

// =====================================================================
// Dashboard
// =====================================================================

export function dashboardData(projectId: number) {
  const project = db.prepare("SELECT id, name, key FROM projects WHERE id = ?").get(projectId) as { id: number; name: string; key: string } | undefined;
  if (!project) return null;

  const runCounts = (kind: string, limit: number) =>
    db
      .prepare(`
        SELECT ru.id, ru.title, ru.started_at, ru.framework, ru.milestone, ru.status AS run_status,
          COUNT(r.id) AS total,
          COALESCE(SUM(r.status = 'passed'), 0) AS passed, COALESCE(SUM(r.status = 'failed'), 0) AS failed,
          COALESCE(SUM(r.status = 'blocked'), 0) AS blocked, COALESCE(SUM(r.status = 'skipped'), 0) AS skipped,
          COALESCE(SUM(r.status = 'untested'), 0) AS untested, COALESCE(SUM(r.flaky), 0) AS flaky,
          COALESCE(SUM(r.duration_ms), 0) AS duration_ms
        FROM runs ru LEFT JOIN results r ON r.run_id = ru.id
        WHERE ru.project_id = ? AND ru.kind = ?
        GROUP BY ru.id ORDER BY ru.started_at DESC, ru.id DESC LIMIT ?`)
      .all(projectId, kind, limit) as (Totals & { id: number; title: string; started_at: string; framework: string | null; milestone: string; run_status: string; flaky: number; duration_ms: number })[];

  const withRate = <T extends Totals>(rows: T[]) => rows.map((r) => ({ ...r, rate: passRate(r) })).reverse(); // oldest first for charts
  const automatedRuns = withRate(runCounts("automated", 20));
  const manualRuns = withRate(runCounts("manual", 20));

  const cases = db.prepare("SELECT COUNT(*) AS n FROM cases WHERE project_id = ? AND status != 'deprecated'").get(projectId) as { n: number };
  const automatedCases = db
    .prepare(`SELECT COUNT(DISTINCT c.id) AS n FROM cases c JOIN automated_tests a ON a.case_id = c.id WHERE c.project_id = ? AND c.status != 'deprecated'`)
    .get(projectId) as { n: number };
  const automatedTests = db.prepare("SELECT COUNT(*) AS n, SUM(case_id IS NULL) AS unlinked FROM automated_tests WHERE project_id = ?").get(projectId) as { n: number; unlinked: number | null };

  // Recent window for flaky/failing stats: the last 10 automated runs.
  const recentIds = (db.prepare("SELECT id FROM runs WHERE project_id = ? AND kind = 'automated' ORDER BY started_at DESC, id DESC LIMIT 10").all(projectId) as { id: number }[]).map((r) => r.id);
  const inRecent = recentIds.length ? `AND r.run_id IN (${recentIds.join(",")})` : "AND 0";

  const testStats = (having: string, order: string) =>
    db
      .prepare(`
        SELECT a.id, a.title, a.file, a.framework, a.last_status, c.number AS case_number,
          COUNT(r.id) AS runs, SUM(r.status = 'failed') AS failures, SUM(r.flaky) AS flaky, AVG(r.duration_ms) AS avg_ms
        FROM automated_tests a JOIN results r ON r.automated_test_id = a.id ${inRecent}
        LEFT JOIN cases c ON c.id = a.case_id
        WHERE a.project_id = ?
        GROUP BY a.id ${having} ${order} LIMIT 8`)
      .all(projectId) as { id: number; title: string; file: string; framework: string; last_status: string; case_number: number | null; runs: number; failures: number; flaky: number; avg_ms: number }[];

  // Spell out the aggregates: in SQLite a bare `flaky` in HAVING/ORDER BY resolves to the results.flaky column, not the alias.
  const mostFailing = testStats("HAVING SUM(r.status = 'failed') > 0", "ORDER BY SUM(r.status = 'failed') DESC, COUNT(r.id) ASC");
  const flaky = testStats("HAVING SUM(r.flaky) > 0", "ORDER BY SUM(r.flaky) DESC");
  const slowest = testStats("", "ORDER BY AVG(r.duration_ms) DESC");

  const failingCases = db
    .prepare(`
      SELECT c.id, c.number, c.title, c.priority, s.name AS suite_name, lr.status, lr.executed_at, lr.run_title
      FROM cases c LEFT JOIN suites s ON s.id = c.suite_id
      JOIN (
        SELECT r.case_id, r.status, COALESCE(r.executed_at, ru.started_at) AS executed_at, ru.title AS run_title,
          ROW_NUMBER() OVER (PARTITION BY r.case_id ORDER BY COALESCE(r.executed_at, ru.started_at) DESC, r.id DESC) AS rn
        FROM results r JOIN runs ru ON ru.id = r.run_id WHERE r.status != 'untested' AND r.case_id IS NOT NULL
      ) lr ON lr.case_id = c.id AND lr.rn = 1
      WHERE c.project_id = ? AND c.status != 'deprecated' AND lr.status IN ('failed', 'blocked')
      ORDER BY CASE c.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, c.number LIMIT 10`)
    .all(projectId);

  const bySuite = db
    .prepare(`
      SELECT COALESCE(s.name, 'No suite') AS name, COUNT(c.id) AS cases,
        SUM(EXISTS (SELECT 1 FROM automated_tests a WHERE a.case_id = c.id)) AS automated
      FROM cases c LEFT JOIN suites s ON s.id = c.suite_id
      WHERE c.project_id = ? AND c.status != 'deprecated' GROUP BY s.id ORDER BY s.position, s.id`)
    .all(projectId) as { name: string; cases: number; automated: number }[];

  const latestAuto = automatedRuns.at(-1) ?? null;
  const prevAuto = automatedRuns.at(-2) ?? null;
  const openManual = manualRuns.filter((r) => r.run_status === "in_progress").length;

  return {
    project,
    summary: {
      cases: cases.n,
      automatedCases: automatedCases.n,
      coverage: cases.n ? Math.round((automatedCases.n / cases.n) * 100) : 0,
      automatedTests: automatedTests.n,
      unlinkedTests: automatedTests.unlinked ?? 0,
      latestRate: latestAuto?.rate ?? null,
      previousRate: prevAuto?.rate ?? null,
      flakyTests: flaky.length,
      failingCases: failingCases.length,
      openManualRuns: openManual,
    },
    automatedRuns,
    manualRuns,
    mostFailing,
    flaky,
    slowest,
    failingCases,
    bySuite,
  };
}

// =====================================================================
// Milestone (sprint / release) report
// =====================================================================

interface Row {
  id: number;
  run_id: number;
  case_id: number | null;
  automated_test_id: number | null;
  status: string;
  flaky: number;
  duration_ms: number | null;
  error: string;
  notes: string;
  executed_at: string | null;
  snapshot: string | null;
  jira_key: string | null;
  kind: "manual" | "automated";
  run_title: string;
  started_at: string;
  framework: string | null;
  case_title: string | null;
  case_number: number | null;
  priority: string | null;
  suite_name: string | null;
  test_title: string | null;
  file: string | null;
}

function milestoneRows(projectId: number, name: string): Row[] {
  return db
    .prepare(`
      SELECT r.id, r.run_id, r.case_id, r.automated_test_id, r.status, r.flaky, r.duration_ms, r.error, r.notes, r.executed_at, r.snapshot, r.jira_key,
        ru.kind, ru.title AS run_title, ru.started_at, ru.framework,
        COALESCE(json_extract(r.snapshot, '$.title'), c.title) AS case_title,
        COALESCE(json_extract(r.snapshot, '$.number'), c.number) AS case_number,
        COALESCE(json_extract(r.snapshot, '$.priority'), c.priority) AS priority,
        s.name AS suite_name, a.title AS test_title, a.file
      FROM results r
      JOIN runs ru ON ru.id = r.run_id
      LEFT JOIN cases c ON c.id = r.case_id
      LEFT JOIN suites s ON s.id = c.suite_id
      LEFT JOIN automated_tests a ON a.id = r.automated_test_id
      WHERE ru.project_id = ? AND ru.milestone = ?
      ORDER BY ru.started_at, ru.id, r.id`)
    .all(projectId, name) as Row[];
}

/** Reruns replace earlier results: keep the newest executed result per key. */
function latestBy(rows: Row[], key: (r: Row) => number | null): Row[] {
  const map = new Map<number, Row>();
  for (const r of rows) {
    const k = key(r);
    if (k == null) continue;
    const prev = map.get(k);
    if (!prev || r.status !== "untested" || prev.status === "untested") map.set(k, r);
  }
  return [...map.values()];
}

function milestoneTotals(projectId: number, name: string) {
  const rows = milestoneRows(projectId, name);
  const manual = emptyTotals();
  const automated = emptyTotals();
  for (const r of latestBy(rows.filter((r) => r.kind === "manual"), (r) => r.case_id)) add(manual, r.status);
  for (const r of latestBy(rows.filter((r) => r.kind === "automated"), (r) => r.automated_test_id)) add(automated, r.status);
  const combined = sumTotals(manual, automated);
  return { manual, automated, combined, rate: passRate(combined), manualRate: passRate(manual), automatedRate: passRate(automated) };
}

export interface Milestone {
  id: number;
  project_id: number;
  name: string;
  kind: "sprint" | "release";
  start_date: string | null;
  end_date: string | null;
  created_at: string;
}

export function listMilestones(projectId: number) {
  const rows = db
    .prepare(`
      SELECT m.*, (SELECT COUNT(*) FROM runs ru WHERE ru.project_id = m.project_id AND ru.milestone = m.name) AS run_count
      FROM milestones m WHERE m.project_id = ?`)
    .all(projectId) as (Milestone & { run_count: number })[];
  // Newest first: by start date when set, otherwise by creation order.
  return rows.sort((a, b) => (b.start_date ?? b.created_at).localeCompare(a.start_date ?? a.created_at) || b.id - a.id);
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const PRIORITY_ORDER = ["critical", "high", "medium", "low"];

export function milestoneReport(milestoneId: number) {
  const milestone = db.prepare("SELECT * FROM milestones WHERE id = ?").get(milestoneId) as Milestone | undefined;
  if (!milestone) return null;
  const project = db.prepare("SELECT id, name, key FROM projects WHERE id = ?").get(milestone.project_id) as { id: number; name: string; key: string };

  const rows = milestoneRows(project.id, milestone.name);
  const manualLatest = latestBy(rows.filter((r) => r.kind === "manual"), (r) => r.case_id);
  const autoLatest = latestBy(rows.filter((r) => r.kind === "automated"), (r) => r.automated_test_id);
  const totals = milestoneTotals(project.id, milestone.name);

  // Requirements as seen through this sprint's results: a case counts as failed if any of its latest results failed.
  const caseStatus = new Map<number, "passed" | "failed">();
  for (const r of [...manualLatest, ...autoLatest]) {
    if (r.case_id == null || r.status === "untested" || r.status === "skipped") continue;
    if (r.status === "failed" || r.status === "blocked") caseStatus.set(r.case_id, "failed");
    else if (caseStatus.get(r.case_id) !== "failed") caseStatus.set(r.case_id, "passed");
  }
  const reqCoverage = listRequirements(project.id)
    .filter((r) => r.status !== "deprecated")
    .map((r) => ({ r, cov: classify(r.activeCaseIds.map((id) => caseStatus.get(id))) }));
  const failingCaseIds = [...new Set(reqCoverage.flatMap((x) => (x.cov.state === "failing" ? x.r.activeCaseIds.filter((id) => caseStatus.get(id) === "failed") : [])))];
  const caseInfo = new Map(
    (failingCaseIds.length ? (db.prepare(`SELECT id, number, title FROM cases WHERE id IN (${failingCaseIds.join(",")})`).all() as { id: number; number: number; title: string }[]) : []).map((c) => [c.id, c]),
  );
  const stateOrder = ["failing", "partial", "untested"];
  const requirements = {
    total: reqCoverage.length,
    byState: {
      passing: reqCoverage.filter((x) => x.cov.state === "passing").length,
      failing: reqCoverage.filter((x) => x.cov.state === "failing").length,
      partial: reqCoverage.filter((x) => x.cov.state === "partial").length,
      untested: reqCoverage.filter((x) => x.cov.state === "untested").length,
      uncovered: reqCoverage.filter((x) => x.cov.state === "uncovered").length,
    },
    /** Requirements that need a look: failing first, then ones not fully tested in this sprint. */
    attention: reqCoverage
      .filter((x) => stateOrder.includes(x.cov.state))
      .sort((a, b) => stateOrder.indexOf(a.cov.state) - stateOrder.indexOf(b.cov.state) || PRIORITY_ORDER.indexOf(a.r.priority) - PRIORITY_ORDER.indexOf(b.r.priority) || a.r.number - b.r.number)
      .slice(0, 20)
      .map((x) => ({
        number: x.r.number, title: x.r.title, priority: x.r.priority, state: x.cov.state, cases: x.cov.cases, passing: x.cov.passing,
        failingCases: x.r.activeCaseIds.filter((id) => caseStatus.get(id) === "failed").map((id) => caseInfo.get(id)).filter((c): c is { id: number; number: number; title: string } => !!c),
      })),
  };

  // Failing steps for failed/blocked manual results.
  const stepResults = db.prepare("SELECT step_id, status, actual FROM step_results WHERE result_id = ? AND status IN ('failed', 'blocked')");
  const manualFailures = manualLatest
    .filter((r) => r.status === "failed" || r.status === "blocked")
    .map((r) => {
      const snap = parseJson<CaseSnapshot | null>(r.snapshot, null);
      const steps = (stepResults.all(r.id) as { step_id: number; status: string; actual: string }[]).map((s) => {
        const idx = snap?.steps.findIndex((x) => x.id === s.step_id) ?? -1;
        return { number: idx + 1, action: snap?.steps[idx]?.action ?? "", expected: snap?.steps[idx]?.expected ?? "", actual: s.actual, status: s.status };
      });
      return {
        number: r.case_number, title: r.case_title ?? "Deleted case", priority: r.priority ?? "medium", suite: r.suite_name,
        status: r.status, notes: r.notes, steps, jira: r.jira_key,
      };
    })
    .sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority));

  const automatedFailures = autoLatest
    .filter((r) => r.status === "failed")
    .map((r) => ({ title: r.test_title ?? "Unknown", file: r.file ?? "", framework: r.framework, error: clip(r.error, 400), caseNumber: r.case_number }));

  const flakyMap = new Map<number, { title: string; file: string; count: number }>();
  for (const r of rows) {
    if (r.flaky && r.automated_test_id != null) {
      const cur = flakyMap.get(r.automated_test_id) ?? { title: r.test_title ?? "Unknown", file: r.file ?? "", count: 0 };
      cur.count++;
      flakyMap.set(r.automated_test_id, cur);
    }
  }

  // Manual results by suite.
  const suiteMap = new Map<string, Totals>();
  for (const r of manualLatest) {
    const k = r.suite_name ?? "No suite";
    if (!suiteMap.has(k)) suiteMap.set(k, emptyTotals());
    add(suiteMap.get(k)!, r.status);
  }

  const runs = db
    .prepare(`
      SELECT ru.id, ru.title, ru.kind, ru.framework, ru.environment, ru.started_at, ru.status AS run_status,
        COUNT(r.id) AS total, COALESCE(SUM(r.status = 'passed'), 0) AS passed, COALESCE(SUM(r.status = 'failed'), 0) AS failed,
        COALESCE(SUM(r.status = 'blocked'), 0) AS blocked, COALESCE(SUM(r.status = 'skipped'), 0) AS skipped,
        COALESCE(SUM(r.status = 'untested'), 0) AS untested
      FROM runs ru LEFT JOIN results r ON r.run_id = ru.id
      WHERE ru.project_id = ? AND ru.milestone = ? GROUP BY ru.id ORDER BY ru.started_at, ru.id`)
    .all(project.id, milestone.name) as (Totals & { id: number; title: string; kind: string; framework: string | null; environment: string; started_at: string; run_status: string })[];

  // Previous milestone in the same ordering used by the list.
  const all = listMilestones(project.id);
  const idx = all.findIndex((m) => m.id === milestone.id);
  const prevMilestone = all.slice(idx + 1).find((m) => m.run_count > 0) ?? null;
  const previous = prevMilestone ? { name: prevMilestone.name, ...milestoneTotals(project.id, prevMilestone.name) } : null;

  const cases = db.prepare("SELECT COUNT(*) AS n FROM cases WHERE project_id = ? AND status != 'deprecated'").get(project.id) as { n: number };
  const automatedCases = db
    .prepare("SELECT COUNT(DISTINCT c.id) AS n FROM cases c JOIN automated_tests a ON a.case_id = c.id WHERE c.project_id = ? AND c.status != 'deprecated'")
    .get(project.id) as { n: number };

  return {
    generatedAt: new Date().toISOString(),
    project,
    milestone: { ...milestone, firstRun: runs[0]?.started_at ?? null, lastRun: runs.at(-1)?.started_at ?? null },
    totals,
    previous,
    requirements,
    openManualRuns: runs.filter((r) => r.kind === "manual" && r.run_status === "in_progress").length,
    coverage: { cases: cases.n, automated: automatedCases.n, percent: cases.n ? Math.round((automatedCases.n / cases.n) * 100) : 0 },
    manualFailures,
    automatedFailures,
    flaky: [...flakyMap.values()].sort((a, b) => b.count - a.count),
    suites: [...suiteMap.entries()].map(([name, t]) => ({ name, ...t, rate: passRate(t) })),
    runs: runs.map((r) => ({ ...r, rate: passRate(r) })),
    automatedDurationMs: autoLatest.reduce((s, r) => s + (r.duration_ms ?? 0), 0),
  };
}

export type MilestoneReport = NonNullable<ReturnType<typeof milestoneReport>>;
