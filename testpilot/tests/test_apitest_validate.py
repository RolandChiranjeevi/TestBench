"""Tests for tools/apitest/validate.py. Run: python3 -m unittest discover -s tests"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from apitest.validate import check_rule, get_path, validate_response, validate_schema  # noqa: E402

BODY = {"items": [{"id": "6f1c6e6a-2b7e-4a1e-9f3d-1c2b3a4d5e6f", "email": "a@b.co", "n": 1}, {"id": "nope", "email": "bad", "n": 2}], "total": 2, "when": "2026-11-10T10:00:00Z", "empty": []}


def rules_of(devs):
    return sorted((d.where, d.rule) for d in devs)


class PathTests(unittest.TestCase):
    def test_paths_and_wildcards(self):
        self.assertEqual(get_path(BODY, "$.total"), [("$.total", 2)])
        self.assertEqual([v for _, v in get_path(BODY, "$.items[*].n")], [1, 2])
        self.assertEqual(get_path(BODY, "$.items[1].email"), [("$.items[1].email", "bad")])
        self.assertEqual(get_path(BODY, "$.missing.x"), [])
        self.assertEqual(get_path({"a-b": {"c": 1}}, '$["a-b"].c'), [('$["a-b"].c', 1)])
        with self.assertRaises(ValueError):
            get_path(BODY, "items")


class RuleTests(unittest.TestCase):
    def test_formats_and_bounds(self):
        self.assertEqual(check_rule("a@b.co", {"format": "email"}, "$"), [])
        self.assertEqual(check_rule("x", {"format": "email"}, "$")[0].rule, "format")
        self.assertEqual(check_rule("2026-11-10T10:00:00Z", {"format": "date-time"}, "$"), [])
        self.assertEqual(check_rule("2026-13-01", {"format": "date"}, "$")[0].rule, "format")
        self.assertEqual(check_rule(5, {"type": "integer", "minimum": 1, "maximum": 5}, "$"), [])
        self.assertEqual(check_rule(True, {"type": "integer"}, "$")[0].rule, "type")
        self.assertEqual(check_rule("abc", {"minLength": 2, "maxLength": 2}, "$")[0].rule, "maxLength")
        self.assertEqual(check_rule([1], {"minItems": 2}, "$")[0].rule, "minItems")
        self.assertEqual(check_rule({"a": 1}, {"required": ["a", "b"]}, "$")[0].actual, "missing ['b']")
        self.assertEqual(check_rule("", {"notEmpty": True}, "$")[0].rule, "notEmpty")
        self.assertEqual(check_rule("x", {"enum": ["y"], "pattern": "^y"}, "$")[0].rule, "pattern")
        self.assertEqual(check_rule("x", {"format": "zip"}, "$")[0].actual, "unknown format")


class SchemaTests(unittest.TestCase):
    def test_subset_with_ref_required_additional_and_items(self):
        root = {"components": {"schemas": {"Item": {"type": "object", "required": ["id"], "additionalProperties": False,
                                                    "properties": {"id": {"type": "string", "format": "uuid"}, "n": {"type": "integer", "minimum": 0}}}}}}
        schema = {"type": "object", "properties": {"items": {"type": "array", "items": {"$ref": "#/components/schemas/Item"}, "maxItems": 5}}}
        devs = validate_schema({"items": [{"id": "6f1c6e6a-2b7e-4a1e-9f3d-1c2b3a4d5e6f", "n": 1}, {"n": -1, "extra": 1}]}, schema, root=root)
        self.assertEqual(rules_of(devs), [("$.items[1].extra", "additionalProperties"), ("$.items[1].id", "required"), ("$.items[1].n", "minimum")])
        self.assertEqual(validate_schema(None, {"type": "string", "nullable": True}), [])
        self.assertEqual(validate_schema(3, {"oneOf": [{"type": "integer"}, {"type": "string"}]}), [])
        self.assertEqual(validate_schema("x", {"anyOf": [{"type": "integer"}, {"type": "boolean"}]})[0].rule, "anyOf")
        self.assertEqual(validate_schema({"a": 1}, {"$ref": "#/nope"})[0].rule, "$ref")


class ResponseTests(unittest.TestCase):
    def test_status_headers_body_and_graphql(self):
        resp = {"status": 200, "headers": {"content-type": "application/json; charset=utf-8"}, "json": BODY, "text": ""}
        expect = {"status": [200, 201], "headers": {"Content-Type": {"contains": "application/json"}, "X-Missing": "1"},
                  "body": {"$.items[*].id": {"format": "uuid"}, "$.items[*].email": {"format": "email"}, "$.total": {"type": "integer", "minimum": 2},
                           "$.when": {"format": "date-time"}, "$.gone": {"type": "string"}, "$.maybe": {"type": "string", "optional": True}, "$.none[*].x": {"type": "string"}, "$.empty[*].id": {"format": "uuid"}}}
        devs = validate_response(resp, expect)
        self.assertEqual(rules_of(devs), [("$.gone", "present"), ("$.items[1].email", "format"), ("$.items[1].id", "format"), ("$.none[*].x", "present"), ("header X-Missing", "present")])
        self.assertEqual(validate_response({"status": 500, "headers": {}, "json": None, "text": "x"}, {"status": 200})[0].actual, 500)
        self.assertEqual(validate_response({"status": 200, "headers": {}, "json": None, "text": "x"}, {"body": {"$.a": {}}})[0].rule, "json")
        gql_ok = {"status": 200, "headers": {}, "json": {"data": {"viewer": {"id": "1"}}}, "text": ""}
        gql_err = {"status": 200, "headers": {}, "json": {"errors": [{"message": "bad"}], "data": None}, "text": ""}
        self.assertEqual(validate_response(gql_ok, {"graphqlErrors": "none"}), [])
        self.assertEqual(validate_response(gql_err, {"graphqlErrors": "none"})[0].rule, "graphqlErrors")
        self.assertEqual(validate_response(gql_err, {"graphqlErrors": "present"}), [])
        self.assertEqual(validate_response(gql_ok, {"graphqlErrors": "present"})[0].actual, "none")


if __name__ == "__main__":
    unittest.main()
