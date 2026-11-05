# Test Plan: Decathlon & Heptathlon scoring app

Identifiers and values follow `../.claude/skills/references/audit-contract.md` (contract version 1.2).

Audit: `AUD-20261105-01`. Status of this plan: **approved by the user**. State-change limits and Export CSV (max 2, only from `TP-AUD-20261105-01`) confirmed. Clarifications for REQ-LOCAL-003, 004 and 006 added; TPI-008, TPI-009 and TPI-012 are now runnable.

## Scope
- Target: `http://localhost:8080`, local environment, build unknown.
- Objective: check the core flows (add competitor, enter result, standings and ranking, CSV export) against REQ-LOCAL-001 to REQ-LOCAL-007.
- Allowed check types: Functional, Responsive, Accessibility, Validation (added for TPI-012; keyboard and accessibility-tree spot-checks only). Mode: `mcp-exploration`.
- Viewports: 1440×900 (main run), 768×1024 and 375×812 (TPI-007 only).
- State changes: only inside the competition `TP-AUD-20261105-01`. Allowed actions and limits are in the table under Assumptions.
- Included requirements: REQ-LOCAL-001 to REQ-LOCAL-007 (all seven, as requested). Excluded: none.

## Out of scope
- Save state, Load state (not approved).
- Rename competition, dark mode toggle, performance, cross-browser, server-side validation, security testing.
- Writing to any competition whose name does not start with `TP-`. The default "General · Mixed" is never written to.

## Assumptions
- Requirements are user-supplied (`source: local`), not registered in TestBench.
- Readiness was assessed by the agent from the requirement wording. No requirement came with an explicit acceptance criterion. Criteria below restate the observable outcome of the requirement text and add nothing. **Please confirm or correct them.**
- Test data are local-only and disposable.
- Heights of the viewports (900, 1024, 812) are the agent's choice. Widths are the agreed defaults.
- Proposed state-change limits. These are not yet confirmed. Execution does not start until they are.

| action | limit | data |
|---|---|---|
| `create_competition` | once per audit | `TP-AUD-20261105-01` |
| `add_competitor` | once per listed name, 9 in total per audit | `TP-Anna`, `TP-Bo`, `TP-Cia`, `TP-Dan`, `TP-V768`, `TP-V375`, `TP-Key`, `TP-Csv, Comma`, `TP-Csv "Quote"` |
| `save_result` | at most 20 per audit | values listed per plan item |
| `export_csv` | at most 2 per audit (one per tab), only from `TP-AUD-20261105-01`. Writes a local file, no app state. Needs approval. | none |

## Requirements and readiness

| requirement_id | Title | Source | Readiness | Acceptance criteria |
|---|---|---|---|---|
| REQ-LOCAL-001 | A user can add a participant with a name | local | ready | After adding a participant with a name, that name is shown in the app (competitor selector or standings). |
| REQ-LOCAL-002 | A user can register a result per event | local | ready | A result saved for a participant and an event is shown for that participant under that event. |
| REQ-LOCAL-003 | Points are calculated per the current Decathlon/Heptathlon tables | local | ready | Points equal the World Athletics (IAAF) scoring-table value per event and result. A deviation is a finding. (User clarification.) |
| REQ-LOCAL-004 | The table shows total points and placement per event | local | ready | Rank within each event, plus total and total position. (User clarification.) |
| REQ-LOCAL-005 | Ties share a placement | local | ready | Participants with equal totals show the same position. The position that follows a tie is not specified and is not judged. |
| REQ-LOCAL-006 | Invalid results are rejected with a clear error message | local | ready | Negative, non-numeric, empty and unreasonable values are rejected with a clear message and not saved. (User clarification.) |
| REQ-LOCAL-007 | Export CSV contains the same data as the table | local | ready | The exported CSV contains every participant, total, position and event value shown in the table. Column order and format are not specified and are not judged. |

## Test plan items

Order of the table is the proposed execution order. All items use `mcp-exploration`. No `saved-test` is planned.

| test_plan_item_id | requirement_id | Title | Risk | Priority | Test type | Preconditions | Test data | Steps | Acceptance criteria | Automation |
|---|---|---|---|---|---|---|---|---|---|---|
| TPI-001 | REQ-LOCAL-001 | Add one participant with a plain name | High: the whole app depends on it, and it is the base for all later checks | High | Functional | Competition `TP-AUD-20261105-01` exists and is selected (created in setup, recorded as an action) | `TP-Anna` | 1. Confirm the selected competition name starts with `TP-`. 2. Type the name in "Name". 3. Click "Add competitor". 4. Observe the competitor selector, standings, console and network. | The name `TP-Anna` is shown in the app. | Yes, mcp-exploration |
| TPI-002 | REQ-LOCAL-001 | Add several participants (count 0, 1, many) | Medium: list handling and counters | High | Functional | TPI-001 done | `TP-Bo`, `TP-Cia` | 1. Add each name in turn. 2. Observe that every name is shown and the tab counters match what is listed. | All three names are shown. Counters are recorded as observation, not judged. | Yes, mcp-exploration |
| TPI-003 | REQ-LOCAL-001 | Add a participant with the keyboard only | Medium: no mouse use, with accessibility-tree names recorded | Medium | Accessibility | Competition selected | `TP-Key` | 1. Tab to "Name", type the name. 2. Press Tab to reach "Add competitor" and Enter. 3. Record focus order, visible focus and the accessible names of the controls from the snapshot. | The name `TP-Key` is added using only the keyboard. Other observations are heuristic-based and recorded, not judged. | Yes, mcp-exploration |
| TPI-004 | REQ-LOCAL-002 | Save a valid time result (100m, Decathlon) | High: core entry flow | High | Functional | `TP-Anna` exists | `TP-Anna`, Decathlon, 100m, `11.00` | 1. Select competitor, discipline, event. 2. Enter the result. 3. Click "Save score". 4. Observe the 100m column in the row, console and network. | `11.00` is shown for `TP-Anna` under 100m. | Yes, mcp-exploration |
| TPI-005 | REQ-LOCAL-002 | Save a valid result in another event type (Long Jump, Decathlon) | Medium: a different unit and input format | High | Functional | `TP-Bo` exists | `TP-Bo`, Decathlon, Long Jump, `7.00` (unit as labelled in the UI) | As TPI-004 for Long Jump. | `7.00` is shown for `TP-Bo` under Long Jump. | Yes, mcp-exploration |
| TPI-006 | REQ-LOCAL-002 | Save a valid result in the Heptathlon discipline | Medium: a separate event list and tab | Medium | Functional | `TP-Dan` exists | `TP-Dan`, Heptathlon, first listed event, plausible value chosen from the UI unit | 1. Select Heptathlon and the first event. 2. Enter the result and save. 3. Open the Heptathlon tab. | The value is shown for `TP-Dan` in the Heptathlon table under the chosen event. | Yes, mcp-exploration |
| TPI-007 | REQ-LOCAL-002 | Result entry at 768 and 375 px | Medium: forms and a wide table on small screens | Medium | Responsive | `TP-V768` and `TP-V375` exist (each added at its own viewport) | `TP-V768`, `TP-V375`, Decathlon, 100m, `11.00` | 1. Resize to the viewport. 2. Add the competitor and save the result as in TPI-001 and TPI-004. 3. Check for page-level horizontal scroll, clipped or overlapping controls and that the form stays operable. | The result is saved and shown at each viewport. Layout observations are heuristic-based. Without a design reference they are recorded as risks, not defects. | Yes, mcp-exploration |
| TPI-008 | REQ-LOCAL-003 | Points per event equal World Athletics table values | High: core logic | High | Functional | Participants and results from TPI-004, TPI-005, TPI-006 exist. Two extra saves are made here: 400m and Shot Put. | Expected (INT of formula): Decathlon 100m 11.00 = 861, Long Jump 7.00 m (700 cm) = 814, 400m 50.00 = 815, Shot Put 14.00 = 728. Heptathlon 100m Hurdles 14.00 = 978. | 1. Read the points the app shows for each saved result. 2. Compare with the expected value. 3. Record the calculation for any deviation. | The app's points equal the expected value for every compared result. A deviation is a finding with the calculation and the expected value. | Yes, mcp-exploration |
| TPI-009 | REQ-LOCAL-004 | Rank within each event, plus total and total position | Medium | Medium | Functional | TPI-004, TPI-005, TPI-010 done. One extra save: `TP-Bo` 100m 10.50 (expected 975 points). | 100m: `TP-Bo` 10.50, `TP-Anna` 11.00, `TP-Cia` 11.00, `TP-V768` and `TP-V375` 11.00 | 1. Read the table for rank within the 100m event and within Long Jump. 2. Read Total and Pos. | Rank within an event is shown per event. `TP-Bo` ranks first in 100m (fastest). Total and total position are also shown. How the table presents event rank is recorded. | Yes, mcp-exploration |
| TPI-010 | REQ-LOCAL-005 | Two participants with equal totals share a position | High: ranking correctness | High | Functional | `TP-Anna`, `TP-Cia` exist. Only one result each. | 100m `11.00` for both | 1. Save 100m `11.00` for `TP-Cia` (`TP-Anna` has it from TPI-004). 2. Read Pos and Total for both rows. | Both show the same total and the same position. | Yes, mcp-exploration |
| TPI-011 | REQ-LOCAL-005 | A participant with a different total is not given the tied position | Medium: neighbouring case of ties | Medium | Functional | TPI-010 done | `TP-Bo` already has Long Jump `7.00` from TPI-005, so no new data. Observation only. | 1. Read Pos and Total for all participants in the Decathlon tab. 2. Record the position that follows a tie. | Participants with a different total do not show the tied position. The position number after a tie (for example 3 or 2) is recorded and not judged. | Yes, mcp-exploration |
| TPI-012 | REQ-LOCAL-006 | Invalid results rejected with a clear message and not saved | High | High | Validation | `TP-Dan` or `TP-Key` selected, Decathlon, 100m. Attempts count against the 20-save limit. | Negative `-1`, non-numeric `abc`, empty value, unreasonable `0.5` (100m) and `99999` | 1. Try each value with Save score. 2. Read the message. 3. Check the table and counters for an unsaved result. | Each value is rejected with a clear error message and nothing is saved. | Yes, mcp-exploration |
| TPI-013 | REQ-LOCAL-007 | Export CSV from the Decathlon tab matches the table | High: data integrity between table and export | High | Functional | TPI-001 to TPI-006, TPI-010 done. **Needs approval to run Export CSV.** | The data created by the earlier items | 1. Click "Export CSV" on the Decathlon tab. 2. Save the file as evidence. 3. Compare each table row and column to the CSV content. | Every participant, total, position and event value in the table is in the CSV. | Yes, mcp-exploration |
| TPI-014 | REQ-LOCAL-007 | CSV keeps names with comma and quote intact | Medium: delimiter and quote handling | Medium | Functional | TPI-013 done. **Needs approval to run Export CSV.** | `TP-Csv, Comma`, `TP-Csv "Quote"` | 1. Add the two names. 2. Save one result each. 3. Export CSV and parse the file with a CSV parser. | The names parsed from the CSV equal the names in the table. | Yes, mcp-exploration |

## Heuristics used
Heuristics are test ideas, not requirements. Checks that come from them are linked to the requirement they concern and are described as heuristic-based.
- CRUD / Follow the data: TPI-001, TPI-004, TPI-013 (enter, store, display, export).
- Count 0, 1, many: TPI-001, TPI-002 (empty state seen during discovery).
- Best representative / broader partitioning: TPI-004 and TPI-005 pick one time event and one distance event instead of all 17 events.
- Quicktest "Boundary / Delimiters" (data attacks, strings): TPI-014.
- Responsive widths 375 and 768, and the page-level horizontal scroll check: TPI-007.
- Accessibility keyboard order and accessible names from the accessibility tree: TPI-003.
- Check console and network after each action (Test design heuristics, Observations): all executed items.

## Coverage gaps
Each gap states what is not verified and why. Manual test proposals for these are created later, after execution.

| coverage_gap_id | requirement_id | Not verified, and why |
|---|---|---|
| CG-004 | REQ-LOCAL-005 | The position that follows a tie. The requirement does not say. It is recorded in TPI-011 and not judged. |
| CG-005 | REQ-LOCAL-001 | Blank, duplicate, very long and special-character names, and persistence after reload. No criterion, and `Validation` is not an allowed check type. Recommended scope change: add `Validation` once criteria exist. |
| CG-006 | REQ-LOCAL-002 | Results in the other events (all 10 decathlon and 7 heptathlon events), changing or overwriting an existing result, and persistence after reload. Only three representative events are planned. |
| CG-007 | REQ-LOCAL-007 | CSV from the Heptathlon tab, the CSV column format and order, and Save state / Load state. Format is not specified, and Save and Load are out of scope. |
| CG-008 | REQ-LOCAL-002 | Create and Rename competition, the dark mode toggle, and the "Actions" column in the table. No requirement covers them. Create competition is used only as setup. |
| CG-009 | REQ-LOCAL-001 | Server-side behaviour and where the data is stored. Only client-side behaviour in the browser is observed. |

## Test data
- Competition: `TP-AUD-20261105-01`.
- Names: `TP-Anna`, `TP-Bo`, `TP-Cia`, `TP-Dan`, `TP-V768`, `TP-V375`, `TP-Key`, `TP-Csv, Comma`, `TP-Csv "Quote"`.
- Results: 100m `11.00`, Long Jump `7.00`, one plausible Heptathlon value in the UI unit. All plausible for any definition of valid. No real personal data.

## Environments
- `http://localhost:8080`, local, build and version unknown. Browser: Playwright MCP.
- No login. No TestBench call has been made. Requirements are local.

## Risks
- The data may be stored in the browser (shared with other uses of this browser profile) or on a server. This is unknown. If the "General" list or any non-`TP-` competition shows real data, or a write goes outside `TP-AUD-20261105-01`, stop and ask.
- TPI-010 and TPI-011 depend on the app giving higher points to a faster 100m. This is not verified against any table.
- The state-change limits above are still proposed. The Export CSV approval is outstanding.
- No automated accessibility scan will be performed. Accessibility signals come from keyboard use and the accessibility tree. This does not establish WCAG 2.1 AA conformance.

## Clarifications confirmed by the user
- REQ-LOCAL-003: use the World Athletics (IAAF) scoring tables; compare with known reference values and report a deviation as a finding with the calculation and the expected value. The agent computes expected values with the published formula constants (as recalled by the agent, not read from the official document in this audit). `save_result` includes the extra saves TPI-008 and TPI-009 need, and attempted invalid saves in TPI-012 count against the limit of 20.
- REQ-LOCAL-004: "placement per event" is the rank within each event. Total and total position are also shown.
- REQ-LOCAL-006: invalid means negative, non-numeric, empty and unreasonable values per event. A clear message is shown and the result is not saved.
- Stop immediately on an unexpected error, data loss, or any write outside `TP-AUD-20261105-01`.
- Coverage gaps CG-001 to CG-003 were removed because the clarifications made the items runnable. Remaining gaps keep their IDs.

## Execution deviations (recorded after the run)
- Long Jump unit is cm in the app, so TPI-005 used `700` (7.00 m). Expected points 814 were unchanged.
- The competition `TP-AUD-20261105-01` was created as type Decathlon and its Discipline control is locked. TPI-006 (Heptathlon result) could not run and is `blocked` (test-data); the Heptathlon part of TPI-008 was not run (CG-010, CG-011). `TP-Dan` was never added.
- TPI-014 is `blocked` (test-data): the app rejects names with a comma or quote (CG-012). Only one of the two approved exports was used.
- Extra executions: EX-013 repeats TPI-009 after a reload and with the CSV; EX-016 repeats TPI-012 attempt 5.
- Results: pass 11, fail 4 (TPI-009 twice, TPI-012 twice), blocked 2. See `report.md`.
