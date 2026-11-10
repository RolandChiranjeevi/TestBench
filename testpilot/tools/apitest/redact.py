"""Masks secrets before anything is written: headers, JSON bodies, URLs and free text.

runner.py passes every request and response through here before storing evidence, and refuses a
target profile that holds a literal secret (find_literal_secrets).
"""
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

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


def redact_url(url):
    parts = urlsplit(str(url))
    if not parts.query:
        return str(url)
    query = [(k, MASK if is_secret_key(k) else v) for k, v in parse_qsl(parts.query, keep_blank_values=True)]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


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
