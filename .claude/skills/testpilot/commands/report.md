# TestPilot: report

Turn the results of a run into findings and a package: analyse the executions,
create bug and manual-test proposals and build the audit package. Validation
against the contract is the next, separate step (audit flow step 9 in `SKILL.md`).

Input:
- audit ID (required), format `AUD-<YYYYMMDD>-<nn>`; it is also the package folder
  name

Paths in this file are relative to this file. The contract is
`../../references/audit-contract.md`.

Before the first step:

- `<audit-id>/manifest.json` must exist and hold the executions of the run
  (`executions[]`). If it does not, stop and tell the user to run `run` first.
- The stop conditions in `SKILL.md` apply during the whole report phase.

Flow:

1. Analyse the results.
2. Create bug proposals.
3. Propose manual test cases.
4. Build the audit package.

## 1. Analyse the results

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

## 2. Create bug proposals

Follow `../../bug-reporting/SKILL.md` for each `fail` that has evidence against its
requirement, and for each visual or accessibility finding that has evidence.

Use `../../bug-reporting/templates/bug-report.md` for all of them.

Status is `proposed`.

## 3. Propose manual test cases

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

## 4. Build the audit package

Complete the package folder `<audit_id>/` created before execution.

Ensure it contains:

```text
manifest.json
report.md
test-plan.md
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

`report.md` has a Test plan section after Requirements and readiness (contract 5.4). It lists the plan items and
coverage gaps of the manifest, in the manifest's order. Set `contract_version` to the version of
`../../references/audit-contract.md`.

When the package is built, tell the user that the next step is the validation
(audit flow step 9 in `SKILL.md`). Wait for the user's approval before starting it.
