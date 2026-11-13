"""The configuration templates in testpilot/config/ are committed, so they must never hold a secret.

Real configuration lives in .testpilot/ (git-ignored). Secrets are only ever named (tokenEnvVar, ${env:NAME}), never written.
Run: python3 -m unittest discover -s testpilot/tests
"""
import json
import sys
import unittest
from pathlib import Path

CONFIG = Path(__file__).resolve().parent.parent / "config"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from apitest.redact import find_literal_secrets  # noqa: E402


class ConfigTemplateTests(unittest.TestCase):
    def test_templates_exist_and_are_json(self):
        files = sorted(CONFIG.rglob("*.json"))
        self.assertTrue(files, "no templates found in testpilot/config/")
        for path in files:
            with self.subTest(path=path.relative_to(CONFIG).as_posix()):
                self.assertTrue(path.name.endswith(".example.json"), "only *.example.json templates may be committed here")
                json.loads(path.read_text())

    def test_templates_hold_no_literal_secret(self):
        for path in sorted(CONFIG.rglob("*.json")):
            with self.subTest(path=path.relative_to(CONFIG).as_posix()):
                self.assertEqual(find_literal_secrets(json.loads(path.read_text())), [])

    def test_project_template_is_observe_only_and_does_not_deliver(self):
        for path in sorted((CONFIG / "projects").glob("*.example.json")):
            profile = json.loads(path.read_text())
            with self.subTest(path=path.name):
                self.assertEqual(profile["permissionMode"], "observe_only")
                self.assertIs(profile["deliveryEnabled"], False)


if __name__ == "__main__":
    unittest.main()
