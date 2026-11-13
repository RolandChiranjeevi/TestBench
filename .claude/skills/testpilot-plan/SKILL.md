---
name: testpilot-plan
description: Collect inputs, fetch requirements, agree on an audit scope and build a TestPilot test plan. Use when the user invokes /testpilot-plan or asks to plan a TestPilot audit.
---

# TestPilot: plan

Collect inputs, fetch requirements, agree on a scope and build the test plan. The
plan phase ends only when the user has approved both the scope and the test plan.
Then `run` can start.

Input:
- audit ID (required), format `AUD-<YYYYMMDD>-<nn>`; it is also the package folder
  name. For a new audit, propose the next free ID and ask the user to confirm it.
- the inputs listed in step 1
- optional: the scope proposed by `discover`

Paths in this file are relative to this file. The contract is
`../../references/audit-contract.md`.

Before starting, read:
- `../testpilot/SKILL.md`
- `../../references/audit-contract.md`
- `../../references/agent-rules.md`

Apply the shared boundaries, secret-handling rules and stop conditions.
Execute only this planning workflow. Do not start the full audit.

Flow, with two stops:

1. Collect inputs.
2. Fetch requirements.
3. Propose the audit scope. **Stop: scope approval.**
4. Create the test plan and coverage gaps. **Stop: test plan approval.**
5. Record the plan in the package draft. The plan phase is then complete.

Do not plan before the scope is approved. Do not run anything before both
approvals.

## 1. Inputs to confirm

Before starting, confirm:

- target URL
- environment and build
- how to log in; never request or store passwords in reports or test code
- test data
- viewports; default 375, 768 and 1440 CSS px
- requirement source
- whether state-changing checks are allowed

If something is missing, ask. Do not guess.

## 2. Fetch active requirements

Read the active requirements according to the project profile.

If TestBench is configured, use the requirements-fetch rules below.

If no TestBench integration is configured, use the requirements the user
supplied and give them `REQ-LOCAL-<nnn>`.

Record each requirement's source.

If a requirement has no measurable acceptance criteria, mark it
`needs-clarification`. Do not invent criteria.

Output: requirement list with `requirement_id` and readiness.

### Read the TestBench configuration

Read:

1. `config/testbench.json`
2. The project profile referenced by `activeProject`

Use from the global configuration:

- `baseUrl`

Use from the project profile:

- `projectId`
- `requirementsSource`
- `requirementsPath`
- `tokenEnvVar`

Rules:

- Do not read project-specific values from the global configuration.
- Do not store token values, passwords, cookies or target URLs in the TestBench
  project profile. An API target profile (`config/targets/<name>.json`) may hold
  a non-production base URL, never a secret.
- If the active profile is missing, invalid or unreadable, pause and ask the user.

### Requirements source behaviour

| `requirementsSource` | Behaviour |
|---|---|
| `testbench` | Fetch active requirements from TestBench |
| `black_box` | Do not fetch requirements; use black-box context |
| `pending` | Ask the user to provide requirements or explicitly choose black-box planning |
| `import_pending` | Explain that requirements must be imported before requirement-based planning |

If `requirementsSource` is `black_box`, skip TestBench requirement fetching.

If `requirementsSource` is `pending`, ask:

```text
Requirements are pending for this project.

Would you like to:
1. Provide requirements now
2. Use black-box planning
3. Cancel
```

If `requirementsSource` is `import_pending`, say:

```text
Requirements must be imported into TestBench before requirement-based planning.

You can:
1. Import requirements now
2. Use black-box planning
3. Cancel
```

Do not invent requirements or acceptance criteria.

### Fetching TestBench requirements

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

## 3. Audit scope

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

`state_changes.allowed` may be `true` only when the project profile's
`permissionMode` is `full`. With `observe_only` (the default, also when the
field is missing), set `allowed: false` and `allowed_actions: []`, and record
each check that would need a state change as a coverage gap. Do not propose
`full` yourself; the user sets it through `init`.

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

**Stop: scope approval.** Show the scope and wait for the user's explicit
approval in a new message. Anything else means no.

## 4. Create the test plan

Start only after the audit scope is confirmed.

Follow `../../test-planning/SKILL.md` and read
`../../references/testheuristics.md` first.

Every plan item has a `requirement_id` and a `test_plan_item_id`.

State which heuristics informed the plan. Heuristics are not requirements.

Output: a test plan in the template, the same plan as `manifest.test_plan_items[]` with the fields of contract
section 5.9 (`preconditions`, `test_data`, `steps`, `acceptance_criteria`, `automation`), and the coverage gaps as
`manifest.coverage_gaps[]`. `../../test-planning/SKILL.md` says how each field is written.

### Test design references

Before generating the test plan, read `../../references/testheuristics.md`.

Apply relevant heuristics when identifying test cases.

Do not treat heuristics as product requirements.

State which heuristics informed the test plan.

**Stop: test plan approval.** The test plan decides what is actually run. Show the
test plan, with its steps, preconditions, test data, acceptance criteria and automation, and the coverage gaps, and wait for the user's explicit approval in a
new message. If the user asks for changes, update the plan and show it again. If
the plan needs a requirement outside the approved scope, go back to step 3.

## 5. Execution order

Do not begin browser execution until the confirmed scope, requirement list, test
plan and coverage gaps have been created and recorded in the audit workspace or
package draft.

Create the package folder and begin `manifest.json` before the first execution. The manifest already has
`test_plan_items[]` with the structured fields of contract section 5.9, and `coverage_gaps[]`, and the folder has
`test-plan.md`.

The package is completed and validated after execution, but its core records
MUST exist before execution begins.

The test plan MUST exist before the first execution is recorded.

If execution begins before the plan is complete, pause the audit, create or
complete the plan, and ask the user whether to retain or discard the already
collected results.

The plan phase is complete when the scope and the test plan are both approved and
recorded in `<audit-id>/`. Tell the user that `run` can start. Do not start it
before they say so.