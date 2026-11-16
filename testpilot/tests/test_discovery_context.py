"""The discovery context: the file `/testpilot-discover` writes and `/testpilot-run` reads (audits/discovery-context.json).

It used to exist only as a phrase: `run` said "read the discovery context produced by discover", but `discover` wrote nothing, so the two confirmations for a production
target had nowhere to be recorded. The skills are instructions for an agent, so their behaviour cannot be tested here. What can be tested is the contract between them:
that they name the same file, that the example `discover` gives holds every field `run` requires and nothing that looks like a secret, and that the file is written only
after the user has approved the scope.
Run: python3 -m unittest discover -s testpilot/tests
"""
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "testpilot" / "tools"))
from apitest.redact import find_literal_secrets  # noqa: E402

PATH = "audits/discovery-context.json"
SKILLS = ROOT / ".claude" / "skills"
DISCOVER = (SKILLS / "testpilot-discover" / "SKILL.md").read_text()
PLAN = (SKILLS / "testpilot-plan" / "SKILL.md").read_text()
RUN = (SKILLS / "testpilot-run" / "SKILL.md").read_text()
ORCHESTRATOR = (SKILLS / "testpilot" / "SKILL.md").read_text()
README = (ROOT / "testpilot" / "README.md").read_text()


def section(text, title):
    m = re.search(r"^## " + re.escape(title) + r"\n(.*?)(?=^## |\Z)", text, re.S | re.M)
    assert m, f"no section called {title!r}"
    return m.group(1)


STEP7 = section(DISCOVER, "7. Write the discovery context")
EXAMPLE = json.loads(re.search(r"```json\n(.*?)\n```", STEP7, re.S).group(1))
# what `run` step 2 lists, in its own words, and the field that holds each
REQUIRED = {
    "target URL": "target_url",
    "environment": "environment",
    "confirmed scope": "confirmed_scope",
    "allowed check types": "allowed_check_types",
    "viewports": "viewports",
    "state-changing action limits": "state_changes",
}


class ContractTests(unittest.TestCase):
    def test_every_skill_and_the_readme_name_the_same_file(self):
        for name, text in {"discover": DISCOVER, "plan": PLAN, "run": RUN, "testpilot": ORCHESTRATOR, "README": README}.items():
            with self.subTest(name):
                self.assertIn(PATH, text)
                self.assertEqual(set(re.findall(r"audits/discovery[\w.-]*", text)), {PATH}, "no other name for it")

    def test_run_requires_exactly_the_fields_the_example_has_a_place_for(self):
        listed = section(RUN, "2. Read the discovery context")
        for phrase, field in REQUIRED.items():
            with self.subTest(phrase):
                self.assertIn(f"- {phrase}", listed, "run lists it")
                self.assertIn(field, EXAMPLE, "and the example in discover holds it")
        wanted = re.search(r"It must contain:\n((?:- .*\n)+)", listed).group(1).strip().splitlines()
        self.assertEqual(sorted(l[2:] for l in wanted), sorted(REQUIRED), "run does not ask for anything the table above does not map")

    def test_the_example_is_complete_and_valid(self):
        self.assertEqual(set(EXAMPLE), {"version", "written_at", "source", "target_url", "environment", "permission_mode", "production", "confirmed_scope",
                                        "allowed_check_types", "viewports", "state_changes"})
        self.assertEqual(EXAMPLE["version"], 1)
        self.assertRegex(EXAMPLE["written_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$", "UTC, ISO 8601")
        self.assertIn(EXAMPLE["permission_mode"], ("observe_only", "full"))
        self.assertIsNone(EXAMPLE["production"])
        self.assertEqual(set(EXAMPLE["confirmed_scope"]), {"in_scope", "out_of_scope"})
        self.assertEqual(set(EXAMPLE["state_changes"]), {"allowed", "actions"})
        self.assertIs(EXAMPLE["state_changes"]["allowed"], False, "observe_only allows no state change")

    def test_every_field_of_the_example_has_a_row_in_the_table(self):
        rows = set(re.findall(r"^\| `(\w+)` \|", STEP7, re.M))
        self.assertEqual(rows, set(EXAMPLE))

    def test_the_two_production_confirmations_have_a_place_and_a_time(self):
        self.assertIn('"confirmed_at"', STEP7)
        self.assertIn('"run_confirmed_at"', STEP7)
        self.assertIn("two separate confirmations", STEP7)
        step3 = section(DISCOVER, "3. Validate the target URL")
        self.assertIn("in the discovery context (step 7)", step3)
        self.assertIn("One confirmation is not enough.", step3)

    def test_the_file_holds_no_secret_and_nothing_from_a_request(self):
        self.assertEqual(find_literal_secrets(EXAMPLE), [])
        self.assertIsNone(re.search(r"tb(?:rq|ag|ci|pr)_[A-Za-z0-9_-]{20,}", STEP7))
        self.assertIn("holds no secret and no text from a request", STEP7)
        self.assertIn("never a password, a token, a cookie, a masked value or the note of a request", STEP7)
        self.assertNotIn("note", EXAMPLE)


class WhenItIsWrittenTests(unittest.TestCase):
    def test_it_is_written_only_after_the_scope_is_approved(self):
        self.assertLess(DISCOVER.index("## 6. Stop and ask for approval"), DISCOVER.index("## 7. Write the discovery context"))
        self.assertIn("Only after the user has approved the scope in step 6", STEP7)
        self.assertIn("Write anything before the user has approved the scope", section(DISCOVER, "Responsibilities"))

    def test_without_approval_nothing_is_written_and_an_old_file_stays(self):
        self.assertIn("If the user does not approve, or approves something other than the scope that was shown, write nothing, and leave an existing file as it is.", STEP7)

    def test_it_is_one_file_that_every_new_approved_discovery_overwrites(self):
        self.assertIn("one file, overwritten by every new approved discovery", STEP7)

    def test_discover_still_stops_before_plan(self):
        self.assertIn("Do not proceed to `plan` automatically.", section(DISCOVER, "6. Stop and ask for approval"))


class WhoReadsItTests(unittest.TestCase):
    def test_run_must_read_it_and_pauses_when_it_is_missing_or_invalid(self):
        step = section(RUN, "2. Read the discovery context")
        self.assertIn(PATH, step)
        self.assertIn("If the discovery context is missing or invalid, pause and ask the user to run", step)

    def test_run_refuses_a_file_that_is_less_restrictive_than_the_profile(self):
        step = section(RUN, "2. Read the discovery context")
        self.assertIn("must not be less restrictive than `permissionMode` in the project profile now", step)
        self.assertIn("the profile wins", step)

    def test_plan_may_read_it_but_still_asks_for_both_approvals(self):
        text = PLAN[:PLAN.index("Paths in this file are relative")]
        self.assertIn("optional: the discovery context", text)
        self.assertIn(PATH, text)
        self.assertIn("It does not replace the approval of the scope or of the test plan here", text)

    def test_the_file_is_kept_out_of_git(self):
        self.assertIn("audits/", (ROOT / ".gitignore").read_text().splitlines())
        self.assertIn("no (git-ignored)", [l for l in README.splitlines() if PATH in l][0])


if __name__ == "__main__":
    unittest.main()
