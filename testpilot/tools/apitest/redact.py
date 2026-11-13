"""Masks secrets before anything is written: headers, JSON bodies, URLs and free text.

runner.py passes every request and response through here before storing evidence, and refuses a
target profile that holds a literal secret (find_literal_secrets).
"""
import re
from urllib.parse import parse_qsl, quote, quote_plus, urlencode, urlsplit, urlunsplit

MASK = "[redacted]"
SECRET_KEY = re.compile(r"(password|passwd|secret|token|api[_-]?key|authorization|cookie|session|credential|private[_-]?key)", re.I)
SECRET_HEADERS = {"authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token", "x-csrf-token"}
TEXT_PATTERNS = [
    (re.compile(r"((?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]{8,}", re.I), r"\1" + MASK),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}"), MASK),
    (re.compile(r"\btb(?:ag|ci)_[A-Za-z0-9_-]{6,}"), MASK),
    (re.compile(r"((?:password|passwd|secret|token|api[_-]?key|authorization)[\"']?\s*[=:]\s*[\"']?)([^\s\"'&,;}]+)", re.I), r"\1" + MASK),
]
PLACEHOLDER = re.compile(r"^\$\{(env|capture):[A-Za-z_][A-Za-z0-9_]*\}$")


def is_secret_key(name):
    return bool(SECRET_KEY.search(str(name)))


def redact_text(text):
    if text is None:
        return None
    s = str(text)
    for pattern, replacement in TEXT_PATTERNS:
        s = pattern.sub(replacement, s)
    return s


def redact_headers(headers):
    out = {}
    for name, value in (headers or {}).items():
        lower = str(name).lower()
        if lower in SECRET_HEADERS or is_secret_key(lower):
            text = str(value)
            if lower in ("authorization", "proxy-authorization") and " " in text:
                out[name] = f"{text.split(' ', 1)[0]} {MASK}"
            else:
                out[name] = MASK
        else:
            out[name] = redact_text(value)
    return out


def redact_json(value):
    if isinstance(value, dict):
        return {k: (MASK if is_secret_key(k) and v not in (None, "") else redact_json(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_json(v) for v in value]
    if isinstance(value, str):
        return redact_text(value)
    return value


MIN_SECRET_LENGTH = 4  # shorter values would mask ordinary text; they are masked by key or pattern only


def _variants(secret):
    return {secret, quote(secret, safe=""), quote_plus(secret)}


def mask_secrets(value, secrets):
    """Replaces every known secret value (and its URL-encoded forms) in strings, dict keys and values, lists."""
    needles = sorted({v for s in (secrets or ()) if isinstance(s, str) and len(s) >= MIN_SECRET_LENGTH for v in _variants(s)}, key=len, reverse=True)
    if not needles:
        return value

    def walk(node):
        if isinstance(node, str):
            for needle in needles:
                node = node.replace(needle, MASK)
            return node
        if isinstance(node, dict):
            return {walk(k) if isinstance(k, str) else k: walk(v) for k, v in node.items()}
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node

    return walk(value)


def redact_url(url, secrets=()):
    """Masks userinfo, secret-looking query keys, token patterns in the path and query values, and known secret values."""
    text = str(url)
    parts = urlsplit(text)
    netloc = parts.netloc
    if "@" in netloc:
        netloc = MASK + "@" + netloc.rsplit("@", 1)[1]
    path = redact_text(parts.path)
    query = parts.query
    if query:
        query = urlencode([(k, MASK if is_secret_key(k) else redact_text(v)) for k, v in parse_qsl(query, keep_blank_values=True)])
    fragment = redact_text(parts.fragment)
    cleaned = urlunsplit((parts.scheme, netloc, path, query, fragment)) if (netloc != parts.netloc or path != parts.path or query != parts.query
                                                                         or fragment != parts.fragment) else text
    return mask_secrets(cleaned, secrets)


def find_literal_secrets(profile):
    """Paths in a target profile where a secret-looking key holds a literal value instead of ${env:NAME}.

    Keys ending in EnvVar (a variable name) or Path (a JSON path) are not secrets.
    """
    found = []

    def walk(node, path):
        if isinstance(node, dict):
            for key, value in node.items():
                here = f"{path}.{key}" if path else key
                if isinstance(value, (dict, list)):
                    walk(value, here)
                elif isinstance(value, str) and is_secret_key(key) and not key.lower().endswith(("envvar", "path", "name", "type")) \
                        and not PLACEHOLDER.match(value):
                    found.append(here)
        elif isinstance(node, list):
            for i, value in enumerate(node):
                walk(value, f"{path}[{i}]")

    walk(profile, "")
    return found
