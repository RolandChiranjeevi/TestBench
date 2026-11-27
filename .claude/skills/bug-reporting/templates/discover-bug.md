# Bug report from a discover

Used by `testpilot-request-discover` and `testpilot-request-discover-write` for every `bug_report` finding. A developer must be able to see what the bug is, and do it again, from this text
alone. Write in English. Never a password, a token, a cookie or a real person's data.

## The fields TestBench keeps

| Field | What goes in it |
|---|---|
| `title` | `[Area]: [what is wrong] when [condition]`, at most 200 characters. Example: `Cart: the total becomes 0 when an item is removed` |
| `steps` | The steps that make it happen, one string each, from a page anyone can reach. Never "log in as alice / s3cret": write "log in with a test account" |
| `expected` | What should happen, **and why**: the requirement, the page's own text, a standard, or the oracle that tells you (`../../../references/testheuristics.md`, Oracles) |
| `actual` | What happened instead, as you saw it |
| `url` | The page where it shows |
| `environment` | The environment of the request |
| `severity` | `critical`, `high`, `medium` or `low` |
| `description` | The text below, with these headings in this order |

## The `description`

```
Summary: <one or two sentences: what the bug is>
Requirement: <the requirement it breaks, or "none known">
Where: <browser>, <size: desktop 1440x900 / tablet 820x1180 / mobile 390x844>
Preconditions: <logged in or not, which role, which data>
Reproduced: <yes, N of N attempts>
Evidence: <what you saw: the snapshot, the console error, the failed request (method, path, status)>
Severity reason: <one sentence: why this severity>
Not checked: <what you did not verify, for example server-side validation or other browsers>
Related: <the test case it belongs to, or similar findings, or "none">

--- Agent note (for triage, not for the developer)
Confidence: <high / medium / low>, <why>
Found by: TestPilot, request <number>
```

## Rules

- **Reproduced** is required. A failure that did not happen again is an observation, not a bug (`../../../references/agent-rules.md`, rule 13).
- **Not checked** is required, also when it is short (rule 12).
- **Requirement:** the agent cannot read the project's requirements, so write `none known` unless the request or the page names one.
- **Severity:** `critical` blocks a main flow or loses data; `high` breaks a flow with no way round; `medium` breaks something with a way round; `low` is a small fault.
- **Confidence** is for the person who sorts the findings: `high` when you saw it each time and the page, the console or a request shows it; `medium` when you saw it but the cause is unclear; `low`
  when it may be the test environment. A `low` that you cannot make clearer is better as an observation.
