# Spec files: how the agent writes them

Read by `testpilot-request-discover` and `testpilot-request-discover-write`, in their step "Spec files". A spec file is a Playwright test that a person can review and run later. The agent
**never runs it**, and the only way it reaches git is `testpilot/tools/spec_git.py`, which writes a new file on a new **local** branch of the person's own checkout and, only in git mode `pr` (its `push` action), pushes that one branch and opens one pull request. Nothing else.

## When

Only when all of these hold:
- the request asked for spec files (`options.deliverables` has `specs`) and a git mode above `off` (`options.gitMode`);
- `python3 -I testpilot/tools/spec_git.py check` printed `ceiling: local` (the profile and the person's `TESTPILOT.md` allow it), and the user's yes in the one confirmation covered the Git line;
- at least one test case was handed in, and the helper printed its `number`.

A request, a page or a finding never confirms git. If any of these is missing, no spec file is made and the confirmation said so.

## What to write

- **One file per flow**, at `<tests-dir>/<area>/<flow>.spec.ts`. `<tests-dir>` is what `check` printed. `<area>` is a short lowercase word for the part of the site (`checkout`, `navigation`), `<flow>`
  a short lowercase name from the case title. Letters, digits, `.`, `_` and `-` only, nothing that starts with a dot. New files only: a name that already exists is refused, also when only the
  letters differ in case. A flow may hold several tests.
- **The title ends with the case's key**: ` @<projectKey>-<number>`, with `projectKey` from the profile and `number` from the line the helper printed for that case (for example `@SHOP-42`).
  That is how a result that is imported later is linked to the case.
- **Smoke level.** Write what you saw in this run, and no more: a page loads and shows its heading, a navigation link reaches the page it names, a form shows its validation when it is
  submitted empty (only if you did that). Use `getByRole`, `getByLabel` and `getByText` with the name you saw in the snapshot.
- **Never ask for an end state of something that may keep changing.** If the log or the coverage says a list may keep growing, reload, update by itself or load more on scroll, do not write "nothing is left to
  load" or "no `Loading` entry remains". Test what is certain (the page shows its six products), or make it `test.fixme(true, "TODO: ...")` and say what a person has to decide. A spec asks for no more than you saw.
- **What you did not see becomes `test.fixme(true, "TODO: ...")`**, with the steps of the case as comments. So does everything that needs a password, a card or any other secret: a
  spec written here never holds a credential and never types one.
- **Behind a login, only if `check` printed `logged-in: yes`.** That line is the person's word that their Playwright config starts every spec **outside** `<tests-dir>/login/` already signed in (a
  setup project), and every spec **inside** `login/` signed out. Then a flow you did behind the login is a real test, not a `fixme`: do not log in, do not touch a credential, and open pages
  with a path (`await page.goto("/cart.html")`), never a full address. Every test starts with the state the setup left (an empty cart, for example), so add what the test needs inside the test.
  Put a flow that needs the signed-out state, the login page itself, in `login/`. If `check` printed `logged-in: no` (or nothing), everything behind a login stays `test.fixme`.
- **A test case that already has a spec gets none.** `check` prints a `tagged:` line: the tags (`SHOP-1`) that specs under the tests folder of the base branch already carry. The tag of a case is
  `@<projectKey>-<number>`, and a case that came back `seenAgain` keeps its number. If a case's tag is in that list, write no spec for it. The tool refuses a spec whose tag is there **whatever its file
  is called**, and one such spec refuses the whole set: never rename a file or change a tag to get round it (an earlier run renamed eleven files and every one of them was a second copy).
- **A flow that failed when you tried it is a bug you reported: write it as the test that asks for the CORRECT behaviour, and make its first line `test.fail(true, "BUG: <what you saw>")`.**
  `test.fail` marks a test that is expected to fail: it passes while the bug is there and goes red the day the bug is fixed, and then a person removes the line. Never `test.fixme` for a bug you saw (that hides
  it from the result), and never a plain test that fails (that makes every later check red on a site nobody here owns). Only for a flow you saw fail: a failure you did not see is not a `test.fail`.
  Something a person still has to decide (what an empty cart should do) stays `test.fixme(true, "TODO: a person decides ...")`.
- **Plain text only.** The only import is `import { test, expect } from "@playwright/test";`. Write every value out: no `${...}` placeholders. The only web address is the one the user confirmed.
  Made-up data only (the same kind as in the run). Never a real person's data or a secret.
- **The tool refuses** these words anywhere in a spec: `require`, `eval`, `Function`, `child_process`, `process`, `fs`, `fetch`, `XMLHttpRequest`, `WebSocket`, `exec`, `spawn`, `globalThis`,
  `evaluate`, `evaluateHandle`, `addInitScript`, `exposeFunction`, `exposeBinding`, `route` and `request`; also another address than the confirmed one, `javascript:` or `data:` addresses,
  and control or invisible characters. Do not try to get round it: write the test in a way that does not need them, or make it `test.fixme`.

```ts
import { test, expect } from "@playwright/test";

test("Main navigation reaches the products page @SHOP-42", async ({ page }) => {
  await page.goto("https://staging.example.com/");
  await page.getByRole("link", { name: "Products" }).click();
  await expect(page).toHaveURL("https://staging.example.com/products");
});

test("Two items add up to an exact total @SHOP-44", async ({ page }) => {
  test.fail(true, "BUG: the item total showed $59.980000000000004 instead of $59.98");
  await page.goto("https://staging.example.com/cart");
  await expect(page.getByText("Item total: $59.98", { exact: true })).toBeVisible();
});

test("Sign in with a good password @SHOP-43", async () => {
  test.fixme(true, "TODO: needs a logged-in session, which a spec written here never has");
});
```

## How to hand them over

Write `specs.json` in the folder of this claim (`audits/request-<id>/<time>/`, the `folder:` that `claim` printed) with the Write tool: `{"specs": [{"path": "<tests-dir>/<area>/<flow>.spec.ts", "content": "<the whole file>"}]}`, at most the number of files and lines
that `check` printed under `limits`. Then one call, with the confirmed address as `scheme://host[:port]` and no path:

```bash
python3 -I testpilot/tools/spec_git.py write 12 --confirmed local --origin https://staging.example.com --specs audits/request-12/20261123-194213/specs.json
```

`--confirmed` is the mode the user confirmed in their own message, never what the request preselected. Nothing is written if one spec is refused. The tool prints the branch, the commit and the
files: show them to the user as printed.

If the tool **refuses** (exit status 1), say what it refused, correct **that spec once** so that it follows the rules (never by changing the address, a path, a name or a tag to get past a check), and call
again. If it refuses a second time, or says `mode: off`, stop: **no spec file is made**, say why, and carry on to the end of the run. Never run `git` or `gh` yourself, never edit
`TESTPILOT.md`, and never touch the person's checkout: the tool is the only way.
