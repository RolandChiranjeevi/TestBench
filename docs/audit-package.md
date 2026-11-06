# Audit packages: bug reports from a test agent

A test agent (a person's script, or an AI agent) can leave an **audit package** behind: its findings, the evidence for them, the **manual
test cases** it proposes and its own readable report. Testbench imports the package and shows every finding as a **proposal** on the
**Bug reports** page and every manual test as a **proposal** on the **Agent proposals** page. A person reads it and accepts or rejects it.
Nothing is sent to Jira or Linear by the import, nothing is run, and accepting is only a decision made in Testbench.

What the agent should test against is the project's **requirements**, which it reads from Testbench: see [requirements.md](requirements.md).

A small working example is in [`examples/audit-package/`](../examples/audit-package/). It is meant for a project with the key `SHOP` (the demo project).

If you write the agent that produces packages, read [agent-audit-guide.md](agent-audit-guide.md) too: it covers stable ids and has a checker (`npm run audit:package`).

## Getting a package in

| Way | How |
|---|---|
| **Upload** | **Bug reports, Import audit package**: choose a zip, or choose the folder. You see a preview (what is new, unchanged, changed, which files or references have problems) and nothing is written until you click **Import as proposals**. |
| **GitHub** | Upload the package as a workflow artifact **named `testbench-audit-<anything>`** (the name of the artifact, not of the workflow or step). With automatic import switched on for the repository (Import results) **and the uploading workflow named under "Workflows allowed to deliver audit packages"**, Testbench picks it up on its next check and imports it as proposals without any further approval. |

```yaml
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: testbench-audit-${{ github.run_id }}
    path: audit-package/
```

The artifact can be uploaded by any job, in the same workflow run as the tests or in another one. Both ways use the same validation.

## Layout

```
manifest.json      required: the audit, and every file with its sha256 and size
bugs.json          required: the findings
manual-tests.json  optional: manual test cases for a person to review and run
test-plan.json     optional: the plan of the audit: plan items and coverage gaps
report.md          optional: the agent's readable audit. Stored and shown as plain text, never interpreted.
evidence/...       files that findings point to (screenshots, logs, ...)
```

A zip may hold the files at its root or inside one folder. `results/` (test results) and `cases.json` (the project's own test cases) are not
imported from a package; if they are present, the preview says so. Test results keep going through the normal import. A package without
`manual-tests.json` imports exactly as before.

### manifest.json

```json
{
  "format": "testbench-audit-package",
  "version": 1,
  "audit": {
    "id": "audit-2026-11-02-001",
    "title": "Checkout audit",
    "startedAt": "2026-11-02T09:00:00Z",
    "finishedAt": "2026-11-02T09:40:00Z",
    "project": "SHOP",
    "agent": { "name": "my-agent", "version": "0.3", "model": "optional" },
    "review": { "status": "self-reviewed", "method": "each finding reproduced twice", "reviewer": "agent" },
    "github": { "repo": "owner/repo", "runId": 123456 }
  },
  "files": [ { "path": "evidence/a.png", "sha256": "<64 hex characters>", "size": 1234 } ],
  "parts": { "bugs": "bugs.json", "manualTests": "manual-tests.json", "testPlan": "test-plan.json", "narrative": "report.md" }
}
```

- `audit.id` is **the agent's own id** for the audit. It is not GitHub's run id, and the two are kept apart. Reports are identified by this id plus the finding's `sourceId`.
- `audit.project` must be the key of the project you import into. A package for another project is refused, whole.
- `audit.github` is optional. It names the GitHub run the audit belongs to, so the audit can be linked to that run when it has been imported. For packages that come from GitHub the real run is used and this field is ignored (with a warning if they differ).
- `files` lists every evidence file. A file that is not listed is not imported.

### bugs.json

```json
{ "version": 1, "bugs": [ {
  "sourceId": "BUG-001",
  "title": "Order total shows 0 kr after applying a discount code",
  "description": "…", "steps": ["…", "…"], "expected": "…", "actual": "…",
  "environment": "staging", "url": "https://…",
  "toolImpact": { "tool": "axe-core", "value": "serious", "ruleId": "label" },
  "agentSeverity": "high",
  "confidence": 0.8,
  "foundAt": "2026-11-02T09:12:00Z",
  "agentReview": { "status": "confirmed", "method": "reproduced twice", "notes": "" },
  "fingerprint": "cart-discount-total-zero",
  "recurrenceOf": "BUG-007",
  "refs": { "requirements": ["REQ-2"], "cases": ["SHOP-6"], "tests": ["suite › test name"] },
  "evidence": [ { "path": "evidence/a.png", "label": "Cart after applying SAVE10" } ]
} ] }
```

Only `sourceId` and `title` are required. `agentSeverity` is one of `low`, `medium`, `high`, `critical`. Unknown fields are ignored, **including
any status**: the agent cannot accept its own report.

### manual-tests.json

Manual tests are checks an automatic run cannot decide: whether a screen reader announces the checkout sensibly, whether the focus order
follows the visual order, whether an error message helps. The agent **proposes** the test. A person reviews it, runs it and judges the
result. The agent never gives a result or a status, and Testbench does not run manual tests.

A proposal is an **inbox**, not a second kind of test. The project has one place for tests that people run, **Test cases** (run in **Runs**),
and automated tests from CI link to those cases. So the flow is: the agent proposes, a person **accepts**, then clicks **Create test case**.
That makes a normal test case (`SHOP-12`) from the proposal: its steps, the expected result (on the last step), the priority, the tags
`agent-proposed`, the category and `wcag-<criterion>`, and a link to every requirement the proposal names. It is run and edited like any other case, and
**its results are what show how well a requirement is tested**. The proposal keeps pointing at its case, and the case points back at the proposal.

```json
{ "version": 1, "tests": [ {
  "sourceId": "checkout-screen-reader-focus-order",
  "title": "The checkout is understandable with a screen reader and the focus order follows the visual order",
  "description": "Needs a person with a screen reader.",
  "preconditions": "A cart with one item. VoiceOver or NVDA running.",
  "steps": ["Open the checkout and move through it with Tab only", "Listen to what is announced", "Compare the focus order with the screen"],
  "expected": "Every control is announced with a matching name and role, and focus moves top to bottom, left to right.",
  "priority": "high",
  "category": "accessibility",
  "wcag": ["1.3.2", "2.4.3", "4.1.2"],
  "viewports": [ { "device": "iPhone 13", "width": 390, "height": 844 }, { "breakpoint": "md", "width": 768 } ],
  "refs": { "requirements": ["CHECKOUT-A11Y-1"], "cases": ["SHOP-6"], "tests": [] }
} ] }
```

| Field | Rule |
|---|---|
| `sourceId` | Required. The test's **stable id** inside the audit: letters, digits and `. _ : - /`, at most 120 characters, unique in the file. Derive it from what the test checks, never from its position. |
| `title` | Required, at most 200 characters. |
| `steps` | Required, 1 to 50 steps, one non-empty string each. |
| `expected` | Required: what should happen. |
| `priority` | Required: `low`, `medium`, `high` or `critical`. This is the agent's priority; a person sets their own separately. |
| `category` | Required: `functional`, `accessibility`, `responsive`, `usability`, `security` or `other`. |
| `description`, `preconditions` | Optional text. |
| `wcag` | Optional: WCAG success criteria as numbers such as `2.4.3` or `1.4.10` (at most 20). Name them for accessibility tests. |
| `viewports` | Required (at least one) for a `responsive` test, optional otherwise. Each names a `device`, a `width` (and `height`) in pixels, or a `breakpoint`; at most 10. |
| `refs` | Optional: `requirements` (`REQ-3`, or the stable id a requirement was imported with), `cases` (`SHOP-6`) and `tests`. Looked up only in the project being imported into, like the references of bug reports. |

At most 200 tests and 10 MB. Unknown fields are ignored, **including any status or result**. A test that breaks a rule refuses the **whole
package** and nothing is stored, bug reports included, with a message that names the test and the field.

### test-plan.json

The plan of the audit, optional: what the audit planned to check, and what it did not verify. It is shown in the **Audits** tab (**Test plan**) and on each requirement it names.

```json
{ "version": 1,
  "planItems": [ {
    "sourceId": "TPI-001",
    "title": "Add a todo, the exact text is shown in the list",
    "type": "Functional", "risk": "High", "priority": "High", "readiness": "ready",
    "preconditions": "The list is empty",
    "testData": "QA-AUDIT-1",
    "steps": ["Type the text in the new-todo field", "Press Enter"],
    "acceptanceCriteria": "A todo with the exact text is shown in the list",
    "automation": "Yes, exploration",
    "refs": { "requirements": ["REQ-1"] }
  } ],
  "coverageGaps": [ {
    "sourceId": "CG-001",
    "description": "Validation (empty, long, special characters) is not verified: other test data is out of scope.",
    "refs": { "requirements": ["REQ-LOCAL-002"] }
  } ] }
```

| Field | Rule |
|---|---|
| `planItems[].sourceId`, `coverageGaps[].sourceId` | Required: the item's stable id in the file (`TPI-001`, `CG-001`): letters, digits and `. _ : - /`, at most 120 characters, unique in its list. |
| `planItems[].title` | Required, at most 200 characters. |
| `coverageGaps[].description` | Required: what was not verified and why, at most 5000 characters. |
| `type`, `risk`, `priority`, `automation` | Optional text (50, 200, 50 and 200 characters). |
| `readiness` | Optional: `ready` or `needs-clarification`. |
| `preconditions`, `testData`, `acceptanceCriteria` | Optional text (5000, 2000 and 5000 characters). |
| `steps` | Optional, at most 50 steps of at most 1000 characters. |
| `refs.requirements` | Optional: requirements named as `REQ-3` or by the stable id they were imported with (`REQ-LOCAL-002`). Matched against the project's requirements when they are shown, so a requirement created after the import is found without another import. A reference that matches nothing is shown as not found. |

At most 500 plan items and 500 coverage gaps, and 10 MB. A file that breaks a rule refuses the **whole package** and nothing is stored. Name the file in `parts.testPlan` or call it `test-plan.json`; it needs no entry in `files`.

- **It is a plan, not a test.** Plan items are kept apart from test cases, runs and results, and never count towards a requirement having a test.
- **The latest import of the same audit wins.** A package with a `test-plan.json` replaces that audit's plan (an empty file empties it); a package without one says nothing about the plan and leaves it as it is. The preview counts new, unchanged, updated and removed items.
- **Deleting the audit deletes its plan.**
- **Reserved:** `inconclusive` is reserved as a status of its own (with `pass`, `fail`, `blocked` and `skipped`) for the executions of a later version. Plan items carry no result yet.

## What the import does

- **Manual tests are kept apart until a person turns one into a test case.** They are stored separately from the project's own test cases, from automated results and from bug reports, and show on their own page. They start as `proposed`; a person can accept, reject or reopen one, and can edit the title, description, preconditions, steps, expected result and priority. The agent's version and the person's version are separate: the agent's priority and the person's priority are two fields, what the agent wrote stays in the test's revisions, and a person's review is never taken as the agent's judgement. Nothing runs a manual test and nothing creates a result.
- **Everything starts as `proposed`.** The agent's own review (`agentReview`, and `audit.review`) is kept as information about where the report came from, and nothing more.
- **Three separate judgements** are kept apart: the tool's impact (`toolImpact`), the agent's severity, and *your* severity, which you set when you review.
- **References** are looked up only in the project you import into: `REQ-n` a requirement, `SHOP-n` a test case (the project's own key), `tests` an automated test by its full name or title. A reference that does not resolve is **shown as unresolved** (not found, another project's key, or ambiguous), and *Check again* resolves it later, for instance after the case has been created. A reference whose target was deleted later is shown as such.
- **Run and result.** If the audit names a GitHub run that has been imported, the audit and its reports are linked to it. If that run has not been imported yet, the audit says so, and is linked when it is. A report is linked to a single result only when a test named in `refs.tests` has exactly one result in that run. A report does not need a run or a result.
- **Evidence** is checked against the manifest (size and sha256), the file type (no SVG or HTML, which could run scripts), the size (50 MB per file) and the path (it must stay inside the package). A file that fails is not stored, and the report shows which file and why. If the file arrives with a later import of the same package, it is filled in.

## Importing the same thing again

A report or a manual test is identified by `(project, audit.id, sourceId)`. Everything below holds for both; for manual tests, read "report" as "test".

| Case | What happens |
|---|---|
| The same report again (the same package from GitHub and from an upload, or a re-run) | Nothing changes. |
| Changed content, report still untouched (proposed, never edited, not linked to an external issue) | The working copy is updated; the older version stays as a revision. |
| Changed content, but you have **reviewed, edited or linked** it | **Your version is not touched.** The newer version waits on the report ("The agent sent a newer version") with a comparison, and you choose *Use the agent's version* or *Keep mine*. |
| A report that is **not in the package** this time (it was in an earlier run of the same audit) | **Nothing happens to it.** It is not removed, closed, archived or marked as fixed. Testbench only shows that it was not seen in the latest run (**Not present in latest audit run**, with the run and date it was last seen). If it comes back, it is the same report, and the two rows above apply to a new version. |
| A manual test **that has become a test case**, and the agent sends a newer version | The test case is **never changed by an import**. The newer version waits on the proposal; **Use the agent's version** (your choice) then also replaces the case's title, description, preconditions, steps and priority, keeping the case's number, its step rows and all results. **Keep mine** leaves the case alone. |
| A **manual test** that is not in the package this time | Same as a report: nothing happens to it, and Testbench shows **Not present in latest audit run**. A package that has **no `manual-tests.json` at all** says nothing about manual tests, so nothing is marked missing; an **empty** list (`"tests": []`) does say that none were listed. |
| The same bug in a **new** audit | A new report. If it has the same `fingerprint` as another, the two are pointed out to each other, and you can mark one as a duplicate of the other. Nothing is merged automatically. |

You can also record that an **existing external issue** (Jira, Linear or other) already covers a report. That stores a link; it calls no API.

## Deleting

- **A report**: confirmation is only needed when it is accepted or linked. Its evidence files go with it. The external issue is never touched.
- **A run**: reports linked to it stay (they just lose the link).
- **An audit**: untouched proposals and the stored audit report are removed. Reports you have reviewed, edited or linked **stay**, as standalone reports. They keep a note of the audit they came from (its id, title, agent, times, source) and all their evidence. If the same package is imported again, those reports are found again and re-attached to the audit.
- **A manual test** can be deleted by a person; an accepted one asks for confirmation. The test case made from it stays. If that test case is deleted, the proposal can become a test case again.
- **An audit** also removes its untouched manual-test proposals. Manual tests a person has accepted, rejected or edited stay, as standalone tests with a note of where they came from.
- **A project** removes everything, including the evidence files, after the usual safety backup.

## Limits

| | |
|---|---|
| Files in a package | 1000 |
| Unpacked size of a package | 500 MB (checked from the zip's table of contents before anything is unpacked) |
| One file | 50 MB |
| Findings in one package | 200 |
| Manual tests in one package | 200 |
| `manifest.json` / `bugs.json` / `manual-tests.json` / report | 1 MB / 20 MB / 10 MB / 5 MB |
| GitHub artifact | 200 MB |

A package that breaks a rule about its structure, size or project is refused as a whole and nothing is stored. Files written before a failure are removed again.

## GitHub import: what to know

- Packages are followed **per artifact** (an artifact's id never changes), not per workflow run. A package that shows up *after* its run's test results were imported, or after the run was skipped for having no test reports, is still fetched. A package that arrives *before* its run is imported is linked when the run arrives.
- Artifacts named `testbench-audit-*` are never read as test reports, so their files cannot be counted as test results.
- **Only workflows you name may deliver packages.** Each GitHub source has a list, **Workflows allowed to deliver audit packages**, of workflow file names (`audit.yml`, the `.github/workflows/` prefix is optional) and/or numeric workflow ids, separated by commas. The flow is: the right repository, then the right workflow, then an artifact named `testbench-audit-*`, then the Testbench project whose key the package names.
  - Which workflow made an artifact is looked up from the artifact's run before anything is downloaded. A package from any other workflow is left alone, even with the right artifact name, and is not remembered: allow its workflow later and it is imported on the next check (if it is still among the 100 newest artifacts).
  - **An empty list allows no workflow, never all of them.** If there are new `testbench-audit-*` artifacts and the list is empty, the source shows a configuration error and nothing is imported. A repository without such artifacts shows no error. A malformed entry (not an id or a `.yml` name) is reported the same way.
  - A run that comes from a fork of the repository, or whose workflow cannot be looked up (for example a rate limit), is not trusted: nothing is downloaded, and the lookup is retried on the next check.
  - This list only concerns audit packages. The source's single *Workflow file* setting still decides which runs are listed for test results, and empty there still means all workflows.
- **Limit: only the repository's 100 most recent artifacts are looked at** each time, and artifacts expire on GitHub's schedule. After a long pause (more than 100 artifacts in the meantime, or an expired artifact) a package may not be found. Complete catching-up after a long gap is **not** promised: download the package and upload it by hand.
- A package that is refused (for example the wrong project key) is **not retried**, and the reason is shown on the Bug reports page under **Audits**. A temporary failure (network, rate limit) is retried on the next check.
- Only artifacts created after automatic import was switched on, and matching the branch filter, are imported.

## Not in this version

Publishing to Jira, status sync with the external issue and publishing many reports at once (an accepted report can be published to Linear one at a time, after a preview; see the README), importing the project's own test cases or test results from a package, running manual tests or recording their results in Testbench (an accepted manual test is where a person takes over), suggesting duplicates automatically, and counting reports in dashboards and sprint reports. Reports that are not accepted never appear in those numbers.
