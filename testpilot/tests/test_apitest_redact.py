"""Tests for tools/apitest/redact.py. Run: python3 -m unittest discover -s tests"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from apitest import redact  # noqa: E402


class RedactTests(unittest.TestCase):
    def test_headers_mask_values_but_keep_scheme(self):
        out = redact.redact_headers({"Authorization": "Bearer abc.def.ghi", "Cookie": "session=xyz", "X-Api-Key": "k", "Accept": "application/json"})
        self.assertEqual(out["Authorization"], "Bearer [redacted]")
        self.assertEqual(out["Cookie"], "[redacted]")
        self.assertEqual(out["X-Api-Key"], "[redacted]")
        self.assertEqual(out["Accept"], "application/json")

    def test_json_masks_secret_keys_recursively(self):
        out = redact.redact_json({"user": "u", "password": "p", "nested": [{"token": "t", "id": 1}], "note": "Bearer abcdefgh12345"})
        self.assertEqual(out["password"], "[redacted]")
        self.assertEqual(out["nested"][0]["token"], "[redacted]")
        self.assertEqual(out["nested"][0]["id"], 1)
        self.assertEqual(out["note"], "Bearer [redacted]")

    def test_text_patterns(self):
        self.assertNotIn("tbag_abcdef123", redact.redact_text("token tbag_abcdef123 here"))
        self.assertNotIn("eyJhbGciOiJIUzI1NiJ9", redact.redact_text("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef123"))
        self.assertEqual(redact.redact_text("password=hunter2&x=1"), "password=[redacted]&x=1")

    def test_url_query_secrets(self):
        self.assertEqual(redact.redact_url("http://h/p?api_key=abc&page=2"), "http://h/p?api_key=%5Bredacted%5D&page=2")
        self.assertEqual(redact.redact_url("http://h/p"), "http://h/p")

    def test_profile_literal_secrets(self):
        ok = {"auth": {"type": "bearer", "tokenEnvVar": "X", "login": {"body": {"password": "${env:P}"}, "tokenPath": "$.token"}, "cookieName": "session"}}
        self.assertEqual(redact.find_literal_secrets(ok), [])
        bad = {"auth": {"login": {"body": {"password": "hunter2"}}, "apiKey": "abc"}}
        self.assertEqual(sorted(redact.find_literal_secrets(bad)), ["auth.apiKey", "auth.login.body.password"])


if __name__ == "__main__":
    unittest.main()
