import "./env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

// The access table must also be complete for the app as a production build runs it: with NODE_ENV=production and the web app in dist/, the server registers routes that the
// other tests never see (the built web files). This starts that app in a child process, in a temporary folder with a stub dist/, and requires it to come up. Nothing
// listens (TESTBENCH_NO_LISTEN=1), so there is no port and no network.
const repo = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "tb-production-"));
after(() => rmSync(work, { recursive: true, force: true }));

function start(env: Record<string, string>) {
  mkdirSync(join(work, "dist"), { recursive: true });
  writeFileSync(join(work, "dist", "index.html"), "<!doctype html><title>stub</title>");
  // The server looks for dist/ and for Playwright's trace viewer (node_modules/playwright-core) in the folder it runs in, as it does in the repo or in the image.
  try { symlinkSync(join(repo, "node_modules"), join(work, "node_modules")); } catch { /* already there from the first start */ }
  const r = spawnSync(join(repo, "node_modules", ".bin", "tsx"), [join(repo, "test", "access-production.script.mts")], {
    cwd: work, encoding: "utf8", timeout: 60_000,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TESTBENCH_DATA: join(work, "data"), TESTBENCH_AUTO_BACKUP: "0", TESTBENCH_NO_LISTEN: "1", ...env },
  });
  return { status: r.status, out: r.stdout.trim().split("\n").pop() ?? "", err: r.stderr };
}

describe("the app as a production build starts it", () => {
  it("comes up with every route decided, including the built web files", () => {
    const r = start({ NODE_ENV: "production" });
    assert.equal(r.status, 0, `the production start failed:\n${r.err.slice(0, 600)}`);
    assert.deepEqual(JSON.parse(r.out), { ready: true, staticRoute: true, problems: { missing: [], stale: [] } });
  });

  it("without a production build the web files are not served by the app, so that route does not exist there (and is not a stale line)", () => {
    const r = start({ NODE_ENV: "development" });
    assert.equal(r.status, 0, r.err.slice(0, 600));
    assert.deepEqual(JSON.parse(r.out), { ready: true, staticRoute: false, problems: { missing: [], stale: [] } });
  });
});
