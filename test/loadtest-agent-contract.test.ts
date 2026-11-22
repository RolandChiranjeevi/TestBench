import "./env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import { cleanLoadOptions, cleanLoadResult } from "../server/loadtest.ts";

// The agent's tool (testpilot/tools/loadtest.py) and the server's check of its result (server/loadtest.ts, cleanLoadResult) are written in two languages. This runs the real tool against a
// small server of its own on 127.0.0.1 and gives what it wrote to the server's own check, so that the two cannot drift apart. Nothing here leaves this computer.

const run = promisify(execFile);
const TOOL = join(process.cwd(), "testpilot", "tools", "loadtest.py");
let target: Server;
let base = "";
const work = mkdtempSync(join(tmpdir(), "loadtest-contract-"));

before(async () => {
  target = createServer((req, res) => {
    const bad = (req.url ?? "").startsWith("/bad");
    res.writeHead(bad ? 503 : 200, { "Content-Length": "2" });
    res.end("ok");
  });
  await new Promise<void>((ok) => target.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
});
after(() => {
  target.closeAllConnections();
  target.close();
  rmSync(work, { recursive: true, force: true });
});

async function tool(...args: string[]) {
  await run("python3", ["-I", TOOL, "run", "--request", "7", "--base-url", base, ...args], { cwd: work, timeout: 60_000 });
  return JSON.parse(readFileSync(join(work, "audits", "request-7", "loadtest.json"), "utf8")) as unknown;
}

describe("what the load test tool writes and what the server accepts", () => {
  it("a test that ran to the end is accepted, with the choices that were asked for as the ceiling", async () => {
    const asked = cleanLoadOptions({ vus: 5, durationSeconds: 30, rampUpSeconds: 0, paths: ["/", "/a"] });
    const result = await tool("--path", "/", "--path", "/a", "--vus", "5", "--duration", "3", "--ramp-up", "0");
    const kept = cleanLoadResult(result, asked);
    assert.equal(kept.outcome, "completed");
    assert.equal(kept.verdict, "pass");
    assert.deepEqual(kept.params.paths, ["/", "/a"]);
    assert.ok(kept.totals.requests > 0);
    assert.equal(kept.paths.reduce((n, p) => n + p.requests, 0), kept.totals.requests);
  });

  it("a test that was stopped by the error limit is accepted too: a fail verdict is a result, not an error", async () => {
    const asked = cleanLoadOptions({ vus: 5, durationSeconds: 30, rampUpSeconds: 0, paths: ["/bad"], maxErrorRatePercent: 5 });
    const result = await tool("--path", "/bad", "--vus", "5", "--duration", "20", "--ramp-up", "0", "--max-error-rate", "5");
    const kept = cleanLoadResult(result, asked);
    assert.equal(kept.outcome, "stopped_error_rate");
    assert.equal(kept.verdict, "fail");
    assert.deepEqual(Object.keys(kept.paths[0].statuses), ["503"]);
  });

  it("is refused by the server when it used more than was asked for: the ceiling is checked on both sides", async () => {
    const result = await tool("--path", "/", "--vus", "10", "--duration", "2", "--ramp-up", "0");
    assert.throws(() => cleanLoadResult(result, cleanLoadOptions({ vus: 5, durationSeconds: 30, rampUpSeconds: 0, paths: ["/"] })), /vus must be/);
    assert.throws(() => cleanLoadResult(result, cleanLoadOptions({ vus: 10, durationSeconds: 30, rampUpSeconds: 0, paths: ["/other"] })), /did not ask for/);
  });
});
