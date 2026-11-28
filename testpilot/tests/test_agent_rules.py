"""The rule that the agent never claims a human approval it did not receive (M-1 in docs/agent-chain-verification.md).

A draft manual test once said "State changes approved for this check by a person" when no person had said so. The rules are instructions for an agent, so its
behaviour cannot be tested here. What can be tested is that the rule is in the text of rule 3, and that the skill that writes the drafts reads that file.
Run: python3 -m unittest discover -s testpilot/tests
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent / ".claude"
RULES = (ROOT / "references" / "agent-rules.md").read_text()
REPORT_SKILL = (ROOT / "skills" / "testpilot-request-discover" / "modes" / "read.md").read_text()


def rule(title):
    """The text of one `## ` section of the rules, up to the next one."""
    m = re.search(r"^## " + re.escape(title) + r"\n(.*?)(?=^## |\Z)", RULES, re.S | re.M)
    assert m, f"no rule called {title!r}"
    return " ".join(m.group(1).split())  # one line per bullet, so the wrapping of the file does not matter


class NoClaimedApprovalTests(unittest.TestCase):
    def test_the_agent_does_not_claim_that_a_person_decided_unless_they_said_so(self):
        text = rule("3. The agent never approves")
        self.assertIn("Do not claim that a person approved, accepted, rejected, reviewed or decided anything", text)
        self.assertIn("unless the person explicitly said so in this session", text)

    def test_it_covers_drafts_and_proposals_and_names_the_case_that_was_found(self):
        text = rule("3. The agent never approves")
        self.assertIn("drafts and proposals included", text)
        self.assertIn("state changes approved for this check by a person", text)

    def test_when_approval_is_needed_the_agent_asks_and_waits_for_an_explicit_answer(self):
        text = rule("3. The agent never approves")
        self.assertIn("If approval is required, ask the user and wait for an explicit answer.", text)

    def test_the_skill_that_writes_the_drafts_reads_the_rules(self):
        self.assertIn("../../references/agent-rules.md", REPORT_SKILL)

    def test_the_rule_that_was_there_before_stays(self):
        text = rule("3. The agent never approves")
        self.assertIn("The agent only proposes.", text)
        self.assertIn("never approves, rejects, edits or deprecates", text)


if __name__ == "__main__":
    unittest.main()


class HonestReportingTests(unittest.TestCase):
    def test_a_report_says_what_was_not_verified_and_does_not_overclaim(self):
        text = rule("12. Honest reporting: say what was not verified")
        for must in ("Never imply broader coverage", "ends with what was **not** verified", "**client-side** validation was verified", "No automated accessibility scan was performed", "is not a security test or an API test"):
            with self.subTest(must=must):
                self.assertIn(must, text)

    def test_a_failure_is_reproduced_before_it_becomes_a_bug(self):
        text = rule("13. Reproduce before a bug")
        for must in ("try the failing step once more", "is an **observation**, not a bug", "never a product defect", "are one finding", "states plainly what the bug is"):
            with self.subTest(must=must):
                self.assertIn(must, text)

    def test_the_oracles_are_in_the_heuristics(self):
        text = (ROOT / "references" / "testheuristics.md").read_text()
        self.assertIn("## Oracles: HICCUPS and FEW HICCUPS", text)
        self.assertIn("**E**xplainability", text)

    def test_both_discover_skills_read_the_rules_and_end_with_what_was_not_verified(self):
        for name in ("read", "write"):
            text = " ".join((ROOT / "skills" / "testpilot-request-discover" / "modes" / f"{name}.md").read_text().split())
            with self.subTest(skill=name):
                self.assertIn("12 and 13)", text)
                self.assertIn("End with what was **not** verified and why, as rule 12 says", text)
