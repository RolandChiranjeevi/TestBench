# TestPilot → TestBench

How a TestPilot audit reaches TestBench, and what to know before you run it.

## 1. Overview

```text
discover → plan → run → report → validate → transform → deliver
```

| Stage | Where it lives | What it does |
|---|---|---|
| discover | `commands/discover.md` | Inspect a target and propose a scope. Stops for approval. |
| plan | `commands/plan.md` | Inputs, requirements, scope, test plan and coverage gaps. Two approvals: scope first, then the test plan. |
| run | `commands/run.md` | Playwright checks, visual design review and evidence. Needs the approved scope and test plan first. |
| report, validate | audit flow, steps 5–9 in `SKILL.md` | Analysis, bug and manual-test proposals, package, contract validation. |
| transform | `tools/build_testbench_package.py` | Turns the audit package into a TestBench import zip. |
| deliver | `commands/deliver.md` | Builds the zip, dry-run, asks you, then imports. |

`discover`, `plan`, `run` and `deliver` are separate command files today. The rest
(report, validate) run as steps of the audit flow in
`.claude/skills/testpilot/SKILL.md`. The audit contract is
`.claude/skills/references/audit-contract.md`.

Everything TestPilot sends is `proposed`. Humans review in TestBench.

## 2. Prerequisites

`config/testbench.json`:

| Field | Use |
|---|---|
| `baseUrl` | TestBench address, for example `http://localhost:4100` |
| `projectId` | Numeric project ID, used in the URL |
| `projectKey` | Passed to the transform, for example `RS` |
| `tokenEnvVar` | Name of the env variable with the agent token (reading requirements only) |
| `deliveryEnabled` | Must be `true`, otherwise `deliver` stops |

`.env` (never committed):

```text
TESTBENCH_PASSWORD=<TestBench login password>     # required for deliver
TESTBENCH_API_TOKEN=<agent token, tbag_...>       # optional, agent reads only
```

`.gitignore` covers `.env`, `*-testbench.zip`, `__pycache__/` and `.DS_Store`.

`deliver` never `source`s `.env`. A password with characters such as `&` would be
parsed by the shell. Python reads the raw line instead.

## 3. Auth model

This is what blocked the first delivery attempt.

- Write requests need a **session cookie**, not a Bearer token.
- Log in: `POST {baseUrl}/api/login` with `{"password": "..."}`. The response sets
  the `tb_session` cookie.
- Every POST must send the header `X-Testbench: 1`, otherwise the server answers 403.
- A Bearer agent token (`tbag_...`) is **not enough** for audit import. It only works
  for agent reads (`GET /api/agent/projects/:id/requirements`) and CI ingest.
- Wrong password gives 401. Repeated wrong passwords give 429. `deliver` does not retry.
- `deliver` refuses plain `http` unless the host is `localhost`, `127.0.0.1` or `[::1]`.

The endpoint is `POST {baseUrl}/api/projects/{projectId}/audit-import`. Add
`?dryRun=1` for a dry-run.

## 4. Evidence

- TestBench stores evidence that a **bug** links to. In the first import, 40 files
  were in the zip but the server counted 10 as evidence, matching the bugs' links.
- Other evidence files in the manifest are not stored. That is by design, not an error.
- The server reports `evidence.ok` and `evidence.problems`. `problems > 0` cancels `deliver`.

## 5. Dedup rule

- `sourceId` is the bug's own ID (`BP-nnn`), never the requirement ID.
- Two bugs must not share a `sourceId`. TestBench rejects the whole package with
  HTTP 400 (`sourceId "X" appears twice`).
- The same package again gives `unchanged`. A new bug ID gives a new bug.
- Changing a `sourceId` creates a new bug. The old one stays in TestBench.
  Clean up by hand.

## 6. Idempotency and safety

- Importing the same file again creates no new bugs or tests. The import is still
  recorded as an event in TestBench.
- `dryRun=1` is supported and writes nothing. It returns the same summary with
  `dryRun: true`.
- Never show the password, cookie or token in output, logs, reports or the manifest.
- Never deliver unless `manifest.validation.result == "pass"`.
- Never import without your explicit "yes" in a separate message after the dry-run.
- Never commit without your confirmation.
- `manifest.delivery` stores counts only, not the raw response.

## 7. Quick start

```text
/testpilot discover <target-url>
/testpilot deliver <audit-id>
```

`deliver <audit-id>`:

1. Read `config/testbench.json`. Stop if `deliveryEnabled` is not `true`.
2. Check `<audit-id>/manifest.json`. Stop unless `validation.result` is `pass`.
3. Build the zip: `python3 tools/build_testbench_package.py <audit-id> <projectKey>`.
   Output: `<audit-id>-testbench.zip`.
4. Log in, upload with `?dryRun=1`.
5. Show counts (new/unchanged/updated/pending), evidence ok/problems, unresolved
   references, warnings, and each item. Stop on any HTTP error or `evidence.problems > 0`.
6. Ask you for confirmation. Nothing is imported before you say yes.
7. Upload for real, then write `manifest.delivery`
   (`status`, `delivered_at`, `method`, `target`, `request_reference`,
   `response_reference`, `error`, `response_summary`).
8. Report the result and the TestBench `auditId`.

Fields mapped by the transform for each bug: `bug_proposal_id` → `sourceId`,
`severity.level` → `agentSeverity` (lower case), `steps_to_reproduce` → `steps`,
`expected_result` → `expected`, `actual_result` → `actual`. `confidence` is not sent.

## 8. Known limitations and TODO

- **BP-001 evidence:** it lists 4 evidence IDs (EV-013, EV-014, EV-039, EV-040) but
  3 files are attached. Which one is missing is not determined. It is recorded in
  `manifest.limitations[]` of `AUD-20261105-01`, not in `report.md`.
- **`deliveryPath`** is not used. The endpoint is `audit-import`. `SKILL.md` section
  "TestBench context" still lists it as a config field and should be corrected.
- **Old bugs with `sourceId` = requirement ID** (for example `REQ-LOCAL-004`,
  `REQ-LOCAL-006`) from earlier imports can remain in older audits.
- **Password login must be enabled** in TestBench. When TestBench has no
  `TESTBENCH_PASSWORD`, the login route is not registered (from the server code), and
  `deliver` would fail at login. That case is not handled.
- `passwordEnvVar` in the config is optional and read by `deliver`. The default is
  `TESTBENCH_PASSWORD` and the config has no such field today.
- The transform stages files in a fixed `/tmp/tb-package` and overwrites it each run.
- The TestBench version must have the `audit-import` route. It was checked against
  the TestBench Docker image running on `localhost:4100`.
