import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { SidebarNav, type NavCounts } from "../web/src/components/SidebarNav.tsx";
import { NAV_GROUPS, NAV_SHORTCUTS } from "../web/src/shortcuts.ts";

// The sidebar is built from NAV_SHORTCUTS, so what is checked here is that nothing gets lost on the way: order, keys, sections, the current page and the counts.

const render = (path: string, counts: NavCounts = {}) =>
  renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] }, createElement(SidebarNav, { pid: 7, counts })));
const anchors = (html: string) => html.match(/<a [^>]*>/g) ?? [];

describe("the sidebar", () => {
  it("lists every page in the order of the list, each with its key", () => {
    const html = render("/p/7/dashboard");
    assert.deepEqual(anchors(html).map((a) => /href="([^"]+)"/.exec(a)![1]), NAV_SHORTCUTS.map((s) => `/p/7/${s.to}`));
    assert.deepEqual([...html.matchAll(/<kbd class="kbd">([^<]+)<\/kbd>/g)].map((m) => m[1]), NAV_SHORTCUTS.map((s) => s.key));
    assert.deepEqual([...html.matchAll(/class="nav-label">([^<]+)</g)].map((m) => m[1]), NAV_SHORTCUTS.map((s) => s.label));
  });

  it("has the three sections in order, as a navigation landmark named Pages", () => {
    const html = render("/p/7/dashboard");
    assert.deepEqual([...html.matchAll(/class="sidebar-section">([^<]+)</g)].map((m) => m[1]), NAV_GROUPS.map((g) => g.label));
    assert.match(html, /<nav class="sidebar-nav" aria-label="Pages">/);
  });

  it("marks the page you are on, and only that one, also on a sub-page", () => {
    for (const [path, page] of [["/p/7/runs", "runs"], ["/p/7/settings/data", "settings"], ["/p/7/test-plan", "test-plan"]] as const) {
      const current = anchors(render(path)).filter((a) => a.includes('aria-current="page"'));
      assert.equal(current.length, 1, path);
      assert.ok(current[0].includes(`href="/p/7/${page}"`), `${path}: ${current[0]}`);
      assert.ok(current[0].includes("nav-item active"), path);
    }
  });

  it("shows a number with what it counts, and nothing for zero", () => {
    const html = render("/p/7/dashboard", { observations: { n: 3, meaning: "active" }, bugs: { n: 0, meaning: "waiting for review" }, "manual-tests": { n: 12, meaning: "waiting for review" } });
    assert.match(html, /<span class="nav-count" aria-label="3 active">3<\/span>/);
    assert.match(html, /<span class="nav-count" aria-label="12 waiting for review">12<\/span>/);
    assert.equal((html.match(/class="nav-count"/g) ?? []).length, 2);
    assert.ok(!html.includes('aria-label="0 '));
  });

  it("draws the icons as decoration: the name next to them is what is read", () => {
    const html = render("/p/7/dashboard");
    assert.equal((html.match(/<svg [^>]*aria-hidden="true"/g) ?? []).length, NAV_SHORTCUTS.length);
  });
});
