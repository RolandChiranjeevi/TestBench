"""Builds one HTTP request from an api-plan.json item and a target profile.

Secrets come only from ${env:NAME} placeholders resolved at build time; the prepared request can
describe itself redacted for evidence.
"""
import base64
import json
import os
import re
import uuid
from dataclasses import dataclass
from urllib.parse import urlencode

from apitest.redact import redact_headers, redact_json, redact_text, redact_url

PLACEHOLDER = re.compile(r"\$\{(env|capture):([A-Za-z_][A-Za-z0-9_]*)\}")
INVALID_TOKEN = "invalid.token.for-testing"


class RequestError(Exception):
    """The request cannot be built: missing variable, unknown option, host outside the target."""


@dataclass
class PreparedRequest:
    method: str
    url: str
    headers: dict
    body: bytes | None
    body_type: str
    body_preview: object = None

    def redacted(self):
        preview = self.body_preview
        if isinstance(preview, (dict, list)):
            preview = redact_json(preview)
        elif preview is not None:
            preview = redact_text(preview)
        return {"method": self.method, "url": redact_url(self.url), "headers": redact_headers(self.headers),
                "bodyType": self.body_type, "body": preview}


def resolve(value, env, captures=None):
    """Replaces ${env:NAME} and ${capture:name} in strings, recursively through dicts and lists."""
    if isinstance(value, str):
        def substitute(match):
            kind, name = match.group(1), match.group(2)
            if kind == "env":
                found = env.get(name)
                if found in (None, ""):
                    raise RequestError(f"environment variable {name} is not set")
                return found
            if captures is None or name not in captures:
                raise RequestError(f"capture {name} is not available")
            return str(captures[name])
        return PLACEHOLDER.sub(substitute, value)
    if isinstance(value, dict):
        return {k: resolve(v, env, captures) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve(v, env, captures) for v in value]
    return value


def _multipart(fields):
    boundary = "----TestPilot" + uuid.uuid4().hex
    out = bytearray()
    for name, value in fields.items():
        out += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def encode_body(spec, env, captures=None):
    """Returns (bytes or None, content type or None, body type, preview for evidence)."""
    body_type = spec.get("bodyType")
    if body_type == "graphql" or (body_type is None and "graphql" in spec):
        graphql = resolve(spec.get("graphql") or {}, env, captures)
        payload = {"query": graphql.get("query", ""), "variables": graphql.get("variables") or {}}
        if graphql.get("operationName"):
            payload["operationName"] = graphql["operationName"]
        return json.dumps(payload).encode(), "application/json", "graphql", payload
    body = spec.get("body")
    if body is None:
        return None, None, body_type or "none", None
    body = resolve(body, env, captures)
    if body_type in (None, "json"):
        if isinstance(body, (dict, list)):
            return json.dumps(body).encode(), "application/json", "json", body
        return str(body).encode(), spec.get("contentType", "text/plain"), "raw", str(body)
    if body_type == "form":
        if not isinstance(body, dict):
            raise RequestError("a form body must be an object")
        return urlencode(body, doseq=True).encode(), "application/x-www-form-urlencoded", "form", body
    if body_type == "multipart":
        if not isinstance(body, dict):
            raise RequestError("a multipart body must be an object")
        data, content_type = _multipart({k: str(v) for k, v in body.items()})
        return data, content_type, "multipart", body
    if body_type == "raw":
        return str(body).encode(), spec.get("contentType", "text/plain"), "raw", str(body)
    raise RequestError(f"unknown bodyType {body_type}")


def auth_headers(profile_auth, mode, env, tokens=None):
    """Headers for an item's auth mode: default, none, invalid, expired or second.

    tokens maps a mode to the credential the runner obtained (a token, a cookie value, or
    "user:password" for basic auth). Without one, the default mode falls back to tokenEnvVar.
    """
    mode = mode or "default"
    profile_auth = profile_auth or {}
    auth_type = profile_auth.get("type", "none")
    if mode == "none" or auth_type == "none":
        return {}
    cookie_name = profile_auth.get("cookieName", "session")
    if mode == "invalid":
        if auth_type == "cookie":
            return {"Cookie": f"{cookie_name}={INVALID_TOKEN}"}
        if auth_type == "header":
            return {profile_auth.get("headerName", "X-Api-Key"): INVALID_TOKEN}
        return {"Authorization": f"Bearer {INVALID_TOKEN}"}
    if mode == "expired":
        variable = profile_auth.get("expiredTokenEnvVar")
        if not variable:
            raise RequestError("the profile has no expiredTokenEnvVar")
        value = env.get(variable)
        if not value:
            raise RequestError(f"environment variable {variable} is not set")
    elif mode in ("default", "second"):
        value = (tokens or {}).get(mode)
        if value is None and mode == "default" and profile_auth.get("tokenEnvVar"):
            value = env.get(profile_auth["tokenEnvVar"])
            if not value:
                raise RequestError(f"environment variable {profile_auth['tokenEnvVar']} is not set")
        if value is None:
            raise RequestError(f"no credentials available for auth mode {mode}")
    else:
        raise RequestError(f"unknown auth mode {mode}")
    if auth_type == "bearer":
        return {"Authorization": f"Bearer {value}"}
    if auth_type == "cookie":
        return {"Cookie": f"{cookie_name}={value}"}
    if auth_type == "header":
        return {profile_auth.get("headerName", "X-Api-Key"): str(value)}
    if auth_type == "basic":
        return {"Authorization": "Basic " + base64.b64encode(str(value).encode()).decode()}
    raise RequestError(f"unknown auth type {auth_type}")


def build_request(spec, profile, env=None, captures=None, auth=None):
    """Builds a PreparedRequest. Every URL must be under the profile's baseUrl."""
    env = os.environ if env is None else env
    base = str(profile.get("baseUrl", "")).rstrip("/")
    if not base.startswith(("http://", "https://")):
        raise RequestError("the target profile has no http(s) baseUrl")
    path = resolve(spec.get("path", "/"), env, captures)
    if "://" in path:
        if path != base and not path.startswith(base + "/") and not path.startswith(base + "?"):
            raise RequestError(f"url {redact_url(path)} is outside the target base URL")
        url = path
    else:
        url = base + (path if path.startswith("/") else "/" + path)
    query = resolve(spec.get("query") or {}, env, captures)
    if query:
        url += ("&" if "?" in url else "?") + urlencode(query, doseq=True)
    headers = {}
    headers.update(resolve(profile.get("headers") or {}, env, captures))
    headers.update(resolve(spec.get("headers") or {}, env, captures))
    body, content_type, body_type, preview = encode_body(spec, env, captures)
    if content_type and not any(k.lower() == "content-type" for k in headers):
        headers["Content-Type"] = content_type
    headers.update(auth or {})
    method = str(spec.get("method", "GET")).upper()
    return PreparedRequest(method, url, headers, body, body_type, preview)
