# Requirements: what the agent tests against

Every Testbench project has its own **requirements**: what the system should do. They are the basis a test agent uses to **choose and prioritise
test cases** and to **propose new manual tests** where a requirement has no coverage. They are not a checklist the agent ticks off: **a person
decides whether a requirement is met.** Nothing an agent sends can mark a requirement as fulfilled, approved or passing.

## A requirement

| Field | |
|---|---|
| Number | `REQ-3`: Testbench's own number, per project. |
| Stable id | Optional, for example `CHECKOUT-A11Y-1`. It is what the requirement is imported and exported under, and what an audit package can use in `refs.requirements`. Unique within a project; the same id in two projects is two requirements. It cannot look like `REQ-n`. |
| Title, description | The wording. A changed title or description flags the linked test cases **to review**, as before. |
| Priority | `low`, `medium`, `high`, `critical`. |
| Status | `draft`, `approved` (**active**) or `deprecated` (**retired**). Only approved requirements are *active*. **Archive** on a requirement sets it to deprecated; **Restore** sets it back. A deprecated requirement is kept with its links and history. |
| Source | Free text or a link: a Jira story key, a URL, a document name. |
| Kind | `functional`, `accessibility`, `responsive`, `security_privacy`, `business_rule` or `usability`. |
| WCAG criteria | For accessibility requirements: success criteria such as `2.4.3`. |
| Viewports | For responsive (and accessibility) requirements: a device, a width and height, and/or a breakpoint. |

Create, edit, archive and delete them on the **Requirements** page. Attachments, linked test cases and change history work as before.

## Import

**Requirements, Import** reads a JSON file and shows a **preview** before anything is written.

```json
{
  "format": "testbench-requirements",
  "version": 1,
  "project": "SHOP",
  "requirements": [
    { "id": "CHECKOUT-PAY-1", "title": "A customer can pay with a card", "description": "…", "kind": "functional", "priority": "critical", "status": "active", "source": "https://example.test/spec" },
    { "id": "CHECKOUT-A11Y-1", "title": "The checkout can be used with a keyboard", "kind": "accessibility", "priority": "high", "wcag": ["2.1.1", "2.4.3"] },
    { "id": "CHECKOUT-RESP-1", "title": "The checkout works on a phone", "kind": "responsive", "viewports": [ { "device": "iPhone 13", "width": 390, "height": 844 }, { "breakpoint": "md", "width": 768 } ] }
  ]
}
```

A complete example is in [`examples/requirements/shop-requirements.json`](../examples/requirements/shop-requirements.json).

- `format`, `version`, `project` and `id` and `title` of each requirement are required. `project` must be the key of the project you import into: **a file for another project is refused whole**, and requirements are only ever looked up in the project being imported into.
- `status` is `draft`, `active` or `retired` (the existing `approved` and `deprecated` are accepted too). Omitted: `active`.
- `wcag` only on `accessibility` requirements; `viewports` only on `responsive` and `accessibility` ones.
- **Idempotent.** A requirement is identified by `id`. The same id is **updated** (its number, links and history are kept); a new id is **added**; the same file imported twice changes nothing and records no revision. `id` can also be the Testbench number of an existing requirement (`REQ-3`), which updates it; a number can never create one.
- **No duplicates.** The same id twice in a file, or an id and the number it already has, refuse the file. A new requirement with the same **title** as an existing one is added but flagged in the preview, so that you can use the existing requirement's id instead.
- **All or nothing.** One invalid requirement refuses the file, with the list of what is wrong. Requirements that are **not in the file are left alone**; nothing is deleted by an import.
- The import writes what the file says, including `status`: re-importing a file after you archived a requirement in Testbench restores what the file says. The preview shows every field that would change.

## What is linked to a requirement

A requirement is linked to **test cases** as before (a test case made from an agent proposal is linked to the requirements the proposal named), and to the **agent proposals** (manual tests) and **bug reports** that name it (`refs.requirements`: `REQ-3` or the stable id), or that a person linked by hand (on a manual test, **Edit requirements**). The requirement's page lists them. Links only ever resolve inside the project; a reference that matches nothing is shown on the manual test or bug report with the reason (not found, or not a requirement reference), and the Requirements page lists them all under *references to requirements that do not exist*.

Coverage counts **people's decisions**, not the agent's proposals:

| | |
|---|---|
| **Without a test** | No active test case is linked, and no **accepted** agent proposal either. A proposal that is not reviewed yet is shown next to the count (`0 +1`) and covers nothing. An accepted proposal that is not a test case yet shows as *Proposal accepted*: create a test case from it, and run it, for the requirement to show real coverage. |
| **With open bugs** | An **accepted** bug report names the requirement. A proposed one is shown but does not count. |
| **Not in latest audit run** | Audits have been imported, and neither a bug report nor a manual test of the **latest run** of any audit names the requirement (by the agent's newest version of it). It means "the agent's latest run did not look at this", not that it is met or broken. |

These are filters on the Requirements page. The coverage from test case results (**Passing**, **Failing**, …) is what says how well a requirement is tested, and a test case made from a proposal takes part in it like any other case.

## What the agent reads

```bash
curl http://127.0.0.1:4100/api/projects/<project id>/agent/requirements
```

Read-only. By default it returns the **active** requirements; `?status=draft`, `?status=retired` or `?status=all` choose others, `?kind=accessibility` narrows to one kind, and `?download=1` saves it as a file (the **For the agent** button on the Requirements page). If the instance is protected with a password, the agent needs a session; give it the downloaded file instead.

```json
{
  "format": "testbench-requirements", "version": 1, "project": "SHOP", "generatedAt": "…", "filter": { "status": "active" },
  "note": "These requirements are the basis for what to test… Whether a requirement is met is decided by a person…",
  "requirements": [ {
    "id": "CHECKOUT-A11Y-1", "ref": "REQ-2", "title": "…", "description": "…", "kind": "accessibility", "priority": "high", "status": "active",
    "source": "WCAG 2.2 AA", "sourceUrl": null, "wcag": ["2.1.1", "2.4.3"], "viewports": [], "updatedAt": "…",
    "coverage": { "testCases": 0, "manualTestsAccepted": 1, "manualTestsProposed": 0, "openBugs": 0, "proposedBugs": 0, "hasTest": true, "notReferencedInLatestAuditRun": false },
    "links": { "testCases": [], "manualTests": [ { "sourceId": "…", "title": "…", "status": "accepted" } ], "bugs": [] }
  } ]
}
```

- Use `id` in `refs.requirements` of a manual test or a bug report. It is the stable id when the requirement has one, otherwise `REQ-n`.
- `coverage` and `links` are there so the agent can **choose and prioritise** (start with critical requirements that have no test) and avoid proposing what exists. They are counts of what people have decided plus what the agent itself proposed, **not a verdict**: there is no "met", "passing" or "fulfilled" in the export, and the agent has no way to set one.
- The shape is the same as the import file, so an exported file can be edited and imported again, and changes nothing until it is edited.

## Reading the requirements with an agent token

The export above needs the login. For an agent that runs on its own there is a separate, read-only route with its own kind of token, `tbag_`
(a CI token, `tbci_`, does not work here and an agent token does not work for CI):

```
GET /api/agent/projects/<project id>/requirements
Authorization: Bearer <agent token>
```

It returns the **active** requirements of the token's project, five fields each, and nothing else:

```json
{
  "format": "testbench-agent-requirements", "version": 1, "project": "SHOP", "generatedAt": "…", "filter": { "status": "active" },
  "note": "These are the active requirements of the project. readiness only says whether acceptance criteria were found…",
  "requirements": [ { "requirement_id": "CHECKOUT-1", "title": "…", "source": "JIRA-12", "readiness": "ready", "acceptance_criteria": ["…", "…"] } ]
}
```

- `requirement_id` is the stable id, or `REQ-<number>` when there is none. `?kind=accessibility` narrows to one kind; `?status=active` is accepted and anything else
  (`?status=all`, an unknown parameter) is refused with `400`.
- **Acceptance criteria are read from the description**, because a requirement has no field for them (the editor says "Add acceptance criteria here"). A label is the words
  *Acceptance criteria* (any case, in bold or as a heading) alone on a line, or followed by a colon. After a label alone the criteria are the list items below it, and plain text lines
  directly under the label (no blank line between) count together as one criterion, so a sentence wrapped over several lines is one criterion; it ends at a blank line, a heading,
  another label or a list item. After a label with a colon the text on the same line is one criterion and list items directly under it are more. No label, or a label with nothing
  under it, gives no criteria.
- `readiness` is `ready` when at least one criterion was found and `needs-clarification` when none was. **It does not say that a criterion is measurable, and nothing here says that a
  requirement is met.** The agent judges the criteria itself.
- `401` for a missing, malformed, unknown or revoked token (and for a CI token), `403` for a valid agent token of another project, `429` after repeated wrong tokens (a limiter of its
  own). The token opens this one route and nothing else: no other route, no write, no other project. Every other route keeps asking for the login.

**Making and revoking tokens** (signed in; no screen for it yet, so with `curl`):

```bash
# 1. sign in (the cookie file holds the session; X-Testbench is required for every change)
curl -c cookies.txt -H 'X-Testbench: 1' -H 'Content-Type: application/json' -d '{"password":"<password>"}' http://127.0.0.1:4100/api/login
# 2. make a token: it is in this answer only, once
curl -b cookies.txt -H 'X-Testbench: 1' -H 'Content-Type: application/json' -d '{"name":"qa-agent"}' http://127.0.0.1:4100/api/projects/<project id>/agent/tokens
# list (prefix and dates, never the token) and revoke
curl -b cookies.txt http://127.0.0.1:4100/api/projects/<project id>/agent/tokens
curl -b cookies.txt -X POST -H 'X-Testbench: 1' -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:4100/api/agent-tokens/<token id>/revoke
```

Only a hash is stored, a project can have **five active tokens**, and revoking is the only way to end one (there is no expiry yet). Testbench has **no roles**: anyone who can sign in can
make and revoke agent tokens for every project. Keep the token in an environment variable or a secret, never in a file in a repository.
