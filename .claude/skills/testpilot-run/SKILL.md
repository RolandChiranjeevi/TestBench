---
name: testpilot-run
description: Execute an approved TestPilot audit plan with Playwright, collect evidence and record results. Use when the user invokes /testpilot-run or asks to run a TestPilot audit.
---

# TestPilot: run

Execute the approved test plan: functional Playwright checks, visual design review
when needed, and evidence collection. Analysis, bug proposals and the package come
after this and stay in the audit flow in `SKILL.md`.

Input:
- audit ID (required), format `AUD-<YYYYMMDD>-<nn>`; it is also the package folder
  name

Paths in this file are relative to this file. The contract is
`../../references/audit-contract.md`.

Before starting, read:
- `../testpilot/SKILL.md`
- `../../references/audit-contract.md`
- `../../references/agent-rules.md`

Apply the shared boundaries, secret-handling rules and stop conditions.
Execute only this run workflow. Do not start the full audit.

## Responsibilities

This workflow:
- Executes the approved test plan
- Runs functional Playwright checks
- Runs visual design review when needed
- Collects evidence
- Records results

It does not:
- Create a TestBench project
- Select a target URL or environment
- Create a test plan
- Analyse results
- Create bugs or manual tests
- Deliver an audit package

## 1. Read the TestBench context

Read:

1. `config/testbench.json`
2. The project profile referenced by `activeProject`

Use from the global configuration:

- `baseUrl`

Use from the project profile:

- `projectId`
- `projectKey`
- `name`
- `requirementsSource`
- `requirementsPath`
- `tokenEnvVar`
- `permissionMode` (missing means `observe_only`)

Rules:

- Do not read project-specific values from the global configuration.
- Do not store token values, passwords, cookies or target URLs in the TestBench
  project profile. An API target profile (`config/targets/<name>.json`) may hold
  a non-production base URL, never a secret.
- If the active profile is missing, invalid or unreadable, pause and ask the user.

## 2. Read the discovery context

Read the discovery context produced by `/testpilot-discover`.

It must contain:
- target URL
- environment
- confirmed scope
- allowed check types
- viewports
- state-changing action limits

If the discovery context is missing or invalid, pause and ask the user to run
`/testpilot-discover` first.

Do not invent a target URL or environment.

## 3. Before the first check

Before the first check:

- `<audit-id>/manifest.json` must hold the approved `scope`, and the approved test
  plan and coverage gaps must be recorded in `<audit-id>/`. If not, stop and tell
  the user to run `plan` first. Do not run anything from an unapproved plan.
- The stop conditions in `SKILL.md` apply during the whole run.
- Check `permissionMode` against the plan. In `observe_only`, no plan item may
  perform a state-changing action, whatever `scope.state_changes` says: if the
  scope allows state changes or a plan item needs one, stop before the first
  check and ask the user (the profile wins; `../../references/agent-rules.md`,
  rule 4). Do not record such items as `skipped` on your own: the user decides
  whether to set `full` through `init`, change the plan, or skip them.
- In `full`, every state-changing action still needs an explicit allowed
  action and limit in the scope (contract 5.6).

Flow:

1. Run functional Playwright checks.
2. Run visual design review when needed.

The rules for both are in steps 4 to 6 below: Browser execution, Evidence storage
and Result accuracy.

## 4. Run functional Playwright checks

Follow `../../functional-test-runner/SKILL.md`.

Use the browser-execution rules below.

Record every state-changing action in `manifest.actions[]` using the format
defined in contract section 5.8.

Link the action to the relevant `execution_id` and evidence IDs.

Output: one execution per run with `execution_id`, status and `evidence_id`s.

## 5. Run visual design review when needed

Follow `../../visual-design-review/SKILL.md` when a requirement concerns layout,
responsive behaviour, design or accessibility, or when the user asks for it.

Check at the agreed viewports.

Run visual design review only when visual presentation, responsive behaviour,
layout, accessibility or a design reference is relevant to the requirement.

When it is not relevant, record the visual review as an execution with status
`skipped` and reason `not-applicable` (contract section 2.3), with a short
rationale.

Output: executions and findings in the same format as step 4.

## 6. Browser execution

Use the available Playwright MCP browser tools for all browser actions.

Use Playwright to:

- Navigate to the target URL
- Perform login and setup steps when needed
- Execute each test case step by step
- Capture screenshots at success checkpoints and failures
- Read console errors and failed network requests
- Inspect layout and computed styles for visual checks

A check done through MCP is `mcp-exploration`.

A check in the project's Playwright Test suite is `saved-test`.

Record which one was used.

MCP exploration is not a saved automated test.

## 7. Evidence storage

All exported files, downloads, screenshots, console logs, network captures and
other evidence artifacts must be stored under:

```text
audits/<audit_id>/downloads/
```

Rules:

- Create the `downloads/` folder before the first export or download.
- Use descriptive file names, for example `decathlon-standings.csv`.
- Never leave evidence only in `/tmp`, the browser download folder or another
  temporary location.
- After a download, move the file into `audits/<audit_id>/downloads/` and
  verify that it exists there.
- Report the full path of every evidence file.
- Do not rename, overwrite or replace an evidence file after it has been
  registered in `manifest.json`.

## 8. Result accuracy

For each execution, report:

- Expected result and its basis: the requirement and acceptance criterion
- Actual observed result
- What was verified
- What was not verified

Only mark the tested behaviour as `pass`.

Do not imply broader coverage than the evidence supports.

If browser validation prevents submission, report that client-side validation
was verified.

Do not claim server-side validation or injection protection was verified.

If no automated accessibility scan was performed, state this explicitly in the
report. Do not use wording that implies an automated scan was performed.

Use wording such as:

> No automated accessibility scan was performed in this audit. Accessibility
> signals were assessed through Playwright MCP exploration, keyboard interaction
> and DOM/accessibility-tree inspection. This does not establish WCAG 2.2 AA
> conformance.

When the run is finished, tell the user that the next step is the analysis
(audit flow step 5 in `SKILL.md`). Do not start it before they say so.