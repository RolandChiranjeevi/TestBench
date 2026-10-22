#!/usr/bin/env node
// Checks the layout at laptop, tablet and phone widths with a real browser. It fails when a page
//  - scrolls sideways,
//  - squeezes the case or requirement list below a readable width,
//  - has top-bar items that overlap each other,
//  - pushes a control off the screen (outside anything that scrolls on purpose),
//  - or leaves no way to open the navigation on a phone.
//
// Usage:  node scripts/check-layout.mjs <baseUrl>        (a THROWAWAY instance; CHECK_SEED=1 fills an empty one with the demo project)
import { baseUrlFromArgs, discoverPages, launchBrowser } from "./lib/pages.mjs";

const BASE = baseUrlFromArgs("check-layout.mjs");
const PAGES = await discoverPages(BASE);
const WIDTHS = [1440, 1100, 1024, 820, 600, 390];
const HEIGHT = 900;

/** Widths where the sidebar is the full 232px, the 56px icon rail, or hidden behind a menu button. */
const sidebarFor = (w) => (w >= 1100 ? 232 : w >= 700 ? 56 : 0);

// Runs inside the page.
function inspect({ width, sidebar, minList }) {
  const problems = [];
  const vw = innerWidth;
  const rect = (el) => el.getBoundingClientRect();
  const visible = (el) => {
    const cs = getComputedStyle(el);
    const r = rect(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
  };

  // 1. The page itself must not scroll sideways.
  const doc = document.documentElement;
  if (doc.scrollWidth > vw + 1) problems.push(`the page scrolls sideways (${doc.scrollWidth}px of content in a ${vw}px window)`);

  // 2. The sidebar takes the expected room, and the content gets the rest.
  const main = document.querySelector(".main");
  if (main) {
    const left = rect(main).left;
    if (left > sidebar + 2) problems.push(`the content starts ${Math.round(left)}px from the left; the sidebar should take at most ${sidebar}px at this width`);
  }
  const navItems = [...document.querySelectorAll(".sidebar .nav-item")].filter(visible);
  if (width < 700) {
    const menu = [...document.querySelectorAll("button")].find((b) => /open (the )?(menu|navigation)/i.test(b.getAttribute("aria-label") ?? "") && visible(b));
    if (!menu) problems.push("there is no visible button to open the navigation on a phone-sized screen");
  } else if (navItems.length < 6) {
    problems.push(`only ${navItems.length} navigation items are visible at this width`);
  }

  // 3. Master-detail pages: the list must stay readable, and the editor must fit the screen.
  const list = document.querySelector(".split > .pane.grow");
  if (list && visible(list)) {
    const w = rect(list).width;
    if (w < minList) problems.push(`the list is only ${Math.round(w)}px wide (needs ${minList}px)`);
  }
  const detail = document.querySelector(".detail-pane");
  if (detail && visible(detail)) {
    const r = rect(detail);
    if (r.left < -1 || r.right > vw + 1) problems.push(`the editor panel does not fit the screen (${Math.round(r.left)}px to ${Math.round(r.right)}px in a ${vw}px window)`);
  }

  // 3b. A side list that is squeezed into a small panel must still show its first row (the sprint list and the run's case list).
  for (const sel of [".reports-list", ".run-list"]) {
    const panel = document.querySelector(sel);
    const row = panel && visible(panel) ? panel.querySelector(".list-row") : null;
    if (row) {
      // A hit test, because a row can be clipped away by its container while its position still looks fine.
      const r = rect(row);
      const hit = r.top >= 0 && r.top < innerHeight ? document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 12)) : null;
      if (r.height < 20 || !hit || !row.contains(hit)) problems.push(`the first row of the ${sel.slice(1)} panel is cut off, so nothing can be picked from it`);
    }
  }

  // 4. Top-bar and toolbar items must not overlap each other.
  for (const bar of document.querySelectorAll(".topbar, .toolbar")) {
    const kids = [...bar.children].filter(visible);
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = rect(kids[i]);
        const b = rect(kids[j]);
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapX > 3 && overlapY > 3) {
          const name = (el) => (el.textContent || el.getAttribute("aria-label") || el.className || el.tagName).toString().trim().slice(0, 18);
          problems.push(`in the ${bar.className.split(" ")[0]}: "${name(kids[i])}" overlaps "${name(kids[j])}"`);
        }
      }
    }
  }

  // 5. Controls must not sit outside the screen, unless they are inside something that scrolls on purpose.
  const inScroller = (el) => {
    for (let e = el.parentElement; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && e.scrollWidth > e.clientWidth + 1) return true;
    }
    return false;
  };
  const off = [];
  for (const el of document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea")) {
    if (!visible(el) || el.closest("iframe")) continue;
    const r = rect(el);
    if ((r.right > vw + 1 || r.left < -1) && !inScroller(el)) off.push((el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 22));
  }
  if (off.length) problems.push(`${off.length} control(s) are pushed off the screen, e.g. ${[...new Set(off)].slice(0, 3).map((s) => `"${s}"`).join(", ")}`);

  return problems;
}

const browser = await launchBrowser();
const failures = [];
let views = 0;
for (const width of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width, height: HEIGHT }, colorScheme: "dark" });
  const page = await ctx.newPage();
  for (const [name, path] of PAGES) {
    await page.goto(BASE + path, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const problems = await page.evaluate(inspect, { width, sidebar: sidebarFor(width), minList: 300 });
    views++;
    for (const p of problems) failures.push({ width, name, p });
  }
  await ctx.close();
}
await browser.close();

if (!failures.length) {
  console.log(`Layout OK: ${views} page views (${PAGES.length} pages at ${WIDTHS.join(", ")}px).`);
  process.exit(0);
}
console.log(`Layout problems: ${failures.length}, in ${views} page views\n`);
for (const f of failures.slice(0, 80)) console.log(`[${f.width}px] ${f.name}: ${f.p}`);
if (failures.length > 80) console.log(`... and ${failures.length - 80} more`);
process.exit(1);
