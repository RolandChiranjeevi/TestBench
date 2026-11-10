"""Integration tests for tools/apitest/runner.py against the in-process mock API (127.0.0.1 only).

Run: python3 -m unittest discover -s tests
"""
import json
import socket
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from apitest import runner  # noqa: E402
from apitest_mock import OPENAPI, TOKENS, USERS, MockApi  # noqa: E402

AID = "AUD-20260102-01"
ENV = {"MOCK_USER": "alice", "MOCK_PASS": USERS["alice"], "MOCK_USER2": "bob", "MOCK_PASS2": USERS["bob"]}


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1))


def make_root(base_url, mode="full", create_limit="2 per audit"):
    root = Path(tempfile.mkdtemp())
    write(root / "config" / "testbench.json", {"baseUrl": "http://localhost:4100", "activeProject": "t"})
    write(root / "config" / "projects" / "t.json", {"projectId": "1", "projectKey": "T", "permissionMode": mode})
    write(root / "config" / "targets" / "mock.json", {
        "name": "mock", "baseUrl": base_url, "environment": "local", "production": False, "permissionMode": "full",
        "headers": {"Accept": "application/json"},
        "auth": {"type": "bearer", "login": {"method": "POST", "path": "/api/login", "body": {"username": "${env:MOCK_USER}", "password": "${env:MOCK_PASS}"}, "tokenPath": "$.token"},
                 "secondAccount": {"body": {"username": "${env:MOCK_USER2}", "password": "${env:MOCK_PASS2}"}}},
        "schema": {"type": "openapi", "file": "specs/mock.json"}, "limits": {"timeoutSeconds": 5, "maxAttempts": 3, "maxRequestsPerRun": 100}})
    write(root / "specs" / "mock.json", OPENAPI)
    write(root / AID / "manifest.json", {
        "audit_id": AID, "contract_version": "1.3", "scope": {"state_changes": {"allowed": True, "allowed_actions": [
            {"action": "create_item", "limit": create_limit}, {"action": "update_item", "limit": "1 per audit"}, {"action": "delete_item", "limit": "1 per audit"}]}},
        "executions": [], "actions": [], "evidence": []})
    write(root / AID / "api-plan.json", {"audit_id": AID, "target": "mock", "items": [
        {"test_plan_item_id": "TPI-001", "requirement_id": "REQ-LOCAL-001", "state_changing": False, "request": {"method": "GET", "path": "/api/me", "auth": "default"},
         "expect": {"status": 200, "headers": {"content-type": {"contains": "json"}}, "body": {"$.id": {"format": "uuid"}, "$.email": {"format": "email"}}}, "capture": {"me_id": "$.id"}},
        {"test_plan_item_id": "TPI-002", "requirement_id": "REQ-LOCAL-002", "state_changing": False, "request": {"method": "GET", "path": "/api/me", "auth": "none"}, "expect": {"status": 401}},
        {"test_plan_item_id": "TPI-003", "requirement_id": "REQ-LOCAL-002", "state_changing": False, "request": {"method": "GET", "path": "/api/me", "auth": "invalid"}, "expect": {"status": 401}},
        {"test_plan_item_id": "TPI-004", "requirement_id": "REQ-LOCAL-002", "state_changing": False, "request": {"method": "GET", "path": "/api/admin", "auth": "second"}, "expect": {"status": 403}},
        {"test_plan_item_id": "TPI-005", "requirement_id": "REQ-LOCAL-003", "state_changing": True, "action": {"action": "create_item", "target": "TP-API item"},
         "request": {"method": "POST", "path": "/api/items", "body": {"name": "TP-API-${capture:run_id}"}}, "repeat": 2, "expect": {"status": [201, 409]}, "capture": {"item_id": "$.id"}},
        {"test_plan_item_id": "TPI-006", "requirement_id": "REQ-LOCAL-003", "state_changing": False, "request": {"method": "GET", "path": "/api/items/${capture:item_id}"},
         "expect": {"status": 200, "body": {"$.name": {"pattern": "^TP-API-"}}, "schema": {"$ref": "#/components/schemas/Item"}}},
        {"test_plan_item_id": "TPI-007", "requirement_id": "REQ-LOCAL-003", "state_changing": False, "request": {"method": "GET", "path": "/api/items/does-not-exist"}, "expect": {"status": 404}},
        {"test_plan_item_id": "TPI-008", "requirement_id": "REQ-LOCAL-003", "state_changing": True, "action": {"action": "update_item", "target": "TP-API item"},
         "request": {"method": "PUT", "path": "/api/items/${capture:item_id}", "body": {"name": ""}}, "expect": {"status": 422}},
        {"test_plan_item_id": "TPI-009", "requirement_id": "REQ-LOCAL-004", "state_changing": False, "request": {"method": "GET", "path": "/api/limited"}, "repeat": 5, "expect": {"status": [200, 429]}},
        {"test_plan_item_id": "TPI-010", "requirement_id": "REQ-LOCAL-005", "state_changing": False, "request": {"method": "GET", "path": "/api/boom"}, "expect": {"status": 200}},
        {"test_plan_item_id": "TPI-011", "requirement_id": "REQ-LOCAL-006", "state_changing": False, "request": {"method": "POST", "path": "/graphql", "bodyType": "graphql", "graphql": {"query": "{ viewer { id email } }"}, "auth": "none"},
         "expect": {"status": 200, "graphqlErrors": "none", "body": {"$.data.viewer.id": {"format": "uuid"}}, "contract": "skip"}},
        {"test_plan_item_id": "TPI-012", "requirement_id": "REQ-LOCAL-006", "state_changing": False, "request": {"method": "POST", "path": "/graphql", "bodyType": "graphql", "graphql": {"query": "{ nope }"}, "auth": "none"},
         "expect": {"status": 200, "graphqlErrors": "present", "contract": "skip"}},
        {"test_plan_item_id": "TPI-013", "requirement_id": "REQ-LOCAL-003", "state_changing": False, "request": {"method": "GET", "path": "/api/items", "query": {"limit": 10}},
         "expect": {"status": 200, "body": {"$.items": {"type": "array", "maxItems": 10}, "$.items[*].id": {"format": "uuid"}}, "schema": {"$ref": "#/components/schemas/ItemList"}}},
        {"test_plan_item_id": "TPI-014", "requirement_id": "REQ-LOCAL-003", "state_changing": True, "action": {"action": "delete_item", "target": "TP-API item"},
         "request": {"method": "DELETE", "path": "/api/items/${capture:item_id}"}, "expect": {"status": 204}},
    ]})
    return root


class RunnerTests(unittest.TestCase):
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

    def test_full_run_records_everything(self):
        root = make_root(self.api.base_url)
        result = runner.Runner(AID, root=str(root), env=ENV, sleep=lambda s: None).run()
        statuses = {r["test_plan_item_id"]: r["status"] for r in result["results"]}
        self.assertEqual(statuses, {f"TPI-{n:03d}": "pass" for n in range(1, 15)} | {"TPI-010": "fail"})
        manifest = json.loads((root / AID / "manifest.json").read_text())
        self.assertEqual(len(manifest["executions"]), 14)
        self.assertEqual([a["action"] for a in manifest["actions"]], ["create_item", "delete_item"])
        self.assertTrue(all(a["allowed_by_scope"] for a in manifest["actions"]))
        boom = next(e for e in manifest["executions"] if e["test_plan_item_id"] == "TPI-010")
        self.assertIn("Violated criterion: status: status expected 200, got 500", boom["summary"])
        self.assertEqual(boom["mode"], "saved-test")
        self.assertIsNone(boom["viewport"])
        limited = next(e for e in manifest["executions"] if e["test_plan_item_id"] == "TPI-009")
        self.assertIn("Retry-After='5'", limited["summary"])
        self.assertEqual(len([c for c in self.api.calls if c[1] == "/api/limited"]), 3)  # stopped at the first 429, never retried
        self.assertEqual(len([c for c in self.api.calls if c[1] == "/api/login"]), 2)  # default and second account, once each
        # evidence: one network-trace per execution plus the run summary, all registered, all redacted
        self.assertEqual(len(manifest["evidence"]), 15)
        for ev in manifest["evidence"]:
            self.assertTrue((root / AID / ev["location"]).is_file(), ev["location"])
            self.assertTrue(ev["redacted"])
        blobs = "".join(p.read_text() for p in (root / AID / "evidence").iterdir())
        for secret in list(TOKENS.values()) + list(USERS.values()):
            self.assertNotIn(secret, blobs)
        self.assertIn("Bearer [redacted]", blobs)
        # contract deviations became observations, not failures
        observations = json.loads((root / AID / "api-observations.json").read_text())
        self.assertTrue(observations)
        self.assertTrue(all(o["kind"] == "api_test" and o["status"] == "observed" and o["auditId"] == AID for o in observations))
        self.assertTrue(any("/api/boom" in o["title"] for o in observations))
        self.assertEqual(result["requests_made"], 2 + 13 + 1 + 3)  # logins, single requests, the 2 creates, the limited probe

    def test_observe_only_refuses_state_changes_before_any_call(self):
        root = make_root(self.api.base_url, mode="observe_only")
        with self.assertRaises(runner.RunError) as ctx:
            runner.Runner(AID, root=str(root), env=ENV).run()
        self.assertIn("observe_only", str(ctx.exception))
        self.assertIn("TPI-005", str(ctx.exception))
        self.assertEqual(self.api.calls, [])

    def test_limit_and_secret_refusals(self):
        root = make_root(self.api.base_url, create_limit="1 per audit")
        with self.assertRaises(runner.RunError) as ctx:
            runner.Runner(AID, root=str(root), env=ENV).run()
        self.assertIn("create_item", str(ctx.exception))
        profile_path = root / "config" / "targets" / "mock.json"
        profile = json.loads(profile_path.read_text())
        profile["auth"]["login"]["body"]["password"] = "literal-secret"
        profile_path.write_text(json.dumps(profile))
        with self.assertRaises(runner.RunError) as ctx:
            runner.Runner(AID, root=str(root), env=ENV).run()
        self.assertIn("auth.login.body.password", str(ctx.exception))
        self.assertNotIn("literal-secret", str(ctx.exception))
        self.assertEqual(self.api.calls, [])

    def test_observe_only_items_run_and_dry_run_sends_nothing(self):
        root = make_root(self.api.base_url, mode="observe_only")
        read_only = ["TPI-001", "TPI-002", "TPI-013"]
        dry = runner.Runner(AID, root=str(root), env=ENV, items=read_only, dry_run=True).run()
        self.assertEqual((dry["dry_run"], dry["mode"], dry["problems"]), (True, "observe_only", []))
        self.assertEqual(self.api.calls, [])
        result = runner.Runner(AID, root=str(root), env=ENV, items=read_only).run()
        self.assertEqual(result["counts"], {"pass": 3})

    def test_unreachable_target_is_blocked_after_three_attempts(self):
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        root = make_root(f"http://127.0.0.1:{port}")
        sleeps = []
        result = runner.Runner(AID, root=str(root), env=ENV, items=["TPI-002"], sleep=sleeps.append).run()
        self.assertEqual(result["counts"], {"blocked": 1})
        execution = json.loads((root / AID / "manifest.json").read_text())["executions"][0]
        self.assertEqual(execution["reason"], "environment")
        self.assertIn("after 3 attempts", execution["summary"])
        self.assertEqual(len(sleeps), 2)

    def test_cli_refuses_with_exit_code_2(self):
        root = make_root(self.api.base_url, mode="observe_only")
        self.assertEqual(runner.main([AID, "--root", str(root)]), 2)


if __name__ == "__main__":
    unittest.main()
