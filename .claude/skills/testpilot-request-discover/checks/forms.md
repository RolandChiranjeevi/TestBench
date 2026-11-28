# Check: form fields (read mode)

Followed from `modes/read.md`, step 3, on every page with a form. Paths are relative to the skill's folder (`SKILL.md`, "Paths").

- **Form fields: fill in, never send.** On every page with a form, try **every** field, password and card fields too, **one field at a time and one value at a time**: send **one** `browser_type` in a message of its own (never two calls that type in the
  same message: they run at once, and the check in lock 2 comes too late), then, in the **next** message, read what the page shows (the snapshot the tool returned) and the list of requests, and
  only then type the next value. For each field try these input classes: **empty** (a required field), **wrong kind** (letters in a phone number or an amount, digits
  in a name), **too long** (well past what the field looks meant for), **boundary** (one character, and the longest the page says it takes), **format** (an e-mail without `@`, a date that does not
  exist), and **emoji** (wrong in a name, a phone number or an e-mail; fine in a comment or a message: say which you assumed). The depth sets how many values you try per class and how far you go
  (step 1, item 7: `Values per class`), never which fields: every field is tried at every depth. **The locks, every time:**
  1. Never Enter, never `submit: true`, never a click on a button, never a file. A form is never sent.
  2. After **each value**, read the list of requests (`browser_network_requests`), before you type the next one. If anything but a GET has gone out from this page since it loaded, stop typing in **that field**: write an
     observation (severity `medium`, title starting `Form:`, "the form sent data without being submitted", with the field, the method and the path, never a value), give that field no
     more values (its other rows are `not tried · lock 2: the field sent data`), and go on with the other fields of the page, still reading the requests after each value. A field that sends
     too gets the same. If a value makes the page **leave** (a new address, a page that reloads) or anything but a short save goes out, stop on this page and leave it.
  3. Leave the page by navigating away; nothing is saved. If the page asks whether to leave, answer leave (`browser_handle_dialog`); any other dialog is a stop (the stop conditions below).
  4. Only made-up values: never a real person's data, never a real password, never the password or a key the page itself shows (it is a secret: rule 5), never anything from `.env`. In a
     password field type made-up values to see the rules the page shows (a minimum length, a strength meter, that the characters are hidden); in a card field a made-up test number such as
     `4111 1111 1111 1111`, never a real card. Neither is ever sent: a real login belongs to the discover that acts on the target.
  What the page does with each value (a message, a field that refuses the character, nothing at all) goes in an observation or, when it is clearly wrong and repeats (rule 13), a bug report.
  **No feedback is a finding.** A value that should be refused (an emoji in a name, a phone number or an e-mail, letters in a phone number, a value far too long, an e-mail without `@`) that the
  field takes **with no feedback at all** (no message, no character refused, no mark on the field) is an **observation**: one per field, naming every class that went through (fields with the same
  lack on one page may be one observation), title starting `Form:` (for example `Form: Phone takes emoji and letters with no message`), severity `low`, or `medium` for a login, a payment or
  contact details. It says that it was seen while typing and that what happens when the form is sent was not checked (rule 12), which is why it is an observation and not a bug. Its row in
  `coverage.md` is `issue`, not `tried`.
  **Breadth first.** Give **every** field on **every** page with a form one value per class before you give any field its second value, and do the forms before the other sizes (a smaller
  size looks at layout, not at the rules of a field). Then, if the budget runs out, every field has been tried once and only extra values are missing.
  **Count the browser calls as you go**, every call of a browser tool, and keep the count on the first line of `coverage.md` (`Browser calls: 212 of 400`). A row may give the limit as its
  reason only with the count, `not tried · browser call limit: 400 of 400`, and only when the count has reached the limit: stopping before it is not a reason.
  **Keep count as you go, and check it before you hand anything in.** Write `coverage.md` in the folder of this claim: a line `## <the path of the page>` for each page with a form, then one row
  per field and class, `<field> · <class> · tried | issue | not tried · values <n> · <what the page did>` (for example `Phone · emoji · issue · values 2 · accepted in a phone number`). A field you
  never type in gets one row with the class `all` and its reason (`Upload · all · not tried · a file field`; `Phone · too-long · not tried · lock 2: the field sent data`). Before step 5, run
  `python3 -I testpilot/tools/request_call.py precheck <request number> --coverage <folder>/coverage.md --read --values <the depth's values per class> --checks <the request's checks joined by commas, or none>` (1, 2 or 3 values; the checks as in `checks/scope.md`). It prints a `GAP` for every field that
  lacks a class or has too few values: do those (or write the row with a hard reason: a file field, a field that sent data (lock 2), a page that left by itself), run it again, and hand in
  only when it prints no `GAP`. "No time" or "skipped" is not a reason.
  You cannot see the messages a form only shows when it is sent, so `Not checked` says so (rule 12). The field's own rules (`maxlength`, `pattern`) are in the page's HTML (`checks/page-html.md`): name them
  in the finding when you read them. A field you did not try goes in a coverage
  gap, with the reason.
- **The kind of field**, from the page's HTML (`checks/page-html.md`): an e-mail, phone or number field without the matching `type` or `inputmode` (a phone shows the wrong keyboard), and a
  name, address or one-time-code field without `autocomplete`. One **observation** per form (`Form:`), severity `info` or `low`, naming the fields. Whether a password field refuses pasting
  needs a key press, so it is not checked here.
