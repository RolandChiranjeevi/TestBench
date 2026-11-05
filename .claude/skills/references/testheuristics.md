# Test Heuristics for LLM-Driven Testing

Condensed from *Testing Heuristics Cheat Sheet* (Hendrickson et al., Ministry of Testing) and *The Little Black Book on Test Design* (Rikard Edgren). These are practical patterns for finding real bugs when testing web applications.

---

## Core Principles

- **Testing is sampling.** You can never test everything. Focus on what matters most.
- **Bugs cluster.** Where you find one bug, look harder -- there are likely more.
- **Vary sequences, configurations, and data.** Identical repetition finds nothing new.
- **Look beyond requirements.** Implicit expectations, edge cases, and real-world usage reveal the important bugs.
- **After each action, observe broadly.** Don't just check the expected outcome -- look at the whole page, console, network, and surrounding state.

---

## Risk Categories

Pick the categories the feature's risks call for. Each idea below is a test idea, **not a requirement**. It becomes a
plan item only when it is linked to a requirement (see `../test-planning/SKILL.md`). The category names match the
`Test type` values in the test plan. The sections after this one (data attacks, web patterns, toolkit, quicktests)
are the shared material these ideas draw on.

### CRUD and data lifecycle (Functional)
- Create with only the required fields, with every field, and with a duplicate of an existing record.
- Read back what was created in the list and the detail view. Compare every field for rounding, encoding and trimming.
- Update one field, then several. Reload and check it persisted. Update then cancel: is the old value kept?
- Delete, then look in the list, search, counters and deep links. Delete a parent with children, and the last child.
- Count 0, 1 and many: empty state, a single item, a page-size boundary (for example 10 and 11 items), a very long list.
- Follow the data across screens: enter, store, search, display, export. Check that counters match the lists they summarise.

### Validation and input handling (Validation)
- Required fields empty, only spaces, exactly at maxlength, and maxlength + 1.
- Apply the string, number and date attacks below to every field.
- Invalid formats (an e-mail without `@`, letters in a phone number): is it rejected on the client **and** the server?
  Reload afterwards and check the invalid value was not saved. Does the message name the field?
- Paste, autofill and drag and drop into the same field. Enter key versus the button.
- Double submit: click twice quickly. Back after submit, then submit again.
- Empty submit of every form, including login and search.
- Error messages appear near the field, are readable, and clear once the value is corrected.

### Authorization and session (Authorization)
- Open a deep URL when logged out, after logout, from a bookmark, and in a second tab.
- Use the Back button after logout: is protected data still shown?
- Try every role on the same page: is a control only hidden, or is the action actually refused?
- Change an ID or slug in the URL to another record or customer (read only).
- Session expiry in the middle of a form: is input lost, and does login return to the right page?
- Wrong, empty and unknown credentials: is there an error, and does it avoid revealing whether the account exists?
- "Keep me signed in", logout in one tab, and tokens or keys shown in URLs or logs.
- Do not change permissions or real accounts in a production environment.

### State and workflow (State)
- Each status transition: allowed, not allowed (for example accepting an expired offer), and repeated.
- Back, forward and refresh in the middle of a flow and after submit. Bookmark a mid-flow URL.
- Cancel or close at each step. Is partial data kept or cleaned up?
- Interruptions: network off, timeout, tab closed.
- Do steps out of order, repeat a step, undo and redo.
- Change a setting after data exists. Does existing data survive?

### Concurrency and timing (Concurrency)
- Edit the same record in two tabs or as two users: last write wins, or a conflict message?
- Click rapidly, or act while the page is still loading.
- Real-time updates: an update arrives while the user is editing. Reconnect after being offline.
- Stale data: do counters, lists and details agree after another user's change?
- Retry after a timeout: does it create a duplicate?

### Responsiveness and layout (Responsive)
- Widths 320, 375, 768, 1024 and 1440, landscape 812 × 375, and 200 % zoom.
- Step the width in small increments around each breakpoint. Do controls disappear (for example header icons) with no
  alternative in the menu?
- Page-level horizontal scroll. Tables may scroll inside their own container.
- Clipped, overlapping or truncated text. Touch target size. Typed input kept after a resize.
- Resize while a menu or dialog is open. Orientation change.

### Internationalisation and localisation (Internationalisation)
- Switch language: everything changes, nothing is mixed, no raw keys, "undefined" or "null" shown.
- Long translations (for example German) and right-to-left text if supported.
- Formats: `dd.mm.yyyy` versus `mm/dd/yyyy`, decimal comma versus point, thousands separators, currency, time zones, DST.
- Characters: åäö, accents, CJK and emoji, in input, display and export. Sort order.
- Plurals and agreement ("1 shuttles", "result(s)").

### Accessibility (Accessibility)
- Tab through the whole page: logical order, no trap, visible focus, every control reachable.
- Dialogs and menus: focus moves in, Escape closes, focus returns to the trigger, the container has a role and a name.
- Every control, input and slider has a computed accessible name. Check the accessibility tree, not just `label` attributes.
- Page language and title, one `h1`, landmarks, headings in order.
- 200 % zoom and 320 px reflow. Text contrast 4.5:1, and information not carried by colour alone.
- Errors identified in text and linked to the field.
- Run axe per relevant state with `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`. Passing does not establish WCAG 2.1 AA conformance.

### Performance (Performance)
- Initial load and time until usable, also on a throttled network.
- Large lists, long search results, large uploads and downloads.
- Repeated navigation without reload: growing request counts, leaks, reconnect or reload loops in the console.
- Feedback while waiting (spinner, progress). Timeouts handled with a message.
- Measurements are observations unless the requirement gives a threshold.

### Visual consistency (Visual)
- The same component looks the same on every page: buttons, tables, status chips, headings, spacing.
- Counters, badges and labels agree with the data they summarise.
- Empty, loading, error and very long content. Hover, focus, active and disabled states.
- Placeholder or test content visible to users ("Hi", lorem ipsum, "undefined", unit-less numbers).
- Compare with a design reference when there is one. Without one, record a consistency risk, not a defect.

---

## Data Type Attacks

Use these as inputs whenever testing forms, fields, URLs, or APIs.

### Strings
| Attack | Examples |
|---|---|
| Empty / blank | `""`, `" "` (single space), multiple spaces |
| Long strings | 255, 256, 257, 1000, 1024, 2000, 2048+ characters |
| Boundary lengths | Exactly at maxlength, maxlength+1 |
| Leading/trailing spaces | `" hello"`, `"hello "`, `" hello "` |
| Special characters | `" ' \` \| / \ , ; : & < > ^ * ? { } [ ] ( ) ! @ # $ % Tab` |
| Accented characters | `àáâãäåçèéêëìíîðñòôõöö` |
| Asian characters | CJK ideographs, Hangul, Hiragana |
| Emojis | 😀🎉💥 (multi-byte, ZWJ sequences) |
| Line breaks | `\n`, `\r\n`, `\r` embedded in single-line fields |
| HTML injection | `<script>alert(1)</script>`, `<img onerror=alert(1)>` |
| SQL injection | `' OR 1=1 --`, `'; DROP TABLE x --` |
| Delimiters | Commas, semicolons, pipes in CSV-like fields |

### Numbers
| Attack | Value |
|---|---|
| Zero | `0` |
| Negative | `-1`, `-0.001` |
| Boundary powers of 2 | 32768, 32769, 65536, 65537, 2147483648, 2147483649, 4294967296, 4294967297 |
| Floating point | `0.0001`, `0.1 + 0.2` (IEEE 754 issues) |
| Scientific notation | `1E-16`, `1E+10` |
| Formatted numbers | `1,234,567` (US), `1.234.567,89` (EU) |
| Very large | Beyond int/long max values |
| NaN / Infinity | If applicable via API |

### Dates and Times
| Attack | Example |
|---|---|
| Invalid dates | Feb 30, Feb 29 in non-leap years, Sept 31 |
| Leap day | Feb 29 in a leap year |
| Format variations | `2025-06-05`, `06/05/2025`, `6/5/25`, `June 5, 2025` |
| Locale formats | `dd.mm.yyyy` vs `mm/dd/yyyy` |
| Time edge cases | 23:59:59, 00:00:00, midnight boundary |
| Daylight saving transitions | Spring forward / fall back |
| Timeouts | Actions that take longer than expected |
| Past/future extremes | Year 1900, year 2099 |

### Paths and Files
| Attack | Example |
|---|---|
| Long filenames | >255 characters |
| Special chars in names | Spaces, `*`, `?`, quotes, parentheses |
| Non-existent paths | Reference files that don't exist |
| Already exists | Upload/create with duplicate names |
| Empty file | 0 bytes |
| Very large file | Exceed expected limits |
| Wrong file type | Upload .exe when expecting .png |
| Corrupted file | Valid extension, invalid content |

---

## Web Testing Patterns

### Navigation
- **Back button**: Watch for "expired" messages and double-posted transactions.
- **Refresh**: Does it re-submit POST data? Does state survive?
- **Bookmark a deep URL**: Then open it logged out, or in a different session.
- **URL hacking**: Change, remove, or corrupt query parameters and path segments.
- **Multiple tabs/windows**: Same user, same page, concurrent edits.
- **History manipulation**: Forward/back through a multi-step flow.

### Input Handling
- Apply all string attacks above to every text input.
- Check if `maxlength` is enforced (both client-side and server-side).
- Paste long text (>5000 chars) into textareas.
- Use copy/paste, drag/drop, autofill -- not just typing.
- Try submitting forms with required fields left blank.

### Accessibility (A11Y)
| Area | What to Check |
|---|---|
| Keyboard | Tab order is logical; no keyboard traps; all functionality reachable; visible focus indicator; popups receive focus and can be dismissed with Escape |
| Screen reader | All interactive elements have labels; images have alt text (or are hidden if decorative); form inputs have associated labels; ARIA roles are correct |
| Visual | Zoom to 200% without breaking layout; sufficient color contrast (4.5:1 for text); information not conveyed by color alone; no all-caps blocks of text |
| Content | Plain language; acronyms explained; clear error messages; one `<main>` element |

### API Tests (Mnemonics)
- **BINMEN**: Boundary, Invalid entries, NULL, Method (wrong HTTP verb), Empty, Negative
- **POISED**: Parameters, Output, Interop, Security, Errors, Data
- **VADER**: Verbs, Auth, Data, Errors, Responsiveness

---

## Test Heuristics Toolkit

These are thinking tools -- apply them to whatever you're testing.

### Boundary Analysis (Goldilocks)
Test at and around every boundary: **too small, just right, too big**. Off-by-one errors are the most common coding mistakes. For any range or limit, test:
- Just below the boundary
- Exactly at the boundary
- Just above the boundary

### CRUD
For every data entity: **Create, Read, Update, Delete**. Then verify:
- Can you read what you created?
- Can you update and see the change?
- After delete, is it truly gone?
- What happens when you CRUD with 0, 1, and many items?

### Follow the Data
Trace data through its lifecycle: Enter → Store → Search → Display → Export → Import → Update → Archive. Verify integrity at every step. Does rounding, encoding, or truncation corrupt it along the way?

### Count: 0, 1, Many
For any collection or repeated element, test with zero items, exactly one, and many. This catches off-by-one errors, empty-state bugs, and performance issues.

### Position: Beginning, Middle, End
Edit or interact at the beginning, middle, and end of lists, text, sequences, and pages.

### Selection: Some, None, All
For any multi-select or permission set: select some, none, and all. Especially test the "none" and "all" edges.

### Interruptions
During any multi-step workflow: log off, shut down, reboot, kill process, disconnect network, timeout, press cancel, navigate away, hit back. What happens to partial state?

### Starvation
What happens under resource pressure? Low memory, slow network, full disk, high CPU. The app should degrade gracefully, not crash or corrupt data.

### Dependencies
Identify "has-a" relationships (Customer has Invoices, Invoice has Line Items). Apply Count and CRUD across the chain. Delete a parent with children. Delete the last child. Update the first child.

### Input Method Variation
The same data entered via typing, copy/paste, drag/drop, import, or API may behave differently. Test all paths to the same field.

### Sequences and State
Vary the order of operations. Do things out of the "expected" order. Undo/Redo. Repeat the same action. Do the reverse. Do two things simultaneously.

### Multi-User
Two users (or the same user logged in twice) performing simultaneous create, update, or delete on the same data. Race conditions and optimistic locking failures hide here.

---

## Quality Characteristics Checklist

When testing a feature, consider each of these dimensions. Not all are relevant every time, but scanning the list prevents blind spots.

| Characteristic | Key Questions |
|---|---|
| **Capability** | Does it do what it should? All functions present? Calculations accurate? |
| **Reliability** | Does it crash? Handle errors gracefully? Recover after failure? Data intact? |
| **Usability** | Easy to learn? Intuitive navigation? Clear error messages? Consistent behavior? |
| **Security** | Auth enforced? Permissions respected? Data private? No injection vectors? |
| **Performance** | Responsive under load? Acceptable with slow network? Memory usage reasonable? |
| **Compatibility** | Works across browsers? Viewport sizes? With assistive tech? |
| **Accessibility** | Keyboard-navigable? Screen-reader friendly? Sufficient contrast? |
| **Charisma** | Does it feel professional? Satisfying? Trustworthy? |

---

## Quicktests (Fast Checks That Find Real Bugs)

These are rapid probes -- each takes seconds and catches common issues.

1. **Boundary test**: For every input, try the min, max, and just beyond.
2. **Error message marathon**: Trigger every error message you can. Test hard *after* dismissing each one.
3. **Click frenzy**: Rapidly click buttons, especially submit buttons. Double-submit is a classic bug.
4. **Continuous use**: Don't restart between tests. Leave windows open. Let state accumulate. Systems tie themselves in knots over time.
5. **Cancel mid-flow**: Start a multi-step process, then cancel at each step. Is cleanup correct?
6. **Interference**: While one operation runs, start another that conflicts.
7. **Resource starvation**: Progressively constrain (slow network, large payloads) until it breaks.
8. **Back button after submit**: Submit a form, hit back, and submit again.
9. **Adjust settings after creation**: Create something with setting A, then change to setting B. Does existing data survive the transition?
10. **Empty state**: What does the page look like with zero data? Is the empty state helpful?
11. **Multiple instances**: Open the same page in many tabs. Edit the same record in two tabs.
12. **Feature interactions**: Find where features share data or state. Test at those intersections.
13. **Follow the writer**: Open the help/docs, follow instructions exactly. Do they actually work?
14. **Déjà vu**: When you get an error, reproduce it. If the message changes, the code is suspect.
15. **Network errors**: What happens when API calls fail? Mock 500s, timeouts, and empty responses.

---

## Test Strategy Mnemonics

### RCRCRC (for regression testing)
| Letter | Focus |
|---|---|
| **R**ecent | What new code areas should I test? |
| **C**ore | What essential functions must always work? |
| **R**isky | What areas are inherently fragile? |
| **C**onfiguration | What depends on environment/settings? |
| **R**epaired | What was recently fixed (and might regress)? |
| **C**hronic | What historically keeps breaking? |

### FAILURE (what to check after finding a bug)
**F**unctional, **A**ppropriate, **I**mpact, **L**og, **U**I, **R**ecovery, **E**motions

### SACRED (for test automation quality)
**S**tate Management, **A**ctions, **C**odified Oracle, **R**eporting, **E**xecution, **D**eterministic

### TRIMS (properties of good automated tests)
**T**argeted, **R**eliable, **I**nformative, **M**aintainable, **S**peedy

---

## Test Design Heuristics for LLMs

These are especially relevant when an LLM is deciding what to test.

### Prioritization
1. **Important problems fast.** Start with the highest-impact, most likely failures.
2. **Benevolent start.** First verify the happy path works at all before attacking edges.
3. **Broader partitioning.** If a representative case passes, you can skip close variants. If it fails, test the neighbors.
4. **Best representative.** When you can't test everything, pick the most common, most error-prone, and most important case.

### Coverage Strategy
5. **Diverse half-measures beat perfect narrow testing.** Do more *kinds* of testing to a reasonable level rather than one kind perfectly.
6. **Coverage for free.** A single well-designed test can cover capability, usability, performance, and accessibility simultaneously -- keep all of these in mind during every test.
7. **Don't stop when you find what you expected.** Look around -- adjacent areas may reveal surprises.
8. **Check errors after actions.** Always check console errors and network failures after every significant interaction.

### Adaptivity
9. **Change strategy when nothing new emerges.** If tests keep passing, try a different angle.
10. **Bugs cluster.** When you find one bug, test harder in the same area and related areas.
11. **Rumble strip.** When the app does something slightly odd, a bigger problem may be nearby.
12. **Problem elsewhere.** A bug found in one place likely exists in similar places.

### Observations
13. **Look at many places.** After an action, check the UI, the console, the network log, the URL, related pages, and stored data.
14. **User mistakes.** Test common typos, misclicks, and misunderstandings -- not just intentional misuse.
15. **Background complexity.** Use realistic, complex data (not just "test123") to catch real-world issues.

---

## Applying This When Testing with Trowser

*Tool-specific appendix. In this project browser actions use Playwright MCP. For example `browser_snapshot`,
`browser_console_messages` and `browser_network_requests` correspond to the state, console and network checks below.*

When using Trowser (API or scripts) to test a web application:

1. **Start with state.** Call `GET /api/state` to understand the page before doing anything.
2. **Check for pre-existing errors.** Look at console errors and network failures in the initial state.
3. **Test the happy path first.** Verify core functionality works before attacking edges.
4. **Apply data attacks to every input.** Use the tables above for each field type you encounter.
5. **After every action, check broadly:**
   - `GET /api/state` -- did the page update correctly?
   - `GET /api/console` -- any new JS errors?
   - `GET /api/network?errors=true` -- any failed requests?
6. **Test keyboard navigation.** Use `POST /api/tab-order` (or `browser_tab_order`) to verify Tab and Shift+Tab focus order, skipped controls, and keyboard traps. Use `POST /api/key {"key": "Tab"}` for manual step-by-step exploration.
7. **Run accessibility audit.** Use `POST /api/accessibility {"level": "AA"}` on every page.
8. **Test interruptions.** Navigate away mid-form. Refresh during loading. Click submit twice.
9. **Test empty and boundary states.** 0 items, 1 item, many items. Empty inputs. Maximum lengths.
10. **Vary input methods.** Type, paste, use selectors, use different data formats.
11. **Check responsive behavior.** Different viewport sizes via JavaScript or browser resize.
12. **Report findings with evidence.** Include what you did, what you expected, what happened, and which console/network errors accompanied it.

---

*Sources: Testing Heuristics Cheat Sheet (Hendrickson, Lyndsay, Emery et al., Ministry of Testing, 2022), The Little Black Book on Test Design (Rikard Edgren, 2012). Condensed for LLM-driven test automation.*
