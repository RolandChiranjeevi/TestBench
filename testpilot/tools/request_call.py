#!/usr/bin/env python3
"""The one way the /testpilot-requests skill talks to TestBench with a request token.

    python3 -I testpilot/tools/request_call.py <action> [<request number>] [--report FILE] [--case-results FILE] [--findings FILE] [--result-run N] [--result-audit N]
                                             [--load-result FILE]

<action> is list, claim, release, result, case-results, findings, load-result, known, precheck or complete. `known <n>` lists what earlier requests already made and keyed (so the same thing is not made twice). `precheck <n> --coverage FILE` is offline: it reads the coverage rows drafted so far and prints what is missing. For release and complete the note is read from standard input (a quoted heredoc keeps it as
text). Run it from the folder that holds `.testpilot/`, or from any folder when the configuration is in `~/.testpilot/` (then `audits/` and `.env` are those of `~/.testpilot/`).

`findings` hands in what a discover found, one finding at a time: the file is {"findings": [...]} (at most 50), each with a `kind` (test_case, bug_report, observation,
manual_test_suggestion, plan_item or coverage_gap). A plan_item may carry `ref` (a name of its own in the file) and a test_case `planItemRef` (the `ref` of an earlier plan_item):
the helper then gives the case the P-number TestBench made. For a test_case it prints the `number` TestBench gave the case (with the profile's projectKey it is the case's key, e.g. SHOP-42). Nothing is sent until the whole file has passed the checks here; it stops at the first finding TestBench refuses.

With no `.testpilot/testbench.json` at all, the helper falls back to the environment (the same names the MCP set-up uses): TESTBENCH_URL, TESTBENCH_PROJECT_ID and TESTBENCH_TOKEN,
each from the environment or from its own raw line of `.env`. A profile that exists is always used as it is, and a profile that is broken is an error, never a fallback.

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

ACTIONS = ("list", "claim", "release", "result", "case-results", "findings", "load-result", "known", "precheck", "complete")
LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")
TOKEN = re.compile(r"tbrq_[A-Za-z0-9_-]{1,195}")  # a request token: its prefix and base64url, at most 200 characters (what TestBench accepts)
SEND_MAX = {"result": 5 * 1024 * 1024, "case-results": 256 * 1024, "findings": 2 * 1024 * 1024, "load-result": 1024 * 1024}  # the most TestBench takes: the report of a re-run, the results of a run request's test cases, and a file of findings
FINDING_KINDS = ("test_case", "bug_report", "observation", "manual_test_suggestion", "plan_item", "coverage_gap")  # the list of server/agentfindings.ts (test_requests_skill.py checks it)
KEY = re.compile(r"[a-z0-9][a-z0-9._-]{0,60}(:[a-z0-9][a-z0-9._-]{0,60}){1,2}")  # the same shape as KEY_RX in server/agentdedupe.ts
PICTURE_LABELS = ("before", "bug")  # one picture taken before the step that fails, one when the bug shows (TestBench takes at most these two per bug report)
PICTURE_MAX = 5 * 1024 * 1024  # the most TestBench takes for one picture
FINDINGS_MAX = 50  # in one call: TestBench takes 300 findings a minute per token
ALIAS = re.compile(r"[A-Za-z0-9_-]{1,40}")  # a `ref` of a plan_item
# What a person chose when asking for a discover (server/agentrequests.ts, REQUEST_OPTIONS). Only a value from these lists is ever printed, so no free text can pass through them.
OPTION_CHOICES = {"targetMode": ("observe_only", "full"), "gitMode": ("off", "local", "pr"), "depth": ("quick", "normal", "deep")}
OPTION_LISTS = {"deliverables": ("plan", "cases", "observations", "bugs", "specs"), "viewports": ("desktop", "tablet", "mobile"), "checks": ("visual", "api", "security")}
# What a person chose when asking for a load test (server/loadtest.ts, LOAD_LIMITS). Only a value from these lists, or a cleaned path, is ever printed.
LOAD_CHOICES = {"vus": (5, 10, 25, 50), "durationSeconds": (30, 60, 120), "rampUpSeconds": (0, 10, 30), "maxErrorRatePercent": (1, 5, 10), "maxP95Ms": (1000, 2000, 5000)}
LOAD_VERDICTS = ("pass", "warning", "fail")
LOAD_OUTCOMES = ("completed", "stopped_error_rate", "stopped_p95", "stopped_tool_limit", "stopped_by_agent")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # the answer is then an error code, and the token stays with the address it was meant for


OPENER = urllib.request.build_opener(NoRedirect)


CONFIG = None  # the folder of testbench.json, set by main()


def printable(text):
    """The text as printable ASCII only: a control character, an escape sequence, a bidi or invisible character or any other non-ASCII character becomes an escape (\\x1b, \\u202e), so that nothing that
    came from a server, a certificate or a library can steer a terminal. What the helper prints as JSON is already this (json.dumps escapes non-ASCII); this is for the lines that are not."""
    return re.sub(r"[^\x20-\x7e]", lambda m: m.group().encode("unicode_escape").decode("ascii"), str(text))


def fail(message, status=1):
    print(printable(message))
    return status


def find_config():
    """Where the configuration is: `.testpilot/` of this folder (an agent folder, as before), or else `~/.testpilot/`, so that claude can be started in any folder (plan 10b). For `~/.testpilot/` the
    helper moves into it, so that `audits/` and `.env` are those of `~/.testpilot/`, and relative paths too. Returns the folder of testbench.json, or None if there is neither."""
    if os.path.exists(".testpilot/testbench.json"):
        return ".testpilot"
    home = os.path.join(os.path.expanduser("~"), ".testpilot")
    if os.path.exists(os.path.join(home, "testbench.json")):
        os.chdir(home)
        return home
    return None


def env_value(var):
    """The value of the environment variable, or else of the raw `.env` line of that name (never `source`d: no other line of `.env` is used). None if there is none."""
    val = os.environ.get(var)
    if not val and os.path.isfile(".env"):
        for line in open(".env", encoding="utf-8"):
            line = line.rstrip("\n")
            if line.startswith(var + "="):
                val = line[len(var) + 1:]
                if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                    val = val[1:-1]
    return val


def read_token(var):
    """The token from the environment variable, or else from the raw `.env` line of that name. None, with the reason on stderr, if there is no usable one."""
    tok = env_value(var)
    if not tok:
        sys.stderr.write("the request token variable is not set\n")
    elif not TOKEN.fullmatch(tok):
        sys.stderr.write("that is not a request token (it starts with tbrq_)\n")
    else:
        return tok
    return None


def claim_folder(q):
    """The folder this claim writes to: audits/request-<id>/<claimedAt as YYYYMMDD-HHMMSS>. TestBench makes the time, so a request number that starts again after a reset (or a second claim of the same request) never gives the same folder twice, and old files are never in the way. None if the time is not in the usual form."""
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z?", str(q.get("claimedAt") or ""))
    return f"audits/request-{q['id']}/{m[1]}{m[2]}{m[3]}-{m[4]}{m[5]}{m[6]}" if m else None


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


def read_picture(path, rid):
    """The bytes of one screenshot this run took for this request: a plain png, jpg, webp or gif file (by its first bytes, not by its name) inside audits/request-<rid>/ of this folder, of
    1 byte up to PICTURE_MAX. A reason (str) if it is not. TestBench checks the bytes again."""
    root = os.path.realpath(os.path.join("audits", "request-" + rid))
    real = os.path.realpath(path) if path else ""
    if not path or os.path.islink(path) or not os.path.isfile(real):
        return "the file is not a plain file"
    if not real.startswith(root + os.sep):
        return "the file must be inside audits/request-" + rid + "/"
    n = os.path.getsize(real)
    if n == 0 or n > PICTURE_MAX:
        return "the picture must be between 1 byte and 5 MB"
    with open(real, "rb") as f:
        data = f.read()
    if not (data[:8] == b"\x89PNG\r\n\x1a\n" or data[:3] == b"\xff\xd8\xff" or data[:6] in (b"GIF87a", b"GIF89a") or (data[:4] == b"RIFF" and data[8:12] == b"WEBP")):
        return "the file is not a png, jpg, webp or gif picture"
    return data


def picture_form(label, data):
    """A multipart body with the label and the picture, as TestBench's screenshot route takes it. Returns (content type, body)."""
    boundary = "testpilot-" + os.urandom(12).hex()
    head = (f'--{boundary}\r\nContent-Disposition: form-data; name="label"\r\n\r\n{label}\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{label}"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()
    return f"multipart/form-data; boundary={boundary}", head + data + f"\r\n--{boundary}--\r\n".encode()


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


def read_findings(body):
    """The findings of the file, ready to be sent one by one (a list), or the reason (a str) why none is. The file is {"findings": [...]}: at most FINDINGS_MAX objects, each with a
    known `kind` and no `request_id` (the request is the number given to the helper). `ref` (a plan_item only, a name that is unique in the file) and `planItemRef` (a test_case
    only, the `ref` of an EARLIER plan_item, and not together with `planItem`) are the helper's own: they are not sent, and the case gets the P-number TestBench gave the plan item."""
    try:
        doc = json.loads(body)
    except ValueError:
        return "the file is not JSON"
    items = doc.get("findings") if isinstance(doc, dict) else None
    if not isinstance(items, list) or not items:
        return 'the file must be {"findings": [ ... ]} with at least one finding'
    if len(items) > FINDINGS_MAX:
        return f"at most {FINDINGS_MAX} findings in one call (TestBench takes 300 a minute per token): split them over several files"
    refs = set()
    for i, f in enumerate(items, 1):
        if not isinstance(f, dict) or f.get("kind") not in FINDING_KINDS:
            return f"finding {i}: kind must be one of {', '.join(FINDING_KINDS)}"
        if "request_id" in f:
            return f"finding {i}: leave request_id out: the request is the number given to the helper"
        ref, link = f.get("ref"), f.get("planItemRef")
        if "ref" in f:
            if f["kind"] != "plan_item" or not isinstance(ref, str) or not ALIAS.fullmatch(ref):
                return f"finding {i}: ref is for a plan_item only, and is 1 to 40 letters, digits, - or _"
            if ref in refs:
                return f"finding {i}: ref {ref} is used twice"
            refs.add(ref)
        if "planItemRef" in f:
            if f["kind"] != "test_case" or "planItem" in f or not isinstance(link, str) or link not in refs:
                return f"finding {i}: planItemRef is for a test_case only, names the ref of a plan_item EARLIER in the file, and is not given together with planItem"
        if "key" in f and (f["kind"] not in ("test_case", "bug_report", "observation") or not isinstance(f["key"], str) or not KEY.fullmatch(f["key"])):
            return f"finding {i}: key is for a test_case, bug_report or observation only, and is lower case words joined by : and -, like cart:float-total"
        if "screenshots" in f and (f["kind"] != "bug_report" or not isinstance(f["screenshots"], dict) or not f["screenshots"] or not set(f["screenshots"]) <= set(PICTURE_LABELS)
                                   or not all(isinstance(v, str) for v in f["screenshots"].values())):
            return f'finding {i}: screenshots is for a bug_report only, like {{"before": "bug-1-before.png", "bug": "bug-1-bug.png"}} (the files are in the folder of this claim)'
        # TestBench takes `automation` as a text of at most 200 characters; three live runs sent an object and only learned it from a 400 after the first call
        if f["kind"] == "plan_item" and "automation" in f and not (isinstance(f["automation"], str) and len(f["automation"]) <= 200):
            return f'finding {i}: automation is a short text of at most 200 characters (for example "Yes, as a saved test"), not an object or a list'
    return items


def send_findings(base, pid, rid, headers, items):
    """Sends the findings one at a time, with the `headers` made in main (the token is put in a header in one place only), in order, and prints what each became (its kind, its number and its link, nothing else of the answer). Stops at the first one TestBench refuses and
    retries nothing, so what was made before it stays made, and the line `stopped_at` says where. Returns the exit status."""
    url = f"{base}/api/agent/projects/{pid}/requests/{rid}/findings"
    clean = lambda s, n: re.sub(r"[\x00-\x1f\x7f]", " ", str(s))[:n]
    whole = lambda v: v if isinstance(v, int) and not isinstance(v, bool) else None
    planned, by_kind, last = {}, {}, {}
    for i, f in enumerate(items, 1):
        body = {k: v for k, v in f.items() if k not in ("ref", "planItemRef", "screenshots", "_pictures")}
        if "planItemRef" in f:
            body["planItem"] = planned[f["planItemRef"]]
        try:
            code, data = send("POST", url, headers, json.dumps(body).encode(), 30)
        except Exception as e:  # nothing here may show more than the kind of failure: no message that could carry the header
            reason = f", {e.reason}" if isinstance(e, urllib.error.URLError) else ""
            print(json.dumps({"stopped_at": i, "kind": f["kind"], "made_before": i - 1, "error": f"the call failed (network or timeout{reason}): not retried here"}))
            return 1
        try:
            r = json.loads(data)
        except Exception:
            r = None
        if code != 201 or not isinstance(r, dict):
            error = clean(r.get("error", ""), 300) if isinstance(r, dict) else "the answer was not JSON"
            print(json.dumps({"stopped_at": i, "kind": f["kind"], "http": code, "made_before": i - 1, "error": error}))
            return 1
        last = r
        by_kind[f["kind"]] = by_kind.get(f["kind"], 0) + 1
        if "ref" in f:
            planned[f["ref"]] = clean(r.get("sourceId", ""), 60)
        shots = {}
        if f.get("_pictures"):
            if r.get("seenAgain") is True:
                shots = {label: "not sent: the bug was seen again and keeps the pictures it has" for label in f["_pictures"]}
            elif whole(r.get("id")) is not None:
                for label, data in f["_pictures"].items():
                    ctype, form = picture_form(label, data)
                    try:
                        scode, sdata = send("POST", f"{url[:-len('/findings')]}/bugs/{whole(r['id'])}/screenshots", {**headers, "Content-Type": ctype}, form, 60)
                    except Exception:  # nothing here may show more than the kind of failure
                        scode, sdata = 0, b""
                    try:
                        said = json.loads(sdata).get("error", "") if scode != 201 else ""
                    except Exception:
                        said = ""
                    shots[label] = "added" if scode == 201 else f"not added (HTTP {scode}{': ' + clean(said, 200) if said else ''}): the bug report stays, without this picture"
        print(json.dumps({"n": i, "kind": f["kind"], "id": whole(r.get("id")), **({"screenshots": shots} if shots else {}), "sourceId": clean(r.get("sourceId", ""), 60), **({"planItem": clean(r["planItem"], 50)} if r.get("planItem") else {}),
                          **({"number": whole(r["number"])} if f["kind"] == "test_case" and whole(r.get("number")) is not None else {}),
                          **({"seenAgain": True} if r.get("seenAgain") is True else {}), **({"possibleDuplicateOf": whole(r["possibleDuplicateOf"])} if whole(r.get("possibleDuplicateOf")) is not None else {})}))  # a case's number is the one a spec's title ends with, as @<project key>-<number>
    print(json.dumps({"made": len(items), "of": len(items), "by_kind": by_kind, "audit": whole(last.get("auditId")),
                      "plan_items_on_request": whole(last.get("planItemsOnRequest")), "coverage_gaps_on_request": whole(last.get("coverageGapsOnRequest"))}))
    return 0


def options_of(o):
    """The choices of a discover as they may be shown: each one of the known values, or left out. A preselection for the agent's confirmation, never a permission."""
    if not isinstance(o, dict):
        return None
    out = {k: o[k] for k, ok in OPTION_CHOICES.items() if o.get(k) in ok}
    out.update({k: [v for v in o[k] if v in ok] for k, ok in OPTION_LISTS.items() if isinstance(o.get(k), list)})
    if isinstance(o.get("production"), bool):
        out["production"] = o["production"]
    return out


def load_options_of(o):
    """The choices of a load test as they may be shown: each one of the known values, the paths cleaned and cut, or left out. A preselection and a ceiling, never a permission."""
    if not isinstance(o, dict):
        return None
    out = {k: o[k] for k, ok in LOAD_CHOICES.items() if o.get(k) in ok}
    if isinstance(o.get("paths"), list):
        out["paths"] = [re.sub(r"[\x00-\x1f\x7f]", " ", str(p))[:200] for p in o["paths"][:10]]
    return out


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
    if action == "load-result":
        print(json.dumps({"verdict": r.get("verdict") if r.get("verdict") in LOAD_VERDICTS else None, "outcome": r.get("outcome") if r.get("outcome") in LOAD_OUTCOMES else None}))
        return 0
    if action == "known":
        for kind in ("test_cases", "bug_reports", "observations"):
            for q in (r.get(kind) or [])[:300] if isinstance(r, dict) else []:  # a title was written by an agent or edited by a person: data, cleaned and cut
                print(json.dumps({"kind": kind[:-1], "key": clean(q.get("key", ""), 120), "id": q.get("id"), **({"number": q["number"]} if "number" in q else {}), "title": clean(q.get("title", ""), 200), "seen_again": q.get("seen")}))
        if isinstance(r, dict) and not any(r.get(k) for k in ("test_cases", "bug_reports", "observations")):
            print("nothing earlier is known: this is the first request, or none of its posts has a key")
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
            "id": q["id"], "name": clean(q.get("name", ""), 60), "kind": q["kind"], "status": q["status"], "environment": clean(q["environment"], 100),
            "target": clean(q["targetUrl"], 500), "run": q["runId"], "tests": len(q["tests"]), "asked_by": clean(q["createdBy"], 80),
            "asked_at": q["createdAt"], "note": clean(q["note"], 500),
            **({"folder": os.path.abspath(claim_folder(q)) if CONFIG not in (None, ".testpilot") else claim_folder(q)} if action == "claim" and claim_folder(q) else {}),  # from ~/.testpilot/ the agent's own Write needs the whole path
            **({"cases": q.get("caseCount"), "progress": q.get("progress")} if q["kind"] == "run" else {}),
            **({"options": options_of(q.get("options"))} if q["kind"] == "discover" and q.get("options") is not None else {}),
            **({"loadOptions": load_options_of(q.get("loadOptions"))} if q["kind"] == "loadtest" and q.get("loadOptions") is not None else {}),
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


FIELD_CLASSES = ("empty", "wrong-kind", "too-long", "boundary", "format", "enter")
READ_FIELD_CLASSES = ("empty", "wrong-kind", "too-long", "boundary", "format", "emoji")  # the read-only discover never presses Enter, and tries emoji instead (step 3, "Form fields")  # a page with a row of any of these takes input, and needs a row for all of them
ROW_STATUS = ("tried", "issue", "not tried")
SOFT_REASON = re.compile(r"not reached|did not reach|didn'?t reach|did not get to|ran out|no time|skipped|left out|forgot|not got to|not looked at|did not look at|didn'?t look at|never looked at|not checked|not examined|not covered|not tried yet", re.I)  # shortcut: words only, a reason can still be soft in other words; the person reads the LEFT lines


def precheck(rid, path, read=False, values=0):
    """Offline, before Logout: reads the coverage rows the agent has drafted (`## <page>` and then one row per line, as in step 4 of the write skill) and prints what is missing, so that it is seen while the session is still there. Exit 1 if there is a gap, 0 if not. It checks that rows exist and carry action numbers; it cannot tell whether a row is true."""
    root = os.path.realpath(os.path.join("audits", "request-" + rid))
    real = os.path.realpath(path) if path else ""
    if not path or os.path.islink(path) or not os.path.isfile(real) or not real.startswith(root + os.sep) or not real.endswith(".md") or not 0 < os.path.getsize(real) <= 400000:
        return fail("the file must be a .md file inside audits/request-" + rid + "/")
    pages, page = {}, None
    for line in open(real, encoding="utf-8", errors="replace").read().splitlines():
        if line.startswith("## "):
            page = line[3:].strip().removeprefix("Coverage:").strip()
            pages.setdefault(page, [])
            continue
        parts = [s.strip() for s in line.split("·")]
        if page is not None and len(parts) >= 3 and parts[2] in ROW_STATUS:
            pages[page].append(parts)
    gaps, left, counts = [], [], {s: 0 for s in ROW_STATUS}
    try:
        log = open(os.path.join(os.path.dirname(real), "actions.md"), encoding="utf-8", errors="replace").read()
    except OSError:
        log = ""
    for p in dict.fromkeys(m.split("?")[0] for m in re.findall(r"^\s*\d+\.\s+(/[^\s:]*):", log, re.M)):
        if p not in pages:
            gaps.append(f"GAP {p}: acted on in actions.md but no coverage rows")
    matrix = []
    for p, rows in pages.items():
        seen, by_field = {}, {}
        for r in rows:
            r[1] = re.sub(r"\b(wrong|too)[\s_]+(kind|long)\b", r"\1-\2", r[1], flags=re.I).lower()  # "wrong kind" and "too long" are the same classes (körning 6 had to rename 14 rows)
            classes, status, proof = [c for c in re.split(r"[\s,/+]+", r[1]) if c] or [""], r[2], r[3] if len(r) > 3 else ""  # a row may name several classes at once ("empty/wrong-kind")
            if read and "all" in classes:  # "Password · all · not tried · a password field": one row for a field that is never typed in
                classes = list(READ_FIELD_CLASSES)
            if read and status != "not tried":
                n = re.search(r"values? (\d+)", proof)
                if not n:
                    gaps.append(f"GAP {p} | {r[0][:50]} | {r[1][:30]}: says {status} but not how many values were tried (\"values 2\"), so it counts as not tried")
                    status = "not tried"
                elif int(n.group(1)) < values and "lock 2" not in " ".join(r[3:]):  # a field that sent data on its first value gets no more (lock 2)
                    gaps.append(f"GAP {p} | {r[0][:50]} | {r[1][:30]}: {n.group(1)} value(s), and this depth asks for {values}")
            elif not read and status != "not tried" and not (re.search(r"actions? \d", proof) or "no action (read:" in proof):
                gaps.append(f"GAP {p} | {r[0][:50]} | {r[1][:30]}: says {status} but names no action numbers, so it counts as not tried")
                status = "not tried"
            why = " ".join(r[3:])
            if read and status == "not tried" and re.search(r"\blimit\b|budget", why, re.I):  # körning 8: "limit of 300 reached" after 222 calls
                m = re.search(r"limit: (\d+) of (\d+)", why)
                if not m:
                    gaps.append(f"GAP {p} | {r[0][:50]} | {r[1][:30]}: gives the browser call limit as the reason but not the count (\"browser call limit: 400 of 400\")")
                elif int(m.group(1)) < int(m.group(2)):
                    gaps.append(f"GAP {p} | {r[0][:50]} | {r[1][:30]}: {m.group(1)} of {m.group(2)} browser calls is not the limit: go on")
            if status == "not tried" and SOFT_REASON.search(" ".join(r[3:])):
                gaps.append(f"GAP {p} | {r[0][:50]} | {r[1][:30]}: not tried, and \"{' '.join(r[3:])[:60]}\" is not a hard reason. Do it now, or give a hard one (a secret, another origin, a card number, a CAPTCHA, a limit of the request)")
            counts[status] += 1
            for cls in classes:
                seen[cls] = seen.get(cls, 0) + 1
                by_field.setdefault(r[0], set()).add(cls)
            if status == "not tried":
                left.append(f"LEFT {p} | {r[0][:50]} | {r[1][:30]} | {' '.join(r[3:])[:90]}")
        if read:  # every field of the page, every class (a field that is only listed, with no class, still needs them all)
            for field, have in by_field.items():
                missing = [c for c in READ_FIELD_CLASSES if c not in have]
                if missing:
                    gaps.append(f"GAP {p} | {field[:50]}: no row for: {', '.join(missing)}")
        elif any(c in seen for c in FIELD_CLASSES):
            missing = [c for c in FIELD_CLASSES if c not in seen]
            if missing:
                gaps.append(f"GAP {p}: takes input, but no row for: {', '.join(missing)}")
        matrix.append(f"  {p[:40]:40} " + ", ".join(f"{c} {n}" for c, n in seen.items()))
    lines = [f"precheck: {len(pages)} pages, {sum(counts.values())} rows (tried {counts['tried']}, issue {counts['issue']}, not tried {counts['not tried']}), {len(gaps)} gaps"]
    lines += matrix + gaps + left
    done = "hand in the findings" if read else "press Logout"
    lines.append("precheck: " + ("every page has its rows. Each LEFT row needs a hard reason, or do it before you " + done + "." if not gaps else "fix each GAP (do it, or write the row with its hard reason), run precheck again, and only then " + done + "."))
    for ln in lines:
        print(printable(ln))
    return 1 if gaps else 0


def main(argv):
    ap = argparse.ArgumentParser(prog="request_call.py", add_help=False)
    ap.add_argument("action")
    ap.add_argument("rid", nargs="?", default="")
    ap.add_argument("--report", default="")
    ap.add_argument("--case-results", default="")
    ap.add_argument("--findings", default="")
    ap.add_argument("--coverage", default="")
    ap.add_argument("--read", action="store_true")  # precheck of the read-only discover: its own input classes, "values N" as the proof, every field
    ap.add_argument("--values", default="0")
    ap.add_argument("--load-result", default="")
    ap.add_argument("--result-run", default="")
    ap.add_argument("--result-audit", default="")
    a = ap.parse_args(argv)
    whole = lambda s: re.fullmatch(r"[0-9]*", s) is not None
    if a.action not in ACTIONS:
        return fail("The action must be list, claim, release, result, case-results, findings, load-result, known, precheck or complete")
    if not whole(a.rid) or (a.action != "list" and not a.rid):
        return fail("The request number must be the number of a request")
    if not whole(a.result_run) or not whole(a.result_audit):
        return fail("--result-run and --result-audit must be a number")
    global CONFIG
    CONFIG = find_config()  # before precheck too: it reads audits/ of the same folder
    if a.action == "precheck":  # offline: no profile, no token, no call
        if not re.fullmatch(r"[0-9]{1,2}", a.values):
            return fail("--values is the number of values per class that the depth asks for (1, 2 or 3)")
        return precheck(a.rid, a.coverage, a.read, int(a.values))

    if CONFIG:  # a profile that exists is used as it is; one that cannot be read is an error, not a reason to fall back
        try:
            g = json.load(open(os.path.join(CONFIG, "testbench.json")))
            p = json.load(open(os.path.join(CONFIG, "projects", f"{g['activeProject']}.json")))
            base, pid, var = g["baseUrl"].rstrip("/"), str(p["projectId"]), p.get("requestTokenEnvVar")
        except (OSError, ValueError, KeyError, AttributeError) as e:
            return fail(f"The TestPilot configuration could not be read ({type(e).__name__}): {os.path.join(CONFIG, 'testbench.json')} and the profile it names")
        if not var:
            return fail("requestTokenEnvVar is not set in the project profile", 3)
    else:
        base, pid, var = (env_value("TESTBENCH_URL") or "").rstrip("/"), env_value("TESTBENCH_PROJECT_ID") or "", "TESTBENCH_TOKEN"
        if not base or not pid:
            return fail("There is no .testpilot/testbench.json here or in ~/.testpilot/, and TESTBENCH_URL and TESTBENCH_PROJECT_ID are not both set (in the environment or as their own lines of .env): the helper does not know which TestBench to call")
        print("profile: none; TESTBENCH_URL, TESTBENCH_PROJECT_ID and TESTBENCH_TOKEN stand in for it")
    if not whole(pid) or not pid:
        return fail("projectId in the project profile must be a number")
    u = urlsplit(base)
    if u.scheme == "http" and u.hostname not in LOCAL_HOSTS:
        return fail("Refusing plain http to a non-local host")
    if u.scheme not in ("http", "https") or not u.hostname:
        return fail("baseUrl must be an http or https address")

    body, items = None, None
    if a.action in SEND_MAX:
        body = read_send_file({"result": a.report, "case-results": a.case_results, "findings": a.findings, "load-result": a.load_result}[a.action], a.rid, SEND_MAX[a.action])
        if isinstance(body, str):
            return fail(body)
        if a.action == "findings":
            items, body = read_findings(body), None
            if isinstance(items, str):
                return fail(items)
            for i, f in enumerate(items, 1):  # every picture is read before anything is sent, so a wrong path stops the call with nothing made
                for label, path in (f.get("screenshots") or {}).items():
                    data = read_picture(path, a.rid)
                    if isinstance(data, str):
                        return fail(f"finding {i}: screenshot {label}: {data}")
                    f.setdefault("_pictures", {})[label] = data
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
    headers = {"Authorization": "Bearer " + tok, **({"Content-Type": "application/json"} if body is not None or items is not None else {})}  # the one place the token is put in a header
    if items is not None:
        return send_findings(base, pid, a.rid, headers, items)
    url = f"{base}/api/agent/projects/{pid}/requests" + ("" if a.action == "list" else f"/{a.rid}/{a.action}")
    try:
        code, data = send("GET" if a.action in ("list", "known") else "POST", url, headers, body, 120 if a.action == "result" else 30)
    except Exception as e:  # nothing here may show more than the kind of failure: no message that could carry the header
        reason = f", {str(e.reason)[:200]}" if isinstance(e, urllib.error.URLError) else ""
        return fail(f"the call failed (network or timeout{reason}): not retried here")
    print(f"{a.action} HTTP {code}")
    return show(data, str(code), a.action, a.rid)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
