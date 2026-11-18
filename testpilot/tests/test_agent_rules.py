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
REPORT_SKILL = (ROOT / "skills" / "testpilot-report" / "SKILL.md").read_text()


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
