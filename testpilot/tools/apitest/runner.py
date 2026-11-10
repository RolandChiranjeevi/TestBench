"""Runs <audit-id>/api-plan.json against a target profile and records executions, actions, evidence and
observations in the audit package. See .claude/skills/testpilot-api-testing/SKILL.md.

    python3 tools/apitest/runner.py AUD-20261110-01 [--root .] [--items TPI-001,TPI-002] [--dry-run]

Refuses to start (and sends nothing) when the effective permission mode forbids a planned state change,
a state-changing item has no allowed action or would exceed its limit, the profile holds a literal
secret, or the profile is production without two recorded confirmations.
"""
import argparse
import base64
import datetime
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request
import uuid

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from apitest import contract as contract_mod
from apitest.redact import MASK, find_literal_secrets, is_secret_key, mask_secrets, redact_headers, redact_json, redact_text, redact_url
from apitest.request import RequestError, auth_headers, build_request, is_state_changing
from apitest.validate import Deviation, get_path, validate_response

MAX_TIMEOUT = 30.0
MAX_ATTEMPTS = 3
BODY_LIMIT = 64 * 1024
MODE = "saved-test"
SOURCE = "testpilot-api-testing"


class RunError(Exception):
    """The run cannot start or continue because of a rule, scope or profile problem."""


class ConnError(Exception):
    """No HTTP response at all: refused, unreachable, timed out.

    before_send is True only when the failure happened before any request bytes could have left (connection
    refused, name not resolved); a timeout or reset is not, because the server may have acted on the request.
    """

    def __init__(self, message, before_send=False):
        super().__init__(message)
        self.before_send = before_send


class WriteUncertain(ConnError):
    """A state-changing request got no response after it may have been sent: it is never retried."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # report the 3xx itself
        return None


OPENER = urllib.request.build_opener(_NoRedirect)


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def save_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def next_id(items, prefix):
    return f"{prefix}-{len(items) + 1:03d}"


def limit_of(text):
    match = re.match(r"\s*(\d+)", str(text))
    return int(match.group(1)) if match else 0


def path_value(obj, path):
    try:
        matches = get_path(obj, path)
    except ValueError:
        return None
    return matches[0][1] if matches else None


def http_call(prepared, timeout):
    """One HTTP exchange. Any HTTP status is a response; only transport failures raise ConnError."""
    request = urllib.request.Request(prepared.url, data=prepared.body, method=prepared.method, headers=prepared.headers)
    started = time.monotonic()
    try:
        with OPENER.open(request, timeout=timeout) as response:
            status, raw_headers, raw = response.status, response.headers, response.read(BODY_LIMIT + 1)
    except urllib.error.HTTPError as error:
        status, raw_headers, raw = error.code, error.headers, error.read(BODY_LIMIT + 1)
    except (urllib.error.URLError, socket.timeout, TimeoutError, OSError) as error:
        reason = getattr(error, "reason", error)
        raise ConnError(redact_text(str(reason)), before_send=isinstance(reason, (ConnectionRefusedError, socket.gaierror))) from None
    elapsed = round((time.monotonic() - started) * 1000, 1)
    headers = {}
    for name, value in raw_headers.items():
        key = name.lower()
        headers[key] = f"{headers[key]}, {value}" if key in headers else value
    text = raw[:BODY_LIMIT].decode("utf-8", errors="replace")
    try:
        body = json.loads(text) if text.strip() else None
    except ValueError:
        body = None
    return {"status": status, "headers": headers, "text": text, "json": body, "elapsed_ms": elapsed, "truncated": len(raw) > BODY_LIMIT}


def effective_mode(root, profile):
    """observe_only unless both the TestBench project profile and the target profile say full."""
    project_mode = "observe_only"
    global_path = os.path.join(root, "config", "testbench.json")
    if os.path.isfile(global_path):
        active = load_json(global_path).get("activeProject")
        project_path = os.path.join(root, "config", "projects", f"{active}.json") if active else None
        if project_path and os.path.isfile(project_path):
            project_mode = load_json(project_path).get("permissionMode", "observe_only")
    target_mode = profile.get("permissionMode", "observe_only")
    return "full" if project_mode == "full" and target_mode == "full" else "observe_only"


class Runner:
    def __init__(self, audit_id, root=".", env=None, items=None, dry_run=False, sleep=time.sleep):
        self.root = os.path.abspath(root)
        self.audit_id = audit_id
        self.env = os.environ if env is None else env
        self.pkg = os.path.join(self.root, audit_id)
        self.manifest_path = os.path.join(self.pkg, "manifest.json")
        self.plan = load_json(os.path.join(self.pkg, "api-plan.json"))
        self.manifest = load_json(self.manifest_path)
        self.profile = load_json(os.path.join(self.root, "config", "targets", f"{self.plan['target']}.json"))
        self.only = set(items) if items else None
        self.dry_run = dry_run
        self.sleep = sleep
        limits = self.profile.get("limits") or {}
        self.timeout = min(float(limits.get("timeoutSeconds", MAX_TIMEOUT)), MAX_TIMEOUT)
        self.max_attempts = max(1, min(int(limits.get("maxAttempts", MAX_ATTEMPTS)), MAX_ATTEMPTS))
        self.max_requests = int(limits.get("maxRequestsPerRun", 200))
        self.tokens = {}
        self.captures = {"run_id": uuid.uuid4().hex[:8]}
        self.requests_made = 0
        self.secrets = self.known_secrets()
        self.contract = None
        self.observations = []
        self.results = []
        for key in ("executions", "actions", "evidence"):
            self.manifest.setdefault(key, [])

    # ---------- secrets ----------

    def known_secrets(self):
        """Values of every environment variable the profile or plan refers to; masked wherever they appear."""
        names, found = set(), set()

        def walk(node):
            if isinstance(node, str):
                names.update(re.findall(r"\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}", node))
            elif isinstance(node, dict):
                for key, value in node.items():
                    if isinstance(value, str) and key.lower().endswith("envvar"):
                        names.add(value)
                    walk(value)
            elif isinstance(node, list):
                for value in node:
                    walk(value)

        walk(self.profile)
        walk(self.plan)
        for name in names:
            value = self.env.get(name)
            if value:
                found.add(value)
        return found

    def text(self, value):
        return mask_secrets(redact_text(value), self.secrets)

    def url(self, value):
        return redact_url(value, self.secrets)

    def scrub(self, value):
        if isinstance(value, (dict, list)):
            return mask_secrets(redact_json(value), self.secrets)
        if isinstance(value, str):
            return self.text(value)
        return value

    def safe(self, deviation):
        """A deviation whose values are masked: by key (a secret-looking path), by pattern and by known secret value."""
        hidden = is_secret_key(deviation.where)
        return Deviation(self.text(deviation.where), deviation.rule, MASK if hidden else self.scrub(deviation.expected),
                         MASK if hidden else self.scrub(deviation.actual))

    @staticmethod
    def changes_state(item):
        """A plan item changes state if it says so or if its request does. The request wins over a missing or false flag."""
        return bool(item.get("state_changing")) or is_state_changing(item.get("request"))

    # ---------- checks before anything is sent ----------

    def selected_items(self):
        return [i for i in self.plan.get("items", []) if self.only is None or i["test_plan_item_id"] in self.only]

    def preflight(self):
        profile = self.profile
        if not str(profile.get("baseUrl", "")).startswith(("http://", "https://")):
            raise RunError("the target profile has no http(s) baseUrl")
        secrets = find_literal_secrets(profile)
        if secrets:
            raise RunError("the target profile holds literal secrets at " + ", ".join(secrets) + "; use ${env:NAME}")
        if profile.get("production") and int(self.plan.get("productionConfirmations", 0)) < 2:
            raise RunError("production target without two recorded confirmations (api-plan.json productionConfirmations)")
        mode = effective_mode(self.root, profile)
        items = self.selected_items()
        if not items:
            raise RunError("no plan items selected")
        changing = [i["test_plan_item_id"] for i in items if self.changes_state(i)]
        if mode == "observe_only" and changing:
            raise RunError("permission mode is observe_only but these items change state: " + ", ".join(changing))
        scope = (self.manifest.get("scope") or {}).get("state_changes") or {}
        allowed = {a.get("action"): a for a in scope.get("allowed_actions", [])}
        planned = {}
        for item in items:
            if not self.changes_state(item):
                continue
            if not scope.get("allowed"):
                raise RunError(f"{item['test_plan_item_id']} changes state but the confirmed scope allows no state change")
            name = (item.get("action") or {}).get("action")
            if name not in allowed:
                raise RunError(f"{item['test_plan_item_id']}: action {name!r} is not in scope.state_changes.allowed_actions")
            planned[name] = planned.get(name, 0) + int(item.get("repeat", 1))
        done = {}
        for action in self.manifest["actions"]:
            done[action["action"]] = done.get(action["action"], 0) + 1
        for name, count in planned.items():
            limit = limit_of(allowed[name].get("limit"))
            if limit and done.get(name, 0) + count > limit:
                raise RunError(f"action {name}: {done.get(name, 0)} performed + {count} planned exceeds the limit {limit}")
        total = sum(int(i.get("repeat", 1)) for i in items)
        if total > self.max_requests:
            raise RunError(f"{total} planned requests exceed maxRequestsPerRun {self.max_requests}")
        if profile.get("schema"):
            self.contract = contract_mod.load_contract(profile["schema"], self.root)
        return mode

    # ---------- auth ----------

    def token_for(self, mode):
        if mode in self.tokens:
            return self.tokens[mode]
        auth = self.profile.get("auth") or {}
        if auth.get("type") == "basic":
            account = auth.get("secondAccount") or {} if mode == "second" else auth
            user, password = self.env.get(account.get("userEnvVar", "")), self.env.get(account.get("passwordEnvVar", ""))
            if not user or not password:
                raise RequestError(f"basic auth credentials for mode {mode} are not set in the environment")
            self.tokens[mode] = f"{user}:{password}"
            self.secrets.update({password, base64.b64encode(self.tokens[mode].encode()).decode()})
            return self.tokens[mode]
        login = auth.get("login")
        if not login:
            return None  # auth_headers falls back to tokenEnvVar for the default mode
        spec = dict(login)
        if mode == "second":
            second = auth.get("secondAccount")
            if not second or "body" not in second:
                raise RequestError("the profile has no secondAccount.body for the login request")
            spec["body"] = second["body"]
        prepared = build_request(spec, self.profile, self.env, self.captures, auth={})
        self.requests_made += 1
        response = self.call_with_attempts(prepared)
        if response["status"] >= 400:
            raise RequestError(f"login for auth mode {mode} failed with status {response['status']}")
        if auth.get("type") == "cookie":
            name = auth.get("cookieName", "session")
            match = re.search(rf"(?:^|,\s*){re.escape(name)}=([^;,]+)", response["headers"].get("set-cookie", ""))
            if not match:
                raise RequestError(f"the login response set no cookie named {name}")
            value = match.group(1)
        else:
            value = path_value(response["json"], login.get("tokenPath", "$.token"))
            if not value:
                raise RequestError(f"the login response has no value at {login.get('tokenPath', '$.token')}")
        self.tokens[mode] = str(value)
        self.secrets.add(self.tokens[mode])
        return self.tokens[mode]

    def auth_for(self, mode):
        if mode == "none":
            return {}
        token = self.token_for(mode) if mode in ("default", "second") else None
        return auth_headers(self.profile.get("auth"), mode, self.env, {mode: token} if token is not None else {})

    # ---------- calls ----------

    def call_with_attempts(self, prepared):
        """At most max_attempts tries, and only when no HTTP response arrived. Any status ends the attempts.

        A state-changing request is retried only when the failure came before anything was sent; after a timeout or
        reset it may already have been performed, so it raises WriteUncertain instead of trying again.
        """
        last = None
        writes = prepared.changes_state()
        for attempt in range(1, self.max_attempts + 1):
            try:
                response = http_call(prepared, self.timeout)
                response["attempt"] = attempt
                return response
            except ConnError as error:
                if writes and not error.before_send:
                    raise WriteUncertain(f"{error}; not retried because the write may have been performed on the target, check it there before rerunning") from None
                last = error
                if attempt < self.max_attempts:
                    self.sleep(min(2 ** (attempt - 1), 4))
        raise ConnError(f"{last} (after {self.max_attempts} attempts)")

    # ---------- one item ----------

    def run_item(self, item):
        tpi = item["test_plan_item_id"]
        started = utc_now()
        execution_id = next_id(self.manifest["executions"], "EX")
        prepared, responses, deviations, contract_devs = None, [], [], []
        status, reason, notes, performed = "pass", None, [], 0
        changing = self.changes_state(item)
        expect = item.get("expect") or {}
        try:
            request_spec = item.get("request") or {}
            prepared = build_request(request_spec, self.profile, self.env, self.captures, auth=self.auth_for(request_spec.get("auth", "default")))
            for i in range(int(item.get("repeat", 1))):
                if self.requests_made >= self.max_requests:
                    raise RunError(f"maxRequestsPerRun {self.max_requests} reached")
                self.requests_made += 1
                response = self.call_with_attempts(prepared)
                responses.append(response)
                if changing and 200 <= response["status"] < 300:
                    performed += 1
                if response["status"] == 429:
                    notes.append(f"429 after {i + 1} request(s), Retry-After={response['headers'].get('retry-after')!r}; not retried")
                    break
            last = responses[-1]
            root_doc = self.contract["doc"] if self.contract and self.contract["kind"] == "openapi" else None
            deviations = [self.safe(d) for d in validate_response(last, expect, root=root_doc)]
            if self.contract and expect.get("contract", "report") != "skip":
                found = [self.safe(d) for d in contract_mod.check(self.contract, prepared, request_spec, last)]
                if expect.get("contract") == "fail":
                    deviations.extend(found)
                else:
                    contract_devs = found
            for name, path in (item.get("capture") or {}).items():
                value = path_value(last["json"], path)
                if value is not None:
                    self.captures[name] = value
            if deviations:
                status = "fail"
        except WriteUncertain as error:
            status, reason = "inconclusive", "insufficient-evidence"
            notes.append(f"no response to a state-changing request: {error}")
        except ConnError as error:
            status, reason = "blocked", "environment"
            notes.append(f"no response: {error}")
        except RequestError as error:
            status, reason = "blocked", "test-data"
            notes.append(str(error))
        except RunError as error:
            status, reason = "blocked", "tooling"
            notes.append(str(error))
        except Exception as error:  # a runner fault is never a product result
            status, reason = "inconclusive", "tooling"
            notes.append(f"runner error: {type(error).__name__}: {error}")
        finished = utc_now()
        notes = [self.text(note) for note in notes]
        evidence_ids = []
        if prepared is not None or responses:
            evidence_ids.append(self.write_evidence(item, execution_id, prepared, responses, deviations, contract_devs, started))
        if status == "pass":
            checked = ", ".join(k for k in ("status", "headers", "body", "schema", "graphqlErrors") if k in expect) or "no expectations"
            summary = f"Verified: {prepared.method} {self.url(prepared.url)} answered {responses[-1]['status']} in {responses[-1]['elapsed_ms']} ms and met {checked}."
            if len(responses) > 1:
                summary += f" {len(responses)} requests sent; statuses {[r['status'] for r in responses]}."
            if contract_devs:
                summary += f" Not verified against the contract: {len(contract_devs)} deviation(s) recorded as observations."
        elif status == "fail":
            summary = "Violated criterion: " + "; ".join(d.text() for d in deviations[:6]) + (f" (+{len(deviations) - 6} more)" if len(deviations) > 6 else "") + "."
        else:
            summary = "; ".join(notes) or status
        if notes and status in ("pass", "fail"):
            summary += " " + " ".join(notes)
        summary = mask_secrets(summary, self.secrets)  # urls, deviations and notes were masked piece by piece above
        self.manifest["executions"].append({
            "execution_id": execution_id, "test_plan_item_id": tpi, "requirement_id": item.get("requirement_id"),
            "status": status, "reason": reason, "started_at": started, "finished_at": finished,
            "url": self.url(prepared.url) if prepared else None, "viewport": None, "mode": MODE,
            "evidence_ids": evidence_ids, "summary": summary})
        action = item.get("action") or {}
        for _ in range(performed):
            self.manifest["actions"].append({
                "action_id": next_id(self.manifest["actions"], "ACT"), "execution_id": execution_id,
                "action": action.get("action"), "target": action.get("target", tpi), "allowed_by_scope": True,
                "performed_at": finished, "evidence_ids": list(evidence_ids)})
        if contract_devs:
            self.observations.append({
                "id": f"OBS-API-{len(self.observations) + 1 + self.existing_observations}", "auditId": self.audit_id, "kind": "api_test",
                "title": f"Contract deviation: {prepared.method} {self.url(prepared.url)}"[:300], "severity": "low", "status": "observed",
                "evidence": self.text("; ".join(d.text() for d in contract_devs[:8])), "evidenceIds": list(evidence_ids),
                "recommendation": "Align the API or its schema so the documented paths, statuses and bodies match what the API does.",
                "source": SOURCE, "execution_id": execution_id})
        self.results.append({"test_plan_item_id": tpi, "execution_id": execution_id, "status": status, "reason": reason})
        return status

    def write_evidence(self, item, execution_id, prepared, responses, deviations, contract_devs, captured_at):
        os.makedirs(os.path.join(self.pkg, "evidence"), exist_ok=True)
        location = f"evidence/api-{item['test_plan_item_id'].lower()}-{execution_id.lower()}-{captured_at[:10]}.json"
        record = {
            "captured_at": captured_at, "test_plan_item_id": item["test_plan_item_id"], "execution_id": execution_id,
            "request": prepared.redacted(self.secrets) if prepared else None,
            "responses": [self.redact_response(r) for r in responses],
            "deviations": [d.to_dict() for d in deviations],
            "contract_deviations": [d.to_dict() for d in contract_devs],
        }
        record = mask_secrets(record, self.secrets)  # last pass: no known secret value survives anywhere in the file
        save_json(os.path.join(self.pkg, location), record)
        evidence_id = next_id(self.manifest["evidence"], "EV")
        self.manifest["evidence"].append({
            "evidence_id": evidence_id, "type": "network-trace", "source": "other", "location": location,
            "related": [execution_id], "captured_at": captured_at,
            "description": f"Redacted request and {len(responses)} response(s) for {item['test_plan_item_id']}", "redacted": True})
        return evidence_id

    @staticmethod
    def redact_response(response):
        body = redact_json(response["json"]) if response.get("json") is not None else redact_text((response.get("text") or "")[:4000])
        return {"status": response["status"], "headers": redact_headers(response.get("headers") or {}), "body": body,
                "elapsed_ms": response.get("elapsed_ms"), "attempt": response.get("attempt"), "truncated": response.get("truncated", False)}

    # ---------- the run ----------

    def run(self):
        mode = self.preflight()
        items = self.selected_items()
        if self.dry_run:
            problems = []
            for item in items:
                try:
                    build_request(item.get("request") or {}, self.profile, self.env, {**self.captures, "__dry__": ""}, auth={})
                except RequestError as error:
                    if "capture" not in str(error):
                        problems.append(f"{item['test_plan_item_id']}: {error}")
            return {"dry_run": True, "mode": mode, "items": [i["test_plan_item_id"] for i in items], "problems": problems}
        observations_path = os.path.join(self.pkg, "api-observations.json")
        existing = load_json(observations_path) if os.path.isfile(observations_path) else []
        self.existing_observations = len(existing)
        run_started = utc_now()
        for item in items:
            self.run_item(item)
        counts = {}
        for result in self.results:
            counts[result["status"]] = counts.get(result["status"], 0) + 1
        summary_location = f"evidence/api-run-summary-{run_started.replace(':', '').replace('-', '')}.json"
        save_json(os.path.join(self.pkg, summary_location), {
            "captured_at": run_started, "finished_at": utc_now(), "target": self.plan["target"], "mode": mode, "requests_made": self.requests_made,
            "counts": counts, "results": self.results, "tools": ["tools/apitest/runner.py (urllib)"]})
        self.manifest["evidence"].append({
            "evidence_id": next_id(self.manifest["evidence"], "EV"), "type": "test-output", "source": "other", "location": summary_location,
            "related": [r["execution_id"] for r in self.results], "captured_at": run_started,
            "description": f"API run summary: {len(self.results)} executions, {self.requests_made} requests", "redacted": True})
        save_json(self.manifest_path, self.manifest)
        if self.observations:
            save_json(observations_path, existing + self.observations)
        return {"dry_run": False, "mode": mode, "counts": counts, "requests_made": self.requests_made,
                "observations": len(self.observations), "results": self.results}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run an API test plan into an audit package.")
    parser.add_argument("audit_id")
    parser.add_argument("--root", default=".")
    parser.add_argument("--items", help="comma-separated test_plan_item_ids")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    try:
        runner = Runner(args.audit_id, root=args.root, items=args.items.split(",") if args.items else None, dry_run=args.dry_run)
        result = runner.run()
    except (RunError, FileNotFoundError, ValueError) as error:
        print(f"refused: {redact_text(str(error))}", file=sys.stderr)
        return 2
    if result["dry_run"]:
        print(f"dry run ok: mode {result['mode']}, {len(result['items'])} items" + (f"; problems: {result['problems']}" if result["problems"] else ""))
    else:
        print(f"mode {result['mode']}: {result['counts']} in {result['requests_made']} requests; {result['observations']} observation(s)")
        for item in result["results"]:
            print(f"  {item['execution_id']} {item['test_plan_item_id']} {item['status']}" + (f" ({item['reason']})" if item["reason"] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
