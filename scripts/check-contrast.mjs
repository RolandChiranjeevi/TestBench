#!/usr/bin/env node
// Checks text contrast on the real pages, in both colour themes, with a real browser (WCAG AA: 4.5:1, or 3:1 for large text).
// It measures what is actually on screen (computed colours over the real background), so it catches a weak colour wherever it is used.
//
// Usage:  node scripts/check-contrast.mjs <baseUrl>        e.g. http://127.0.0.1:4100
// Point it at a THROWAWAY instance: the address is required on purpose, and with CONTRAST_SEED=1 it creates the demo project in an
// empty instance. It only reads otherwise. Needs Chrome: TESTBENCH_CHROME_PATH or TESTBENCH_CHROME_CHANNEL (default "chrome") pick it.
import { baseUrlFromArgs, discoverPages, launchBrowser } from "./lib/pages.mjs";

const BASE = baseUrlFromArgs("check-contrast.mjs");
const PAGES = await discoverPages(BASE);

// Runs inside the page. Returns the text elements that fall short.
function auditPage() {
  const parse = (c) => {
    let m = c.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    m = c.match(/^color\(srgb ([^)]+)\)$/); // what the browser returns for color-mix()
    if (m) {
      const p = m[1].split(/[ /]+/).filter(Boolean).map(parseFloat);
      return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 };
    }
    return null;
  };
  const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const page = (() => {
    const b = parse(getComputedStyle(document.body).backgroundColor);
    return b && b.a > 0 ? over(b, { r: 255, g: 255, b: 255, a: 1 }) : { r: 255, g: 255, b: 255, a: 1 };
  })();

  /** The colour behind an element, or null when it sits on an image or gradient (cannot be measured). */
  const backdrop = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== "none") return null;
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 1) break;
      }
    }
    return layers.reverse().reduce((acc, l) => over(l, acc), page);
  };
  const opacityOf = (el) => {
    let o = 1;
    for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
    return o;
  };

  const fails = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent.trim();
    const el = node.parentElement;
    if (!text || !el || seen.has(el)) continue;
    if (el.closest("iframe,script,style,noscript,option,[disabled],[aria-disabled='true'],[data-contrast-ignore]")) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height || cs.visibility === "hidden" || cs.display === "none") continue;
    const opacity = opacityOf(el);
    if (opacity === 0) continue;
    const bg = backdrop(el);
    if (!bg) continue;
    const raw = parse(el instanceof SVGElement ? cs.fill : cs.color);
    if (!raw) continue;
    const fg = over({ ...raw, a: raw.a * opacity }, bg);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && parseInt(cs.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    const r = ratio(fg, bg);
    if (r < need - 0.005) {
      fails.push({
        ratio: +r.toFixed(2),
        need,
        size,
        text: text.slice(0, 32),
        where: `${el.tagName.toLowerCase()}${typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/)[0] : ""}`,
        colors: `rgb(${Math.round(fg.r)},${Math.round(fg.g)},${Math.round(fg.b)}) on rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`,
      });
    }
  }
  return fails;
}

const browser = await launchBrowser();

const groups = new Map();
let checked = 0;
for (const scheme of ["dark", "light"]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  const page = await ctx.newPage();
  for (const [name, path] of PAGES) {
    await page.goto(BASE + path, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    for (const f of await page.evaluate(auditPage)) {
      const key = `${scheme}|${f.colors}|${f.size}|${f.where}`;
      const g = groups.get(key) ?? { ...f, scheme, pages: new Set(), n: 0 };
      g.pages.add(name);
      g.n++;
      groups.set(key, g);
    }
    checked++;
  }
  await ctx.close();
}
await browser.close();

const list = [...groups.values()].sort((a, b) => a.ratio - b.ratio || b.n - a.n);
if (!list.length) {
  console.log(`Contrast OK: ${checked} page views (${PAGES.length} pages, dark and light) meet WCAG AA.`);
  process.exit(0);
}
console.log(`Contrast problems: ${list.length} distinct, in ${checked} page views (needs 4.5:1, or 3:1 for large text)\n`);
for (const g of list.slice(0, 60)) {
  console.log(`[${g.scheme}] ${g.ratio}:1 (needs ${g.need})  ${g.size}px  ${g.where}  "${g.text}"  ${g.colors}  x${g.n}  on: ${[...g.pages].join(", ")}`);
}
if (list.length > 60) console.log(`... and ${list.length - 60} more`);
process.exit(1);
