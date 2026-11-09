# TestPilot → TestBench

How a TestPilot audit reaches TestBench, and what to know before you run it.

## 1. Overview

```text
init → discover → plan → run → report → validate → transform → deliver
```

| Stage | Where it lives | What it does |
|---|---|---|
| init | `.claude/skills/testpilot-init/SKILL.md` | Select or create a TestBench project, determine requirements source, save project profile. Stops for confirmation. |
| discover | `.claude/skills/testpilot-discover/SKILL.md` | Select or create a target environment, inspect a target and propose a scope. Stops for approval. |
| plan | `.claude/skills/testpilot-plan/SKILL.md` | Inputs, requirements, scope, test plan and coverage gaps. Two approvals: scope first, then the test plan. |
| run | `.claude/skills/testpilot-run/SKILL.md` | Playwright checks, visual design review and evidence. Needs the approved scope and test plan first. |
| report | `.claude/skills/testpilot-report/SKILL.md` | Analysis, bug and manual-test proposals, and the audit package. Needs a finished run first. |
| validate | audit flow, step 9 in `testpilot/SKILL.md` | Contract validation. `deliver` needs `validation.result == "pass"`. |
| transform | `tools/build_testbench_package.py` | Turns the audit package into a TestBench import zip. |
| deliver | `.claude/skills/testpilot-deliver/SKILL.md` | Builds the zip, dry-run, asks you, then imports. |

`init`, `discover`, `plan`, `run`, `report` and `deliver` are separate skills.
The rest (validate) runs as a step of the audit flow in
`.claude/skills/testpilot/SKILL.md`. The audit contract is
`.claude/references/audit-contract.md`.

Everything TestPilot sends is `proposed`. Humans review in TestBench.

## 2. Configuration layout

TestPilot supports multiple TestBench projects.

### Global configuration

`config/testbench.json`:

```json
{
  "baseUrl": "http://localhost:4100",
  "activeProject": "ts"
}
```

| Field | Use |
|---|---|
| `baseUrl` | TestBench address, for example `http://localhost:4100` |
| `activeProject` | Lowercase project key of the active project, for example `ts` |

### Project profiles

`config/projects/<lowercase_project_key>.json`

Example for project key `TS`:

`config/projects/ts.json`

```json
{
  "projectId": "5",
  "projectKey": "TS",
  "name": "Testpilot",
  "requirementsSource": "black_box",
  "requirementsPath": "/api/agent/projects/5/requirements",
  "tokenEnvVar": "TESTBENCH_API_TOKEN_TS",
  "deliveryEnabled": false
}
```

| Field | Use |
|---|---|
| `projectId` | Numeric project ID, used in the URL |
| `projectKey` | Project key, for example `TS` |
| `name` | Human-readable project name |
| `requirementsSource` | One of `testbench`, `black_box`, `pending`, `import_pending` |
| `requirementsPath` | API path for requirements, built from project ID |
| `tokenEnvVar` | Name of the env variable with the agent token (reading requirements only) |
| `deliveryEnabled` | Must be `true` for `deliver` to run |

Rules:

- `activeProject` in the global config must match an existing profile file.
- Project-specific fields live only in the profile, not in the global config.
- `deliveryEnabled` in the profile is authoritative.
- Do not store token values, passwords, cookies or target URLs in configuration.

## 3. Environment variables

`.env` (never committed):

```text
TESTBENCH_PASSWORD=<TestBench login password>     # required for deliver
TESTBENCH_API_TOKEN_RS=<agent token for RS>       # optional, agent reads only
TESTBENCH_API_TOKEN_TS=<agent token for TS>       # optional, agent reads only
TESTBENCH_API_TOKEN_SHOP=<agent token for SHOP>   # optional, agent reads only
```

Rules:

- One token per project, named after the project key.
- The token value is never stored in configuration files.
- `tokenEnvVar` in the profile points to the variable name.
- `.gitignore` covers `.env`, `*-testbench.zip`, `__pycache__/` and `.DS_Store`.

`deliver` never `source`s `.env`. A password with characters such as `&` would be
parsed by the shell. Python reads the raw line instead.

## 4. Auth model

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

## 5. Evidence

- TestBench stores evidence that a **bug** links to. In the first import, 40 files
  were in the zip but the server counted 10 as evidence, matching the bugs' links.
- Other evidence files in the manifest are not stored. That is by design, not an error.
- The server reports `evidence.ok` and `evidence.problems`. `problems > 0` cancels `deliver`.

## 6. Dedup rule

- `sourceId` is the bug's own ID (`BP-nnn`), never the requirement ID.
- Two bugs must not share a `sourceId`. TestBench rejects the whole package with
  HTTP 400 (`sourceId "X" appears twice`).
- The same package again gives `unchanged`. A new bug ID gives a new bug.
- Changing a `sourceId` creates a new bug. The old one stays in TestBench.
  Clean up by hand.

## 7. Idempotency and safety

- Importing the same file again creates no new bugs or tests. The import is still
  recorded as an event in TestBench.
- `dryRun=1` is supported and writes nothing. It returns the same summary with
  `dryRun: true`.
- Never show the password, cookie or token in output, logs, reports or the manifest.
- Never deliver unless `manifest.validation.result == "pass"`.
- Never import without your explicit "yes" in a separate message after the dry-run.
- Never commit without your confirmation.
- `manifest.delivery` stores counts only, not the raw response.

## 8. Quick start

```text
/testpilot-init
/testpilot-discover <target-url>
/testpilot-plan
/testpilot-run
/testpilot-report
/testpilot-deliver <audit-id>
```

`init`:

1. Read `config/testbench.json`.
2. List or create a TestBench project.
3. Determine requirements source.
4. Confirm before creating anything.
5. Save project profile and update `activeProject`.

`deliver <audit-id>`:

1. Read `config/testbench.json` and the active project profile.
2. Stop if `deliveryEnabled` is not `true` in the profile.
3. Check `<audit-id>/manifest.json`. Stop unless `validation.result` is `pass`.
4. Build the zip: `python3 tools/build_testbench_package.py <audit-id> <projectKey>`.
   Output: `<audit-id>-testbench.zip`.
5. Log in, upload with `?dryRun=1`.
6. Show counts (new/unchanged/updated/pending), evidence ok/problems, unresolved
   references, warnings, and each item. Stop on any HTTP error or `evidence.problems > 0`.
7. Ask you for confirmation. Nothing is imported before you say yes.
8. Upload for real, then write `manifest.delivery`
   (`status`, `delivered_at`, `method`, `target`, `request_reference`,
   `response_reference`, `error`, `response_summary`).
9. Report the result and the TestBench `auditId`.

Fields mapped by the transform for each bug: `bug_proposal_id` → `sourceId`,
`severity.level` → `agentSeverity` (lower case), `steps_to_reproduce` → `steps`,
`expected_result` → `expected`, `actual_result` → `actual`. `confidence` is not sent.

## 9. Known limitations and TODO

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
- `passwordEnvVar` in the profile is optional and read by `deliver`. The default is
  `TESTBENCH_PASSWORD` and the profile has no such field today.
- The transform stages files in a fixed `/tmp/tb-package` and overwrites it each run.
- The TestBench version must have the `audit-import` route. It was checked against
  the TestBench Docker image running on `localhost:4100`.
- **Project profiles are not yet implemented in code.** Only the skills describe
  them. `init` must verify support before writing profiles.