# Check: privacy and consent

Followed from step 3 of the mode file when the request chose `privacy` (in both modes). Paths are relative to the skill's folder (`SKILL.md`, "Paths").

- **The `privacy` check, before any choice.** Only if the request chose `privacy`. Look at the **first** page you open, before anything is pressed: read mode never presses the banner, and
  write mode does this before it touches it. This check never establishes that the site meets the law (the scope row `limits.legal`).
- **The banner.** Is there a cookie or consent banner? Can it be refused as easily as accepted (a "reject" next to "accept", not only in a second layer)? Does it link to a privacy policy?
- **Tracking before consent.** In the list of requests (`browser_network_requests` with `static: true`), calls to tracking hosts made before any choice: `google-analytics.com` or
  `googletagmanager.com` (`/g/collect`, and its `gcs=` value: `G100` is denied, anything else is not), `facebook.com/tr`, `analytics.tiktok.com`, `px.ads.linkedin.com`, `bat.bing.com`,
  `hotjar.com`, `clarity.ms`. Match the host, not a word in the address. Each is an **observation** (`Privacy:`), severity `medium`.
- **Cookies before consent.** In the response headers of the main document (`checks/security.md`, "Reading headers"), the **names** of the cookies set before any choice, never their values.
  A name that belongs to analytics or ads (`_ga`, `_gid`, `_fbp`, `_gcl_au`, `_hjSession`) is an observation, severity `medium`. Cookies a script sets are not seen this way: say so in the
  scope row.
- **Personal data in addresses.** An e-mail address, a phone number, a name or a token in the address of a page or of a tracking call (`?email=`, `&uid=` with an e-mail): an observation,
  severity `medium`. Write the parameter's **name**, never its value.
- **What it does after a choice** (reject, then no new tracking; accept, then an update) needs a click: in read mode it is `not in this mode`.
