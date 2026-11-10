# Security Review Heuristics

## Objective

Identify obvious, low-risk security weaknesses through a limited,
non-destructive review. Prioritize clarity, evidence and safe reproduction
over exploitation.

## Review order

1. Confirm authorization and scope.
2. Map the application passively.
3. Review headers, cookies and error handling.
4. Test approved input-validation behaviour.
5. Test approved access-control behaviour, if applicable.
6. Report findings and limitations.

## Passive review

Inspect, without changing data:

- HTML, JavaScript and visible client-side routes
- Forms, inputs, links and buttons
- Network requests initiated by the UI
- Response headers
- Cookies and their attributes
- Error messages
- Login, logout and session-related UI
- Publicly visible version or technology information

Do not scan third-party domains or infrastructure.

## Input validation

Use harmless, unique markers such as:

```text
TPSEC-<random-token>
```

Test only approved fields and parameters. Observe whether the marker is:

- Rendered as text
- Interpreted as HTML
- Interpreted as JavaScript
- Reflected in an error message
- Stored and displayed later
- Rejected or sanitized

Do not use exploit payloads, polyglots, encoded attack chains or destructive
input.

## Error handling

Trigger ordinary validation errors, such as:

- Empty required field
- Invalid format
- Out-of-range value
- Unknown identifier
- Missing required parameter

Look for:

- Stack traces
- Internal file paths
- Database errors
- Framework or library versions
- API keys, tokens or secrets
- Personal data
- Internal hostnames or infrastructure details

Do not force server failures or send malformed payloads beyond the approved
scope.

## Security headers

Review response headers for:

| Header | Why it matters |
|---|---|
| `Content-Security-Policy` | Reduces impact of injected content |
| `X-Content-Type-Options` | Reduces MIME-type confusion |
| `Referrer-Policy` | Limits referrer leakage |
| `Strict-Transport-Security` | Encourages HTTPS-only connections |
| `Permissions-Policy` | Restricts powerful browser features |
| `Cache-Control` | Prevents unintended caching of sensitive responses |

Do not treat a missing header as a confirmed vulnerability without
understanding the application context.

## Cookies

For session or authentication cookies, review:

- `HttpOnly`
- `Secure`
- `SameSite`
- Expiry and lifetime
- Scope and path
- Whether logout invalidates the session

Do not attempt to steal, reuse or manipulate another user's session.

## Access control

Only test access control if the user provides:

- Separate test accounts
- Test data owned by those accounts
- Explicit approval for the comparison

Use this method:

1. Log in as an approved low-privilege test account.
2. Record accessible resources and actions.
3. Log in as another approved test account with the same role.
4. Compare access to resources and actions.
5. Report only clear, reproducible differences.

Do not attempt privilege escalation or access real user data.

## Rate limiting

Only test rate limiting if:

- The user explicitly approved it
- The target is local or an approved test environment
- The request count is small and predictable
- There is no risk of account lockout or service disruption

Stop immediately on:

- HTTP 429
- Account lockout
- Repeated 5xx responses
- Instability
- Any sign of impact beyond the test account

## Reporting rules

- Separate confirmed findings from suspicions and untested areas.
- Provide a reproduction path for every confirmed finding.
- Mask sensitive values in evidence.
- Do not speculate about exploitability without evidence.
- Do not claim a vulnerability is exploitable unless it was safely demonstrated.
- Record every check that was not performed and why.

## Safety rules

- Never test without explicit authorization.
- Never test production or shared infrastructure without separate approval.
- Never use destructive payloads or exploit techniques.
- Never access data outside approved test accounts and test data.
- Never continue after a stop condition.
- Never retain sensitive data in evidence or reports.