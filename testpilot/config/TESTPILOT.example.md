# Rules for the TestPilot agent in this repository.
#
# You own this file. Put it in the root of your base branch (usually main) and commit it there yourself.
# The agent reads it from origin/<base> as you last fetched it, never from its own branch, and never edits it.
# Only "key: value" lines and # comments are read. An unknown or repeated key is an error, so a typo cannot drop a protection.
# Keeping the repository correctly protected (protected main, a narrow token, CI without secrets) is your job. The agent assumes it is and never checks.

repo: owner/name              # the project profile, this file and the checkout's origin must name the same repository
base: main                    # the branch the agent branches from
mode-max: local               # the highest git mode you allow: off | local | pr (pr also pushes the branch and opens a pull request: it needs protection-confirmed below)
branch-prefix: testpilot/     # the agent's branch is <prefix>discover-<request number>
tests-dir: e2e/tests          # specs go to <tests-dir>/<area>/<flow>.spec.ts, as new files only
allowed-new-paths: [e2e/]     # new files may only be made under these folders
never-touch: [e2e/support/]   # on top of the built-in list: .git, .github, TESTPILOT.md, package.json, package-lock.json, playwright.config.ts and .js
max-files: 40                 # most spec files in one branch
max-lines: 3000               # most lines in all of them together
logged-in: no                # yes if YOUR playwright.config.ts starts every spec outside <tests-dir>/login already signed in (a setup project, storageState); the agent then writes real tests behind the login, with no credential
# protection-confirmed: 2026-11-25   # remove the # when YOUR base branch is protected (a pull request is required before anything reaches it): your word, with the date. Only then can `pr` push. The agent checks that the line is there, never that it is true.
