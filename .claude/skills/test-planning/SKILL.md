---
name: test-planning
description: Creates QA test plans and test cases for a feature, user story, or acceptance criteria using the project's test plan template. Every plan item is linked to a requirement and carries risk, priority, test type, preconditions, test data and acceptance criteria. Use when the user asks for a test plan, test cases, or QA coverage.
---

# Skill: QA Test Planning

Use this skill when the user asks for a test plan, test cases, or QA
coverage for a feature, user story, or acceptance criteria. `qa-run` calls it in step 2 of the audit.

Identifiers, statuses and reason codes are defined in `../references/audit-contract.md`.
Use them as written. Do not define your own. Paths are relative to this `SKILL.md`.

## Workflow
1. Read the requirements, user story, acceptance criteria, designs, and existing tests.
2. Give each requirement its `requirement_id` (from the source, or `REQ-LOCAL-<nnn>` for a requirement the
   user supplied without one).
3. Decide each requirement's readiness:
   - `ready`: it has measurable acceptance criteria.
   - `needs-clarification`: it has none, or they cannot be measured.
   Do not guess criteria for a `needs-clarification` requirement. Mark it and ask for the missing information.
4. Read `../references/testheuristics.md`. Identify normal flows, edge cases, negative cases, permissions,
   data variations and regression risks by risk category. State which heuristics were used.
5. Create plan items. Each item gets a `test_plan_item_id` and exactly one `requirement_id`.
6. For each item record: risk, priority, test type, preconditions, test data, steps, acceptance criteria and
   whether it suits automation. These are fields of the plan item in `manifest.json` (contract section 5.9),
   not only columns of the template. Use the field names of the contract exactly (`test_data`,
   `acceptance_criteria`, not `testData` or free variants): Testbench ignores a name it does not know.
7. Create coverage gaps. Give each gap a `coverage_gap_id` in the format
   `CG-<nnn>`.

   Create a coverage gap for:
   - a requirement with no plan item
   - an acceptance criterion that no plan item covers
   - a check that requires a person and cannot be automated in this audit
   - a `needs-clarification` requirement

   Each gap MUST have:
   - `coverage_gap_id`
   - `requirement_id`
   - `description`

   The description MUST state what is not verified and why.
8. Fill in `templates/test-plan.md` and save it as `test-plan.md` in the audit package. It says the same as
   `manifest.test_plan_items[]` and `manifest.coverage_gaps[]`: every `test_plan_item_id` and every
   `coverage_gap_id` of the manifest appears in it, and no id that is not in the manifest (V-33). Write each
   coverage gap with its `coverage_gap_id`, not as a bare bullet.

## Plan item fields
| Field | Content |
|---|---|
| `test_plan_item_id` | `TPI-<nnn>` |
| `requirement_id` | The requirement it verifies. Required. |
| Risk | High / Medium / Low, with a short reason (impact and likelihood). |
| Priority | High / Medium / Low. Not the same as risk: priority is the order of execution. |
| Test type | Functional, Validation, Authorization, State, Concurrency, Responsive, Internationalisation, Accessibility, Performance, Visual. |
| `preconditions` | String. State, user, data and environment needed before step 1. Write `None` when there are none; never leave it empty. |
| `test_data` | String. Exact values or the rule for choosing them. `None` when there is no test data. No real personal data or secrets. |
| `steps` | Array of strings, one action per string, in order. |
| `acceptance_criteria` | String. The measurable condition for `pass`, taken from the requirement. For a check that comes only from a heuristic and has no criterion in the requirement, say so. |
| `automation` | Object, not text. `{ "suitable": true, "mode": "mcp-exploration" }` (`mode` is `mcp-exploration`, `saved-test` or `both`), or `{ "suitable": false, "reason": "..." }`. |

In the template's table, write `automation` as text (`Yes, saved-test` or `No: <reason>`); in the manifest it is the object.

A plan item for a `needs-clarification` requirement has no steps: `steps` is `[]`, `acceptance_criteria` says
what is missing, and it is run as `skipped` with reason `needs-clarification`. Do not invent steps or criteria for it.
A plan item for a `ready` requirement has at least one step and a non-empty value in every field above (V-34).

Keep the values within the limits of Testbench's import (contract section 9): `title` 200 characters, at most
50 steps of 1000 characters, `preconditions` and `acceptance_criteria` 5000, `test_data` 2000.

## Scope alignment

Create plan items only for requirements listed in the confirmed audit scope's
`included_requirement_ids`.

Use only check types allowed by `scope.allowed_check_types`.

Do not plan a state-changing action unless it is explicitly listed in
`scope.state_changes.allowed_actions`.

If a needed check is outside the confirmed scope, record it as a coverage gap
or recommend a scope change. Do not silently expand the audit.

## Rules
- Do not invent requirements or acceptance criteria. Ask first.
- Every plan item has a `requirement_id` and a `test_plan_item_id`.
- The plan is recorded in two places that agree: `manifest.test_plan_items[]` (the record) and `test-plan.md`
  (what a person reads). `report.md` repeats the plan in its Test plan section (V-35).
- Include boundary and negative tests.
- Keep each test case independently executable.
- Use the template exactly.
- Heuristics are test ideas, not requirements. A check that comes only from a heuristic is linked to the
  requirement it concerns, and is stated as heuristic-based.
