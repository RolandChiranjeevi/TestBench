---
name: functional-test-runner
description: Executes planned test cases one at a time in a real browser using Playwright MCP, records an execution status of pass, fail, blocked, skipped or inconclusive with evidence, and hands each fail that has supporting evidence to the bug-reporting workflow. Use when the user asks to run an existing test plan. Called by qa-run in step 3.
---

# Skill: Functional Test Runner

Use this skill to execute planned test cases in a real browser.

Identifiers, statuses, reason codes and evidence types are defined in `../references/audit-contract.md`.
Use them as written. Do not define your own. Paths are relative to this `SKILL.md`.

## Tools
Use available Playwright MCP browser tools.

## Scope alignment

Run only test plan items whose `requirement_id` is listed in the confirmed
audit scope's `included_requirement_ids`.

Use only check types allowed by `scope.allowed_check_types`.

Do not perform a state-changing action unless it is explicitly listed in
`scope.state_changes.allowed_actions`.

If a planned item is outside the confirmed scope, record it as `skipped` with
reason `out-of-scope` and explain why. Do not silently expand the audit.

When a scope limit is ambiguous, ask the user before performing the action.

Record every completed state-changing action in `manifest.actions[]` using the
format defined in contract section 5.8.

## Workflow
1. Read the test plan. Run only items with a `requirement_id` and a `test_plan_item_id`.
   Items for `needs-clarification` requirements are recorded as `skipped` with that reason.
2. Open the application and confirm the environment, login and test data.
3. Execute items one at a time.
4. After each item, create an execution record:
   - `execution_id`, `test_plan_item_id`, `requirement_id`
   - `status` (contract section 2.1) and, where required, `reason` (section 2.3)
   - URL, viewport, start and end time in UTC, and mode (`mcp-exploration` or `saved-test`)
   - `evidence_id`s, with console and network errors as `console-log` and `network-trace` evidence
   - Summary: what was verified and what was not
5. If login, test data or environment is missing, pause and ask the user.

   Record affected test plan items that will not be executed in this audit as
   `blocked`, using the matching reason code from contract section 2.3.

   If the problem prevents continuation of the entire run, stop the run, retain
   the confirmed scope and completed results, and ask the user whether to resume,
   change the scope, or abandon the run. Do not automatically mark every remaining
   plan item as `blocked`.

   Do not classify unresolved environment or access problems as product defects.

## Choosing the status

| Status | Use when |
|---|---|
| `fail` | The executed check produced objective evidence that an expected behavior or acceptance criterion was not met. |
| `blocked` | The check **could not run** because of environment, access, test data or a dependency. |
| `inconclusive` | The check ran but the evidence is not enough for `pass` or `fail`. |
| `pass` | The check ran and the evidence meets the acceptance criterion. |
| `skipped` | The check was deliberately not run, with a reason. |

Use `verified deviation` only as descriptive language when evidence supports the difference between expected and
actual behavior. Do not use `verified` as a proposal status.

Before recording `fail`:
1. Compare the observed result with the acceptance criterion in the requirement.
2. Repeat the check once more, or by another route, to see whether it reproduces.
   Record each attempt as its own execution with a new `execution_id`, its own
   status, evidence and summary. Note the relationship between the attempts in the
   execution summaries.
3. Check that the cause is not the test: wrong selector, timing, fixture, stale data, expired session.

A failing selector, a timeout or a broken fixture is **not** a product bug. Record it as `blocked` with reason
`tooling` if the check could not run, or `inconclusive` with reason `tooling` if it ran and the result is unclear.
Look into the cause first. Only if the behaviour is then verified against the requirement does it become `fail`.

Never report `blocked` as `fail`.

## Failure handling
For each `fail`:
1. Capture a screenshot immediately.
2. Capture relevant console and network errors.
3. Save evidence under `evidence/` and register each file as an evidence object.
4. Call the bug-reporting workflow (`../bug-reporting/SKILL.md`) with the `execution_id`.

For `blocked` and `inconclusive`, save evidence of the cause and say what is needed to continue. Do not create a
bug proposal from them.

Evidence `location` in `manifest.json` is relative to the audit package root,
for example `evidence/checkout-empty-cart-error-2026-11-02.png`.

Markdown links in `report.md` are relative to `report.md`.

Once an evidence object has been created, do not rename, overwrite, replace or
delete its referenced file. Do not change `captured_at` to a time other than
the actual capture time.

## Do not
- Mark something `pass` that was only partly checked. Say what was and was not verified.
- Retry until a check turns green and record only the last run. Each run is its own `execution_id`.
- Change data in a production environment, or run state-changing checks without approval.
