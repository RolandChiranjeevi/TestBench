# Check: the scope, what became of every check

Followed by both modes, in step 4, for every run, whatever the request chose. Paths are relative to the skill's folder (`SKILL.md`, "Paths").

The point: the person reads the report and knows what was **not** looked at, without asking. So every check below gets a row, also the ones the request did not choose and the ones a browser can never do. Nothing is
left out because it is obvious.

- **Write the rows.** In `coverage.md` in the folder of this claim, after the page sections, write a line `## Scope` and then **one row per id in the table below, every id**, as
  `<id> · <status> · <what you looked at, or why not>`, for example `security.headers · issue · 6 pages read; no Content-Security-Policy on any (observation "Security: no CSP")` or
  `visual.headings · not chosen · the request did not choose visual`.
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
| core.failed-requests | core | yes | yes | requests to the same origin that fail (4xx or 5xx) |
| forms.fields | core | yes | yes | every form field and every input class (the page sections above) |
| forms.sent | core | no | yes | what a form does when it is sent |
| flows.actions | core | no | yes | the flows: every link, button, menu and state, to the end (`modes/write.md`, step 3) |
| visual.title-lang | visual | yes | yes | the page title and `lang` |
| visual.headings | visual | yes | yes | one `h1`, and no level skipped |
| visual.images-alt | visual | yes | yes | images without a name that are not decorative |
| visual.link-text | visual | yes | yes | link text that says nothing, or the same text to different places |
| visual.landmarks | visual | yes | yes | `main`, `nav`, a header and a footer |
| visual.labels | visual | yes | yes | fields without a label |
| visual.layout | visual | yes | yes | cut-off text, a horizontal scroll, content over other content, at each size |
| visual.keyboard | visual | no | no | the keyboard path: Tab order, visible focus, no trap |
| visual.a11y-scan | visual | never | never | an automated accessibility scan, and WCAG conformance |
| api.calls | api | yes | yes | the calls a page makes to its own origin (address and status) |
| api.failing | api | yes | yes | the calls that fail (4xx or 5xx) |
| api.other-hosts | api | yes | yes | the hosts of calls to other origins |
| security.headers | security | yes | yes | the protective response headers of each page |
| security.cookies | security | yes | yes | the name and flags of every cookie set, never its value |
| security.mixed-content | security | yes | yes | an `http:` resource on an `https:` page |
| security.password-autocomplete | security | yes | yes | a password field without `autocomplete` |
| security.third-party-scripts | security | yes | yes | scripts from other hosts |
| security.active | security | no | no | requests of its own to probe injection or access control (only passive reads here) |
| limits.email | limits | never | never | the e-mail the site sends (there is no inbox) |
| limits.other-browsers | limits | never | never | Firefox and Safari: this runs in Chromium only, and Chromium is not Safari |
| limits.screen-reader | limits | never | never | how a screen reader reads the pages |
| limits.field-inp | limits | never | never | how fast the site answers real people (field INP) |
| limits.load | limits | never | never | how the site behaves under load (that is a load test request) |
| limits.legal | limits | never | never | whether the site meets the law (privacy, accessibility): a check here never establishes it |
