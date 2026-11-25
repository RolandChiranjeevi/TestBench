"""The manual for the person who owns the repository (docs/agent-git-setup.md) must agree with the tool that enforces the rules.

If the manual names a rule, a default, a message or a number that the tool does not have, a person follows it and is stopped by something it did not warn about. These tests tie every rule, default,
built-in path, git call and message in the manual to testpilot/tools/spec_git.py, and the links to and from it.
Run: python3 -m unittest discover -s testpilot/tests
"""
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
TOOLS = ROOT / "testpilot" / "tools"
CONFIG = ROOT / "testpilot" / "config"
sys.path.insert(0, str(TOOLS))
import spec_git  # noqa: E402

MANUAL = (ROOT / "docs" / "agent-git-setup.md").read_text()
TOOL_SRC = (TOOLS / "spec_git.py").read_text()
REQUESTS_DOC = (ROOT / "docs" / "agent-requests.md").read_text()
README = (ROOT / "testpilot" / "README.md").read_text()

MODE_OFF = (
    "the profile's gitMode is off", "The profile needs repo (owner/name) and repoPath", "repoPath is not the top folder of a git checkout", "the checkout has no GitHub origin, or no origin/", "was not found on origin/",
    "says base", "must name the same repository", "git mode is off (profile gitMode", "you confirmed git mode off", "is not a rule this tool knows (a typo?)", "is given twice", "is missing",
    "repo must be owner/name", "base is not a plain branch name", "mode-max must be off, local or pr", "branch-prefix must be one folder name ending in /", "must be a whole number above 0",
    "tests-dir must lie inside allowed-new-paths", "not a plain relative path", "must be a list like [e2e/]", "The TestPilot configuration could not be read", "gitMode in the project profile must be off, local or pr",
)
REFUSALS = (
    "is outside the tests folder", "must be <tests folder>/<area>/<flow>.spec.ts", "is not under allowed-new-paths", "is on the never-touch list", "already exists (only new files are written)", "is over max-lines",
    "must hold 1 to", "which a spec written by the agent may not", "names a web address other than the confirmed one", "holds a control, invisible or odd space character", "is not a Playwright spec",
    "would be written through a link", "git could not commit",
)


def flat(text):
    return " ".join(text.split())


class ManualTests(unittest.TestCase):
    def test_it_puts_the_responsibility_on_the_person_and_says_what_the_agent_never_does(self):
        text = flat(MANUAL)
        for must in ("**Keeping the repository correctly protected is your job.**", "The agent assumes it is, and never checks.", "never runs the specs, never pushes or merges, never creates a remote or a repository, never edits your rules file",
                     "never touches the branch you have checked out or your uncommitted changes", "no token, no network", "git branch -D testpilot/discover-<n>"):
            with self.subTest(must=must):
                self.assertIn(must, text)

    def test_every_rule_the_tool_knows_is_in_the_rules_table_with_the_defaults_the_tool_has(self):
        for key in spec_git.RULE_KEYS:
            with self.subTest(key):
                self.assertIn(f"| `{key}` |", MANUAL)
        rules = spec_git.parse_rules("repo: a/b\nbase: main\nmode-max: local\ntests-dir: e2e/tests\nallowed-new-paths: [e2e/]\n")
        for key, default in (("max-files", rules["max-files"]), ("max-lines", rules["max-lines"]), ("branch-prefix", rules["prefix"])):
            with self.subTest(default=key):
                self.assertRegex(MANUAL, rf"\| `{key}` \| [^|]+ \| `{re.escape(str(default))}` \|")

    def test_every_built_in_never_touch_path_is_named(self):
        for path in spec_git.ALWAYS_NEVER:
            with self.subTest(path):
                self.assertIn(f"`{path}`", MANUAL)

    def test_the_number_of_fixed_git_calls_is_right_and_each_is_named(self):
        self.assertEqual(len(spec_git.GIT_OK), 13)
        self.assertIn("**thirteen fixed git calls**", flat(MANUAL))
        for key in spec_git.GIT_OK:
            with self.subTest(key):
                self.assertIn(f"`{' '.join(key)}`", MANUAL)

    def test_every_reason_the_mode_is_off_is_a_message_the_tool_has(self):
        text = flat(MANUAL)
        for phrase in MODE_OFF:
            with self.subTest(phrase):
                self.assertIn(phrase, text, "the manual does not mention it")
                self.assertIn(phrase, TOOL_SRC, "the tool no longer says it")

    def test_every_refusal_in_the_manual_is_a_message_the_tool_has(self):
        text = flat(MANUAL)
        for phrase in REFUSALS:
            with self.subTest(phrase):
                self.assertIn(phrase, text, "the manual does not mention it")
                self.assertIn(phrase, TOOL_SRC, "the tool no longer says it")

    def test_the_profile_fields_exist_in_the_template_and_the_files_it_names_exist(self):
        profile = json.loads((CONFIG / "projects" / "shop.example.json").read_text())
        for field in ("gitMode", "repo", "repoPath", "baseBranch", "projectKey"):
            with self.subTest(field):
                self.assertIn(field, profile)
                self.assertIn(f"| `{field}` |", MANUAL)
        for path in ("testpilot/config/TESTPILOT.example.md", "testpilot/config/projects/shop.example.json", "testpilot/tools/spec_git.py"):
            with self.subTest(path):
                self.assertIn(path, MANUAL)
                self.assertTrue((ROOT / path).is_file())

    def test_the_command_the_person_runs_is_the_tools_check(self):
        self.assertIn("python3 -I testpilot/tools/spec_git.py check", MANUAL)
        self.assertIn("check", spec_git.ACTIONS)

    def test_the_ci_warning_is_there_and_honest_about_what_was_not_checked(self):
        text = flat(MANUAL)
        for must in ("**A spec is code that your CI will run.**", "**rule, not a lock**", "a CI that runs the agent's branch **without secrets**", "this guide has not been checked against a real repository",
                     "The specs have **not been run**"):
            with self.subTest(must=must):
                self.assertIn(must, text)

    def test_it_links_to_the_sections_it_needs_and_is_linked_from_where_a_person_looks(self):
        self.assertIn("(agent-requests.md#spec-files-on-a-local-branch-git-mode-local)", MANUAL)
        self.assertIn("### Spec files on a local branch (git mode `local`)", REQUESTS_DOC)
        self.assertIn("(agent-quickstart.md)", MANUAL)
        self.assertTrue((ROOT / "docs" / "agent-quickstart.md").is_file())
        self.assertIn("[agent-git-setup.md](agent-git-setup.md)", REQUESTS_DOC)
        self.assertNotIn("is planned.", REQUESTS_DOC.split("### Spec files on a local branch")[1])
        self.assertIn("`docs/agent-git-setup.md`", README)


if __name__ == "__main__":
    unittest.main()
