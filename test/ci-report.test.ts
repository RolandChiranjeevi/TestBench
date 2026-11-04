import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db } from "../server/db.ts";
import { makeProject } from "./helpers.ts";
import { ingestCiResults } from "../server/ci.ts";
// @ts-expect-error a plain .mjs script without types
import { buildPayload, testKeyOf } from "../scripts/ci-report.mjs";

// A trimmed Playwright JSON report: one passing test, one failing test with a trace and a screenshot, one flaky test and one skipped.
const report = {
  stats: { startTime: "2026-11-04T07:00:00.000Z", duration: 240000 },
  suites: [{
    title: "checkout.spec.ts", file: "tests/checkout.spec.ts",
    specs: [
      { title: "Cart total adds up", file: "tests/checkout.spec.ts", tests: [{ projectName: "chromium", status: "expected", results: [{ status: "passed", duration: 900 }] }] },
      {
        title: "Empty cart checkout fails", file: "tests/checkout.spec.ts",
        tests: [{
          projectName: "chromium", status: "unexpected",
          results: [
            { status: "failed", duration: 2000, retry: 0, error: { message: "\u001b[31mExpected checkout button to be enabled\u001b[39m\nAuthorization: Bearer abcdefghijklmnop1234" }, attachments: [] },
            { status: "failed", duration: 2210, retry: 1, error: { message: "Expected checkout button to be enabled" },
              steps: [{ title: "Add product to cart" }, { title: "Open checkout" }],
              attachments: [{ name: "trace", path: "/w/test-results/a/trace.zip", contentType: "application/zip" }, { name: "screenshot", path: "/w/test-results/a/test-failed-1.png", contentType: "image/png" }, { name: "log", body: "inline" }] },
          ],
        }],
      },
      { title: "Coupon applies", file: "tests/checkout.spec.ts", tests: [{ projectName: "chromium", status: "flaky", results: [{ status: "failed", duration: 500, error: { message: "timeout" } }, { status: "passed", duration: 480 }] }] },
      { title: "Not on mobile", file: "tests/checkout.spec.ts", tests: [{ projectName: "chromium", status: "skipped", results: [{ status: "skipped", duration: 0 }] }] },
    ],
    suites: [{ title: "Guest", specs: [{ title: "Pays as guest", file: "tests/checkout.spec.ts", tests: [{ projectName: "firefox", status: "unexpected", results: [{ status: "timedOut", duration: 30000, error: { message: "Test timeout of 30000ms exceeded." } }] }] }] }],
  }],
};

const env = { GITHUB_RUN_ID: "12345", GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY: "org/repo", GITHUB_SERVER_URL: "https://github.com", GITHUB_SHA: "mergecommit", GITHUB_REF_NAME: "feature/checkout" };

describe("scripts/ci-report.mjs", () => {
  it("turns a Playwright report into one result per test and project, with stable keys", () => {
    const { payload } = buildPayload(report, env, { pull_request: { head: { sha: "headcommit" } } });
    assert.deepEqual([payload.runId, payload.commitSha, payload.branch, payload.repository], ["github-actions-12345-1", "headcommit", "feature/checkout", "org/repo"]);
    assert.equal(payload.pipelineUrl, "https://github.com/org/repo/actions/runs/12345");
    assert.deepEqual([payload.startedAt, payload.finishedAt], ["2026-11-04T07:00:00.000Z", "2026-11-04T07:04:00.000Z"]);
    const keys = payload.results.map((r: any) => r.testKey).sort();
    assert.deepEqual(keys, [
      "tests/checkout.spec.ts > Cart total adds up [chromium]", "tests/checkout.spec.ts > Coupon applies [chromium]", "tests/checkout.spec.ts > Empty cart checkout fails [chromium]",
      "tests/checkout.spec.ts > Guest > Pays as guest [firefox]", "tests/checkout.spec.ts > Not on mobile [chromium]",
    ].sort());
    assert.deepEqual(payload.results.map((r: any) => r.status).sort(), ["failed", "failed", "flaky", "passed", "skipped"]);
    assert.deepEqual(payload.results.slice(0, 3).map((r: any) => r.status).sort(), ["failed", "failed", "flaky"], "failed and flaky go first");
  });

  it("takes the error without colour codes, the steps, and the attachments as links to the run", () => {
    const { payload } = buildPayload(report, env);
    const r = payload.results.find((x: any) => x.title.includes("Empty cart"));
    assert.equal(r.error, "Expected checkout button to be enabled", "the message of the last failing attempt");
    assert.deepEqual(r.steps, ["Add product to cart", "Open checkout"]);
    assert.deepEqual(r.attachments, [
      { name: "trace.zip", url: "https://github.com/org/repo/actions/runs/12345", type: "trace" },
      { name: "test-failed-1.png", url: "https://github.com/org/repo/actions/runs/12345", type: "screenshot" },
    ]);
    assert.deepEqual(r.tags, ["chromium"]);
  });

  it("a long key is shortened the same way every time, and the same title twice in a file stays distinct", () => {
    const long = testKeyOf("f.spec.ts", ["x".repeat(400)], "chromium");
    assert.ok(long.length <= 300);
    assert.equal(long, testKeyOf("f.spec.ts", ["x".repeat(400)], "chromium"));
    assert.notEqual(long, testKeyOf("f.spec.ts", ["x".repeat(399) + "y"], "chromium"));
    const twice = { suites: [{ title: "a.spec.ts", file: "a.spec.ts", specs: [1, 2].map(() => ({ title: "same", file: "a.spec.ts", tests: [{ projectName: "p", status: "expected", results: [{ status: "passed" }] }] })) }] };
    const keys = buildPayload(twice, env).payload.results.map((r: any) => r.testKey);
    assert.equal(new Set(keys).size, 2);
  });

  it("what it builds is accepted by the server and makes the bugs it should, again and again", () => {
    const p = makeProject("CIR", "Report script");
    const first = ingestCiResults(p.id, buildPayload(report, env).payload);
    assert.deepEqual([first.bugsCreated, first.counts], [3, { passed: 1, failed: 2, flaky: 1, skipped: 1 }]);
    const again = ingestCiResults(p.id, { ...buildPayload(report, env).payload, runId: "github-actions-12346-1" });
    assert.deepEqual([again.bugsCreated, again.bugsUpdated], [0, 3]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?").get(p.id) as { n: number }).n, 3);
  });
});
