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
- It opens **ten routes of one project and nothing else**. It cannot make or cancel a request, read requirements, touch specs or accounts, or decide anything; every other route refuses it. Four of them only change the
  status of a request (and a release adds a note, and a finished discover the audit it made). One makes findings of a discover (draft or proposed, and the discover's plan; see `mcp/README.md`). One adds a screenshot to a bug report that discover made (below). One hands in the result of a load test (`load-result`, below). Two (`result` and `case-results`) write test results, and are **off until a person switches them on** (below).
- No login cookie and no `X-Testbench` header are needed. The token is checked on every call.
- **Screenshots of a bug.** A bug report that a discover makes may get two pictures: one taken before the step that fails (`before`) and one when the bug shows (`bug`). Only the token that took the
  request, while it is taken, and only for a bug report that request made itself, so a bug that was seen again keeps the pictures it has. Each picture is checked by its first bytes (png, jpg, webp or
  gif, at most 5 MB), stored as an attachment of the bug report and never analysed. At most one of each per bug, 200 per request and 120 calls a minute per token. The agent names them in the finding
  (`"screenshots": {"before": "<file>", "bug": "<file>"}`, files in the folder of the claim) and the helper sends them after the bug; a refused picture leaves the bug report made.

```
GET  /api/agent/projects/<project id>/requests                    the waiting requests: the one a person put first, then the oldest
POST /api/agent/projects/<project id>/requests/<id>/claim         take one (409 if someone else did, or if another request of the project is taken)
POST /api/agent/projects/<project id>/requests/<id>/release       {"note": "why it is given back"}  (it waits again)
POST /api/agent/projects/<project id>/requests/<id>/result        the Playwright JSON report of a re-run or of a run request (off by default, see below)
POST /api/agent/projects/<project id>/requests/<id>/case-results  a result for each test case of a run request (off by default, see below)
POST /api/agent/projects/<project id>/requests/<id>/findings      one finding of a discover (draft or proposed, see mcp/README.md)
GET  /api/agent/projects/<project id>/requests/<id>/known         what earlier requests already made and keyed: key, title, how often seen again (below)
POST /api/agent/projects/<project id>/requests/<id>/load-result   the result of a load test, once (below)
POST /api/agent/projects/<project id>/requests/<id>/bugs/<bug id>/screenshots   one picture of a bug this discover made, label before or bug (below)
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
  "options": { "targetMode": "observe_only", "gitMode": "local", "deliverables": ["plan", "cases", "observations", "bugs"], "viewports": ["desktop", "tablet", "mobile"], "checks": [], "depth": "normal", "production": false } }
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
| `depth` | `quick`, `normal` or `deep`: how much work the agent may do (its ceilings for pages, actions and calls, and for how much it hands in). It never gives a permission | `normal` (the dialog proposes `deep` when you choose to act on the target) |
| `production` | `true` if the person says the target is production | `false` |

- **Depth.** The skills read `depth` and use its numbers: *quick* 5 pages, *normal* 10, *deep* 40 (the write discover also takes 60, 250 or 1000 actions and stops after 8, 12 or 15 actions in a row that find nothing new). TestBench itself accepts up to 1000 findings, 300 plan items and 150 coverage gaps per request, the highest of the three, as a guard against a flood.
- **Only these choices, and nothing else.** They are enumerations, not text. An unknown option or a value that is not in the table is refused (400). Each value is kept once, in a fixed order. Without `options`, the defaults apply, and a discover made before options existed reads as the defaults.
- **A production target can only be read.** `production: true` together with `targetMode: full` is refused (400). It is a hint: the agent still asks for its own two confirmations for a production target. With `production: true` the only check allowed is `visual` (others are refused, 400).
- **With accounts on, `full` and `pr` need the admin role of the project** (403 for anyone else). Reading and a local branch are open to every tester. Without accounts there are no roles.
- **Only a discover has options.** A re-run or a run that is given some is refused (400).
- The audit log entry `agent_request.created` of a discover records `targetMode`, `gitMode` and `production`.
- **In the dialog**, *Request discover* has the same choices: what the agent may do to the address (only read, or act on it), what it may do in git, what to deliver and which screen sizes. *This address is production* takes acting on it away. *Act on the target* and *Push and open a pull request* are off for anyone who is not an admin of the project, with the reason as the tooltip. The request card shows the choices on one line.
- **After the request is made**, the dialog says what to do next, since Testbench starts nothing: the line that starts Claude Code, the first message to give it (both with a Copy button), what the agent will ask you, and a pointer to [the first-time set-up](agent-quickstart.md).
- The options are stored and handed to the agent (in the list, in the claim and by the MCP tool). The discover skills read them as a preselection for their one confirmation. `pr` counts as `local` unless every lock of section 9 of `docs/agent-git-setup.md` is in place; the spec files that `specs` asks for are described under "Spec files on a local branch" below.

### What a session that uses the token can reach

The token is a secret in a file that the agent's own session can reach (`.env`, or `.mcp.json` for the MCP server). The agent is told never to open them, and the skill's helper (`testpilot/tools/request_call.py`) is the only thing that reads the token. But that is behaviour, not a lock: the session also has file and shell tools (and, with the Playwright MCP, tools that run code in a browser), so an agent that chose to could read the token. TestBench cannot prevent that, and no setting here switches it off. It is a limit of the setup. What bounds the damage:

- **The token is narrow.** Nine routes of one project and nothing else (above). The routes that write test results are off until a person switches them on, and every finding stays a proposal.
- **Only a hash is stored**, and a revoked token is refused on the next call. Revoking is one step under **Settings → Agent → Requests to a test agent**, and the list shows when each token was last used.
- **At most three active tokens per project**, and making and revoking one is in the audit log (`token.created`, `token.revoked`). What an agent does with a request is written there too, as `agent_request.*` entries under "agent: <token name>".

What to do about it:

- Make a token for the work and **revoke it when the work is done**.
- Keep the session in its normal permission mode and answer its prompts. Do not save an "always allow" rule for reading files or running shell commands.
- In Claude Code's `auto` permission mode a classifier approves the calls and you are not asked, so no prompt would stop a read of `.env`. The limits above (the narrow token, revoking it, the audit log) do not depend on prompts and still hold.
- In the normal (`default`) mode a prompt guards shell commands, but **not the Read tool**. Measured with Claude Code 2.1.328 (appendix D of [agent-chain-verification.md](agent-chain-verification.md)): a `sed` against `.env` asked first, while Read of `.env` and of `.mcp.json` in the working folder ran with no prompt. So answering prompts does not keep a session from reading the token; the limits above do.
- Keep `.env` out of git (it is in `.gitignore`) and readable by you only (`chmod 600 .env`), and put in it only what the agent's folder needs: any other secret in that file is as reachable as the token.
- If you think a token was read, revoke it, and look at when it was last used and at the audit log.

### A discover that finds the same thing again

A test case, a bug report or an observation can carry a `key`: lower case words joined by `:` and `-` that say what the thing IS (`cart:float-total`), not how it was worded. `GET .../known` lists the
keyed posts of earlier requests (their key, title and how often they were seen again; a person's own posts have no key and are never listed), and only to the token that took the request.

When a finding carries a key that an earlier post has, **no new post is made** if all of these hold: the key is exactly the same in the same project; for a bug report, the page (the path of its address,
without a query or an extension) is the same and known on both sides; and the words of the title and the main text are alike enough (a Dice likeness of at least 0.3, measured on two real runs). The answer
is then `seenAgain: true` with the id of the post (and a case's number), and TestBench keeps a **sighting**: what the agent wrote this time, in full. The post is left as it is. Anything less than a match
makes a new post and says `possibleDuplicateOf: <id>` when the key exists. The rule is built to make a duplicate rather than to hide something, and a person can see and sort out the two. A finding
without a key is always a post.

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

## A load test (`loadtest`)

A person who is an **admin** of the project asks an agent for a small, bounded load test (**Request load test** on the Requests tab). It is its own kind of request, because it puts load on a system and has its own choices. Like every request it is a wish, not an approval: the agent shows the choices in its own confirmation and asks before it sends any load.

**The agent side:** `/testpilot-requests` hands a load test to `testpilot-request-loadtest`, which asks **one** confirmation (it also asks whether the system is production or shared, and stops on a yes), runs the fixed tool `testpilot/tools/loadtest.py` and hands the result in with `load-result`. The tool is the only thing that sends load, and its limits are in its code: 50 users, 120 seconds, 10 paths and 200000 requests, GET only, no login, no redirect followed, 10 seconds for one request, no retry, a local or private address only. It stops by itself when the share of failed requests, or p95, passes the limit (judged on the last 10 seconds, once at least 20 requests are in them). The verdict is worked out by fixed rules from numbers (fail: stopped or over the error limit; warning: over half of it, over 80 % of the p95 limit or any 5xx; otherwise pass), and nothing a page says is put in the result. There is no MCP path for a load test: use the skill.

| Choice (`loadOptions`) | Values | Default |
| --- | --- | --- |
| `vus` (users at most) | 5, 10, 25 or 50 | 10 |
| `durationSeconds` | 30, 60 or 120 | 60 |
| `rampUpSeconds` | 0, 10 or 30, and at most half of the duration | 10 |
| `paths` | 1 to 10 paths that start with a single `/` (GET only; no spaces, no `#`, no secret in the query) | `/` |
| `maxErrorRatePercent` (stop above this share of failed requests) | 1, 5 or 10 | 5 |
| `maxP95Ms` (stop when p95 passes this) | none, 1000, 2000 or 5000 | none |

- **Only a local or private address**, for now: `localhost`, `*.localhost`, `*.local`, `::1`, `127.x`, `10.x`, `172.16-31.x`, `192.168.x`. Anything else is refused (400). A name that points somewhere else is refused too, which is the safe side.
- **The choices are a ceiling for the result.** The agent hands in one result (`load-result`, at most 1 MB, once). TestBench checks it field by field and against what was asked: more users, a longer test or a path that was not asked for is refused (400) and nothing is kept. The result is rebuilt from the known fields and kept apart from the request, so a list of requests never carries it. TestBench checks the shape and the ceilings, **not the measurements**: they are what the agent reports.
- **A request with a result cannot be given back**, and it can only be finished (`complete`) once the result is in.
- **The verdict follows fixed rules over the numbers, and says whose fault it is.** `fail`: stopped for too many errors or too slow a p95, or an error rate over the limit. `warning`: an error rate over half of the limit, a p95 over 80 % of the limit, any 5xx, a stop by the agent, or **a p95 over 1000 ms when no p95 limit was set** (the report then says so). **A test that the tool could not go on with is never a `fail` for the site:** when the computer that runs the tool runs out of local ports, files or buffers (`EADDRNOTAVAIL`, `EMFILE`, `ENFILE`, `ENOBUFS`) those attempts are not counted as requests or as errors of the site, and a test that mostly fails like that stops with its own outcome, `stopped_tool_limit`, and a `warning` that says that the result says nothing about the site (use fewer users, or a server that keeps connections open). A refused connection still counts as the site's error.
- **The chip of a finished load test says how it ended.** In the list a load test that the agent has finished does not say plain "Done" (which looks like "all well" next to a discover): it says **Done · pass**, **Done · warning** or **Done · fail**, each in its own tone, taken from the verdict of the result that was handed in (the list carries it as `loadVerdict`; it is `null` until a result is handed in, and for every other kind). A request that is not done keeps its own status.
- **The report** is under **View the load test report** on the request: the verdict and its reason, the totals, the p95 over time with the limit drawn in, a table per path, and **Copy as Markdown** and **Download JSON**.

### Running a load test without sitting by

In the normal permission mode a load test asks you for each tool command: `plan`, `run` and `load-result`. To start one and come back to a result, allow them in advance. You still answer which request, whether the system is production or shared, and the one confirmation; after that the agent works alone until it is done, or stops for something that needs you.

Put this in `.claude/settings.local.json` in the agent's folder, and start a **new** session there (the file is read when a session starts):

```json
{
  "permissions": {
    "allow": [
      "Bash(python3 -I testpilot/tools/request_call.py list:*)",
      "Bash(python3 -I testpilot/tools/request_call.py claim:*)",
      "Bash(python3 -I testpilot/tools/request_call.py load-result:*)",
      "Bash(python3 -I testpilot/tools/request_call.py complete:*)",
      "Bash(python3 -I testpilot/tools/loadtest.py plan:*)",
      "Bash(python3 -I testpilot/tools/loadtest.py run:*)"
    ],
    "deny": [
      "Read(./.env)",
      "Read(./.mcp.json)",
      "Bash(git:*)",
      "Bash(gh:*)",
      "Bash(cat:*)",
      "Bash(grep:*)",
      "Bash(head:*)",
      "Bash(sed:*)",
      "Bash(find:*)",
      "Bash(ls:*)"
    ]
  }
}
```

- **What it allows** is exactly what `testpilot-request-loadtest` runs: the helper actions `list`, `claim`, `load-result` and `complete`, and `plan` and `run` of the load tool. The tool writes its result file itself, so no `Write` rule is needed. `release` is left out on purpose (giving a request back needs your yes), and so is an inline `python3 -c` or `python3 -`, which can run anything. `git`, `gh`, `.env` and `.mcp.json` are denied.
- **With `run` allowed, Claude Code does not ask before load is sent.** What stands between the agent and the load is then the skill's own confirmation (your yes, in a new message) and the ceilings in the tool's code: 50 users, 120 seconds, 10 paths and 200000 requests, GET only, a local or private address only. If you want Claude Code to ask for `run` as well, leave that one line out.
- **`cat`, `grep`, `head` and `sed` are denied**, so a file is read with the Read tool (which does not ask) and never with the shell. The denial is refused at once, with no question to you. It also closes a hole: `Read(./.env)` stops the Read tool, but not `cat .env` through the shell. `find` and `ls` are denied for the same reason: in a live run (2026-11-23) an agent used `find ... -exec ls -l` to list a folder, a command that was neither allowed nor denied, so it asked.
- **Not measured with the list in place.** It is written from the commands the skill runs and from the live test of 2026-11-23, where `plan`, `run` and `load-result` asked and `list`, `claim` and `complete` did not. A hook of your own that asks for facts before a file is created is not part of Claude Code's permissions, and still applies.
- `.claude/skills/testpilot-request-loadtest/SKILL.md` is what the list follows: a test in `testpilot/tests/test_request_loadtest_skill.py` reads this block and fails if the list and the skill drift apart.

## Checking the set-up: `doctor`

`python3 -I testpilot/tools/doctor.py` (run from the agent folder, the one that holds `.testpilot/`) tells you whether the folder is ready for a request, before you start one. It only **reads**: it writes nothing, fetches nothing, and **never prints a token** (a token-like string in any line is shown as `tbrq_[redacted]`). Each line is `ok`, `warn` or `fail`, and the exit code is 1 if there is a `fail`.

- **config:** the profile can be read and has a project id, a token variable, a permission mode and a valid address (plain `http` only to a local host, as the helper insists).
- **token:** the variable the profile names is set, in the environment or as its own line of `.env`, and looks like a request token. The value is not shown.
- **server:** one read-only call (the same as `request_call.py list`) shows that the address answers and that the token is accepted for the project. `--offline` skips it, and it is the only network call.
- **permissions:** `.claude/settings.local.json` against the lists in this document. A deny rule that **every** list has but your file lacks is a `fail` (that is how a missing `git`, `find` or `cat` denial shows up); an allow rule that **no** list has is a `warn`. The absolute `Write(//…/audits/**)` path is your own and is not a difference.
- **git:** the profile, the rules file and `origin` agree (the checks of `spec_git.py`). A git mode of `off` is fine.
- **skills:** whether the skills, the references, the tools and this document in the folder match `origin/main` (`ok`), lack changes it has (`stale`), or were changed here (`modified`). Nothing is fetched, so `stale` means *as of your last fetch*.

It does not check the browser profile (that is specific to a set-up) or what the text of a skill says. It is not allowed in the permission lists, because it is for you to run, and not for the agent.

## What the helper prints, and its exit codes

`python3 -I testpilot/tools/request_call.py <action> [<request number>] [--report|--case-results|--findings|--load-result <file>]` is the only thing that holds the token, and a skill or a script can rely on this:

- **Everything it prints is printable ASCII** (and line breaks). A control character, an escape sequence, a right-to-left or invisible character or any other non-ASCII character in text that came from TestBench, a certificate or a library is written as an escape (`\x1b`, `‮`), so that nothing a server says can steer a terminal. The data of a request is printed as JSON strings, so a note stays a note.
- **It never prints the token**, not on a line, not in an error, and not on stderr.
- Existing lines do not change; a new line or key may be added.

| Id | Situation | What it prints | Exit |
| --- | --- | --- | --- |
| `bad-arguments` | the action is not one of the ten, or the request number or `--result-run` is not a number | one line saying what is wrong | 1 |
| `config-unreadable` | `.testpilot/testbench.json` or the profile it names cannot be read, or the address is not allowed (plain `http` to a non-local host) | one line | 1 |
| `no-token-variable` | the profile names no `requestTokenEnvVar` | one line | 3 |
| `no-token` | the variable (or its line in `.env`) is empty or does not look like a request token | one line (and one on stderr) | 1 |
| `file-refused` | the file to send is not a plain `.json` file inside `audits/request-<id>/`, is empty or too big, or is not in the findings format | one line with the reason, nothing sent | 1 |
| `call-failed` | the call itself failed (network, timeout) | `the call failed (network or timeout…): not retried here` | 1 |
| `answered-200` | TestBench answered 200 | `<action> HTTP 200`, then the data lines of that action (JSON) | 0 |
| `answered-other` | TestBench answered anything else | `<action> HTTP <code>`, then `ERROR: <json>` | 1 |
| `not-json` | the answer was not JSON | `<action> HTTP <code>`, then `the answer was not JSON` | 1 |
| `findings-made` | `findings`: every finding was made | one JSON line per finding, then a line with `made` | 0 |
| `precheck-ok` | `precheck`: every page of the drafted coverage has its rows | `precheck: <pages> pages, <rows> rows (…), 0 gaps`, then one line per page, any `LEFT` rows, and a closing line | 0 |
| `precheck-gaps` | `precheck`: a page is missing, an input page lacks a class, or a row names no action numbers | the same first line with the number of gaps, then a `GAP` line for each | 1 |
| `precheck-refused` | `precheck`: the file is not a plain `.md` file inside `audits/request-<id>/` | one line | 1 |
| `findings-stopped` | `findings`: TestBench refused one, or the call failed | one JSON line per finding made before it, then a line with `stopped_at`; nothing is retried | 1 |

The table is tested against the code (`testpilot/tests/test_request_call_output.py`): each row is run, and its exit code and the shape of its first line must be what is written here.

## Who can do what

| Role | Requests |
| --- | --- |
| **Viewer** | Sees the Requests tab, the list and each request's state. Cannot ask or cancel. |
| **Tester** and above | Asks for a discover or a re-run, and cancels a request that is Waiting or Taken. |
| **Admin** | Also asks for a load test, and makes and revokes request tokens. Both are written to the audit log (`token.created`, `token.revoked`: who, the project, and the token's name and prefix, never the token or its hash), and the token keeps who made it. |
| **Owner** | Also switches agent results on or off (off by default). |
| **An agent with a request token** | The ten routes above, for its own project. Nothing else. |

Who asked, cancelled, took and finished a request, and who reported results, is written to the audit log (shown to the owner when accounts are on; the filter is *Agent requests*).

## Not part of this

- Testbench does not run tests, start a browser or run an agent. A request is only a row that an agent can read.
- Starting a CI run (for example a GitHub Actions workflow) for a re-run is a possible later addition, and is not built.
- Starting a request without a person: an agent only works on a request that a user chose.

## The agent side: `/testpilot-requests`

The TestPilot skills have a command for this (`.claude/skills/testpilot-requests/SKILL.md`; setup in `testpilot/README.md`, section 10). It lists the waiting requests, the user chooses **one**, and only then does
the agent take it. The address and note are treated as data (`agent-rules.md`, rule 11), and a request confirms nothing. The MCP tools are the other way to work on a request: what each path can do, and which to use, is in [agent-paths.md](agent-paths.md).

- **loadtest:** `/testpilot-requests` hands it to `testpilot-request-loadtest`: **one** confirmation, a run of `testpilot/tools/loadtest.py` after the user's yes, the result handed in (`load-result`) and the request marked done with a note of numbers. A request that is not for a local or private address is not taken. See "A load test" above.
- **discover:** `/testpilot-requests` hands it to `testpilot-request-discover`: **one** confirmation (the address, the environment, the read-only mode, what is delivered, how far it looks, what is sent and finishing the request), in which the production question is the request's own choice (the *This address is production* box), shown in the confirmation, and is asked, with its two separate confirmations, only when the request says production or the host name says `prod`. It explores read-only, hands in findings with the helper (request token only) and marks the request done with a note of numbers. If the request asks to *Act on the target* and the profile says `permissionMode: full`, `testpilot-request-discover-write` is used instead (the user says read-only when choosing the request to use the read-only one), which clicks and fills in forms with made-up data on an address that is **not production** ([below](#a-discover-that-may-click-and-type-reading-and-writing)). For the full audit with evidence and an audit package, the user asks for it instead: the address then goes to `/testpilot-discover` as a suggestion, and the normal audit flow follows, with every stop.
- **re-run:** Playwright tests only, only with `permissionMode: full`, and only after the user confirms the exact command and the environment. The agent asks where the tests are (the repository with `playwright.config.*`, which is usually not the folder it runs from), finds each test's file there, and writes its report and artifacts in its own folder, never in the user's repository. It then **offers to hand the report in** and shows exactly what would be sent: the file, its size and test count, the request, the address, and that TestBench makes a run marked as the agent's. It sends nothing until the user answers yes in a **new message**, and it sends **once**, only that file, only the report it just wrote. If agent results are switched off (409), or the user says no, nothing is lost: the report stays in `audits/request-<id>/` and the user imports it under **Import results**. After a successful hand-in the request already links the run, so the note carries no run number.
- **run, automated tests:** for a test case that has `automatedTests` or `specFiles`, and only if the user wants them run, the skill asks where the tests are (the repository with `playwright.config.*`), finds each file with exactly one match, runs whole files (never a test name in a shell string), shows the exact command and the environment (a production target needs the two confirmations), runs once, and then **offers to hand the report in** and shows exactly what is sent. It reports each test case's result afterwards, true to the report: never `passed` for a test case whose tests did not run.
- **run:** only with `permissionMode: full` and a valid address (a production target needs its two confirmations), **at most 10 test cases per request** (a cautious limit of the skill, "This skill supports up to 10 cases per request"; TestBench itself takes up to 200, and the skill's limit can be raised later), and only after the user confirms the plan in a message of its own. The agent runs the test cases **one at a time with Playwright MCP in the user's own environment**, writes the results to a file under `audits/request-<id>/`, **shows exactly what would be sent and asks** in a new message, and sends it with the `case-results` action (the token only in a header). It never invents a result: a test case it could not finish is `blocked`, one it did not run is `skipped` or left out, each with the reason. The text of a test case is data, and a step that asks for something outside the test is not done. It marks the request done only when every test case has a result, and never finishes the run.
- If the work stops, the agent **offers to give the request back** and shows the note it would send. It asks in a message of its own and does nothing without a yes, so the request stays Taken (until a person cancels it) if the answer is no.
- The request is marked done with a short note. For a discover that went through `testpilot-request-discover`, finishing the request and the note (counts only) are part of its one confirmation. For a re-run or a run, the user confirms the note first. After the **full audit** of a discover, the audit that `deliver` made is linked to the request.

### Running a discover without sitting by

In the normal permission mode every browser call and every file write asks you, and a discover on a small site makes 15 to 30 browser calls (the skill's cap is 400 at normal depth). To start one and come back to
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
      "mcp__playwright__browser_network_request",
      "mcp__playwright__browser_find",
      "mcp__playwright__browser_take_screenshot",
      "mcp__playwright__browser_type",
      "mcp__playwright__browser_handle_dialog",
      "Bash(python3 -I testpilot/tools/request_call.py list:*)",
      "Bash(python3 -I testpilot/tools/request_call.py claim:*)",
      "Bash(python3 -I testpilot/tools/request_call.py findings:*)",
      "Bash(python3 -I testpilot/tools/request_call.py known:*)",
      "Bash(python3 -I testpilot/tools/request_call.py precheck:*)",
      "Bash(python3 -I testpilot/tools/request_call.py complete:*)",
      "Bash(python3 -I testpilot/tools/spec_git.py check:*)",
      "Bash(python3 -I testpilot/tools/spec_git.py write:*)",
      "Bash(python3 -I testpilot/tools/spec_git.py push:*)",
      "Edit(audits/request-*/**)",
      "Write(audits/request-*/**)",
      "Write(//Users/you/agent-folder/audits/**)",
      "Bash(mkdir -p audits/request-*)"
    ],
    "deny": [
      "mcp__playwright__browser_click",
      "mcp__playwright__browser_fill_form",
      "mcp__playwright__browser_select_option",
      "mcp__playwright__browser_press_key",
      "mcp__playwright__browser_drag",
      "mcp__playwright__browser_hover",
      "mcp__playwright__browser_file_upload",
      "mcp__playwright__browser_evaluate",
      "mcp__playwright__browser_run_code_unsafe",
      "Read(./.env)",
      "Read(./.mcp.json)",
      "Bash(git:*)",
      "Bash(gh:*)",
      "Bash(cat:*)",
      "Bash(grep:*)",
      "Bash(head:*)",
      "Bash(sed:*)",
      "Bash(find:*)",
      "Bash(ls:*)"
    ]
  }
}
```

Replace `/Users/you/agent-folder` with the absolute path of the agent's folder. The write rule is given in several forms because in testing an `Edit` rule alone did not cover the Write tool,
and it was not found out whether the relative or the absolute `Write` form was the one that matched. Keep all of them.

- **What it allows** is exactly what `testpilot-request-discover` uses: the read-only browser tools, the two that fill in a form field without sending it (`browser_type`, one field at a time, and `browser_handle_dialog` for a "leave this page?" question), the helper actions `list`, `claim`, `findings` and `complete`, the two actions of the spec tool
  (`spec_git.py check` and `write`, see "Spec files on a local branch" below), and writing the findings in the folder of the claim, `audits/request-<id>/<time>/` (with `mkdir` for that folder). Nothing that clicks, presses a key, sends a form or
  runs code in a page is allowed: those nine tools are **denied**, not only left out, and so is reading `.env` and `.mcp.json`, and so are `git` and `gh`: the agent never runs them, and the spec
  tool makes the few git calls it needs itself, from a fixed list.
- **What it leaves out on purpose.** `release`: giving a request back needs your yes. An inline `python3 -c` or `python3 -`, which can run anything. Everything outside the list still asks, and then
  it is worth reading what it asks for before you answer: it is outside what the skill needs.
- **`browser_network_request` is allowed, and it can show more than the skill reads.** It is what lets the passive `api` and `security` checks read the response headers of a page. The same tool can return the request headers (with cookies and tokens) and the body of a response, and **a permission rule cannot hold it to the `response-headers` part**. Only the text of the skills does that (never `request-headers`, never `response-body`, never a `filename`). If you do not want to rely on that, leave this one line out of the list: Claude Code then asks before each call of it, and you answer each one (or refuse, and the checks stay with what `browser_network_requests` lists: addresses and statuses).
- **`browser_find` is allowed, and it can save a file.** It searches the page snapshot for text or a pattern and returns the matching elements and their references, which is cheaper than a whole snapshot. It reads and changes nothing on the page and runs no code. Like `browser_network_request` it has a parameter (`filename`) that a permission rule cannot hold back, so the skills say: only `text` or `regex`, never `filename`. Leave this one line out of the list if you do not want to rely on that.
- **One folder for every claim.** A request number can start again after TestBench is reset, and a folder named only by it can still hold the files of an older run. `claim` therefore prints `folder: audits/request-<id>/<time>`, made from the time TestBench gave the claim, and the agent writes everything for the request there: the log, the findings, a screenshot, the specs, the report. The permission rules already match it (`audits/request-*/**`), and the helper takes a file from anywhere inside `audits/request-<id>/`.
- **`browser_navigate` is allowed for any address.** The skill keeps to one origin and at most 10 pages, but the permission no longer asks per address. If you point the agent at a site you do not
  control, leave `browser_navigate` out and answer each address once.
- **`cat`, `grep`, `head` and `sed` are denied**, so a file or a page snapshot (in `.playwright-mcp/`) is read with the Read tool, which does not ask, and never with the shell. The denial is refused at once, with no question to you: in a live run a discover ran 18 `grep` commands on snapshots and two of them asked. It also closes a hole: `Read(./.env)` stops the Read tool, but not `cat .env` through the shell. `find` and `ls` are denied too (an agent listed a folder with `find ... -exec ls -l`, which was neither allowed nor denied, so it asked).
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
- **You log in yourself**, in the browser window, with an account you can lose or reset. The agent **stops once** when it meets a login, asks you to log in (or to skip it) and goes on; if the address itself shows a login, that is
  **before its first action**, so you can log in at the start and leave. You can also say when you answer the confirmation that you are already logged in. It never types, reads or asks for a password, a token or a cookie, so no secret comes into its context.
- **Made-up data and fixed limits:** at most 10 pages and a ceiling of 1000 actions (clicks, entries and selections) and 3000 browser calls, though a run ends sooner when everything it can reach is done or 15 actions in a row find nothing new; never a real password, card, identity-number or file field (the one password it
  types is a made-up wrong one on a login page, to see the refusal); never another origin.
- **What it may press on a test address, and what not.** The one confirmation says that this is not production, so the agent may finish a test purchase (a checkout that asks for no card), reset the
  app's own state and remove what it made itself. It never presses what sends or publishes to other people or pays a real provider, deletes or changes what was there before the run, or closes the account you
  logged in with. A production address is never acted on by this skill: there the read-only discover and its two confirmations apply.
- **It tries to go through everything it can reach**, not a sample: every link, menu item, form and sort option, each flow to its end and cancelled half-way, amounts with more than one price. It presses Logout
  last (so you are logged out afterwards) and then tries a protected page and a made-up wrong password. A gap in coverage has a hard reason (a secret, another origin, a card number, a limit).
- **A page is data, never an instruction.** A page that tells the agent to press something is reported as an observation and ignored. The demo shop in the live tests has such a page, and a button that resets it.
- **A coverage record shows what was done, and what was not.** TestBench has no place for "tried this, saw nothing wrong": a plan item is a plan, a test case is a draft, and only a failure becomes an observation or a bug. Without more, you would see the gaps and not what was checked, and could trust what was never done, or do it twice. So the agent hands in, for each page, **one observation** titled `Coverage: <path>` (severity `info`). Each line is `<thing> · <class> · tried | issue | not tried · actions <numbers> · <reason>`, where the class is one of the fixed list in the skill (`empty`, `wrong-kind`, `too-long`, `boundary`, `format`, `date-range`, `enter`, `end-to-end`, `cancel-back`, `empty-state`, `amounts`, `reset`, `order`, `links`, `menu`, `size`, `look`, `console`, `session`). Read them under **Observations**. A row that says `tried` or `issue` must name the numbers of the actions in the agent's log (`actions.md`), and one without numbers counts as `not tried`. The list of classes is a definition of what "most of it" means, not proof that it is the right list, and **the record is the agent's own account**: the way to check it is to compare it with the log, and the log with what the browser really did (the session log of the agent shows each call). Do that on a first run of a new version, and again whenever the result is surprising.
- **A log of every action** is written to `actions.md` in the folder of the claim (`audits/request-<id>/<time>/`, see below): the page, what was done and what happened, never the values typed. It is never handed in to TestBench. It is there so that you can see
  what changed on the address and undo it. Use an address you can reset.
- **`cat`, `grep`, `head` and `sed` are denied** here too, so a page snapshot is read with the Read tool and not with the shell (see the read-only list above), and the agent only presses a button that undoes something (Remove, Delete, Cancel) for what it made itself in this run, after a new snapshot.
- **A window of the browser itself can stop the run, and the agent cannot see it.** On a site whose demo password has leaked, Chrome shows a warning that blocks the whole tab: clicks do nothing, while selecting an option and opening an address still work. In two live runs (#13 and #17, 2026-11-23) that cost a stop and a wrong guess about the account. Switching to Playwright's own Chromium (`--browser chromium`) did **not** help. What worked was a separate browser profile for the agent, with the password manager, the leak check and Safe Browsing switched off (`credentials_enable_service`, `profile.password_manager_enabled`, `profile.password_manager_leak_detection` and `safebrowsing.enabled` set to `false` in the profile's `Default/Preferences`), and `--user-data-dir <that folder>` in the Playwright arguments of `.mcp.json`. It was tried in one live run (#19, no stop, no blocked click), not measured further. If a window still blocks the run, the agent stops once, asks you to close it, and hands in **one observation** about the test environment (not a fault of the site).
- **A request that was taken stays taken when the session is closed.** `exit` gives nothing back: the request is released only by the agent (`release`, which is left out of the permission lists on purpose) or by a person cancelling it. Until then, no other request of the project can be taken.
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
      "mcp__playwright__browser_network_request",
      "mcp__playwright__browser_find",
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
      "Bash(python3 -I testpilot/tools/request_call.py known:*)",
      "Bash(python3 -I testpilot/tools/request_call.py precheck:*)",
      "Bash(python3 -I testpilot/tools/request_call.py complete:*)",
      "Bash(python3 -I testpilot/tools/spec_git.py check:*)",
      "Bash(python3 -I testpilot/tools/spec_git.py write:*)",
      "Bash(python3 -I testpilot/tools/spec_git.py push:*)",
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
      "Bash(gh:*)",
      "Bash(cat:*)",
      "Bash(grep:*)",
      "Bash(head:*)",
      "Bash(sed:*)",
      "Bash(find:*)",
      "Bash(ls:*)"
    ]
  }
}
```

- **With this list Claude Code no longer asks before it clicks or types.** Nothing in Claude Code's permissions can tell a harmless button from a destructive one. What protects the address is the
  confirmation, the rules in the skill (nothing that reaches beyond the address or changes what was there before, made-up data, one origin, a ceiling of 1000 actions), the rule that a page is data and the log. Those are rules written for an agent, not a lock.
  Use it only on an address you can reset. If you would rather be asked, leave the nine added tools out and answer each one.
- The rest is as for the read-only list: `release` and an inline `python3 -c` are left out on purpose, and the absolute `Write` path is yours to fill in. This list was run live three times against a local demo shop without the two `spec_git.py` lines and
  the `git` and `gh` denials. With them it was used in two more live runs (one writing, one read-only), and the denials were tried: see "Spec files on a local branch" below.
- `.claude/skills/testpilot-request-discover-write/SKILL.md` is what the list follows: a test in `testpilot/tests/test_request_discover_write_skill.py` reads this block and fails if the list and the skill drift apart.

### Spec files on a local branch (git mode `local`)

When a request asks for **Spec files** (and a git mode above `off`), both discovers can also write **Playwright specs** for the test cases they hand in: one file per flow, as **new files on a new local
branch of your own checkout**, committed once on top of `origin/<base>`. They are a proposal for you to review. The agent never runs them, never pushes or merges, never creates a remote or a repository,
and never touches the branch you have checked out or your uncommitted changes. The request only *asks*: the agent shows a `Git:` line in its one confirmation, and your yes to that message is what lets it
write. The mode that counts is the lowest of three things: the profile's `gitMode`, `mode-max` in your rules file, and what you confirm. `pr` is in the tool (`spec_git.py push`: it pushes the branch and opens a pull request, only with a protection-confirmed date and a token of your own; see section 9 of [agent-git-setup.md](agent-git-setup.md)), and both discovers run it after `write` when `check` says `pr: yes` and your yes covered a `Git:` line that says the branch is pushed. Without that, `pr` counts as `local`.

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
