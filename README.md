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

## Keyboard

`1`–`4` switch pages · `C` new case/run · `J`/`K` move · `X` select · `R` run selected ·
`P`/`F`/`B`/`S` pass/fail/block/skip while executing · `⌘V` paste a screenshot.
