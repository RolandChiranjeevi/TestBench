---
name: testpilot-init
description: Select or create a TestBench project, determine the requirements source and save the TestPilot project configuration. Use when the user invokes /testpilot-init or asks to initialize a TestPilot project.
---

# TestPilot Init

Initialize the TestBench project context for TestPilot.

This workflow establishes:
- Project identity
- Requirements source
- Local TestBench configuration

It does not select a target URL or environment, inspect the application,
create a test plan or execute tests. Those activities belong to later workflows.

## References and paths

Paths to instruction files below are relative to this SKILL.md.

Before proceeding, read:
- `../testpilot/SKILL.md`
- `../../references/audit-contract.md`

Apply the shared boundaries, secret-handling rules and stop conditions.
Execute only this initialization workflow. Do not start the full audit.

Repository configuration paths are relative to the repository root, not this file.
Locate the actual configuration and integration code before changing anything.

## Scope and write permissions

This workflow may, after explicit user confirmation:
- Create a TestBench project through a verified supported interface
- Save or switch the local TestPilot project configuration

Project creation is a setup operation, not audit-package delivery.
It does not authorize creating bugs, manual tests, external tickets or imports.

If the shared instructions prohibit project creation or conflict with this
workflow, pause and request clarification. Do not bypass the restriction.

## Project profiles

TestPilot supports multiple TestBench projects.

Project-specific configuration is stored in:

`config/projects/<lowercase_project_key>.json`

The global configuration is:

`config/testbench.json`

It stores only shared settings and the active project selection.

Project-specific configuration stores:

- Project ID
- Project key
- Project name
- Requirements source
- Requirements path
- Token environment variable name
- Project-specific delivery setting

The active project is selected through `activeProject` in the global
configuration.

Do not duplicate project-specific fields in the global configuration.

## 1. Inspect the existing integration

Read the actual configuration and relevant integration code.

Verify:
- The configuration file location
- Supported configuration fields
- The configured TestBench base URL
- The environment variable named by `tokenEnvVar`
- How projects can be listed, read and created
- Authentication and required headers for each operation
- How requirements are fetched

Do not invent endpoints, payload fields or authentication mechanisms.

Do not assume an agent Bearer token permits project creation.
If a write operation requires a session, follow the verified login mechanism.

Read secrets only through the supported environment/configuration mechanism.
Never ask the user to paste secrets into chat or expose them in output.

If the configuration is missing, ask for the missing non-secret connection
details. A missing projectId is expected during first-time initialization.

If a required interface does not exist:
- Explain the limitation
- Record a TestBench backlog item locally
- Offer manual setup through a verified UI, if available
- Do not claim the operation succeeded

Do not implement missing TestBench features during this workflow.

## 2. Select or create a project

Present these choices:

1. Use an existing TestBench project
2. Create a new TestBench project
3. Cancel

If project listing is supported, show actual accessible projects.
Display only information returned by the integration.

For an existing project:
- Let the user select the project
- Verify access
- Read its actual ID, key and name
- Do not request replacement project details

For a new project, ask for:
- Project name
- Project key
- Description, optional

Do not guess or silently generate a project key.
Validate values against the actual TestBench constraints.

Do not ask for target URL or environment.

## 3. Determine the requirements source

Ask:

"Do you have existing requirements for this project?"

If yes, ask where they are:
1. Already in the selected TestBench project
2. In a CSV or Excel file
3. In another system or document
4. I will provide them later

If no, explain that planning can use black-box context without existing
TestBench requirement IDs, subject to the audit contract.

For a newly created project, do not imply it already contains requirements.
If requirements are in another TestBench project, clarify which project
should be used. Do not silently copy requirements.

### Already in TestBench

Fetch requirements through the verified interface.

If none are returned, offer:
- Import requirements from CSV or Excel
- Defer requirements
- Explicitly choose black-box planning

Do not silently switch to black-box mode.

### CSV or Excel

Mention that requirements can be imported into TestBench if the installed
version supports the relevant format.

Check the actual implementation before offering an import action or command.

If import is supported:
- Explain the supported route
- Offer import after project setup
- Keep import separate from project creation
- Require preview and separate confirmation before writing requirements

If import is not implemented:
- Clearly say so
- Record the need as a local TestBench backlog item
- Offer to defer or explicitly use black-box planning

Do not advertise an unavailable `/testpilot-import-requirements` command.

### Another source

Ask for a non-secret description of the source.
Record whether requirements still need to be supplied or imported.

Do not claim an integration exists unless verified.

### Requirements deferred

Record the pending decision.
Before planning, require the user to provide requirements or explicitly
approve black-box planning.

## 4. Confirm project creation

For a new project, show:

- Project name
- Project key
- Description
- Requirements source
- Any pending requirements/import action

Ask:

"Create this TestBench project with these details?"

Wait for explicit confirmation.
Accept clear confirmation in the user's language.

If details change, show the revised summary and request confirmation again.

For an existing project, skip creation and continue to configuration review.

## 5. Create or verify the project

Create the confirmed project only through the verified supported interface.

Use the actual ID and key returned by TestBench.
If needed, fetch the created project to verify them.

If creation times out or returns an ambiguous response:
- Do not blindly repeat the create request
- Check whether the project was created
- If the outcome remains unknown, pause and explain

If a project key already exists, offer to select that project or change the key.
Do not overwrite it.

If project creation succeeds but later setup fails, preserve the project and
report its identity. Do not automatically delete it or create another one.

### Verify project access

After selecting or creating a project, verify that the configured agent token
can read that project.

If access fails:
- Do not save the project as fully initialized
- Explain that the current token does not cover the selected project
- Offer one of the following:
  1. Create a new agent token, if the integration supports it
  2. Ask the user to create a token in the TestBench UI
  3. Cancel initialization without changing the active project configuration

Never claim initialization is complete if the selected project cannot be read
with the configured token.

### Token handling

Agent tokens may be project-specific.

Do not assume that an existing token works for a newly created project.

If a new token is required:
- Use a project-specific environment variable name
- Derive it from the project key when appropriate, for example:
  `TESTBENCH_API_TOKEN_<PROJECT_KEY>`
- Store only the variable name in the project profile
- Never store the token value in configuration, chat, logs, reports or packages
- If token creation is supported by the integration, require explicit user
  confirmation before creating one
- If token creation is not supported, provide exact UI instructions and stop
  before saving an unusable configuration

If the existing token already works for the selected project, retain its
existing environment variable name.

## 6. Review and save local configuration

TestPilot supports multiple TestBench projects.

Project-specific configuration is stored in:

`config/projects/<lowercase_project_key>.json`

The global configuration is:

`config/testbench.json`

It stores only shared settings and the active project selection.

### Project profile

For the selected project, create or update:

`config/projects/<lowercase_project_key>.json`

Use the lowercase version of the verified project key as the file name.

Example: for project key `TS`, use:

`config/projects/ts.json`

The project profile must contain:

```json
{
  "projectId": "<verified_project_id>",
  "projectKey": "<verified_project_key>",
  "name": "<project_name>",
  "requirementsSource": "<requirements_source>",
  "requirementsPath": "<verified_requirements_path>",
  "tokenEnvVar": "<verified_token_env_var_name>",
  "deliveryEnabled": false
}
```

Rules:

- Use the project ID returned by TestBench.
- Use the project key returned by TestBench.
- Rebuild `requirementsPath` from the returned project ID.
- Set `requirementsSource` explicitly.
- Use `black_box` when no TestBench requirements are available.
- Use `testbench` only after requirements have been verified as available.
- Use `import_pending` when requirements exist but have not yet been imported.
- Use `pending` when the user will provide requirements later.
- Set `deliveryEnabled` to `false` unless the user explicitly enables delivery.
- Do not store target URL, environment, token value, password or cookie.

### Global configuration

Update only these fields in `config/testbench.json`:

```json
{
  "baseUrl": "<existing_base_url>",
  "activeProject": "<lowercase_project_key>"
}
```

Do not duplicate project-specific fields in the global configuration.

Do not add `projectId`, `projectKey`, `requirementsPath` or `tokenEnvVar`
to `testbench.json`.

### Confirmation

Before writing either file, show the proposed non-secret changes:

```text
Project profile:
<project profile JSON>

Global configuration:
<global configuration JSON>

Save these changes?
```

Wait for explicit confirmation.

If the user changes a value, show the revised summary and request confirmation
again.

### Safe write behavior

Before writing:

1. Read the existing file.
2. Build a complete, valid replacement object.
3. Do not append duplicate fields.
4. Write the file.
5. Read it back.
6. Validate that it parses as JSON.
7. Validate that no field occurs more than once.
8. Validate that the active project matches an existing project profile.

If validation fails, do not mark initialization as complete.

### Token validation

Before marking initialization complete, verify that the environment variable
named by `tokenEnvVar` is available.

Do not store the token value in either configuration file.

If the token is missing or cannot read the selected project, pause and explain
the required next action.

## 7. Finish

Report:
- Project name
- Project key
- Project ID
- Requirements source and whether requirements were verified
- Pending import or setup actions
- Whether local configuration was saved

If project setup succeeded but requirements are pending, distinguish those
facts. Do not describe requirements as ready.

Suggest:

`/testpilot-discover`

Explain that discover selects the target URL and environment.

Do not run discover or any import automatically.

## Completion checklist

- [ ] Project identity was verified against TestBench
- [ ] No project IDs, keys, counts or interfaces were invented
- [ ] Project creation had explicit confirmation, if applicable
- [ ] Configuration changes had explicit confirmation
- [ ] Requirements availability was verified or clearly marked pending
- [ ] CSV/Excel import was mentioned when relevant
- [ ] Unsupported import features were not presented as available
- [ ] Unrelated configuration and delivery settings were preserved
- [ ] No target URL or environment was selected
- [ ] No secrets were exposed
- [ ] No audit execution, package delivery or external ticket creation occurred