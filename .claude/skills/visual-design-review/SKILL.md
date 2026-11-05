---
name: visual-design-review
description: Reviews web UI layout against explicit design requirements and evaluates accessibility against WCAG 2.1 Level A and AA. Use when the user requests visual validation, layout checks, or accessibility testing.
---

# Visual Design and Accessibility Review

## Purpose
Review:
1. Layout and visual behavior against explicit design requirements.
2. Accessibility against WCAG 2.1 Level A and AA.

Keep design findings separate from accessibility findings.

Identifiers, execution statuses, reason codes, evidence types and the audit package are defined in
`../references/audit-contract.md`. Use them as written. Do not define your own. Paths are relative to this
`SKILL.md`. `qa-run` calls this skill in step 4 of the audit.

Do not invent design requirements.
Do not claim full WCAG conformance based on automated checks alone.

## Inputs
Use information already provided in the task or project:
- Target URL and environment.
- Pages, components, and states in scope.
- Supported viewports.
- Design references or explicit layout requirements.
- Existing test plan and known bug reports.

If a design requirement is missing, continue with checks that have
a clear basis and mark uncertain results as `inconclusive` (reason `needs-design-reference` or `insufficient-evidence`).

Do not request passwords in reports or store secrets in test code.

## Tools and execution modes

### Browser exploration
Use the available Playwright MCP browser tools to:
- Navigate and interact with the page.
- Set viewport sizes.
- Capture screenshots.
- Inspect element geometry and computed styles.
- Observe relevant page states.

### Saved automated tests
When asked to create reusable tests:
- Save checks in the project's Playwright Test suite.
- Use @axe-core/playwright for automated accessibility scans.
- Reuse the project's configuration and helpers.
- Ask before installing missing dependencies.
- Do not replace existing tests without approval.

A check performed through MCP is not a saved automated test.
Report clearly which mode was used.

## Workflow
1. Read the task, relevant test plan, and available design references.
2. Identify the checks that have an explicit expected result.
3. Use the viewports specified by the task.
   If none are specified, propose 375, 768, and 1440 CSS px.
   Record viewport width and height in the results.
4. Perform the design checks.
5. Perform the automated accessibility checks when available.
6. Record checks requiring human review separately.
7. Capture evidence for findings.
8. Compare findings with existing bug reports to avoid duplicates.
9. Summarize coverage, failures, limitations, and untested items.

Do not publish findings externally without explicit approval.

## Design checks

### Text centering
Check centering only where required by the user or design.

Before creating a centering assertion, identify:
- The target text.
- Its intended container.
- Whether centering is horizontal, vertical, or both.
- The relevant viewport and component state.
- The agreed tolerance in CSS pixels.

If these details are unclear, ask or mark the check as `inconclusive`.

Distinguish between:
- A text element centered within its parent container.
- Text centered within the text element's own content box.

Do not infer rendered centering from text-align, flexbox, or grid
declarations alone.

Measure the relevant container and text geometry where feasible.
For text, use rendered text ranges or line boxes where appropriate,
rather than assuming the element's bounding box equals the text bounds.

Account for padding, borders, multiline text, and font loading.
Document the measurement method and its limitations.

Use the tolerance specified by the task or design.
If no tolerance exists, propose one for approval rather than silently
treating it as a product requirement.

On failure, capture:
- Screenshot.
- Target and container locators.
- Viewport.
- Required alignment.
- Measured deviation and tolerance.

Geometric centering does not necessarily prove optical centering.
Mark subjective visual judgments as `inconclusive` and propose a manual test.

### Layout and text flow
Check for:
- Clipped or overflowing content.
- Unintended element overlap.
- Text obscuring controls or other content.
- Horizontal scrolling only when it hides required content, prevents access
  to controls, or conflicts with an explicit responsive requirement.
- Misalignment against an explicit grid or container requirement.
- Wrapping or truncation that conflicts with the design or hides content.

Do not classify horizontal scrolling as a defect solely because it occurs.
First determine whether it is intentional, whether required content remains
reachable, and whether it conflicts with a requirement, design reference or
accessibility criterion.

If the behaviour is intentional or cannot be assessed against a clear
requirement, record it as an observation or `inconclusive`; do not create a
bug proposal.

Do not classify a line break, orphan word, intentional truncation,
or left-aligned text as a defect solely because of a stylistic preference.

Use representative content and page states where available.
Do not change production data to create test cases without approval.

## Responsive and interactive state checks

For each page, component, or flow in scope:

1. Test the initial state at each agreed viewport.
2. Test interactive states relevant to the requirement:
   - Buttons and links: default, hover, focus, active, disabled and loading
     states where applicable.
   - Menus, dropdowns and navigation: closed, open, focus within, selection
     and close behaviour.
   - Dialogs and modals: open, focus behaviour, close, and content overflow.
   - Forms: empty, incomplete, validation error, submitting and success/error
     states.
   - Lists, cards and tables: empty, loading, populated, truncated and error
     states where applicable.
3. Repeat relevant checks at each agreed viewport.
4. Capture a screenshot or DOM/accessibility-tree evidence for each assessed
   state.
5. Record viewport, state, expected result, actual result and evidence for
   every execution.

A state is only `pass` when its expected behaviour was defined and the evidence
supports it. Missing or unclear expected behaviour is `inconclusive`, with
reason `insufficient-evidence` or `needs-design-reference`.

## Accessibility target: WCAG 2.1 AA

The target includes applicable Level A and Level AA success criteria
from WCAG 2.1.

This skill provides scoped testing, not automatic certification.
Passing automated checks does not establish full conformance.

### Automated accessibility scans
For saved Playwright tests, use @axe-core/playwright with:
- wcag2a
- wcag2aa
- wcag21a
- wcag21aa

Scan after the page and relevant UI state have loaded.

Include relevant states from the agreed scope, such as:
- Initial page.
- Displayed form validation errors.
- Open dialogs or menus.
- Successful or failed interaction states.

Do not assume a scan of the initial page covers later states.

For each detected violation, preserve:
- Rule ID.
- Related WCAG success criteria, where supplied by the tool.
- Affected element locator or HTML snippet.
- Tool impact classification.
- Explanation and evidence.

Keep tool impact separate from product severity and priority.

Record results the tool reports as incomplete as `inconclusive`, with the rule ID.
Do not silently suppress findings or add exclusions to make tests pass.
Document and justify any approved exclusions.

If the scanner is unavailable, report that the scan was not performed.
Do not present browser exploration as an equivalent automated scan.

### Targeted accessibility checks
Where in scope, assess:
- Keyboard access and navigation order.
- Keyboard traps.
- Visible keyboard focus.
- Accessible names and appropriate control semantics.
- Form labels, instructions, and error identification.
- Zoom and reflow.
- Text and non-text contrast.
- Screen reader behavior.

This list is not a complete WCAG 2.1 AA checklist.

Use keyboard interaction when assessing keyboard focus.
Do not infer absence of a visible focus indicator only from
outline: none or missing box-shadow.

Consider other focus cues, including border, background, text,
and changes rendered through pseudo-elements.

A computed-style change alone does not prove that the focus cue
is visibly distinguishable.

Do not infer absence of an accessible name solely from a missing
label element or aria-label attribute.
Inspect the computed accessible name and relevant naming relationships.

Do not claim screen reader testing was completed unless it actually was.
Do not mark a manual check as passed based only on an automated scan.

### Coverage and limitations
For each assessed criterion or check, record:
- What was tested.
- Method: automated, agent-assisted inspection, or human assessment.
- Result.
- Evidence.
- Limitations.

Use the execution statuses in `../references/audit-contract.md` section 2.1 and the reason codes in section 2.3.
Do not use other status words. Older wording (Passed, Failed, Needs review, Not tested) appears only in historical
reports and is read with the legacy mapping in section 2.5. It is never used to assign a status to a new result.
A check that does not apply is `skipped` with reason `not-applicable` (explain why).

`blocked` is never reported as `fail`. A scanner or measurement that failed to run is `blocked` or
`inconclusive` with reason `tooling`, not a product defect.

Unassessed criteria must not be treated as passed.

## Manual accessibility follow-up

After automated accessibility checks, create manual test proposals for the
applicable areas that cannot be reliably verified automatically:

- Keyboard navigation and tab order.
- Visible keyboard focus.
- Keyboard traps and escape behaviour.
- Screen-reader announcements, roles and accessible names.
- Form labels, instructions and error identification.
- Zoom and reflow.
- Text and non-text contrast in the actual visual context.
- Menus, dialogs, forms and interactive controls in their relevant states.

Each manual test proposal MUST use the contract's manual-test format, link to
the relevant `requirement_id`, `test_plan_item_id` and evidence where available,
and have status `proposed`.

Do not create a manual test proposal for a criterion that is clearly outside
the confirmed scope; record it as `skipped` with reason `out-of-scope`
instead.

## Finding handling
Before creating a bug report:
1. Identify the design requirement or WCAG criterion involved.
2. Verify the observed behavior where feasible.
3. Capture evidence.
4. Perform the duplicate check required by the contract.

Set `duplicate_check` and `possible_duplicate_of` on every proposed bug:

- `not_available` and `null` when no bug data is available.
- `no_match` and `null` when no plausible match exists.
- `possible_match` and the existing bug identifier when a plausible match
  exists.
- `uncertain_match`, keep status `proposed`, and use the most likely existing
  bug identifier when the match is uncertain.

Separate:
- Finding type (see Finding format).
- Execution status and bug proposal status (contract section 2). An evidence-supported finding that violates a requirement, acceptance criterion
  or WCAG success criterion becomes a bug proposal with status `proposed`.
- Product severity and priority.
- Automated tool impact, if applicable.

Do not classify tool errors as product defects.
Do not automatically dismiss application errors as environment issues.

## Finding format
For each finding, record:
- `execution_id` of the check, and `bug_proposal_id` or existing bug ID if one exists.
- Category: Design / Accessibility.
- Finding type: `design-deviation`, `usability-risk`, `consistency-risk` or `accessibility` (see below).
- Title.
- URL and view (page, component or route).
- Viewport width and height.
- State: initial, hover, focus, open menu or dialog, error, empty, loading, and so on.
- Design reference, if available, as a `design-reference` evidence ID. Otherwise write "none available".
- Requirement link: `requirement_id`, `test_plan_item_id` and the criterion or WCAG success criterion involved.
- Affected element and relevant container.
- Expected result and its source.
- Actual result.
- User impact: who is affected, what they cannot do or understand, and how often.
- Reproduction steps.
- Assessment method and measurements, if applicable.
- Evidence IDs (screenshot, dom-excerpt, axe-result, test-output). At least one.
- Severity and priority, with rationale if assigned.
- Limitations or required human review.

### Design deviation versus risk
- **`design-deviation`**: the result differs from a design reference or an explicit layout requirement.
  The reference is cited as evidence. This can be `fail`.
- **`usability-risk` or `consistency-risk`**: there is no design reference, but the result may hurt use or
  differs from similar parts of the product. Examples: a control that disappears at a narrow width with no
  alternative, or two different looks for the same component. Record it as a risk, status `inconclusive` with
  reason `needs-design-reference`, and describe the impact. Do not call it a defect.
  It becomes a bug proposal only if a requirement or WCAG criterion is verifiably violated. Otherwise
  propose a manual test or ask for the design decision.
- **`accessibility`**: tied to a WCAG 2.1 criterion, kept apart from design findings.

When creating a bug proposal, use the project's bug-reporting skill and `../bug-reporting/templates/bug-report.md`.
The template is mandatory for visual and accessibility findings as well.

Use evidence paths relative to the saved report.
Do not reference screenshots that were not actually saved.
Avoid exposing credentials, tokens, or personal data in evidence.

## Run summary
Report:
1. Pages, states, and viewports assessed.
2. Design checks and results.
3. Automated accessibility scan results.
4. Agent-assisted or human checks actually completed.
5. Defect proposals requiring review (status `proposed`) and existing bug references.
6. Items needing human review.
7. Blocked and untested items.
8. Paths to saved tests, reports, and evidence, where created.

If no automated violations are found, say:
"No violations were detected by the configured automated checks
in the tested states. This does not establish WCAG 2.1 AA conformance."

Do not say "WCAG compliant" or "fully accessible" based on this run alone.