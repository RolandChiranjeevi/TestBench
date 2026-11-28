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
D = ROOT / ".claude" / "skills" / "testpilot-request-discover"
SKILLS = {n: (D / "modes" / f"{m}.md").read_text() + "\n".join(p.read_text() for p in sorted((D / "checks").glob("*.md"))) for n, m in (("testpilot-request-discover", "read"), ("testpilot-request-discover-write", "write"))}  # the names are the two modes
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


class TheListIsNotAShortcut(unittest.TestCase):
    """Deep key 3 stopped after 14 actions and asked whether to do less, because the list of known posts made it think most of the work was done."""
    def test_the_reference_says_the_list_does_not_shorten_the_run_and_that_the_agent_never_asks_to_do_less(self):
        text = flat(REF)
        for must in ("The list is not a work list that gets shorter", "never skip, shorten or stop because most of it is already known", "never ask the user whether to do less",
                     "Finding a thing again is a result", "the one confirmation covered the whole run"):
            with self.subTest(must=must):
                self.assertIn(must, text)

    def test_both_skills_say_it_where_they_run_known(self):
        for name, text in SKILLS.items():
            step1 = flat(text[text.index("## 1. Read what there is"):text.index("## 2. The one confirmation")])
            with self.subTest(skill=name):
                self.assertRegex(step1, r"not(\*\*)? a reason to explore less")
                self.assertRegex(step1, r"whether to do less|you do the whole run")


class TheListDoesNotCountForTheStopRule(unittest.TestCase):
    """Deep key 5 stopped after 58 actions in 11 minutes: the stop rule counts actions in a row that find nothing new, and with a list of what TestBench holds, finding anything known looks like nothing."""
    def test_the_reference_and_the_write_skill_say_that_a_known_thing_found_again_is_found(self):
        self.assertIn("an action that finds something that is on the list has found it", flat(REF))
        self.assertIn("The list says what TestBench holds, not how far you have come", flat(REF))
        skill = flat(SKILLS["testpilot-request-discover-write"])
        for must in ("a new finding **in this run**", "a thing that is on the list from `known` counts as found", "finding it again is not \"nothing new\""):
            with self.subTest(must=must):
                self.assertIn(must, skill)


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
