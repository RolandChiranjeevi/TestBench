---
name: testpilot-loadtest
description: Run a controlled, bounded load test against a target app. Use when the user asks to load test, stress test lightly, or measure performance under load. This skill is separate from the main TestPilot audit flow.
---

# TestPilot Load Test

Run a small, controlled load test against a target app to measure
response time, error rate and obvious degradation.

## When to use

Use this skill when the user asks to:
- Load test an app
- Stress test lightly
- Measure performance under load

Do not use this skill for:
- Full performance benchmarks
- Production or shared infrastructure
- Aggressive load (100+ VU, long duration)
- Destructive actions

## Prerequisites

Before starting, read `../../references/agent-rules.md` and apply it: in
particular the limits (3 attempts, 30 s per request), tool fallback, and
observe-only (a load test sends read requests only unless the profile's
`permissionMode` is `full` and the user approves each write path).

Before running, confirm:

- Target URL and environment (local only unless user explicitly approves otherwise)
- Active project profile (if applicable)
- Load test parameters (VU count, duration, ramp-up)

## Scope

Default scope:

- 10-50 virtual users
- 1-2 minutes duration
- Local environment only
- Measure response time, error rate, obvious degradation

## Approval gate

Before running, propose:

- Target URL and environment
- VU count, duration, ramp-up
- What will be measured
- Stop conditions

Ask for explicit approval before running.

## Stop conditions

Pause and ask if:

- Error rate rises sharply
- Environment becomes unstable
- Any unexpected 5xx
- Any change outside test scope

## Output

Produce:

- A load test report (response time, error rate, degradation)
- Evidence (logs, screenshots if relevant)
- A recommendation (pass / warning / fail)

## Integration with TestPilot

This skill is separate from the main audit flow. It can be run:
- Standalone
- As a supplement to an existing audit

If run as a supplement, reference the audit ID in the report.