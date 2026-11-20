#!/usr/bin/env python3
"""The one way a TestPilot discover puts Playwright specs into git: on a new LOCAL branch of a checkout the person owns, never anywhere else (git mode `local`).

    python3 -I testpilot/tools/spec_git.py check [--confirmed off|local|pr]
    python3 -I testpilot/tools/spec_git.py write <request number> --confirmed off|local|pr --origin https://the.confirmed.target --specs audits/request-<n>/specs.json

Run it from the folder that holds `.testpilot/`. The agent never runs `git` itself: this tool makes the few git calls it needs, from a fixed list (GIT_OK), with hooks off, no network
and no `GIT_*` variables from the environment. It never fetches, pushes, merges, creates a remote or a repository, or touches the branch the person has checked out.

What it reads (all owned by the person, never by a request):
  - the project profile: `repoPath` (the checkout), `repo` (owner/name), `gitMode` (off|local|pr, default off), `baseBranch` (default main);
  - `TESTPILOT.md` in the repository root, read from `origin/<base>` as the person last fetched it (never from the working folder, never from the agent's own branch).
It stops, and says why, unless the profile, that file and `origin` all name the same repository. Missing checkout, missing `origin/<base>` or missing rules file means mode `off`.

The mode that counts is the lowest of the profile's `gitMode`, the rules file's `mode-max` and what the person confirmed (`--confirmed`). `pr` is not built yet and counts as `local`.

`write` takes {"specs": [{"path": ..., "content": ...}]} and writes every spec as a NEW file `<tests-dir>/<area>/<flow>.spec.ts` in a temporary worktree cut from `origin/<base>`, checks the
paths and the text of every spec, commits, and only then creates the branch `<branch-prefix>discover-<n>` there. Nothing is written if one spec is refused.

Honest limit: the text check below is a rule, not a lock. A text check can be got around by someone who tries; the locks are the person's own review of the branch and CI that runs it
without secrets.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata

ACTIONS = ("check", "write")
MODES = ("off", "local", "pr")  # lowest first; pr counts as local until it is built
TOP = 1
RULES_FILE = "TESTPILOT.md"
RULE_KEYS = {"repo", "base", "mode-max", "branch-prefix", "tests-dir", "allowed-new-paths", "never-touch", "max-files", "max-lines"}
ALWAYS_NEVER = (".git", ".github", "TESTPILOT.md", "package.json", "package-lock.json", "playwright.config.ts", "playwright.config.js")  # in force whatever the rules file says
GIT_OK = {("rev-parse",), ("show",), ("ls-tree",), ("remote", "get-url"), ("worktree", "add"), ("worktree", "remove"), ("worktree", "prune"), ("add",), ("commit",), ("update-ref",)}
PATH_RX = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*")
IMPORT_RX = re.compile(r"import \{[\w\s,]+\} from [\"']@playwright/test[\"'];?")
BANNED = re.compile(r"\b(?:require|eval|Function|child_process|process|fs|fetch|XMLHttpRequest|WebSocket|exec|spawn|globalThis|evaluate|evaluateHandle|addInitScript|exposeFunction|exposeBinding|route|request)\b")
ORIGIN_RX = re.compile(r"(?:(?:https?|ssh|git)://(?:[^@/\s]+@)?|[^@/\s]+@)github\.com(?::[0-9]+)?[:/]([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?", re.I)
SPEC_MAX, MANIFEST_MAX = 60000, 600000


class Stop(Exception):
    """Something this tool will not do. `off` means the git mode is off for a practical reason (nothing wrong was asked); otherwise the call was refused."""

    def __init__(self, reason, off=False):
        super().__init__(reason)
        self.reason, self.off = reason, off


def git(cwd, *args):
    key = args[:2] if args[0] in ("remote", "worktree") else args[:1]
    if key not in GIT_OK:
        raise RuntimeError("git " + " ".join(key) + " is not one of the calls this tool may make")
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_TERMINAL_PROMPT"] = "0"
    try:
        return subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-C", cwd, *args], capture_output=True, text=True, errors="replace", timeout=60, env=env)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise Stop(f"git could not be run in time ({type(e).__name__})")


def entry(value, key):
    """One path of a rule: relative, plain characters only, no `..`, never the whole repository."""
    v = value.strip().strip("\"'")
    v = v[2:] if v.startswith("./") else v
    if not re.fullmatch(r"[A-Za-z0-9._/-]+", v) or any(p in ("", ".", "..") for p in v.rstrip("/").split("/")):
        raise Stop(f"{RULES_FILE}: {key} holds a path that is not a plain relative path", off=True)
    return v


def as_list(raw, key):
    v = raw.get(key, "[]")
    if not (v.startswith("[") and v.endswith("]")):
        raise Stop(f"{RULES_FILE}: {key} must be a list like [e2e/]", off=True)
    return [entry(x, key) for x in v[1:-1].split(",") if x.strip()]


def parse_rules(text):
    """The rules file: `key: value` lines, `#` comments, lists as [a, b]. An unknown or repeated rule is an error, so a typo can never drop a protection silently."""
    raw = {}
    for n, line in enumerate(text.splitlines(), 1):
        line = re.sub(r"(^|\s)#.*$", "", line).strip()
        if not line:
            continue
        key, sep, val = line.partition(":")
        key, val = key.strip(), val.strip()
        if not sep or key not in RULE_KEYS:
            raise Stop(f"{RULES_FILE}: line {n} is not a rule this tool knows (a typo?)", off=True)
        if key in raw:
            raise Stop(f"{RULES_FILE}: the rule {key} is given twice", off=True)
        raw[key] = val if val.startswith("[") else val.strip("\"'")
    for k in ("repo", "base", "mode-max", "tests-dir", "allowed-new-paths"):
        if k not in raw:
            raise Stop(f"{RULES_FILE}: the rule {k} is missing", off=True)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", raw["repo"]):
        raise Stop(f"{RULES_FILE}: repo must be owner/name", off=True)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", raw["base"]) or ".." in raw["base"] or raw["base"].endswith("/"):
        raise Stop(f"{RULES_FILE}: base is not a plain branch name", off=True)
    if raw["mode-max"] not in MODES:
        raise Stop(f"{RULES_FILE}: mode-max must be off, local or pr", off=True)
    prefix = raw.get("branch-prefix", "testpilot/")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*/", prefix):
        raise Stop(f"{RULES_FILE}: branch-prefix must be one folder name ending in /, like testpilot/", off=True)
    limits = {}
    for k, default in (("max-files", 40), ("max-lines", 3000)):
        v = raw.get(k, str(default))
        if not re.fullmatch(r"[1-9][0-9]{0,5}", v):
            raise Stop(f"{RULES_FILE}: {k} must be a whole number above 0", off=True)
        limits[k] = int(v)
    tests_dir = entry(raw["tests-dir"], "tests-dir").rstrip("/")
    allowed = [a.rstrip("/") + "/" for a in as_list(raw, "allowed-new-paths")]
    if not any((tests_dir + "/").startswith(a) for a in allowed):
        raise Stop(f"{RULES_FILE}: tests-dir must lie inside allowed-new-paths", off=True)
    never = [n.rstrip("/").lower() for n in as_list(raw, "never-touch")] + [n.lower() for n in ALWAYS_NEVER]
    return {"repo": raw["repo"], "base": raw["base"], "mode-max": raw["mode-max"], "prefix": prefix, "tests-dir": tests_dir, "allowed": allowed, "never": never, **limits}


def origin_repo(url):
    m = ORIGIN_RX.fullmatch(url.strip())
    return f"{m[1]}/{m[2]}" if m else None  # the address itself is never shown: it may hold a token


def lowest(*modes):
    return MODES[min(min(MODES.index(m) for m in modes), TOP)]


def inspect():
    """Every practical check, in order. Returns what `check` and `write` need, or raises Stop(off=True) with the reason the git mode is off."""
    try:
        g = json.load(open(".testpilot/testbench.json"))
        p = json.load(open(f".testpilot/projects/{g['activeProject']}.json"))
        mode, repo, path, base = p.get("gitMode", "off"), p.get("repo"), p.get("repoPath"), p.get("baseBranch", "main")
    except (OSError, ValueError, KeyError, AttributeError, TypeError) as e:
        raise Stop(f"The TestPilot configuration could not be read ({type(e).__name__}): .testpilot/testbench.json and the profile it names")
    if mode not in MODES:
        raise Stop("gitMode in the project profile must be off, local or pr")
    if mode == "off":
        raise Stop("the profile's gitMode is off", off=True)
    if not all(isinstance(x, str) and x for x in (repo, path, base)):
        raise Stop("The profile needs repo (owner/name) and repoPath, and baseBranch if it is not main")
    top = os.path.realpath(os.path.expanduser(path))
    if not os.path.isdir(top) or git(top, "rev-parse", "--show-toplevel").stdout.strip() != top:
        raise Stop("repoPath is not the top folder of a git checkout", off=True)
    url = git(top, "remote", "get-url", "origin")
    found = origin_repo(url.stdout) if url.returncode == 0 else None
    sha = git(top, "rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{base}^{{commit}}").stdout.strip()
    if not found or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise Stop(f"the checkout has no GitHub origin, or no origin/{base} (fetch it yourself first)", off=True)
    shown = git(top, "show", f"{sha}:{RULES_FILE}")
    if shown.returncode != 0 or len(shown.stdout) > 20000:
        raise Stop(f"{RULES_FILE} was not found on origin/{base} (or is over 20 kB)", off=True)
    rules = parse_rules(shown.stdout)
    if rules["base"] != base:
        raise Stop(f"{RULES_FILE} says base {rules['base']} but the profile says {base}", off=True)
    if len({rules["repo"].lower(), repo.lower(), found.lower()}) != 1:
        raise Stop(f"the profile ({repo}), {RULES_FILE} ({rules['repo']}) and origin ({found}) must name the same repository", off=True)
    low = MODES[min(MODES.index(mode), MODES.index(rules["mode-max"]))]
    if low == "off":
        raise Stop(f"git mode is off (profile gitMode {mode}, {RULES_FILE} mode-max {rules['mode-max']})", off=True)
    return {"top": top, "sha": sha, "rules": rules, "ceiling": lowest(low), "capped": low == "pr"}


def check_path(path, rules):
    if not isinstance(path, str) or not PATH_RX.fullmatch(path):
        return "is not a plain relative path (letters, digits, . _ - and /)"
    if not path.startswith(rules["tests-dir"] + "/"):
        return "is outside the tests folder " + rules["tests-dir"]
    rest = path[len(rules["tests-dir"]) + 1:].split("/")
    if len(rest) != 2 or not rest[1].endswith(".spec.ts"):
        return "must be <tests folder>/<area>/<flow>.spec.ts"
    low = path.lower()
    if any(low == n or low.startswith(n + "/") for n in rules["never"]):
        return "is on the never-touch list"
    if not any(path.startswith(a) for a in rules["allowed"]):
        return "is not under allowed-new-paths"
    return None


def check_content(text, origin):
    if len(text) > SPEC_MAX:
        return f"is over {SPEC_MAX // 1000} kB"
    text = text.replace("\r\n", "\n")
    for ch in text:
        if ch not in "\n\t " and unicodedata.category(ch)[0] in "CZ":
            return "holds a control, invisible or odd space character"
    for n, line in enumerate(text.split("\n"), 1):
        if re.search(r"\bimport\b", line) and not IMPORT_RX.fullmatch(line.strip()):
            return f"line {n}: the only import allowed is import {{ ... }} from \"@playwright/test\""
        if "${" in line:
            return f"line {n}: no ${{...}} placeholders: write the values out"
        found = BANNED.search(line)
        if found:
            return f"line {n}: uses {found[0]}, which a spec written by the agent may not"
    for m in re.finditer(r"([A-Za-z][A-Za-z0-9+.-]*)://([^/\s\"'`)?#]*)", text):
        if f"{m[1]}://{m[2]}".lower() != origin.lower():
            return "names a web address other than the confirmed one: " + f"{m[1]}://{m[2]}"[:80]
    if re.search(r"\b(?:javascript|data|file|blob|vbscript|about):", text, re.I) or re.search(r"[\"'`]\s*//", text):
        return "holds a javascript:, data:, file: or protocol-relative address"
    if not re.search(r"^import \{[^}]*\} from [\"']@playwright/test[\"']", text, re.M) or not re.search(r"\btest(?:\.[a-z]+)?\(", text):
        return "is not a Playwright spec (an import from @playwright/test and a test(...) are needed)"
    return None


def read_manifest(path, rid, rules):
    root = os.path.realpath(os.path.join("audits", "request-" + rid))
    real = os.path.realpath(path) if path else ""
    if not path or os.path.islink(path) or not os.path.isfile(real) or not real.startswith(root + os.sep) or not real.endswith(".json"):
        raise Stop(f"the specs file must be a plain .json file inside audits/request-{rid}/")
    if os.path.getsize(real) > MANIFEST_MAX:
        raise Stop(f"the specs file is over {MANIFEST_MAX // 1000} kB")
    try:
        items = json.load(open(real, encoding="utf-8"))["specs"]
    except (OSError, ValueError, KeyError, TypeError):
        raise Stop('the specs file must be {"specs": [{"path": ..., "content": ...}]}')
    if not isinstance(items, list) or not 1 <= len(items) <= rules["max-files"]:
        raise Stop(f"the specs file must hold 1 to {rules['max-files']} specs")
    if not all(isinstance(i, dict) and set(i) == {"path", "content"} and isinstance(i["content"], str) for i in items):
        raise Stop('every spec must be exactly {"path": ..., "content": ...}')
    return items


def cleanup(top, tmp):
    git(top, "worktree", "remove", "--force", os.path.join(tmp, "checkout"))
    shutil.rmtree(tmp, ignore_errors=True)
    git(top, "worktree", "prune")


def write(rid, confirmed, origin, specs_file):
    ctx = inspect()
    mode = lowest(ctx["ceiling"], confirmed)
    if mode == "off":
        raise Stop("you confirmed git mode off", off=True)
    top, rules = ctx["top"], ctx["rules"]
    if not re.fullmatch(r"https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?", origin):
        raise Stop("--origin must be the confirmed address as scheme://host[:port], with no path")
    items = read_manifest(specs_file, rid, rules)
    taken = {p.lower() for p in git(top, "ls-tree", "-r", "-z", "--name-only", ctx["sha"]).stdout.split("\0") if p}
    seen, lines = set(), 0
    for i in items:
        bad = check_path(i["path"], rules)
        if bad:
            raise Stop(f"refused, {str(i['path'])[:80]!r} {bad}")
        if i["path"].lower() in taken or i["path"].lower() in seen:
            raise Stop(f"refused, {i['path']} already exists (only new files are written)")
        seen.add(i["path"].lower())
        bad = check_content(i["content"], origin)
        if bad:
            raise Stop(f"refused, {i['path']} {bad}")
        lines += i["content"].count("\n") + 1
    if lines > rules["max-lines"]:
        raise Stop(f"refused, {lines} lines is over max-lines {rules['max-lines']}")
    branch = f"{rules['prefix']}discover-{rid}"
    if git(top, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}").returncode == 0:
        raise Stop(f"refused, the branch {branch} already exists")
    tmp = tempfile.mkdtemp(prefix="testpilot-")
    wt = os.path.join(tmp, "checkout")
    try:
        made = git(top, "worktree", "add", "--detach", wt, ctx["sha"])
        if made.returncode != 0:
            raise Stop("git could not make a temporary worktree: " + made.stderr.strip()[:200])
        for i in items:
            cur, *parts = wt, *i["path"].split("/")
            for part in parts[:-1]:
                cur = os.path.join(cur, part)
                if os.path.islink(cur):
                    raise Stop(f"refused, {i['path']} would be written through a link")
                os.makedirs(cur, exist_ok=True)
            with open(os.path.join(cur, parts[-1]), "x", encoding="utf-8", newline="\n") as f:
                f.write(i["content"].replace("\r\n", "\n"))
        git(wt, "add", "--", *[i["path"] for i in items])
        done = git(wt, "commit", "-q", "--no-verify", "-m", f"Add Playwright specs from TestPilot discover request {rid}\n\nWritten by the TestPilot agent for TestBench request {rid}. Not run.")
        commit = git(wt, "rev-parse", "HEAD").stdout.strip()
        if done.returncode != 0 or not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise Stop("git could not commit (is user.name and user.email set?): " + done.stderr.strip()[:200])
        if git(top, "update-ref", f"refs/heads/{branch}", commit, "").returncode != 0:
            raise Stop(f"refused, the branch {branch} could not be made")
    except OSError as e:
        raise Stop(f"a file could not be written ({type(e).__name__})")
    finally:
        cleanup(top, tmp)
    print(f"git mode: {mode} (profile and {RULES_FILE} allow {ctx['ceiling']}, you confirmed {confirmed})")
    print(f"branch: {branch} (local only: nothing was pushed, and the branch you have checked out was not touched)")
    print(f"commit: {commit[:7]} on top of origin/{rules['base']} {ctx['sha'][:7]}")
    print(f"files: {len(items)}, {lines} lines (not run)")
    for i in items:
        print("  " + i["path"])
    print(f"to look at it: git -C {top} log -1 --stat {branch}")


def check(confirmed):
    ctx = inspect()
    r = ctx["rules"]
    print(f"repo: {r['repo']} (the profile, {RULES_FILE} on origin/{r['base']} @ {ctx['sha'][:7]} and origin agree)")
    print(f"ceiling: {ctx['ceiling']}" + (" (pr is not built yet and counts as local)" if ctx["capped"] else ""))
    print(f"checkout: {ctx['top']}")
    if confirmed:
        print(f"mode: {lowest(ctx['ceiling'], confirmed)}")
    print(f"tests-dir: {r['tests-dir']} (only new files, one <area>/<flow>.spec.ts each)")
    print(f"branch: {r['prefix']}discover-<request number>")
    print(f"limits: {r['max-files']} files, {r['max-lines']} lines")


def main(argv):
    ap = argparse.ArgumentParser(prog="spec_git.py", add_help=False)
    ap.add_argument("action")
    ap.add_argument("rid", nargs="?", default="")
    ap.add_argument("--confirmed", default="")
    ap.add_argument("--origin", default="")
    ap.add_argument("--specs", default="")
    a = ap.parse_args(argv)
    if a.action not in ACTIONS or (a.action == "write" and not re.fullmatch(r"[0-9]{1,9}", a.rid)):
        print("Usage: spec_git.py check [--confirmed MODE] | spec_git.py write <request number> --confirmed MODE --origin ADDRESS --specs FILE")
        return 1
    if (a.confirmed and a.confirmed not in MODES) or (a.action == "write" and not a.confirmed):
        print("--confirmed must be off, local or pr, as the person answered in their own message (a request is never a confirmation)")
        return 1
    try:
        write(a.rid, a.confirmed, a.origin, a.specs) if a.action == "write" else check(a.confirmed)
    except Stop as s:
        print(("mode: off\nreason: " if s.off else "") + s.reason)
        return 2 if s.off and a.action == "write" else 0 if s.off else 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
