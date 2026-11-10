---
name: testpilot-security-review
description: Perform a limited, non-destructive security review of an explicitly authorized web application. Use for basic input-validation, header, cookie, error-handling and access-control observations. This is not a full penetration test.
---

# TestPilot Security Review

Perform a limited, non-destructive security review of a web application.
Find obvious security weaknesses and document them with evidence, impact and
recommendations.

This is **not** a full penetration test.

## When to use

Use this skill when the user asks to:

- Review basic web security
- Check input validation and output handling
- Review security headers, cookies or error messages
- Check basic access-control behaviour
- Perform a limited, non-destructive security assessment

Do not use this skill for:

- Full penetration testing
- Exploitation or exploit-chain development
- Credential attacks
- Denial-of-service testing
- Testing production or third-party systems without explicit authorization
- Testing systems the user is not authorized to test

## Required approvals

Before starting, read `../../references/agent-rules.md` and apply it: secrets
found in clear text are masked in all output and reported as a separate
finding; checks on access control, limits, duplicate protection, error handling
and empty states use the severities given there.

Before any active security check, collect and confirm:

- Target URL
- Environment: local, staging, or another explicitly approved environment
- Authorization: confirm the user owns or is authorized to test the target
- Test accounts and test data, if access-control checks are approved
- Exact checks allowed
- Request and time limits
- Stop conditions

Do not perform an active security check before the user explicitly approves
the proposed scope.

## Default scope

Start with passive review. Only perform active checks that the user has
explicitly approved.

### Passive review

Without changing data, inspect:

- Pages, forms, links and client-side routes
- API requests initiated by the UI
- HTTP response headers
- Cookies and their attributes
- Error messages
- Visible technologies and client-side assets
- Login, logout and session-related UI, if present

### Approved active checks

Only perform checks explicitly approved by the user, such as:

- Input validation using harmless, unique markers
- Output escaping and reflected-input behaviour
- Error handling and information disclosure
- Security-header review
- Cookie attribute review
- Basic access-control comparison using approved test accounts
- Limited rate-limit observation, if explicitly approved

## Forbidden actions

- Exploit a vulnerability or attempt to gain unauthorized access
- Use destructive payloads, malware, reverse shells or persistence mechanisms
- Perform SQL injection, command injection, SSRF, RCE or deserialization attacks
- Perform credential stuffing, brute force, password spraying or enumeration
- Perform denial-of-service or resource-exhaustion testing
- Scan third-party domains, subdomains, networks or infrastructure
- Access, modify or delete data belonging to real users
- Exfiltrate, download or retain sensitive data
- Continue after reaching a scope boundary or stop condition

## Stop conditions

Pause immediately and ask the user before continuing if:

- The target is production, shared infrastructure, or an unapproved environment
- A test could modify, delete or expose data outside approved test data
- Sensitive information is exposed
- The application becomes unstable
- A 5xx response appears repeatedly
- A rate limit, lockout or security control is triggered
- The user asks to stop

## Workflow

1. Ask for target URL, environment and authorization.
2. Confirm ownership or explicit permission to test.
3. Perform passive review only.
4. Propose a limited active-check scope, limits and stop conditions.
5. Ask for approval before active testing.
6. Run only approved checks.
7. Stop on any stop condition.
8. Classify each result as confirmed, needs review, or not tested.
9. Produce a report with findings, evidence and recommendations.

## Finding classification

Use these statuses:

| Status | Meaning |
|---|---|
| `confirmed` | Reproducible observation with evidence |
| `needs_review` | Suspicious behaviour that requires manual verification |
| `not_tested` | Check was not approved, not possible, or out of scope |

Use these severity levels:

| Severity | Use when |
|---|---|
| `info` | Observation with no clear security impact |
| `low` | Minor hardening or hygiene issue |
| `medium` | Meaningful weakness with limited impact |
| `high` | Significant weakness with material impact |
| `critical` | Direct compromise, data exposure, or high-impact issue |

Do not assign a severity without evidence and impact reasoning.

## Report format

Create a report containing:

- Target and environment
- Authorization and approval timestamp
- Scope and exclusions
- Methodology
- Findings summary
- Detailed findings
- Evidence references
- Limitations
- Recommendations
- Tests not performed

Each finding should include:

- `finding_id`
- `title`
- `severity`
- `status`
- `category`
- `description`
- `evidence`
- `reproduction`
- `impact`
- `recommendation`
- `scope_boundary`

## Evidence rules

- Save evidence in the security-review folder.
- Never include passwords, tokens, cookies, secrets, personal data or full
  sensitive request/response bodies.
- Mask credentials, personal data and sensitive values in evidence.
- Record request and response summaries, not raw sensitive payloads.
- Record the exact approved scope and limits.

## Integration with TestPilot

This skill is separate from the main TestPilot audit flow.

It can be run:

- Standalone
- As a supplement to an existing audit

If run as a supplement, reference the audit ID in the report and do not
modify the original audit scope without explicit approval.