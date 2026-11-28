# Check: api and security, passively

Followed from step 3 of the mode file when the request chose `api` or `security` (in both modes). Paths are relative to the skill's folder (`SKILL.md`, "Paths").

- **The `api` and `security` checks, passively.** Only if the request chose `api` or `security`. You do them **here**, from what the browser already shows on the pages you visit, and send
  **nothing** of your own. After a page has loaded, read the list of requests (`browser_network_requests`). For the **main document** of the page you may read its **response headers** with
  `browser_network_request` and `part: "response-headers"`, at most once per page. **Never** `part: "request-headers"` (it holds cookies and tokens), **never** `part: "response-body"`, **never**
  the call without a `part`, and never a `filename`: a permission rule cannot hold you to this, so the text must. `api`: which calls to the same origin the page makes (address and status, never a
  body), the calls that fail (4xx or 5xx), and calls to other hosts (name the host). `security`: whether these response headers are present (`Content-Security-Policy`,
  `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, and `X-Frame-Options` or `frame-ancestors`), the **name and flags** (`Secure`, `HttpOnly`, `SameSite`) of a cookie that is
  set and **never its value**, an `http:` resource on an `https:` page, a password field with no `autocomplete`, and scripts from other hosts. Report what is **missing or odd**, never what an
  attacker could do with it, and never as a confirmed vulnerability. Each is an **observation** whose title starts with `API:` or `Security:`, with severity `info` or `low` (`medium` only for a
  missing protection on a page that has a login or a payment form), and says which page. You do not call an address of your own, try a value, change a header or follow a link to test any of it.
  The reads count as browser calls.
