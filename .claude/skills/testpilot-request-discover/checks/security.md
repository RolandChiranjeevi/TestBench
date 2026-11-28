# Check: security

Followed from step 3 of the mode file when the request chose `security` (in both modes). Paths are relative to the skill's folder (`SKILL.md`, "Paths").

- **Reading headers** (this file, `checks/api.md` and `checks/privacy.md`). After a page has loaded, read the list of requests (`browser_network_requests`). For the **main document** of the page
  you may read its **response headers** with `browser_network_request` and `part: "response-headers"`, at most once per page. **Never** `part: "request-headers"` (it holds cookies and tokens),
  **never** `part: "response-body"` except the page's own HTML as `checks/page-html.md` allows, **never** the call without a `part`, and never a `filename`: a permission rule cannot hold you to
  this, so the text must. The reads count as browser calls.
- **The `security` check, passively.** Only if the request chose `security`. From what the browser already shows on the pages you visit, and send **nothing** of your own: whether these response
  headers are present (`Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, and `X-Frame-Options` or `frame-ancestors`), a
  `Content-Security-Policy` with `'unsafe-inline'` or `'unsafe-eval'` in `script-src`, the **name and flags** (`Secure`, `HttpOnly`, `SameSite`) of a cookie that is set and **never its value**, an
  `http:` resource on an `https:` page, a password field with no `autocomplete`, scripts from other hosts, and a header that names the server's software and version (`Server: nginx/1.18.0`,
  `X-Powered-By`).
- **From the page's HTML** (`checks/page-html.md`): a script from another host without `integrity` (subresource integrity); a payment key that is live (`pk_live_`) on an address that is not
  production; a card number field on the site's own page instead of in the payment provider's frame; and a token, a session id or an e-mail address in the address of a link or a form.
- **Probes with a purpose.** These are the only addresses of your own you open, each **once**, on the confirmed origin, with `browser_navigate`, and you say in the coverage row what each was for.
  At most 6 in a run.
  - **An error page.** `/testpilot-does-not-exist` (a page that cannot exist): does the answer leak a stack trace, a file path, `node_modules`, a database error or the framework's name and
    version? And is it a friendly page, not a bare error?
  - **Pages that should be closed.** `/admin` and `/debug`, while not logged in: a page that opens without a login is a finding.
  - **Version control left open.** `/.git/HEAD`: an answer that starts with `ref:` means the whole history can be downloaded. Read nothing else under `/.git/`. Never open `/.env`, a backup or a
    configuration file: what is in them would pass through you.
  - **Only on an address that is not production**, and only if the site has the parameter on its own pages:
    - **Reflected input.** A search or filter parameter (`?q=`, `?search=`) with the marker `testpilot<b>x</b>`: if the snapshot shows a bold `x`, the input is not escaped.
    - **An open redirect.** A parameter that sends you on (`?next=`, `?redirect=`, `?returnUrl=`) set to `https://example.com/`: if the page sends you there, note it and do not go on from
      `example.com`.
  On production, the two last are `not run · production address` in the scope.
- Report what is **missing or odd**, never what an attacker could do with it, and never as a confirmed vulnerability. Each is an **observation** whose title starts with `Security:`, with severity
  `info` or `low` (`medium` for a missing protection on a page that has a login or a payment form, a page that should be closed and opens, a leaking error page, an open `/.git/`, reflected
  input or an open redirect; `high` for a live key or a card field on the site's own page). It says which page. Apart from the probes above, you do not call an address of your own, try a value,
  change a header or follow a link to test any of it.
