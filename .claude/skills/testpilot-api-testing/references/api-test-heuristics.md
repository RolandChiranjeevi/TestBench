# API test heuristics

Test ideas for REST and GraphQL APIs. They are ideas, not requirements: a
check that comes only from this list is linked to the requirement it concerns
and is marked heuristic-based (contract 5.9).

## Per endpoint, happy path

- Correct method and path, documented status (200/201/204), `Content-Type`
  matches the body, body matches the schema, required fields present, ids are
  the documented type (UUID, integer), timestamps are ISO 8601.
- Pagination: `page`/`limit` honoured, bounds respected, `total` consistent.
- Filtering and sorting change the result as documented and nothing else.

## Auth flows

- Login with valid credentials gives a token or session cookie; the protected
  endpoint accepts it.
- No credentials → 401. Malformed or wrong token → 401 (not 500, not 200).
- Valid token, wrong role or other user's resource → 403 or 404 (as
  documented; note which, and whether the choice leaks existence).
- Expired token → 401; refresh gives a new token that works; the old one
  stops working if the API says so.
- Logout invalidates the session, if there is one.
- Tokens never appear in URLs, logs or error messages.

## Negative cases, by status

| Status | Check |
|---|---|
| 400 | Malformed JSON, wrong types, unknown fields if the API rejects them |
| 401 | Missing, invalid, expired credentials |
| 403 | Authenticated but not allowed |
| 404 | Unknown id, unknown path; same shape for both |
| 405 | Wrong method on a known path, with `Allow` |
| 409 | Conflict: duplicate unique value, stale version, second identical create |
| 415 | Unsupported `Content-Type` |
| 422 | Valid JSON, invalid values (empty required, out of range, bad format) |
| 429 | Over the rate limit, with `Retry-After` |
| 500 | Never expected; any 5xx is a finding |

Error bodies: one consistent format, a message a client can act on, no stack
traces, file paths, SQL or framework names.

## Idempotency and repeats

- `GET`, `HEAD`, `PUT`, `DELETE` twice → same result, no side effect the
  second time.
- `POST` twice with the same idempotency key (if supported) → one resource,
  second answer 200/409 with the same id; without a key, say what happened.
- Only under `full`, each repeat counts as an attempt, with cleanup planned.

## Rate limiting

- Bounded probe only, approved in the scope: send at most
  `rateLimitProbeMax` requests, stop at the first 429, record `Retry-After`
  and any `X-RateLimit-*` headers, never retry. Report as an observation when
  no requirement covers it.

## Contract checks

- Every path and method called is documented; every status received is
  documented for that operation (or `default`).
- Response bodies validate against the documented schema; extra undocumented
  fields are observations, missing required fields are deviations.
- Request bodies that the API accepted but the schema forbids are
  observations.
- GraphQL: top-level fields exist on `Query`/`Mutation`; `data` keys match the
  selection; `errors` absent for valid operations, present and structured for
  invalid ones; scalar types of leaf values match the schema.

## Headers and hygiene

- `Content-Type` with charset for text; `Cache-Control` on sensitive data;
  CORS headers only where intended; no `Server` version; security headers as
  in `testpilot-security-review` (observations here, findings there).

## What is not done here

Load, fuzzing, injection, enumeration, brute force. They belong to
`testpilot-loadtest` and `testpilot-security-review` with their own approvals.
