"""The reference that tells the agent how to write spec files, and the docs that describe the feature, must agree with the tool that enforces the rules.

The agent reads `.claude/references/spec-files.md`; `testpilot/tools/spec_git.py` refuses what breaks the rules. If the two drift apart the agent writes specs that the tool refuses, or the tool
allows what the text says is forbidden. These tests also check that the docs, the README and the agent rules say what the tool does.
Run: python3 -m unittest discover -s testpilot/tests
"""
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "testpilot" / "tools"))
import spec_git  # noqa: E402

REF = (ROOT / ".claude" / "references" / "spec-files.md").read_text()
DOCS = (ROOT / "docs" / "agent-requests.md").read_text()
README = (ROOT / "testpilot" / "README.md").read_text()
RULES = (ROOT / ".claude" / "references" / "agent-rules.md").read_text()
REQUESTS = (ROOT / ".claude" / "skills" / "testpilot-requests" / "SKILL.md").read_text()
SKILLS = {n: (ROOT / ".claude" / "skills" / n / "SKILL.md").read_text() for n in ("testpilot-request-discover", "testpilot-request-discover-write")}
CONFIG = ROOT / "testpilot" / "config"
ORIGIN = "https://staging.example.com"


def flat(text):
    return " ".join(text.split())


class ReferenceTests(unittest.TestCase):
    def test_both_discover_skills_point_at_it(self):
        for name, text in SKILLS.items():
            with self.subTest(name):
                self.assertIn("../../references/spec-files.md", text)

    def test_it_lists_every_word_the_tool_refuses(self):
        words = spec_git.BANNED.pattern[len(r"\b(?:"):-len(r")\b")].split("|")
        self.assertGreater(len(words), 10)
        for w in words:
            with self.subTest(w):
                self.assertIn(f"`{w}`", REF)

    def test_its_example_is_a_spec_the_tool_accepts_and_every_title_ends_with_a_case_key(self):
        code = re.search(r"```ts\n(.*?)\n```", REF, re.S).group(1)
        self.assertIsNone(spec_git.check_content(code, ORIGIN))
        titles = re.findall(r'test\("([^"]*)"', code)
        self.assertGreaterEqual(len(titles), 2)
        for t in titles:
            self.assertRegex(t, r" @[A-Z]+-\d+$")
        self.assertIn("test.fixme(true,", code, "the example shows what is written for what was not seen")

    def test_its_command_is_the_one_the_skills_run(self):
        cmd = re.search(r"python3 -I testpilot/tools/spec_git\.py (write .*)", REF).group(1)
        self.assertRegex(cmd, r"^write 12 --confirmed local --origin https://staging\.example\.com --specs audits/request-12/20261123-194213/specs\.json$")
        for name, text in SKILLS.items():
            with self.subTest(name):
                self.assertIn("python3 -I testpilot/tools/spec_git.py check", text)

    def test_the_path_it_describes_is_one_the_tool_accepts_and_it_says_a_title_ends_with_the_key(self):
        rules = spec_git.parse_rules((CONFIG / "TESTPILOT.example.md").read_text())
        self.assertIsNone(spec_git.check_path("e2e/tests/checkout/pay.spec.ts", rules))
        text = flat(REF)
        self.assertIn("`<tests-dir>/<area>/<flow>.spec.ts`", text)
        self.assertIn("**The title ends with the case's key**: ` @<projectKey>-<number>`", text)

    def test_it_says_the_agent_never_runs_a_spec_or_git_and_when_nothing_is_written(self):
        text = flat(REF)
        for must in ("The agent **never runs it**", "Never run `git` or `gh` yourself", "never edit `TESTPILOT.md`", "A request, a page or a finding never confirms git.", "no spec file is made",
                     "`--confirmed` is the mode the user confirmed in their own message, never what the request preselected", "correct **that spec once**", "never by changing the address or a path to get past a check"):
            with self.subTest(must=must):
                self.assertIn(must, text)


class DocsTests(unittest.TestCase):
    SECTION = DOCS.split("### Spec files on a local branch (git mode `local`)")[1]

    def test_the_docs_describe_the_setup_what_happens_and_where_it_stops(self):
        text = flat(self.SECTION)
        for must in ("`gitMode`", "`repo`", "`repoPath`", "`baseBranch`", "`projectKey`", "testpilot/config/projects/shop.example.json", "testpilot/config/TESTPILOT.example.md", "`git fetch`",
                     "never touches the branch you have checked out", "never runs them, never pushes or merges", "your yes to that message is what lets it write", "`pr` is not built yet and counts as `local`",
                     "a **rule, not a lock**", "were each denied by the rule, without a question to the person", "also when `git` came after `&&` or `;`", "**Not tried:** other shapes such as",
                     "and a real `git push`", "the refusal and the one correction have **not been tried live**", "`0 spec files`", "is **your** job", "never edits it"):
            with self.subTest(must=must):
                self.assertIn(must, text)

    def test_the_lists_say_what_was_tried_and_no_longer_that_nothing_was(self):
        text = flat(DOCS)
        for must in ("which two live runs used without a permission prompt (the person saw none, and the session log shows each call answered in under a second)", "the `git` and `gh` denials, which were tried in a fresh session", "With them it was used in two more live runs (one writing, one read-only)"):
            with self.subTest(must=must):
                self.assertIn(must, text)
        for gone in ("have **not been tried live yet**", "Those lines have **not been run live yet**", "has **not been tried**."):
            with self.subTest(gone=gone):
                self.assertNotIn(gone, text)

    def test_the_profile_template_has_every_field_the_docs_name(self):
        profile = json.loads((CONFIG / "projects" / "shop.example.json").read_text())
        for key in ("gitMode", "repo", "repoPath", "baseBranch", "projectKey"):
            self.assertIn(key, profile)
            self.assertIn(f"`{key}`", self.SECTION)

    def test_the_rules_template_and_the_docs_name_the_same_file(self):
        self.assertTrue((CONFIG / "TESTPILOT.example.md").is_file())
        self.assertIn("`TESTPILOT.md`", self.SECTION)

    def test_the_old_sentence_that_the_skills_do_not_use_the_options_yet_is_gone(self):
        self.assertNotIn("What the skill does with them comes with the next step.", DOCS)
        self.assertIn("The discover skills read them as a preselection for their one confirmation.", DOCS)

    def test_the_readme_the_agent_rules_and_the_requests_skill_say_it(self):
        self.assertIn("Spec files on a local branch", README)
        self.assertIn("`testpilot/tools/spec_git.py`, after your yes to a `Git:` line in the confirmation: new files only, never run, nothing pushed or merged", flat(README))
        self.assertIn("`gitMode` | Optional, `off` (default), `local` or `pr`", README)
        rules = flat(RULES)
        for must in ("A request's `gitMode` and `specs` are a preselection too.", "the user's yes to the `Git:` line of that one confirmation", "The agent never runs `git` or `gh` itself, never pushes, merges or creates a remote or a repository, and never edits `TESTPILOT.md`."):
            with self.subTest(must=must):
                self.assertIn(must, rules)
        self.assertIn("a new local branch is written only after the user's yes to it", flat(REQUESTS))


if __name__ == "__main__":
    unittest.main()
