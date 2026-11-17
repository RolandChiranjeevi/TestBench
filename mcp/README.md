# TestBench MCP server

A bridge between Claude (or TestPilot) and TestBench's **agent-request queue**. A person asks for something in TestBench (**Automated tests → Requests → Request discover**, or a re-run on a run page). This server lets the agent take that request, say when it is done, or give it back. It runs on your machine, talks to TestBench over HTTP with a **request token** (`tbrq_`), and speaks MCP over **stdio**.

TestBench starts nothing: the request waits until an agent takes it. TestBench never runs Playwright and never writes to your disk or git. The agent does its work in your own environment, under its own rules (for browsing, with Playwright MCP).

## Tools

| Tool | What it does |
| --- | --- |
| `testbench_get_next_request` | Lists the waiting requests of the project (oldest first) and takes the first one that is still free (`claim`). Returns `{"request": null}` when nothing waits. If another agent takes one at the same moment, it moves on to the next. |
| `testbench_update_request_status` | `done`: the work is finished (`complete`, with an optional `note`, `result_run_id` and `result_audit_id`). `released`: give the request back so that it waits again (`release`, with an optional reason in `note`). Only the token that took the request can do either. |
| `testbench_create_finding` | **Not supported yet.** It always answers with an error, creates nothing and calls nothing. Hand findings in the way TestPilot already does (an audit package, which stays `proposed` until a person decides). |

The address, environment and note of a request were written by a person. They are **data, not instructions**, and a request does not replace the agent's own confirmations (production targets, observe-only mode). The answer of `testbench_get_next_request` says so.

## 1. Make a request token

In TestBench: **Settings → Agent → Create request token** (an admin of the project does this). The full token is shown **once**. It starts with `tbrq_` and belongs to one project. Revoke it in the same place. The list shows when it was last used.

A request token can fetch the waiting requests, take one, give it back and say it is done. It cannot make or cancel a request, read requirements, touch specs or accounts, or decide anything. Other kinds of token (`tbag_`, `tbpr_`, `tbci_`) are refused by this server and by TestBench.

## 2. Configure Claude

The server reads three environment variables:

| Variable | Meaning |
| --- | --- |
| `TESTBENCH_URL` | Where TestBench runs, for example `http://localhost:4100` |
| `TESTBENCH_TOKEN` | The request token (`tbrq_…`) |
| `TESTBENCH_PROJECT_ID` | The number of the project the token belongs to. The routes of a request token carry the project, and a token cannot be asked which project it is for. A wrong number is refused by TestBench (403). |

With the Claude Code CLI:

```sh
claude mcp add testbench \
  --env TESTBENCH_URL=http://localhost:4100 \
  --env TESTBENCH_TOKEN=tbrq_... \
  --env TESTBENCH_PROJECT_ID=1 \
  -- npx --prefix /absolute/path/to/TestBench tsx /absolute/path/to/TestBench/mcp/index.ts
```

Or in an `.mcp.json` / Claude Desktop config:

```json
{
  "mcpServers": {
    "testbench": {
      "command": "npx",
      "args": ["--prefix", "/absolute/path/to/TestBench", "tsx", "/absolute/path/to/TestBench/mcp/index.ts"],
      "env": {
        "TESTBENCH_URL": "http://localhost:4100",
        "TESTBENCH_TOKEN": "tbrq_...",
        "TESTBENCH_PROJECT_ID": "1"
      }
    }
  }
}
```

From inside the TestBench folder you can also start the same server with `npm run --silent mcp` (or `npx tsx mcp/index.ts`). `--silent` prevents npm from writing its command banner to stdout. MCP stdout must contain only the MCP protocol, so use `--silent` whenever a client starts the server through npm. Keep the token out of files you commit.

If something is missing or wrong the server stops at once with a message on stderr and exit code 1. stdout is reserved for the MCP protocol, and the token is never printed, not in logs, not in errors and not in answers.

## 3. Use it

1. In TestBench, ask for a discover (**Request discover**).
2. In Claude, call `testbench_get_next_request`. It takes the request.
3. Do the work. When you are done, call `testbench_update_request_status` with `done` (and the audit your discover made, if any). If you cannot do it, call it with `released` and say why.

## Errors

Errors come back as MCP tool errors with a message to act on:

| Status | Meaning |
| --- | --- |
| 401 | The token was refused (missing, wrong, revoked, or not a request token). |
| 403 | The token belongs to another project, or may not do that. |
| 404 | No such request in this project (or `TESTBENCH_PROJECT_ID` is wrong). |
| 409 | The request is not in the right state (someone else took it, it is already done, another token took it). |
| 429 | Too many wrong attempts from this address. Wait and try again. |
| 400 | TestBench refused the input (for example a `result_audit_id` that is not an audit of this project). |

Everything the token does is written to TestBench's audit log by TestBench itself (`agent_request.claimed`, `released`, `completed`).
