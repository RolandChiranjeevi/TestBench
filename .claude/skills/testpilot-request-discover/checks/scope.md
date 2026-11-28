# Check: the scope, what became of every check

Followed by both modes, in step 4, for every run, whatever the request chose. Paths are relative to the skill's folder (`SKILL.md`, "Paths").

The point: the person reads the report and knows what was **not** looked at, without asking. So every check below gets a row, also the ones the request did not choose and the ones a browser can never do. Nothing is
left out because it is obvious.

- **Write the rows.** In `coverage.md` in the folder of this claim, after the page sections, write a line `## Scope` and then **one row per id in the table below, every id**, as
  `<id> · <status> · <what you looked at, or why not>`, for example `security.headers · issue · 6 pages read; no Content-Security-Policy on any (observation "Security: no CSP")` or
  `a11y.headings · not chosen · the request did not choose accessibility`.
- **The status** is exactly one of these words:
  - `done`: looked at, and nothing was wrong. Say what you looked at (which pages, how many).
  - `issue`: looked at, and something is wrong. Name the finding or findings.
  - `not run`: this mode could do it and the request chose it, but it was not done. Only a **hard** reason: a limit with its count (`browser call limit: 400 of 400`), a login wall, a stop of step 3. "No time", "skipped" or "not needed" is not a reason.
  - `blocked`: you tried, and it could not finish (a page that did not load, a tool that failed). Say what happened. A result you could not read is `blocked`, never `done`.
  - `not chosen`: the request did not choose its check (the `check` column; `core` and `limits` are always chosen).
  - `not in this mode`: the table says `no` for this mode.
  - `not possible`: the table says `never`: a browser cannot do it at all.
- **Check it.** The `precheck` call of your mode reads these rows (`--checks` with the request's `checks`, or `none`): a missing id, a status that does not fit the table, or a soft reason is a `GAP`.
  Fix each one, run it again, and hand in only when it prints no `GAP`.
- **Hand it in** (step 5), as findings:
  - one `coverage_gap` for each row that is `not run`, `blocked` or `not in this mode`, whose `description` says the id, what it is, the status and the reason;
  - one `observation` with severity `info`, title `Scope: <the host of the address>`, key `scope:<host>` (the host in lower case, a `:` as `-`, so `127.0.0.1:4310` is `scope:127.0.0.1-4310`), whose
    `description` is every row as you wrote it. Over 4000 characters, the rest goes in a second one, `Scope: <host> (2)` with key `scope:<host>:2`.
- **Say it in the report** (step 6): how many rows have each status, and then, by name, every row that is `not run`, `blocked`, `not chosen`, `not in this mode` or `not possible`.

| id | check | read | write | what it is |
|---|---|---|---|---|
| core.pages | core | yes | yes | the pages on the same origin, up to the depth's number |
| core.sizes | core | yes | yes | each confirmed screen size |
| core.console | core | yes | yes | errors in the console of every page |
| core.console-warnings | core | yes | yes | console warnings that point at a real fault |
| core.failed-requests | core | yes | yes | requests to the same origin that fail (4xx or 5xx) |
| core.links | core | yes | yes | links to the same origin, and pages that answer 4xx or 5xx (`checks/core.md`) |
| core.placeholders | core | yes | yes | text that slipped through: Lorem ipsum, `undefined`, `NaN`, `{{name}}`, empty prices |
| core.i18n | core | yes | yes | mixed languages, and dates or amounts in different formats |
| core.robots | core | yes | yes | `/robots.txt`, `/sitemap.xml` and `noindex` |
| forms.fields | core | yes | yes | every form field and every input class (the page sections above) |
| forms.input-kind | core | yes | yes | a field's `type`, `inputmode` and `autocomplete` (from the page's HTML) |
| forms.sent | core | no | yes | what a form does when it is sent |
| flows.actions | core | no | yes | the flows: every link, button, menu and state, to the end (`modes/write.md`, step 3) |
| visual.layout | visual | yes | yes | cut-off text, a horizontal scroll, content over other content, at each size |
| visual.landscape | visual | yes | yes | the mobile size turned (844×390) |
| visual.image-size | visual | yes | yes | images without `width` and `height` (from the page's HTML) |
| visual.browser-hotspots | visual | yes | yes | what behaves differently in Firefox and Safari (a date field, a dialog, a copy button) |
| a11y.title-lang | accessibility | yes | yes | the page title and `lang` |
| a11y.headings | accessibility | yes | yes | one `h1`, and no level skipped |
| a11y.images-alt | accessibility | yes | yes | images without a name that are not decorative |
| a11y.link-text | accessibility | yes | yes | link text that says nothing, or the same text to different places |
| a11y.landmarks | accessibility | yes | yes | `main`, `nav`, a header and a footer |
| a11y.labels | accessibility | yes | yes | fields without a label |
| a11y.form-markup | accessibility | yes | yes | a placeholder as the only label, required not marked, fields without a `fieldset` |
| a11y.icon-names | accessibility | yes | yes | buttons and links that are only an icon, with no name |
| a11y.target-size | accessibility | yes | yes | buttons and links smaller than 24×24 pixels at the mobile size |
| a11y.frames | accessibility | yes | yes | a `canvas`, a video or a frame from another origin, which the tree cannot show (listed) |
| a11y.keyboard | accessibility | no | no | the keyboard path: Tab order, visible focus, no trap |
| a11y.scan | accessibility | never | never | an automated accessibility scan, and WCAG conformance |
| api.calls | api | yes | yes | the calls a page makes to its own origin (address and status) |
| api.failing | api | yes | yes | the calls that fail (4xx or 5xx) |
| api.other-hosts | api | yes | yes | the hosts of calls to other origins |
| api.headers | api | yes | yes | `Content-Type` and `Cache-Control` of up to 3 calls per page |
| api.bodies | api | no | no | what an answer contains, its shape and its error messages (bodies are never read) |
| security.headers | security | yes | yes | the protective response headers of each page |
| security.csp-unsafe | security | yes | yes | `'unsafe-inline'` or `'unsafe-eval'` in the `Content-Security-Policy` |
| security.cookies | security | yes | yes | the name and flags of every cookie set, never its value |
| security.mixed-content | security | yes | yes | an `http:` resource on an `https:` page |
| security.password-autocomplete | security | yes | yes | a password field without `autocomplete` |
| security.third-party-scripts | security | yes | yes | scripts from other hosts |
| security.server-version | security | yes | yes | a header that names the server's software and version |
| security.sri | security | yes | yes | a script from another host without `integrity` (from the page's HTML) |
| security.live-keys | security | yes | yes | a live payment key (`pk_live_`) on an address that is not production |
| security.card-field | security | yes | yes | a card number field on the site's own page, not in the payment provider's frame |
| security.tokens-in-urls | security | yes | yes | a token, a session id or an e-mail address in a link or a form's address |
| security.error-page | security | yes | yes | what a page that cannot exist shows (a probe) |
| security.admin-routes | security | yes | yes | `/admin` and `/debug` without a login (probes) |
| security.git | security | yes | yes | `/.git/HEAD` (a probe) |
| security.reflected | security | yes | yes | a search parameter that comes back unescaped (a probe, not on production) |
| security.open-redirect | security | yes | yes | a parameter that sends you to another host (a probe, not on production) |
| security.active | security | no | no | requests that try injection or another user's data |
| privacy.banner | privacy | yes | yes | a consent banner, a reject as easy as accept, a policy link |
| privacy.before-consent | privacy | yes | yes | tracking calls before any choice |
| privacy.cookies-before | privacy | yes | yes | analytics or ad cookies set before any choice (from the headers; script cookies are not seen) |
| privacy.pii-in-urls | privacy | yes | yes | personal data in the address of a page or a tracking call |
| privacy.after-choice | privacy | no | no | what the site does after reject or accept |
| limits.email | limits | never | never | the e-mail the site sends (there is no inbox) |
| limits.other-browsers | limits | never | never | Firefox and Safari: this runs in Chromium only, and Chromium is not Safari |
| limits.screen-reader | limits | never | never | how a screen reader reads the pages |
| limits.speed | limits | never | never | page speed (LCP, CLS) and response times: the tools here cannot measure them |
| limits.field-inp | limits | never | never | how fast the site answers real people (field INP) |
| limits.load | limits | never | never | how the site behaves under load (that is a load test request) |
| limits.legal | limits | never | never | whether the site meets the law (privacy, accessibility): a check here never establishes it |
