# Set up a repository for the test agent

This is for the person who owns the repository. It covers the one git mode that exists, `local`: after your yes, a discover can leave **Playwright spec files on a new local branch** of your own checkout. The
branch is a proposal for you to review. The agent never runs the specs, never pushes or merges, never creates a remote or a repository, never edits your rules file, and never touches the branch you have checked
out or your uncommitted changes. In this mode it has no access to GitHub at all: no token, no network.

**Keeping the repository correctly protected is your job.** The agent assumes it is, and never checks. Protect your base branch (require a pull request before anything reaches it), and read what the agent wrote
before you push it. If something goes wrong because a protection was missing, that is not the agent's doing.

How a request asks for this, and what the agent shows you, is in [agent-requests.md](agent-requests.md#spec-files-on-a-local-branch-git-mode-local). The one-time setup of the agent itself is in
[agent-quickstart.md](agent-quickstart.md). This page is only about the repository.

## What you need

- A **checkout** of the repository that holds (or will hold) the Playwright tests, with `origin` pointing at GitHub: `https://github.com/<owner>/<name>` or `git@github.com:<owner>/<name>.git`. The tool
  recognises only GitHub addresses, and never shows the address, because it may hold a token.
- Git, with `user.name` and `user.email` set. The commit on the agent's branch is made with **your** identity.
- The agent's folder, set up as in the quickstart.

## 1. The rules file: `TESTPILOT.md`

Put it in the root of your **base branch** (usually `main`) and commit it yourself. The agent reads it from `origin/<base>` **as you last fetched it**, never from your working folder and never from its own branch,
and it never edits it. It must be under 20 kB. A template is `testpilot/config/TESTPILOT.example.md`. After you push it, run `git fetch origin` in your checkout: the agent only sees what you have fetched.

The file is `key: value` lines, `#` comments, and lists as `[a, b]`. An unknown or repeated key is an error, so a typo cannot silently drop a protection. Paths are plain relative paths: no `..`, no glob, nothing
that would cover the whole repository.

| Rule | Meaning | Default |
|---|---|---|
| `repo` | `owner/name`. The profile, this file and `origin` must name the same repository | required |
| `base` | The branch the agent branches from | required |
| `mode-max` | The highest git mode you allow: `off`, `local` or `pr`. `pr` does not exist yet and counts as `local` | required |
| `branch-prefix` | The agent's branch is `<prefix>discover-<request number>` | `testpilot/` |
| `tests-dir` | Specs go to `<tests-dir>/<area>/<flow>.spec.ts`, as new files only | required |
| `allowed-new-paths` | A list. New files may only be made under these folders, and `tests-dir` must lie inside one | required |
| `never-touch` | A list of paths that are never written, on top of the built-in ones below | none |
| `max-files` | Most spec files in one branch | `40` |
| `max-lines` | Most lines in all of them together, counted as git counts them | `3000` |
| `logged-in` | `yes` or `no`. `yes` is your word that your own `playwright.config.ts` starts every spec outside `<tests-dir>/login/` already signed in (a setup project that saves the session, `storageState`) and every spec inside `login/` signed out. The agent then writes real tests behind the login, and still never types or holds a credential. The login code lives in files you wrote, under a path in `never-touch` | `no` |

**Built in, whatever the file says:** `.git`, `.github`, `TESTPILOT.md`, `package.json`, `package-lock.json`, `playwright.config.ts` and `playwright.config.js` are never written, and no path may have a part that
starts with a dot. Only **new** files are made: a name that already exists on the base branch is refused, also when only the letters differ in case.

## 2. The profile: where your checkout is

In `.testpilot/projects/<key>.json` of the agent's folder (a template is `testpilot/config/projects/shop.example.json`). These live only in the agent's folder: a request can never set them.

| Field | Meaning |
|---|---|
| `gitMode` | `off` (the default), `local` or `pr`. The mode that counts is the **lowest** of this, `mode-max` in `TESTPILOT.md` and what you confirm in the agent's message |
| `repo` | `owner/name` |
| `repoPath` | The absolute path of the **top folder** of your checkout |
| `baseBranch` | The base branch. Default `main`. `TESTPILOT.md` must say the same |
| `projectKey` | The key of the project in Testbench. Each spec's title ends with `@<projectKey>-<number>`, which is how a result that is imported later is linked to its case |

## 3. What the agent may run

Use one of the permission lists in [agent-requests.md](agent-requests.md) (they allow `spec_git.py check` and `write`, and **deny** `git` and `gh`). The agent never runs git itself. The tool,
`testpilot/tools/spec_git.py`, makes **ten fixed git calls** (`rev-parse`, `show`, `ls-tree`, `remote get-url`, `worktree add`, `worktree remove`, `worktree prune`, `add`, `commit` and `update-ref`), with hooks
off, no `GIT_*` variables from the environment and no network. It never fetches, pushes, merges, creates a remote or a repository, or changes your branches. What was tried live, and what was not, is under
"Spec files on a local branch" in [agent-requests.md](agent-requests.md).

## 4. Check it yourself before the first run

You run this, not the agent, from the agent's folder:

```bash
python3 -I testpilot/tools/spec_git.py check
```

It prints the repository, `ceiling: local`, the checkout folder, the tests folder, the branch name and the limits. If it prints `mode: off`, it says why: see section 7.

## 5. A run

In the dialog, ask for **Commit on a local branch** and tick **Spec files**. That is only a preselection: the agent's one confirmation has a `Git:` line, and **your yes to that message** is what lets it write.
After the findings are handed in, the agent writes `specs.json` in the folder of that claim (`audits/request-<n>/<time>/`) and calls `spec_git.py write`. The tool cuts a temporary worktree from `origin/<base>`, writes the new files there, checks
them, commits, and creates the branch **last**, so a refusal leaves nothing behind. The temporary worktree is removed. Your checkout is not touched.

## 6. Review the branch, then push it yourself

```bash
git log -1 --stat testpilot/discover-<n>
git diff <base> testpilot/discover-<n>
```

Look for: one commit on top of `origin/<base>` with only new `<area>/<flow>.spec.ts` files; titles that end with `@<projectKey>-<number>`; `test.fixme` where the agent had not seen what a step does; only your
address; no secrets. The specs have **not been run**: run them yourself. To keep them, push the branch and open a pull request yourself, review it and merge it yourself. To drop them,
`git branch -D testpilot/discover-<n>` (`-D`, because the branch is not merged).

**A spec is code that your CI will run.** The tool's check of a spec's text (only `@playwright/test` as an import, no `eval`, `fetch`, `process` and so on, only the confirmed address, no invisible characters)
is a **rule, not a lock**: someone who tries can get round a text check. The locks are your review and a CI that runs the agent's branch **without secrets**. Workflows that run on a push to a branch of your own
repository can normally read the repository's secrets, so keep them out of reach of that branch (for example environment secrets limited to protected branches, or with required reviewers). Check GitHub's own
documentation for the current rules: this guide has not been checked against a real repository.

## 7. Why the mode is off

`check` and `write` print `mode: off` and a `reason:`. Nothing was written. What to do:

| The reason says | What to do |
|---|---|
| `the profile's gitMode is off` | Set `gitMode` to `local` in the profile |
| `The profile needs repo (owner/name) and repoPath` | Add the missing fields (and `baseBranch` if it is not `main`) |
| `repoPath is not the top folder of a git checkout` | Use the absolute path of the **top** folder, not a subfolder |
| `the checkout has no GitHub origin, or no origin/…` | Point `origin` at a GitHub address and run `git fetch origin` |
| `TESTPILOT.md was not found on origin/…` | Commit it to the base branch, push, and `git fetch origin`. It must be under 20 kB |
| `TESTPILOT.md says base … but the profile says …` | Make `base` and `baseBranch` the same |
| `… must name the same repository` | Make `repo` in the profile, `repo` in `TESTPILOT.md` and the `origin` address name one repository |
| `git mode is off (profile gitMode …, TESTPILOT.md mode-max …)` | The lowest wins: raise `gitMode` or `mode-max` |
| `you confirmed git mode off` | You answered off in the agent's confirmation |
| `TESTPILOT.md: …` with `is not a rule this tool knows (a typo?)`, `is given twice`, `is missing`, `repo must be owner/name`, `base is not a plain branch name`, `mode-max must be off, local or pr`, `branch-prefix must be one folder name ending in /`, `must be a whole number above 0`, `tests-dir must lie inside allowed-new-paths`, `not a plain relative path` or `must be a list like [e2e/]` | Correct that rule in `TESTPILOT.md`, push, and `git fetch origin` |

Two problems are **not** `mode: off` but an error: `The TestPilot configuration could not be read` (run it from the agent's folder, and check `.testpilot/testbench.json` and the profile it names) and
`gitMode in the project profile must be off, local or pr`.

## 8. When the tool refuses a spec

Nothing is written if even one spec is refused. The agent corrects the refused spec **once**; after a second refusal no spec file is made, and the request still finishes with `0 spec files`.

| The refusal says | Meaning |
|---|---|
| `is outside the tests folder`, `must be <tests folder>/<area>/<flow>.spec.ts`, `is not under allowed-new-paths` | The path does not fit your rules |
| `is on the never-touch list` | The path is protected, by you or by the built-in list |
| `already exists (only new files are written)` | A file of that name is already on the base branch, or twice in the set |
| `is over max-lines` or `must hold 1 to` | The set is over your limits |
| `uses … which a spec written by the agent may not`, `names a web address other than the confirmed one`, `holds a control, invisible or odd space character`, `is not a Playwright spec` | The text of a spec broke a rule |
| `would be written through a link` | A folder on the way is a symbolic link |
| `the branch … already exists` | That request already has a branch: delete it, or ask again |
| `git could not commit` | Set `user.name` and `user.email` in your checkout |
