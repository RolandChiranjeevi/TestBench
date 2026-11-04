import "./env.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// scripts/ci-report.mjs run as GitHub Actions would run it: a real process, a report file, environment variables and a Testbench that is a small
// local server here. What matters is what it sends, what it prints, whether it fails the build, and that the token is never printed.

const SCRIPT = join(import.meta.dirname, "..", "scripts", "ci-report.mjs");
const TOKEN = "tbci_testtokenvalue_0123456789abcdef0123456789";
const dir = mkdtempSync(join(tmpdir(), "tb-ci-report-"));

interface Seen { url: string; auth: string | undefined; body: any; bytes: number }
let server: Server;
let port = 0;
let seen: Seen[] = [];
let answer: (req: IncomingMessage) => { status: number; body: unknown } = () => ({ status: 200, body: {} });

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      let body: any = null;
      try { body = JSON.parse(raw.toString("utf8")); } catch { /* not JSON */ }
      seen.push({ url: req.url ?? "", auth: req.headers.authorization, body, bytes: raw.length });
      const a = answer(req);
      res.writeHead(a.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(a.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
after(() => server.close());

const ok = (over: Record<string, unknown> = {}) => ({
  runId: "x", replayed: false, counts: { passed: 1, failed: 1, flaky: 0, skipped: 0 }, bugsCreated: 1, bugsUpdated: 0, reopened: 0, resolvedSuspected: 0, bugs: [], ...over,
});
const spec = (title: string, status: string, error?: string) => ({
  title, file: "tests/checkout.spec.ts",
  tests: [{ projectName: "chromium", status, results: [{ status: status === "unexpected" ? "failed" : "passed", duration: 10, ...(error ? { error: { message: error } } : {}) }] }],
});
const report = (specs: unknown[]) => ({ stats: { startTime: "2026-11-04T07:00:00.000Z", duration: 1000 }, suites: [{ title: "checkout.spec.ts", file: "tests/checkout.spec.ts", specs }] });

let n = 0;
const file = (content: string) => { const p = join(dir, `r${++n}.json`); writeFileSync(p, content); return p; };

const ENV_BASE = { GITHUB_RUN_ID: "777", GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY: "org/repo", GITHUB_SHA: "abcdef0123456789", GITHUB_REF_NAME: "main" };
function run(path: string, env: Record<string, string | undefined> = {}) {
  seen = [];
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, path], {
      env: { PATH: process.env.PATH, ...ENV_BASE, TESTBENCH_URL: `http://127.0.0.1:${port}`, TESTBENCH_PROJECT_ID: "3", TESTBENCH_API_TOKEN: TOKEN, ...env } as NodeJS.ProcessEnv,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

describe("ci-report.mjs: sending", () => {
  it("sends failed and passed tests with commit, branch, repository and run link, and logs the count and the answer", async () => {
    answer = () => ({ status: 200, body: ok() });
    const r = await run(file(JSON.stringify(report([spec("Empty cart", "unexpected", "boom"), spec("Total adds up", "expected")]))));
    assert.equal(r.code, 0, r.out);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "/api/projects/3/ci/test-results");
    assert.equal(seen[0].auth, `Bearer ${TOKEN}`);
    const b = seen[0].body;
    assert.deepEqual([b.commitSha, b.branch, b.repository, b.pipelineUrl, b.runId], ["abcdef0123456789", "main", "org/repo", "https://github.com/org/repo/actions/runs/777", "github-actions-777-1"]);
    assert.deepEqual(b.results.map((x: any) => [x.testKey, x.status]), [
      ["tests/checkout.spec.ts > Empty cart [chromium]", "failed"], ["tests/checkout.spec.ts > Total adds up [chromium]", "passed"],
    ]);
    assert.match(r.out, /sending 2 results \(1 failed, 0 flaky, 1 passed, 0 skipped\) for main at abcdef01/);
    assert.match(r.out, /Bugs with an event \(each counted once\): 1 new, 0 updated/);
    assert.equal(r.out.includes(TOKEN), false, "the token is never printed");
  });

  it("uses TESTBENCH_TOKEN when TESTBENCH_API_TOKEN is not set, and prefers TESTBENCH_API_TOKEN when both are", async () => {
    answer = () => ({ status: 200, body: ok() });
    const p = file(JSON.stringify(report([spec("a", "unexpected", "x")])));
    await run(p, { TESTBENCH_API_TOKEN: undefined, TESTBENCH_TOKEN: "tbci_old_name_token_000000000000000" });
    assert.equal(seen[0].auth, "Bearer tbci_old_name_token_000000000000000");
    await run(p, { TESTBENCH_TOKEN: "tbci_old_name_token_000000000000000" });
    assert.equal(seen[0].auth, `Bearer ${TOKEN}`);
  });

  it("sends nothing and says so when there is no token (a pull request from a fork)", async () => {
    const r = await run(file(JSON.stringify(report([spec("a", "unexpected", "x")]))), { TESTBENCH_API_TOKEN: undefined });
    assert.equal(r.code, 0);
    assert.equal(seen.length, 0);
    assert.match(r.out, /TESTBENCH_API_TOKEN is not set/);
  });
});

describe("ci-report.mjs: a missing, empty or unusable report", () => {
  it("warns and does not fail the build for a missing file, and sends nothing", async () => {
    const r = await run(join(dir, "does-not-exist.json"));
    assert.equal(r.code, 0);
    assert.equal(seen.length, 0);
    assert.match(r.out, /::warning::Testbench: could not read .*does-not-exist\.json/);
    assert.match(r.out, /JSON reporter/);
  });

  it("with TESTBENCH_STRICT=1 the same problems fail the build", async () => {
    assert.equal((await run(join(dir, "does-not-exist.json"), { TESTBENCH_STRICT: "1" })).code, 1);
    assert.equal((await run(file(""), { TESTBENCH_STRICT: "1" })).code, 1);
  });

  it("an empty file, invalid JSON and JSON that is not a report are warnings, not crashes", async () => {
    const empty = await run(file("  \n"));
    assert.match(empty.out, /is empty/);
    const bad = await run(file("{ not json"));
    assert.match(bad.out, /could not read/);
    const arr = await run(file("[]"));
    assert.match(arr.out, /is not a Playwright JSON report/);
    for (const r of [empty, bad, arr]) assert.equal(r.code, 0, r.out);
    assert.equal(seen.length, 0);
  });

  it("a report without any tests sends nothing (a notice, and a failure only in strict mode)", async () => {
    const p = file(JSON.stringify({ suites: [], errors: [] }));
    const r = await run(p);
    assert.equal(r.code, 0);
    assert.equal(seen.length, 0);
    assert.match(r.out, /contains no tests, so nothing was sent/);
    assert.equal((await run(p, { TESTBENCH_STRICT: "1" })).code, 1);
  });
});

describe("ci-report.mjs: what Testbench answers", () => {
  it("a refusal is a clear warning that does not contain the token, even if the server echoes it, and is not retried", async () => {
    answer = () => ({ status: 401, body: { error: `bad token ${TOKEN}` } });
    const r = await run(file(JSON.stringify(report([spec("a", "unexpected", "x")]))));
    assert.equal(r.code, 0);
    assert.equal(seen.length, 1, "a 401 is not retried");
    assert.match(r.out, /HTTP 401/);
    assert.equal(r.out.includes(TOKEN), false);
    assert.match(r.out, /\[token\]/);
  });

  it("a 413 gives an understandable message and is not retried", async () => {
    answer = () => ({ status: 413, body: { error: "too large" } });
    const r = await run(file(JSON.stringify(report([spec("a", "unexpected", "x")]))));
    assert.equal(r.code, 0);
    assert.equal(seen.length, 1);
    assert.match(r.out, /refused the request as too large \(the limit is 5 MB per request\)/);
  });

  it("a server that is not reachable is a warning, not a failed build", async () => {
    const r = await run(file(JSON.stringify(report([spec("a", "unexpected", "x")]))), { TESTBENCH_URL: "http://127.0.0.1:9", TESTBENCH_RETRY_DELAY_MS: "10" });
    assert.equal(r.code, 0);
    assert.match(r.out, /could not reach Testbench/);
    assert.equal(r.out.includes(TOKEN), false);
  });
});

describe("ci-report.mjs: a report that is too large for one request", () => {
  const bigGreen = (count: number) => Array.from({ length: count }, (_, i) => spec(`passed test ${i} ${"x".repeat(450)}`, "expected"));
  const manyTags = Array.from({ length: 19 }, (_, i) => `tag${i}-${"t".repeat(40)}`).join(",");

  it("leaves out passed results first, keeps the failed ones, and warns", async () => {
    answer = () => ({ status: 200, body: ok() });
    const r = await run(file(JSON.stringify(report([spec("The failing one", "unexpected", "boom"), ...bigGreen(4000)]))), { TESTBENCH_TAGS: manyTags });
    assert.equal(r.code, 0, r.out);
    assert.equal(seen.length, 1);
    assert.ok(seen[0].bytes <= 5 * 1024 * 1024, `sent ${seen[0].bytes} bytes`);
    assert.equal(seen[0].body.results[0].status, "failed");
    assert.ok(seen[0].body.results.length < 4001, "some passed results were left out");
    assert.match(r.out, /::warning::Testbench: the report was larger than 5 MB, so \d+ passed or skipped results were left out/);
  });

  it("sends nothing when the failed results alone are too large, and says how large they are", async () => {
    const failing = Array.from({ length: 1500 }, (_, i) => spec(`failing ${i}`, "unexpected", "e".repeat(3900)));
    const r = await run(file(JSON.stringify(report(failing))), { TESTBENCH_TAGS: manyTags });
    assert.equal(r.code, 0, r.out);
    assert.equal(seen.length, 0, "nothing is sent");
    assert.match(r.out, /the failed and flaky results alone are \d+\.\d MB, above the 5 MB limit for one request, so nothing was sent/);
    assert.equal((await run(file(JSON.stringify(report(failing))), { TESTBENCH_TAGS: manyTags, TESTBENCH_STRICT: "1" })).code, 1);
  });
});
