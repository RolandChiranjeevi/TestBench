# Check: visual

Followed from step 3 of the mode file when the request chose `visual` (in both modes). Paths are relative to the skill's folder (`SKILL.md`, "Paths").

- **The `visual` check, from the snapshot.** Only if the request chose `visual`. Read-only cannot press keys or read computed styles, so this check rests on what the page snapshot (with
  `boxes: true` for sizes) and a screenshot show. On **every** page you look at, and at each confirmed size, check: text that is cut off, a horizontal scroll, and content that covers other content.
- **Landscape.** At the mobile size, also look at each page turned (844×390): many pages break only there.
- **Images without a size.** In the page's HTML (`checks/page-html.md`), images with no `width` and `height` (or no aspect ratio): the page jumps while they load.
- **Where browsers differ.** A date field (`input type=date`), a `<dialog>`, a "copy" button and smooth scrolling behave differently in Firefox and Safari. Note each one you see in one
  `info` observation per kind, saying it was seen in Chromium only.
- Each deviation is an **observation** (title starting `Visual:`, severity `info` to `medium`, naming the pages and sizes); one per problem, not one per page.
