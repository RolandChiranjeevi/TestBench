# Check: accessibility

Followed from step 3 of the mode file when the request chose `accessibility` (in both modes). Paths are relative to the skill's folder (`SKILL.md`, "Paths").

- **The `accessibility` check, from the snapshot.** Only if the request chose `accessibility`. Read-only cannot run an accessibility scan, press keys or read computed styles, so this check rests
  on what the page snapshot (the accessibility tree) and the page's HTML (`checks/page-html.md`) show. On **every** page you look at, check: the page **title** and the page's `lang`; the
  **headings** (one `h1`, and no level skipped, an `h1` followed by an `h3` is one); every **image** without a name (no alt text) that is not marked decorative; **links** whose text says nothing
  ("click here", "read more") or that share a text and lead to different places; the **landmarks** (`main`, `nav`, a header and a footer); and fields **without a label**.
- **Forms, from the HTML.** A placeholder that is the field's only label; a required field that is not marked as required both on screen and in the HTML (`required` or `aria-required`);
  related fields (an address, a date in three parts, radio buttons) without a `fieldset` and a `legend`.
- **Buttons and links without a name.** A button or a link that is only an icon and has no name in the snapshot.
- **Small targets.** With `boxes: true`, buttons and links smaller than 24×24 pixels at the mobile size.
- **What the tree cannot show.** A `canvas`, a video, or an `iframe` from another origin has no accessibility tree to read: list each one in the scope row `a11y.frames`, never as passed.
- Each deviation is an **observation** (title starting `Accessibility:`, severity `info` to `medium`, naming the pages); one per problem, not one per page. Say in the report that no automated
  accessibility scan was done and that this does not establish WCAG conformance (rule 12).
