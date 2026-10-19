# Testbench

A local test management app: write manual test cases, execute them in runs, and import
Playwright / TestCafe / Selenium results (files or GitHub Actions artifacts).

```bash
npm install
npm run dev        # http://localhost:5173 (API on 127.0.0.1:4100)
```

Data lives in `data/testbench.db` (SQLite) and `data/uploads/`. Back up that folder to keep everything.

## Linking automated tests to cases

Each case gets an ID like `SHOP-12`. Put `@SHOP-12` in a test title (or a Playwright tag) and imports
link the test to the case automatically. You can also link by hand on **Automated tests**.

## Requirements

**Requirements** (sidebar, key `2`) is where you write down what the system should do: a title, description, priority, status
(draft, approved, deprecated) and a source such as a Jira story key or link. Link any number of test cases to a requirement,
from the requirement ("Link test cases") or from the case ("Requirements" section), and one case can cover several requirements.
Each requirement shows how well it is covered, from the latest result of its linked cases: **Passing**, **Failing**, **Partly tested**,
**Not run yet** or **No test cases**. Deprecated cases don't count. The dashboard shows requirement coverage, sprint reports list the
requirements that are failing or weren't run, and exports include them (JSON and a requirements CSV).

- **Auto-link with `@REQ-4`**: put it in a case's title, description or tag, or in an automated test's title or tag, and the case
  (for a test: the case it is linked to) is linked to requirement 4. This only ever adds links.
- **Bulk link**: tick cases on Test cases and choose **Link to requirement**. The **No requirement** tab lists cases nobody covers.
- **Start run**: on a requirement, runs all its linked cases as a manual run named after it.
- **Change history**: every edit to a requirement (wording, priority, status, source, linked cases) is recorded on the page.
  When the title or description changes, the linked cases are flagged **to review** (on the requirement, in its list, in the case
  editor and under the **Needs review** tab) until you confirm them with **Still correct**. Cases linked afterwards start confirmed.
- Manual bug drafts list the requirements the failed case covers.

## Backup and restore

**Backup & restore** (sidebar, key `8`) downloads one zip with all projects: the database and every uploaded file. Restore it on this or
another computer, without restarting. A restore validates the zip first and moves your current data to `data/previous/<time>` instead
of deleting it. The sidebar footer turns amber when there is no backup from the last 7 days. `data/` is git-ignored, so this is how
your data is kept safe.

## Re-run, insights and automation candidates

- **Re-run failed** (button in any run): starts a manual run with the failed and blocked cases, carrying over title, environment and
  sprint. For an automated run it uses the cases its failing tests are linked to.
- **Automated tests → Insights**: flaky tests (needed a retry, or keep flipping between pass and fail) with a per-run strip, test time per
  run, tests that are getting slower, and **Automate next**: manual cases without an automated test, ranked by priority, how often they
  are run by hand, how often they fail and whether they are smoke/regression cases. The top few also show on the dashboard.

## Automatic GitHub imports

On the Import page, switch on **Import new runs automatically** for a connected repository. TestBench checks every 5 minutes while it
is running (`TESTBENCH_POLL_MINUTES=2` changes it, `0` turns it off) and imports finished workflow runs that were created after you
switched it on. Optionally limit it to branches (`main, release/*`) and give the imported runs a sprint. Runs without test artifacts
are skipped and remembered, and a run is never imported twice. **Check now** does it immediately.

## Playwright evidence

Turn on evidence in `playwright.config.ts` and write a JSON report:

```ts
reporter: [["html"], ["json", { outputFile: "results.json" }]],
use: { trace: "retain-on-failure", screenshot: "only-on-failure", video: "retain-on-failure" },
```

Upload `results.json` **and** `test-results/` (in GitHub Actions: `path: |` both, see the guide on the Import page). Then import
the downloaded artifact `.zip`, pick the project folder with **Choose a test-results folder**, or click Import on a workflow run.
Expand a test in an automated run to see:

- the **attempts** (Attempt 1, Retry 1…), so a flaky test shows what failed first and that it passed on retry
- the error with Playwright's code frame, the location, and console output
- **screenshots and video** per attempt, and **Open trace**, which runs Playwright's trace viewer from this app (nothing is uploaded anywhere)
- the **history** of that test over its last 20 runs, and a **Report bug** draft for Jira (same flow as manual bugs)

Evidence files are matched to tests by their path, so any artifact layout works. If both `results.json` and a JUnit XML of the same
run are present, the JSON is used (it has the details) so tests aren't counted twice. Deleting a run deletes its evidence files.

## Report formats

| Framework  | Report                                                          |
|------------|-----------------------------------------------------------------|
| Playwright | `json` reporter (adds flaky detection) or `junit`               |
| TestCafe   | `testcafe-reporter-xunit`                                       |
| Selenium   | JUnit XML from pytest `--junitxml`, Maven Surefire, TestNG, ... |

## GitHub Actions

Upload the report folder with `actions/upload-artifact`, connect the repo under **Import results**,
and click **Import** on a workflow run. The token comes from `GITHUB_TOKEN` or a logged-in `gh` CLI
and is never stored.

## Dashboard, sprint reports and export

- **Dashboard**: automated pass-rate trend, automation coverage, failing and flaky tests, slowest tests.
- **Sprint reports**: give runs a sprint or release name (a dropdown suggests existing ones). Each name gets a report with a
  headline, pass rate, comparison with the previous sprint, results per suite and open failures. Download it as **PDF**
  (rendered with your installed Google Chrome; set `TESTBENCH_CHROME_CHANNEL=msedge` to use Edge) or as standalone HTML.
  Sprint dates are set on the Reports page and decide which sprint counts as "previous".
- **Export** (Reports page): full JSON backup, one Markdown file per case (zip), cases CSV, requirements CSV, results CSV.
- **Run templates** (Runs → Templates): a saved set of cases, like "Smoke test", with an optional default environment. Start a run
  from one in a click, or pick it in the New run dialog. Make one from ticked cases on Test cases ("Save as template"), or tick
  "Save this selection as a template" when starting a run. Templates follow your cases: deleted cases drop out, deprecated ones are skipped.
- **Bug reports for Jira**: on a failed or blocked result, **Report bug** opens an editable draft (summary, steps to reproduce with the
  failing step marked, expected/actual, environment, sprint, run). **Copy description** puts rich text on the clipboard for pasting
  into Jira's editor (plain text is the fallback). Attachments can't be pasted several at a time, so **Download .zip** gives you
  the screenshots to drag into the issue. Paste the issue key (or link) back to link it: it then shows on the result, in the run's
  case list, in the sprint report and in the exports.
- Manual runs freeze each case's title and steps when the run starts, so editing a case later doesn't rewrite old runs.

## Keyboard

`1`–`8` switch pages · `C` new case/run · `J`/`K` move · `X` select · `R` run selected ·
`P`/`F`/`B`/`S` pass/fail/block/skip while executing · `⌘V` paste a screenshot.
