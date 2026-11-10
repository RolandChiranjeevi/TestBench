"""Checks a response against an item's expect: status, headers, body rules by JSON path, a JSON-schema subset.

The schema subset covers type, properties, required, additionalProperties, items, enum, const, format,
pattern, length and range keywords, nullable, allOf/anyOf/oneOf and local $ref. When the jsonschema
package is installed it is used for schemas without $ref.
"""
import re
from dataclasses import dataclass
from datetime import datetime


@dataclass
class Deviation:
    where: str
    rule: str
    expected: object
    actual: object

    def text(self):
        return f"{self.where}: {self.rule} expected {self.expected!r}, got {self.actual!r}"

    def to_dict(self):
        return {"where": self.where, "rule": self.rule, "expected": self.expected, "actual": self.actual}


UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
URI_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://\S+$")


def _is_datetime(value):
    try:
        datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def _is_date(value):
    try:
        datetime.strptime(str(value), "%Y-%m-%d")
        return True
    except ValueError:
        return False


FORMATS = {
    "uuid": lambda v: isinstance(v, str) and bool(UUID_RE.match(v)),
    "email": lambda v: isinstance(v, str) and bool(EMAIL_RE.match(v)),
    "date-time": lambda v: isinstance(v, str) and _is_datetime(v),
    "date": lambda v: isinstance(v, str) and _is_date(v),
    "uri": lambda v: isinstance(v, str) and bool(URI_RE.match(v)),
}
SIMPLE_TYPES = {"string": str, "boolean": bool, "array": list, "object": dict, "null": type(None)}


def type_ok(value, type_name):
    if type_name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if type_name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if type_name in SIMPLE_TYPES:
        return isinstance(value, SIMPLE_TYPES[type_name])
    return False


PATH_TOKEN = re.compile(r"\.([A-Za-z_][A-Za-z0-9_-]*)|\[(\*|\d+)\]|\[\"([^\"]+)\"\]")


def get_path(obj, path):
    """Resolves $.a.b[0].c with [*] wildcards. Returns [(pointer, value)], empty when nothing matches."""
    if path in ("$", ""):
        return [("$", obj)]
    if not path.startswith("$"):
        raise ValueError(f"path must start with $: {path}")
    rest, pos, current = path[1:], 0, [("$", obj)]
    while pos < len(rest):
        match = PATH_TOKEN.match(rest, pos)
        if not match:
            raise ValueError(f"bad path {path} at {rest[pos:]!r}")
        pos = match.end()
        key, index, quoted = match.group(1), match.group(2), match.group(3)
        following = []
        for pointer, value in current:
            if key is not None or quoted is not None:
                name = key if key is not None else quoted
                if isinstance(value, dict) and name in value:
                    following.append((f'{pointer}["{name}"]' if quoted is not None else f"{pointer}.{name}", value[name]))
            elif index == "*":
                if isinstance(value, list):
                    following.extend((f"{pointer}[{i}]", item) for i, item in enumerate(value))
            else:
                i = int(index)
                if isinstance(value, list) and i < len(value):
                    following.append((f"{pointer}[{i}]", value[i]))
        current = following
        if not current:
            return []
    return current


def check_rule(value, rule, where):
    """Applies one body rule to one value."""
    out = []
    if "type" in rule and not type_ok(value, rule["type"]):
        return [Deviation(where, "type", rule["type"], type(value).__name__)]
    if "format" in rule:
        checker = FORMATS.get(rule["format"])
        if checker is None:
            out.append(Deviation(where, "format", rule["format"], "unknown format"))
        elif not checker(value):
            out.append(Deviation(where, "format", rule["format"], value))
    if "equals" in rule and value != rule["equals"]:
        out.append(Deviation(where, "equals", rule["equals"], value))
    if "pattern" in rule and (not isinstance(value, str) or not re.search(rule["pattern"], value)):
        out.append(Deviation(where, "pattern", rule["pattern"], value))
    if "enum" in rule and value not in rule["enum"]:
        out.append(Deviation(where, "enum", rule["enum"], value))
    numeric = isinstance(value, (int, float)) and not isinstance(value, bool)
    if "minimum" in rule and (not numeric or value < rule["minimum"]):
        out.append(Deviation(where, "minimum", rule["minimum"], value))
    if "maximum" in rule and (not numeric or value > rule["maximum"]):
        out.append(Deviation(where, "maximum", rule["maximum"], value))
    if "minLength" in rule and (not isinstance(value, str) or len(value) < rule["minLength"]):
        out.append(Deviation(where, "minLength", rule["minLength"], len(value) if isinstance(value, str) else value))
    if "maxLength" in rule and (not isinstance(value, str) or len(value) > rule["maxLength"]):
        out.append(Deviation(where, "maxLength", rule["maxLength"], len(value) if isinstance(value, str) else value))
    if "minItems" in rule and (not isinstance(value, list) or len(value) < rule["minItems"]):
        out.append(Deviation(where, "minItems", rule["minItems"], len(value) if isinstance(value, list) else value))
    if "maxItems" in rule and (not isinstance(value, list) or len(value) > rule["maxItems"]):
        out.append(Deviation(where, "maxItems", rule["maxItems"], len(value) if isinstance(value, list) else value))
    if "required" in rule:
        missing = [k for k in rule["required"] if not isinstance(value, dict) or k not in value]
        if missing:
            out.append(Deviation(where, "required", rule["required"], f"missing {missing}"))
    if rule.get("notEmpty") and value in (None, "", [], {}):
        out.append(Deviation(where, "notEmpty", "a non-empty value", value))
    return out


def deref(schema, root):
    """Follows local $ref chains ("#/components/schemas/X") against the root document."""
    hops = 0
    while isinstance(schema, dict) and "$ref" in schema and hops < 20:
        ref = schema["$ref"]
        if not ref.startswith("#/"):
            raise ValueError(f"unsupported $ref {ref}")
        node = root
        for part in ref[2:].split("/"):
            part = part.replace("~1", "/").replace("~0", "~")
            if not isinstance(node, dict) or part not in node:
                raise ValueError(f"unresolved $ref {ref}")
            node = node[part]
        schema, hops = node, hops + 1
    return schema


def _has_ref(schema):
    if isinstance(schema, dict):
        return "$ref" in schema or any(_has_ref(v) for v in schema.values())
    if isinstance(schema, list):
        return any(_has_ref(v) for v in schema)
    return False


def validate_schema(instance, schema, root=None, where="$"):
    """Returns deviations of instance against schema. root is the document that local $refs point into."""
    root = schema if root is None else root
    if not _has_ref(schema):
        try:
            import jsonschema  # optional
        except ImportError:
            jsonschema = None
        if jsonschema is not None:
            try:
                validator = jsonschema.validators.validator_for(schema)(schema, format_checker=jsonschema.FormatChecker())
                return [Deviation(where + ("." + ".".join(str(p) for p in e.absolute_path) if e.absolute_path else ""),
                                  e.validator, e.validator_value, e.message) for e in validator.iter_errors(instance)]
            except Exception:  # fall back to the subset on any library problem
                pass
    return _subset(instance, schema, root, where)


def _subset(instance, schema, root, where):
    try:
        schema = deref(schema, root)
    except ValueError as error:
        return [Deviation(where, "$ref", str(error), "unresolved")]
    if not isinstance(schema, dict):
        return []
    if instance is None and schema.get("nullable"):
        return []
    out = []
    declared = schema.get("type")
    if declared is not None:
        types = declared if isinstance(declared, list) else [declared]
        if not any(type_ok(instance, t) for t in types):
            return [Deviation(where, "type", declared, type(instance).__name__)]
    for keyword in ("allOf", "anyOf", "oneOf"):
        if keyword in schema:
            results = [_subset(instance, s, root, where) for s in schema[keyword]]
            passing = sum(1 for r in results if not r)
            if keyword == "allOf":
                out.extend(d for r in results for d in r)
            elif keyword == "anyOf" and passing == 0:
                out.append(Deviation(where, "anyOf", "one matching schema", "none matched"))
            elif keyword == "oneOf" and passing != 1:
                out.append(Deviation(where, "oneOf", "exactly one matching schema", f"{passing} matched"))
    if "enum" in schema and instance not in schema["enum"]:
        out.append(Deviation(where, "enum", schema["enum"], instance))
    if "const" in schema and instance != schema["const"]:
        out.append(Deviation(where, "const", schema["const"], instance))
    if isinstance(instance, str):
        checker = FORMATS.get(schema.get("format"))
        if checker and not checker(instance):
            out.append(Deviation(where, "format", schema["format"], instance))
        if "pattern" in schema and not re.search(schema["pattern"], instance):
            out.append(Deviation(where, "pattern", schema["pattern"], instance))
        if "minLength" in schema and len(instance) < schema["minLength"]:
            out.append(Deviation(where, "minLength", schema["minLength"], len(instance)))
        if "maxLength" in schema and len(instance) > schema["maxLength"]:
            out.append(Deviation(where, "maxLength", schema["maxLength"], len(instance)))
    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            out.append(Deviation(where, "minimum", schema["minimum"], instance))
        if "maximum" in schema and instance > schema["maximum"]:
            out.append(Deviation(where, "maximum", schema["maximum"], instance))
        if "exclusiveMinimum" in schema and isinstance(schema["exclusiveMinimum"], (int, float)) and instance <= schema["exclusiveMinimum"]:
            out.append(Deviation(where, "exclusiveMinimum", schema["exclusiveMinimum"], instance))
        if "exclusiveMaximum" in schema and isinstance(schema["exclusiveMaximum"], (int, float)) and instance >= schema["exclusiveMaximum"]:
            out.append(Deviation(where, "exclusiveMaximum", schema["exclusiveMaximum"], instance))
    if isinstance(instance, dict):
        for key in schema.get("required", []):
            if key not in instance:
                out.append(Deviation(f"{where}.{key}", "required", "present", "missing"))
        properties = schema.get("properties", {})
        extra = schema.get("additionalProperties", True)
        for key, value in instance.items():
            if key in properties:
                out.extend(_subset(value, properties[key], root, f"{where}.{key}"))
            elif extra is False:
                out.append(Deviation(f"{where}.{key}", "additionalProperties", "not allowed", "present"))
            elif isinstance(extra, dict):
                out.extend(_subset(value, extra, root, f"{where}.{key}"))
    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            out.append(Deviation(where, "minItems", schema["minItems"], len(instance)))
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            out.append(Deviation(where, "maxItems", schema["maxItems"], len(instance)))
        if schema.get("uniqueItems") and len({repr(v) for v in instance}) != len(instance):
            out.append(Deviation(where, "uniqueItems", "unique items", "duplicates"))
        items = schema.get("items")
        if isinstance(items, dict):
            for i, value in enumerate(instance):
                out.extend(_subset(value, items, root, f"{where}[{i}]"))
    return out


def _empty_collection(body, path):
    """True when a wildcard path matched nothing only because the list before its first [*] exists and is empty."""
    if "[*]" not in path:
        return False
    prefix = path[: path.index("[*]")]
    try:
        parents = get_path(body, prefix)
    except ValueError:
        return False
    return bool(parents) and all(isinstance(value, list) for _, value in parents)


def validate_response(resp, expect, root=None):
    """resp: {"status", "headers" (lower-case names), "json", "text"}. Returns deviations against expect."""
    out = []
    expected_status = expect.get("status")
    if expected_status is not None:
        allowed = expected_status if isinstance(expected_status, list) else [expected_status]
        if resp["status"] not in allowed:
            out.append(Deviation("status", "status", expected_status, resp["status"]))
    headers = resp.get("headers") or {}
    for name, rule in (expect.get("headers") or {}).items():
        actual = headers.get(name.lower())
        where = f"header {name}"
        if actual is None:
            out.append(Deviation(where, "present", rule, "missing"))
        elif isinstance(rule, str):
            if actual != rule:
                out.append(Deviation(where, "equals", rule, actual))
        elif isinstance(rule, dict):
            if "contains" in rule and rule["contains"] not in actual:
                out.append(Deviation(where, "contains", rule["contains"], actual))
            if "regex" in rule and not re.search(rule["regex"], actual):
                out.append(Deviation(where, "regex", rule["regex"], actual))
    body = resp.get("json")
    rules = expect.get("body") or {}
    if rules and body is None:
        out.append(Deviation("body", "json", "a JSON body", "not JSON"))
    else:
        for path, rule in rules.items():
            try:
                matches = get_path(body, path)
            except ValueError as error:
                out.append(Deviation(path, "path", "a valid path", str(error)))
                continue
            if not matches:
                if not rule.get("optional") and not _empty_collection(body, path):
                    out.append(Deviation(path, "present", "a value", "missing"))
                continue
            for pointer, value in matches:
                out.extend(check_rule(value, rule, pointer))
    if expect.get("schema") is not None:
        if body is None:
            out.append(Deviation("body", "schema", "a JSON body", "not JSON"))
        else:
            out.extend(validate_schema(body, expect["schema"], root=root))
    graphql_errors = expect.get("graphqlErrors")
    if graphql_errors:
        errors = body.get("errors") if isinstance(body, dict) else None
        if graphql_errors == "none" and errors:
            out.append(Deviation("$.errors", "graphqlErrors", "none", errors[:3] if isinstance(errors, list) else errors))
        if graphql_errors == "present" and not errors:
            out.append(Deviation("$.errors", "graphqlErrors", "present", "none"))
    return out
