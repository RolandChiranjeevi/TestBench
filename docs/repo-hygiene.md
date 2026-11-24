# Keeping the repository clean: Dependabot, code owners and the secret scan

This repository is public, so what is committed to it is public for good, in the history too. Three small things keep it in order. None of them reaches the app or an agent.

## Dependabot (`.github/dependabot.yml`)

Opens a pull request when a dependency has a newer version: `npm` and the GitHub Actions in `ci.yml`, **once a month**, grouped (all minor and patch updates of a month in one pull request, all actions in another), at most 5 open at a time. The first run after this was added is the biggest, because it catches up with everything that had piled up (14 npm updates and 3 actions in one pull request each); a major version of a package gets a pull request of its own. **Security updates** come in their own pull requests when an advisory is published (they follow the setting *Dependabot security updates*, not this file), so a month's wait does not hold a fix back. If it is still too much, `ignore` for major updates in this file, or a lower limit, are the next steps. The Python tools in `testpilot/` use only the standard library, so there is nothing to update there. CI runs on each of these pull requests like on any other, and nothing is merged by itself.

## Code owners (`.github/CODEOWNERS`)

Names the owner of the repository for every path, and again for the ones that decide what an agent may do or what holds a secret (`.claude/skills/`, `.claude/references/`, `testpilot/tools/`, `docs/agent-requests.md`, `.github/`, the secret scan). With one maintainer it asks for no review that nobody could give. It starts to matter when a second person is added and "Require review from Code Owners" is switched on for `main` (Settings, Branches).

## The secret scan (`scripts/secret-scan.mjs`)

Run by CI (the job `Secret scan`) and by hand, in every file that git tracks:

```bash
node scripts/secret-scan.mjs              # the working tree, as CI does
node scripts/secret-scan.mjs --history    # every line ever added in the history (a second or two), now and then
```

It looks for our own tokens (`tbrq_` request tokens, `tbag_` agent tokens), GitHub tokens, AWS access key ids, Anthropic and OpenAI style keys, Slack tokens, Google API keys and the body of a private key. It prints `file:line  rule  first-characters…`, **never the whole secret**, and exits with 1 when it finds something, which fails the build. It has no dependencies and sends nothing anywhere.

**A value that is obviously made up is not a finding**, so that the tests and the docs can show what a token looks like: a body with fewer than 6 different characters (`tbrq_aaaa…`), a body with a word such as `secret`, `example`, `fake`, `dummy`, `test`, `sample`, `placeholder` or `redacted`, or a run of 6 characters in a row in the alphabet or in the digits (`abcdef`, `123456`). A real token is random; the chance that one of those is in it is negligible. When a real-looking value is still fine, put `secret-scan: ignore` on the same line and say why next to it. A test that needs a real-looking value builds it while it runs, in pieces, so that no file holds it whole.

**If it finds a real one:** remove it, and **revoke it** in the place that issued it (a request token under Settings, Agent; a key at its provider). Removing it from the next commit is not enough, because it stays in the history.

**What it does not do.** It knows the formats above and nothing else: a password or a random string with no known prefix is not found, and it does not measure entropy. It is a net for the mistakes we can name, not a replacement for a scanner with a wide rule set.

### Also switch on GitHub's own scanning

This is two switches in the repository settings and nothing in the code: **Settings, Code security**: *Secret scanning* and *Push protection*. For a public repository GitHub then looks for the secrets of its partners (cloud providers, and so on) and can stop a push that holds one. It does not know our own `tbrq_` and `tbag_` formats unless a custom pattern is added; whether custom patterns are available for a public repository on a personal account is not checked here, and the scan above does not depend on it.

The history of this repository was scanned for the same patterns when this was added (`--history`): nothing real was found. The only matches were made-up test values in `test/ci-ingest.test.ts`, which the rule for made-up values lets through.
