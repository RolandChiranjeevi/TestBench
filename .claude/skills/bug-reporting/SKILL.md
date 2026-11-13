---
name: bug-reporting
description: Reproduces and documents web application bugs using Playwright browser tools, captures evidence, and writes a bug proposal in the mandatory bug-report.md format for both functional and visual findings. Use when the user reports a defect or asks to reproduce, investigate, or document a bug. Called by qa-run in step 6.
---

# Skill: Bug Reporting with Browser Reproduction

Use this skill when the user reports a defect, when a test run has a `fail` that has supporting evidence, or when a visual or
accessibility finding has evidence supporting a deviation from a requirement, acceptance criterion or design reference. It produces a bug **proposal**.

Identifiers, statuses and evidence types are defined in `../references/audit-contract.md`.
Use them as written. Do not define your own. Paths are relative to this `SKILL.md`.

## Tools
Use the available Playwright MCP browser tools to:
- Navigate to the application or specified URL.
- Perform the reported reproduction steps.
- Capture screenshots before failure and at the moment of failure.
- Inspect console messages and failed network requests/responses.
- Record the final URL, viewport size, and browser context.

## Workflow
1. Confirm:
   - Starting URL
   - Environment and build
   - The approved way to obtain a test session or test user; never request,
     store, or include passwords, tokens, cookies, or personal data in reports,
     evidence, or test code
   - Expected starting state
   - The requirement (`requirement_id`) and the test plan item (`test_plan_item_id`) the finding belongs to
2. If information is missing, ask before proceeding.
3. Open the application using Playwright.
4. Follow the reported steps exactly.
5. If the defect occurs:
   - Capture a screenshot showing the issue.
   - Capture relevant console errors.
   - Capture relevant failed network requests and response statuses.
6. Save evidence in `evidence/` and register each file as an evidence object with an `evidence_id`.
7. Perform the duplicate check required by the contract.

   Compare the evidence-supported finding with known open bugs available through
   the configured TestBench integration.

   Set:

   - `duplicate_check: not_available` and `possible_duplicate_of: null` when no
     bug data is available.
   - `duplicate_check: no_match` and `possible_duplicate_of: null` when no
     plausible match is found.
   - `duplicate_check: possible_match` and `possible_duplicate_of` to the existing
     bug identifier when a plausible match exists.
   - `duplicate_check: uncertain_match`, keep status `proposed`, and set
     `possible_duplicate_of` to the most likely existing bug identifier when the
     match is uncertain.

   Explain matching evidence and differences in `duplicate_check_notes`.

   Never close, merge, reject or change an existing bug, and never set the
   proposal status to `duplicate`.
8. Fill in `templates/bug-report.md`.
9. Review the report: can someone else reproduce it from the text alone?

## What may become a bug proposal
- A functional `fail` with an evidence-supported deviation from requirement.
- A visual or accessibility finding with evidence supporting a deviation from
  a requirement, acceptance criterion or design reference.

Not a bug proposal: `blocked` and `skipped` results, `inconclusive` results, and tool or fixture errors.
For those, describe the problem in the audit report and propose a manual test if useful.

## Evidence rules
- Save screenshots as `evidence/[area]-[issue]-[date].png`.
  Example: `evidence/checkout-empty-cart-error-2026-11-02.png`
- Every proposal lists at least one `evidence_id`.
- Include the screenshot in the report using a relative Markdown path.
- Never include passwords, tokens, cookies, or personal data in evidence or report text.
- If the issue cannot be reproduced, document exactly what was attempted, the observed behaviour, and what
  additional information is needed. Set the reproduction rate to `Not reproduced`.

Evidence `location` in `manifest.json` is relative to the audit package root,
for example `evidence/checkout-empty-cart-error-2026-11-02.png`.

Markdown links in `report.md` are relative to `report.md`, for example
`evidence/checkout-empty-cart-error-2026-11-02.png`.

## Output
Use `templates/bug-report.md` exactly, for functional, visual and accessibility findings alike.
The status is `proposed`. Do not change it, and do not close, accept or reject any bug.
