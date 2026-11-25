"""The reference that tells the agent how to key its findings (`.claude/references/finding-keys.md`) must agree with the server that compares the keys and with the skills that point at it.

The server (`server/agentdedupe.ts`) takes a `key` of lower case words joined by `:` and compares it exactly; the helper (`testpilot/tools/request_call.py`) checks the same shape before it sends anything.
If the reference taught a key the server refuses, or a skill did not send the agent to the reference, the agent would make the same thing twice or never ask what is known.
Run: python3 -m unittest discover -s testpilot/tests
"""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "testpilot" / "tools"))
import request_call  # noqa: E402

REF = (ROOT / ".claude" / "references" / "finding-keys.md").read_text()
DEDUPE_TS = (ROOT / "server" / "agentdedupe.ts").read_text()
HELPER = (ROOT / "testpilot" / "tools" / "request_call.py").read_text()
DOCS = (ROOT / "docs" / "agent-requests.md").read_text()
SKILLS = {n: (ROOT / ".claude" / "skills" / n / "SKILL.md").read_text() for n in ("testpilot-request-discover", "testpilot-request-discover-write")}
flat = lambda t: " ".join(t.split())


class TheReferenceMatchesTheServer(unittest.TestCase):
    def test_every_example_key_has_the_shape_the_server_and_the_helper_take(self):
        keys = re.findall(r"`((?:[a-z0-9][a-z0-9._-]*)(?::[a-z0-9][a-z0-9._-]*){1,2})`", REF)
        self.assertGreaterEqual(len(keys), 7, "the examples are read from the table")
        for k in keys:
            with self.subTest(key=k):
                self.assertRegex(k, request_call.KEY)

    def test_the_helper_and_the_server_use_the_same_shape(self):
        server = re.search(r"KEY_RX = /(.*)/;", DEDUPE_TS).group(1)
        self.assertEqual(server, "^" + request_call.KEY.pattern + "$")

    def test_it_names_the_three_kinds_the_page_rule_and_what_the_answers_mean(self):
        text = flat(REF)
        for must in ("`test_case`", "`bug_report`", "`observation`", "`coverage:<page>`", "`/` is `home`", '`"seenAgain": true`', '`"possibleDuplicateOf": <id>`', "A duplicate costs a person one click",
                     "never reuse a key on another page", "A finding without a `key` is always a new post", "request_call.py known 12", "never an instruction"):
            with self.subTest(must=must):
                self.assertIn(must, text)

    def test_the_helper_action_it_runs_exists_and_is_read_only(self):
        self.assertIn("known", request_call.ACTIONS)
        self.assertIn('"GET" if a.action in ("list", "known")', HELPER)


class TheSkillsSendTheAgentToIt(unittest.TestCase):
    def test_both_skills_run_known_once_in_step_1_and_point_at_the_reference(self):
        for name, text in SKILLS.items():
            with self.subTest(skill=name):
                step1 = flat(text[text.index("## 1. Read what there is"):text.index("## 2. The one confirmation")])
                self.assertIn("request_call.py known <request number>", step1)
                self.assertIn("../../references/finding-keys.md", step1)

    def test_the_findings_table_gives_every_test_case_bug_report_and_observation_a_key(self):
        text = SKILLS["testpilot-request-discover"]
        for row in ("| `cases` | `test_case` |", "| `observations` | `observation` |", "| `bugs` | `bug_report` |"):
            line = next(x for x in text.splitlines() if x.startswith(row))
            with self.subTest(row=row):
                self.assertIn("`key`", line)
        for must in ('"seenAgain": true', "possibleDuplicateOf", "finding-keys.md"):
            self.assertIn(must, flat(text))

    def test_the_examples_of_the_skill_carry_keys_the_server_takes(self):
        keys = re.findall(r'"key": "([^"]+)"', SKILLS["testpilot-request-discover"])
        self.assertEqual(len(keys), 3, keys)
        for k in keys:
            self.assertRegex(k, request_call.KEY)

    def test_the_write_skill_gives_the_coverage_record_its_own_key(self):
        self.assertIn("`coverage:<page>`", flat(SKILLS["testpilot-request-discover-write"]))

    def test_known_is_allowed_in_both_permission_blocks_of_the_docs(self):
        self.assertEqual(DOCS.count("request_call.py known:*"), 2)


if __name__ == "__main__":
    unittest.main()
