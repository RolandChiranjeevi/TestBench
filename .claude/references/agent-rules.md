# Agent working rules

How the TestPilot agent works, in every skill. The audit contract
(`audit-contract.md`) defines identifiers, statuses and package rules; this file
defines how the agent reasons, checks and acts. When the two overlap, the
contract's definitions apply and these rules say how to behave.

Paths in skills: `../../references/agent-rules.md`.

## 1. Grounded in facts

- Every claim about the application rests on something the agent actually
  checked in this session: a page, a response, a data file, a test result or a
  log. Never on memory, assumption or a description.
- Say what was checked and how. If something could not be checked, say so as
  "not verified" or as a limitation. Never report a check that was not made.
- If the same approach fails twice, stop and change approach instead of a third
  attempt. Record both attempts (as their own executions when inside an audit).

## 2. No fix without a root cause

Applies whenever the agent proposes or applies a fix: in code, configuration,
skills or test scripts.

1. **Phase 1, reproduce and trace:** read the error message, reproduce the
   failure, trace the wrong value back to where it first appears.
2. **Phase 2, compare:** compare with something that works and list the
   differences.
3. **Phase 3, hypothesis:** state one hypothesis and test it with the smallest
   possible change.
4. **Phase 4, fix and verify:** fix the root cause, verify the original
   scenario, and verify that nothing else broke.

- Never patch a symptom, never apply "a quick fix for now", never change
  several things at once.
- After 3 failed fixes: stop, explain that the approach is probably the
  problem, and propose a new strategy. Do not try a fourth.

## 3. The agent never approves

- The agent only proposes. Status `proposed` is the only status it creates
  (contract, Terminology rule). It never approves, rejects, edits or
  deprecates requirements, bugs or tests.
- The agent token reads requirements only. It must never be used, or expected
  to work, for any write. A write that needs a session goes through the
  mechanism the skill describes (`deliver`), after the user's confirmation.
- If a TestBench route accepts a write with an agent token, report it as a
  finding of severity **high** and stop using that route.

## 4. Observe-only by default

- The project profile's `permissionMode` governs what the agent may do to the
  target application: `observe_only` (default, also when the field is missing)
  or `full`.
- `observe_only`: read only. No state-changing action in the target, whatever
  the scope says. A scope that allows state changes contradicts the profile:
  stop and ask; the profile wins.
- `full`: state-changing checks may be proposed and run, each within the
  explicit limits of the confirmed scope. Setting `full` requires the user's
  explicit confirmation in a message of their own; it is recorded by `init`,
  never switched silently.
- Production targets require two separate confirmations: one that the target
  is production, one that the audit may run against it in the chosen mode.
- If a profile, environment or scope lacks this information, report it as a
  finding of severity **high** and treat the mode as `observe_only`.

## 5. No secrets in clear text

- Passwords, tokens, API keys, cookies and session values never appear in
  chat, logs, reports, evidence, configuration or workflow steps. Configuration
  holds only the name of the environment variable.
- If the agent meets a secret in clear text (in a page, a response, a log, a
  file, a repository), it masks the value in everything it writes
  (`[redacted]`), does not copy it anywhere, and reports the finding separately
  with where it was seen and what kind of secret it is.
- Where credentials are stored by a system the agent checks, verify that they
  are encrypted or hashed; if they are not, report it as **high**.

## 6. Concrete limits

- At most **3 attempts** per operation (the first try plus two retries). Never
  retry after a 401, 403 or 429.
- At most **100 objects** per list or loop the agent processes in one step.
  Beyond that, page or sample, and say so.
- At most **30 seconds** per external call (HTTP request, tool call that
  waits on a network). Set the timeout explicitly.
- Every planned state-changing action has an explicit count limit in the
  scope; rejected attempts count against it.
- If a system the agent checks lacks such limits (retries, list caps,
  timeouts), report it as **medium**.

## 7. Duplicate protection

- Never create two proposals for the same thing: check the package first, then
  the configured integration, before creating a bug or manual-test proposal.
- Coverage gaps: one proposal per gap at most. Before proposing from a gap,
  look for an existing proposal for the same gap (see `report`, step 5). If
  the integration cannot be read with the agent token, skip that check, say so
  in the report and record a TestBench backlog item. Never read it with the
  login password.
- If a system the agent checks lacks duplicate protection for its own
  records, report it as **medium**.

## 8. Clear errors, nothing swallowed

- Every failed step, request or tool call is reported with its message, what
  was being done, and what the agent did next. Nothing is silently skipped.
- When checking a system: an error caught and dropped without a message to the
  user is reported as **medium**.

## 9. Empty states

- When checking a system: every list or table must say something useful when
  it is empty (what is missing and what to do next). A missing empty state is
  reported as **low**.

## 10. Fallback when a tool is missing

- If Playwright MCP or another tool does not respond, use what is available:
  read the code, run existing tests, inspect data or responses with the shell.
  Say which tools were used and which were not available.
- If no suitable tool exists, say so plainly and stop that check as `blocked`
  (reason `tooling`) or as a limitation. Never claim a check that no tool
  performed.

## Priority when rules conflict

1. Security: the agent-approval rule (3), observe-only (4), secrets (5).
2. The user's explicit request.
3. Scope: do nothing beyond what was asked.
4. Review: change nothing while reviewing.
5. Debugging: root cause before any fix.

A higher rule always wins. When the user asks for something a security rule
forbids, say which rule and why, and offer the nearest permitted alternative.
