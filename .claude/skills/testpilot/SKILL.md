---
name: testpilot
description: The boundaries and stop conditions that every TestPilot request skill reads (the agent proposes, people decide). Not a command: work from TestBench starts with /testpilot-requests.
---

# Skill: TestPilot (boundaries)

The skills that work on requests from TestBench (`../testpilot-requests/SKILL.md`, `../testpilot-request-discover/SKILL.md` (both modes), `../testpilot-request-loadtest/SKILL.md`) read this file for the boundaries and the stop conditions below. It starts nothing itself.

Paths in this file are relative to this `SKILL.md`.

## Boundaries

The agent proposes. People decide.

The agent never, on its own:

- closes bugs or changes the status of anything except to create it as `proposed`
- approves, accepts or rejects its own proposals
- creates Linear, Jira, GitHub Issues or other external tickets
- changes production data
- merges pull requests
- exposes, logs, stores or includes secrets in prompts, reports, evidence or findings

New bug and manual-test proposals always have status `proposed`. Their wording never claims a human-review outcome.

Needs for new TestBench fields or endpoints are recorded as separate `TestBench backlog` items. Do not work around them or invent an interface.

Ask for confirmation before posting anything externally.

The only permitted external write path is `/testpilot-requests`: take a request that the user chose, hand in what it found (as proposals, a test result or a load test result) and mark it done, with a request token (`tbrq_`) that opens those routes of one project and nothing else.

## Working rules

`../../references/agent-rules.md` defines how the agent reasons and acts in every skill: claims grounded in checks made in the session, no fix without a root cause, the agent never approves, observe-only by default, no secrets in clear text, concrete limits (3 attempts, 100 objects, 30 s per external call), duplicate protection, no swallowed errors, and tool fallback. Every skill reads it before starting.

When rules conflict, this order decides:

1. Security (agent-approval rule, observe-only, secrets)
2. The user's explicit request
3. Scope: nothing beyond what was asked
4. Review: change nothing while reviewing
5. Debugging: root cause before any fix

## Stop conditions

Pause and ask the user when there is:

- missing login, environment access or test data
- a URL, build or environment that differs from the confirmed scope
- a state-changing action that the scope does not explicitly allow
- a risk of affecting other users, shared data, billing, permissions or irreversible workflows
- the same blocking problem stopping several planned checks
- not enough evidence to tell a product defect from an environment, selector, fixture or test-data fault
- a TestBench authentication or project-access failure

When pausing, say what stopped, which checks it affects and what decision is needed. Do not classify unresolved environment, access, authentication or authorisation problems as product defects.
