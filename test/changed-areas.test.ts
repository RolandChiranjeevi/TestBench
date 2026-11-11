import "./env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";

// Contrast and layout are opt-in: they run when something visual changed. This is the rule CI and a person both use, so it is tested as it is used: as a program that is given paths.

const script = join(import.meta.dirname, "..", "scripts", "changed-areas.mjs");
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: join(import.meta.dirname, "..") });
  return { status: r.status, out: r.stdout.trim().split("\n"), err: r.stderr };
};
const areas = (...files: string[]) => run("--files", ...files).out;

describe("which browser checks a change needs", () => {
  it("docs, tests and other files need neither contrast and layout nor the roles script", () => {
    assert.deepEqual(areas("docs/audit-package.md", "README.md", "backlog.md", "vision.md", "test/plan-edit.test.ts", "Dockerfile", ".gitignore"), ["visual=false", "flows=false"]);
    assert.deepEqual(areas(), ["visual=false", "flows=false"], "no change at all");
  });

  it("a change to what the pages look like needs contrast and layout, and the roles script", () => {
    for (const f of ["web/src/styles.css", "web/src/pages/TestPlan.tsx", "web/index.html", "scripts/check-contrast.mjs", "scripts/check-layout.mjs", "scripts/lib/pages.mjs", "vite.config.ts", "package.json", "package-lock.json"]) {
      assert.deepEqual(areas("docs/x.md", f), ["visual=true", "flows=true"], f);
    }
  });

  it("a change to the server or to the roles script needs the roles script only", () => {
    for (const f of ["server/index.ts", "server/db.ts", "scripts/check-roles-ui.mjs"]) assert.deepEqual(areas("docs/x.md", f), ["visual=false", "flows=true"], f);
  });

  it("a change to the workflow or to this rule runs everything, so a mistake in them is seen", () => {
    for (const f of [".github/workflows/ci.yml", "scripts/changed-areas.mjs"]) assert.deepEqual(areas(f), ["visual=true", "flows=true"], f);
  });

  it("the reason is said: the first path that made each check run", () => {
    const r = run("--files", "docs/x.md", "server/index.ts", "web/src/styles.css");
    assert.match(r.err, /Contrast and layout: run \(web\/src\/styles\.css\)\. Roles script: run \(server\/index\.ts\)\./);
    assert.match(run("--files", "docs/x.md", "server/index.ts").err, /Contrast and layout: skipped, nothing visual changed\. Roles script: run \(server\/index\.ts\)\./);
    assert.match(run("--files", "docs/x.md").err, /skipped, nothing visual changed.*skipped, no screen or server change/);
  });

  it("when it cannot tell what changed it runs everything", () => {
    const r = run("no-such-ref-for-this-test");
    assert.deepEqual([r.status, r.out], [0, ["visual=true", "flows=true"]]);
    assert.match(r.err, /Cannot tell what changed since no-such-ref-for-this-test: running every check/);
  });

  it("without a base or paths it is a usage error, not a silent skip", () => {
    const r = run();
    assert.equal(r.status, 2);
    assert.match(r.err, /Usage:/);
    assert.deepEqual(r.out, [""], "and prints no answer that could be taken for one");
  });
});
