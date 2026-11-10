"""Safety regressions for tools/apitest: derived state changes (B1), unsafe retries (B2), unmasked secrets (B3).

Run: python3 -m unittest discover -s tests
"""
import json
import socket
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from apitest import redact, runner  # noqa: E402
from apitest.request import is_state_changing  # noqa: E402
from apitest_mock import TOKENS, USERS, MockApi  # noqa: E402
from test_apitest_runner import AID, ENV, make_root  # noqa: E402

MUTATION = 'mutation { createItem(name: "n") { id } }'


def set_plan(root, items):
    path = root / AID / "api-plan.json"
    plan = json.loads(path.read_text())
    plan["items"] = items
    path.write_text(json.dumps(plan))


def item(n, request, **extra):
    return {"test_plan_item_id": f"TPI-{n:03d}", "requirement_id": "REQ-LOCAL-001", "request": request, "expect": {}, **extra}


def graphql(query):
    return {"method": "POST", "path": "/graphql", "bodyType": "graphql", "graphql": {"query": query}, "auth": "none"}


def manifest_of(root):
    return json.loads((root / AID / "manifest.json").read_text())


def all_text(root):
    return "".join(p.read_text() for p in (root / AID).rglob("*.json"))


class Blackhole:
    """Accepts connections, records the request line, never answers."""

    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(10)
        self.hits = []
        threading.Thread(target=self._serve, daemon=True).start()

    @property
    def base_url(self):
        return f"http://127.0.0.1:{self.sock.getsockname()[1]}"

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            self.hits.append(conn.recv(65536).split(b" ")[0])
            threading.Timer(3, conn.close).start()

    def close(self):
        self.sock.close()


def no_auth_root(base_url):
    root = make_root(base_url)
    path = root / "config" / "targets" / "mock.json"
    profile = json.loads(path.read_text())
    profile["auth"] = {"type": "none"}
    profile["limits"]["timeoutSeconds"] = 1
    path.write_text(json.dumps(profile))
    return root


class StateChangeDerivationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = MockApi().start()

    @classmethod
    def tearDownClass(cls):
        cls.api.stop()

    def setUp(self):
        self.api.calls.clear()

    def test_is_state_changing_table(self):
        for method in ("GET", "get", "HEAD", "OPTIONS"):
            self.assertFalse(is_state_changing({"method": method, "path": "/x"}), method)
        for method in ("POST", "PUT", "PATCH", "DELETE", "TRACE", "PURGE"):
            self.assertTrue(is_state_changing({"method": method, "path": "/x"}), method)
        self.assertFalse(is_state_changing(graphql("{ viewer { id } }")))
        self.assertFalse(is_state_changing(graphql("query Q { viewer { id } }")))
        self.assertTrue(is_state_changing(graphql(MUTATION)))
        self.assertTrue(is_state_changing(graphql("mutation M { a }")))
        self.assertTrue(is_state_changing(graphql("subscription { a }")))
        self.assertTrue(is_state_changing(graphql("fragment F on T { a } mutation { b { ...F } }")))
        self.assertTrue(is_state_changing(graphql("not a graphql document")))
        self.assertTrue(is_state_changing(graphql("")))
        self.assertTrue(is_state_changing({"method": "POST", "path": "/graphql", "graphql": {"query": MUTATION}}))
        self.assertTrue(is_state_changing({"method": "GET", "path": "/x", "graphql": {"query": MUTATION}}))

    def test_observe_only_refuses_unflagged_delete(self):
        root = make_root(self.api.base_url, mode="observe_only")
        set_plan(root, [item(1, {"method": "DELETE", "path": "/api/items/x"})])
        with self.assertRaises(runner.RunError) as ctx:
            runner.Runner(AID, root=str(root), env=ENV).run()
        self.assertIn("TPI-001", str(ctx.exception))
        self.assertEqual(self.api.calls, [])

    def test_observe_only_refuses_graphql_mutation_even_when_flagged_false(self):
        root = make_root(self.api.base_url, mode="observe_only")
        set_plan(root, [item(1, graphql(MUTATION), state_changing=False)])
        with self.assertRaises(runner.RunError):
            runner.Runner(AID, root=str(root), env=ENV).run()
        self.assertEqual(self.api.calls, [])

    def test_target_profile_stricter_than_project_refuses_unflagged_post(self):
        root = make_root(self.api.base_url, mode="full")
        path = root / "config" / "targets" / "mock.json"
        profile = json.loads(path.read_text())
        profile["permissionMode"] = "observe_only"
        path.write_text(json.dumps(profile))
        set_plan(root, [item(1, {"method": "POST", "path": "/api/items", "body": {"name": "n"}})])
        with self.assertRaises(runner.RunError):
            runner.Runner(AID, root=str(root), env=ENV).run()
        self.assertEqual(self.api.calls, [])

    def test_observe_only_still_runs_graphql_query_over_post_and_login(self):
        root = make_root(self.api.base_url, mode="observe_only")
        set_plan(root, [item(1, graphql("{ viewer { id } }"), expect={"status": 200}),
                        item(2, {"method": "GET", "path": "/api/me", "auth": "default"}, expect={"status": 200})])
        result = runner.Runner(AID, root=str(root), env=ENV).run()
        self.assertEqual(result["counts"], {"pass": 2})
        self.assertIn(("POST", "/api/login"), [c[:2] for c in self.api.calls])  # the explicit login exemption

    def test_full_mode_unflagged_write_needs_an_allowed_action(self):
        root = make_root(self.api.base_url, mode="full")
        set_plan(root, [item(1, {"method": "POST", "path": "/api/items", "body": {"name": "n"}})])
        with self.assertRaises(runner.RunError) as ctx:
            runner.Runner(AID, root=str(root), env=ENV).run()
        self.assertIn("action", str(ctx.exception))
        self.assertEqual(self.api.calls, [])

    def test_full_mode_unflagged_write_with_action_is_recorded(self):
        root = make_root(self.api.base_url, mode="full")
        set_plan(root, [item(1, {"method": "POST", "path": "/api/items", "body": {"name": "TP-API-x"}}, action={"action": "create_item", "target": "i"},
                             expect={"status": 201})])
        runner.Runner(AID, root=str(root), env=ENV).run()
        self.assertEqual([a["action"] for a in manifest_of(root)["actions"]], ["create_item"])


class RetryTests(unittest.TestCase):
    def test_write_timeout_is_inconclusive_and_never_retried(self):
        hole = Blackhole()
        self.addCleanup(hole.close)
        root = no_auth_root(hole.base_url)
        set_plan(root, [item(1, {"method": "POST", "path": "/api/items", "body": {"name": "a"}, "auth": "none"}, state_changing=True,
                             action={"action": "create_item", "target": "i"}, expect={"status": 201})])
        sleeps = []
        result = runner.Runner(AID, root=str(root), env=ENV, sleep=sleeps.append).run()
        time.sleep(0.2)
        self.assertEqual(hole.hits, [b"POST"])
        self.assertEqual(sleeps, [])
        self.assertEqual(result["results"][0]["status"], "inconclusive")
        execution = manifest_of(root)["executions"][0]
        self.assertEqual(execution["reason"], "insufficient-evidence")
        self.assertIn("may have been performed", execution["summary"])
        self.assertEqual(manifest_of(root)["actions"], [])

    def test_graphql_mutation_timeout_is_not_retried(self):
        hole = Blackhole()
        self.addCleanup(hole.close)
        root = no_auth_root(hole.base_url)
        set_plan(root, [item(1, graphql(MUTATION), state_changing=True, action={"action": "create_item", "target": "i"})])
        runner.Runner(AID, root=str(root), env=ENV, sleep=lambda s: None).run()
        time.sleep(0.2)
        self.assertEqual(len(hole.hits), 1)

    def test_read_timeout_is_still_retried_three_times(self):
        hole = Blackhole()
        self.addCleanup(hole.close)
        root = no_auth_root(hole.base_url)
        set_plan(root, [item(1, {"method": "GET", "path": "/api/me", "auth": "none"}, expect={"status": 200})])
        result = runner.Runner(AID, root=str(root), env=ENV, sleep=lambda s: None).run()
        time.sleep(0.2)
        self.assertEqual(len(hole.hits), 3)
        self.assertEqual(result["results"][0]["status"], "blocked")

    def test_write_refused_before_sending_is_retried(self):
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        root = no_auth_root(f"http://127.0.0.1:{port}")
        set_plan(root, [item(1, {"method": "POST", "path": "/api/items", "body": {"name": "a"}, "auth": "none"}, state_changing=True,
                             action={"action": "create_item", "target": "i"})])
        sleeps = []
        result = runner.Runner(AID, root=str(root), env=ENV, sleep=sleeps.append).run()
        self.assertEqual(result["results"][0]["status"], "blocked")
        self.assertEqual(len(sleeps), 2)  # three attempts: nothing was ever sent


class SecretMaskingTests(unittest.TestCase):
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

    def login_item(self, expect):
        return item(1, {"method": "POST", "path": "/api/login", "body": {"username": "alice", "password": "${env:MOCK_PASS}"}, "auth": "none"},
                    state_changing=True, action={"action": "create_item", "target": "s"}, expect=expect)

    def test_deviation_values_never_reach_manifest_evidence_or_observations(self):
        root = make_root(self.api.base_url)
        set_plan(root, [self.login_item({"status": 200, "body": {"$.token": {"equals": "nope"}}})])
        runner.Runner(AID, root=str(root), env=ENV).run()
        blob = all_text(root)
        self.assertNotIn(TOKENS["alice"], blob)
        self.assertNotIn(USERS["alice"], blob)
        summary = manifest_of(root)["executions"][0]["summary"]
        self.assertIn("$.token", summary)
        self.assertIn("[redacted]", summary)

    def test_known_secret_value_masked_when_it_appears_under_an_innocent_key(self):
        root = make_root(self.api.base_url)
        # the mock echoes "name"; a deviation on $.name would quote the password the plan sent via ${env:}
        set_plan(root, [item(1, {"method": "POST", "path": "/api/items", "body": {"name": "${env:MOCK_PASS}"}}, state_changing=True,
                             action={"action": "create_item", "target": "i"}, expect={"status": 201, "body": {"$.name": {"equals": "other"}}})])
        result = runner.Runner(AID, root=str(root), env=ENV).run()
        self.assertEqual(result["results"][0]["status"], "fail")  # the deviation exists, so the leak path is exercised
        self.assertNotIn(USERS["alice"], all_text(root))

    def test_secret_in_url_path_is_masked_everywhere(self):
        root = make_root(self.api.base_url)
        set_plan(root, [item(1, {"method": "GET", "path": "/api/items/${env:MOCK_PASS}", "auth": "none"}, expect={"status": 200})])
        runner.Runner(AID, root=str(root), env=ENV).run()
        self.assertNotIn(USERS["alice"], all_text(root))
        self.assertIn("[redacted]", manifest_of(root)["executions"][0]["url"])

    def test_secret_in_query_value_under_innocent_key_is_masked(self):
        root = make_root(self.api.base_url)
        set_plan(root, [item(1, {"method": "GET", "path": "/api/items", "query": {"q": "${env:MOCK_PASS}"}, "auth": "none"}, expect={"status": 200})])
        runner.Runner(AID, root=str(root), env=ENV).run()
        self.assertNotIn(USERS["alice"], all_text(root))

    def test_redact_url_hides_userinfo_jwt_and_query_values(self):
        jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef123"
        out = redact.redact_url(f"http://user:hunter22@h/p/{jwt}?q={jwt}&page=2")
        self.assertNotIn("hunter22", out)
        self.assertNotIn(jwt, out)
        self.assertIn("page=2", out)
        self.assertEqual(redact.redact_url("http://h/p"), "http://h/p")

    def test_mask_known_secrets(self):
        self.assertNotIn("zzsecret99", redact.redact_url("http://h/a/zzsecret99/b", secrets={"zzsecret99"}))
        self.assertNotIn("zz secret", redact.redact_url("http://h/a?q=zz%20secret", secrets={"zz secret"}))
        masked = redact.mask_secrets({"k": ["x zzsecret99 y"], "zzsecret99": 1}, {"zzsecret99"})
        self.assertEqual(masked, {"k": ["x [redacted] y"], "[redacted]": 1})
        self.assertEqual(redact.mask_secrets("a ab b", {"ab"}), "a ab b")  # too short to be a safe needle


if __name__ == "__main__":
    unittest.main()
