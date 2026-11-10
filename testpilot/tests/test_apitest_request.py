"""Tests for tools/apitest/request.py. Run: python3 -m unittest discover -s tests"""
import base64
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from apitest.request import RequestError, auth_headers, build_request, resolve  # noqa: E402

PROFILE = {"baseUrl": "http://localhost:9999/", "headers": {"Accept": "application/json"}, "auth": {"type": "bearer", "tokenEnvVar": "T"}}
ENV = {"T": "static-token-value", "USER": "alice", "PASS": "pw"}


class ResolveTests(unittest.TestCase):
    def test_env_and_capture_placeholders(self):
        out = resolve({"a": "${env:USER}", "b": ["${capture:id}"], "c": 3}, ENV, {"id": 42})
        self.assertEqual(out, {"a": "alice", "b": ["42"], "c": 3})

    def test_missing_env_names_variable_not_value(self):
        with self.assertRaises(RequestError) as ctx:
            resolve("${env:MISSING}", ENV)
        self.assertIn("MISSING", str(ctx.exception))

    def test_missing_capture(self):
        with self.assertRaises(RequestError):
            resolve("${capture:nope}", ENV, {})


class BuildTests(unittest.TestCase):
    def test_json_body_query_and_profile_headers(self):
        r = build_request({"method": "post", "path": "/api/items", "query": {"a": 1, "b": ["x", "y"]}, "body": {"name": "n"}}, PROFILE, ENV)
        self.assertEqual(r.method, "POST")
        self.assertEqual(r.url, "http://localhost:9999/api/items?a=1&b=x&b=y")
        self.assertEqual(json.loads(r.body), {"name": "n"})
        self.assertEqual(r.headers["Content-Type"], "application/json")
        self.assertEqual(r.headers["Accept"], "application/json")
        self.assertEqual(r.body_type, "json")

    def test_form_multipart_graphql_raw(self):
        form = build_request({"method": "POST", "path": "/f", "bodyType": "form", "body": {"a": "1 2"}}, PROFILE, ENV)
        self.assertEqual(form.body, b"a=1+2")
        self.assertEqual(form.headers["Content-Type"], "application/x-www-form-urlencoded")
        multi = build_request({"method": "POST", "path": "/m", "bodyType": "multipart", "body": {"f": "v"}}, PROFILE, ENV)
        self.assertIn(b'name="f"', multi.body)
        self.assertTrue(multi.headers["Content-Type"].startswith("multipart/form-data; boundary="))
        gql = build_request({"method": "POST", "path": "/graphql", "bodyType": "graphql", "graphql": {"query": "{ viewer { id } }", "variables": {"x": "${env:USER}"}}}, PROFILE, ENV)
        self.assertEqual(json.loads(gql.body), {"query": "{ viewer { id } }", "variables": {"x": "alice"}})
        self.assertEqual(gql.body_type, "graphql")
        raw = build_request({"method": "POST", "path": "/r", "bodyType": "raw", "body": "<x/>", "contentType": "text/xml"}, PROFILE, ENV)
        self.assertEqual((raw.body, raw.headers["Content-Type"]), (b"<x/>", "text/xml"))

    def test_rejects_other_hosts_and_bad_base(self):
        with self.assertRaises(RequestError):
            build_request({"path": "http://evil.test/x"}, PROFILE, ENV)
        with self.assertRaises(RequestError):
            build_request({"path": "/x"}, {"baseUrl": "ftp://x"}, ENV)
        same = build_request({"path": "http://localhost:9999/ok"}, PROFILE, ENV)
        self.assertEqual(same.url, "http://localhost:9999/ok")

    def test_redacted_view_hides_auth_and_secret_fields(self):
        r = build_request({"method": "POST", "path": "/login", "body": {"username": "u", "password": "${env:PASS}"}}, PROFILE, ENV, auth={"Authorization": "Bearer abcdefgh"})
        view = r.redacted()
        self.assertEqual(view["headers"]["Authorization"], "Bearer [redacted]")
        self.assertEqual(view["body"]["password"], "[redacted]")
        self.assertEqual(view["body"]["username"], "u")


class AuthTests(unittest.TestCase):
    def test_modes_for_bearer(self):
        auth = {"type": "bearer", "tokenEnvVar": "T", "expiredTokenEnvVar": "EXP"}
        self.assertEqual(auth_headers(auth, "default", ENV), {"Authorization": "Bearer static-token-value"})
        self.assertEqual(auth_headers(auth, "default", ENV, {"default": "login-token"}), {"Authorization": "Bearer login-token"})
        self.assertEqual(auth_headers(auth, "none", ENV), {})
        self.assertIn("invalid", auth_headers(auth, "invalid", ENV)["Authorization"])
        self.assertEqual(auth_headers(auth, "expired", {"EXP": "old"}), {"Authorization": "Bearer old"})
        with self.assertRaises(RequestError):
            auth_headers(auth, "expired", {})
        with self.assertRaises(RequestError):
            auth_headers(auth, "second", ENV)
        with self.assertRaises(RequestError):
            auth_headers(auth, "weird", ENV)

    def test_cookie_header_and_basic(self):
        self.assertEqual(auth_headers({"type": "cookie", "cookieName": "sid"}, "default", ENV, {"default": "abc"}), {"Cookie": "sid=abc"})
        self.assertEqual(auth_headers({"type": "header", "headerName": "X-Key"}, "default", ENV, {"default": "k"}), {"X-Key": "k"})
        basic = auth_headers({"type": "basic"}, "default", ENV, {"default": "alice:pw"})
        self.assertEqual(basic["Authorization"], "Basic " + base64.b64encode(b"alice:pw").decode())
        self.assertEqual(auth_headers({"type": "none"}, "default", ENV), {})


if __name__ == "__main__":
    unittest.main()
