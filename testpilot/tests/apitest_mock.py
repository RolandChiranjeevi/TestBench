"""In-process mock API for the apitest tests. Listens on 127.0.0.1 only. Credentials here are synthetic."""
import json
import re
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

USERS = {"alice": "s3cret-pass", "bob": "b0b-pass"}
TOKENS = {"alice": "tok-alice-" + "a" * 24, "bob": "tok-bob-" + "b" * 24}
ALICE_ID = "6f1c6e6a-2b7e-4a1e-9f3d-1c2b3a4d5e6f"


class MockApi:
    def __init__(self):
        self.items, self.names, self.calls, self.limited_hits = {}, {}, [], 0
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self):
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"

    def start(self):
        self.thread.start()
        return self

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def _handler(self):
        api = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def _send(self, status, body=None, headers=None):
                data = json.dumps(body).encode() if body is not None else b""
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                for name, value in (headers or {}).items():
                    self.send_header(name, value)
                self.end_headers()
                if data:
                    self.wfile.write(data)

            def _user(self):
                auth = self.headers.get("Authorization", "")
                token = auth[7:] if auth.startswith("Bearer ") else None
                return next((u for u, t in TOKENS.items() if t == token), None)

            def _json(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    return json.loads(raw) if raw else None
                except ValueError:
                    return None

            def do_GET(self):
                self._route()

            def do_POST(self):
                self._route()

            def do_PUT(self):
                self._route()

            def do_DELETE(self):
                self._route()

            def _route(self):
                api.calls.append((self.command, self.path))
                parts = urlsplit(self.path)
                path, query = parts.path, parse_qs(parts.query)
                body = self._json() if self.command in ("POST", "PUT") else None
                if self.command == "POST" and path == "/api/login":
                    if isinstance(body, dict) and USERS.get(body.get("username")) == body.get("password"):
                        return self._send(200, {"token": TOKENS[body["username"]]})
                    return self._send(401, {"error": "bad credentials"})
                if path == "/api/limited" and self.command == "GET":
                    api.limited_hits += 1
                    if api.limited_hits > 2:
                        return self._send(429, {"error": "slow down"}, {"Retry-After": "5"})
                    return self._send(200, {"ok": True})
                if path == "/graphql" and self.command == "POST":
                    if "viewer" in (body or {}).get("query", ""):
                        return self._send(200, {"data": {"viewer": {"id": ALICE_ID, "email": "alice@example.test"}}})
                    return self._send(200, {"errors": [{"message": "Cannot query field"}], "data": None})
                if path == "/api/boom":
                    return self._send(500, {"error": "boom"})
                user = self._user()
                if path.startswith("/api/") and user is None:
                    return self._send(401, {"error": "unauthorized"})
                if path == "/api/me":
                    return self._send(200, {"id": ALICE_ID if user == "alice" else "not-a-uuid", "email": f"{user}@example.test", "name": user.title()})
                if path == "/api/admin":
                    return self._send(200, {"ok": True}) if user == "alice" else self._send(403, {"error": "forbidden"})
                if path == "/api/items" and self.command == "GET":
                    limit = int(query.get("limit", ["100"])[0])
                    return self._send(200, {"items": list(api.items.values())[:limit], "total": len(api.items)})
                if path == "/api/items" and self.command == "POST":
                    name = (body or {}).get("name")
                    if not name:
                        return self._send(422, {"error": "name is required"})
                    if name in api.names:
                        return self._send(409, {"error": "exists", "id": api.names[name]})
                    item_id = str(uuid.uuid4())
                    api.items[item_id] = {"id": item_id, "name": name, "email": "owner@example.test"}
                    api.names[name] = item_id
                    return self._send(201, api.items[item_id])
                match = re.match(r"^/api/items/([^/]+)$", path)
                if match:
                    item = api.items.get(match.group(1))
                    if self.command == "GET":
                        return self._send(200, item) if item else self._send(404, {"error": "not found"})
                    if self.command == "PUT":
                        if not item:
                            return self._send(404, {"error": "not found"})
                        if not (body or {}).get("name"):
                            return self._send(422, {"error": "name must not be empty"})
                        item["name"] = body["name"]
                        return self._send(200, item)
                    if self.command == "DELETE":
                        if not item:
                            return self._send(404, {"error": "not found"})
                        api.names.pop(item["name"], None)
                        del api.items[match.group(1)]
                        return self._send(204)
                return self._send(404, {"error": "no route"})

        return Handler


OPENAPI = {
    "openapi": "3.0.3", "info": {"title": "Mock", "version": "1"},
    "components": {"schemas": {
        "User": {"type": "object", "required": ["id", "email"], "properties": {"id": {"type": "string", "format": "uuid"}, "email": {"type": "string", "format": "email"}, "name": {"type": "string"}}},
        "Item": {"type": "object", "required": ["id", "name"], "properties": {"id": {"type": "string", "format": "uuid"}, "name": {"type": "string"}, "email": {"type": "string", "format": "email"}}},
        "ItemList": {"type": "object", "required": ["items"], "properties": {"items": {"type": "array", "items": {"$ref": "#/components/schemas/Item"}}, "total": {"type": "integer"}}},
        "NewItem": {"type": "object", "required": ["name"], "properties": {"name": {"type": "string", "minLength": 1}}},
        "Error": {"type": "object", "required": ["error"], "properties": {"error": {"type": "string"}}},
    }},
    "paths": {
        "/api/login": {"post": {"responses": {"200": {"content": {"application/json": {"schema": {"type": "object", "required": ["token"]}}}}, "401": {"description": "x"}}}},
        "/api/me": {"get": {"responses": {"200": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/User"}}}}, "401": {"description": "x"}}}},
        "/api/admin": {"get": {"responses": {"200": {"description": "x"}, "401": {"description": "x"}, "403": {"description": "x"}}}},
        "/api/items": {
            "get": {"responses": {"200": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/ItemList"}}}}}},
            "post": {"requestBody": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/NewItem"}}}},
                     "responses": {"201": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Item"}}}}, "409": {"description": "x"}, "422": {"description": "x"}}}},
        "/api/items/{id}": {
            "get": {"responses": {"200": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Item"}}}}, "404": {"description": "x"}}},
            "put": {"responses": {"200": {"description": "x"}, "404": {"description": "x"}, "422": {"description": "x"}}},
            "delete": {"responses": {"204": {"description": "x"}, "404": {"description": "x"}}}},
        "/api/limited": {"get": {"responses": {"200": {"description": "x"}, "429": {"description": "x"}}}},
    },
}

GRAPHQL_SDL = '''
"""Root"""
type Query {
  viewer: User
  item(id: ID!): Item
}
type Mutation {
  createItem(name: String!): Item
}
type User { id: ID!, email: String! }
type Item { id: ID!, name: String!, count: Int }
'''
