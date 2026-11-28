# Two ways for an agent to work on a request

An agent can work on a request ([agent-requests.md](agent-requests.md)) through **two paths**: the **MCP tools** and the **skills**. Both use the same kind of token (`tbrq_`), the same routes of one project, and the same audit log. They differ in what they can do and in what they stop to ask.

| | **MCP tools** ([`mcp/README.md`](../mcp/README.md)) | **Skills** (`/testpilot-requests`, [`testpilot/README.md`](../testpilot/README.md) section 10) |
| --- | --- | --- |
| What it is | An MCP server with four tools: `testbench_get_next_request`, `testbench_update_request_status`, `testbench_report_results`, `testbench_create_finding`. | Instructions for the agent and a fixed helper, `testpilot/tools/request_call.py`, with the actions `list`, `claim`, `release`, `result`, `case-results` and `complete`. |
| Where the token is | In the environment of the MCP server (`TESTBENCH_TOKEN`, usually set in `.mcp.json`). | In `.env`, named by `requestTokenEnvVar` in the project profile. Only the helper reads it. |
| Taking a request | `testbench_get_next_request` takes the first waiting request (the one a person put first, otherwise the oldest), unless another request of the project is already taken: one runs at a time. | It lists the waiting requests, **you choose one**, and only then is it taken. |
| Stops | None of its own. The tool text says that a request is data and confirms nothing; your permission prompts and the agent's own rules decide the rest. | Built in: the address, the environment, production (two confirmations), the exact command, what is sent, and the note. A re-run or a run request needs `permissionMode: full`, and a run request holds at most 10 test cases. |

## What each path can do

| Work | MCP tools | Skills |
| --- | --- | --- |
| **Discover** | Findings handed in one at a time (`testbench_create_finding`): a draft test case, a proposed bug report, an observation or a manual test suggestion, and the request's plan (`plan_item`, `coverage_gap`, at most 100 and 50, apart from the 200 findings). A draft case can be linked to a plan item. | `/testpilot-requests` hands a discover request to `testpilot-request-discover`: **one** confirmation (a production target still gets its two), a read-only exploration, the plan, draft cases, observations and bug reports handed in with the helper (`findings`, request token only), and the request marked done with a note of numbers. No audit package; the only pictures handed in are the two screenshots of each bug report (before, and when the bug shows). |
| **Run request** (chosen test cases) | `testbench_report_results`: one batch, each test case once, at most 200 results and 256 kB. | `case-results` through the helper, the same route and limits. The skill runs the cases one at a time in a real browser, after you confirmed the plan. |
| **A Playwright report** (a re-run, or the automated tests of a run request) | **Not possible.** A report can be 5 MB, which does not fit a tool argument, and no tool takes a file. | `result` through the helper, after you confirmed exactly what is sent. |
| **Give back, done** | `testbench_update_request_status` with `released` or `done`. | `release` and `complete`. |

So a **re-run** always needs the skill to hand its report in; the MCP tools can take it, give it back and mark it done, but not deliver the report.

## Using both on one request

That works, and it is what the agent did in the verification of the chain ([agent-chain-verification.md](agent-chain-verification.md)): it took and reported through MCP, and handed the Playwright report in through the skill. Three things to get right:

- **Hand the report in before `done`.** Once the request is done, TestBench refuses the report (409). `done` then carries a `warning` if a test case of a run request names automated tests or spec files and no report was handed in.
- **Say where the tests are.** The skill asks for the repository with `playwright.config.*`. The MCP path never asks, so give the folder in your first instruction.
- **Use the same token on both paths.** Only the token that took a request can report on it or finish it.

## Which to use

- A **load test** (a request of its own kind, a bounded GET-only test of a local or private address, with **one** confirmation): `/testpilot-requests`, which hands it to `testpilot-request-loadtest`. **There is no MCP path for it**: the load is sent by a fixed tool, and the result goes in with `load-result` through the helper.
- A **discover from a request** (a draft plan, test cases, observations and bug proposals, read-only, with **one** confirmation): `/testpilot-requests`, which hands it to `testpilot-request-discover`.
- A **discover that may click and fill in forms** (made-up data, an address that is not production, you log in yourself, a log of every action, **one** confirmation): `/testpilot-requests`, which hands it to `testpilot-request-discover` in write mode when the request says *Act on the target* and the profile says `permissionMode: full`.
- A **re-run**, a **Playwright report**, or a **discover** that should end as an audit with evidence and an audit package (the full audit): the skills.
- A **run request** that follows test cases by hand, or discover findings handed in one by one: either path. The skill stops and asks at each step; the MCP path is shorter.
- If you want the agent to stop and ask you at every step: the full audit (`/testpilot`), which keeps all its stops.

## What is the same

Whichever path the agent takes, everything it hands in stays a proposal or a result that a person reviews, the token opens the same few routes of one project and nothing else, and every step is in the audit log as `agent_request.*`. Revoke the token when the work is done. What a session that uses the token can reach is in [What a session that uses the token can reach](agent-requests.md#what-a-session-that-uses-the-token-can-reach).
