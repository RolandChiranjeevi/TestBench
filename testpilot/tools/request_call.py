#!/usr/bin/env python3
"""The one way the /testpilot-requests skill talks to TestBench with a request token.

    python3 -I testpilot/tools/request_call.py <action> [<request number>] [--report FILE] [--case-results FILE] [--result-run N] [--result-audit N]

<action> is list, claim, release, result, case-results or complete. For release and complete the note is read from standard input (a quoted heredoc keeps it as
text). Run it from the folder that holds `.testpilot/`.

Why a fixed script: the token must never be in code an agent writes, on a command line, in a file or in the output. Here it is read from the environment variable that
the project profile names (`requestTokenEnvVar`), or else from that one line of `.env`, kept in memory, and sent only in the Authorization header, to the request routes of
that one project on `baseUrl`. Nothing else of `.env` is read. It prints the HTTP code and the data of the request(s), never the token and never more of an answer than
`show` picks out. It never retries, and it follows no redirect (the token would go with it).

Python standard library only. Tests: testpilot/tests/test_requests_skill.py.
"""
import argparse
import json
import os
import re
import signal
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit

ACTIONS = ("list", "claim", "release", "result", "case-results", "complete")
LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")
TOKEN = re.compile(r"tbrq_[A-Za-z0-9_-]{1,195}")  # a request token: its prefix and base64url, at most 200 characters (what TestBench accepts)
SEND_MAX = {"result": 5 * 1024 * 1024, "case-results": 256 * 1024}  # the most TestBench takes: the report of a re-run, and the results of a run request's test cases


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # the answer is then an error code, and the token stays with the address it was meant for


OPENER = urllib.request.build_opener(NoRedirect)


def fail(message, status=1):
    print(message)
    return status


def read_token(var):
    """The token from the environment variable, or else from the raw `.env` line of that name (never `source`d). None, with the reason on stderr, if there is no usable one."""
    tok = os.environ.get(var)
    if not tok and os.path.isfile(".env"):
        for line in open(".env", encoding="utf-8"):
            line = line.rstrip("\n")
            if line.startswith(var + "="):
                tok = line[len(var) + 1:]
                if len(tok) >= 2 and tok[0] == tok[-1] and tok[0] in "\"'":
                    tok = tok[1:-1]
    if not tok:
        sys.stderr.write("the request token variable is not set\n")
    elif not TOKEN.fullmatch(tok):
        sys.stderr.write("that is not a request token (it starts with tbrq_)\n")
    else:
        return tok
    return None


def read_send_file(path, rid, top):
    """The bytes of the one file this run wrote for this request: a plain .json file (not a link) inside audits/request-<rid>/ of this folder, of 1 byte up to `top`. A reason (str) if it is not."""
    root = os.path.realpath(os.path.join("audits", "request-" + rid))
    real = os.path.realpath(path) if path else ""
    if not path or os.path.islink(path) or not os.path.isfile(real):
        return "the file is not a plain file"
    if not real.startswith(root + os.sep) or not real.endswith(".json"):
        return "the file must be a .json file inside audits/request-" + rid + "/"
    n = os.path.getsize(real)
    if n == 0 or n > top:
        return "the file must be between 1 byte and " + str(top // 1024) + " kB"
    with open(real, "rb") as f:
        return f.read()


def send(method, url, headers, body, timeout):
    """One call: no redirect, no retry, and (where the system has SIGALRM) cut off after `timeout` seconds in all, as `curl --max-time` was. Returns (HTTP code, answer bytes)."""
    def timed_out(*_):
        raise TimeoutError("timeout")
    timed = hasattr(signal, "SIGALRM")
    if timed:
        signal.signal(signal.SIGALRM, timed_out)
        signal.alarm(timeout)
    try:
        with OPENER.open(urllib.request.Request(url, data=body, method=method, headers=headers), timeout=timeout) as r:
            return r.status, r.read(20 * 1024 * 1024)
    except urllib.error.HTTPError as e:
        return e.code, e.read(20 * 1024 * 1024)
    finally:
        if timed:
            signal.alarm(0)


def show(data, code, action, rid):
    """Prints the answer: the data of the requests as JSON strings, so that text in a note stays text, and nothing else from it. Returns the exit status."""
    try:
        r = json.loads(data)
    except Exception:
        print("the answer was not JSON")
        return 1
    if code != "200":
        print("ERROR:", json.dumps(r.get("error", r) if isinstance(r, dict) else r))
        return 1
    clean = lambda s, n: re.sub(r"[\x00-\x1f\x7f]", " ", str(s))[:n]
    if action == "result":
        print(json.dumps({"run": r.get("runId"), "tests": r.get("total"), "linked": r.get("linked")}))
        return 0
    if action == "case-results":
        c, p = r.get("counts") or {}, r.get("progress") or {}  # only these numbers are printed, nothing else from the answer
        print(json.dumps({"reported": r.get("reported"), "counts": {k: c.get(k) for k in ("passed", "failed", "blocked", "skipped")}, "progress": {k: p.get(k) for k in ("total", "reported", "missing")}}))
        return 0
    rows = r if isinstance(r, list) else [r]
    if action == "list" and rid:
        rows = [q for q in rows if str(q["id"]) == rid]
        if not rows:
            print("request", rid, "is not waiting")
            return 1
    # list with a request number, and claim, also show the tests of the request
    detail = action == "claim" or (action == "list" and rid)
    for q in rows[:100]:
        if action == "release":
            print(json.dumps({"id": q["id"], "status": q["status"], "release_note": clean(q["releaseNote"], 1000)}))
            continue
        if action == "complete":
            # `warning` is TestBench's own text for a run request that was finished without the report of the automated tests it names (the agent tells the user): shown, cleaned like all text, and cut.
            print(json.dumps({"id": q["id"], "status": q["status"], "result_note": clean(q["resultNote"], 1000), "result_run": q["resultRunId"], "result_audit": q.get("resultAuditId"), "finished_at": q["finishedAt"],
                              **({"warning": clean(q["warning"], 600)} if q.get("warning") else {})}))
            continue
        print(json.dumps({
            "id": q["id"], "kind": q["kind"], "status": q["status"], "environment": clean(q["environment"], 100),
            "target": clean(q["targetUrl"], 500), "run": q["runId"], "tests": len(q["tests"]), "asked_by": clean(q["createdBy"], 80),
            "asked_at": q["createdAt"], "note": clean(q["note"], 500),
            **({"cases": q.get("caseCount"), "progress": q.get("progress")} if q["kind"] == "run" else {}),
        }))
        if detail and q["kind"] == "run":
            cases = q.get("cases") or []
            for c in cases[:100]:  # a test case is data written by a person: every text is cleaned and cut
                print(json.dumps({"case": {
                    "caseId": c["caseId"], "key": clean(c["key"], 40), "title": clean(c["title"], 300), "priority": clean(c.get("priority", ""), 20),
                    "description": clean(c.get("description", ""), 1000), "preconditions": clean(c.get("preconditions", ""), 500),
                    "steps": [{"id": s["id"], "action": clean(s["action"], 300), "expected": clean(s["expected"], 300)} for s in (c.get("steps") or [])[:30]],
                    "automatedTests": [clean(t.get("fullName", ""), 300) for t in (c.get("automatedTests") or [])[:20]],
                    "specFiles": [clean(f, 200) for f in (c.get("specFiles") or [])[:20]],
                }}))
            if len(cases) > 100:
                print(json.dumps({"more_cases_not_shown": len(cases) - 100}))
        elif detail:
            for t in q["tests"][:100]:
                print(json.dumps({"test": {"framework": clean(t["framework"], 40), "file": clean(t["file"], 300), "title": clean(t["title"], 300), "fullName": clean(t["fullName"], 400)}}))
            if len(q["tests"]) > 100:
                print(json.dumps({"more_tests_not_shown": len(q["tests"]) - 100}))
    if isinstance(r, list) and not r:
        print("no requests are waiting")
    return 0


def main(argv):
    ap = argparse.ArgumentParser(prog="request_call.py", add_help=False)
    ap.add_argument("action")
    ap.add_argument("rid", nargs="?", default="")
    ap.add_argument("--report", default="")
    ap.add_argument("--case-results", default="")
    ap.add_argument("--result-run", default="")
    ap.add_argument("--result-audit", default="")
    a = ap.parse_args(argv)
    whole = lambda s: re.fullmatch(r"[0-9]*", s) is not None
    if a.action not in ACTIONS:
        return fail("The action must be list, claim, release, result, case-results or complete")
    if not whole(a.rid) or (a.action != "list" and not a.rid):
        return fail("The request number must be the number of a request")
    if not whole(a.result_run) or not whole(a.result_audit):
        return fail("--result-run and --result-audit must be a number")

    try:
        g = json.load(open(".testpilot/testbench.json"))
        p = json.load(open(f".testpilot/projects/{g['activeProject']}.json"))
        base, pid, var = g["baseUrl"].rstrip("/"), str(p["projectId"]), p.get("requestTokenEnvVar")
    except (OSError, ValueError, KeyError, AttributeError) as e:
        return fail(f"The TestPilot configuration could not be read ({type(e).__name__}): .testpilot/testbench.json and the profile it names")
    if not var:
        return fail("requestTokenEnvVar is not set in the project profile", 3)
    if not whole(pid) or not pid:
        return fail("projectId in the project profile must be a number")
    u = urlsplit(base)
    if u.scheme == "http" and u.hostname not in LOCAL_HOSTS:
        return fail("Refusing plain http to a non-local host")
    if u.scheme not in ("http", "https") or not u.hostname:
        return fail("baseUrl must be an http or https address")

    body = None
    if a.action in SEND_MAX:
        body = read_send_file(a.report if a.action == "result" else a.case_results, a.rid, SEND_MAX[a.action])
        if isinstance(body, str):
            return fail(body)
    elif a.action in ("release", "complete"):
        note = "" if sys.stdin.isatty() else sys.stdin.read(20000)
        payload = {"note": note.strip()[:1000]}
        if a.action == "complete":
            if a.result_run:
                payload["resultRunId"] = int(a.result_run)
            if a.result_audit:
                payload["resultAuditId"] = int(a.result_audit)
        body = json.dumps(payload).encode()

    tok = read_token(var)
    if tok is None:
        return fail("no usable request token")
    headers = {"Authorization": "Bearer " + tok, **({"Content-Type": "application/json"} if body is not None else {})}
    url = f"{base}/api/agent/projects/{pid}/requests" + ("" if a.action == "list" else f"/{a.rid}/{a.action}")
    try:
        code, data = send("GET" if a.action == "list" else "POST", url, headers, body, 120 if a.action == "result" else 30)
    except Exception as e:  # nothing here may show more than the kind of failure: no message that could carry the header
        reason = f", {e.reason}" if isinstance(e, urllib.error.URLError) else ""
        return fail(f"the call failed (network or timeout{reason}): not retried here")
    print(f"{a.action} HTTP {code}")
    return show(data, str(code), a.action, a.rid)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
