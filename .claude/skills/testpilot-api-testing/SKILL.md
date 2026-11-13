---
name: testpilot-api-testing
description: Test a REST or GraphQL API in the TestPilot audit flow (discover → plan → run → report → deliver) from a target profile, with structured requests, response validation, auth flows, negative tests, contract checks against OpenAPI or GraphQL schemas, and deviations reported as observations. Use when the user invokes /testpilot-api-testing or asks to test, audit or validate an API.
---

# TestPilot: API testing

A thin skill: it defines the API variant of each audit phase and delegates
everything else (package, contract, approvals, delivery) to the existing
skills. The audit package it produces is the same as for a web UI, so
`report`, validation and `deliver` are unchanged.

Paths in this file are relative to this file.

Before starting, read:
- `../testpilot/SKILL.md`
- `../../references/audit-contract.md`
- `../../references/agent-rules.md`
- `references/api-test-heuristics.md`

Then, per phase, the corresponding skill: `../testpilot-discover/SKILL.md`,
`../testpilot-plan/SKILL.md`, `../testpilot-run/SKILL.md`,
`../testpilot-report/SKILL.md`, `../testpilot-deliver/SKILL.md`. Everything
they say applies; this file only says what is different for an API.

## Tooling

`testpilot/tools/apitest/` (stdlib Python, no dependencies):

| Module | Does |
|---|---|
| `request.py` | Builds a request from a plan item: method, URL, query, headers, auth, body as JSON, form, multipart or GraphQL. Resolves `${env:NAME}` and `${capture:name}`. |
| `validate.py` | Checks status, headers and body fields (type, format `uuid`/`email`/`date-time`, pattern, enum, ranges), plus a JSON-schema subset; uses `jsonschema` automatically when installed. |
| `contract.py` | Loads an OpenAPI 3 document (JSON) or a GraphQL schema (introspection JSON or SDL) and lists deviations between the spec and what was sent and received. |
| `redact.py` | Masks secrets in headers, bodies, URLs and text before anything is written. |
| `runner.py` | Runs `audits/<audit-id>/api-plan.json` against the target profile and writes executions, actions, evidence and observations into the package. |

Run: `python3 testpilot/tools/apitest/runner.py <audit-id> --config-dir .testpilot --audits-dir audits [--dry-run] [--items TPI-001,TPI-002]`
Tests: `python3 -m unittest discover -s testpilot/tests` (the tests use an in-process mock
server on 127.0.0.1 and never reach the network).

## Target profile

An API target is described in `.testpilot/targets/<name>.json`
(template: `templates/target-profile.json`). It holds a **non-production**
base URL, the environment, the auth method with the **names** of the
environment variables that hold credentials, an optional schema location, and
limits. It never holds a token, password, cookie or any other secret value;
`runner.py` refuses a profile that does. The TestBench project profile keeps
no target URL at all.

`permissionMode` in the target profile may only be stricter than the project
profile's: the effective mode is `observe_only` unless both say `full`.

`production: true` is allowed only after the two separate confirmations that
`discover` requires; the runner refuses a production profile unless
`api-plan.json` records both (`productionConfirmations: 2`).

## 1. Discover (API)

Follow `../testpilot-discover/SKILL.md` with these differences:

- The environment is the target profile. Ask which profile to use or, with
  the user's values, create one from the template. Never write a secret into
  it; ask for environment variable names.
- Read-only probing only: `GET` the base URL, `OPTIONS` on the base path, and
  the schema document if the profile names one. Do not call endpoints that
  look state-changing, whatever their method.
- From the schema (or, without one, from the user's description) list the
  endpoints or operations, their methods, auth requirements and which ones
  change state. GraphQL: queries read, mutations change state.
- The proposed scope lists endpoints in and out, the auth flows to test, and,
  under `full` only, each state-changing operation with its limit and the
  cleanup for it. Under `observe_only` the scope allows GET, HEAD, OPTIONS,
  read-only GraphQL queries and the login call only.
- Record the discovery context with the profile name and the schema used.

## 2. Plan (API)

Follow `../testpilot-plan/SKILL.md`. Each plan item keeps the contract's
fields (5.9) and adds a structured `request` and `expect`, written to
`audits/<audit-id>/api-plan.json` for the runner and summarised in the plan item's
`steps`. Format: `templates/api-plan-item.md`.

Plan from `references/api-test-heuristics.md`: the happy path per endpoint,
the auth flows, negative cases (bad auth, bad input, missing resource,
conflict, validation, rate limit), idempotency and contract checks. Each item
has exactly one requirement; a check with no requirement becomes a coverage
gap, not an item.

State-changing items are allowed only under `full`, each with an action name
and limit in the scope; the plan includes their cleanup items. Idempotency
checks (the same request twice) count as two attempts.

The rate-limit check is a bounded observation: at most the profile's
`limits.rateLimitProbeMax` requests, stop at the first 429, never retry it,
and record `Retry-After`. It needs the user's explicit approval in the scope.

## 3. Run (API)

Follow `../testpilot-run/SKILL.md`; the runner replaces Playwright.

- Whether an item changes state is derived from its request, not from the
  plan's `state_changing` flag: every method except GET, HEAD and OPTIONS
  does, and a GraphQL body does unless it is a plain query (mutations,
  subscriptions and text that cannot be parsed count as writes). The flag can
  only add to this, never remove it. The login call that obtains a token is
  the one explicit exemption.
- `runner.py` refuses to start when: the effective permission mode is
  `observe_only` and any item is state-changing; a state-changing item has no
  matching allowed action in the scope, or its limit would be exceeded; the
  profile holds a literal secret; the profile is production without two
  recorded confirmations. It then prints the reason and changes nothing.
- Per call: timeout from the profile, at most 30 s; at most 3 attempts, only
  on a connection failure or timeout; never a retry after a 401, 403 or 429.
  A state-changing request is retried only when it failed before anything was
  sent (connection refused, name not resolved). After a timeout or reset it may
  already have been performed, so it is not retried: the execution is
  `inconclusive` (`insufficient-evidence`), no action is recorded, and the
  summary says to check the target.
- Each item becomes one execution with `mode: saved-test` (the plan file is
  the saved test), `viewport: null`, and one `network-trace` evidence file
  with the redacted request and response. Statuses follow contract 2.1: a
  deviation from `expect` is `fail` with the violated expectation in the
  summary; a connection failure after the attempts is `blocked`
  (`environment`); a runner fault is `inconclusive` (`tooling`).
- Every state-changing call that received a 2xx is recorded in
  `manifest.actions[]`; a rejected one is not, but counts against the limit.
- Contract deviations (spec mismatches that no `expect` covers) do not fail
  the item; they are written to `audits/<audit-id>/api-observations.json` (see 4).
- After the run, say which tools were used. If the runner cannot run, say so;
  do not fall back to unrecorded manual calls.

## 4. Report (API)

Follow `../testpilot-report/SKILL.md`. In addition:

- A `fail` with a requirement becomes a bug proposal as usual, with the
  evidence file of the execution.
- Deviations without a requirement (contract mismatches, undocumented
  statuses, missing headers, slow responses) are **observations**, not bugs.
  Until TestBench has the `api_test` observation kind, list them in
  `report.md` under "Coverage gaps and not verified" as "API observations
  (not imported)", keep them in `api-observations.json`, and record one
  `testbench_backlog` item (kind `other`): "Observation kind `api_test`".
  Import them with the Observations endpoint once the kind exists.
- Never turn an observation into a bug yourself.

## 5. Deliver (API)

`../testpilot-deliver/SKILL.md`, unchanged. `api-plan.json` and
`api-observations.json` stay in the package; the transform ignores files it
does not know.

## Boundaries specific to APIs

- Requests go only to the profile's base URL. The runner rejects any other
  host.
- No request bodies, headers or URLs with secrets are ever written unredacted;
  `redact.py` runs on everything before it is stored, and evidence objects
  have `redacted: true`. Masking works by key name, by token pattern, and by
  value: every environment variable the profile or plan refers to, and every
  token the login returns, is masked wherever it appears, including in URL
  paths and queries, deviation texts, summaries and observations.
- No load, fuzzing, injection or enumeration: one request per planned check,
  within the limits above. Those belong to `testpilot-loadtest` and
  `testpilot-security-review`, with their own approvals.
