# Audit report: AUD-20261106-01

## Summary

Target: http://localhost:8080 (local, build unknown). Executions: 8 in total. **pass: 8, fail: 0, blocked: 0, skipped: 0, inconclusive: 0.** These counts are separate; blocked, skipped and inconclusive are never counted as pass or fail.

Test plan items run: TPI-001 to TPI-008 (8 items in the plan, all run).

- **Bug proposals:** 0. No execution failed and no finding had a requirement it could be checked against.
- **Manual test proposals:** 8 (MTP-001 to MTP-008), status `proposed`.
- **Coverage gaps:** 7.
- **TestBench backlog:** 0 items.

Findings in short:

1. REQ-LOCAL-001 (add a participant): TPI-001 to TPI-005 all `pass`: TP-Anna, TP-Bo, TP-Cia, TP-V375 and TP-Key were added and are shown; TP-Anna is kept after a reload; the keyboard-only path works.
2. REQ-LOCAL-002 (save a result): TPI-006 to TPI-008 all `pass`: 100m 11.50 s gave 753 points and Long Jump 680 cm gave 767 points (total 1520); the 100m result is kept after a reload. The points were not compared with a scoring table (CG-005).
3. Observation, not a finding: at 375x812 the page is wider than the viewport (scrollWidth 383, clientWidth 360) and the standings table extends past it. No requirement gives a layout criterion; see MTP-007.

Everything above is a proposal. Nothing has been accepted or closed; review is yours.

## Scope and environment

- Objective: Black-box check that a user can add participants and save results in the Decathlon & Heptathlon app (REQ-LOCAL-001 and REQ-LOCAL-002).
- Target: http://localhost:8080, environment local, build not known.
- Confirmed by: johan at 2026-11-06T13:19:21Z (proposed in `discover`, approved there, recorded when the user approved the test plan).
- Included requirements: REQ-LOCAL-001, REQ-LOCAL-002. Excluded: none.
- Allowed check types: Functional, State, Responsive, Accessibility. Mode: `mcp-exploration` only; no saved Playwright test.
- Viewports: 1440×900, 768×1024, 375×812 (1440×900 and 375×812 were used).
- State changes: allowed only in the competition TP-TPT-20261106. Actions used: create_competition 1 of 1, add_competitor 5 of 5, save_result 2 of 2.
- Out of scope: Save state and Load state; The existing competitions General and TP-AUD-20261105-01; Editing and removing competitors; Heptathlon; CSV export; Server-side validation, performance and security testing.
- Browser: Playwright MCP browser. TestBench: project 4 (TPT1106) has no requirements; the requirements are local (`REQ-LOCAL-<nnn>`, not registered in TestBench).

Stop conditions: Stop on an unexpected error, data loss, or any write outside the competition TP-TPT-20261106 (user, 2026-11-06); Stop on a server error (5xx) response; Pause and ask when a check would need data or an action that the scope does not allow. None occurred.

## Requirements and readiness

| requirement_id | Title | Source | Readiness | Acceptance criteria |
|---|---|---|---|---|
| REQ-LOCAL-001 | A user can add a participant to a competition | local (not registered in TestBench) | ready | After entering a name and clicking 'Add competitor', the competitor is shown as a row in the standings table of the selected competition, and is still shown after a page reload. |
| REQ-LOCAL-002 | A user can save a result for a participant | local (not registered in TestBench) | ready | For an existing competitor, selecting the event, entering a valid numeric result and clicking 'Save score' shows a success message without an error, and the competitor's row in the standings shows the result and the points for that event; the result is still shown after a page reload. |

The acceptance criteria were proposed by the agent from the user's goal ('testa att man kan lägga till deltagare och spara resultat') and confirmed by the user when approving the test plan.

## Test plan

| test_plan_item_id | requirement_id | Type | Risk | Priority | Readiness | Title |
|---|---|---|---|---|---|---|
| TPI-001 | REQ-LOCAL-001 | Functional | Medium | High | ready | Create the test competition and add TP-Anna (1440 px) |
| TPI-002 | REQ-LOCAL-001 | State | Medium | Medium | ready | TP-Anna is still there after a page reload |
| TPI-003 | REQ-LOCAL-001 | Functional | Low | Medium | ready | Add TP-Bo and TP-Cia, three rows in total |
| TPI-004 | REQ-LOCAL-001 | Responsive | Medium | Medium | ready | Add a competitor at 375x812 |
| TPI-005 | REQ-LOCAL-001 | Accessibility | Medium | Medium | ready | Add a competitor with the keyboard only |
| TPI-006 | REQ-LOCAL-002 | Functional | High | High | ready | Save a valid 100m result for TP-Anna |
| TPI-007 | REQ-LOCAL-002 | State | Medium | Medium | ready | The saved result is still there after a page reload |
| TPI-008 | REQ-LOCAL-002 | Functional | Medium | Medium | ready | Save a Long Jump result, both events are shown |

Coverage gaps of the plan:

- CG-001 (REQ-LOCAL-001): Validation of competitor names (empty, duplicate, special characters, very long) is not verified: the requirement gives no criterion for it.
- CG-002 (REQ-LOCAL-002): Validation of result values (empty, negative, non-numeric, unreasonably large) is not verified: the requirement gives no criterion for it.
- CG-003 (REQ-LOCAL-002): Replacing an existing result and its confirmation dialog are not verified: the requirement gives no criterion for it.
- CG-004 (REQ-LOCAL-001): Editing and removing a competitor are not verified: they are not part of the requirement and are not allowed by the scope.
- CG-005 (REQ-LOCAL-002): Correctness of the points calculation and of the ranking per event is not verified: no scoring rule is supplied. The plan only checks that points are shown.
- CG-006 (REQ-LOCAL-002): The CSV export of the results is not verified: the requirement gives no criterion for it.
- CG-007 (REQ-LOCAL-002): Persistence of the Long Jump result after a page reload is not verified: TPI-007 reloaded the page before the Long Jump result was saved (TPI-008), and no later reload was planned.

## Execution results

### EX-001: TPI-001, Create the test competition and add TP-Anna (1440 px) (pass)

- Requirement: REQ-LOCAL-001; mode: `mcp-exploration`; viewport 1440×900.
- Expected: After entering a name and clicking 'Add competitor', the competitor is shown as a row in the standings table of the selected competition, and is still shown after a page reload.
- Actual and scope of verification: Verified: the competition TP-TPT-20261106 (Decathlon) was created and selected (ACT-001); after adding TP-Anna a row 'TP-Anna' is shown in the Decathlon standings, the app says 'Added' and no error is shown. Not verified: console output for this item, blank or special-character names, server-side behaviour.
- Evidence: EV-001, EV-002

### EX-002: TPI-002, TP-Anna is still there after a page reload (pass)

- Requirement: REQ-LOCAL-001; mode: `mcp-exploration`; viewport 1440×900.
- Expected: After entering a name and clicking 'Add competitor', the competitor is shown as a row in the standings table of the selected competition, and is still shown after a page reload.
- Actual and scope of verification: Verified: after a page reload the competition c2 is selected and the row 'TP-Anna' is still shown. Not verified: console output for this item, persistence in another browser or session.
- Evidence: EV-003

### EX-003: TPI-003, Add TP-Bo and TP-Cia, three rows in total (pass)

- Requirement: REQ-LOCAL-001; mode: `mcp-exploration`; viewport 1440×900.
- Expected: After entering a name and clicking 'Add competitor', the competitor is shown as a row in the standings table of the selected competition, and is still shown after a page reload.
- Actual and scope of verification: Verified: after adding TP-Bo (ACT-003) and TP-Cia (ACT-004) the standings show three rows (TP-Anna, TP-Bo, TP-Cia) and no error. Not verified: console output for this item, ordering of equal rows, duplicate names.
- Evidence: EV-004, EV-005

### EX-004: TPI-004, Add a competitor at 375x812 (pass)

- Requirement: REQ-LOCAL-001; mode: `mcp-exploration`; viewport 375×812.
- Expected: After entering a name and clicking 'Add competitor', the competitor is shown as a row in the standings table of the selected competition, and is still shown after a page reload.
- Actual and scope of verification: Verified: at 375x812 TP-V375 was added (ACT-005) and a row 'TP-V375' is shown with no error. Observation, not judged because no requirement gives a layout criterion: the page is wider than the viewport (scrollWidth 383, clientWidth 360) and the standings table extends past it. Not verified: layout against any design reference, console output for this item.
- Evidence: EV-006, EV-007

### EX-005: TPI-005, Add a competitor with the keyboard only (pass)

- Requirement: REQ-LOCAL-001; mode: `mcp-exploration`; viewport 1440×900.
- Expected: After entering a name and clicking 'Add competitor', the competitor is shown as a row in the standings table of the selected competition, and is still shown after a page reload.
- Actual and scope of verification: Verified: with the keyboard only (Tab to the Name field, typing, Tab to the 'Add competitor' button with a visible focus, Enter) TP-Key was added (ACT-006) and a row 'TP-Key' is shown with no error. Not verified: other keyboard paths, screen reader behaviour; no automated accessibility scan was performed.
- Evidence: EV-008, EV-009

### EX-006: TPI-006, Save a valid 100m result for TP-Anna (pass)

- Requirement: REQ-LOCAL-002; mode: `mcp-exploration`; viewport 1440×900.
- Expected: For an existing competitor, selecting the event, entering a valid numeric result and clicking 'Save score' shows a success message without an error, and the competitor's row in the standings shows the result and the points for that event; the result is still shown after a page reload.
- Actual and scope of verification: Verified: TP-Anna was chosen from the competitor list, Decathlon 100m 11.50 was saved (ACT-007); the app says 'Saved: 753 pts' with no error, and TP-Anna's row shows 753 points and the raw value 11.5 s for the 100m. Not verified: that 753 is the correct score (no scoring rule supplied), console output for this item, invalid values.
- Evidence: EV-010, EV-011

### EX-007: TPI-007, The saved result is still there after a page reload (pass)

- Requirement: REQ-LOCAL-002; mode: `mcp-exploration`; viewport 1440×900.
- Expected: For an existing competitor, selecting the event, entering a valid numeric result and clicking 'Save score' shows a success message without an error, and the competitor's row in the standings shows the result and the points for that event; the result is still shown after a page reload.
- Actual and scope of verification: Verified: after a page reload competition c2 is selected and TP-Anna's row still shows 753 points and the raw value 11.5 s; the console had 0 messages since the load. Not verified: persistence in another browser or session.
- Evidence: EV-012, EV-013, EV-014

### EX-008: TPI-008, Save a Long Jump result, both events are shown (pass)

- Requirement: REQ-LOCAL-002; mode: `mcp-exploration`; viewport 1440×900.
- Expected: For an existing competitor, selecting the event, entering a valid numeric result and clicking 'Save score' shows a success message without an error, and the competitor's row in the standings shows the result and the points for that event; the result is still shown after a page reload.
- Actual and scope of verification: Verified: TP-Anna was chosen from the competitor list, Decathlon Long Jump 680 cm was saved (ACT-008); the app says 'Saved: 767 pts' with no error, and TP-Anna's row shows both events: 100m 753 points (raw 11.5 s) and Long Jump 767 points (raw 680 cm), total 1520 (the sum of the two shown values); the console had 0 messages. Not verified: that 767 is the correct score (no scoring rule supplied), persistence of the Long Jump result after a reload, invalid values. The planned test data 6.80 was corrected to 680 cm because the app takes Long Jump in cm (see limitations).
- Evidence: EV-015, EV-016, EV-017

## Bug proposals

None. No execution failed, and the one observation (page width at 375 px) has no requirement to be checked against, so it is a manual test proposal (MTP-007) and not a bug proposal.

## Manual test proposals

### MTP-001: Valid and invalid competitor names
- Requirement: REQ-LOCAL-001
- Origin: coverage_gap CG-001
- Objective: Agree which competitor names are valid, then verify how the app handles empty, duplicate, very long and special-character names.
- Steps:
  1. Agree with the product owner which names are valid and what the app must say for an invalid one.
  2. In a TP- competition, try an empty name, a name that already exists, a 200-character name and a name with a comma and a quote.
  3. Check the message for each and that invalid names are not added, also after a page reload.
- Expected result: Invalid names are rejected with a clear message and are not added; valid names are added.
- Why manual: Needs a product decision on what a valid name is before it can be automated.
- Status: proposed

### MTP-002: Valid and invalid result values
- Requirement: REQ-LOCAL-002
- Origin: coverage_gap CG-002
- Objective: Agree limits and messages for invalid result values and verify them per event.
- Steps:
  1. Agree with the product owner the valid range per event and the expected message.
  2. In a TP- competition, try an empty, a negative, a non-numeric and a very large value for one time event and one distance event.
  3. Check the message and that no invalid value is saved, also after a page reload.
- Expected result: Invalid values are rejected with a clear message and are not saved.
- Why manual: Needs a product decision on the limits before it can be automated.
- Status: proposed

### MTP-003: Replace an existing result
- Requirement: REQ-LOCAL-002
- Origin: coverage_gap CG-003
- Objective: Verify what happens when a result is saved for an event that already has one.
- Steps:
  1. In a TP- competition, save a valid result for a competitor and an event.
  2. Save a different valid result for the same competitor and event.
  3. Answer the confirmation dialog once with 'No, keep it' and once with 'Yes, replace', and check the standings each time.
- Expected result: 'No' keeps the old result and its points; 'Yes' replaces them; the standings and total follow the choice.
- Why manual: The requirement gives no criterion for replacing a result; a person should agree the expected behaviour first.
- Status: proposed

### MTP-004: Edit and remove a competitor
- Requirement: REQ-LOCAL-001
- Origin: coverage_gap CG-004
- Objective: Verify editing a competitor's name and results, and removing a competitor.
- Steps:
  1. In a TP- competition, click a competitor row to open the edit dialog.
  2. Change the name and a result and save; then open it again and remove the competitor.
  3. Check the standings and total after each change.
- Expected result: Changes are shown in the standings and are kept after a reload; a removed competitor is no longer listed.
- Why manual: Editing and removing data was outside the scope and no criterion exists; run by a person on disposable data.
- Status: proposed

### MTP-005: Points and ranking per event
- Requirement: REQ-LOCAL-002
- Origin: coverage_gap CG-005
- Objective: Compare the points and the ranking with the official combined-events scoring tables.
- Steps:
  1. Agree the scoring tables that apply (World Athletics, current version).
  2. In a TP- competition, enter reference results for every Decathlon event for two competitors.
  3. Compare each event's points and the total with the tables, and check the order of the standings.
- Expected result: Points per event and total equal the tables; positions follow the totals.
- Why manual: Needs the scoring tables as a reference before it can be automated.
- Status: proposed

### MTP-006: CSV export matches the table
- Requirement: REQ-LOCAL-002
- Origin: coverage_gap CG-006
- Objective: Verify that the exported CSV contains the same data as the standings.
- Steps:
  1. In a TP- competition with results, click 'Export CSV' on the Decathlon tab.
  2. Open the file and compare every competitor, total, position and event value with the table.
  3. Repeat with a name that contains a comma.
- Expected result: The CSV has every competitor and value shown in the table, and names with a comma stay intact.
- Why manual: The export was not in scope and gives a download that a person should inspect.
- Status: proposed

### MTP-007: Page width at 375 px
- Requirement: REQ-LOCAL-001
- Origin: execution EX-004
- Objective: Decide whether the page may be wider than a 375 px screen and check the layout on a real phone.
- Steps:
  1. Open http://localhost:8080 at 375x812 (or a real phone) and select a TP- competition with competitors.
  2. Check whether the page scrolls sideways and whether the standings table can be read and reached.
  3. Agree the expected behaviour (for example a table that scrolls inside its own box).
- Expected result: The page does not scroll sideways, or the table scrolls in its own box, as agreed.
- Why manual: No requirement gives a layout criterion and there is no design reference; a person must decide what is acceptable.
- Evidence: EV-006, EV-007
- Status: proposed

### MTP-008: Long Jump result after a reload
- Requirement: REQ-LOCAL-002
- Origin: coverage_gap CG-007
- Objective: Verify that a saved Long Jump result is still there after a page reload.
- Steps:
  1. In a TP- competition, save a Long Jump result for a competitor (in cm).
  2. Reload the page and select the competition.
  3. Check that the Long Jump result and its points are still shown.
- Expected result: The Long Jump result and its points are still shown after the reload.
- Why manual: Can be automated; proposed as a follow-up to TPI-008, which did not reload after saving.
- Status: proposed

## Coverage gaps and not verified

| coverage_gap_id | requirement_id | What is not verified, and why |
|---|---|---|
| CG-001 | REQ-LOCAL-001 | Validation of competitor names (empty, duplicate, special characters, very long) is not verified: the requirement gives no criterion for it. |
| CG-002 | REQ-LOCAL-002 | Validation of result values (empty, negative, non-numeric, unreasonably large) is not verified: the requirement gives no criterion for it. |
| CG-003 | REQ-LOCAL-002 | Replacing an existing result and its confirmation dialog are not verified: the requirement gives no criterion for it. |
| CG-004 | REQ-LOCAL-001 | Editing and removing a competitor are not verified: they are not part of the requirement and are not allowed by the scope. |
| CG-005 | REQ-LOCAL-002 | Correctness of the points calculation and of the ranking per event is not verified: no scoring rule is supplied. The plan only checks that points are shown. |
| CG-006 | REQ-LOCAL-002 | The CSV export of the results is not verified: the requirement gives no criterion for it. |
| CG-007 | REQ-LOCAL-002 | Persistence of the Long Jump result after a page reload is not verified: TPI-007 reloaded the page before the Long Jump result was saved (TPI-008), and no later reload was planned. |

## Limitations

- 2026-11-06T13:19:21Z: Scope confirmed by the user (johan). It was proposed in the discover step and approved there; it is recorded here when the user approved the test plan.
- 2026-11-06T13:19:21Z: REQ-LOCAL-001 and REQ-LOCAL-002 come from the user's goal ('testa att man kan lägga till deltagare och spara resultat'). TestBench project 4 (TPT1106) has no requirements. The acceptance criteria were proposed by the agent and confirmed by the user when approving the test plan.
- Execution start and finish times are derived from recorded tool timestamps and evidence read-out times; they are not measured to the second. The performed_at of an action is the time of the first tool record after the action.
- Screenshot and console-log captured_at values are the file write times; the read-out files carry their own capture time.
- The browser console was captured only after the page load of TPI-007 (EV-014). Console output of the other items was not captured.
- A stale Chrome process (pid 82172, profile mcp-chrome-c6d51fd) from the earlier audit blocked the Playwright browser at the start of the run. It was ended with the user's approval before the first check; no check was affected.
- 2026-11-06T13:28:31Z: Correction confirmed by the user (johan) during the run: the app takes Long Jump in cm, so the planned test data 6.80 (TPI-008 and scope.state_changes save_result) was changed to 680 cm (= 6.80 m). It is the same intent; TPI-008 was run with 680.
- No automated accessibility scan was performed in this audit. Accessibility signals were assessed through Playwright MCP exploration, keyboard interaction and DOM/accessibility-tree inspection. This does not establish WCAG 2.1 AA conformance.
- Visual design review (step 4) was not run as a separate check: no requirement concerns visual presentation and no design reference exists. Responsive layout was observed in TPI-004 only (page wider than the 375 px viewport, see MTP-007).
- No bug proposals were created, so no duplicate check was needed. No bug data is available from a TestBench integration for a comparison.
- The expected values (753 and 767 points) were not compared with a scoring table; only that the app shows points was checked (see CG-005).

## TestBench backlog

None.

Delivery: `not_delivered`. The validation result is recorded in `manifest.json` (`validation`). Package validation and TestBench acceptance are separate facts.

## Evidence index

| evidence_id | Type | Captured (UTC) | Location | Related | Description |
|---|---|---|---|---|---|
| EV-001 | screenshot | 2026-11-06T13:22:36Z | [evidence/tpi-001-tp-anna-added-screenshot-2026-11-06.png](evidence/tpi-001-tp-anna-added-screenshot-2026-11-06.png) | EX-001 | Screenshot after creating TP-TPT-20261106 and adding TP-Anna at 1440x900. |
| EV-002 | test-output | 2026-11-06T13:22:36Z | [evidence/tpi-001-tp-anna-added-dom-2026-11-06.json](evidence/tpi-001-tp-anna-added-dom-2026-11-06.json) | EX-001 | Read-out after adding TP-Anna: row 'TP-Anna', message 'Added', no error. |
| EV-003 | test-output | 2026-11-06T13:22:42Z | [evidence/tpi-002-after-reload-dom-2026-11-06.json](evidence/tpi-002-after-reload-dom-2026-11-06.json) | EX-002 | Read-out after a page reload: competition c2 selected, row 'TP-Anna' present. |
| EV-004 | test-output | 2026-11-06T13:23:12Z | [evidence/tpi-003-three-competitors-dom-2026-11-06.json](evidence/tpi-003-three-competitors-dom-2026-11-06.json) | EX-003 | Read-out after adding TP-Bo and TP-Cia: rows TP-Anna, TP-Bo, TP-Cia, message 'Added', no error. |
| EV-005 | screenshot | 2026-11-06T13:23:13Z | [evidence/tpi-003-three-competitors-screenshot-2026-11-06.png](evidence/tpi-003-three-competitors-screenshot-2026-11-06.png) | EX-003 | Screenshot of the standings with three competitors at 1440x900. |
| EV-006 | test-output | 2026-11-06T13:23:38Z | [evidence/tpi-004-375-add-competitor-dom-2026-11-06.json](evidence/tpi-004-375-add-competitor-dom-2026-11-06.json) | EX-004 | Read-out at 375x812 after adding TP-V375: row present, no error; scrollWidth 383 against clientWidth 360, table#standingsTableEl extends past the viewport. |
| EV-007 | screenshot | 2026-11-06T13:23:39Z | [evidence/tpi-004-375-add-competitor-screenshot-2026-11-06.png](evidence/tpi-004-375-add-competitor-screenshot-2026-11-06.png) | EX-004 | Screenshot at 375x812 after adding TP-V375. |
| EV-008 | test-output | 2026-11-06T13:24:17Z | [evidence/tpi-005-keyboard-add-competitor-dom-2026-11-06.json](evidence/tpi-005-keyboard-add-competitor-dom-2026-11-06.json) | EX-005 | Read-out after adding TP-Key with Tab and Enter only: row present, message 'Added', no error. |
| EV-009 | screenshot | 2026-11-06T13:24:18Z | [evidence/tpi-005-keyboard-add-competitor-screenshot-2026-11-06.png](evidence/tpi-005-keyboard-add-competitor-screenshot-2026-11-06.png) | EX-005 | Screenshot after adding TP-Key with the keyboard only. |
| EV-010 | test-output | 2026-11-06T13:24:57Z | [evidence/tpi-006-save-100m-dom-2026-11-06.json](evidence/tpi-006-save-100m-dom-2026-11-06.json) | EX-006 | Read-out after saving 100m 11.50 for TP-Anna: 'Saved: 753 pts', row shows 753 [raw 11.5 s], no error. |
| EV-011 | screenshot | 2026-11-06T13:24:58Z | [evidence/tpi-006-save-100m-screenshot-2026-11-06.png](evidence/tpi-006-save-100m-screenshot-2026-11-06.png) | EX-006 | Screenshot of the standings after saving the 100m result for TP-Anna. |
| EV-012 | test-output | 2026-11-06T13:25:08Z | [evidence/tpi-007-after-reload-dom-2026-11-06.json](evidence/tpi-007-after-reload-dom-2026-11-06.json) | EX-007 | Read-out after a page reload: competition c2 selected, TP-Anna row still shows 753 [raw 11.5 s]. |
| EV-013 | screenshot | 2026-11-06T13:25:13Z | [evidence/tpi-007-after-reload-screenshot-2026-11-06.png](evidence/tpi-007-after-reload-screenshot-2026-11-06.png) | EX-007 | Screenshot of the standings after the reload. |
| EV-014 | console-log | 2026-11-06T13:25:55Z | [evidence/tpi-007-console-after-reload-2026-11-06.txt](evidence/tpi-007-console-after-reload-2026-11-06.txt) | EX-007 | Console output since the last page load: 0 messages, 0 errors, 0 warnings. |
| EV-015 | test-output | 2026-11-06T13:28:06Z | [evidence/tpi-008-save-longjump-dom-2026-11-06.json](evidence/tpi-008-save-longjump-dom-2026-11-06.json) | EX-008 | Read-out after saving Long Jump 680 cm for TP-Anna: 'Saved: 767 pts', row shows 753 [raw 11.5 s] for 100m and 767 [raw 680 cm] for Long Jump, total 1520, no error. |
| EV-016 | screenshot | 2026-11-06T13:28:07Z | [evidence/tpi-008-save-longjump-screenshot-2026-11-06.png](evidence/tpi-008-save-longjump-screenshot-2026-11-06.png) | EX-008 | Screenshot of the standings after saving the Long Jump result for TP-Anna. |
| EV-017 | console-log | 2026-11-06T13:28:07Z | [evidence/tpi-008-console-after-save-2026-11-06.txt](evidence/tpi-008-console-after-save-2026-11-06.txt) | EX-008 | Console output since the last page load, after saving the Long Jump result: 0 messages, 0 errors, 0 warnings. |

## Human review handover

- All manual test proposals (MTP-001 to MTP-008) have status `proposed`. There are no bug proposals. Review and any decision are the reviewer's. The agent has not accepted, rejected or closed anything.
- Decisions needed: (1) which competitor names are valid (MTP-001); (2) the valid range and message for result values (MTP-002); (3) what replacing a result should do (MTP-003); (4) which scoring tables apply (MTP-005); (5) whether the page may be wider than a 375 px screen (MTP-007).
- Data left behind in the competition TP-TPT-20261106: TP-Anna (100m 11.50 s, Long Jump 680 cm), TP-Bo, TP-Cia, TP-V375, TP-Key. No delete action was in scope.
- Human review status: pending.
