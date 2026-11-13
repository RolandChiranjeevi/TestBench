---
name: testpilot-discover
description: Select or create a target environment, inspect a target application and propose a TestPilot audit scope. Use when the user invokes /testpilot-discover or asks to discover a target for a TestPilot audit.
---

# TestPilot: discover

Discover a target and propose a test scope.

Input:
- optional target URL
- optional context: feature, user goal, release, known risks

Paths in this file are relative to this file. The contract is
`../../references/audit-contract.md`.

Before starting, read:
- `../testpilot/SKILL.md`
- `../../references/audit-contract.md`
- `../../references/agent-rules.md`

Apply the shared boundaries, secret-handling rules and stop conditions.
Execute only this discovery workflow. Do not start the full audit.

## Responsibilities

This workflow:
- Selects or creates a target environment
- Resolves the target URL
- Inspects the application
- Proposes an initial audit scope

It does not:
- Create a TestBench project
- Create a test plan
- Execute tests
- Create bugs or manual tests
- Deliver an audit package

## 1. Read the TestBench context

Read:

1. `.testpilot/testbench.json`
2. The project profile referenced by `activeProject`

Use from the global configuration:

- `baseUrl`

Use from the project profile:

- `projectId`
- `projectKey`
- `name`
- `requirementsSource`
- `requirementsPath`
- `tokenEnvVar`

Rules:

- Do not read project-specific values from the global configuration.
- Do not store token values, passwords, cookies or target URLs in the TestBench
  project profile. An API target profile (`.testpilot/targets/<name>.json`) may hold
  a non-production base URL, never a secret.
- If the active profile is missing, invalid or unreadable, pause and ask the user.

## 2. Select or create an environment

Present these choices:

1. Use an existing environment
2. Create a new environment
3. Cancel

If environments are supported by the current integration, list them.
Otherwise, explain that environment management is not yet implemented and
ask for the target URL directly.

Do not invent environments, URLs, credentials or variables.

### Use an existing environment

If an environment is selected:
- Read its target URL
- Confirm it with the user
- Use it for this discovery session

### Create a new environment

If the user chooses to create a new environment, ask for:
- Environment name
- Target URL
- Description, optional
- Authentication method
- Credentials source, if applicable

Do not ask for secrets in chat.
Refer to environment variables or a secure secret store.

Confirm before creating anything.

If environment creation is not supported, say so clearly and do not claim success.

### Permission mode

Read `permissionMode` from the project profile. A missing field means
`observe_only`.

- `observe_only` (default): the audit may only read the target. The scope you
  propose in step 5 must say `state_changes.allowed: false` with no allowed
  actions, and checks that would need a state change are listed as coverage
  gaps instead.
- `full`: state-changing checks may be proposed, each with an explicit limit.

Tell the user which mode applies before inspecting the target. If the user
wants state-changing checks but the profile says `observe_only`, do not change
the profile here: explain that `full` needs their explicit confirmation and is
set by `/testpilot-init` (or by editing the profile), and continue in
`observe_only` until then. Never infer `full` from the request itself.

## 3. Validate the target URL

Validate the target URL before fetching anything.

Rules:
- Must be a valid HTTP or HTTPS URL
- Must not contain credentials in the URL
- Must not be a production URL unless confirmed twice, in two separate
  messages from the user: first that the target is production, then that the
  audit may run against it in the profile's permission mode. Record both
  confirmations in the discovery context. One confirmation is not enough.
- Must be reachable before inspection

If the URL is missing, ask for it.

If the URL is invalid, explain why and ask again.

## 4. Inspect the target

Fetch the page and identify:
- page purpose
- primary user flows
- visible interactive elements
- forms, navigation, authentication hints
- obvious risks

Do not modify anything.
Do not submit forms.
Do not create accounts.
Do not perform state-changing actions.

## 5. Propose a scope

Propose a scope with:
- in-scope flows
- out-of-scope areas
- proposed checks
- required credentials or test data

Do not run tests or modify anything before explicit approval.

## 6. Stop and ask for approval

Show the proposed scope and wait for the user's explicit approval in a new
message. Anything else means no.

If the user asks for changes, update the scope and show it again.

Do not proceed to `plan` automatically.