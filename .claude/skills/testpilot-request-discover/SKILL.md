---
name: testpilot-request-discover
description: Work on a discover request from TestBench with ONE confirmation: explore the target in a browser, read-only, or also acting on it when both the request and the project profile say full and it is not production; hand in a test plan, draft test cases, observations and bug proposals as findings, and mark the request done. Use only when /testpilot-requests hands over a discover request. It never acts on a production address.
user-invocable: false
---

# TestPilot: request discover

A person asked for a discover in TestBench (Automated tests, Requests). This skill is the one place that does it. It says which mode to work in; the mode file says every step; and each check the person
chose in TestBench is a file of its own, which the mode file tells you when to follow.

Input: the number of a discover request that `/testpilot-requests` has taken (claimed), and the mode it handed over.

## The mode

- **read**, the default: follow `modes/read.md`, steps 1 to 7, from the start to the end. It explores read-only: it fills in form fields but never sends a form, clicks nothing and logs in nowhere.
- **write**: follow `modes/write.md`, steps 1 to 7. Only when `/testpilot-requests` handed over `write`: the request asks to act on the target (`targetMode: full`), the project profile allows it
  (`permissionMode: full`), and the user did not say read-only. Its step 1 checks the profile again, and it never runs on production.

Never choose `write` yourself, and never switch mode during a run.

## The checks

The core (the pages, and every form field) always runs. The request's `checks`, which the person chose in TestBench, add the files below; the mode file says where in its step 3 each one is followed.

| Check | File | read | write |
|---|---|---|---|
| the core | `checks/core.md` | always | always |
| form fields | `checks/forms.md` | always | its own field classes, `modes/write.md` step 3 |
| the page's HTML | `checks/page-html.md` | when a check needs an attribute | only before the login |
| `visual` | `checks/visual.md` | if chosen | if chosen |
| `accessibility` | `checks/accessibility.md` | if chosen | if chosen |
| `api` | `checks/api.md` | if chosen, passively | if chosen, passively |
| `security` | `checks/security.md` | if chosen, passively and with its probes | if chosen, passively and with its probes |
| `privacy` | `checks/privacy.md` | if chosen, before anything is pressed | if chosen, before the banner is pressed |
| the scope | `checks/scope.md` | always, step 4 | always, step 4 |

A check that was not chosen is not run, and the report says so (rule 12): `checks/scope.md` gives every check id a row, also the ones not chosen and the ones a browser can never do.

## Paths

Every path in this file, in `modes/` and in `checks/` is relative to this skill's folder (the folder of this `SKILL.md`): `../testpilot/SKILL.md` is the boundaries, and `../../references/` the references, in all of them.
