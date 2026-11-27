# Ask an agent: set it up once

**Testbench starts nothing.** A request waits until an agent takes it, in your own environment ([agent-requests.md](agent-requests.md)). So the first time needs a one-time setup, in five steps. After it, **Request discover** in Testbench, then you open Claude Code in the agent's folder and ask for the next request. This page describes how it works today.

What you need: Testbench running with a project, an admin account (or no accounts at all), Claude Code, and a **checkout of the Testbench repository** to run the agent from (a clone or a `git worktree`). The skills (`.claude/skills/testpilot-*`) and the helper that sends the token live in that checkout, and the agent runs from the folder that holds `.testpilot/`. Run `npm install` there: the MCP server starts from it. To look at a page, the agent also uses the Playwright MCP (`@playwright/mcp`).

## 1. Make a request token

In Testbench: **Settings → Agent → Requests to a test agent → Create request token** (an admin). It is shown once and only its hash is stored. A project can have three active tokens. Revoke it on the same screen when the work is done.

## 2. Put it in `.env`, and nowhere else

In the agent's folder, in `.env` (it is in `.gitignore`), then `chmod 600 .env`:

```
TESTBENCH_URL=http://localhost:4100
TESTBENCH_PROJECT_ID=<the project's number>
TESTBENCH_TOKEN=tbrq_...                  # read by the MCP tools
TESTBENCH_REQUEST_TOKEN_<KEY>=tbrq_...    # read by the skills, named in the profile (step 4)
```

Use the same token in both lines. Keep it out of `.mcp.json`, out of git, and off the command line: `claude mcp add --env TESTBENCH_TOKEN=…` puts it in your shell history and in the process list.

## 3. `.mcp.json`, with no secret in it

```json
{
  "mcpServers": {
    "testbench": {
      "command": "bash",
      "args": ["-c", "cd /absolute/path/to/this/checkout && set -a && . ./.env && set +a && exec npm run --silent mcp"]
    },
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] }
  }
}
```

The first server reads its variables from `.env` itself, so the file holds no token. The three variables are described in [mcp/README.md](../mcp/README.md).

## 4. The profile

**You can skip this step for a discover request.** With no `.testpilot/testbench.json` at all, the helper of the skills uses `TESTBENCH_URL`, `TESTBENCH_PROJECT_ID` and `TESTBENCH_TOKEN` from the `.env` you made in step 2, and the agent works with the strictest defaults (read only). A re-run and a run request still need the profile below, and a profile that exists but cannot be read is an error.

`.testpilot/testbench.json`:

```json
{ "baseUrl": "http://localhost:4100", "activeProject": "<the key in lower case>" }
```

`.testpilot/projects/<the key in lower case>.json`:

```json
{
  "projectId": "<the project's number>",
  "projectKey": "<KEY>",
  "name": "<the project's name>",
  "requirementsSource": "black_box",
  "deliveryEnabled": false,
  "permissionMode": "observe_only",
  "requestTokenEnvVar": "TESTBENCH_REQUEST_TOKEN_<KEY>"
}
```

`permissionMode` decides what the agent may do to the target: `observe_only` (read only, the default) or `full` (state-changing checks, which needs your explicit confirmation in a message of its own). You edit the profile by hand (`testpilot/config/projects/shop.example.json` is a template), and so is `requestTokenEnvVar` ([testpilot/README.md](../testpilot/README.md), section 10).

## 5. Ask, and start the agent

1. In Testbench: **Automated tests → Requests → Request discover** (a name, the address, the environment and a note).
2. In the agent's folder: `claude --permission-mode default`, and run `/testpilot-requests`. It lists what is waiting, with each request's number and name, and lets you choose one. With the MCP tools instead of the skills, say: `Use testbench_get_next_request to fetch the next request from Testbench and work on it.` How the two paths differ: [agent-paths.md](agent-paths.md).
3. Answer what the agent asks in messages of your own: which request, the address, the environment, whether it is production, and then its one confirmation. Answer its other permission prompts with *allow once*, never "always allow". To let a discover run while you are away, write the fixed list in [Running a discover without sitting by](agent-requests.md#running-a-discover-without-sitting-by) once instead.
4. When it says it is done, review what came in as proposals in Testbench. Then revoke the token.

## Good to know

- **Nothing starts by itself.** The setup above stays; only the asking is one click.
- **The Read tool does not ask before it reads `.env`** in the normal permission mode (measured in [appendix D of the verification](agent-chain-verification.md)). The token is narrow and you revoke it at the end: see [What a session that uses the token can reach](agent-requests.md#what-a-session-that-uses-the-token-can-reach).
- **The skills and `.testpilot/` are read from the folder you start in**, so start from the agent's folder when you use the skills. A skill with no profile stops and asks you, except `/testpilot-requests` for a discover request.
- **Agent results are off by default.** A discover does not need them. A re-run and a run request do ([agent-requests.md](agent-requests.md)).
- **What the token can and cannot do:** [agent-requests.md](agent-requests.md#the-request-token). The two ways to work on a request: [agent-paths.md](agent-paths.md).
