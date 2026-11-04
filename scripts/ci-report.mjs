#!/usr/bin/env node
// Sends the result of a Playwright run (JSON reporter) from GitHub Actions to Testbench, where failed tests become bugs.
// One file, no dependencies: copy it into the repository whose tests you run.
//
//   TESTBENCH_URL=https://testbench.example.com TESTBENCH_PROJECT_ID=3 TESTBENCH_API_TOKEN=... node ci-report.mjs [test-results/results.json]
//
// The token comes from the environment (a GitHub secret; TESTBENCH_TOKEN works too), is sent only in the Authorization header and is never printed.
// A failure to report is a warning, not a failed build, unless TESTBENCH_STRICT=1. A missing, empty or invalid report is such a failure; a report
// without any tests is reported as a notice and nothing is sent. If the failed and flaky results alone are too large for one request, nothing is sent
// (passed and skipped results are dropped first, and a warning says so).
//
// Optional: TESTBENCH_RUN_SUFFIX (needed when one workflow run reports from several jobs), TESTBENCH_ARTIFACT_URL (where the uploaded
// traces and screenshots can be found; defaults to the workflow run page), TESTBENCH_TAGS (extra tags, comma-separated).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_RESULTS = 5000;
const MAX_KEY = 300;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

const clean = (s) => String(s ?? "").replace(ANSI, "").trim();

/** A key that stays the same for the same test: file, titles and Playwright project. Long keys are shortened with a hash of the whole. */
export function testKeyOf(file, titlePath, project) {
  const full = [file, ...titlePath].filter(Boolean).join(" > ") + (project ? ` [${project}]` : "");
  if (full.length <= MAX_KEY) return full;
  return `${full.slice(0, MAX_KEY - 13)}~${createHash("sha1").update(full).digest("hex").slice(0, 12)}`;
}

const STATUS = { expected: "passed", unexpected: "failed", flaky: "flaky", skipped: "skipped" };

/** Walks the suites of a Playwright JSON report and returns one result per test and project (the worst of its retries). */
export function resultsFromReport(report, { artifactUrl = "", extraTags = [] } = {}) {
  const results = [];
  const used = new Map();
  const walk = (suite, path, file, isFile = false) => {
    // A top-level suite is the file itself; only describe blocks below it are part of a test's title path.
    const here = !isFile && suite.title ? [...path, suite.title] : path;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const status = STATUS[test.status];
        if (!status) continue;
        const titlePath = [...here, spec.title];
        let key = testKeyOf(spec.file ?? file, titlePath, test.projectName);
        const seen = (used.get(key) ?? 0) + 1;
        used.set(key, seen);
        if (seen > 1) key = `${key.slice(0, MAX_KEY - 6)} #${seen}`; // the same title twice in one file
        const attempts = test.results ?? [];
        const last = [...attempts].reverse().find((r) => r.status !== "skipped") ?? attempts.at(-1) ?? {};
        const failing = [...attempts].reverse().find((r) => r.status === "failed" || r.status === "timedOut" || r.status === "interrupted") ?? last;
        const err = failing.error ?? failing.errors?.[0];
        const attachments = [];
        if (status !== "passed" && status !== "skipped" && artifactUrl) {
          for (const a of attempts.flatMap((r) => r.attachments ?? [])) {
            if (!a.path) continue; // inline text, not a file
            const type = /trace/i.test(a.name ?? "") ? "trace" : /^image\//.test(a.contentType ?? "") ? "screenshot" : /^video\//.test(a.contentType ?? "") ? "video" : "file";
            const name = basename(a.path);
            if (!attachments.some((x) => x.name === name)) attachments.push({ name, url: artifactUrl, type });
          }
        }
        results.push({
          testKey: key,
          title: titlePath.join(" › ").slice(0, 500), // the server refuses longer titles, and one long title must not make it refuse the whole run
          status,
          durationMs: Math.round(attempts.reduce((s, r) => s + (r.duration ?? 0), 0)),
          error: status === "failed" || status === "flaky" ? clean(err?.message ?? err?.stack ?? failing.status).slice(0, 4000) : "",
          steps: status === "failed" || status === "flaky" ? (failing.steps ?? []).map((s) => clean(s.title)).filter(Boolean).slice(0, 20) : [],
          attachments: attachments.slice(0, 20),
          tags: [...new Set([...(test.projectName ? [test.projectName] : []), ...(spec.tags ?? []), ...extraTags])].slice(0, 20),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, here, child.file ?? file);
  };
  for (const s of report.suites ?? []) walk(s, [], s.file ?? s.title, true);
  return results;
}

/** What the GitHub Actions environment says about this run. */
export function runFromEnv(env, report, event = {}) {
  const server = env.GITHUB_SERVER_URL || "https://github.com";
  const runUrl = env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY ? `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
  const start = report.stats?.startTime ? new Date(report.stats.startTime) : undefined;
  const finish = start && report.stats?.duration ? new Date(start.getTime() + report.stats.duration) : undefined;
  const attempt = env.GITHUB_RUN_ATTEMPT || "1";
  const suffix = env.TESTBENCH_RUN_SUFFIX ? `-${env.TESTBENCH_RUN_SUFFIX}` : "";
  return {
    runId: `github-actions-${env.GITHUB_RUN_ID || Date.now()}-${attempt}${suffix}`,
    // For a pull request GITHUB_SHA is a merge commit that nobody can check out; the head commit is the one that was pushed.
    commitSha: event.pull_request?.head?.sha || env.GITHUB_SHA || "",
    branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || "",
    repository: env.GITHUB_REPOSITORY || "",
    pipelineUrl: runUrl,
    startedAt: start?.toISOString(),
    finishedAt: finish?.toISOString(),
    runUrl,
  };
}

/** The whole request body. Failed and flaky tests always go; passes are what lets Testbench notice that a bug may be resolved. */
export function buildPayload(report, env = process.env, event = {}) {
  const { runUrl, ...run } = runFromEnv(env, report, event);
  const extraTags = (env.TESTBENCH_TAGS ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const all = resultsFromReport(report, { artifactUrl: env.TESTBENCH_ARTIFACT_URL || runUrl || "", extraTags });
  const important = all.filter((r) => r.status === "failed" || r.status === "flaky");
  const rest = all.filter((r) => r.status !== "failed" && r.status !== "flaky");
  const results = [...important, ...rest].slice(0, MAX_RESULTS);
  return { payload: { ...run, results }, omitted: all.length - results.length };
}

// Testbench refuses a request above 5 MiB. Stay a little under it so that the headers and rounding never tip it over.
export const MAX_BODY_BYTES = 5 * 1024 * 1024 - 16 * 1024;
const bytes = (x) => Buffer.byteLength(JSON.stringify(x));

/**
 * Makes the payload fit in one request. Failed and flaky results always stay; passed and skipped results are dropped when there is no room.
 * Returns payload: null when even the failed and flaky ones alone are too large (nothing is sent then).
 */
export function fitPayload(payload, max = MAX_BODY_BYTES) {
  const size = bytes(payload);
  if (size <= max) return { payload, size, droppedGreen: 0 };
  const important = payload.results.filter((r) => r.status === "failed" || r.status === "flaky");
  const rest = payload.results.filter((r) => r.status !== "failed" && r.status !== "flaky");
  let used = bytes({ ...payload, results: important });
  if (used > max) return { payload: null, size: used, droppedGreen: rest.length };
  const kept = [];
  for (const r of rest) {
    const n = bytes(r) + 1;
    if (used + n > max) continue;
    kept.push(r);
    used += n;
  }
  return { payload: { ...payload, results: [...important, ...kept] }, size: used, droppedGreen: rest.length - kept.length };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(url, token, payload) {
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      last = res.status === 413
        ? "Testbench refused the request as too large (the limit is 5 MB per request). Send fewer passed tests or split the run."
        : `HTTP ${res.status}: ${text.slice(0, 300)}`;
      if (res.status < 500 && res.status !== 429) break; // a refusal will not change by trying again
    } catch (e) {
      last = `could not reach Testbench (${e instanceof Error ? e.message : "network error"})`;
    }
    await sleep(attempt * (Number(process.env.TESTBENCH_RETRY_DELAY_MS) || 2000));
  }
  throw new Error(last);
}

async function main() {
  const file = process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) ?? "test-results/results.json";
  const dry = process.argv.includes("--dry-run");
  const strict = process.env.TESTBENCH_STRICT === "1";
  const fail = (msg) => {
    console.error(`${strict ? "::error::" : "::warning::"}Testbench: ${msg}`);
    process.exit(strict ? 1 : 0);
  };

  const reporterHint = "Add the JSON reporter: reporter: [['json', { outputFile: 'test-results/results.json' }]]";
  let report;
  try {
    const raw = readFileSync(file, "utf8");
    if (!raw.trim()) return fail(`${file} is empty (the test run probably stopped before it wrote a report). ${reporterHint}`);
    report = JSON.parse(raw);
  } catch (e) {
    return fail(`could not read ${file}: ${e instanceof Error ? e.message : e}. ${reporterHint}`);
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) return fail(`${file} is not a Playwright JSON report. ${reporterHint}`);
  let event = {};
  try {
    if (process.env.GITHUB_EVENT_PATH) event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  } catch { /* the event file is optional */ }
  const built = buildPayload(report, process.env, event);
  const omitted = built.omitted;
  const fit = fitPayload(built.payload);
  const payload = fit.payload;
  if (dry) {
    console.log(JSON.stringify(payload ?? built.payload, null, 2));
    return;
  }

  if (built.payload.results.length === 0) {
    if (strict) return fail(`${file} contains no tests, so there is nothing to report.`);
    console.log(`Testbench: ${file} contains no tests, so nothing was sent.`);
    return;
  }

  const { TESTBENCH_URL: base, TESTBENCH_PROJECT_ID: project } = process.env;
  const token = process.env.TESTBENCH_API_TOKEN || process.env.TESTBENCH_TOKEN;
  if (!token) {
    // Pull requests from forks do not get the repository's secrets. That is expected, not an error.
    console.log("Testbench: TESTBENCH_API_TOKEN is not set (a pull request from a fork gets no secrets), so nothing was reported.");
    return;
  }
  if (!base || !/^\d+$/.test(project ?? "")) return fail("set TESTBENCH_URL and TESTBENCH_PROJECT_ID (the number in the project's address)");
  if (omitted > 0) console.log(`::notice::Testbench: ${omitted} passed tests were left out (at most ${MAX_RESULTS} results per run).`);
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  if (!payload) {
    return fail(`the failed and flaky results alone are ${mb(fit.size)} MB, above the 5 MB limit for one request, so nothing was sent. Shorten the error output of the failing tests or split the run.`);
  }
  if (fit.droppedGreen > 0) {
    console.log(`::warning::Testbench: the report was larger than 5 MB, so ${fit.droppedGreen} passed or skipped results were left out. ` +
      "A bug whose test passed may therefore not be marked as possibly resolved this time.");
  }

  const n = (st) => payload.results.filter((r) => r.status === st).length;
  console.log(`Testbench: sending ${payload.results.length} results (${n("failed")} failed, ${n("flaky")} flaky, ${n("passed")} passed, ${n("skipped")} skipped) for ${payload.branch || "unknown branch"} at ${payload.commitSha.slice(0, 8) || "unknown commit"}.`);
  try {
    const s = await send(`${base.replace(/\/$/, "")}/api/projects/${project}/ci/test-results`, token, payload);
    const c = s.counts ?? {};
    // The four bug counters never overlap: a reopened bug is counted as reopened only, not as updated.
    console.log(`Testbench: ${c.failed ?? 0} failed, ${c.flaky ?? 0} flaky, ${c.passed ?? 0} passed tests. ` +
      `Bugs with an event (each counted once): ${s.bugsCreated} new, ${s.bugsUpdated} updated (no status change), ${s.reopened} reopened, ${s.resolvedSuspected} may be resolved.` +
      (s.replayed ? " This run had already been reported, so nothing was changed." : ""));
  } catch (e) {
    fail(e instanceof Error ? e.message.replaceAll(token, "[token]") : "request failed");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
