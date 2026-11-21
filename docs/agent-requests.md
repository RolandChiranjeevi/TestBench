# Requests to a test agent

A person can ask a test agent to do something from Testbench: **look at a web address** (discover), **run the failed automated tests of a run again**, or **run chosen test cases**.
**Testbench starts nothing.** The request waits until an agent with its own token takes it, works in *your* environment under its own rules, and says when it is
done. What the agent delivers comes in through the normal import, as `proposed` items that a person reviews. First time? See [agent-quickstart.md](agent-quickstart.md).

```
a person asks → Waiting → an agent takes it → Taken → the agent works, in your environment, under its own rules → it delivers by the normal import → Done
```

Nothing here lets Testbench, or anyone's browser, run code on the machine that holds your data.

## Asking

- **Request discover**: **Automated tests → Requests → Request discover.** An address (http or https), an optional environment and an optional note.
  - The address cannot hold a user name or a password, nor a query that looks like a secret (`?token=…`, `?api_key=…`). Give the agent credentials some other way. At most 500 characters.
  - The note is at most 2000 characters.
  - **A name** (optional, one line of at most 60 characters, in the dialogs for a discover and for a re-run), so that you and the agent can tell requests apart. It is shown next to the request number in the list and in the agent's choice. It is set when you ask and is not changed afterwards: cancel the request and ask again if you chose wrong. Like the note, it is data to the agent.
- **Ask agent to re-run**: on an **automated** run that has failed or blocked tests, **Ask agent to re-run (n)**. The request lists those tests *as they were when you asked*
  (at most 500), so it stays the same if the run changes or is deleted afterwards. The environment is the run's unless you change it.
- **Ask an agent to run test cases**: **Runs → New manual run → Ask an agent.** Pick the test cases, an **address to test** (the same rules as for discover), an optional environment and note.
  - The run is made **at once**, as a manual run with an empty result for each chosen case, and the request points at it. The run shows *Waiting for agent · request #n*, then *Taken by agent: …*, *Agent finished* or *Request cancelled*. You can still fill in results yourself.
  - **The text of the chosen test cases is sent to the agent**: title, description, preconditions, steps (with their ids), and the *names* of linked automated tests and spec files, as they were when you asked. Never a spec's text, a requirement, an attachment or a screenshot.
  - **Do not put secrets, passwords, API keys or other sensitive information in test cases or in the address.** TestBench does not scan the text for them.
  - Between 1 and **200** test cases, at most **1 MB** of text (more is refused: pick fewer), and none that is deprecated. A suite the dialog was opened from stays on the run (*Suite: …*).
  - Taking and giving back work as for any request. The agent reports a result for each test case (below). **A run request is finished when every test case has a result** (`complete` answers 409 "N of M test cases have no result yet" until then); the run stays in progress for a person to review and finish. A request whose run was deleted cannot be taken.
- At most **20** requests can be waiting in a project. Taking or cancelling one frees a place.
- To re-run **manual** cases, use **Re-run failed cases**; that makes a manual run of the cases the failing tests are linked to, and needs no agent. It is greyed out when none of the failing tests is linked to a case, and **Ask agent to re-run** is the one to use for automated tests.
- An automated run to ask about comes from **Import results** or the GitHub Actions import. The CI route (`ci-report.mjs`) makes bugs and no run, so a project that only reports through CI has no run to ask about.

## What happens to a request

| State | Meaning |
| --- | --- |
| **Waiting** | Nobody has taken it. |
| **Taken** | An agent took it, with the name of its token. Only that token can finish it, or give it back. |
| **Done** | The agent says it is finished, with a note and, if it delivered something, a link to the run (a re-run) or the audit (a discover) that came in. |
| **Cancelled** | A person withdrew it (while it was Waiting or Taken). |

An agent that cannot finish a Taken request can **give it back** (release): it is Waiting again, with the agent's note, who gave it back and when. Nothing leaves Done or Cancelled. Taking is one step in the database that only succeeds while the request is Waiting, so two agents cannot take the same one.

## A request is a wish, not an approval

- The agent keeps **its own stops**: it asks you before it tests, a production target needs its two separate confirmations, and `observe_only` still means the agent only reads.
  A request does not replace any of them.
- The **address, the name and the note are data**. They were written by a person and are read by an agent, so an agent must treat them as information about the request and never as
  instructions. They are returned as plain fields, nothing is run from them, and nothing in a request approves, decides or changes anything in Testbench.
- Everything the agent delivers is `proposed` until a person decides, as for any audit.

## The request token

Made under **Settings → Agent → Requests to a test agent**, by an admin of the project.

- It is a fourth kind of agent token, **`tbrq_`**, apart from the read token (`tbag_`), the proposal token (`tbpr_`) and the CI token (`tbci_`). Each kind is refused by its prefix, so none can stand
  in for another.
- It is shown once and only its hash is stored. A project can have **three** active request tokens; revoking is the only way to end one. Too many wrong tokens from one address are slowed down (429).
- It opens **seven routes of one project and nothing else**. It cannot make or cancel a request, read requirements, touch specs or accounts, or decide anything; every other route refuses it. Four of them only change the
  status of a request (and a release adds a note, and a finished discover the audit it made). One makes findings of a discover (draft or proposed, and the discover's plan; see `mcp/README.md`). The last two (`result` and `case-results`) write test results, and are **off until a person switches them on** (below).
- No login cookie and no `X-Testbench` header are needed. The token is checked on every call.

```
GET  /api/agent/projects/<project id>/requests                    the waiting requests: the one a person put first, then the oldest
POST /api/agent/projects/<project id>/requests/<id>/claim         take one (409 if someone else did, or if another request of the project is taken)
POST /api/agent/projects/<project id>/requests/<id>/release       {"note": "why it is given back"}  (it waits again)
POST /api/agent/projects/<project id>/requests/<id>/result        the Playwright JSON report of a re-run or of a run request (off by default, see below)
POST /api/agent/projects/<project id>/requests/<id>/case-results  a result for each test case of a run request (off by default, see below)
POST /api/agent/projects/<project id>/requests/<id>/findings      one finding of a discover (draft or proposed, see mcp/README.md)
POST /api/agent/projects/<project id>/requests/<id>/complete      {"note": "...", "resultRunId": 42, "resultAuditId": 8}  (all optional)
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
  "runId": null, "tests": [], "status": "pending", "createdBy": "Tess Tester", "createdAt": "2026-11-14 12:00:00",
  "options": { "targetMode": "observe_only", "gitMode": "local", "deliverables": ["plan", "cases", "observations", "bugs"], "viewports": ["desktop", "tablet", "mobile"], "checks": [], "production": false } }
```

For a `rerun`, `runId` is the run and `tests` lists `{ id, framework, file, title, fullName }` of each failed or blocked test. `resultRunId` must be a run in the same project. Only a `discover` has `options`; the others have `"options": null`.

### Choices when asking for a discover (`options`)

A discover can carry `options`: what the person chose when asking. They are a **preselection for the agent's one confirmation, never a permission**. The agent is meant to show them in its own confirmation, the user confirms in a message of their own, and the agent stays under its own ceiling (the profile's `permissionMode`). A request never raises either: a request is a wish, not an approval.

| Option | Values | Default |
| --- | --- | --- |
| `targetMode` | `observe_only` (only read the target) or `full` (also change its state; each action still needs the user's confirmation) | `observe_only` |
| `gitMode` | `off`, `local` (commit on a local branch) or `pr` (push the branch and open a pull request, never merge) | `local` |
| `deliverables` | any of `plan`, `cases`, `observations`, `bugs`, `specs` | `plan`, `cases`, `observations`, `bugs` |
| `viewports` | any of `desktop`, `tablet`, `mobile` | all three |
| `checks` | none or any of `visual`, `api`, `security` (extra parts; the plan and the bug proposals always follow the test-planning and bug-reporting rules and are not choices) | none |
| `production` | `true` if the person says the target is production | `false` |

- **Only these choices, and nothing else.** They are enumerations, not text. An unknown option or a value that is not in the table is refused (400). Each value is kept once, in a fixed order. Without `options`, the defaults apply, and a discover made before options existed reads as the defaults.
- **A production target can only be read.** `production: true` together with `targetMode: full` is refused (400). It is a hint: the agent still asks for its own two confirmations for a production target. With `production: true` the only check allowed is `visual` (others are refused, 400).
- **With accounts on, `full` and `pr` need the admin role of the project** (403 for anyone else). Reading and a local branch are open to every tester. Without accounts there are no roles.
- **Only a discover has options.** A re-run or a run that is given some is refused (400).
- The audit log entry `agent_request.created` of a discover records `targetMode`, `gitMode` and `production`.
- **In the dialog**, *Request discover* has the same choices: what the agent may do to the address (only read, or act on it), what it may do in git, what to deliver and which screen sizes. *This address is production* takes acting on it away. *Act on the target* and *Push and open a pull request* are off for anyone who is not an admin of the project, with the reason as the tooltip. The request card shows the choices on one line.
- **After the request is made**, the dialog says what to do next, since Testbench starts nothing: the line that starts Claude Code, the first message to give it (both with a Copy button), what the agent will ask you, and a pointer to [the first-time set-up](agent-quickstart.md).
- The options are stored and handed to the agent (in the list, in the claim and by the MCP tool). The discover skills read them as a preselection for their one confirmation. `pr` is not built yet and counts as `local`; the spec files that `specs` asks for are described under "Spec files on a local branch" below.

### What a session that uses the token can reach

The token is a secret in a file that the agent's own session can reach (`.env`, or `.mcp.json` for the MCP server). The agent is told never to open them, and the skill's helper (`testpilot/tools/request_call.py`) is the only thing that reads the token. But that is behaviour, not a lock: the session also has file and shell tools (and, with the Playwright MCP, tools that run code in a browser), so an agent that chose to could read the token. TestBench cannot prevent that, and no setting here switches it off. It is a limit of the setup. What bounds the damage:

- **The token is narrow.** Seven routes of one project and nothing else (above). The routes that write test results are off until a person switches them on, and every finding stays a proposal.
- **Only a hash is stored**, and a revoked token is refused on the next call. Revoking is one step under **Settings → Agent → Requests to a test agent**, and the list shows when each token was last used.
- **At most three active tokens per project**, and making and revoking one is in the audit log (`token.created`, `token.revoked`). What an agent does with a request is written there too, as `agent_request.*` entries under "agent: <token name>".

What to do about it:

- Make a token for the work and **revoke it when the work is done**.
- Keep the session in its normal permission mode and answer its prompts. Do not save an "always allow" rule for reading files or running shell commands.
- In Claude Code's `auto` permission mode a classifier approves the calls and you are not asked, so no prompt would stop a read of `.env`. The limits above (the narrow token, revoking it, the audit log) do not depend on prompts and still hold.
- In the normal (`default`) mode a prompt guards shell commands, but **not the Read tool**. Measured with Claude Code 2.1.328 (appendix D of [agent-chain-verification.md](agent-chain-verification.md)): a `sed` against `.env` asked first, while Read of `.env` and of `.mcp.json` in the working folder ran with no prompt. So answering prompts does not keep a session from reading the token; the limits above do.
- Keep `.env` out of git (it is in `.gitignore`) and readable by you only (`chmod 600 .env`), and put in it only what the agent's folder needs: any other secret in that file is as reachable as the token.
- If you think a token was read, revoke it, and look at when it was last used and at the audit log.

## One request at a time, and the order a person chooses

- **At most one request of a project is taken at a time.** While one is Taken, every `claim` in that project is refused with **409**, whichever token asks, and the message names the one that runs (`Request #7 is already being worked on (agent: qa-agent)`). It is free again when that one is done, given back (`release`) or cancelled by a person. The check is part of the `UPDATE` that takes the request, so two agents asking at the same moment cannot both be given one. Another project is not held up.
- **A person chooses which goes first.** On the *Requests* tab, a waiting request that is not next has **Run next** (the same role as *Cancel*: a tester or an admin). It puts the request above every other waiting one. The agent's list (`GET …/requests`), the MCP tool `testbench_get_next_request` and the skill's list all follow that order: the one put first, then the oldest. A request that is already first is left as it is.
- **It is a place in line, nothing more.** It does not take the request, change what it asks, or give an agent any right it did not have. Only a waiting request can be put first (409 otherwise). It is recorded in the audit log as `agent_request.put_first`, with the person.
- **The person's list** (`GET /api/projects/<id>/agent-requests`) carries `priority` (0 until put first) and `queuePosition` (1 is next; `null` for a request that is not waiting).
- **A request that hangs.** There is no time limit on a taken request, so a session that died leaves it Taken. A person can **Cancel** it (that also frees the project), and the card says how long ago it was taken.
- **What a discover delivered.** The person's list carries `delivered` for a discover that made something: how many plan items and coverage gaps (the agent's own, not a person's), draft cases, bug reports, observations and manual test suggestions **are still there**. A thing a person deleted is not counted, and a discover that made nothing has `null`. Draft cases made before this was recorded (`cases.agent_request_id`) are not counted. The card shows it as *Delivered: …*.
- **MCP.** When requests wait but none can be taken, `testbench_get_next_request` answers `{"request": null, "reason": "…"}` with the reason (for example which request runs) instead of a bare `null`. `{"request": null}` alone means nothing waits.

## Giving a request back, and linking the audit

**Release.** `POST …/requests/<id>/release` with an optional `note` (at most 1000 characters). Only the token that took the request can do it, only while it is Taken, and **not after a report was handed in** (a re-run that has its result is finished, not repeated; `complete` it). The request is Waiting again, the claim is gone, and the note, `releasedBy` and `releasedAt` stay on it: the card shows *Given back by … : note* while it waits. Another agent (or the same) can take it. Each release is in the audit log (`agent_request.released`). A person can still cancel it.

**Audit link.** `complete` of a **discover** can carry `resultAuditId`, the `auditId` that `deliver` printed. TestBench links the request to the audit, and the card shows *Audit: its title*, which opens it under Bug reports → Audits. It must be an audit of the same project that was **imported after the request was taken** (the audit is imported with a person's login, not by the token, so the server cannot know whose it is, but it can refuse an older one). A re-run cannot carry it. If the audit is deleted later, the link is emptied and the request is kept.

## Handing in the report of a re-run

(A run request can hand in a report too, with other rules about which tests it may hold and how they are linked: see *The Playwright report of a run request* below.)

An agent that ran the failed tests again can hand in the Playwright JSON report, and Testbench makes a run of it, linked to the request. This writes test results (facts, not proposals), so it
is **off by default**. The owner switches it on for the installation (**Settings → Agent → Requests to a test agent → Agent results → Switch on**, or `PUT /api/settings/agent-results` with `{"enabled": true}`). While it is off the route answers 409 and writes nothing. Every change of the switch (and of the *Agent proposals* switch) is written to the audit log, as `settings.agent_results_changed` (or `settings.agent_proposals_changed`): who changed it, and from what to what. Putting the value it already has writes nothing.

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

## Reporting a result for each test case (a run request)

An agent that ran the test cases of a run request reports what happened, and TestBench writes it into the run that was made when the request was asked. These are test results (facts, not proposals) and they count **at once**
for the status of a test case, for coverage and for requirements, so this is **off until the owner switches on *Agent results*** (the same switch as for the report of a re-run; off by default). The Ask-an-agent dialog and Settings say so:
*Agent results must be enabled before an agent can report results for a run.* While it is off the route answers 409 and writes nothing.

```sh
curl -X POST -H "Authorization: Bearer $TESTBENCH_REQUEST_TOKEN" -H "Content-Type: application/json" \
  -d '{"results": [{"caseId": 17, "status": "failed", "note": "Saw a spinner", "error": "Expected Signed in", "durationMs": 4200,
        "steps": [{"stepId": 41, "status": "passed", "actual": "A form"}]}, {"caseId": 18, "status": "blocked", "note": "Sandbox down"}]}' \
  http://localhost:4100/api/agent/projects/5/requests/12/case-results
```

The answer is `{"reported", "counts", "progress"}`. The route takes a batch only when **all** of this holds, and refuses the whole batch otherwise (nothing is written, and nothing is left in the audit log):

1. Agent results are switched on.
2. The request is a **run request** that **this very token took** and that is still Taken.
3. The batch has 1 to **200** results and is at most **256 kB**; each result has a `caseId` of the request, a `status` of `passed`, `failed`, `blocked` or `skipped` (never `untested`; an agent that is not sure says `blocked`), and optionally
   `note`, `error` and a step's `actual` of at most 2000 characters, `durationMs` and `steps` (`stepId`, `status`, `actual`; each step a step of that test case). A field that is not listed is refused. A test case twice in a batch is refused.
4. Each test case's result in the run is still **untouched**: nobody has set it, changed it (also put it back to untested), commented it, linked an issue to it, given it step results or attached something to it, and no agent has reported it.
   **The agent never writes over what a person has done**, and each test case is reported **once**. Several batches may follow each other, so a long run loses nothing if the agent stops.
5. At most **60** calls a minute per token (429); every call counts, also a refused one.

TestBench sets the time. The result is **marked** with the token that reported it (`results.reported_by_agent_token_id`), shown on the run page as *Agent: name* with the tip *Reported by agent. A person may have changed it.*, and the mark stays
when a person changes the result afterwards. A person changes or deletes these results like any others (or deletes the run). The request and the run show *n of M results recorded (includes manual results)*: the count is every test case that has a result, whoever set it, and pointing at it says that what the agent reported may have been changed by a person.

Nothing here finishes anything: the agent finishes the request with `complete`, which needs a result for **every test case that still exists** (also one a person set by hand), and the run stays **in progress** for a person to review and finish. If a run request names automated tests or spec files but no Playwright report was handed in, the `complete` answer contains a `warning` that asks the agent to tell the user to import the report; `complete` still finishes the request, and the warning is not stored.
An agent that has to stop gives the request back (`release`): the results it reported stay, and the next agent sees in the request's `progress` (`{total, reported, missing}`) how many are left. The audit log gets
`agent_request.results_reported` for each batch (the agent's name, the request, the run, the token's id and the number per status, never the token).

## The Playwright report of a run request

An agent that ran the **automated tests of the test cases** of a run request (the `automatedTests` and `specFiles` that the request lists for each test case) hands in the Playwright JSON report on the same route as for a re-run:
`POST …/requests/<id>/result`. There is **no MCP tool** for it (a report can be 5 MB, too large for a tool argument): the TestPilot skill sends the file with its `result` action, and the request token only in a header.

It takes the same rules as the report of a re-run (*Agent results* on, a request **this very token took** and that is still Taken, **once per request**, at most 5 MB, and the whole report refused otherwise), and these:

1. **Which tests the report may hold.** A test that is linked to one of the request's test cases (its `automatedTests`, by framework and full name), or **any test in one of the request's spec files** (also a test TestBench does not know yet,
   so that a spec made in TestBench can get its first results). Every other test, a test twice, an empty report, something that is not a Playwright report, more than **1000 tests** or more than 5 MB refuses the **whole** report: no run,
   no test, no audit entry and no mark is made.
2. **TestBench decides which test case a test belongs to, the report does not.** A test TestBench already knows keeps its case (also none, and a link a person made). A new test in a spec file of the request is linked to the test case
   of that spec. Any other new test gets none. The title, the suite and the tags of the report, `@KEY-n` and `@REQ-n` included, link nothing and cover no requirement. (A re-run follows the same rule.)
3. **It becomes a separate automated run**, `Automated tests of run #… (request #…)`, marked as the agent's and in the request's environment, linked from the request (*Automated report handed in*) and from the manual run (*Automated report: run #N*).
   It does **not** touch the manual run, the results a person set there, or the results the agent reported with `case-results`, and TestBench does **not** copy the automated results into the manual run: the agent reports each test case itself,
   true to what the report says.
4. **It reaches a spec by its file name** (the last part of the file, any case of the letters and either slash), so a spec shows its tests and their last status; two files with the same name make it *ambiguous*. **It reaches a test case
   by the link:** a linked test case gets the status of its newest result, so coverage, requirement status and *Last automated* on the manual run's page follow it at once, which is why this is off until the owner switches agent results on.
5. At most **10 reports a minute per token** (429); every attempt counts, also a refused one.
6. The audit log gets `agent_request.result_delivered` in the same transaction as the run: the agent's name, the request, the run, the run that the report made, the token's id (never the token) and what came in (tests, new tests, linked, and how many
   passed, failed and were skipped).

A run request **can be given back after its report** (the report stays, and another agent can take the rest, but it cannot hand in another report); a re-run that has its report is still finished, not given back. `complete` is as it was:
it needs a result for every test case.

## Who can do what

| Role | Requests |
| --- | --- |
| **Viewer** | Sees the Requests tab, the list and each request's state. Cannot ask or cancel. |
| **Tester** and above | Asks for a discover or a re-run, and cancels a request that is Waiting or Taken. |
| **Admin** | Also makes and revokes request tokens. Both are written to the audit log (`token.created`, `token.revoked`: who, the project, and the token's name and prefix, never the token or its hash), and the token keeps who made it. |
| **Owner** | Also switches agent results on or off (off by default). |
| **An agent with a request token** | The seven routes above, for its own project. Nothing else. |

Who asked, cancelled, took and finished a request, and who reported results, is written to the audit log (shown to the owner when accounts are on; the filter is *Agent requests*).

## Not part of this

- Testbench does not run tests, start a browser or run an agent. A request is only a row that an agent can read.
- Starting a CI run (for example a GitHub Actions workflow) for a re-run is a possible later addition, and is not built.
- Starting a request without a person: an agent only works on a request that a user chose.

## The agent side: `/testpilot-requests`

The TestPilot skills have a command for this (`.claude/skills/testpilot-requests/SKILL.md`; setup in `testpilot/README.md`, section 10). It lists the waiting requests, the user chooses **one**, and only then does
the agent take it. The address and note are treated as data (`agent-rules.md`, rule 11), and a request confirms nothing. The MCP tools are the other way to work on a request: what each path can do, and which to use, is in [agent-paths.md](agent-paths.md).

- **discover:** `/testpilot-requests` hands it to `testpilot-request-discover`: **one** confirmation (the address, the environment, the read-only mode, what is delivered, how far it looks, what is sent and finishing the request), with the two separate confirmations for a production target kept. It explores read-only, hands in findings with the helper (request token only) and marks the request done with a note of numbers. If the request asks to *Act on the target* and the profile says `permissionMode: full`, `testpilot-request-discover-write` is used instead (the user says read-only when choosing the request to use the read-only one), which clicks and fills in forms with made-up data on an address that is **not production** ([below](#a-discover-that-may-click-and-type-reading-and-writing)). For the full audit with evidence and an audit package, the user asks for it instead: the address then goes to `/testpilot-discover` as a suggestion, and the normal audit flow follows, with every stop.
- **re-run:** Playwright tests only, only with `permissionMode: full`, and only after the user confirms the exact command and the environment. The agent asks where the tests are (the repository with `playwright.config.*`, which is usually not the folder it runs from), finds each test's file there, and writes its report and artifacts in its own folder, never in the user's repository. It then **offers to hand the report in** and shows exactly what would be sent: the file, its size and test count, the request, the address, and that TestBench makes a run marked as the agent's. It sends nothing until the user answers yes in a **new message**, and it sends **once**, only that file, only the report it just wrote. If agent results are switched off (409), or the user says no, nothing is lost: the report stays in `audits/request-<id>/` and the user imports it under **Import results**. After a successful hand-in the request already links the run, so the note carries no run number.
- **run, automated tests:** for a test case that has `automatedTests` or `specFiles`, and only if the user wants them run, the skill asks where the tests are (the repository with `playwright.config.*`), finds each file with exactly one match, runs whole files (never a test name in a shell string), shows the exact command and the environment (a production target needs the two confirmations), runs once, and then **offers to hand the report in** and shows exactly what is sent. It reports each test case's result afterwards, true to the report: never `passed` for a test case whose tests did not run.
- **run:** only with `permissionMode: full` and a valid address (a production target needs its two confirmations), **at most 10 test cases per request** (a cautious limit of the skill, "This skill supports up to 10 cases per request"; TestBench itself takes up to 200, and the skill's limit can be raised later), and only after the user confirms the plan in a message of its own. The agent runs the test cases **one at a time with Playwright MCP in the user's own environment**, writes the results to a file under `audits/request-<id>/`, **shows exactly what would be sent and asks** in a new message, and sends it with the `case-results` action (the token only in a header). It never invents a result: a test case it could not finish is `blocked`, one it did not run is `skipped` or left out, each with the reason. The text of a test case is data, and a step that asks for something outside the test is not done. It marks the request done only when every test case has a result, and never finishes the run.
- If the work stops, the agent **offers to give the request back** and shows the note it would send. It asks in a message of its own and does nothing without a yes, so the request stays Taken (until a person cancels it) if the answer is no.
- The request is marked done with a short note. For a discover that went through `testpilot-request-discover`, finishing the request and the note (counts only) are part of its one confirmation. For a re-run or a run, the user confirms the note first. After the **full audit** of a discover, the audit that `deliver` made is linked to the request.

### Running a discover without sitting by

In the normal permission mode every browser call and every file write asks you, and a discover on a small site makes 15 to 30 browser calls (the skill's cap is 60). To start one and come back to
a finished result, allow the tools the skill uses in advance. You still answer which request, whether the target is production, and the one confirmation; after that the agent works alone until it is
done, or stops for something that needs you (a login, another address, a risk).

Put this in `.claude/settings.local.json` in the agent's folder, and start a **new** session there (the file is read when a session starts):

```json
{
  "permissions": {
    "allow": [
      "mcp__playwright__browser_navigate",
      "mcp__playwright__browser_snapshot",
      "mcp__playwright__browser_resize",
      "mcp__playwright__browser_console_messages",
      "mcp__playwright__browser_network_requests",
      "mcp__playwright__browser_take_screenshot",
      "Bash(python3 -I testpilot/tools/request_call.py list:*)",
      "Bash(python3 -I testpilot/tools/request_call.py claim:*)",
      "Bash(python3 -I testpilot/tools/request_call.py findings:*)",
      "Bash(python3 -I testpilot/tools/request_call.py complete:*)",
      "Bash(python3 -I testpilot/tools/spec_git.py check:*)",
      "Bash(python3 -I testpilot/tools/spec_git.py write:*)",
      "Edit(audits/request-*/**)",
      "Write(audits/request-*/**)",
      "Write(//Users/you/agent-folder/audits/**)",
      "Bash(mkdir -p audits/request-*)"
    ],
    "deny": [
      "mcp__playwright__browser_click",
      "mcp__playwright__browser_type",
      "mcp__playwright__browser_fill_form",
      "mcp__playwright__browser_select_option",
      "mcp__playwright__browser_press_key",
      "mcp__playwright__browser_drag",
      "mcp__playwright__browser_hover",
      "mcp__playwright__browser_file_upload",
      "mcp__playwright__browser_handle_dialog",
      "mcp__playwright__browser_evaluate",
      "mcp__playwright__browser_run_code_unsafe",
      "Read(./.env)",
      "Read(./.mcp.json)",
      "Bash(git:*)",
      "Bash(gh:*)"
    ]
  }
}
```

Replace `/Users/you/agent-folder` with the absolute path of the agent's folder. The write rule is given in several forms because in testing an `Edit` rule alone did not cover the Write tool,
and it was not found out whether the relative or the absolute `Write` form was the one that matched. Keep all of them.

- **What it allows** is exactly what `testpilot-request-discover` uses: the six read-only browser tools, the helper actions `list`, `claim`, `findings` and `complete`, the two actions of the spec tool
  (`spec_git.py check` and `write`, see "Spec files on a local branch" below), and writing the findings under `audits/request-<id>/` (with `mkdir` for that folder). Nothing that clicks, types or
  runs code in a page is allowed: those eleven tools are **denied**, not only left out, and so is reading `.env` and `.mcp.json`, and so are `git` and `gh`: the agent never runs them, and the spec
  tool makes the few git calls it needs itself, from a fixed list.
- **What it leaves out on purpose.** `release`: giving a request back needs your yes. An inline `python3 -c` or `python3 -`, which can run anything. Everything outside the list still asks, and then
  it is worth reading what it asks for before you answer: it is outside what the skill needs.
- **`browser_navigate` is allowed for any address.** The skill keeps to one origin and at most 10 pages, but the permission no longer asks per address. If you point the agent at a site you do not
  control, leave `browser_navigate` out and answer each address once.
- **It is a fixed, narrow list you write once**, which is not the same as answering "always allow" in the middle of a run (the quickstart says never to do that). Keep it to the folder you give the
  agent, and not in a folder with other work.
- **Measured** on a local demo shop in the normal permission mode: with this list the browser calls, the helper calls and the writing of the findings did not ask. A hook of your own that asks for
  facts before a file is created is not part of Claude Code's permissions, and still applies. The `Read(./.mcp.json)` line was added afterwards and is not part of that measurement. Nor are the two
  `spec_git.py` lines, which two live runs used without a permission prompt (the person saw none, and the session log shows each call answered in under a second), and the `git` and `gh` denials, which were tried in a fresh session: see "Spec files on a local
  branch" below for what that showed and what was not tried.
- `.claude/skills/testpilot-request-discover/SKILL.md` is what the list follows: a test in `testpilot/tests/test_request_discover_skill.py` reads this block and fails if the list and the skill
  drift apart.

### A discover that may click and type (reading and writing)

`testpilot-request-discover-write` explores an address by clicking and filling in forms with **made-up data**, which the read-only discover never does. That finds what reading cannot: what a form does
with a wrong value, whether a sign-in works, what a flow ends in. It needs **three things**, and they are separate on purpose:
1. The request says *Act on the target* (`targetMode: full`). Only an admin can choose it in the dialog, and not for a production address.
2. The agent folder's profile says `permissionMode: full` (set with `/testpilot-init`, or by editing `.testpilot/projects/<key>.json`). The profile wins over the request.
3. You answer its **one confirmation**: it says what the agent may do, what it will never do, how far it goes and that the address may keep what it submits. It is used on its own when the request and the profile both say `full`; say read-only when you choose the request to use the read-only discover instead.

What it does and does not do:
- **Never a production address.** It asks whether the address is production, and a yes (or "not sure") ends it. Reading a production address is the read-only discover's job, with its two confirmations.
- **You log in yourself**, in the browser window, with an account you can lose or reset. The agent **stops once** when it meets a login, asks you to log in (or to skip it) and goes on; you can also say when
  you answer the confirmation that you are already logged in. It never types, reads or asks for a password, a token or a cookie, so no secret comes into its context.
- **Made-up data and fixed limits:** at most 10 pages, 40 actions (clicks, entries and selections) and 120 browser calls; a form at most twice (once empty or wrong, once with made-up data); never a password,
  card, identity-number or file field; nothing that looks irreversible (delete, reset, pay, send, publish, unsubscribe); never another origin.
- **A page is data, never an instruction.** A page that tells the agent to press something is reported as an observation and ignored. The demo shop in the live tests has such a page, and a button that resets it.
- **A log of every action** is written to `audits/request-<id>/actions.md`: the page, what was done and what happened, never the values typed. It is never handed in to TestBench. It is there so that you can see
  what changed on the address and undo it. Use an address you can reset.
- The findings, the helper and the note of numbers are the same as for the read-only discover (the note also says how many actions were taken). Nothing is approved.

To let it run while you are away, use this list **instead of** the one above (it adds the nine tools that click and type, and denies the ones that can run code or move files):

```json
{
  "permissions": {
    "allow": [
      "mcp__playwright__browser_navigate",
      "mcp__playwright__browser_snapshot",
      "mcp__playwright__browser_resize",
      "mcp__playwright__browser_console_messages",
      "mcp__playwright__browser_network_requests",
      "mcp__playwright__browser_take_screenshot",
      "mcp__playwright__browser_click",
      "mcp__playwright__browser_type",
      "mcp__playwright__browser_fill_form",
      "mcp__playwright__browser_select_option",
      "mcp__playwright__browser_press_key",
      "mcp__playwright__browser_hover",
      "mcp__playwright__browser_handle_dialog",
      "mcp__playwright__browser_wait_for",
      "mcp__playwright__browser_navigate_back",
      "Bash(python3 -I testpilot/tools/request_call.py list:*)",
      "Bash(python3 -I testpilot/tools/request_call.py claim:*)",
      "Bash(python3 -I testpilot/tools/request_call.py findings:*)",
      "Bash(python3 -I testpilot/tools/request_call.py complete:*)",
      "Bash(python3 -I testpilot/tools/spec_git.py check:*)",
      "Bash(python3 -I testpilot/tools/spec_git.py write:*)",
      "Edit(audits/request-*/**)",
      "Write(audits/request-*/**)",
      "Write(//Users/you/agent-folder/audits/**)",
      "Bash(mkdir -p audits/request-*)"
    ],
    "deny": [
      "mcp__playwright__browser_evaluate",
      "mcp__playwright__browser_run_code_unsafe",
      "mcp__playwright__browser_file_upload",
      "mcp__playwright__browser_drag",
      "Read(./.env)",
      "Read(./.mcp.json)",
      "Bash(git:*)",
      "Bash(gh:*)"
    ]
  }
}
```

- **With this list Claude Code no longer asks before it clicks or types.** Nothing in Claude Code's permissions can tell a harmless button from a destructive one. What protects the address is the
  confirmation, the rules in the skill (nothing that looks irreversible, made-up data, one origin, 40 actions), the rule that a page is data and the log. Those are rules written for an agent, not a lock.
  Use it only on an address you can reset. If you would rather be asked, leave the nine added tools out and answer each one.
- The rest is as for the read-only list: `release` and an inline `python3 -c` are left out on purpose, and the absolute `Write` path is yours to fill in. This list was run live three times against a local demo shop without the two `spec_git.py` lines and
  the `git` and `gh` denials. With them it was used in two more live runs (one writing, one read-only), and the denials were tried: see "Spec files on a local branch" below.
- `.claude/skills/testpilot-request-discover-write/SKILL.md` is what the list follows: a test in `testpilot/tests/test_request_discover_write_skill.py` reads this block and fails if the list and the skill drift apart.

### Spec files on a local branch (git mode `local`)

When a request asks for **Spec files** (and a git mode above `off`), both discovers can also write **Playwright specs** for the test cases they hand in: one file per flow, as **new files on a new local
branch of your own checkout**, committed once on top of `origin/<base>`. They are a proposal for you to review. The agent never runs them, never pushes or merges, never creates a remote or a repository,
and never touches the branch you have checked out or your uncommitted changes. The request only *asks*: the agent shows a `Git:` line in its one confirmation, and your yes to that message is what lets it
write. The mode that counts is the lowest of three things: the profile's `gitMode`, `mode-max` in your rules file, and what you confirm. `pr` is not built yet and counts as `local`.

**You set it up, the agent never does:**
1. In the project profile (`.testpilot/projects/<key>.json`): `gitMode` (`off` unless you change it), `repo` (`owner/name`), `repoPath` (the absolute path of your checkout), `baseBranch` (default
   `main`) and `projectKey`, the key of the project in TestBench: each spec's title ends with `@<projectKey>-<number>`, which is how a result that is imported later is linked to its case. A template is
   `testpilot/config/projects/shop.example.json`.
2. In that repository, **on the base branch**, a file `TESTPILOT.md` with your rules: the repository, the base branch, the highest mode you allow, the tests folder, the folders where new files may be
   made, what is never touched, and limits on files and lines. A template is `testpilot/config/TESTPILOT.example.md`. The agent reads it from `origin/<base>` **as you last fetched it** (run `git fetch`
   yourself), never from the working folder or from its own branch, and never edits it. The profile, that file and `origin` must name the same repository.
3. Keeping the repository correctly protected (a protected `main`, a narrow token, CI without secrets) is **your** job. The agent assumes it is and never checks.

**What happens:** `python3 -I testpilot/tools/spec_git.py check` tells the agent what is allowed (and the confirmation shows the folder and the branch name), and after the findings are handed in
`spec_git.py write` makes the branch `testpilot/discover-<request number>` (the prefix is yours to set). Look at it with `git log -1 --stat <branch>`, push it yourself if you want it, delete it if you do not.
If anything is missing or does not match (no checkout, no `origin/<base>`, no rules file, a repository name that differs), the mode is off and the run says why. A spec that breaks a rule is refused, and then
**no** spec file is made: the findings stay handed in, and the note of the request says `0 spec files`.

**What it checks, and where that stops.** The tool makes only a fixed list of git calls, with hooks off and no network. It writes only new `<tests-dir>/<area>/<flow>.spec.ts` files, never in `.github`,
never `package.json`, `TESTPILOT.md` or a Playwright config, and it checks the text of each spec (only `@playwright/test` as an import, no `eval`, `fetch`, `process` or `route`, no `${...}`, only the
confirmed address, no invisible characters). That text check is a **rule, not a lock**: someone who tries can get round a text check. The locks are your review of the branch and CI that runs it without
secrets.

**What was tried live, and what was not.** The `git` and `gh` denials in the lists above were tried in a fresh session in the agent's folder: `git --version`, `git status`, `ls && git log -1`,
`echo hi; git status` and `gh --version` were each denied by the rule, without a question to the person, also when `git` came after `&&` or `;` (the session log shows `Permission to use Bash with
command … has been denied`, a few seconds apart). **Not tried:** other shapes such as `env git …`, `bash -c "git …"`, a path to the binary or `$(git …)` (none of them is on the allow list, so they
would ask and not run), and a real `git push`. A spec set that the tool refuses is tested on real temporary repositories, but in the one live run where it should have happened the agent saw the limit
in advance and did not try to write, so the refusal and the one correction have **not been tried live**. How to set up the repository (the rules file, the profile, what to check and what to do when the mode is off) is in [agent-git-setup.md](agent-git-setup.md).
