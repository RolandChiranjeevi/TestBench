# Check: api, passively

Followed from step 3 of the mode file when the request chose `api` (in both modes). Paths are relative to the skill's folder (`SKILL.md`, "Paths").

- **The `api` check, passively.** Only if the request chose `api`. You do it **here**, from what the browser already shows on the pages you visit, and send **nothing** of your own. After a page
  has loaded, read the list of requests (`browser_network_requests`): which calls to the same origin the page makes (address and status, never a body), the calls that fail (4xx or 5xx), and
  calls to other hosts (name the host).
- **Their headers.** For at most 3 calls to the same origin per page, read the **response headers** with `browser_network_request` and `part: "response-headers"` (the rules of
  `checks/security.md`, "Reading headers"): a JSON answer without `Content-Type: application/json`, and an answer about a person or an account without `Cache-Control: no-store` or `private`.
- **Never a body** of these calls: they may hold other people's data. So what an answer contains, its shape, and its error messages are not checked here, and the scope says so.
- Each is an **observation** whose title starts with `API:`, with severity `info` or `low`, and says which page and which call. Report what is **missing or odd**, never as a confirmed fault of
  the server. The reads count as browser calls.
