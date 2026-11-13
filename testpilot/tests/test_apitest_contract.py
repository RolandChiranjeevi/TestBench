"""Tests for tools/apitest/contract.py. Run: python3 -m unittest discover -s tests"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from apitest import contract  # noqa: E402
from apitest_mock import GRAPHQL_SDL, OPENAPI  # noqa: E402


def rules_of(devs):
    return sorted((d.where, d.rule) for d in devs)


class OpenApiTests(unittest.TestCase):
    def setUp(self):
        self.c = {"kind": "openapi", "doc": OPENAPI}

    def test_path_matching_prefers_literal(self):
        self.assertEqual(contract.match_path(OPENAPI, "/api/items/42?x=1"), ("/api/items/{id}", {"id": "42"}))
        self.assertEqual(contract.match_path(OPENAPI, "/api/items"), ("/api/items", {}))
        self.assertEqual(contract.match_path(OPENAPI, "/nope"), (None, {}))

    def test_undocumented_path_method_status(self):
        self.assertEqual(contract.check_openapi(self.c, "GET", "/api/boom", 500)[0].rule, "path")
        self.assertEqual(contract.check_openapi(self.c, "PATCH", "/api/items/1", 200)[0].rule, "method")
        dev = contract.check_openapi(self.c, "GET", "/api/me", 418)[0]
        self.assertEqual((dev.rule, dev.actual), ("status", 418))

    def test_response_and_request_schemas(self):
        good = {"id": "6f1c6e6a-2b7e-4a1e-9f3d-1c2b3a4d5e6f", "email": "a@b.co", "name": "A"}
        self.assertEqual(contract.check_openapi(self.c, "GET", "/api/me", 200, good), [])
        bad = contract.check_openapi(self.c, "GET", "/api/me", 200, {"id": "x", "name": "A"})
        self.assertEqual(rules_of(bad), [("response $.email", "required"), ("response $.id", "format")])
        req = contract.check_openapi(self.c, "POST", "/api/items", 201, good, request_json={"name": ""})
        self.assertEqual(rules_of(req), [("request $.name", "minLength")])

    def test_load_contract_from_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "spec.json").write_text(json.dumps(OPENAPI))
            loaded = contract.load_contract({"type": "openapi", "file": "spec.json"}, tmp)
            self.assertEqual(loaded["kind"], "openapi")
            Path(tmp, "bad.json").write_text("{}")
            with self.assertRaises(ValueError):
                contract.load_contract({"type": "openapi", "file": "bad.json"}, tmp)
            self.assertIsNone(contract.load_contract(None))


class GraphqlTests(unittest.TestCase):
    def setUp(self):
        self.c = contract.graphql_from_sdl(GRAPHQL_SDL)

    def test_sdl_parsing(self):
        self.assertEqual(self.c["types"]["Query"], {"viewer": "User", "item": "Item"})
        self.assertEqual(self.c["types"]["Item"]["count"], "Int")
        self.assertEqual((self.c["query"], self.c["mutation"]), ("Query", "Mutation"))

    def test_selection_parsing(self):
        self.assertEqual(contract.selection("query Q($id: ID!) { viewer { id } item(id: $id) { name } }"), ("query", ["viewer", "item"]))
        self.assertEqual(contract.selection("{ me: viewer { id } }"), ("query", ["viewer"]))
        self.assertEqual(contract.selection("mutation { createItem(name: \"x\") { id } }"), ("mutation", ["createItem"]))

    def test_checks(self):
        ok = contract.check_graphql(self.c, "{ viewer { id email } }", {"data": {"viewer": {"id": "1", "email": "a@b.co"}}})
        self.assertEqual(ok, [])
        bad = contract.check_graphql(self.c, "{ viewer { id } nope { x } }", {"data": {"viewer": {"id": 5, "extra": 1}, "ghost": 1}})
        self.assertEqual(rules_of(bad), [("$.data.ghost", "field"), ("$.data.viewer.extra", "field"), ("$.data.viewer.id", "type"), ("query.nope", "field")])
        self.assertEqual(contract.check_graphql(self.c, "mutation { createItem(name: \"n\") { id count } }", {"data": {"createItem": {"id": "1", "count": 2}}}), [])

    def test_introspection(self):
        doc = {"data": {"__schema": {"queryType": {"name": "Query"}, "mutationType": None, "types": [
            {"name": "Query", "fields": [{"name": "viewer", "type": {"kind": "NON_NULL", "name": None, "ofType": {"kind": "OBJECT", "name": "User", "ofType": None}}}]},
            {"name": "User", "fields": [{"name": "id", "type": {"kind": "SCALAR", "name": "ID", "ofType": None}}]}]}}}
        c = contract.graphql_from_introspection(doc)
        self.assertEqual(c["types"]["Query"], {"viewer": "User"})
        self.assertEqual(c["mutation"], "Mutation")


if __name__ == "__main__":
    unittest.main()
