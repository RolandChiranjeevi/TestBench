#!/usr/bin/env python3
"""testpilot doctor, version 1: is this agent folder set up so that a request can run? It only reads, and it never prints a token.

    python3 -I testpilot/tools/doctor.py [--offline]

Run it from the folder that holds `.testpilot/`. Each line is `ok`, `warn` or `fail`; the exit code is 1 if there is a `fail`.
  config       the project profile can be read and has what the helper needs (project id, token variable, permission mode, a valid address)
  token        the token variable named by the profile is set (in the environment or as its own line of `.env`) and looks like a request token. The value is never printed.
  server       one read-only call (the same as `request_call.py list`) shows that the address answers and that the token is accepted for the project. `--offline` skips it.
  permissions  `.claude/settings.local.json` against the lists in `docs/agent-requests.md`: a deny rule that every list has but this file lacks is a `fail`,
               an allow rule that no list has is a `warn`
  git          the profile, the rules file and `origin` agree (`spec_git.py`'s own checks); a git mode of `off` is fine
  skills       whether the skills, the references, the tools and the docs of this folder are `ok`, `stale` (origin/main has changes this folder lacks, as of your
               last fetch: nothing is fetched here) or `modified` (changed here)
Nothing is written, nothing is fetched, and the only network call is the one of `server`, to the address the profile already names. Python standard library only.
Tests: testpilot/tests/test_doctor.py.
"""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import request_call  # noqa: E402
import spec_git  # noqa: E402

DOCS = "docs/agent-requests.md"
SETTINGS = ".claude/settings.local.json"
WATCHED = (".claude/skills", ".claude/references", "testpilot/tools", DOCS)
VARIABLE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}")


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def say(status, name, detail):
    return status, f"{status:<4} {name}: {detail}"


def config():
    """(lines, what the other checks need or None)."""
    try:
        g = load(".testpilot/testbench.json")
        p = load(f".testpilot/projects/{g['activeProject']}.json")
        base, pid, var = str(g["baseUrl"]).rstrip("/"), p["projectId"], p.get("requestTokenEnvVar")
    except (OSError, ValueError, KeyError, AttributeError, TypeError) as e:
        return [say("fail", "config", f".testpilot/testbench.json and the profile it names could not be read ({type(e).__name__})")], None
    problems = []
    if not re.fullmatch(r"[0-9]{1,9}", str(pid)):
        problems.append("projectId must be a number")
    if not isinstance(var, str) or not VARIABLE.fullmatch(var):
        problems.append("requestTokenEnvVar must name an environment variable")
    if p.get("permissionMode") not in ("observe_only", "full"):
        problems.append("permissionMode must be observe_only or full")
    host = request_call.urlsplit(base)
    if host.scheme not in ("http", "https") or not host.hostname:
        problems.append("baseUrl must be an http or https address")
    elif host.scheme == "http" and host.hostname not in request_call.LOCAL_HOSTS:
        problems.append("plain http to a non-local host is refused by the helper")
    if problems:
        return [say("fail", "config", "; ".join(problems))], None
    key = p.get("projectKey") if isinstance(p.get("projectKey"), str) else "?"
    return [say("ok", "config", f"project {pid} ({key}), permissionMode {p['permissionMode']}, gitMode {p.get('gitMode', 'off')}")], {"base": base, "pid": str(pid), "var": var}


def token(var):
    val = request_call.env_value(var)
    if not val:
        return [say("fail", "token", f"{var} is not set, in the environment or as its own line of .env")], None
    if not request_call.TOKEN.fullmatch(val):
        return [say("fail", "token", f"{var} is set, but it is not a request token (it starts with tbrq_)")], None
    where = "the environment" if os.environ.get(var) else ".env"
    return [say("ok", "token", f"{var} is set in {where} and looks like a request token")], val


def server(base, pid, tok):
    url = f"{base}/api/agent/projects/{pid}/requests"
    try:
        code, _ = request_call.send("GET", url, {"Authorization": "Bearer " + tok}, None, 10)
    except Exception as e:  # the kind of failure only: nothing here may carry the header
        return [say("fail", "server", f"{base} could not be reached ({type(e).__name__})")]
    if code == 200:
        return [say("ok", "server", f"{base} answers and accepts the token for project {pid}")]
    if code in (401, 403):
        return [say("fail", "server", f"HTTP {code}: the token is refused (revoked, or made for another project?)")]
    if code == 404:
        return [say("fail", "server", f"HTTP 404: project {pid} was not found on {base}")]
    return [say("warn", "server", f"HTTP {code} from {base}")]


def rule_key(rule):
    return re.sub(r"^Write\(//.*/audits/\*\*\)$", "Write(//<agent folder>/audits/**)", rule)  # the absolute path of the folder is the person's own


def permissions():
    try:
        with open(DOCS, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return [say("warn", "permissions", f"{DOCS} was not found here, so the list was not compared")]
    blocks = []
    for m in re.finditer(r"```json\n(.*?)\n```", text, re.S):
        try:
            perms = json.loads(m.group(1)).get("permissions")
        except (ValueError, AttributeError):
            continue
        if isinstance(perms, dict) and isinstance(perms.get("allow"), list) and isinstance(perms.get("deny"), list):
            blocks.append(perms)
    if not blocks:
        return [say("warn", "permissions", f"{DOCS} has no permission list to compare with")]
    known = {rule_key(r) for b in blocks for r in b["allow"]}
    required = set.intersection(*[{rule_key(r) for r in b["deny"]} for b in blocks])
    try:
        mine = load(SETTINGS).get("permissions", {})
        allow, deny = {rule_key(r) for r in mine.get("allow", [])}, {rule_key(r) for r in mine.get("deny", [])}
    except OSError:
        return [say("warn", "permissions", f"{SETTINGS} does not exist: nothing is allowed or denied in advance, so a run asks at every step")]
    except (ValueError, AttributeError, TypeError):
        return [say("fail", "permissions", f"{SETTINGS} could not be read as a permission list")]
    missing, extra = sorted(required - deny), sorted(allow - known)
    if missing:
        return [say("fail", "permissions", "denied in every list of the docs but not here: " + ", ".join(missing))]
    if extra:
        return [say("warn", "permissions", "allowed here but in no list of the docs: " + ", ".join(extra))]
    return [say("ok", "permissions", f"every deny rule of the docs is here, and nothing more is allowed ({len(allow)} allowed, {len(deny)} denied)")]


def git_mode():
    try:
        ctx = spec_git.inspect()
    except spec_git.Stop as s:
        if "gitMode is off" in s.reason:
            return [say("ok", "git", "git mode is off in the profile: no spec files are made")]
        return [say("warn" if s.off else "fail", "git", s.reason)]
    return [say("ok", "git", f"the profile, the rules file and origin agree on {ctx['rules']['repo']} (ceiling {ctx['ceiling']})")]


def git(*args):
    return subprocess.run(["git", "--no-optional-locks", *args], capture_output=True, text=True, timeout=30)


def skills():
    try:
        if git("rev-parse", "--is-inside-work-tree").stdout.strip() != "true":
            raise OSError
    except (OSError, subprocess.SubprocessError):
        return [say("warn", "skills", "this folder is not a git checkout, so it cannot be told whether the skills are current")]
    if git("rev-parse", "--verify", "--quiet", "refs/remotes/origin/main").returncode != 0:
        return [say("warn", "skills", "there is no origin/main here: fetch it, and run this again")]
    changed = [x[3:] for x in git("status", "--porcelain", "--", *WATCHED).stdout.splitlines() if len(x) > 3]
    behind = git("rev-list", "--count", "HEAD..origin/main", "--", *WATCHED).stdout.strip()
    if changed:
        return [say("warn", "skills", "modified here: " + ", ".join(changed[:5]) + (" ..." if len(changed) > 5 else ""))]
    if behind not in ("", "0"):
        return [say("warn", "skills", f"stale: origin/main has {behind} change(s) to the skills, tools or docs that this folder lacks (as of your last fetch)")]
    return [say("ok", "skills", "the skills, references, tools and docs match origin/main (as of your last fetch)")]


def run(offline=False):
    results, ctx = config()
    if ctx:
        got, tok = token(ctx["var"])
        results += got
        if tok and not offline:
            results += server(ctx["base"], ctx["pid"], tok)
    return results + permissions() + git_mode() + skills()


def main(argv):
    if any(a != "--offline" for a in argv):
        print("Usage: doctor.py [--offline]")
        return 1
    results = run("--offline" in argv)
    for _, text in results:
        print(request_call.TOKEN.sub("tbrq_[redacted]", text))  # a rule or a path can never carry a token out
    n = {s: sum(1 for x, _ in results if x == s) for s in ("ok", "warn", "fail")}
    print(f"doctor: {n['ok']} ok, {n['warn']} warn, {n['fail']} fail")
    return 1 if n["fail"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
