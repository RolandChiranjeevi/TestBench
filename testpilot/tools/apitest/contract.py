"""Compares requests and responses with an OpenAPI 3 document (JSON) or a GraphQL schema.

OpenAPI: path and method documented, status documented, response and request bodies match the
schemas (local $ref resolved). GraphQL: basic only, as agreed: top-level fields of the operation exist
on the root type, data keys match the schema, and leaf scalar types match. Full GraphQL validation is
out of scope.
"""
import json
import os
import re

from apitest.validate import Deviation, deref, type_ok, validate_schema

SCALARS = {"String": "string", "ID": "string", "Int": "integer", "Float": "number", "Boolean": "boolean"}


def load_contract(schema_cfg, base_dir="."):
    """Returns the loaded contract, or None without configuration. Reads files only; URLs belong to discover."""
    if not schema_cfg:
        return None
    path = schema_cfg.get("file")
    if not path:
        raise ValueError("schema.file is required for the runner (schema.url is read by discover)")
    full = path if os.path.isabs(path) else os.path.join(base_dir, path)
    with open(full, encoding="utf-8") as handle:
        text = handle.read()
    kind = schema_cfg.get("type", "openapi")
    if kind == "openapi":
        doc = json.loads(text)
        if "paths" not in doc:
            raise ValueError("not an OpenAPI document: no paths")
        return {"kind": "openapi", "doc": doc}
    if kind == "graphql":
        return graphql_from_introspection(json.loads(text)) if path.endswith(".json") else graphql_from_sdl(text)
    raise ValueError(f"unknown schema type {kind}")


# ---------- OpenAPI ----------

def match_path(doc, path):
    """Finds the template for a concrete path (/items/42 -> /items/{id}). Returns (template, params) or (None, {})."""
    concrete = path.split("?", 1)[0].rstrip("/").split("/")
    best = None
    for template in doc.get("paths", {}):
        parts = template.rstrip("/").split("/")
        if len(parts) != len(concrete):
            continue
        params, literal, ok = {}, 0, True
        for t, s in zip(parts, concrete):
            if t.startswith("{") and t.endswith("}"):
                params[t[1:-1]] = s
            elif t == s:
                literal += 1
            else:
                ok = False
                break
        if ok and (best is None or literal > best[2]):
            best = (template, params, literal)
    return (best[0], best[1]) if best else (None, {})


def _json_schema_of(content):
    if not isinstance(content, dict):
        return None
    for content_type, media in content.items():
        if "json" in content_type.lower() and isinstance(media, dict):
            return media.get("schema")
    return None


def check_openapi(contract, method, path, status, response_json=None, request_json=None):
    doc = contract["doc"]
    template, _ = match_path(doc, path)
    label = f"{method.upper()} {path}"
    if template is None:
        return [Deviation(label, "path", "a documented path", "not in the OpenAPI document")]
    operation = doc["paths"][template].get(method.lower())
    if not isinstance(operation, dict):
        return [Deviation(f"{method.upper()} {template}", "method", "a documented method", "not documented")]
    responses = operation.get("responses", {})
    definition = responses.get(str(status)) or responses.get(f"{str(status)[0]}XX") or responses.get("default")
    out = []
    if definition is None:
        return [Deviation(f"{method.upper()} {template}", "status", sorted(responses), status)]
    try:
        definition = deref(definition, doc)
        schema = _json_schema_of(definition.get("content")) if isinstance(definition, dict) else None
        if schema is not None and response_json is not None:
            out.extend(Deviation(f"response {d.where}", d.rule, d.expected, d.actual) for d in validate_schema(response_json, schema, root=doc))
        if request_json is not None:
            body = deref(operation.get("requestBody") or {}, doc)
            request_schema = _json_schema_of(body.get("content")) if isinstance(body, dict) else None
            if request_schema is not None:
                out.extend(Deviation(f"request {d.where}", d.rule, d.expected, d.actual) for d in validate_schema(request_json, request_schema, root=doc))
    except ValueError as error:
        out.append(Deviation(f"{method.upper()} {template}", "$ref", "a resolvable reference", str(error)))
    return out


# ---------- GraphQL ----------

TYPE_BLOCK = re.compile(r"\b(type|interface|input)\s+([A-Za-z_][A-Za-z0-9_]*)[^{]*\{([^}]*)\}", re.S)
FIELD = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\[\]A-Za-z0-9_!]+)")
ARGS = re.compile(r"\([^)]*\)")


def _base_type(name):
    return name.replace("[", "").replace("]", "").replace("!", "")


def graphql_from_sdl(text):
    text = re.sub(r'"""[\s\S]*?"""', "", text)
    text = re.sub(r"#.*", "", text)
    # Commas are whitespace in GraphQL; argument lists are dropped so "item(id: ID!): Item" keeps only the field.
    types = {name: {field: _base_type(kind) for field, kind in FIELD.findall(ARGS.sub("", body).replace(",", "\n"))}
             for _, name, body in TYPE_BLOCK.findall(text)}
    query, mutation = "Query", "Mutation"
    schema_block = re.search(r"\bschema\s*\{([^}]*)\}", text)
    if schema_block:
        found_query = re.search(r"query\s*:\s*(\w+)", schema_block.group(1))
        found_mutation = re.search(r"mutation\s*:\s*(\w+)", schema_block.group(1))
        query = found_query.group(1) if found_query else query
        mutation = found_mutation.group(1) if found_mutation else mutation
    return {"kind": "graphql", "types": types, "query": query, "mutation": mutation}


def graphql_from_introspection(doc):
    schema = (doc.get("data") or {}).get("__schema") if isinstance(doc.get("data"), dict) else doc.get("__schema")
    if not schema:
        raise ValueError("not an introspection result: no __schema")

    def base(type_ref):
        while type_ref and type_ref.get("ofType"):
            type_ref = type_ref["ofType"]
        return (type_ref or {}).get("name")

    types = {t["name"]: {f["name"]: base(f["type"]) for f in t.get("fields") or []} for t in schema.get("types", []) if t.get("fields")}
    return {"kind": "graphql", "types": types, "query": (schema.get("queryType") or {}).get("name") or "Query",
            "mutation": (schema.get("mutationType") or {}).get("name") or "Mutation"}


def selection(query_text):
    """(operation, [top-level field names]) of a simple document; aliases resolved to the field name."""
    text = re.sub(r"#.*", "", query_text)
    head = re.match(r"\s*(query|mutation|subscription)?\s*[A-Za-z_0-9]*\s*(\([^)]*\))?\s*\{", text)
    if not head:
        return "query", []
    operation = head.group(1) or "query"
    i, depth, names = head.end(), 0, []
    while i < len(text):
        char = text[i]
        if char == "{":
            depth += 1
        elif char == "}":
            if depth == 0:
                break
            depth -= 1
        elif char == "(" and depth == 0:
            i = text.find(")", i)
            if i < 0:
                break
        elif depth == 0 and (char.isalnum() or char == "_"):
            j = i
            while j < len(text) and (text[j].isalnum() or text[j] == "_"):
                j += 1
            k = j
            while k < len(text) and text[k] in " \t\r\n":
                k += 1
            if k < len(text) and text[k] == ":":  # alias: the field follows
                i = k + 1
                continue
            names.append(text[i:j])
            i = j
            continue
        i += 1
    return operation, names


def _check_value(value, type_name, contract, where, depth=0):
    if value is None or depth > 6:
        return []
    if isinstance(value, list):
        return [d for i, item in enumerate(value) for d in _check_value(item, type_name, contract, f"{where}[{i}]", depth + 1)]
    if type_name in SCALARS:
        expected = SCALARS[type_name]
        ok = type_ok(value, expected) or (expected == "number" and type_ok(value, "integer"))
        return [] if ok else [Deviation(where, "type", type_name, type(value).__name__)]
    fields = contract["types"].get(type_name)
    if fields is None or not isinstance(value, dict):
        return []
    out = []
    for key, item in value.items():
        if key == "__typename":
            continue
        if key not in fields:
            out.append(Deviation(f"{where}.{key}", "field", f"a field of {type_name}", "not in schema"))
            continue
        out.extend(_check_value(item, fields[key], contract, f"{where}.{key}", depth + 1))
    return out


def check_graphql(contract, query_text, response_json=None):
    operation, fields = selection(query_text)
    root_name = contract["mutation"] if operation == "mutation" else contract["query"]
    root = contract["types"].get(root_name)
    if root is None:
        return [Deviation(root_name, "type", "a root type in the schema", "missing")]
    out = [Deviation(f"{operation}.{f}", "field", f"a field of {root_name}", "not in schema") for f in fields if f not in root]
    data = response_json.get("data") if isinstance(response_json, dict) else None
    if isinstance(data, dict):
        for key, value in data.items():
            if key not in root:
                out.append(Deviation(f"$.data.{key}", "field", f"a field of {root_name}", "not in schema"))
            else:
                out.extend(_check_value(value, root[key], contract, f"$.data.{key}"))
    return out


def check(contract, prepared, request_spec, resp):
    """Dispatches on the contract kind. Returns deviations (empty when there is no contract)."""
    if not contract:
        return []
    if contract["kind"] == "openapi":
        from urllib.parse import urlsplit
        path = urlsplit(prepared.url).path
        request_json = prepared.body_preview if prepared.body_type == "json" else None
        return check_openapi(contract, prepared.method, path, resp["status"], resp.get("json"), request_json)
    if prepared.body_type == "graphql" and isinstance(prepared.body_preview, dict):
        return check_graphql(contract, prepared.body_preview.get("query", ""), resp.get("json"))
    return []
