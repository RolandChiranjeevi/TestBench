#!/usr/bin/env python3
"""The one way the /testpilot-request-loadtest skill sends load: a small, bounded load test of a local or private address.

    python3 -I testpilot/tools/loadtest.py plan|run --request N --base-url URL --path /a [--path /b ...] [--vus N] [--duration S] [--ramp-up S]
                                            [--max-error-rate PERCENT] [--max-p95-ms MS] [--out audits/request-N/loadtest.json]

`plan` checks the choices and prints exactly what `run` would do, and sends nothing. `run` does it and writes the result (the format of server/loadtest.ts, `cleanLoadResult`) to a
file inside audits/request-N/. The verdict and its reason are worked out here by fixed rules from numbers; nothing a page says is ever put in the result.

The limits are in this code and cannot be raised from the command line: at most 50 users, 120 seconds, 10 paths and 200000 requests; GET only, with no body and no login; one
address, which must be local or private (localhost, 127.x, 10.x, 172.16-31.x, 192.168.x, *.local); no redirect is followed; 10 seconds for one request; no retry (a 429 counts as an
error). It stops by itself when the share of failed requests, or p95, goes over the limit given, judged on the last 10 seconds once at least 20 requests are in them.

Python standard library only. Tests: testpilot/tests/test_loadtest.py, and test/loadtest-agent-contract.test.ts (the result is accepted by the server's own check).
"""
import argparse
import http.client
import json
import math
import os
import re
import socket
import sys
import threading
import time
from collections import deque
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlsplit

CEILINGS = {"vus": 50, "duration": 120, "paths": 10, "requests": 200000, "path_chars": 200, "max_error_rate": 10, "max_p95_ms": 5000}
TIMEOUT = 10  # seconds for one request
BUCKET = 5  # seconds in one point of the timeline
WINDOW = 10  # seconds the stop rules look at
MIN_SAMPLE = 20  # requests in the window before a stop rule may fire
SECRET_KEY = re.compile(r"pass|token|secret|key|auth|cookie|session", re.I)


def is_local_host(hostname):
    """localhost, *.localhost, *.local, ::1, 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12 and 192.168.0.0/16 (the list of server/loadtest.ts). A name that points elsewhere is refused."""
    h = (hostname or "").lower().strip("[]")
    if h == "localhost" or h.endswith(".localhost") or h.endswith(".local") or h == "::1":
        return True
    m = re.fullmatch(r"(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})", h)
    if not m:
        return False
    a, b, c, d = (int(x) for x in m.groups())
    if max(a, b, c, d) > 255:
        return False
    return a == 127 or a == 10 or (a == 172 and 16 <= b <= 31) or (a == 192 and b == 168)


def check_path(p):
    """A reason (str) if the path is not one this tool sends, else None."""
    if not isinstance(p, str) or not p.startswith("/") or p.startswith("//"):
        return f"the path {str(p)[:40]!r} must start with a single /"
    if len(p) > CEILINGS["path_chars"] or re.search(r"[\s\x00-\x1f\\#]", p):
        return f"the path {p[:40]!r} is too long or has a space, a control character, a backslash or #"
    for k, _ in parse_qsl(urlsplit(p).query, keep_blank_values=True):
        if SECRET_KEY.search(k):
            return f"the path {p[:40]!r} has {k!r} in its query, which looks like a secret"
    return None


def validate(o):
    """A reason (str) why the choices cannot be run, else None. The ceilings are here, not on the command line."""
    u = urlsplit(o["base_url"])
    if u.scheme not in ("http", "https") or not u.hostname:
        return "the base URL must be an http or https address"
    if u.username or u.password:
        return "the base URL cannot hold a user name or password"
    if u.path not in ("", "/") or u.query or u.fragment:
        return "the base URL is the address only: give the paths with --path"
    if not is_local_host(u.hostname):
        return "a load test is only run against a local or private address (localhost, 127.x, 10.x, 172.16-31.x, 192.168.x, *.local)"
    if not 1 <= o["vus"] <= CEILINGS["vus"]:
        return f"users must be from 1 to {CEILINGS['vus']}"
    if not 1 <= o["duration"] <= CEILINGS["duration"]:
        return f"the duration must be from 1 to {CEILINGS['duration']} seconds"
    if not 0 <= o["ramp_up"] <= o["duration"] / 2:
        return "the ramp-up must be from 0 to half of the duration"
    if not 0 < o["max_error_rate"] <= CEILINGS["max_error_rate"]:
        return f"the error-rate limit must be above 0 and at most {CEILINGS['max_error_rate']} percent"
    if o["max_p95_ms"] is not None and not 0 < o["max_p95_ms"] <= CEILINGS["max_p95_ms"]:
        return f"the p95 limit must be above 0 and at most {CEILINGS['max_p95_ms']} ms"
    if not 1 <= len(o["paths"]) <= CEILINGS["paths"]:
        return f"give from 1 to {CEILINGS['paths']} paths"
    for p in o["paths"]:
        bad = check_path(p)
        if bad:
            return bad
    if not re.fullmatch(r"[0-9]{1,9}", str(o["request"])):
        return "the request number must be a number"
    return None


def percentile(values, p):
    """Nearest rank on a list in any order; 0 for an empty list."""
    if not values:
        return 0.0
    s = sorted(values)
    return s[max(0, math.ceil(p / 100 * len(s)) - 1)]


def totals_of(latencies, errors, seconds):
    n = len(latencies)
    return {
        "requests": n, "errors": errors, "errorRate": round(100 * errors / n, 2) if n else 0, "rps": round(n / seconds, 2) if seconds > 0 else 0,
        "p50Ms": round(percentile(latencies, 50), 1), "p95Ms": round(percentile(latencies, 95), 1), "p99Ms": round(percentile(latencies, 99), 1), "maxMs": round(max(latencies, default=0), 1),
    }


def statuses_of(counts):
    """At most 20 entries (what TestBench takes): the most common, with the rest counted as "error"."""
    items = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    if len(items) <= 20:
        return dict(sorted(items))
    keep = dict(items[:19])
    keep["error"] = keep.get("error", 0) + sum(n for _, n in items[19:])
    return dict(sorted(keep.items()))


def verdict_of(outcome, total, statuses, o):
    """('pass'|'warning'|'fail', one line of reasoning). Fixed rules over numbers: fail if it was stopped or the error rate passed the limit, warning for half the limit, 80 % of the p95 limit or any 5xx."""
    said = f"error rate {total['errorRate']} %, p95 {round(total['p95Ms'])} ms, {total['requests']} requests"
    if total["requests"] == 0:
        return "fail", "No request got an answer"
    if outcome == "stopped_error_rate":
        return "fail", f"Stopped: the error rate went over {o['max_error_rate']} % ({said})"
    if outcome == "stopped_p95":
        return "fail", f"Stopped: p95 went over {o['max_p95_ms']} ms ({said})"
    if outcome == "stopped_by_agent":
        return "warning", f"Stopped before the end ({said})"
    if total["errorRate"] > o["max_error_rate"]:
        return "fail", f"The error rate is over {o['max_error_rate']} % ({said})"
    five = sum(n for k, n in statuses.items() if k.startswith("5"))
    if total["errorRate"] > o["max_error_rate"] / 2:
        return "warning", f"The error rate is over half of the limit of {o['max_error_rate']} % ({said})"
    if o["max_p95_ms"] and total["p95Ms"] > 0.8 * o["max_p95_ms"]:
        return "warning", f"p95 is over 80 % of the limit of {o['max_p95_ms']} ms ({said})"
    if five:
        return "warning", f"{five} answers were 5xx ({said})"
    return "pass", f"Within the limits ({said}, {o['vus']} users)"


class Run:
    """The state of one test: what every user thread records, and the stop rules that look at the last seconds."""

    def __init__(self, o):
        self.o, self.lock, self.stop, self.outcome = o, threading.Lock(), threading.Event(), "completed"
        self.t0 = time.monotonic()
        self.samples = []  # (seconds since start, path, milliseconds, status key, error?)
        self.window = deque()  # (monotonic time, milliseconds, error?)

    def record(self, path, ms, key, error):
        now = time.monotonic()
        with self.lock:
            self.samples.append((now - self.t0, path, ms, key, error))
            self.window.append((now, ms, error))
            if len(self.samples) >= CEILINGS["requests"]:
                self.stop.set()  # the cap: an end like any other, said in the reason

    def judge(self):
        """The stop rules, on the last WINDOW seconds. Returns an outcome to stop with, or None."""
        now = time.monotonic()
        with self.lock:
            while self.window and now - self.window[0][0] > WINDOW:
                self.window.popleft()
            w = list(self.window)
        if len(w) < MIN_SAMPLE:
            return None
        if 100 * sum(1 for _, _, e in w if e) / len(w) > self.o["max_error_rate"]:
            return "stopped_error_rate"
        if self.o["max_p95_ms"] and percentile([ms for _, ms, _ in w], 95) > self.o["max_p95_ms"]:
            return "stopped_p95"
        return None


def user(run, index):
    """One user: waits for its turn in the ramp-up, then asks the paths in turn over one connection until the test stops."""
    o = run.o
    u = urlsplit(o["base_url"])
    port = u.port or (443 if u.scheme == "https" else 80)
    make = (lambda: http.client.HTTPSConnection(u.hostname, port, timeout=TIMEOUT)) if u.scheme == "https" else (lambda: http.client.HTTPConnection(u.hostname, port, timeout=TIMEOUT))
    if run.stop.wait(o["ramp_up"] * index / o["vus"]):
        return
    conn, n = make(), index
    while not run.stop.is_set():
        path = o["paths"][n % len(o["paths"])]
        n += 1
        started = time.monotonic()
        try:
            conn.request("GET", path, headers={"User-Agent": "testpilot-loadtest/1", "Accept": "*/*"})
            resp = conn.getresponse()
            resp.read(1024 * 1024)  # the answer is read to the end of the first MB and thrown away; a redirect is an answer, never followed
            status = resp.status
            ms = (time.monotonic() - started) * 1000
            run.record(path, ms, str(status), status >= 400)
            if resp.will_close or not resp.isclosed():
                conn.close()
                conn = make()
        except (socket.timeout, TimeoutError):
            run.record(path, (time.monotonic() - started) * 1000, "timeout", True)
            conn.close()
            conn = make()
        except (OSError, http.client.HTTPException):
            run.record(path, (time.monotonic() - started) * 1000, "error", True)
            conn.close()
            conn = make()
            run.stop.wait(0.05)  # a refused connection must not become a busy loop
    conn.close()


def run_test(o):
    """Runs the test and returns the result in the format of server/loadtest.ts. Nothing is sent before `validate` has passed."""
    started_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    run = Run(o)
    threads = [threading.Thread(target=user, args=(run, i), daemon=True) for i in range(o["vus"])]
    for t in threads:
        t.start()
    try:
        while time.monotonic() - run.t0 < o["duration"] and not run.stop.is_set():
            why = run.judge()
            if why:
                run.outcome = why
                break
            time.sleep(0.25)
    except KeyboardInterrupt:
        run.outcome = "stopped_by_agent"
    run.stop.set()
    for t in threads:
        t.join(TIMEOUT + 2)
    seconds = min(time.monotonic() - run.t0, o["duration"] + TIMEOUT)
    ended_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with run.lock:
        samples = list(run.samples)
    lat = [s[2] for s in samples]
    err = sum(1 for s in samples if s[4])
    counts = {}
    for s in samples:
        counts[s[3]] = counts.get(s[3], 0) + 1
    paths = []
    for p in o["paths"]:
        mine = [s for s in samples if s[1] == p]
        pc = {}
        for s in mine:
            pc[s[3]] = pc.get(s[3], 0) + 1
        paths.append({"path": p, **totals_of([s[2] for s in mine], sum(1 for s in mine if s[4]), seconds), "statuses": statuses_of(pc)})
    timeline = []
    for b in range(int(seconds // BUCKET) + 1):
        mine = [s for s in samples if b * BUCKET <= s[0] < (b + 1) * BUCKET]
        started = sum(1 for i in range(o["vus"]) if o["ramp_up"] * i / o["vus"] <= (b + 1) * BUCKET)
        timeline.append({"t": b * BUCKET, "vus": min(o["vus"], started), "requests": len(mine), "errors": sum(1 for s in mine if s[4]), "p95Ms": round(percentile([s[2] for s in mine], 95), 1)})
    total = totals_of(lat, err, seconds)
    capped = len(samples) >= CEILINGS["requests"] and run.outcome == "completed"
    verdict, reason = verdict_of(run.outcome, total, counts, o)
    return {
        "version": 1, "outcome": run.outcome, "startedAt": started_at, "endedAt": ended_at,
        "params": {"vus": o["vus"], "durationSeconds": o["duration"], "rampUpSeconds": int(o["ramp_up"]), "paths": list(o["paths"])},
        "totals": total, "paths": paths, "timeline": timeline, "verdict": verdict,
        "verdictReason": (reason + (f" (stopped at the cap of {CEILINGS['requests']} requests)" if capped else ""))[:300],
    }


def out_path(path, request):
    """The file this run may write: a plain .json file name inside audits/request-N/ of this folder, never a link. A reason (str) if it is not."""
    root = os.path.realpath(os.path.join("audits", "request-" + str(request)))
    real = os.path.realpath(path)
    if os.path.islink(path) or not real.startswith(root + os.sep) or not real.endswith(".json"):
        return "the output file must be a .json file inside audits/request-" + str(request) + "/"
    return None


def options_of(a):
    return {"request": a.request, "base_url": a.base_url, "paths": a.path or [], "vus": a.vus, "duration": a.duration, "ramp_up": a.ramp_up, "max_error_rate": a.max_error_rate, "max_p95_ms": a.max_p95_ms}


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("action", choices=("plan", "run"))
    ap.add_argument("--request", required=True)
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--path", action="append")
    ap.add_argument("--vus", type=int, default=10)
    ap.add_argument("--duration", type=int, default=60)
    ap.add_argument("--ramp-up", type=int, default=10)
    ap.add_argument("--max-error-rate", type=float, default=5)
    ap.add_argument("--max-p95-ms", type=int, default=None)
    ap.add_argument("--out", default="")
    a = ap.parse_args(argv)
    o = options_of(a)
    problem = validate(o)
    out = a.out or os.path.join("audits", f"request-{a.request}", "loadtest.json")
    problem = problem or out_path(out, a.request)
    if problem:
        print("REFUSED:", problem)
        return 2
    plan = {"address": o["base_url"], "paths": o["paths"], "users": o["vus"], "seconds": o["duration"], "rampUpSeconds": o["ramp_up"], "stopAtErrorPercent": o["max_error_rate"],
            "stopAtP95Ms": o["max_p95_ms"], "method": "GET", "ceilings": CEILINGS, "writes": out}
    if a.action == "plan":
        print(json.dumps({"plan": plan}))
        return 0
    result = run_test(o)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump(result, f)
    t = result["totals"]
    print(json.dumps({"outcome": result["outcome"], "verdict": result["verdict"], "reason": result["verdictReason"], "requests": t["requests"], "errorRate": t["errorRate"], "p95Ms": t["p95Ms"], "wrote": out}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
