import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractCaseRefs, parseReport } from "../server/importers/parse.ts";

describe("extractCaseRefs", () => {
  it("finds an ID in the forms people actually write", () => {
    assert.deepEqual(extractCaseRefs("@SHOP-12 user can log in"), ["SHOP-12"]);
    assert.deepEqual(extractCaseRefs("[SHOP-12] user can log in"), ["SHOP-12"]);
    assert.deepEqual(extractCaseRefs("SHOP-12 user can log in"), ["SHOP-12"]);
    assert.deepEqual(extractCaseRefs("(SHOP-12) user can log in"), ["SHOP-12"]);
    assert.deepEqual(extractCaseRefs("SHOP-12, SHOP-13 both"), ["SHOP-12", "SHOP-13"]);
  });

  it("accepts a colon or semicolon after the ID (regression: 'D-1: Add competitor' was not linked)", () => {
    assert.deepEqual(extractCaseRefs("D-1: Add competitor"), ["D-1"]);
    assert.deepEqual(extractCaseRefs("D-1; Add competitor"), ["D-1"]);
    assert.deepEqual(extractCaseRefs("D-1 - Add competitor"), ["D-1"]);
  });

  it("normalises case, and reads IDs from tags and several sources", () => {
    assert.deepEqual(extractCaseRefs("login works", "@shop-3"), ["SHOP-3"]);
    assert.deepEqual(extractCaseRefs("a", "SHOP-1", "SHOP-1 again"), ["SHOP-1"]);
  });

  it("does not match IDs glued into longer words", () => {
    assert.deepEqual(extractCaseRefs("SHOP-12abc is not an id"), []);
    // A word stuck to the front is read as a different project key, so it can never link to SHOP.
    assert.deepEqual(extractCaseRefs("prefixSHOP-12 nope"), ["PREFIXSHOP-12"]);
    assert.deepEqual(extractCaseRefs("no id here"), []);
  });
});

describe("parseReport: Playwright JSON", () => {
  const report = {
    config: { rootDir: "/work/e2e" },
    stats: { startTime: "2026-10-21T10:00:00.000Z" },
    suites: [
      {
        title: "login.spec.ts",
        file: "login.spec.ts",
        specs: [],
        suites: [
          {
            title: "Login",
            specs: [
              { title: "passes", file: "login.spec.ts", line: 3, column: 1, tags: ["@SHOP-1"], tests: [{ projectName: "chromium", status: "expected", annotations: [], results: [{ status: "passed", duration: 120, retry: 0 }] }] },
              {
                title: "fails",
                file: "login.spec.ts",
                line: 9,
                column: 1,
                tags: [],
                tests: [
                  {
                    projectName: "chromium",
                    status: "unexpected",
                    annotations: [],
                    results: [{ status: "failed", duration: 300, retry: 0, errors: [{ message: "\u001b[31mExpected: 1\u001b[39m\nReceived: 2", location: { file: "/work/e2e/login.spec.ts", line: 11, column: 5 } }] }],
                  },
                ],
              },
              {
                title: "flaky one",
                file: "login.spec.ts",
                line: 15,
                column: 1,
                tags: [],
                tests: [
                  {
                    projectName: "chromium",
                    status: "flaky",
                    annotations: [],
                    results: [
                      { status: "failed", duration: 100, retry: 0, errors: [{ message: "timeout" }] },
                      { status: "passed", duration: 90, retry: 1 },
                    ],
                  },
                ],
              },
              { title: "skipped one", file: "login.spec.ts", line: 20, column: 1, tags: [], tests: [{ projectName: "chromium", status: "skipped", annotations: [{ type: "skip" }], results: [] }] },
            ],
          },
        ],
      },
    ],
  };
  const parsed = parseReport(JSON.stringify(report));
  const byTitle = (t: string) => parsed.tests.find((x) => x.title.startsWith(t))!;

  it("reads the framework, start time and every test", () => {
    assert.equal(parsed.framework, "playwright");
    assert.equal(parsed.startedAt, "2026-10-21T10:00:00.000Z");
    assert.equal(parsed.tests.length, 4);
  });

  it("maps statuses: expected and flaky pass, unexpected fails, skipped is skipped", () => {
    assert.equal(byTitle("passes").status, "passed");
    assert.equal(byTitle("fails").status, "failed");
    assert.equal(byTitle("flaky one").status, "passed");
    assert.equal(byTitle("skipped one").status, "skipped");
  });

  it("marks flaky tests and keeps every attempt", () => {
    const t = byTitle("flaky one");
    assert.equal(t.flaky, true);
    assert.equal(t.detail?.attempts.length, 2);
    assert.equal(byTitle("passes").flaky, false);
  });

  it("strips colour codes from errors and makes locations relative to rootDir", () => {
    const t = byTitle("fails");
    assert.equal(t.error, "Expected: 1\nReceived: 2");
    assert.equal(t.detail?.attempts[0].errors[0].location?.file, "login.spec.ts");
  });

  it("keeps the project name, suite path and tags", () => {
    const t = byTitle("passes");
    assert.equal(t.title, "passes [chromium]");
    assert.equal(t.suitePath, "Login");
    assert.deepEqual(t.tags, ["@SHOP-1"]);
  });
});

describe("parseReport: JUnit XML", () => {
  const xml = (suiteName: string, cases: string) => `<?xml version="1.0"?><testsuites><testsuite name="${suiteName}" timestamp="2026-10-21T10:00:00">${cases}</testsuite></testsuites>`;

  it("reads passed, failed and skipped cases with timings", () => {
    const p = parseReport(
      xml(
        "Suite",
        `<testcase name="ok" classname="a.B" time="0.25"/>
         <testcase name="bad" classname="a.B" time="1"><failure message="boom">stack</failure></testcase>
         <testcase name="skip" classname="a.B"><skipped/></testcase>`,
      ),
    );
    assert.deepEqual(p.tests.map((t) => t.status), ["passed", "failed", "skipped"]);
    assert.equal(p.tests[0].durationMs, 250);
    assert.match(p.tests[1].error, /boom/);
    assert.equal(p.startedAt, "2026-10-21T10:00:00");
  });

  it("guesses the framework from the report", () => {
    assert.equal(parseReport(xml("TestCafe Tests", `<testcase name="x" classname="c"/>`)).framework, "testcafe");
    assert.equal(parseReport(xml("s", `<testcase name="Login › works" classname="login.spec.ts"/>`)).framework, "playwright");
    assert.equal(parseReport(xml("s", `<testcase name="x" classname="org.selenium.Tests"/>`)).framework, "selenium");
    assert.equal(parseReport(xml("s", `<testcase name="x" classname="com.acme.Tests"/>`)).framework, "junit");
  });

  it("reads a Bruno CLI report: the request file identifies the test, not the URL", () => {
    // Shape written by `bru run --reporter-junit`: suite name = request file, classname = request URL.
    const bruno = (url: string) => `<?xml version="1.0"?><testsuites>
      <testsuite name="users/get-user" errors="0" failures="1" skipped="0" tests="2" timestamp="2026-10-21T10:00:00" hostname="ci" time="0.120">
        <testcase name="@SHOP-12 returns the user" status="pass" classname="${url}/users/1" time="0.060"/>
        <testcase name="res.status eq 201" status="fail" classname="${url}/users/1" time="0.060"><failure type="failure" message="expected 200 to equal 201"/></testcase>
      </testsuite>
      <testsuite name="users/create-user" errors="1" failures="0" skipped="0" tests="1" timestamp="2026-10-21T10:00:01" hostname="ci" time="0.050">
        <testcase name="Test suite has no errors" status="fail" classname="${url}/users" time="0.050"><error type="error" message="connect ECONNREFUSED 127.0.0.1:3000"/></testcase>
      </testsuite></testsuites>`;
    const a = parseReport(bruno("https://staging.example.com"));
    const b = parseReport(bruno("https://prod.example.com"));
    assert.equal(a.framework, "bruno");
    assert.deepEqual(a.tests.map((t) => t.status), ["passed", "failed", "failed"]);
    assert.equal(a.tests[0].file, "users/get-user");
    assert.equal(a.tests[0].suitePath, "users/get-user");
    assert.equal(a.tests[0].fullName, "users/get-user › @SHOP-12 returns the user");
    assert.match(a.tests[1].error, /expected 200 to equal 201/);
    assert.equal(a.tests[2].title, "Request failed to run");
    assert.match(a.tests[2].error, /ECONNREFUSED/);
    // The same request run against another environment is the same test.
    assert.deepEqual(a.tests.map((t) => t.fullName), b.tests.map((t) => t.fullName));
    assert.deepEqual(extractCaseRefs(a.tests[0].title, a.tests[0].suitePath), ["SHOP-12"]);
  });

  it("rejects XML without test suites", () => {
    assert.throws(() => parseReport("<foo/>"), /No <testsuite>/);
  });
});
