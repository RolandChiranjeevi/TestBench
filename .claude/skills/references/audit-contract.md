# Audit contract

Single shared source for identifiers, statuses, evidence types, audit package files and
validation rules. Contract version: `1.2`.

Every QA skill (`qa-run`, `test-planning`, `functional-test-runner`, `bug-reporting`,
`visual-design-review`) refers to this file. No skill may define its own version of these
identifiers, statuses, evidence types or package files. If a skill needs a new value, change
it here and update `contract_version`.

Paths in skills are relative to the skill's own `SKILL.md`: `../references/audit-contract.md`.

---

## 1. Shared identifiers

| Identifier | Format | Example | Created by | Meaning |
|---|---|---|---|---|
| `requirement_id` | Source ID used verbatim (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`), or `REQ-LOCAL-<nnn>` | `REQ-LOCAL-001` | Requirement source (TestBench). Agent only for local ones. | The requirement under test. |
| `test_plan_item_id` | `TPI-<nnn>` | `TPI-007` | test-planning | One planned check, linked to exactly one requirement. |
| `execution_id` | `EX-<nnn>` | `EX-014` | functional-test-runner, visual-design-review | One execution of one test plan item. A re-run gets a new ID. |
| `evidence_id` | `EV-<nnn>` | `EV-031` | Any skill that captures evidence | One evidence object (section 4). |
| `bug_proposal_id` | `BP-<nnn>` | `BP-003` | bug-reporting | One proposed bug, never a confirmed bug. |
| `manual_test_proposal_id` | `MTP-<nnn>` | `MTP-002` | qa-run | One proposed manual test case. |
| `audit_id` | `AUD-<YYYYMMDD>-<nn>` | `AUD-20261104-01` | qa-run | One audit run and its package. Also the package folder name. |
| `testbench_backlog_id` | `TBB-<nnn>` | `TBB-001` | qa-run | One TestBench backlog item (section 8). Added in 1.0 for the "TestBench backlog" rule. |
| `coverage_gap_id` | `CG-<nnn>` | `CG-002` | test-planning, qa-run | One recorded coverage gap (section 5.1 `coverage_gaps[]`). Added in 1.1. |
| `action_id` | `ACT-<nnn>` | `ACT-001` | qa-run | One state-changing action performed during the audit. Added in 1.2. |

Rules:
- `<nnn>` is zero padded, three digits or more, and counted per audit package from `001`.
- IDs are unique within a package and are never reused or renumbered after creation.
- References to another audit are written `<audit_id>/<id>`, for example `AUD-20261104-01/BP-003`.
- `REQ-LOCAL-<nnn>` is only for a requirement the user gave in the session and that has no
  source ID. It is listed with `source: "local"` in the manifest and in the report as
  "not registered in TestBench". The agent never invents a requirement.
- Dates and times are ISO 8601 in UTC, for example `2026-11-04T12:30:44Z`.

## 2. Shared statuses

### 2.1 Execution status

Used by every execution record (`executions[].status` in `manifest.json`).

| Status | Definition | Required |
|---|---|---|
| `pass` | The check ran and the evidence shows the acceptance criterion is met, within the documented scope. | At least one `evidence_id`. State what was verified and what was not. |
| `fail` | A test execution produced objective evidence that an expected behavior or acceptance criterion was not met. A fail may be described as a verified deviation only when the evidence supports the observed difference between expected and actual behavior. | At least one `evidence_id`, the violated acceptance criterion, and the observed result. The deviation was reproduced, or the reason it was not is stated. |
| `blocked` | The check **could not be run** because of environment, access, data or a dependency. | `reason` (section 2.3) and what is needed to unblock. |
| `skipped` | The check was deliberately not run. | `reason` (section 2.3). |
| `inconclusive` | The check ran but the evidence is not enough for `pass` or `fail`. | `reason`, what was observed, and what additional evidence or decision is needed. |

Hard rules:
- **`blocked` is never reported as `fail`.** A check that could not run says nothing about the product.
- A failing selector, timeout, broken fixture, expired login or missing test data is `blocked`
  (could not run) or `inconclusive` (ran, unclear), never `fail`, until the behaviour has been
  verified against the requirement.
- `skipped` and `blocked` are never counted as `pass` in any summary or coverage figure.
- `fail` must trace to a requirement. A defect with no requirement is recorded as a finding with
  `requirement_id` of a local requirement (`REQ-LOCAL-<nnn>`) and marked `inconclusive` for review,
  not as a verified failure.

### 2.2 Proposal status

Used by `bug_proposal_id`, `manual_test_proposal_id` and `testbench_backlog_id` records.

| Status | Definition | Set by |
|---|---|---|
| `proposed` | Created by the agent, not yet looked at by a person. | Agent |
| `under_review` | A person is assessing it. | Human or TestBench |
| `accepted` | A person accepted it. | Human or TestBench |
| `rejected` | A person rejected it. | Human or TestBench |
| `duplicate` | A person marked it as a duplicate of another item. | Human or TestBench |
| `needs_information` | A person asked for more information. | Human or TestBench |

Hard rules:
- The agent creates every proposal with status `proposed` and never changes it.
- The agent never sets `under_review`, `accepted`, `rejected`, `duplicate` or `needs_information`.
  If it suspects a duplicate it sets `possible_duplicate_of` on the proposal and leaves the status.
- A delivered package contains only `proposed` proposals.

### 2.3 Reason codes

Required `reason` for `blocked`, `skipped` and `inconclusive` executions:

| Code | Use with | Meaning |
|---|---|---|
| `environment` | blocked | Target unavailable, wrong build, service down. |
| `access` | blocked | No login, permission or network access. |
| `test-data` | blocked | Required data missing or in the wrong state. |
| `dependency` | blocked | Another system or earlier step failed. |
| `tooling` | blocked, inconclusive | Selector, timeout, fixture or tool problem not yet traced to the product. |
| `needs-clarification` | skipped | The requirement has no measurable acceptance criteria. |
| `manual-only` | skipped | Can only be checked by a person. A manual test proposal is created. |
| `out-of-scope` | skipped | Excluded by the task. |
| `not-applicable` | skipped | The check does not apply. The explanation is in the record. |
| `insufficient-evidence` | inconclusive | Observation does not support `pass` or `fail`. |
| `needs-design-reference` | inconclusive | Visual check without a design reference to compare against. |

### 2.4 Requirement readiness

Not an execution status. Each requirement in the manifest has `readiness`:
`ready` (has measurable acceptance criteria) or `needs-clarification` (has not).
A `needs-clarification` requirement gets no `pass` or `fail` execution. Its plan items are
`skipped` with reason `needs-clarification`.

### 2.5 Legacy mapping (historical data only)

**This mapping is only for interpreting historical imports or reports. It MUST NOT be used to assign a status to a
new finding.** Older reports in this repository use other words. None of them is valid in a new package.

| Older value | Contract value |
|---|---|
| Pass, Passed | `pass` |
| Fail, Failed | `fail` |
| Blocked | `blocked` |
| Not tested | `skipped` (with reason) |
| Not applicable | `skipped` with reason `not-applicable` |
| Needs review | `inconclusive` |
| Confirmed defect (finding) | bug proposal with status `proposed` |

## Terminology rule

The agent MUST use `proposed` for all newly created bug and manual-test
proposals.

The terms `confirmed`, `verified`, `approved`, and `closed` describe human
review or defect-lifecycle decisions. The agent MUST NOT apply them to its own
proposals.

The legacy mapping is for interpreting historical data only. It MUST NOT be
used to assign a status to a new finding.

## Verified results versus verified proposals

The term `verified` has two distinct uses:

1. **Verified test result**
   A test execution has objective evidence showing that an expected behavior
   was not met. This may be described as a `verified fail` or a
   `verified deviation`.

2. **Verified proposal or fix**
   A human reviewer has reviewed evidence, reproduced or assessed the issue,
   and made a decision. This may result in statuses such as `accepted`,
   `rejected`, or `closed`.

The agent MAY produce a `verified fail` or `verified deviation` when the
required evidence supports the test result.

The agent MUST NOT mark its own bug proposal, manual-test proposal, severity
assessment, priority assessment, or remediation as `verified`, `approved`, or
`closed`.

All new bug and manual-test proposals MUST use the proposal status `proposed`.

## 3. Severity, confidence and reproduction

Defined in `../bug-reporting/templates/bug-report.md` and not repeated here. Product severity,
agent confidence and reproduction rate are separate from execution status and from any automated
tool impact (for example axe `impact`), which is stored as its own field.

## 4. Evidence

### 4.1 Evidence types

| Type | What it is | Typical file |
|---|---|---|
| `screenshot` | Image of the page or element | `.png` |
| `video` | Recording of an interaction | `.webm`, `.mp4` |
| `console-log` | Browser console output | `.txt`, `.log` |
| `network-trace` | Requests and responses, status codes, timings | `.json`, `.har`, `.txt` |
| `dom-excerpt` | Relevant DOM or accessibility-tree fragment | `.html`, `.yml`, `.txt` |
| `axe-result` | Output of an axe-core scan | `.json` |
| `design-reference` | The design or requirement text the result was compared with | link or file |
| `test-output` | Output of a test run or measurement (reporter output, measured values) | `.txt`, `.json` |

### 4.2 Evidence object

Each evidence object (in `manifest.json` under `evidence`) has:

| Field | Required | Description |
|---|---|---|
| `evidence_id` | always | `EV-<nnn>` |
| `type` | always | One of the types above. |
| `source` | always | How it was obtained: `playwright-mcp`, `playwright-test`, `axe-core`, `user-supplied`, `design-system`, `other`. |
| `location` | always | A path relative to the package root (files in `evidence/`) or a URL. |
| `related` | always | Array of `execution_id`, `bug_proposal_id` or `manual_test_proposal_id` the evidence supports. At least one. |
| `captured_at` | when relevant | ISO 8601 UTC. Required for everything captured at run time. May be omitted for `design-reference`. |
| `description` | always | One line: what the evidence shows. |
| `viewport` | when relevant | `{ "width": 375, "height": 812 }` for visual and responsive evidence. |
| `redacted` | always | `true` if secrets or personal data were removed or masked, otherwise `false`. |

Rules:
- Evidence never contains passwords, tokens, API keys, cookies or personal data. Redact before saving,
  or do not save it. Do not copy the value into a report to explain a redaction.
- A file in `evidence/` that no evidence object points to is an error, and so is an object pointing to a missing file.
- Do not reference screenshots that were not saved. Evidence paths in `report.md` are relative to `report.md`.
- `axe-result` evidence keeps rule ID, WCAG tags, tool impact and element locators. HTML snippets are left out unless
  needed to understand the finding.

### 4.3 Evidence integrity

Once an evidence object has been created:

- Do not rename, overwrite, delete, or replace its referenced file.
- Do not change `captured_at` to a time other than the actual capture time.
- If a filename is misleading, retain the original file and create a new,
  correctly named evidence object only when a new capture or verified copy is
  available.
- Record any correction in the evidence description, limitations, or report;
  do not silently alter historical evidence.
- A copied or merged file MUST NOT receive a fabricated `captured_at`.

## 5. Audit package

The package is one folder named after the `audit_id`:

```
<audit_id>/
  manifest.json
  report.md
  bugs.json
  manual-tests.json
  evidence/
```

### 5.1 `manifest.json`

| Field | Description |
|---|---|
| `audit_id`, `contract_version`, `created_at` | Identity and version. |
| `agent` | `{ "name", "model" }`. |
| `target` | `{ "url", "environment", "build" }`. Unknown values are `null`, not guessed. |
| `scope` | Confirmed audit scope object. See section 5.6. |
| `requirements[]` | `{ requirement_id, title, source, readiness, acceptance_criteria }`. `source` is `testbench` or `local`. |
| `test_plan_items[]` | `{ test_plan_item_id, requirement_id, title, risk, priority, type, readiness }`. |
| `executions[]` | `{ execution_id, test_plan_item_id, requirement_id, status, reason, started_at, finished_at, url, viewport, mode, evidence_ids[], summary }`. `mode` is `mcp-exploration` or `saved-test`. |
| `actions[]` | State-changing actions performed during the audit. See section 5.8. Added in 1.2. |
| `evidence[]` | Evidence objects (section 4.2). |
| `coverage_gaps[]` | `{ coverage_gap_id, requirement_id, description }` for what was not verified. |
| `testbench_backlog[]` | `{ testbench_backlog_id, kind, title, rationale, status }`. See section 8. |
| `limitations[]` | Text. |
| `external_actions` | Must be `[]`. See section 7. |
| `validation` | `{ validated_at, contract_version, result, errors[] }` with `result` of `pass` or `fail`. |
| `delivery` | Delivery record. See section 5.7. |
| `human_review` | `{ required: true, status }`. The agent creates `status: "pending"` and never changes it. A person or TestBench may later set `in_review`, `completed` or `rejected`. |

### 5.2 `bugs.json`

An array. Each element is one bug proposal. The fields are the sections of
`../bug-reporting/templates/bug-report.md` in snake case, plus `bug_proposal_id`, `finding_category`
(`functional`, `visual` or `accessibility`), `execution_ids[]` and `evidence_ids[]`, plus the duplicate-check
fields below. `status` is `proposed`. Every proposal is also written out in `report.md` using the template.

Duplicate-check fields on each bug proposal:

| Field | Value |
|---|---|
| `possible_duplicate_of` | Existing bug identifier, or `null`. |
| `duplicate_check` | `not_available`, `no_match`, `possible_match` or `uncertain_match`. |
| `duplicate_check_notes` | Text: the matching evidence and the differences. Optional. |

Rules:
- No bug data: `duplicate_check` is `not_available` and `possible_duplicate_of` is `null`.
- No plausible match: `duplicate_check` is `no_match` and `possible_duplicate_of` is `null`.
- Plausible match: `duplicate_check` is `possible_match` and `possible_duplicate_of` is the existing bug identifier.
- Uncertain match: `duplicate_check` is `uncertain_match`, the status stays `proposed`, and `possible_duplicate_of`
  is the most likely existing bug identifier.
- The agent MUST NOT set the proposal status to `duplicate`.

### 5.3 `manual-tests.json`

An array. Each element: `manual_test_proposal_id`, `title`, `requirement_id`, `objective`, `steps[]`,
`expected_result`, `origin`, `reason_manual`, `evidence_ids[]` (may be empty) and `status` (`proposed`).
`origin` is an object: `{ "type": "execution | bug_proposal | coverage_gap", "id": "..." }`, where `id` is the
`execution_id`, `bug_proposal_id` or `coverage_gap_id` it comes from.

### 5.4 `report.md`

Headings, in this order: Summary, Scope and environment, Requirements and readiness, Execution results,
Bug proposals, Manual test proposals, Coverage gaps and not verified, Limitations, TestBench backlog,
Evidence index, Human review handover.

The summary uses the execution statuses of section 2.1 and never combines `blocked`, `skipped` or
`inconclusive` into `pass` or `fail`. Automated scans that find nothing are described as:
"No violations were detected by the configured automated checks in the tested states.
This does not establish WCAG 2.1 AA conformance."

### 5.5 `evidence/`

Files referenced by evidence objects whose `location` is a path. Use descriptive names:
`<area>-<issue>-<yyyy-mm-dd>.<ext>`.

### 5.6 Audit scope

The `scope` object in `manifest.json` is the scope the user confirmed before the test plan was created.

| Field | Description |
|---|---|
| `objective` | Text: what the audit is meant to find out. |
| `target` | `{ url, environment, build }`. Unknown values are `null`, not guessed. |
| `included_requirement_ids` | Array of `requirement_id`. |
| `excluded_requirement_ids` | Array of `requirement_id`. |
| `allowed_check_types` | Array of the `Test type` values of the test plan that may be run. |
| `viewports` | Array of `{ width, height }`. |
| `state_changes` | `{ allowed, allowed_actions[], constraints }`. `allowed` is `true` or `false`. `allowed_actions` is an array of action objects. Each object MUST contain `action`, `limit` and, when relevant, `data`. `constraints` is text. |
| `test_data_constraints` | Text. |
| `out_of_scope` | Array of text: known out-of-scope areas. |
| `stop_conditions` | Array of text: the conditions on which the agent pauses and asks. |
| `confirmed_at` | ISO 8601 UTC. |
| `confirmed_by` | Name or identifier of the person who confirmed. |

Each `allowed_actions` object MUST state:

- `action`: the permitted action.
- `limit`: whether the action may be performed once per audit, once per
  viewport, once per test plan item, or another explicit limit.
- `data`: exact permitted test data, when applicable.

Example:

```json
{
  "action": "add_todo",
  "limit": "one per viewport",
  "data": "QA-AUDIT-1"
}
```

A limit MUST be explicit. Do not interpret a per-audit limit as a per-viewport
limit, or a per-viewport limit as a per-audit limit.

All fields are required. A change of scope needs new confirmation (V-26).

### 5.7 Delivery record

The `delivery` object in `manifest.json` records the delivery attempt to TestBench.

| Field | Description |
|---|---|
| `status` | `not_delivered`, `delivered`, `failed` or `not_configured`. |
| `delivered_at` | ISO 8601 UTC, or `null`. |
| `method` | How delivery was done (integration or endpoint kind), or `null`. |
| `target` | Where it was delivered, or `null`. |
| `request_reference` | Reference to the request, or `null`. |
| `response_reference` | Reference in the response from the integration, or `null`. |
| `error` | Error summary when delivery failed, otherwise `null`. |

Rules:
- `delivered` requires confirmation from the configured TestBench integration.
- A package validation result of `pass` does not imply `delivered`.
- `failed` means a delivery attempt was made but not accepted.
- `not_configured` means no TestBench delivery path is configured.
- Use `null` for unknown optional values. Do not guess.

### 5.8 Performed actions

`manifest.actions[]` records every state-changing action performed during the
audit.

Each entry MUST contain:

```json
{
  "action_id": "ACT-<nnn>",
  "execution_id": "EX-<nnn>",
  "action": "string",
  "target": "string",
  "allowed_by_scope": true,
  "performed_at": "ISO 8601 UTC",
  "evidence_ids": []
}
```

Rules:
- `action_id` uses the format `ACT-<nnn>` and is unique within the package.
- `action` MUST match an action listed in
  `scope.state_changes.allowed_actions`.
- `allowed_by_scope` MUST be `true`.
- `performed_at` MUST be the actual time the action was performed.
- Read-only checks do not need an action entry.
- If a state-changing action is attempted but not completed, record it as an
  execution with the appropriate `blocked`, `inconclusive` or `fail` status.
  Do not create an action entry for an action that was not performed.

## 6. Validation rules

An audit package is complete only if all rules pass. Record the result in `manifest.json` `validation`.
A package with `result: "fail"` is not delivered.

**Package**
- V-01 The folder contains `manifest.json`, `report.md`, `bugs.json`, `manual-tests.json` and `evidence/`.
- V-02 The JSON files parse. `audit_id` matches the folder name and the format in section 1.
  `contract_version` equals the version of this file.

**Identifiers and links**
- V-03 Every ID matches its format and is unique within the package.
- V-04 Every ID that is referenced exists in the package.
- V-05 Every test plan item has a `requirement_id` and a `test_plan_item_id`. Every execution has a
  `requirement_id` and a `test_plan_item_id`, and both resolve to the same requirement.
- V-06 Requirements with `readiness: "needs-clarification"` have no `pass` or `fail` execution.

**Statuses**
- V-07 Every execution status is one of the five in section 2.1.
- V-08 Every `blocked`, `skipped` and `inconclusive` execution has a `reason` from section 2.3.
- V-09 Every `pass` and `fail` execution has at least one `evidence_id`. Every `fail` names the violated criterion.
- V-10 No bug proposal rests only on `blocked`, `skipped` or `inconclusive` executions. Each has at least one
  `fail` execution in `execution_ids`.
- V-11 No summary in `report.md` or the manifest counts `blocked`, `skipped` or `inconclusive` as `pass` or `fail`.
- V-12 Every bug proposal, manual test proposal and TestBench backlog item has status `proposed`.

**Evidence**
- V-13 Every evidence object has the fields required in section 4.2 and a type from section 4.1.
- V-14 Every finding (bug proposal) has at least one `evidence_id`. Every evidence ID it lists exists.
- V-15 Every file location resolves inside `evidence/`. Every file in `evidence/` is referenced by at least one
  evidence object. One evidence object may support multiple executions, bug proposals or manual test proposals
  through `related`.
- V-16 Timestamps are ISO 8601 UTC. Run-time evidence has `captured_at`
  matching the actual capture time. Evidence files referenced by an evidence
  object MUST NOT be renamed, overwritten, replaced, or given a fabricated
  timestamp after registration.
- V-17 No evidence file or report text contains a password, token, API key, cookie or personal data.
  Check for these patterns before delivery and fix, do not just note.

**Content**
- V-18 Every bug proposal contains all sections of `bug-report.md`, non-empty. `Reproduction rate` may be
  `Not reproduced` but not empty.
- V-19 Every manual test proposal has objective, steps and expected result.
- V-20 Counts in `report.md` match `manifest.json`, `bugs.json` and `manual-tests.json`.
- V-21 `external_actions` is `[]`. `human_review.status` is `pending`.
- V-22 Every need for a new TestBench field or endpoint is a `testbench_backlog` item and not a workaround in the package.

**Scope, delivery and duplicates**
- V-23 `scope` exists and contains all required fields (section 5.6).
- V-24 Every execution and test plan item `requirement_id` is included in `scope.included_requirement_ids`.
- V-25 Every recorded state-changing action MUST have `allowed_by_scope: true`
  and MUST correspond to an action listed in
  `scope.state_changes.allowed_actions`.
- V-26 A scope change requires new user confirmation and is recorded in the manifest (as an entry in `limitations[]`
  stating the change and its new confirmation) and in `report.md`.
- V-27 `delivery.status` is one of the four allowed values (section 5.7).
- V-28 `delivery.status` of `delivered` requires a request or response reference from the configured integration.
- V-29 Every bug proposal has `duplicate_check` and a consistent `possible_duplicate_of` value (section 5.2).
- V-30 Every state-changing action recorded in `manifest.actions[]` MUST have
  an `action_id`, `execution_id`, `action`, `target`, `allowed_by_scope`,
  `performed_at` and `evidence_ids`.
- V-31 Every `manifest.actions[]` entry MUST match an allowed action and limit
  in `scope.state_changes.allowed_actions`.
- V-32 Every evidence file referenced by an evidence object MUST retain its
  original filename and content after registration. A renamed, overwritten or
  replaced evidence file is a validation failure.

## 7. Agent boundaries

The agent never, on its own:
- closes bugs or changes the status of any item except to create it as `proposed`,
- approves, accepts or rejects its own proposals,
- creates Linear, Jira or other external tickets,
- changes production data (a read-only check is preferred, and state-changing checks need explicit approval),
- merges pull requests.

The only outward step is delivering a validated package to TestBench through the delivery path
the project has configured. If there is none, the package stays local and the gap becomes a
TestBench backlog item. Anything the agent would have done in one of the forbidden ways is
written in the report as a recommendation for a person.

## 8. TestBench backlog

When the audit needs something TestBench does not provide, such as a field in the data model, an endpoint,
a status or a delivery method, the agent does not work around it and does not invent an interface.
It adds a `testbench_backlog` item:

| Field | Description |
|---|---|
| `testbench_backlog_id` | `TBB-<nnn>` |
| `kind` | `field`, `endpoint` or `other` |
| `title` | One line. |
| `rationale` | What was needed, what happened without it. |
| `status` | `proposed` |

These items are listed in `report.md` under "TestBench backlog" and are kept apart from bug proposals.
