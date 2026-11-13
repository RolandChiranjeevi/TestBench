"""The runner can read configuration and audit packages from other folders than <root>/config and <root>/<audit-id>.

In the TestBench repository the skills use .testpilot/ for local configuration and audits/ for audit packages (both are git-ignored).
Run: python3 -m unittest discover -s testpilot/tests
"""
import json
import shutil
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from apitest import runner  # noqa: E402
from apitest_mock import MockApi  # noqa: E402
from test_apitest_runner import AID, ENV, make_root  # noqa: E402


class LayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = MockApi().start()

    @classmethod
    def tearDownClass(cls):
        cls.api.stop()

    def setUp(self):
        self.api.items.clear()
        self.api.names.clear()
        self.api.calls.clear()
        self.api.limited_hits = 0

    def relocate(self, root):
        """Moves the default layout (<root>/config, <root>/<audit-id>) to <root>/.testpilot and <root>/audits/<audit-id>."""
        shutil.move(str(root / "config"), str(root / ".testpilot"))
        (root / "audits").mkdir()
        shutil.move(str(root / AID), str(root / "audits" / AID))

    def test_reads_config_and_writes_package_in_the_given_folders(self):
        root = make_root(self.api.base_url)
        self.relocate(root)
        result = runner.Runner(AID, root=str(root), env=ENV, sleep=lambda s: None, config_dir=str(root / ".testpilot"), audits_dir=str(root / "audits")).run()
        self.assertTrue(result["results"])
        manifest = json.loads((root / "audits" / AID / "manifest.json").read_text())
        self.assertTrue(manifest["executions"])
        self.assertFalse((root / AID).exists(), "nothing is written next to <root> when --audits-dir is given")

    def test_permission_mode_is_read_from_the_given_config_folder(self):
        root = make_root(self.api.base_url, mode="observe_only")
        self.relocate(root)
        profile = json.loads((root / ".testpilot" / "targets" / "mock.json").read_text())
        self.assertEqual(runner.effective_mode(str(root), profile, str(root / ".testpilot")), "observe_only")
        project = root / ".testpilot" / "projects" / "t.json"
        project.write_text(json.dumps({"projectId": "1", "projectKey": "T", "permissionMode": "full"}))
        profile["permissionMode"] = "full"
        self.assertEqual(runner.effective_mode(str(root), profile, str(root / ".testpilot")), "full")


if __name__ == "__main__":
    unittest.main()
