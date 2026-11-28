# Check: visual

Followed from step 3 of the mode file when the request chose `visual` (in both modes). Paths are relative to the skill's folder (`SKILL.md`, "Paths").

- **The `visual` check, from the snapshot.** Only if the request chose `visual`. Read-only cannot run an accessibility scan, press keys or read computed styles, so this check rests on
  what the page snapshot (the accessibility tree) and a screenshot show. On **every** page you look at, check: the page **title** and the page's `lang`; the **headings** (one `h1`, and no
  level skipped, an `h1` followed by an `h3` is one); every **image** without a name (no alt text) that is not marked decorative; **links** whose text says nothing ("click here", "read
  more") or that share a text and lead to different places; the **landmarks** (`main`, `nav`, a header and a footer); fields **without a label**; and, at each confirmed size, text that is cut
  off, a horizontal scroll, and content that covers other content. Each deviation is an **observation** (title starting `Visual:` or `Accessibility:`, severity `info` to `medium`, naming
  the pages); one per problem, not one per page. Say in the report that no automated accessibility scan was done and that this does not establish WCAG conformance (rule 12).
