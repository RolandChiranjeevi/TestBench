import "./env.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// The Host check (server/index.ts): the app only answers to host names it has been told about, so that a web page cannot reach it through
// another name (DNS rebinding) and a public address that points at it is refused until it is listed in TESTBENCH_ALLOWED_HOSTS.
// Two real servers: one with the variable set, one without.

const ROOT = join(import.meta.dirname, "..");
const FUNNEL = "mcattck.tail52218b.ts.net";
const servers: ChildProcess[] = [];

function start(port: number, allowedHosts?: string) {
  const env = { ...process.env, TESTBENCH_DATA: mkdtempSync(join(tmpdir(), "tb-hosts-")), TESTBENCH_PORT: String(port), NODE_ENV: "production", TESTBENCH_AUTO_BACKUP: "1" } as NodeJS.ProcessEnv;
  if (allowedHosts === undefined) delete env.TESTBENCH_ALLOWED_HOSTS;
  else env.TESTBENCH_ALLOWED_HOSTS = allowedHosts;
  const child = spawn(process.execPath, ["--import", "tsx", join(ROOT, "server", "index.ts")], { cwd: ROOT, env, stdio: "ignore" });
  servers.push(child);
  return child;
}

/** A request with an exact Host header (fetch does not allow setting one). */
function get(port: number, host: string, path = "/api/auth/status", method = "GET") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host, "content-type": "application/json", "x-testbench": "1" } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

async function ready(port: number) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await get(port, "127.0.0.1")).status === 200) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server on ${port} did not start`);
}

const WITH = 43000 + Math.floor(Math.random() * 900);
const WITHOUT = WITH + 1;

before(async () => {
  // Spaces, a different case, an empty entry and a wildcard on purpose: only exact names count.
  start(WITH, ` ${FUNNEL}, Other.Example.com ,, *.ts.net `);
  start(WITHOUT);
  await Promise.all([ready(WITH), ready(WITHOUT)]);
});
after(() => servers.forEach((s) => s.kill()));

describe("TESTBENCH_ALLOWED_HOSTS", () => {
  it("lets the listed host names in, whatever their case or port, and trims the list", async () => {
    for (const host of [FUNNEL, `${FUNNEL}:443`, FUNNEL.toUpperCase(), "other.example.com", "OTHER.example.com:8443"]) {
      assert.equal((await get(WITH, host)).status, 200, host);
    }
  });

  it("keeps localhost, 127.0.0.1 and ::1 allowed, with or without the variable", async () => {
    for (const port of [WITH, WITHOUT]) {
      for (const host of ["localhost", `localhost:${port}`, "127.0.0.1", `127.0.0.1:${port}`, `[::1]:${port}`]) {
        assert.equal((await get(port, host)).status, 200, `${host} on ${port}`);
      }
    }
  });

  it("still refuses every other host name with 403 Forbidden host", async () => {
    for (const host of ["evil.example.com", `${FUNNEL}.evil.com`, `evil-${FUNNEL}`, `x.${FUNNEL}`, "tail52218b.ts.net", "ts.net", "192.168.1.20", "10.0.0.5:4100"]) {
      const r = await get(WITH, host);
      assert.equal(r.status, 403, host);
      assert.equal(JSON.parse(r.body).error, "Forbidden host");
    }
  });

  it("treats a wildcard entry as nothing: another .ts.net name is refused", async () => {
    assert.equal((await get(WITH, "someone-else.tail00000.ts.net")).status, 403);
  });

  it("without the variable the public name is refused, on every route and method", async () => {
    for (const [path, method] of [["/", "GET"], ["/api/projects", "GET"], ["/api/auth/status", "GET"], ["/api/projects/1/ci/test-results", "POST"]] as const) {
      const r = await get(WITHOUT, FUNNEL, path, method);
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(JSON.parse(r.body).error, "Forbidden host");
    }
  });

  it("the host check comes before the token: an allowed name still needs the API token on the CI route", async () => {
    assert.equal((await get(WITH, FUNNEL, "/api/projects/1/ci/test-results", "POST")).status, 401);
    assert.equal((await get(WITH, "evil.example.com", "/api/projects/1/ci/test-results", "POST")).status, 403);
  });
});
