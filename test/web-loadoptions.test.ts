import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LOAD_OPTIONS, isLocalHost as serverIsLocalHost, LOAD_LIMITS } from "../server/loadtest.ts";
import {
  addressIsLocal, DEFAULT_LOAD, isLocalHost, LOAD_DURATIONS, LOAD_ERROR_RATES, LOAD_P95S, LOAD_PATHS_MAX, LOAD_RAMPS, LOAD_VUS, loadProblem, loadReportMarkdown, loadSummary, OUTCOME, parsePaths, ranSeconds, VERDICT,
  type LoadResult,
} from "../web/src/loadOptions.ts";

// The load test form of the web and the server (server/loadtest.ts) must offer the same choices, so that nothing the form allows is refused for a reason the person cannot see.

const result: LoadResult = {
  version: 1, outcome: "stopped_p95", startedAt: "2026-11-21T10:00:00Z", endedAt: "2026-11-21T10:00:45Z",
  params: { vus: 10, durationSeconds: 60, rampUpSeconds: 10, paths: ["/", "/a|b"] },
  totals: { requests: 900, errors: 9, errorRate: 1, rps: 20, p50Ms: 40.4, p95Ms: 2100, p99Ms: 2500, maxMs: 3000 },
  paths: [{ path: "/a|b", requests: 900, errors: 9, errorRate: 1, p50Ms: 40, p95Ms: 2100, p99Ms: 2500, maxMs: 3000, rps: 20, statuses: { "200": 891, "503": 9 } }],
  timeline: [{ t: 0, vus: 1, requests: 10, errors: 0, p95Ms: 80 }],
  verdict: "fail", verdictReason: "p95 2100 ms\nwent over 2000 ms | stopped",
};

describe("the choices of the load test form and the server", () => {
  it("are the same choices, in the same order, with the same defaults", () => {
    assert.deepEqual([...LOAD_VUS], [...LOAD_LIMITS.vus]);
    assert.deepEqual([...LOAD_DURATIONS], [...LOAD_LIMITS.durationSeconds]);
    assert.deepEqual([...LOAD_RAMPS], [...LOAD_LIMITS.rampUpSeconds]);
    assert.deepEqual([...LOAD_ERROR_RATES], [...LOAD_LIMITS.maxErrorRatePercent]);
    assert.deepEqual([...LOAD_P95S], [...LOAD_LIMITS.maxP95Ms]);
    assert.equal(LOAD_PATHS_MAX, LOAD_LIMITS.pathsMax);
    assert.deepEqual(DEFAULT_LOAD, DEFAULT_LOAD_OPTIONS);
  });

  it("call the same addresses local", () => {
    const hosts = ["localhost", "app.localhost", "build.local", "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "172.32.0.1", "192.168.1.20", "192.169.0.1", "[::1]", "example.com", "8.8.8.8", "999.1.1.1", "localhost.example.com"];
    for (const h of hosts) assert.equal(isLocalHost(h), serverIsLocalHost(h), h);
  });
});

describe("what the form checks before it sends", () => {
  it("says nothing about an address that is not typed yet, and names a public one", () => {
    assert.equal(addressIsLocal(""), null);
    assert.equal(addressIsLocal("local"), null);
    assert.equal(addressIsLocal("http://localhost:3000"), true);
    assert.equal(addressIsLocal("https://staging.example.com"), false);
  });

  it("stops what the server would refuse: no address, a public address, no paths, a bad path, a ramp-up that is too long", () => {
    const ok = { ...DEFAULT_LOAD };
    assert.equal(loadProblem(ok, "http://localhost:3000"), null);
    assert.match(loadProblem(ok, "") ?? "", /Give the address/);
    assert.match(loadProblem(ok, "https://staging.example.com") ?? "", /local or private/);
    assert.match(loadProblem({ ...ok, paths: [] }, "http://localhost:3000") ?? "", /at least one path/);
    assert.match(loadProblem({ ...ok, paths: Array.from({ length: 11 }, (_, i) => `/p${i}`) }, "http://localhost:3000") ?? "", /At most 10/);
    for (const bad of ["x", "//evil.example.com", "/a b", "/a#b", "/a\\b"]) assert.match(loadProblem({ ...ok, paths: [bad] }, "http://localhost:3000") ?? "", /must start with a single/, bad);
    assert.match(loadProblem({ ...ok, durationSeconds: 30, rampUpSeconds: 30 }, "http://localhost:3000") ?? "", /half/);
  });

  it("reads the paths one to a line, without blanks or repeats", () => {
    assert.deepEqual(parsePaths(" /\n\n/api/health \n/\n"), ["/", "/api/health"]);
    assert.deepEqual(parsePaths(""), []);
  });

  it("says the choices on one line", () => {
    assert.equal(loadSummary(DEFAULT_LOAD), "10 users · 60 s (ramp-up 10 s) · 1 path · stop at 5 % errors");
    assert.equal(loadSummary({ ...DEFAULT_LOAD, vus: 50, paths: ["/", "/b"], maxP95Ms: 2000 }), "50 users · 60 s (ramp-up 10 s) · 2 paths · stop at 5 % errors or p95 2000 ms");
  });
});

describe("the report", () => {
  it("has a word and a tone for every verdict and outcome the server accepts", () => {
    for (const v of ["pass", "warning", "fail"] as const) assert.ok(VERDICT[v].label);
    for (const o of ["completed", "stopped_error_rate", "stopped_p95", "stopped_by_agent"] as const) assert.ok(OUTCOME[o]);
  });

  it("counts the seconds that ran from the timestamps, and 0 when they cannot be read", () => {
    assert.equal(ranSeconds(result), 45);
    assert.equal(ranSeconds({ startedAt: "x", endedAt: "y" }), 0);
    assert.equal(ranSeconds({ startedAt: "2026-11-21T10:00:45Z", endedAt: "2026-11-21T10:00:00Z" }), 0);
  });

  it("becomes Markdown that cannot break its own table: a | or a line break from the agent stays inside its cell or line", () => {
    const md = loadReportMarkdown({ id: 7, name: "Login | flow", targetUrl: "http://localhost:3000/", environment: "local" }, result);
    assert.match(md, /^# Load test, request #7 · Login \\\| flow/);
    assert.match(md, /\*\*Fail\*\*: p95 2100 ms went over 2000 ms \\\| stopped/);
    assert.match(md, /Stopped: too slow \(p95\), ran 45 s of 60 s/);
    assert.match(md, /\| \/a\\\|b \| 900 \| 1 % \| 40 ms \| 2100 ms \| 2500 ms \| 20 \|/);
    assert.equal(md.split("\n").filter((l) => l.startsWith("| /a")).length, 1);
  });
});
