import { db, parseJson } from "./db.ts";

/**
 * Suggested links between unlinked automated tests and manual cases, judged by TypeSafe's System One model. Opt-in: nothing is sent
 * anywhere unless TYPESAFE_API_KEY is set. A person always confirms; this never links anything by itself.
 *
 * How it works: code shortlists a few cases per test by word overlap (cheap, local), then ONE request per test asks a yes/no question
 * per candidate ("does this test check what that case describes?"). The answers are probabilities; code decides the threshold.
 * Every judged pair is stored, so the same pair is never paid for twice.
 */

export interface TypeSafeConfig { key: string; url: string; model: string; threshold: number }

export function typesafeConfig(): TypeSafeConfig | null {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key) return null;
  return {
    key,
    url: (process.env.TYPESAFE_API_URL?.trim() || "https://api.typesafe.ai").replace(/\/$/, ""),
    model: process.env.TYPESAFE_MODEL?.trim() || "jev-latest",
    threshold: Number(process.env.TYPESAFE_LINK_THRESHOLD) > 0 ? Number(process.env.TYPESAFE_LINK_THRESHOLD) : 0.7,
  };
}

// ---------- Shortlist (local, no network) ----------

const STOP = new Set(["the", "a", "an", "to", "of", "and", "or", "in", "on", "for", "with", "is", "are", "can", "should", "user", "test", "spec", "ts", "js", "e2e"]);

/** Lower-case word stems from free text, file names and camelCase/kebab-case. */
export function tokens(text: string): string[] {
  const words = text
    .replace(/@[\w-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w))
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
  return [...new Set(words)];
}

interface TestRow { id: number; title: string; suite_path: string; file: string }
interface CaseRow { id: number; number: number; title: string; suite: string | null; tags: string }

export function shortlist(test: TestRow, cases: { c: CaseRow; words: Set<string> }[], k: number) {
  const t = new Set(tokens(`${test.title} ${test.suite_path} ${test.file.split("/").pop() ?? ""}`));
  if (!t.size) return [];
  return cases
    .map(({ c, words }) => {
      let hit = 0;
      for (const w of t) if (words.has(w)) hit++;
      return { c, score: hit / Math.sqrt(t.size * Math.max(words.size, 1)) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.number - b.c.number)
    .slice(0, k)
    .map((x) => x.c);
}

// ---------- The judgment ----------

const QUESTION_TRUE =
  "The automated test exercises the scenario the manual case describes, so whether that test passes or fails is meaningful evidence about that case. It may cover only part of the case if that is its core.";
const QUESTION_FALSE = "The test covers a different feature or scenario, even if it shares words or is in the same area.";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

interface Candidate { id: number; label: string; title: string; suite: string | null; steps: { action: string; expected: string }[] }

export class SuggestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function judge(cfg: TypeSafeConfig, test: TestRow, candidates: Candidate[]): Promise<{ probs: Map<number, number>; tokens: number }> {
  const questions: Record<string, unknown> = {};
  candidates.forEach((c, i) => {
    questions[`c${c.id}`] = {
      type: "noul",
      instructions: `Does the automated test \`automated_test\` check the same behavior that the manual test case \`candidates[${i}]\` describes? Judge the intent of both, not just shared words.`,
      criteria: { true: QUESTION_TRUE, false: QUESTION_FALSE },
    };
  });
  const state = {
    automated_test: { title: clip(test.title.replace(/@[\w-]+/g, "").replace(/\s*\[[^\]]+\]$/, "").trim(), 300), suite: clip(test.suite_path, 200), file: test.file },
    candidates: candidates.map((c) => ({
      id: c.label,
      title: clip(c.title, 300),
      suite: c.suite,
      steps: c.steps.slice(0, 8).map((s) => ({ action: clip(s.action, 200), expected: clip(s.expected, 200) })),
    })),
  };

  const res = await fetch(`${cfg.url}/v1/systemone`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg.model, state, questions }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401 || res.status === 403) throw new SuggestError(502, "TypeSafe rejected the API key. Check TYPESAFE_API_KEY.");
  if (res.status === 429) throw new SuggestError(429, "TypeSafe says too many requests. Try again in a minute.");
  if (!res.ok) throw new SuggestError(502, `TypeSafe returned ${res.status}: ${clip((await res.text().catch(() => "")).replace(/\s+/g, " "), 200)}`);

  const body = (await res.json()) as { answers?: Record<string, { type?: string; noul?: number }>; usage?: { input_tokens?: number } };
  const probs = new Map<number, number>();
  for (const c of candidates) {
    const a = body.answers?.[`c${c.id}`];
    if (a?.type === "noul" && typeof a.noul === "number") probs.set(c.id, a.noul);
  }
  return { probs, tokens: body.usage?.input_tokens ?? 0 };
}

// ---------- Project-level flow ----------

const PER_TEST_CANDIDATES = 5;

/** Judge up to `limit` unlinked tests that have not been judged yet (or all of them with `force`). */
export async function suggestLinks(projectId: number, opts: { limit?: number; force?: boolean } = {}) {
  const cfg = typesafeConfig();
  if (!cfg) throw new SuggestError(400, "Link suggestions are off. Set TYPESAFE_API_KEY and restart Testbench.");
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));

  if (opts.force) {
    db.prepare("DELETE FROM link_judged WHERE automated_test_id IN (SELECT id FROM automated_tests WHERE project_id = ? AND case_id IS NULL)").run(projectId);
  }
  const pending = db
    .prepare(`
      SELECT a.id, a.title, a.suite_path, a.file FROM automated_tests a
      WHERE a.project_id = ? AND a.case_id IS NULL AND NOT EXISTS (SELECT 1 FROM link_judged j WHERE j.automated_test_id = a.id)
      ORDER BY a.id`)
    .all(projectId) as TestRow[];
  const batch = pending.slice(0, limit);

  const caseRows = db
    .prepare("SELECT c.id, c.number, c.title, c.tags, s.name AS suite FROM cases c LEFT JOIN suites s ON s.id = c.suite_id WHERE c.project_id = ? AND c.status != 'deprecated'")
    .all(projectId) as CaseRow[];
  const stepsOf = db.prepare("SELECT action, expected FROM case_steps WHERE case_id = ? ORDER BY position");
  const key = (db.prepare("SELECT key FROM projects WHERE id = ?").get(projectId) as { key: string }).key;
  const indexed = caseRows.map((c) => {
    const steps = stepsOf.all(c.id) as { action: string; expected: string }[];
    const words = new Set(tokens(`${c.title} ${c.suite ?? ""} ${steps.map((s) => s.action).join(" ")} ${parseJson<string[]>(c.tags, []).join(" ")}`));
    return { c, words, steps };
  });
  const stepMap = new Map(indexed.map((x) => [x.c.id, x.steps]));

  const save = db.prepare(`
    INSERT INTO link_suggestions (automated_test_id, case_id, probability, model) VALUES (?, ?, ?, ?)
    ON CONFLICT (automated_test_id, case_id) DO UPDATE SET probability = excluded.probability, model = excluded.model`);
  const markJudged = db.prepare("INSERT OR REPLACE INTO link_judged (automated_test_id, candidates) VALUES (?, ?)");

  let usedTokens = 0;
  let judged = 0;
  let error: string | null = null;
  let next = 0;
  const worker = async () => {
    while (!error) {
      const test = batch[next++];
      if (!test) return;
      const cands = shortlist(test, indexed, PER_TEST_CANDIDATES);
      try {
        if (cands.length) {
          const { probs, tokens: t } = await judge(
            cfg,
            test,
            cands.map((c) => ({ id: c.id, label: `${key}-${c.number}`, title: c.title, suite: c.suite, steps: stepMap.get(c.id) ?? [] })),
          );
          usedTokens += t;
          db.transaction(() => {
            for (const [caseId, p] of probs) save.run(test.id, caseId, p, cfg.model);
            markJudged.run(test.id, cands.length);
          })();
        } else {
          markJudged.run(test.id, 0);
        }
        judged++;
      } catch (e) {
        // Stop the whole batch on an API problem (bad key, rate limit); what was judged so far is kept.
        error = e instanceof Error ? e.message : String(e);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  return { judged, remaining: pending.length - judged, inputTokens: usedTokens, error };
}

/** Pending suggestions: unlinked tests whose best candidates reach the threshold and were not dismissed. */
export function listSuggestions(projectId: number) {
  const cfg = typesafeConfig();
  const threshold = cfg?.threshold ?? 0.7;
  const rows = db
    .prepare(`
      SELECT s.automated_test_id, s.case_id, s.probability, a.title AS test_title, a.file AS test_file, a.framework,
        c.number AS case_number, c.title AS case_title
      FROM link_suggestions s
      JOIN automated_tests a ON a.id = s.automated_test_id
      JOIN cases c ON c.id = s.case_id AND c.status != 'deprecated'
      WHERE a.project_id = ? AND a.case_id IS NULL AND s.dismissed = 0 AND s.probability >= ?
      ORDER BY s.automated_test_id, s.probability DESC`)
    .all(projectId, threshold) as {
    automated_test_id: number; case_id: number; probability: number; test_title: string; test_file: string; framework: string; case_number: number; case_title: string;
  }[];

  const byTest = new Map<number, { testId: number; title: string; file: string; framework: string; candidates: { caseId: number; number: number; title: string; probability: number }[] }>();
  for (const r of rows) {
    const t = byTest.get(r.automated_test_id) ?? { testId: r.automated_test_id, title: r.test_title, file: r.test_file, framework: r.framework, candidates: [] };
    if (t.candidates.length < 3) t.candidates.push({ caseId: r.case_id, number: r.case_number, title: r.case_title, probability: r.probability });
    byTest.set(r.automated_test_id, t);
  }
  const unjudged = (db.prepare("SELECT COUNT(*) AS n FROM automated_tests a WHERE a.project_id = ? AND a.case_id IS NULL AND NOT EXISTS (SELECT 1 FROM link_judged j WHERE j.automated_test_id = a.id)").get(projectId) as { n: number }).n;
  return {
    suggestions: [...byTest.values()].sort((a, b) => b.candidates[0].probability - a.candidates[0].probability),
    unjudged,
    threshold,
  };
}

export function dismissSuggestion(testId: number, caseId: number) {
  db.prepare("UPDATE link_suggestions SET dismissed = 1 WHERE automated_test_id = ? AND case_id = ?").run(testId, caseId);
}
