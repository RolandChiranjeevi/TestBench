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
   whether it suits automation.
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
8. Fill in `templates/test-plan.md`.

## Plan item fields
| Field | Content |
|---|---|
| `test_plan_item_id` | `TPI-<nnn>` |
| `requirement_id` | The requirement it verifies. Required. |
| Risk | High / Medium / Low, with a short reason (impact and likelihood). |
| Priority | High / Medium / Low. Not the same as risk: priority is the order of execution. |
| Test type | Functional, Validation, Authorization, State, Concurrency, Responsive, Internationalisation, Accessibility, Performance, Visual. |
| Preconditions | State, user, data and environment needed before step 1. |
| Test data | Exact values or the rule for choosing them. No real personal data or secrets. |
| Acceptance criteria | The measurable condition for `pass`, taken from the requirement. |
| Automation | Yes / No, with the reason if No. If Yes, state whether the check is intended as an `mcp-exploration` check, a `saved-test`, or both. |

A plan item for a `needs-clarification` requirement has no steps. It states what is missing and is run as
`skipped` with reason `needs-clarification`.

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
- Include boundary and negative tests.
- Keep each test case independently executable.
- Use the template exactly.
- Heuristics are test ideas, not requirements. A check that comes only from a heuristic is linked to the
  requirement it concerns, and is stated as heuristic-based.
