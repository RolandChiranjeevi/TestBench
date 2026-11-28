# Check: the core, on every page

Followed by both modes in step 3, for every run, whatever the request chose. Paths are relative to the skill's folder (`SKILL.md`, "Paths").

Cheap checks that find big mistakes, done on every page you look at, from what the snapshot and the list of requests already show:

- **Broken links.** Note every link to the same origin that a page shows. A page you open that answers `4xx` or `5xx`, or shows an error page, is a finding: a **bug report** when the site's own
  navigation leads there, otherwise an observation. Links you did not open (the page limit) are counted in the scope row `core.links`, with the limit as the reason.
- **Text that slipped through.** Placeholder or broken text on a page the person would see: `Lorem ipsum`, `TODO`, `undefined`, `NaN`, `null`, `[object Object]`, `{{name}}` or `${name}`, a
  translation key such as `checkout.title`, an empty price or amount. Each is an **observation** (`Content:`), severity `low`, `medium` when it is a price, an amount or a checkout step.
  `browser_find` with a regex finds them quickly (`/lorem ipsum|undefined|NaN|\[object Object\]|\{\{/i`).
- **Language and formats.** Two languages mixed on one page, a `lang` that does not match the text, and dates, times or amounts written in different formats on different pages
  (`2026-11-28` here and `11/28/2026` there, `1 299,00 kr` and `SEK 1299.00`). One **observation** (`Content:`) per kind, severity `info` or `low`, naming the pages.
- **Console warnings.** Besides the errors, the warnings of `browser_console_messages` that point at a real fault (a React key or hydration warning, a deprecated call, a failed font or image):
  one **observation** (`Console:`), severity `info`, per kind.
- **Search engines.** Once per run, open `/robots.txt` and `/sitemap.xml` of the origin. Note whether they exist, and whether `robots.txt` shuts everything out (`Disallow: /`) or the start page has
  `noindex` (`checks/page-html.md`). Either is an **observation** (`Search:`): `medium` when the address looks like production (the site would vanish from search), `info` when it is a test
  address that is open to search engines.
