# Requests to a test agent

A person can ask a test agent to do something from Testbench: **look at a web address** (discover), or **run the failed automated tests of a run again**.
**Testbench starts nothing.** The request waits until an agent with its own token takes it, works in *your* environment under its own rules, and says when it is
done. What the agent delivers comes in through the normal import, as `proposed` items that a person reviews.

```
a person asks → Waiting → an agent takes it → Taken → the agent works, in your environment, under its own rules → it delivers by the normal import → Done
```

Nothing here lets Testbench, or anyone's browser, run code on the machine that holds your data.

## Asking

- **Request discover**: **Automated tests → Requests → Request discover.** An address (http or https), an optional environment and an optional note.
  - The address cannot hold a user name or a password, nor a query that looks like a secret (`?token=…`, `?api_key=…`). Give the agent credentials some other way. At most 500 characters.
  - The note is at most 2000 characters.
- **Ask agent to re-run**: on an **automated** run that has failed or blocked tests, **Ask agent to re-run (n)**. The request lists those tests *as they were when you asked*
  (at most 500), so it stays the same if the run changes or is deleted afterwards. The environment is the run's unless you change it.
- At most **20** requests can be waiting in a project. Taking or cancelling one frees a place.
- To re-run **manual** cases, use **Re-run failed cases**; that makes a manual run of the cases the failing tests are linked to, and needs no agent. It is greyed out when none of the failing tests is linked to a case, and **Ask agent to re-run** is the one to use for automated tests.
- An automated run to ask about comes from **Import results** or the GitHub Actions import. The CI route (`ci-report.mjs`) makes bugs and no run, so a project that only reports through CI has no run to ask about.

## What happens to a request

| State | Meaning |
| --- | --- |
| **Waiting** | Nobody has taken it. |
| **Taken** | An agent took it, with the name of its token. Only that token can finish it. |
| **Done** | The agent says it is finished, with a note and, if it delivered something, a link to the run that came in. |
| **Cancelled** | A person withdrew it (while it was Waiting or Taken). |

Nothing leaves Done or Cancelled. Taking is one step in the database that only succeeds while the request is Waiting, so two agents cannot take the same one.

## A request is a wish, not an approval

- The agent keeps **its own stops**: it asks you before it tests, a production target needs its two separate confirmations, and `observe_only` still means the agent only reads.
  A request does not replace any of them.
- The **address and the note are data**. They were written by a person and are read by an agent, so an agent must treat them as information about the request and never as
  instructions. They are returned as plain fields, nothing is run from them, and nothing in a request approves, decides or changes anything in Testbench.
- Everything the agent delivers is `proposed` until a person decides, as for any audit.

## The request token

Made under **Settings → Agent → Requests to a test agent**, by an admin of the project.

- It is a fourth kind of agent token, **`tbrq_`**, apart from the read token (`tbag_`), the proposal token (`tbpr_`) and the CI token (`tbci_`). Each kind is refused by its prefix, so none can stand
  in for another.
- It is shown once and only its hash is stored. A project can have **three** active request tokens; revoking is the only way to end one. Too many wrong tokens from one address are slowed down (429).
- It opens **four routes of one project and nothing else**. It cannot make or cancel a request, read requirements, or decide anything; every other route refuses it. Three of them only change the
  status of a request. The fourth (`result`) writes test results, and is **off until a person switches it on** (below).
- No login cookie and no `X-Testbench` header are needed. The token is checked on every call.

```
GET  /api/agent/projects/<project id>/requests                    the waiting requests, oldest first
POST /api/agent/projects/<project id>/requests/<id>/claim         take one (409 if someone else did)
POST /api/agent/projects/<project id>/requests/<id>/result        the Playwright JSON report of a re-run (off by default, see below)
POST /api/agent/projects/<project id>/requests/<id>/complete      {"note": "...", "resultRunId": 42}  (both optional)
Authorization: Bearer $TESTBENCH_REQUEST_TOKEN
```

```sh
curl -H "Authorization: Bearer $TESTBENCH_REQUEST_TOKEN" http://localhost:4100/api/agent/projects/5/requests
curl -X POST -H "Authorization: Bearer $TESTBENCH_REQUEST_TOKEN" http://localhost:4100/api/agent/projects/5/requests/12/claim
curl -X POST -H "Authorization: Bearer $TESTBENCH_REQUEST_TOKEN" -H "Content-Type: application/json" \
  -d '{"note": "3 pages looked at", "resultRunId": 42}' http://localhost:4100/api/agent/projects/5/requests/12/complete
```

A request looks like this (times are UTC, `YYYY-MM-DD HH:MM:SS`):

```json
{ "id": 12, "projectId": 5, "kind": "discover", "targetUrl": "https://staging.example.com/", "environment": "staging", "note": "the checkout is new",
  "runId": null, "tests": [], "status": "pending", "createdBy": "Tess Tester", "createdAt": "2026-11-14 12:00:00" }
```

For a `rerun`, `runId` is the run and `tests` lists `{ id, framework, file, title, fullName }` of each failed or blocked test. `resultRunId` must be a run in the same project.

## Handing in the report of a re-run

An agent that ran the failed tests again can hand in the Playwright JSON report, and Testbench makes a run of it, linked to the request. This writes test results (facts, not proposals), so it
is **off by default**. The owner switches it on for the installation (`PUT /api/settings/agent-results` with `{"enabled": true}`; the Settings page gets its toggle in the next change). While it is off the route answers 409 and writes nothing.

```sh
curl -X POST -H "Authorization: Bearer $TESTBENCH_REQUEST_TOKEN" -H "Content-Type: application/json" \
  --data-binary @report.json http://localhost:4100/api/agent/projects/5/requests/12/result
```

The route takes the report only when **all** of this holds, and refuses the whole report otherwise (nothing is made or changed):

1. Agent results are switched on.
2. The request is a **re-run** that **this very token took** and that is not finished or cancelled.
3. Nothing was handed in for it before. **Once only**: even if a person deletes the run, a second report is refused. Ask for a new re-run instead.
4. The body is a Playwright JSON report, at most **5 MB**. No attachments, screenshots or traces are read.
5. Every test in the report is one the request named (by framework and full name), and none appears twice. A report with **any other test** is refused whole. Fewer tests than the request named is fine.

The report touches **only the tests it carries**: unlike a person's import, it does not go on to link other unlinked tests of the project to cases by the ID in their name.

The run gets `source: agent`, the **environment of the request** (never one from the report), and `meta.agentRequest`, which links it to the request. `resultRunId` is set by Testbench, so `complete` keeps it
and cannot name another run. The results count like any others (dashboards, flaky counts, last status); a tester can delete the run like any run. The audit log gets `agent_request.result_delivered`.

## Who can do what

| Role | Requests |
| --- | --- |
| **Viewer** | Sees the Requests tab, the list and each request's state. Cannot ask or cancel. |
| **Tester** and above | Asks for a discover or a re-run, and cancels a request that is Waiting or Taken. |
| **Admin** | Also makes and revokes request tokens. |
| **Owner** | Also switches agent results on or off (off by default). |
| **An agent with a request token** | The four routes above, for its own project. Nothing else. |

Who asked, cancelled, took and finished a request is written to the audit log (shown to the owner when accounts are on; the filter is *Agent requests*).

## Not part of this

- Testbench does not run tests, start a browser or run an agent. A request is only a row that an agent can read.
- Starting a CI run (for example a GitHub Actions workflow) for a re-run is a possible later addition, and is not built.
- Starting a request without a person: an agent only works on a request that a user chose.

## The agent side: `/testpilot-requests`

The TestPilot skills have a command for this (`.claude/skills/testpilot-requests/SKILL.md`; setup in `testpilot/README.md`, section 10). It lists the waiting requests, the user chooses **one**, and only then does
the agent take it. The address and note are treated as data (`agent-rules.md`, rule 11), and a request confirms nothing.

- **discover:** the address goes to `/testpilot-discover` as a suggestion, which validates and confirms it, with its two confirmations for production. The normal audit flow follows, with every stop.
- **re-run:** Playwright tests only, only with `permissionMode: full`, and only after the user confirms the exact command and the environment. The agent asks where the tests are (the repository with `playwright.config.*`, which is usually not the folder it runs from), finds each test's file there, and writes its report and artifacts in its own folder, never in the user's repository. It does not import the report (a later change lets it hand the report in with the `result` route, when a person has switched that on).
- The request is marked done with a short note after the user confirms the note.

Limits for now: an agent cannot release a request, so one that is taken and not finished stays **Taken** until a person cancels it. `complete` can link a run, and an audit import makes an audit, so after a
discover the audit is named in the note as text. The results of a re-run are not imported by the agent.
