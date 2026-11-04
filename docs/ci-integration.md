# CI results as bugs

Testbench can receive the test results of your CI. A test that fails becomes one bug, keyed by the test's stable key. The same test failing
again, on any branch, is added to that bug instead of making a new one. Agent audits, manual findings and CI results then land in the same place.

```
git push → CI runs the tests → CI sends the results → Testbench makes or updates one bug per failing test → a person reviews, prioritises, assigns and closes it
```

## Set up

1. In Testbench open **Bug reports → CI** and **Create token**. The token is shown once; only a hash is kept. A token works for one project and can be revoked.
2. Store it as a secret in your CI. Never put it in code or logs.
3. Send the results. For GitHub Actions and Playwright see [the example](../examples/github-actions/testbench-report.yml) and
   [`scripts/ci-report.mjs`](../scripts/ci-report.mjs): one file without dependencies that reads `test-results/results.json` (Playwright's JSON reporter).

If your Testbench is behind a domain, add it to `TESTBENCH_ALLOWED_HOSTS` (see the README). If it has a password (`TESTBENCH_PASSWORD`), the CI route still
works without it: it never uses the login, it always requires the token.

## The request

```
POST /api/projects/{projectId}/ci/test-results
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "runId": "github-actions-12345-1",
  "commitSha": "abc123",
  "branch": "feature/checkout",
  "repository": "org/repo",
  "pipelineUrl": "https://github.com/org/repo/actions/runs/12345",
  "startedAt": "2026-11-04T07:00:00Z",
  "finishedAt": "2026-11-04T07:04:00Z",
  "results": [
    {
      "testKey": "e2e-checkout-empty-cart",
      "title": "Empty cart checkout fails",
      "status": "failed",
      "durationMs": 4210,
      "error": "Expected checkout button to be enabled",
      "steps": ["Add product to cart", "Remove product", "Open checkout"],
      "attachments": [{ "name": "trace.zip", "url": "https://github.com/org/repo/actions/runs/12345", "type": "trace" }],
      "tags": ["checkout", "e2e"]
    }
  ]
}
```

| Field | Notes |
| --- | --- |
| `runId` | The CI's own id for this run. Use a new one for every run and every re-run (GitHub: run id plus attempt). Required. |
| `commitSha`, `branch`, `repository`, `pipelineUrl`, `startedAt`, `finishedAt` | Shown on the bug and kept in the history. `pipelineUrl` must be an http(s) link. |
| `results[].testKey` | **Stable and deterministic** for the test, up to 300 characters, no control characters. The script uses file, titles and Playwright project. One result per key in a run. |
| `results[].status` | `passed`, `failed`, `skipped` or `flaky` (failed, then passed on retry). |
| `results[].attachments` | **Links** (`name`, `url`, optional `type`: trace, screenshot, log, video). Files are not uploaded in this version. Query strings and credentials are removed from links. |

The answer says what happened:

```json
{ "runId": "…", "replayed": false, "counts": { "passed": 1, "failed": 1, "flaky": 0, "skipped": 0 },
  "bugsCreated": 1, "bugsUpdated": 0, "reopened": 0, "resolvedSuspected": 0, "bugs": [{ "testKey": "…", "bugId": 7, "action": "created" }] }
```

If the same `runId` with the same content is sent again, nothing is changed and the answer says so: `replayed: true`, `bugsCreated`, `bugsUpdated`,
`reopened` and `resolvedSuspected` are all `0`, and each bug has `"action": "already_processed"`. `counts` still describes what the run contained.

Errors: `401` without a valid token for that project, `400` for an invalid payload (the message names the field), `409` when the `runId` was received before with
other content, `413` above 5 MB, `429` after repeated wrong tokens.

## What Testbench does with a result

| Result | What happens |
| --- | --- |
| `failed`, no bug for the key yet | A bug is created: source **CI**, review status *proposed*, workflow *open*, severity *medium*. |
| `failed`, bug exists | The failure is added to the bug (an *occurrence* with branch, commit, pipeline link, error and attachments). If the bug was *may be resolved* or *closed*, it goes back to *open*. Text you have edited is kept. |
| `flaky` | Marked **flaky**. A new flaky bug starts at *low* severity. CI never raises severity. A flaky result puts a *may be resolved* bug back to *open*, but does not reopen a closed one. |
| `passed`, bug exists | The bug's latest CI status becomes passed. When **no branch is failing any more** the bug is marked *may be resolved*. It is **never closed by CI**. |
| `passed` or `skipped`, no bug | Counted in the run, not stored. |
| bug is *rejected* or *duplicate* | Occurrences are still recorded, but its workflow is not changed. |

Several tests failing in one run make one bug each. Failures on several branches share one bug; the bug shows the latest result of each branch. The same
`runId` sent again changes nothing (the answer has `replayed: true`).

## Workflow and review are separate

Every bug, whatever its source, has a **workflow status** (*open*, *may be resolved*, *closed*) and an **assignee**. They are not the same as the review status
(*proposed*, *accepted*, *rejected*, *duplicate*), which is still your decision about whether it is a real bug. Changing workflow or assignee is not an edit of
the report's text, so it does not stop later imports from updating it. The bug lists what changed it and who (you or CI).

## What the bug shows

Source (CI, Agent audit or Manual), the latest CI status, the number of failed runs, branch and commit, a link to the CI run, the error, attachment links, the
latest result per branch and the history of runs. The list filters on source, workflow, severity, tag and exact test key.

## Safety and limits

- The route is authenticated by the token on every call. It is the only route that skips the browser guards (login cookie and `X-Testbench` header); a token opens nothing else.
- Tokens are stored as hashes, shown once, never logged, and the list of tokens never contains them.
- At most 5 MB per request and 5000 results, 100 steps, 20 attachments and 20 tags per result. Errors are cut at 8000 characters.
- Error text, steps and attachment names are scanned for things that look like credentials (bearer tokens, GitHub, AWS and Slack keys, `password=` and similar,
  `user:password@` in URLs) and those parts are replaced with `[redacted]`. This is a safety net, not a guarantee: do not let tests print secrets or production data.

## Things to know

- A feature branch that failed and never ran again keeps counting as failing, so the bug will not become *may be resolved* until that branch passes. Close the bug yourself if the branch is gone.
- Closing is yours. A closed bug opens again by itself when its test fails again.
- If one workflow run reports from several jobs, give each job its own `TESTBENCH_RUN_SUFFIX`, since a `runId` can be used once.
- A test whose key changes (renamed file or title) is a new test and gets a new bug. Keep keys stable if you rename tests.
