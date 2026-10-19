import { db, parseJson } from "./db.ts";

interface Point {
  resultId: number;
  runId: number;
  runTitle: string;
  startedAt: string;
  status: string;
  flaky: number;
  durationMs: number | null;
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * How stable and how fast the automated tests have been over their most recent runs.
 *
 * A test is "flaky" when it needed a retry to pass, or when it keeps flipping between passing and failing without
 * being broken for good. Retries alone are reported even if the final result was a pass, because that's exactly the
 * instability a green run hides.
 */
export function insightsData(projectId: number, windowRuns: number) {
  const runs = (
    db
      .prepare(`
        SELECT ru.id, ru.title, ru.started_at, COALESCE(SUM(r.duration_ms), 0) AS duration_ms, COUNT(r.id) AS tests,
          COALESCE(SUM(r.status = 'failed'), 0) AS failed
        FROM runs ru LEFT JOIN results r ON r.run_id = ru.id
        WHERE ru.project_id = ? AND ru.kind = 'automated'
        GROUP BY ru.id ORDER BY ru.started_at DESC, ru.id DESC LIMIT ?`)
      .all(projectId, windowRuns) as { id: number; title: string; started_at: string; duration_ms: number; tests: number; failed: number }[]
  ).reverse(); // oldest first, for charts

  const ids = runs.map((r) => r.id);
  const rows = ids.length
    ? (db
        .prepare(`
          SELECT r.id AS result_id, r.run_id, r.automated_test_id AS test_id, r.status, r.flaky, r.duration_ms,
            ru.title AS run_title, ru.started_at, a.title AS test_title, a.file, a.framework, c.number AS case_number
          FROM results r
          JOIN runs ru ON ru.id = r.run_id
          JOIN automated_tests a ON a.id = r.automated_test_id
          LEFT JOIN cases c ON c.id = a.case_id
          WHERE r.run_id IN (${ids.join(",")})
          ORDER BY ru.started_at, ru.id, r.id`)
        .all() as Record<string, any>[])
    : [];

  const byTest = new Map<number, { title: string; file: string; framework: string; caseNumber: number | null; points: Point[] }>();
  for (const r of rows) {
    if (!byTest.has(r.test_id)) byTest.set(r.test_id, { title: r.test_title, file: r.file, framework: r.framework, caseNumber: r.case_number, points: [] });
    byTest.get(r.test_id)!.points.push({
      resultId: r.result_id, runId: r.run_id, runTitle: r.run_title, startedAt: r.started_at, status: r.status, flaky: r.flaky, durationMs: r.duration_ms,
    });
  }

  const flaky: unknown[] = [];
  const slowdowns: unknown[] = [];
  for (const [testId, t] of byTest) {
    const timed = t.points.filter((p) => p.status !== "skipped");
    if (!timed.length) continue;

    const failures = timed.filter((p) => p.status === "failed").length;
    const retries = timed.filter((p) => p.flaky).length;
    let flips = 0;
    for (let i = 1; i < timed.length; i++) if ((timed[i].status === "failed") !== (timed[i - 1].status === "failed")) flips++;
    const unstable = retries > 0 || (failures > 0 && failures < timed.length && flips >= 2);
    if (unstable) {
      const lastEvent = [...timed].reverse().find((p) => p.flaky || p.status === "failed") ?? timed.at(-1)!;
      flaky.push({
        testId, title: t.title, file: t.file, framework: t.framework, caseNumber: t.caseNumber,
        runs: timed.length, failures, retries, flips, events: flips + retries,
        failingNow: timed.at(-1)!.status === "failed",
        lastEventRunId: lastEvent.runId,
        strip: timed.map((p) => ({ status: p.status, flaky: !!p.flaky, runId: p.runId, runTitle: p.runTitle, startedAt: p.startedAt })),
      });
    }

    // Slower than it used to be: the last three runs against everything before them.
    const durations = timed.filter((p) => p.durationMs != null).map((p) => p.durationMs as number);
    if (durations.length >= 6) {
      const recent = avg(durations.slice(-3));
      const before = avg(durations.slice(0, -3));
      const delta = recent - before;
      if (before >= 200 && delta >= 300 && delta / before >= 0.25) {
        slowdowns.push({ testId, title: t.title, file: t.file, caseNumber: t.caseNumber, beforeMs: Math.round(before), recentMs: Math.round(recent), deltaMs: Math.round(delta), pct: Math.round((delta / before) * 100), runId: timed.at(-1)!.runId });
      }
    }
  }
  flaky.sort((a: any, b: any) => b.events - a.events || b.failures - a.failures);
  slowdowns.sort((a: any, b: any) => b.deltaMs - a.deltaMs);

  return {
    window: windowRuns,
    runs: runs.map((r) => ({ id: r.id, title: r.title, started_at: r.started_at, duration_ms: r.duration_ms, tests: r.tests, failed: r.failed })),
    flaky: flaky.slice(0, 15),
    flakyTotal: flaky.length,
    slowdowns: slowdowns.slice(0, 10),
    ...automationCandidates(projectId, 15),
  };
}

const PRIORITY_WEIGHT: Record<string, number> = { critical: 8, high: 5, medium: 3, low: 1 };

/**
 * Manual cases that have no automated test yet, ranked by how much automating them would pay off:
 * important cases, ones that get executed by hand over and over, ones that keep failing, and smoke/regression cases.
 */
export function automationCandidates(projectId: number, limit: number) {
  const rows = db
    .prepare(`
      SELECT c.id, c.number, c.title, c.priority, c.tags, s.name AS suite,
        (SELECT COUNT(*) FROM results r JOIN runs ru ON ru.id = r.run_id
          WHERE r.case_id = c.id AND ru.kind = 'manual' AND r.status IN ('passed', 'failed', 'blocked')) AS executions,
        (SELECT COUNT(*) FROM results r JOIN runs ru ON ru.id = r.run_id
          WHERE r.case_id = c.id AND ru.kind = 'manual' AND r.status IN ('failed', 'blocked')) AS fails,
        (SELECT MAX(COALESCE(r.executed_at, ru.started_at)) FROM results r JOIN runs ru ON ru.id = r.run_id
          WHERE r.case_id = c.id AND ru.kind = 'manual' AND r.status != 'untested') AS last_manual
      FROM cases c LEFT JOIN suites s ON s.id = c.suite_id
      WHERE c.project_id = ? AND c.status != 'deprecated'
        AND NOT EXISTS (SELECT 1 FROM automated_tests a WHERE a.case_id = c.id)`)
    .all(projectId) as { id: number; number: number; title: string; priority: string; tags: string; suite: string | null; executions: number; fails: number; last_manual: string | null }[];

  const ranked = rows
    .map((c) => {
      const tags = parseJson<string[]>(c.tags, []).map((t) => t.toLowerCase());
      const core = tags.includes("smoke") || tags.includes("regression");
      const score = (PRIORITY_WEIGHT[c.priority] ?? 3) + c.executions + c.fails * 2 + (core ? 3 : 0);
      const reasons = [
        ...(c.priority === "critical" || c.priority === "high" ? [`${c.priority} priority`] : []),
        ...(c.executions >= 2 ? [`run by hand ${c.executions} times`] : []),
        ...(c.fails ? [`failed ${c.fails}×`] : []),
        ...(core ? [tags.includes("smoke") ? "smoke test" : "regression"] : []),
      ];
      return { id: c.id, number: c.number, title: c.title, priority: c.priority, suite: c.suite, executions: c.executions, fails: c.fails, lastManual: c.last_manual, score, reasons };
    })
    .sort((a, b) => b.score - a.score || a.number - b.number);

  return { candidates: ranked.slice(0, limit), candidatesTotal: ranked.length };
}
