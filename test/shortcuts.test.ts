import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { NAV_SHORTCUTS, PAGE_SHORTCUTS } from "../web/src/shortcuts.ts";
import { claimKeys, isClaimed } from "../web/src/hotkeys.ts";

// The keys that switch pages (one list, shortcuts.ts), the order of the sidebar (main.tsx) and the keys that pages use themselves (hotkeys.ts).

const MAIN = readFileSync(join(import.meta.dirname, "..", "web", "src", "main.tsx"), "utf8");
const sidebar = MAIN.slice(MAIN.indexOf('<div className="sidebar-section">Workspace</div>'), MAIN.indexOf('<div className="sidebar-footer">'));

describe("the shortcuts that switch pages", () => {
  it("each key and each page appears once", () => {
    const keys = NAV_SHORTCUTS.map((s) => s.key);
    const pages = NAV_SHORTCUTS.map((s) => s.to);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(new Set(pages).size, pages.length);
  });

  it("the digits 0 to 9 are all used, in order, and come first; the pages under Manage have letters", () => {
    assert.deepEqual(NAV_SHORTCUTS.slice(0, 10).map((s) => s.key), ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    assert.deepEqual(NAV_SHORTCUTS.slice(10).map((s) => [s.key, s.to]), [["s", "settings"], ["i", "import"]]);
  });

  it("the sidebar lists the pages in the same order, with the digits 0 to 8 under Workspace, 9 under Reporting and the letters under Manage", () => {
    const order = [...sidebar.matchAll(/\{link\("([a-z-]+)"/g)].map((m) => m[1]);
    assert.deepEqual(order, NAV_SHORTCUTS.map((s) => s.to));
    const at = (s: string) => sidebar.indexOf(s);
    assert.ok(at('link("runs"') < at(">Reporting<") && at(">Reporting<") < at('link("reports"'));
    assert.ok(at('link("reports"') < at(">Manage<") && at(">Manage<") < at('link("settings"') && at('link("settings"') < at('link("import"'));
  });

  it("a key that a page also uses is a decision, not an accident: only s (Skipped on a run, Settings elsewhere) is shared", () => {
    const pageKeys = new Set(PAGE_SHORTCUTS.flatMap(([, rows]) => rows.flatMap(([k]) => k.split(" / ").map((x) => x.trim()))));
    const shared = NAV_SHORTCUTS.map((s) => s.key as string).filter((k) => pageKeys.has(k));
    assert.deepEqual(shared, ["s"]);
  });
});

describe("keys that a page has taken", () => {
  it("are claimed while the page is shown and given back when it goes", () => {
    assert.equal(isClaimed("s"), false);
    const release = claimKeys(["s", "p"]);
    assert.deepEqual([isClaimed("s"), isClaimed("p"), isClaimed("i")], [true, true, false]);
    release();
    assert.deepEqual([isClaimed("s"), isClaimed("p")], [false, false]);
  });

  it("two pages can take the same key; it is free only when both have gone, and giving back twice does nothing", () => {
    const a = claimKeys(["c"]);
    const b = claimKeys(["c"]);
    a();
    a();
    assert.equal(isClaimed("c"), true);
    b();
    assert.equal(isClaimed("c"), false);
  });
});
