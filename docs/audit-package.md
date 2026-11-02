# Audit packages: bug reports from a test agent

A test agent (a person's script, or an AI agent) can leave an **audit package** behind: its findings, the evidence for them and its own
readable report. Testbench imports the package and shows every finding as a **proposal** on the **Bug reports** page. A person reads it and
accepts or rejects it. Nothing is sent to Jira or Linear by the import, and accepting is only a decision made in Testbench.

A small working example is in [`examples/audit-package/`](../examples/audit-package/). It is meant for a project with the key `SHOP` (the demo project).

If you write the agent that produces packages, read [agent-audit-guide.md](agent-audit-guide.md) too: it covers stable ids and has a checker (`npm run audit:package`).

## Getting a package in

| Way | How |
|---|---|
| **Upload** | **Bug reports, Import audit package**: choose a zip, or choose the folder. You see a preview (what is new, unchanged, changed, which files or references have problems) and nothing is written until you click **Import as proposals**. |
| **GitHub** | Upload the package as a workflow artifact **named `testbench-audit-<anything>`** (the name of the artifact, not of the workflow or step). With automatic import switched on for the repository (Import results), Testbench picks it up on its next check and imports it as proposals without any further approval. |

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
report.md          optional: the agent's readable audit. Stored and shown as plain text, never interpreted.
evidence/...       files that findings point to (screenshots, logs, ...)
```

A zip may hold the files at its root or inside one folder. `results/` (test results) and `cases.json` (test cases) are not imported from a
package in this version; if they are present, the preview says so. Test results keep going through the normal import.

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
  "parts": { "bugs": "bugs.json", "narrative": "report.md" }
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

## What the import does

- **Everything starts as `proposed`.** The agent's own review (`agentReview`, and `audit.review`) is kept as information about where the report came from, and nothing more.
- **Three separate judgements** are kept apart: the tool's impact (`toolImpact`), the agent's severity, and *your* severity, which you set when you review.
- **References** are looked up only in the project you import into: `REQ-n` a requirement, `SHOP-n` a test case (the project's own key), `tests` an automated test by its full name or title. A reference that does not resolve is **shown as unresolved** (not found, another project's key, or ambiguous), and *Check again* resolves it later, for instance after the case has been created. A reference whose target was deleted later is shown as such.
- **Run and result.** If the audit names a GitHub run that has been imported, the audit and its reports are linked to it. If that run has not been imported yet, the audit says so, and is linked when it is. A report is linked to a single result only when a test named in `refs.tests` has exactly one result in that run. A report does not need a run or a result.
- **Evidence** is checked against the manifest (size and sha256), the file type (no SVG or HTML, which could run scripts), the size (50 MB per file) and the path (it must stay inside the package). A file that fails is not stored, and the report shows which file and why. If the file arrives with a later import of the same package, it is filled in.

## Importing the same thing again

A report is identified by `(project, audit.id, sourceId)`.

| Case | What happens |
|---|---|
| The same report again (the same package from GitHub and from an upload, or a re-run) | Nothing changes. |
| Changed content, report still untouched (proposed, never edited, not linked to an external issue) | The working copy is updated; the older version stays as a revision. |
| Changed content, but you have **reviewed, edited or linked** it | **Your version is not touched.** The newer version waits on the report ("The agent sent a newer version") with a comparison, and you choose *Use the agent's version* or *Keep mine*. |
| The same bug in a **new** audit | A new report. If it has the same `fingerprint` as another, the two are pointed out to each other, and you can mark one as a duplicate of the other. Nothing is merged automatically. |

You can also record that an **existing external issue** (Jira, Linear or other) already covers a report. That stores a link; it calls no API.

## Deleting

- **A report**: confirmation is only needed when it is accepted or linked. Its evidence files go with it. The external issue is never touched.
- **A run**: reports linked to it stay (they just lose the link).
- **An audit**: untouched proposals and the stored audit report are removed. Reports you have reviewed, edited or linked **stay**, as standalone reports. They keep a note of the audit they came from (its id, title, agent, times, source) and all their evidence. If the same package is imported again, those reports are found again and re-attached to the audit.
- **A project** removes everything, including the evidence files, after the usual safety backup.

## Limits

| | |
|---|---|
| Files in a package | 1000 |
| Unpacked size of a package | 500 MB (checked from the zip's table of contents before anything is unpacked) |
| One file | 50 MB |
| Findings in one package | 200 |
| `manifest.json` / `bugs.json` / report | 1 MB / 20 MB / 5 MB |
| GitHub artifact | 200 MB |

A package that breaks a rule about its structure, size or project is refused as a whole and nothing is stored. Files written before a failure are removed again.

## GitHub import: what to know

- Packages are followed **per artifact** (an artifact's id never changes), not per workflow run. A package that shows up *after* its run's test results were imported, or after the run was skipped for having no test reports, is still fetched. A package that arrives *before* its run is imported is linked when the run arrives.
- Artifacts named `testbench-audit-*` are never read as test reports, so their files cannot be counted as test results.
- **Limit: only the repository's 100 most recent artifacts are looked at** each time, and artifacts expire on GitHub's schedule. After a long pause (more than 100 artifacts in the meantime, or an expired artifact) a package may not be found. Complete catching-up after a long gap is **not** promised: download the package and upload it by hand.
- A package that is refused (for example the wrong project key) is **not retried**, and the reason is shown on the Bug reports page under **Audits**. A temporary failure (network, rate limit) is retried on the next check.
- Only artifacts created after automatic import was switched on, and matching the branch filter, are imported.

## Not in this version

Publishing a report to Jira or Linear (including per-project destinations and attachments to the external issue), importing test cases or test results from a package, suggesting duplicates automatically, and counting reports in dashboards and sprint reports. Reports that are not accepted never appear in those numbers.
