import type { MilestoneReport, Totals } from "./stats.ts";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const COLORS = { passed: "#1a9e5f", failed: "#d9363e", blocked: "#e08a1e", skipped: "#8a8f98", untested: "#d3d6db" };

function fmtDate(s: string | null | undefined): string {
  if (!s) return "";
  // SQLite datetimes are UTC without a zone marker; plain dates (YYYY-MM-DD) are kept as-is.
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + "T00:00:00" : /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const pct = (n: number | null) => (n == null ? "–" : `${Number.isInteger(n) ? n : n.toFixed(1)}%`);

function delta(cur: number | null, prev: number | null): string {
  if (cur == null || prev == null) return "";
  const d = Math.round((cur - prev) * 10) / 10;
  if (d === 0) return `<span class="delta flat">no change</span>`;
  return `<span class="delta ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${Math.abs(d)} pts</span>`;
}

function bar(t: Pick<Totals, "total" | "passed" | "failed" | "blocked" | "skipped" | "untested">, height = 10): string {
  const total = t.total || 1;
  const seg = (k: keyof typeof COLORS) => (t[k] ? `<span style="width:${(t[k] / total) * 100}%;background:${COLORS[k]}"></span>` : "");
  return `<div class="bar" style="height:${height}px">${seg("passed")}${seg("failed")}${seg("blocked")}${seg("skipped")}${seg("untested")}</div>`;
}

function legend(t: Totals): string {
  return (["passed", "failed", "blocked", "skipped", "untested"] as const)
    .filter((k) => t[k])
    .map((k) => `<span class="lg"><i style="background:${COLORS[k]}"></i>${t[k]} ${k}</span>`)
    .join("");
}

export function headline(r: MilestoneReport): string {
  const c = r.totals.combined;
  const executed = c.passed + c.failed + c.blocked;
  const name = r.milestone.name;
  if (!executed) return `No tests have been executed in ${name} yet.`;
  let first = `${pct(r.totals.rate)} of ${executed} executed tests passed in ${name}`;
  if (r.previous?.rate != null && r.totals.rate != null) {
    const d = Math.round((r.totals.rate - r.previous.rate) * 10) / 10;
    first += d === 0 ? ` (unchanged from ${r.previous.name})` : ` (${d > 0 ? "+" : "−"}${Math.abs(d)} pts vs ${r.previous.name})`;
  }
  const open = r.manualFailures.length + r.automatedFailures.length;
  const tail: string[] = [];
  tail.push(open ? `${open} ${open === 1 ? "failure remains" : "failures remain"} open` : "no open failures");
  if (r.flaky.length) tail.push(`${r.flaky.length} flaky ${r.flaky.length === 1 ? "test" : "tests"}`);
  if (c.untested) tail.push(`${c.untested} not yet executed`);
  if (r.openManualRuns) tail.push(`${r.openManualRuns} manual ${r.openManualRuns === 1 ? "run" : "runs"} still in progress`);
  return `${first}; ${tail.join(", ")}.`;
}

const PRIORITY_LABEL: Record<string, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

/** Show a linked issue as its key, whether a key or a full URL was pasted. */
const jiraLabel = (v: string) => v.match(/[A-Za-z][A-Za-z0-9_]*-\d+/g)?.at(-1)?.toUpperCase() ?? v;

export function renderReport(r: MilestoneReport): string {
  const key = r.project.key;
  const m = r.milestone;
  const c = r.totals.combined;
  const range =
    m.start_date || m.end_date
      ? `${fmtDate(m.start_date)}${m.end_date ? ` – ${fmtDate(m.end_date)}` : ""}`
      : m.firstRun
        ? `${fmtDate(m.firstRun)}${m.lastRun && fmtDate(m.lastRun) !== fmtDate(m.firstRun) ? ` – ${fmtDate(m.lastRun)}` : ""}`
        : "";

  const tile = (label: string, value: string, sub = "") =>
    `<div class="tile"><div class="tl">${esc(label)}</div><div class="tv">${value}</div>${sub ? `<div class="ts">${sub}</div>` : ""}</div>`;

  const manual = r.totals.manual;
  const auto = r.totals.automated;
  const openFailures = r.manualFailures.length + r.automatedFailures.length;

  const compareRow = (label: string, cur: Totals, curRate: number | null, prev: Totals | undefined, prevRate: number | null | undefined) => `
    <tr><td>${label}</td>
      <td class="num">${cur.total}</td><td class="num">${pct(curRate)}</td>
      <td class="num">${prev ? prev.total : "–"}</td><td class="num">${prev ? pct(prevRate ?? null) : "–"}</td>
      <td>${prev ? delta(curRate, prevRate ?? null) : ""}</td></tr>`;

  const comparison = r.previous
    ? `<h2>Compared with ${esc(r.previous.name)}</h2>
       <table class="t"><thead><tr><th></th><th class="num">Tests</th><th class="num">Pass rate</th><th class="num">Prev. tests</th><th class="num">Prev. rate</th><th>Change</th></tr></thead><tbody>
        ${compareRow("Manual", manual, r.totals.manualRate, r.previous.manual, r.previous.manualRate)}
        ${compareRow("Automated", auto, r.totals.automatedRate, r.previous.automated, r.previous.automatedRate)}
        ${compareRow("<strong>Overall</strong>", c, r.totals.rate, r.previous.combined, r.previous.rate)}
       </tbody></table>`
    : "";

  const suites = r.suites.length
    ? `<h2>Manual results by area</h2>
       <table class="t"><thead><tr><th>Suite</th><th style="width:34%"></th><th class="num">Passed</th><th class="num">Failed</th><th class="num">Other</th><th class="num">Rate</th></tr></thead><tbody>
       ${r.suites
         .map((s) => `<tr><td>${esc(s.name)}</td><td>${bar(s, 8)}</td><td class="num">${s.passed}</td><td class="num ${s.failed ? "bad" : ""}">${s.failed}</td><td class="num">${s.blocked + s.skipped + s.untested}</td><td class="num">${pct(s.rate)}</td></tr>`)
         .join("")}
       </tbody></table>`
    : "";

  const manualFailures = r.manualFailures.length
    ? `<h3>Manual test cases (${r.manualFailures.length})</h3>` +
      r.manualFailures
        .map(
          (f) => `<div class="fail">
            <div class="fh"><span class="id">${esc(key)}-${esc(f.number ?? "?")}</span><span class="ft">${esc(f.title)}</span>
              <span class="badge ${esc(f.status)}">${esc(f.status)}</span>${f.jira ? `<span class="jira">${esc(jiraLabel(f.jira))}</span>` : ""}<span class="pri">${esc(PRIORITY_LABEL[f.priority] ?? f.priority)}</span></div>
            ${f.suite ? `<div class="fm">${esc(f.suite)}</div>` : ""}
            ${f.steps.map((s) => `<div class="fs"><strong>Step ${s.number || "?"}:</strong> ${esc(s.action)}${s.expected ? `<br><span class="mut">Expected:</span> ${esc(s.expected)}` : ""}${s.actual ? `<br><span class="mut">Actual:</span> ${esc(s.actual)}` : ""}</div>`).join("")}
            ${f.notes ? `<div class="fs"><span class="mut">Notes:</span> ${esc(f.notes)}</div>` : ""}
          </div>`,
        )
        .join("")
    : "";

  const autoFailures = r.automatedFailures.length
    ? `<h3>Automated tests (${r.automatedFailures.length})</h3>` +
      r.automatedFailures
        .map(
          (f) => `<div class="fail">
            <div class="fh">${f.caseNumber ? `<span class="id">${esc(key)}-${esc(f.caseNumber)}</span>` : ""}<span class="ft">${esc(f.title)}</span>
              <span class="badge failed">failed</span>${f.framework ? `<span class="pri">${esc(f.framework)}</span>` : ""}</div>
            ${f.file ? `<div class="fm mono">${esc(f.file)}</div>` : ""}
            ${f.error ? `<pre>${esc(f.error)}</pre>` : ""}
          </div>`,
        )
        .join("")
    : "";

  const failures = openFailures
    ? `<h2>Open failures</h2>${manualFailures}${autoFailures}`
    : `<h2>Open failures</h2><p class="mut">No failing tests in the latest results.</p>`;

  const flaky = r.flaky.length
    ? `<h2>Flaky tests</h2><p class="mut">Passed only after a retry. These pass in the totals above but are unreliable.</p>
       <table class="t"><tbody>${r.flaky.map((f) => `<tr><td>${esc(f.title)}<div class="mut mono">${esc(f.file)}</div></td><td class="num">${f.count}× flaky</td></tr>`).join("")}</tbody></table>`
    : "";

  const runs = r.runs.length
    ? `<h2>Runs included</h2><table class="t"><thead><tr><th>Run</th><th>Type</th><th>Date</th><th class="num">Tests</th><th class="num">Passed</th><th class="num">Failed</th><th class="num">Rate</th></tr></thead><tbody>
       ${r.runs.map((x) => `<tr><td>${esc(x.title)}${x.environment ? `<div class="mut">${esc(x.environment)}</div>` : ""}</td><td>${x.kind === "manual" ? "Manual" : esc(x.framework ?? "Automated")}</td><td>${fmtDate(x.started_at)}</td><td class="num">${x.total}</td><td class="num">${x.passed}</td><td class="num ${x.failed ? "bad" : ""}">${x.failed}</td><td class="num">${pct(x.rate)}</td></tr>`).join("")}
       </tbody></table>`
    : "";

  const reqs = r.requirements;
  const REQ_LABEL: Record<string, string> = { failing: "Failing", partial: "Partly tested", untested: "Not run" };
  const REQ_BADGE: Record<string, string> = { failing: "failed", partial: "blocked", untested: "untested" };
  const requirementsSection = reqs.total
    ? `<h2>Requirements</h2>
       <p class="mut">${reqs.total} ${reqs.total === 1 ? "requirement" : "requirements"}: ${[
         `${reqs.byState.passing} passing`,
         `${reqs.byState.failing} failing`,
         ...(reqs.byState.partial ? [`${reqs.byState.partial} partly tested`] : []),
         ...(reqs.byState.untested ? [`${reqs.byState.untested} not run in this ${m.kind}`] : []),
         ...(reqs.byState.uncovered ? [`${reqs.byState.uncovered} without test cases`] : []),
       ].join(" · ")}.</p>
       ${
         reqs.attention.length
           ? `<table class="t"><tbody>${reqs.attention
               .map(
                 (q) => `<tr><td style="width:70px" class="mono">REQ-${q.number}</td>
                   <td>${esc(q.title)}<div class="mut">${
                     q.state === "failing"
                       ? `Failing: ${q.failingCases.map((c) => `${esc(key)}-${c.number} ${esc(c.title)}`).join(", ")}`
                       : q.state === "partial"
                         ? `${q.passing} of ${q.cases} test cases passed; the rest weren't run`
                         : `${q.cases} linked ${q.cases === 1 ? "test case" : "test cases"}, none run in this ${esc(m.kind)}`
                   }</div></td>
                   <td class="num"><span class="badge ${REQ_BADGE[q.state]}">${REQ_LABEL[q.state]}</span></td></tr>`,
               )
               .join("")}</tbody></table>`
           : `<p class="mut">Every requirement with test cases passed.</p>`
       }`
    : "";

  const cl = r.checklist;
  const checklistSection = cl.total
    ? `<h2>Release checklist</h2>
       <p class="mut">${cl.done} of ${cl.total} tasks done${cl.done === cl.total ? " – everything is complete" : ""}.</p>
       <table class="t"><tbody>${cl.items
         .map((i) => `<tr><td style="width:24px">${i.doneAt ? "&#10003;" : "&#9744;"}</td><td>${esc(i.title)}</td><td class="num mut">${i.doneAt ? `Done ${fmtDate(i.doneAt)}` : "Open"}</td></tr>`)
         .join("")}</tbody></table>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(r.project.name)} – ${esc(m.name)} test report</title>
<style>
  @page { size: A4; margin: 16mm 14mm 18mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #1d2027; font: 10.5pt/1.45 -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; background: #fff; }
  .wrap { max-width: 820px; margin: 0 auto; padding: 24px; }
  @media print { .wrap { max-width: none; padding: 0; } }
  .mono { font-family: ui-monospace, Menlo, monospace; font-size: 8.5pt; }
  .mut { color: #6b707a; }
  header { border-bottom: 2px solid #1d2027; padding-bottom: 10px; margin-bottom: 18px; }
  .eyebrow { text-transform: uppercase; letter-spacing: .08em; font-size: 8.5pt; color: #6b707a; font-weight: 600; }
  h1 { margin: 2px 0 2px; font-size: 22pt; letter-spacing: -0.02em; }
  .sub { color: #4a4f59; }
  h2 { font-size: 13pt; margin: 26px 0 8px; letter-spacing: -0.01em; break-after: avoid; }
  h3 { font-size: 10.5pt; margin: 14px 0 6px; color: #3a3f48; break-after: avoid; }
  .headline { font-size: 12pt; margin: 0 0 14px; padding: 12px 14px; background: #f4f5f7; border-left: 4px solid #1d2027; border-radius: 3px; }
  .hero { display: flex; gap: 22px; align-items: center; margin-bottom: 14px; }
  .big { font-size: 42pt; font-weight: 700; letter-spacing: -0.03em; line-height: 1; }
  .hero .grow { flex: 1; }
  .bar { display: flex; border-radius: 99px; overflow: hidden; background: #eceef1; width: 100%; }
  .bar span { display: block; height: 100%; }
  .legend { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 9pt; color: #4a4f59; }
  .lg i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
  .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 14px 0 4px; }
  .tile { border: 1px solid #dfe2e7; border-radius: 6px; padding: 9px 11px; break-inside: avoid; }
  .tl { font-size: 8.5pt; color: #6b707a; text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }
  .tv { font-size: 18pt; font-weight: 700; letter-spacing: -0.02em; }
  .ts { font-size: 8.5pt; color: #6b707a; }
  table.t { width: 100%; border-collapse: collapse; }
  .t th { text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .05em; color: #6b707a; font-weight: 600; padding: 5px 8px; border-bottom: 1px solid #c9ccd2; }
  .t td { padding: 6px 8px; border-bottom: 1px solid #eceef1; vertical-align: top; }
  .t tr { break-inside: avoid; }
  .num { text-align: right !important; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .bad { color: ${COLORS.failed}; font-weight: 600; }
  .delta { font-size: 9pt; font-weight: 600; white-space: nowrap; }
  .delta.up { color: ${COLORS.passed}; } .delta.down { color: ${COLORS.failed}; } .delta.flat { color: #6b707a; }
  .fail { border: 1px solid #dfe2e7; border-left: 3px solid ${COLORS.failed}; border-radius: 4px; padding: 8px 11px; margin-bottom: 8px; break-inside: avoid; }
  .fh { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .id { font-family: ui-monospace, Menlo, monospace; font-size: 8.5pt; color: #6b707a; }
  .ft { font-weight: 600; flex: 1; }
  .fm { font-size: 9pt; color: #6b707a; margin-top: 1px; }
  .fs { font-size: 9.5pt; margin-top: 5px; }
  .badge { font-size: 8pt; text-transform: uppercase; letter-spacing: .05em; font-weight: 700; padding: 1px 6px; border-radius: 3px; color: #fff; }
  .badge.failed { background: ${COLORS.failed}; } .badge.blocked { background: ${COLORS.blocked}; } .badge.untested { background: ${COLORS.skipped}; }
  .pri { font-size: 8.5pt; color: #6b707a; }
  .jira { font: 600 8.5pt ui-monospace, Menlo, monospace; color: #0052cc; background: #eef4ff; border: 1px solid #b3d0ff; border-radius: 3px; padding: 0 5px; }
  pre { margin: 6px 0 0; padding: 7px 9px; background: #f4f5f7; border-radius: 4px; white-space: pre-wrap; word-break: break-word; font: 8.5pt/1.4 ui-monospace, Menlo, monospace; }
  footer { margin-top: 30px; padding-top: 8px; border-top: 1px solid #dfe2e7; font-size: 8.5pt; color: #8a8f98; }
</style></head>
<body><div class="wrap">
<header>
  <div class="eyebrow">${esc(r.project.name)} · Test report · ${m.kind === "release" ? "Release" : "Sprint"}</div>
  <h1>${esc(m.name)}</h1>
  <div class="sub">${esc(range)}${range ? " · " : ""}Generated ${esc(fmtDate(r.generatedAt))}</div>
</header>

<p class="headline">${esc(headline(r))}</p>

<div class="hero">
  <div><div class="big">${pct(r.totals.rate)}</div><div class="mut">overall pass rate ${r.previous ? delta(r.totals.rate, r.previous.rate) : ""}</div></div>
  <div class="grow">${bar(c, 14)}<div class="legend">${legend(c)}</div></div>
</div>

<div class="tiles">
  ${tile("Manual", pct(r.totals.manualRate), `${manual.passed + manual.failed + manual.blocked} of ${manual.total} executed`)}
  ${tile("Automated", pct(r.totals.automatedRate), `${auto.total} tests`)}
  ${tile("Open failures", `<span class="${openFailures ? "bad" : ""}">${openFailures}</span>`, `${r.manualFailures.length} manual · ${r.automatedFailures.length} automated`)}
  ${tile("Automation", `${r.coverage.percent}%`, `${r.coverage.automated} of ${r.coverage.cases} cases covered`)}
</div>

${comparison}
${suites}
${requirementsSection}
${checklistSection}
${failures}
${flaky}
${runs}

<footer>Testbench · ${esc(r.project.name)} (${esc(key)}) · Pass rate counts passed ÷ (passed + failed + blocked); skipped and untested tests are excluded. Reruns within the period replace earlier results.</footer>
</div></body></html>`;
}
