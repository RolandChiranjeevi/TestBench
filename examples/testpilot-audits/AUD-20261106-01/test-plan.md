# Test Plan: Decathlon & Heptathlon, add participants and save results

Identifiers and values follow `../.claude/skills/references/audit-contract.md`.

Audit: AUD-20261106-01. Confirmed scope: see `manifest.json` `scope`.

## Scope
Black-box check that a user can add participants to a competition and save results for them, in the app at http://localhost:8080 (local environment, build unknown). Checks are Functional, State, Responsive and Accessibility, at 1440x900, 768x1024 and 375x812.

## Out of scope
- Save state and Load state
- The existing competitions General and TP-AUD-20261105-01
- Editing and removing competitors, Heptathlon, CSV export
- Server-side validation, performance and security testing

## Assumptions
- The app takes Long Jump in cm, so the Long Jump test data is 680 (= 6.80 m). Corrected with the user's approval during the run.
- TestBench project 4 (TPT1106) has no requirements. REQ-LOCAL-001 and REQ-LOCAL-002 come from the user's goal; the acceptance criteria were proposed by the agent and confirmed by the user when approving this plan.
- The app keeps its data on the server, so the checks write only in the new competition TP-TPT-20261106.

## Requirements and readiness

| requirement_id | Title | Source | Readiness | Acceptance criteria |
|---|---|---|---|---|
| REQ-LOCAL-001 | A user can add a participant to a competition | local | ready | After entering a name and clicking 'Add competitor', the competitor is shown as a row in the standings table of the selected competition, and is still shown after a page reload. |
| REQ-LOCAL-002 | A user can save a result for a participant | local | ready | For an existing competitor, selecting the event, entering a valid numeric result and clicking 'Save score' shows a success message without an error, and the competitor's row in the standings shows the result and the points for that event; the result is still shown after a page reload. |

## Test plan items

| test_plan_item_id | requirement_id | Title | Risk | Priority | Test type | Preconditions | Test data | Steps | Acceptance criteria | Automation |
|---|---|---|---|---|---|---|---|---|---|---|
| TPI-001 | REQ-LOCAL-001 | Create the test competition and add TP-Anna (1440 px) | Medium | High | Functional | The app is reachable at http://localhost:8080. The competition TP-TPT-20261106 does not exist yet. Viewport 1440x900. | Competition name TP-TPT-20261106, type Decathlon. Competitor name TP-Anna. | 1. Open http://localhost:8080 at viewport 1440x900.<br>2. Click 'New competition'.<br>3. Enter TP-TPT-20261106 as the competition name, keep the type Decathlon and click 'Create'.<br>4. Check that the competition TP-TPT-20261106 is selected.<br>5. Enter TP-Anna in the Name field under 'Add competitor' and click 'Add competitor'.<br>6. Check that a row for TP-Anna is shown in the Decathlon standings table and that no error is shown. | After entering a name and clicking 'Add competitor', the competitor is shown as a row in the standings table of the selected competition, and is still shown after a page reload. | Yes, mcp-exploration |
| TPI-002 | REQ-LOCAL-001 | TP-Anna is still there after a page reload | Medium | Medium | State | The app is reachable at http://localhost:8080. TPI-001 is done: TP-Anna exists in the competition TP-TPT-20261106. Viewport 1440x900. | None | 1. Reload the page.<br>2. Select the competition TP-TPT-20261106 if it is not selected.<br>3. Check that a row for TP-Anna is shown in the Decathlon standings table. | After entering a name and clicking 'Add competitor', the competitor is shown as a row in the standings table of the selected competition, and is still shown after a page reload. | Yes, mcp-exploration |
| TPI-003 | REQ-LOCAL-001 | Add TP-Bo and TP-Cia, three rows in total | Low | Medium | Functional | The app is reachable at http://localhost:8080. TP-Anna exists in the competition TP-TPT-20261106, which is selected. Viewport 1440x900. | Competitor names TP-Bo and TP-Cia. | 1. Enter TP-Bo in the Name field under 'Add competitor' and click 'Add competitor'.<br>2. Enter TP-Cia in the Name field under 'Add competitor' and click 'Add competitor'.<br>3. Check that rows for TP-Anna, TP-Bo and TP-Cia are shown in the Decathlon standings table and that no error is shown. | After entering a name and clicking 'Add competitor', the competitor is shown as a row in the standings table of the selected competition, and is still shown after a page reload. | Yes, mcp-exploration |
| TPI-004 | REQ-LOCAL-001 | Add a competitor at 375x812 | Medium | Medium | Responsive | The app is reachable at http://localhost:8080. The competition TP-TPT-20261106 exists. Viewport 375x812. | Competitor name TP-V375. | 1. Set the viewport to 375x812 and open http://localhost:8080.<br>2. Select the competition TP-TPT-20261106.<br>3. Enter TP-V375 in the Name field under 'Add competitor' and click 'Add competitor'.<br>4. Check that a row for TP-V375 is shown in the Decathlon standings table and that no error is shown. | After entering a name and clicking 'Add competitor', the competitor is shown as a row in the standings table of the selected competition, and is still shown after a page reload. | Yes, mcp-exploration |
| TPI-005 | REQ-LOCAL-001 | Add a competitor with the keyboard only | Medium | Medium | Accessibility | The app is reachable at http://localhost:8080. The competition TP-TPT-20261106 exists and is selected. Viewport 1440x900. Heuristic-based (input method variation): the requirement has no keyboard criterion; the acceptance criterion is the one of the requirement. | Competitor name TP-Key. | 1. Move the focus to the Name field under 'Add competitor' with the Tab key.<br>2. Type TP-Key.<br>3. Move the focus to the 'Add competitor' button with the Tab key and press Enter.<br>4. Check that a row for TP-Key is shown in the Decathlon standings table and that no error is shown. | After entering a name and clicking 'Add competitor', the competitor is shown as a row in the standings table of the selected competition, and is still shown after a page reload. | Yes, mcp-exploration |
| TPI-006 | REQ-LOCAL-002 | Save a valid 100m result for TP-Anna | High | High | Functional | The app is reachable at http://localhost:8080. TP-Anna exists in the competition TP-TPT-20261106, which is selected. Viewport 1440x900. | Competitor TP-Anna, discipline Decathlon, event 100m, result 11.50. | 1. Select TP-Anna in the Competitor field under 'Enter result'.<br>2. Select the discipline Decathlon and the event 100m.<br>3. Enter 11.50 in the Result field and click 'Save score'.<br>4. Check that a success message is shown and no error is shown.<br>5. Check that the row for TP-Anna shows the 100m result 11.50 and a points value. | For an existing competitor, selecting the event, entering a valid numeric result and clicking 'Save score' shows a success message without an error, and the competitor's row in the standings shows the result and the points for that event; the result is still shown after a page reload. | Yes, mcp-exploration |
| TPI-007 | REQ-LOCAL-002 | The saved result is still there after a page reload | Medium | Medium | State | The app is reachable at http://localhost:8080. TPI-006 is done: TP-Anna has a 100m result of 11.50. Viewport 1440x900. | None | 1. Reload the page.<br>2. Select the competition TP-TPT-20261106 if it is not selected.<br>3. Check that the row for TP-Anna shows the 100m result 11.50 and a points value. | For an existing competitor, selecting the event, entering a valid numeric result and clicking 'Save score' shows a success message without an error, and the competitor's row in the standings shows the result and the points for that event; the result is still shown after a page reload. | Yes, mcp-exploration |
| TPI-008 | REQ-LOCAL-002 | Save a Long Jump result, both events are shown | Medium | Medium | Functional | The app is reachable at http://localhost:8080. TP-Anna exists in the competition TP-TPT-20261106, which is selected, and has a 100m result. Viewport 1440x900. | Competitor TP-Anna, discipline Decathlon, event Long Jump, result 680 (the app takes Long Jump in cm; 680 cm = 6.80 m). | 1. Select TP-Anna in the Competitor field under 'Enter result'.<br>2. Select the discipline Decathlon and the event Long Jump.<br>3. Enter 680 in the Result field and click 'Save score'.<br>4. Check that a success message is shown and no error is shown.<br>5. Check that the row for TP-Anna shows both the 100m result 11.50 and the Long Jump result 680 cm, each with a points value. | For an existing competitor, selecting the event, entering a valid numeric result and clicking 'Save score' shows a success message without an error, and the competitor's row in the standings shows the result and the points for that event; the result is still shown after a page reload. | Yes, mcp-exploration |

## Heuristics used
- CRUD and data lifecycle (create and read)
- Count: 0, 1, Many (TPI-001, TPI-003)
- Follow the Data (persistence after reload, TPI-002 and TPI-007)
- Sequences and State (TPI-006 before TPI-008)
- Responsiveness and layout (TPI-004)
- Input method variation (TPI-005)

Heuristics are test ideas, not requirements.

## Coverage gaps
- CG-001 (REQ-LOCAL-001): Validation of competitor names (empty, duplicate, special characters, very long) is not verified: the requirement gives no criterion for it.
- CG-002 (REQ-LOCAL-002): Validation of result values (empty, negative, non-numeric, unreasonably large) is not verified: the requirement gives no criterion for it.
- CG-003 (REQ-LOCAL-002): Replacing an existing result and its confirmation dialog are not verified: the requirement gives no criterion for it.
- CG-004 (REQ-LOCAL-001): Editing and removing a competitor are not verified: they are not part of the requirement and are not allowed by the scope.
- CG-005 (REQ-LOCAL-002): Correctness of the points calculation and of the ranking per event is not verified: no scoring rule is supplied. The plan only checks that points are shown.
- CG-006 (REQ-LOCAL-002): The CSV export of the results is not verified: the requirement gives no criterion for it.
- CG-007 (REQ-LOCAL-002): Persistence of the Long Jump result after a page reload is not verified: TPI-007 reloaded the page before the Long Jump result was saved (TPI-008), and no later reload was planned.

## Test data
- Competition: TP-TPT-20261106 (Decathlon)
- Competitors: TP-Anna, TP-Bo, TP-Cia, TP-V375, TP-Key
- Results: TP-Anna 100m 11.50, TP-Anna Long Jump 680 (cm)

## Environments
- http://localhost:8080, local, build unknown; Playwright MCP browser

## Risks
- The app stores data on the server without login; the checks must not touch the existing competitions.
- Limits on state changes are per audit (see the scope); no check may exceed them.
