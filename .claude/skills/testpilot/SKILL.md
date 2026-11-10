---
name: testpilot
description: TestPilot QA audit agent. Discovers a target, proposes a scope, runs approved checks and builds an audit package. Fetches active requirements from TestBench or local input, plans and runs functional Playwright checks, runs visual design review when needed, turns results into bug and manual-test proposals, builds and validates an audit package, delivers it to TestBench when configured and hands over to human review. Use when the user asks to test a feature, run a QA pass or audit.
---

# Skill: TestPilot (audit orchestrator)

`testpilot` runs the whole audit and delegates work to the other skills. It does not
define identifiers, statuses, evidence types, package files or validation rules.
Those are in `../../references/audit-contract.md` and apply as written there.

Paths in this file are relative to this `SKILL.md`.

## Commands

- `init`: select or create a TestBench project and establish the requirements
  source. See `../testpilot-init/SKILL.md`.
  Target URL and environment belong to discover, not init.
- `discover`: inspect a target and propose a test scope. See
  `../testpilot-discover/SKILL.md`.
- `plan`: collect inputs and requirements, agree on a scope and build the test
  plan; stops for scope approval and for test plan approval. See
  `../testpilot-plan/SKILL.md`.
- `run`: execute the approved test plan with Playwright, review visual design
  when needed and collect evidence. See `../testpilot-run/SKILL.md`.
- `report`: analyse the results, create bug and manual-test proposals and build
  the audit package. See `../testpilot-report/SKILL.md`.
- `deliver`: transform a validated audit package and import it to TestBench
  after user confirmation (dry-run first, then real import). See
  `../testpilot-deliver/SKILL.md`.
- `api-testing`: the API variant of discover → plan → run → report → deliver
  for a REST or GraphQL target described by a target profile
  (`config/targets/<name>.json`); `tools/apitest/runner.py` replaces Playwright
  and the package, contract and delivery are unchanged. See
  `../testpilot-api-testing/SKILL.md`.

## Command order

```text
init → discover → plan → run → report → deliver
```

`init` is optional when the user already has a configured TestBench project.
`discover` is required before planning or running an audit.

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

Ask for confirmation before posting anything externally.

Permitted external write paths are:

- `/testpilot-init`: create a confirmed TestBench project and save local
  project configuration
- `/testpilot-deliver`: deliver a validated audit package to TestBench

Follow the delivery policy configured for the project.

## Working rules

`../../references/agent-rules.md` defines how the agent reasons and acts in
every skill: claims grounded in checks made in the session, no fix without a
root cause, the agent never approves, observe-only by default, no secrets in
clear text, concrete limits (3 attempts, 100 objects, 30 s per external call),
duplicate protection, no swallowed errors, and tool fallback. Every skill reads
it before starting.

When rules conflict, this order decides:

1. Security (agent-approval rule, observe-only, secrets)
2. The user's explicit request
3. Scope: nothing beyond what was asked
4. Review: change nothing while reviewing
5. Debugging: root cause before any fix

## TestBench context

Before fetching requirements or delivering an audit package, read:

1. `config/testbench.json`
2. The project profile referenced by `activeProject`

The global configuration must provide:

- `baseUrl`
- `activeProject`

The project profile must provide:

- `projectId`
- `projectKey`
- `name`
- `requirementsSource`
- `requirementsPath`
- `tokenEnvVar`
- `deliveryEnabled`
- `permissionMode`: `observe_only` or `full` (missing means `observe_only`)

Example global configuration:

```json
{
  "baseUrl": "http://localhost:4100",
  "activeProject": "ts"
}
```

Example project profile:

```json
{
  "projectId": "5",
  "projectKey": "TS",
  "name": "Testpilot",
  "requirementsSource": "black_box",
  "requirementsPath": "/api/agent/projects/5/requirements",
  "tokenEnvVar": "TESTBENCH_API_TOKEN_TS",
  "deliveryEnabled": false,
  "permissionMode": "observe_only"
}
```

Rules:

- Resolve the active project from `activeProject`.
- Treat `permissionMode` as authoritative for state-changing actions in the
  target: `observe_only` (default) allows none; `full` allows those the
  confirmed scope lists, and is set only by `init` after the user's explicit
  confirmation (`../../references/agent-rules.md`, rule 4).
- Read project-specific values only from the matching profile.
- Do not duplicate project-specific fields in the global configuration.
- Do not store token values, passwords, cookies or target URLs in the TestBench
  project profile. An API target profile (`config/targets/<name>.json`) may hold
  a non-production base URL, never a secret.
- Treat `deliveryEnabled` in the project profile as authoritative.
- If the active profile is missing, invalid or unreadable, pause and ask the user.

`tokenEnvVar` MUST contain only the name of the environment variable that holds
the TestBench token. It MUST NOT contain the token value.

Never ask for, display, log, store, or include an API token, password, cookie,
or other secret in a prompt, report, evidence file, or audit package.

If no TestBench project is configured, use user-supplied requirements with
`REQ-LOCAL-<nnn>` and leave delivery as `not_configured`.

## Plan phase

Requirements, inputs, audit scope, the test plan and the execution-order
prerequisites are defined in `../testpilot-plan/SKILL.md`. The plan phase ends only after
the user has approved both the scope and the test plan. Do not begin browser
execution before that.

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

### 0. Initialize the project

See `../testpilot-init/SKILL.md`.

Run this step when no valid TestBench project context exists, or when the user
explicitly asks to initialize a new audit.

This step establishes:

- the TestBench project
- the project ID and project key
- the requirements source
- the local TestPilot project profile

This step does **not** select the target URL or environment.

### 1. Fetch active requirements

See `../testpilot-plan/SKILL.md`, step 2.

### 2. Create the test plan

See `../testpilot-plan/SKILL.md`, step 4.

### 3. Run functional Playwright checks

See `../testpilot-run/SKILL.md`, step 1.

### 4. Run visual design review when needed

See `../testpilot-run/SKILL.md`, step 2.

### 5. Analyse the results

See `../testpilot-report/SKILL.md`, step 1.

### 6. Create bug proposals

See `../testpilot-report/SKILL.md`, step 2.

### 7. Propose manual test cases

See `../testpilot-report/SKILL.md`, step 3.

### 8. Build the audit package

See `../testpilot-report/SKILL.md`, step 4.

### 9. Validate against the contract

Run every rule in `../../references/audit-contract.md` section 6 and the final
quality checklist below, including V-33 to V-35 for the test plan.

Fix errors and validate again.

Record the result in `manifest.json` `validation`.

If the package still fails, do not deliver it. Report the errors.

### 10. Deliver to TestBench

See `../testpilot-deliver/SKILL.md`.

TestBench integration (for `deliver`):

- Config is read from:
  - `config/testbench.json` for `baseUrl`
  - the active project profile for `projectId`, `projectKey`, `tokenEnvVar`
    and `deliveryEnabled`

- The delivery endpoint is:

  ```text
  {baseUrl}/api/projects/{projectId}/audit-import
  ```

- Auth: TestBench requires a session cookie for write requests.
  `deliver` logs in via `POST /api/login` with `{"password": ...}`,
  where the password is read from the environment variable
  `TESTBENCH_PASSWORD` (defined in `.env`). The response sets the
  `tb_session` cookie.

- All POST requests to TestBench must also send the header
  `X-Testbench: 1`, otherwise the server responds 403.

- A Bearer token (`TESTBENCH_API_TOKEN`, agent token `tbag_...`) is NOT
  sufficient for audit import — it only works for agent read endpoints
  (e.g. `GET /api/agent/projects/:id/requirements`) and CI ingest.

- Password and cookie values must never be printed to output, logs,
  or reports.

Delivery rules:

- Only deliver a package whose `manifest.validation.result` is `pass`.
- If `deliveryEnabled` is false (or absent), leave the package undelivered
  and create a TestBench backlog item.
- Create no tickets anywhere else.
- `manifest.delivery` fields: status (one of the four allowed values),
  delivered_at, method, target, request_reference, response_reference,
  and error.
- Do not mark the audit as delivered unless the integration confirms
  acceptance.
- Package validation and TestBench acceptance are separate facts.

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

## Evidence storage

See `../testpilot-run/SKILL.md`, step 4.

## Browser execution

See `../testpilot-run/SKILL.md`, step 3.

## Test design references

See `../testpilot-plan/SKILL.md`, step 4 (Test design references).

## Result accuracy

See `../testpilot-run/SKILL.md`, step 5.

## Final quality checklist

Before delivery, verify each item and fix what fails. Do not deliver on a
partial pass.

- [ ] All results have a `requirement_id` and a `test_plan_item_id`
- [ ] All findings have at least one `evidence_id`
- [ ] All bug proposals follow `../bug-reporting/templates/bug-report.md`
- [ ] No `blocked` result is reported as `fail`
- [ ] All proposals have status `proposed`
- [ ] The audit package validates against `../../references/audit-contract.md`
- [ ] No autonomous closings, approvals or external tickets have been created
- [ ] The confirmed audit scope lists included and excluded requirements
- [ ] Every state-changing action is recorded in `manifest.actions[]` and
  matches an allowed action and limit in the confirmed scope
- [ ] The test plan and coverage gaps were created before the first execution
- [ ] Every plan item has `preconditions`, `test_data`, `steps`, `acceptance_criteria` and an `automation`
  object (contract 5.9); a `needs-clarification` item has `steps: []`
- [ ] `test-plan.md` and the Test plan section of `report.md` list the same plan items and coverage gaps as the
  manifest (V-33, V-35)
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