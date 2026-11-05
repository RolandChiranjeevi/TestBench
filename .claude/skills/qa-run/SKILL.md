---
name: qa-run
description: Main orchestrator for a QA audit of a web feature. Fetches active requirements from TestBench or local input, plans and runs functional Playwright checks, runs visual design review when needed, turns results into bug and manual-test proposals, builds and validates an audit package, delivers it to TestBench when configured and hands over to human review. Use when the user asks to test a feature, run a QA pass or audit.
---

# Skill: QA Run (audit orchestrator)

`qa-run` runs the whole audit and delegates work to the other skills. It does not
define identifiers, statuses, evidence types, package files or validation rules.
Those are in `../references/audit-contract.md` and apply as written there.

Paths in this file are relative to this `SKILL.md`.

## Boundaries

The agent proposes. People decide.

The agent never, on its own:

- closes bugs or changes the status of anything except to create it as `proposed`
- approves, accepts or rejects its own proposals
- creates Linear, Jira, GitHub Issues or other external tickets
- changes production data
- merges pull requests
- exposes, logs, stores or includes secrets in prompts, reports, evidence or
  audit packages

New bug and manual-test proposals always have status `proposed` (contract,
Terminology rule). Their wording never claims a human-review outcome.

Needs for new TestBench fields or endpoints are recorded as separate
`TestBench backlog` items (contract, section 8). Do not work around them or
invent an interface.

Ask for confirmation before posting anything externally. Delivering a validated
package to TestBench in step 10 is the only permitted external delivery path;
follow the delivery policy configured for the project.

## TestBench context

Before fetching requirements or delivering an audit package, read the project's
TestBench configuration.

The configuration MUST provide:

- `baseUrl`
- `projectId`
- `requirementsSource`
- `tokenEnvVar`
- `deliveryPath`
- `deliveryEnabled`

Example:

```json
{
  "baseUrl": "http://localhost:4100",
  "projectId": "3",
  "requirementsSource": "testbench",
  "requirementsPath": "/api/projects/3/agent/requirements",
  "deliveryPath": "/api/projects/3/audit-packages",
  "tokenEnvVar": "TESTBENCH_API_TOKEN",
  "deliveryEnabled": false
}
```

`tokenEnvVar` MUST contain only the name of the environment variable that holds
the TestBench token. It MUST NOT contain the token value.

Never ask for, display, log, store, or include an API token, password, cookie,
or other secret in a prompt, report, evidence file, or audit package.

If no TestBench project is configured, use user-supplied requirements with
`REQ-LOCAL-<nnn>` and leave delivery as `not_configured`.

## Fetching TestBench requirements

When `requirementsSource` is `testbench`, fetch active requirements from:

```text
GET {baseUrl}{requirementsPath}
Authorization: Bearer <value of tokenEnvVar>
```

Use the token named by `tokenEnvVar` as a Bearer token.

Rules:

- Request only active requirements for the configured `projectId`.
- Preserve the TestBench `requirement_id` exactly.
- Set each requirement's `source` to `testbench`.
- Treat a 401 response as an authentication problem and stop for user guidance.
- Treat a 403 response as a project-access problem and stop for user guidance.
- Do not fall back to invented requirements.
- Do not use a CI token for an endpoint it is not authorised to access.
- Do not retry repeatedly after an authentication or authorisation failure.

If the requirements endpoint is unavailable or not configured, stop and ask the
user whether to:

- use user-supplied requirements as `REQ-LOCAL-<nnn>`
- use an exported requirements file, if one is configured
- create a TestBench backlog item for the missing endpoint

Do not invent requirements or acceptance criteria.

## Inputs to confirm

Before starting, confirm:

- target URL
- environment and build
- how to log in; never request or store passwords in reports or test code
- test data
- viewports; default 375, 768 and 1440 CSS px
- requirement source
- whether state-changing checks are allowed

If something is missing, ask. Do not guess.

## Audit scope

Before creating the test plan, create an audit scope and ask the user to confirm
it. Do not plan or run anything until it is confirmed.

The scope contains:

- Audit objective
- Target URL and environment
- Included and excluded requirement IDs
- Allowed check types, using the `Test type` values of the plan
- Viewports
- Whether state-changing checks are allowed, and which ones
- Test-data constraints
- Known out-of-scope areas
- Stop conditions, including any added by the user

If the user only asks for “a QA pass” without a scope, propose a small,
risk-based scope first and ask for confirmation. Do not assume that all active
requirements are to be tested in one run.

Record the confirmed scope as the `scope` object of `manifest.json` (contract
section 5.6) and in `report.md`, including included and excluded requirement
IDs.

A change of scope during the run requires a new confirmation.

When a scope limit is ambiguous, ask the user before performing the action.

Do not interpret a per-audit limit as a per-viewport limit, or a per-viewport
limit as a per-audit limit unless the scope explicitly says so.

Record a confirmed scope change as an entry in `manifest.limitations[]` stating
the change and its new confirmation, and describe it in `report.md`.

## Execution order

Do not begin browser execution until the confirmed scope, requirement list, test
plan and coverage gaps have been created and recorded in the audit workspace or
package draft.

Create the package folder and begin `manifest.json` before the first execution.

The package is completed and validated after execution, but its core records
MUST exist before execution begins.

The test plan MUST exist before the first execution is recorded.

If execution begins before the plan is complete, pause the audit, create or
complete the plan, and ask the user whether to retain or discard the already
collected results.

## Stop conditions

Pause and ask the user when there is:

- missing login, environment access or test data
- a URL, build or environment that differs from the confirmed scope
- a state-changing action that the scope does not explicitly allow
- a risk of affecting other users, shared data, billing, permissions or
  irreversible workflows
- the same blocking problem stopping several planned checks
- not enough evidence to tell a product defect from an environment, selector,
  fixture or test-data fault
- a TestBench authentication or project-access failure

When pausing, record the reason for the pause, the affected test plan items and
the user decision that is needed.

Put this in the report under Limitations.

Mark affected test plan items that will not be executed in this audit as
`blocked`, using the matching reason code from contract section 2.3.

If the pause prevents continuation of the entire audit, stop the audit, retain
the confirmed scope and completed results, and ask the user whether to resume,
change the scope, or abandon the run.

Do not automatically mark every remaining plan item as `blocked`.

Do not classify unresolved environment, access, authentication or authorisation
problems as product defects.

## Audit flow

### 1. Fetch active requirements

Read the active requirements from TestBench through the integration the project
has configured.

If TestBench is configured, use the requirements-fetch rules above.

If no TestBench integration is configured, use the requirements the user
supplied and give them `REQ-LOCAL-<nnn>`.

Record each requirement's source.

If a requirement has no measurable acceptance criteria, mark it
`needs-clarification`. Do not invent criteria.

Output: requirement list with `requirement_id` and readiness.

### 2. Create the test plan

Start only after the audit scope is confirmed.

Follow `../test-planning/SKILL.md` and read
`../references/testheuristics.md` first.

Every plan item has a `requirement_id` and a `test_plan_item_id`.

State which heuristics informed the plan. Heuristics are not requirements.

Output: a test plan in the template and coverage gaps.

### 3. Run functional Playwright checks

Follow `../functional-test-runner/SKILL.md`.

Use the browser-execution rules below.

Record every state-changing action in `manifest.actions[]` using the format
defined in contract section 5.8.

Link the action to the relevant `execution_id` and evidence IDs.

Output: one execution per run with `execution_id`, status and `evidence_id`s.

### 4. Run visual design review when needed

Follow `../visual-design-review/SKILL.md` when a requirement concerns layout,
responsive behaviour, design or accessibility, or when the user asks for it.

Check at the agreed viewports.

Run visual design review only when visual presentation, responsive behaviour,
layout, accessibility or a design reference is relevant to the requirement.

When it is not relevant, record the visual review as an execution with status
`skipped` and reason `not-applicable` (contract section 2.3), with a short
rationale.

Output: executions and findings in the same format as step 3.

### 5. Analyse the results

Check that every status follows the contract (section 2).

Check each `fail` against its requirement.

Attempt at least one reproduction or evidence re-check using the recorded steps,
viewport, state and evidence.

If reproduction or evidence re-check does not support the deviation, reclassify
the result as `inconclusive` unless independent evidence still supports it.

Reclassify anything caused by a selector, timeout, fixture or environment as
`blocked` or `inconclusive`.

Group findings that share a cause.

Perform the duplicate check for every proposed bug:

- Compare against known open bugs through the configured TestBench integration.
- No bug data available: `duplicate_check` is `not_available` and
  `possible_duplicate_of` is `null`.
- No plausible match: `duplicate_check` is `no_match` and
  `possible_duplicate_of` is `null`.
- Plausible match: `duplicate_check` is `possible_match` and
  `possible_duplicate_of` is the existing bug identifier. Explain the matching
  evidence and differences in `duplicate_check_notes`.
- Uncertain match: `duplicate_check` is `uncertain_match`, keep the new proposal
  with status `proposed`, set `possible_duplicate_of` to the most likely
  existing bug identifier, and set agent confidence to `Low` or `Medium`.

Never close, merge, reject or change an existing bug, and never set the status
`duplicate`.

### 6. Create bug proposals

Follow `../bug-reporting/SKILL.md` for each `fail` that has evidence against its
requirement, and for each visual or accessibility finding that has evidence.

Use `../bug-reporting/templates/bug-report.md` for all of them.

Status is `proposed`.

### 7. Propose manual test cases

Create a `manual_test_proposal_id` for checks that are `manual-only`, for
coverage gaps and for follow-up around each bug.

Each has an objective, steps and expected result.

Status is `proposed`.

Each manual test proposal MUST have an `origin` object:

```json
{
  "type": "coverage_gap",
  "id": "CG-002"
}
```

`type` MUST be one of `execution`, `bug_proposal` or `coverage_gap`.

`id` MUST be the matching `execution_id`, `bug_proposal_id` or
`coverage_gap_id`.

### 8. Build the audit package

Complete the package folder `<audit_id>/` created before execution.

Ensure it contains:

```text
manifest.json
report.md
bugs.json
manual-tests.json
evidence/
```

Store or reference each evidence artifact in `evidence/` exactly as required by
the contract.

Register every artifact with its `evidence_id`, type, source and integrity
information where the contract requires it.

Include `actions[]` in `manifest.json` for every state-changing action performed
during the audit.

### 9. Validate against the contract

Run every rule in `../references/audit-contract.md` section 6 and the final
quality checklist below.

Fix errors and validate again.

Record the result in `manifest.json` `validation`.

If the package still fails, do not deliver it. Report the errors.

### 10. Deliver to TestBench

Deliver only a package whose validation result is `pass`, and only through the
delivery path the project has configured.

If `deliveryEnabled` is `false`, or no delivery path is configured, leave the
package in place, say so, and add a TestBench backlog item.

Create no tickets anywhere else.

Record the delivery attempt in `manifest.delivery`:

- `status`: `not_delivered`, `delivered`, `failed` or `not_configured`
- `delivered_at`
- `method`
- `target`
- `request_reference`
- `response_reference`
- `error`

Use `null` for unknown optional values. Do not guess.

Do not mark the audit as delivered unless the configured integration confirms
acceptance.

Package validation (step 9) and TestBench acceptance are separate facts and are
recorded separately.

### 11. Hand over to human review

Give the person a short summary:

- scope
- counts per execution status
- defect proposals requiring review
- manual test proposals
- coverage gaps
- limitations
- TestBench backlog
- package path

State that everything is `proposed` and that review is theirs.

Do nothing further on the proposals.

## Browser execution

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

## Test design references

Before generating the test plan, read `../references/testheuristics.md`.

Apply relevant heuristics when identifying test cases.

Do not treat heuristics as product requirements.

State which heuristics informed the test plan.

## Result accuracy

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
> and DOM/accessibility-tree inspection. This does not establish WCAG 2.1 AA
> conformance.

## Final quality checklist

Before delivery, verify each item and fix what fails. Do not deliver on a
partial pass.

- [ ] All results have a `requirement_id` and a `test_plan_item_id`
- [ ] All findings have at least one `evidence_id`
- [ ] All bug proposals follow `../bug-reporting/templates/bug-report.md`
- [ ] No `blocked` result is reported as `fail`
- [ ] All proposals have status `proposed`
- [ ] The audit package validates against `../references/audit-contract.md`
- [ ] No autonomous closings, approvals or external tickets have been created
- [ ] The confirmed audit scope lists included and excluded requirements
- [ ] Every state-changing action is recorded in `manifest.actions[]` and
  matches an allowed action and limit in the confirmed scope
- [ ] The test plan and coverage gaps were created before the first execution
- [ ] No evidence file was renamed, overwritten, replaced, or given a
  fabricated timestamp after registration
- [ ] The report clearly states whether an automated accessibility scan was
  performed
- [ ] Every bug proposal has a `duplicate_check` value and a consistent
  `possible_duplicate_of` value
- [ ] The delivery record distinguishes package validation from TestBench
  acceptance
- [ ] No secret, token, password, cookie or personal data appears in the
  package

Also confirm that `external_actions` is `[]`, that no secrets are in the
package, and that coverage gaps and TestBench backlog items are listed rather
than left out.