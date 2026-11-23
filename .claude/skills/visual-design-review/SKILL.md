---
name: visual-design-review
description: Reviews web UI layout against explicit design requirements, validates link integrity and destination correctness, and evaluates accessibility against WCAG 2.2 Level A and AA. Use when the user requests visual validation, layout checks, link checks, or accessibility testing.
---

# Visual Design, Link and Accessibility Review

## Purpose

Review:

1. Layout and visual behaviour against explicit design requirements.
2. Link integrity and whether links resolve to their intended destinations.
3. Accessibility against WCAG 2.2 Level A and AA.

Keep design, link and accessibility findings separate.

Identifiers, execution statuses, reason codes, evidence types and the audit
package are defined in `../references/audit-contract.md`. Use them as written.
Do not define your own. Paths are relative to this `SKILL.md`. `qa-run` calls
this skill in step 4 of the audit.

Do not invent design requirements, expected link destinations or accessibility
requirements.

Do not claim full WCAG conformance based on automated checks alone.

## Inputs

Use information already provided in the task or project:

- Target URL and environment.
- Pages, components and states in scope.
- Supported viewports.
- Design references or explicit layout requirements.
- Existing test plan and known bug reports.
- Link inventory, route map, sitemap, content model or navigation structure,
  where available.
- Expected link destinations, link purpose, allowed redirect behaviour,
  required locales/markets and authentication requirements.

If a design requirement or expected link destination is missing, continue with
checks that have a clear basis and mark uncertain results as `inconclusive`
with reason `needs-design-reference` or `insufficient-evidence`.

Do not request passwords in reports or store secrets in test code.

## Tools and execution modes

### Browser exploration

Use the available Playwright MCP browser tools to:

- Navigate and interact with the page.
- Set viewport sizes.
- Capture screenshots.
- Inspect element geometry, computed styles and the DOM.
- Observe relevant page states.
- Follow links in the browser when destination behaviour requires it.

### HTTP link validation

Use available HTTP tooling or browser network inspection to validate link
reachability and redirects.

A browser navigation is preferred when the link requires JavaScript, cookies,
authentication, client-side routing or fragment navigation.

A direct HTTP request may be used for a fast reachability check, but it must
not be treated as proof that the user reaches the correct experience.

### Saved automated tests

When asked to create reusable tests:

- Save checks in the project's Playwright Test suite.
- Use `@axe-core/playwright` for automated accessibility scans.
- Reuse the project's configuration and helpers.
- Ask before installing missing dependencies.
- Do not replace existing tests without approval.

A check performed through MCP is not a saved automated test. Report clearly
which mode was used.

## Workflow

1. Read the task, relevant test plan, available design references and link
   expectations.
2. Identify the checks that have an explicit expected result.
3. Use the viewports specified by the task.
   If none are specified, propose 375, 768 and 1440 CSS px.
   Record viewport width and height in the results.
4. Perform the design checks.
5. Identify links in scope and perform link integrity and destination checks.
6. Perform the automated accessibility checks when available.
7. Record checks requiring human review separately.
8. Capture evidence for findings.
9. Compare findings with existing bug reports to avoid duplicates.
10. Summarize coverage, failures, limitations and untested items.

Do not publish findings externally without explicit approval.

## Design checks

### Text centering

Check centering only where required by the user or design.

Before creating a centering assertion, identify:

- The target text.
- Its intended container.
- Whether centering is horizontal, vertical or both.
- The relevant viewport and component state.
- The agreed tolerance in CSS pixels.

If these details are unclear, ask or mark the check as `inconclusive`.

Distinguish between:

- A text element centered within its parent container.
- Text centered within the text element's own content box.

Do not infer rendered centering from `text-align`, flexbox or grid
declarations alone.

Measure the relevant container and text geometry where feasible.
For text, use rendered text ranges or line boxes where appropriate, rather
than assuming the element's bounding box equals the text bounds.

Account for padding, borders, multiline text and font loading.
Document the measurement method and its limitations.

Use the tolerance specified by the task or design.
If no tolerance exists, propose one for approval rather than silently treating
it as a product requirement.

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
- Horizontal scrolling only when it hides required content, prevents access to
  controls, or conflicts with an explicit responsive requirement.
- Misalignment against an explicit grid or container requirement.
- Wrapping or truncation that conflicts with the design or hides content.

Do not classify horizontal scrolling as a defect solely because it occurs.
First determine whether it is intentional, whether required content remains
reachable, and whether it conflicts with a requirement, design reference or
accessibility criterion.

If the behaviour is intentional or cannot be assessed against a clear
requirement, record it as an observation or `inconclusive`; do not create a
bug proposal.

Do not classify a line break, orphan word, intentional truncation or
left-aligned text as a defect solely because of a stylistic preference.

Use representative content and page states where available.
Do not change production data to create test cases without approval.

## Responsive and interactive state checks

For each page, component or flow in scope:

1. Test the initial state at each agreed viewport.
2. Test interactive states relevant to the requirement:
   - Buttons and links: default, hover, focus, active, disabled and loading
     states where applicable.
   - Menus, dropdowns and navigation: closed, open, focus within, selection
     and close behaviour.
   - Dialogs and modals: open, focus behaviour, close and content overflow.
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

## Link checks

Perform link checks for all links that are within the agreed scope.

Treat each link as a separate check with:

- Source page, component and viewport.
- Link locator.
- Visible link text and accessible name.
- Raw `href` and resolved absolute URL.
- Link type.
- Expected destination and the source of that expectation.
- Actual HTTP result, final URL and destination evidence.
- Execution status and reason code from the audit contract.

Do not infer the intended destination from link text alone. If no expected
destination is available, record the result as `inconclusive` with reason
`needs-design-reference` or `insufficient-evidence`.

### Link discovery

Collect links from the rendered DOM, not only from static source code.

For each link, record:

- Locator, for example role, accessible name and `href`.
- Visible text and accessible name.
- Resolved absolute URL.
- Link type: internal, external, anchor, download, `mailto:`, `tel:` or
  JavaScript-driven navigation.
- `target`, `rel` and `download` attributes where present.
- Whether the link opens a new browser context.
- Whether the link is an in-page anchor.
- Whether activation is handled by JavaScript rather than a normal `href`.

Include links rendered after relevant interactions, such as opening a menu,
expanding a section, completing a form step or entering an authenticated area.

Do not recursively crawl the site unless explicitly requested.

### Link reachability

For HTTP-based links, determine reachability using a controlled request.

Prefer a `HEAD` request. If the server rejects, mishandles or returns an
unreliable result for `HEAD`, repeat with `GET`.

Record:

- Initial URL.
- HTTP status.
- Redirect chain, including each `Location` target.
- Final URL.
- Final HTTP status.
- Content type, where relevant.
- Request method, timeout, retries and environment.

Classify results as follows:

- `2xx`: reachable.
- `3xx`: reachable only after redirect; record the complete redirect chain.
- `404` or `410`: broken link.
- `401` or `403`: potentially authentication or authorization related; do not
  report as broken without checking the agreed authenticated context.
- `5xx`, DNS failure, TLS failure or timeout: retry within agreed limits.
  If it persists, report as `blocked` or `inconclusive` with reason `tooling`,
  not as a product defect.

Do not treat a successful HTTP status as proof that the destination is correct.

### Non-HTTP links

For `mailto:` and `tel:` links, validate that:

- The URI uses the expected scheme.
- The address or telephone number is present and correctly formatted for the
  intended context.
- The link does not contain unexpected encoding, whitespace or broken
  parameters.
- The accessible name and visible text match the intended action where
  relevant.

Do not attempt to send an email, place a call or open an external
communication client as part of an automated check.

Record the result as `pass` when the URI is structurally valid and matches the
expected action. Record it as `fail` when the URI is malformed, missing or
clearly points to the wrong recipient or number.

### Destination correctness

Compare the final destination with the explicit expected destination.

Apply the following validation levels in order. Stop at the first level that
is defined and can be verified reliably:

1. Exact expected URL, where defined.
2. Expected URL pattern, route, query parameters or locale.
3. Expected page type, for example product page, help article, category page
   or login page.
4. Expected page title, primary heading, breadcrumb or key content.
5. Expected DOM structure or component marker.
6. Screenshot comparison, only as supporting evidence.

For an anchor link, navigate to the destination in the browser and verify that
the referenced fragment target is present and reachable.

Check that:

- The destination document contains an element with the referenced `id` or
  another valid fragment target.
- The browser moves focus or scroll position to the target when the link is
  activated.
- The target is not hidden solely by an overlay, collapsed section or
  client-side state.
- The target remains usable at the tested viewport.

A fragment is resolved in the browser context and is not validated by the HTTP
status of the base URL alone.

Perform browser navigation for anchor links whenever the fragment is relevant
to the scope. Do not rely only on the presence of the target ID in the DOM.

Treat a `2xx` response as a potential soft failure when the final page
contradicts the expected destination, for example:

- A search page instead of the expected article.
- A login or consent page when an authenticated destination was expected.
- A generic error, empty state or “page not found” message despite HTTP 200.
- A different locale, market, product or campaign than specified.

### Redirect assessment

Do not treat a redirect as a defect when the final destination is correct.

Record the complete redirect chain and assess the final destination using the
destination-correctness rules.

Record a redirect as:

- `pass` when the final destination is correct.
- `inconclusive` with reason `needs-design-reference` when the final
  destination cannot be verified against an available expectation.
- `fail` when the final destination is incorrect, the redirect chain is broken,
  or the redirect conflicts with an explicit requirement.

Do not recommend changing a redirecting `href` solely because a redirect
exists. Recommend updating the source `href` only when the project's link
policy or an explicit requirement supports it.

### External links

Test external links actively, but conservatively.

Apply conservative rate limits, timeouts and a small number of retries.
Do not recursively crawl external sites unless explicitly requested.

Respect robots directives, authentication boundaries and terms that limit
automated access. If an external link cannot be verified safely, record it as
`blocked` or `inconclusive` with reason `tooling` and explain the limitation.

Do not treat an external site's temporary outage, bot protection, geographic
restriction or CAPTCHA as a defect in the reviewed product without
corroborating evidence.

### Authenticated links

Test links that require authentication only when the project already provides
usable test credentials, session cookies, test accounts or an approved
authentication helper.

Do not request passwords in reports or store secrets in test code.

If authentication is required but no approved test context is available,
record the link check as `blocked` or `inconclusive` with reason `tooling`.
Do not report it as a product defect.

### Link text quality

Assess link text quality as an observation or usability/consistency risk, not
as an automatic product defect.

Flag the following patterns when they occur in scope:

- Generic link text such as “click here”, “read more”, “here” or equivalents.
- Multiple links with the same visible text or accessible name that lead to
  different destinations.
- Link text that does not describe the destination or action.
- Link text that conflicts with the actual destination.

Record such findings as `usability-risk` or `consistency-risk` with status
`inconclusive` and reason `needs-design-reference`.

Do not create a bug proposal for link text quality unless it violates an
explicit requirement, an explicit link expectation or a WCAG success criterion.

### Link check coverage

Record link results at two levels:

1. Per link:
   - Source page, component and viewport.
   - Link text and accessible name.
   - Link type.
   - Initial and final URL.
   - HTTP result and redirect chain, where applicable.
   - Expected destination and validation level used.
   - Result, reason code and evidence.

2. Per page, component or scope:
   - Total links discovered.
   - Links checked, skipped, blocked and inconclusive.
   - Number of `pass`, `fail` and `inconclusive` results.
   - Summary of broken links, incorrect destinations and redirect behaviour.
   - Links requiring human review.

Record for each link check:

- What was tested.
- Method: HTTP validation, browser navigation, DOM inspection or screenshot
  comparison.
- Result.
- Evidence.
- Limitations.

Do not report an untested link as passed.

## Accessibility target: WCAG 2.2 AA

The target includes applicable Level A and Level AA success criteria from
WCAG 2.2. WCAG 2.2 includes all criteria from 2.0 and 2.1, except 4.1.1
Parsing, which 2.2 removed. Do not report 4.1.1.

This skill provides scoped testing, not automatic certification.
Passing automated checks does not establish full conformance.

### Automated accessibility scans

For saved Playwright tests, use `@axe-core/playwright` with:

- `wcag2a`
- `wcag2aa`
- `wcag21a`
- `wcag21aa`
- `wcag22aa`

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

Record results the tool reports as incomplete as `inconclusive`, with the rule
ID. Do not silently suppress findings or add exclusions to make tests pass.
Document and justify any approved exclusions.

If the scanner is unavailable, report that the scan was not performed.
Do not present browser exploration as an equivalent automated scan.

### Targeted accessibility checks

Where in scope, assess:

- Keyboard access and navigation order.
- Keyboard traps.
- Visible keyboard focus.
- Accessible names and appropriate control semantics.
- Form labels, instructions and error identification.
- Zoom and reflow.
- Text and non-text contrast.
- Screen reader behavior.

This list is not a complete WCAG 2.2 AA checklist.

### WCAG 2.2 criteria for web UI

These criteria are new in WCAG 2.2. Assess the ones that apply to the agreed
scope. Automated scans cover little of them (`wcag22aa` currently covers target
size only), so most need manual or scripted checks.

| Criterion | Level | What to check |
|---|---|---|
| 2.4.11 Focus Not Obscured (Minimum) | AA | A focused element is not entirely hidden by sticky headers, footers, cookie banners or other overlays. Tab through the page and check. |
| 2.5.7 Dragging Movements | AA | Anything done by dragging (sorting, sliders, drag and drop) can also be done with a single pointer action or the keyboard. |
| 2.5.8 Target Size (Minimum) | AA | Pointer targets are at least 24 by 24 CSS pixels, or have enough spacing, or fall under an exception (inline text links, essential size). |
| 3.2.6 Consistent Help | A | Where a help mechanism (contact, chat, help link) appears on several pages, it is in the same relative place. |
| 3.3.7 Redundant Entry | A | Information the user already gave in the same process is not asked for again, unless essential or for security. |
| 3.3.8 Accessible Authentication (Minimum) | AA | Sign-in does not require a cognitive function test (remembering, transcribing, solving) unless an alternative exists. Password managers and paste must work. |

2.4.12 Focus Not Obscured (Enhanced), 2.4.13 Focus Appearance and 3.3.9
Accessible Authentication (Enhanced) are Level AAA and out of scope.

Use keyboard interaction when assessing keyboard focus.
Do not infer absence of a visible focus indicator only from `outline: none` or
missing `box-shadow`.

Consider other focus cues, including border, background, text and changes
rendered through pseudo-elements.

A computed-style change alone does not prove that the focus cue is visibly
distinguishable.

Do not infer absence of an accessible name solely from a missing label element
or `aria-label` attribute.
Inspect the computed accessible name and relevant naming relationships.

Do not claim screen reader testing was completed unless it actually was.
Do not mark a manual check as passed based only on an automated scan.

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
the relevant `requirement_id`, `test_plan_item_id` and evidence where
available, and have status `proposed`.

Do not create a manual test proposal for a criterion that is clearly outside
the confirmed scope; record it as `skipped` with reason `out-of-scope` instead.

## Finding handling

Before creating a bug report:

1. Identify the design requirement, link expectation or WCAG criterion
   involved.
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

- Finding type.
- Execution status and bug proposal status.
- Product severity and priority.
- Automated tool impact, if applicable.

Do not classify tool errors as product defects.
Do not automatically dismiss application errors as environment issues.

Create a bug proposal with status `proposed` immediately when a link check has
evidence that it violates an explicit link expectation or requirement, for
example:

- The link returns `404` or `410`.
- The final destination differs from an explicit expected destination.
- An anchor target is missing.
- The destination shows an error, empty state or “page not found” message
  despite an expected content destination.
- The link requires authentication but no approved test context is available;
  in this case, create a manual follow-up or blocked item rather than a product
  defect.

## Finding format

For each finding, record:

- `execution_id` of the check, and `bug_proposal_id` or existing bug ID if one
  exists.
- Category: Design, Link or Accessibility.
- Finding type: `design-deviation`, `link-integrity`, `usability-risk`,
  `consistency-risk` or `accessibility`.
- Title.
- URL and view (page, component or route).
- Viewport width and height.
- State: initial, hover, focus, open menu or dialog, error, empty, loading and
  so on.
- Design reference, if available, as a `design-reference` evidence ID.
  Otherwise write "none available".
- Requirement link: `requirement_id`, `test_plan_item_id` and the criterion,
  link expectation or WCAG success criterion involved.
- Affected element and relevant container.
- Expected result and its source.
- Actual result.
- User impact: who is affected, what they cannot do or understand, and how
  often.
- Reproduction steps.
- Assessment method and measurements, if applicable.
- Evidence IDs: screenshot, DOM excerpt, HTTP trace, redirect trace, axe
  result or test output. At least one.
- Severity and priority, with rationale if assigned.
- Limitations or required human review.

### Finding types

- **`design-deviation`**: the result differs from a design reference or an
  explicit layout requirement. The reference is cited as evidence. This can be
  `fail`.
- **`link-integrity`**: a link is unreachable, resolves to an unexpected
  destination, has a broken fragment, or otherwise conflicts with an explicit
  link requirement. This can be `fail` when the expected destination and
  evidence are available.
- **`usability-risk` or `consistency-risk`**: there is no design reference or
  explicit link expectation, but the result may hurt use or differs from
  similar parts of the product. Examples include generic or ambiguous link
  text, inconsistent link behaviour, or a link that appears to lead to an
  unexpected destination without a defined expectation.
  Record it as a risk, status `inconclusive` with reason
  `needs-design-reference`, and describe the impact. Do not call it a defect.
  It becomes a bug proposal only if a requirement, explicit link expectation or
  WCAG criterion is verifiably violated. Otherwise propose a manual test or ask
  for the design decision.
- **`accessibility`**: tied to a WCAG 2.2 criterion, kept apart from design and
  link findings.

When creating a bug proposal, use the project's bug-reporting skill and
`../bug-reporting/templates/bug-report.md`.
The template is mandatory for visual, link and accessibility findings as well.

Use evidence paths relative to the saved report.
Do not reference screenshots that were not actually saved.
Avoid exposing credentials, tokens or personal data in evidence.

## Run summary

Report:

1. Pages, states and viewports assessed.
2. Design checks and results.
3. Link checks and results:
   - Per-link results.
   - Per-page or per-scope summary.
   - Reachability, redirects and destination validation.
   - Broken links, incorrect destinations and anchor issues.
   - Link text quality observations and risks.
4. Automated accessibility scan results.
5. Agent-assisted or human checks actually completed.
6. Defect proposals requiring review (status `proposed`) and existing bug
   references.
7. Items needing human review.
8. Blocked and untested items.
9. Paths to saved tests, reports and evidence, where created.

If no automated violations are found, say:

"No violations were detected by the configured automated checks
in the tested states. This does not establish WCAG 2.2 AA conformance."

Do not say "WCAG compliant" or "fully accessible" based on this run alone.
