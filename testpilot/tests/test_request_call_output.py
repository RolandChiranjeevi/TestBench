"""What `testpilot/tools/request_call.py` prints: terminal-safe, and the contract in docs/agent-requests.md ("What the helper prints, and its exit codes").

Two things are tested here, and both are about the lines the helper prints, never about what the skills do with them:
  1. A property: whatever text a server (or a library) puts in an answer, everything the helper prints is printable ASCII and line breaks. Strings are made up by a seeded random generator from
     the characters that can steer a terminal (escape sequences, C1 controls, right-to-left and invisible characters, line separators, a BOM, emoji), so the test is the same on every run.
  2. A contract: each row of the table in the docs is run, and its exit code and the shape of its first line must be what the docs say.
Run: python3 -m unittest discover -s testpilot/tests
"""
import contextlib
import io
import json
import os
import random
import re
import shutil
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent.parent
DOCS = (ROOT / "docs" / "agent-requests.md").read_text()
sys.path.insert(0, str(ROOT / "testpilot" / "tools"))
import request_call  # noqa: E402

TOKEN = "tbrq_" + "a" * 24
VAR = "TB_TOK_CONTRACT"

# Everything that can steer a terminal or hide what a line says, and a few plain characters to mix with it.
PIECES = ["\x1b", "\x1b[31m", "\x1b]0;owned\x07", "\x9b", "\x85", "\x00", "\r", "\n", "\t", "\x7f", "\x08", "‮", "‪", "⁦", "⁩", "​", "‏", "⁠", "﻿",
          " ", " ", "\U000e0041", "\U0001f600", "́", "é", "ö", "a", "Z", "7", " ", "<script>", "'", '"', "\\", "`", "$("]


def nasty(rng, longest=14):
    return "".join(rng.choice(PIECES) for _ in range(rng.randint(1, longest)))


def printable_only(text):
    return all(c == "\n" or 0x20 <= ord(c) <= 0x7E for c in text)


def shown(data, code="200", action="list", rid=""):
    """What `show` prints for an answer (data, as JSON) and its exit status."""
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        status = request_call.show(json.dumps(data).encode(), code, action, rid)
    return status, out.getvalue()


class PrintableTests(unittest.TestCase):
    def test_every_character_that_can_steer_a_terminal_becomes_a_visible_escape(self):
        for ch, shown_as in (("\x1b", "\\x1b"), ("\x9b", "\\x9b"), ("\x00", "\\x00"), ("\x7f", "\\x7f"), ("\r", "\\r"), ("\n", "\\n"), ("\t", "\\t"), ("‮", "\\u202e"), ("⁦", "\\u2066"),
                             ("​", "\\u200b"), ("﻿", "\\ufeff"), (" ", "\\u2028"), ("\U0001f600", "\\U0001f600"), ("\U000e0041", "\\U000e0041")):
            with self.subTest(char=shown_as):
                self.assertEqual(request_call.printable("a" + ch + "b"), "a" + shown_as + "b")

    def test_plain_ascii_is_left_exactly_as_it_is(self):
        text = "The request number must be the number of a request (1-9): `x` \"y\" 'z' \\ <>&$"
        self.assertEqual(request_call.printable(text), text)

    def test_what_it_makes_is_always_printable_ascii_without_line_breaks(self):
        rng = random.Random(20261124)
        for _ in range(300):
            out = request_call.printable(nasty(rng, 40))
            self.assertTrue(all(0x20 <= ord(c) <= 0x7E for c in out), repr(out))


class NothingFromAServerSteersATerminal(unittest.TestCase):
    """Property: the same seeded random strings in every text field of every kind of answer, and the output is printable ASCII and line breaks, and nothing else."""

    ROUNDS = 150

    def request(self, rng, kind):
        s = lambda: nasty(rng)
        base = {"id": rng.randint(1, 99), "kind": kind, "status": s(), "environment": s(), "targetUrl": s(), "name": s(), "note": s(), "createdBy": s(), "createdAt": s(), "runId": s(),
                "tests": [{"id": 1, "framework": s(), "file": s(), "title": s(), "fullName": s()}] * 2, "resultNote": s(), "releaseNote": s(), "resultRunId": s(), "finishedAt": s(),
                "claimedAt": s(), "caseCount": s(), "progress": s(), "warning": s(), "resultAuditId": s()}
        if kind == "discover":
            base["options"] = {"targetMode": s(), "gitMode": s(), "deliverables": [s(), "plan"], "viewports": [s()], "checks": [s()], "depth": s(), "production": s()}
        if kind == "loadtest":
            base["loadOptions"] = {"vus": s(), "durationSeconds": s(), "paths": [s(), s()], "maxErrorRatePercent": s()}
        if kind == "run":
            base["cases"] = [{"caseId": s(), "key": s(), "title": s(), "priority": s(), "description": s(), "preconditions": s(),
                              "steps": [{"id": s(), "action": s(), "expected": s()}], "automatedTests": [{"fullName": s()}], "specFiles": [s()]}]
        return base

    def test_listing_and_claiming_every_kind_of_request(self):
        rng = random.Random(7)
        for i in range(self.ROUNDS):
            for kind in ("discover", "rerun", "run", "loadtest"):
                for action, rid, wrap in (("list", "", lambda q: [q]), ("list", "12", lambda q: [dict(q, id=12)]), ("claim", "12", lambda q: dict(q, id=12))):
                    status, out = shown(wrap(self.request(rng, kind)), "200", action, rid)
                    self.assertTrue(printable_only(out), f"{kind} {action} round {i}: {out!r}")

    def test_release_and_complete_with_notes_and_warnings_from_the_server(self):
        rng = random.Random(8)
        for i in range(self.ROUNDS):
            for action in ("release", "complete"):
                status, out = shown(self.request(rng, "run"), "200", action, "12")
                self.assertTrue(printable_only(out), f"{action} round {i}: {out!r}")

    def test_results_and_a_refused_answer_with_text_where_a_number_should_be(self):
        rng = random.Random(9)
        for i in range(self.ROUNDS):
            s = lambda: nasty(rng)
            for action, data in (("result", {"runId": s(), "total": s(), "linked": s()}),
                                 ("case-results", {"reported": s(), "counts": {"passed": s(), "failed": s()}, "progress": {"total": s(), "reported": s()}}),
                                 ("load-result", {"verdict": s(), "outcome": s()})):
                status, out = shown(data, "200", action, "12")
                self.assertTrue(printable_only(out), f"{action} round {i}: {out!r}")
            for data in ({"error": s()}, {"error": {"a": s()}}, [s()], s(), {"other": s()}):
                status, out = shown(data, "409", "complete", "12")
                self.assertEqual(status, 1)
                self.assertTrue(printable_only(out), f"refused round {i}: {out!r}")

    def test_an_answer_that_is_not_json_prints_a_fixed_line(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            status = request_call.show(b"\x1b[31m not json \xe2\x80\xae", "200", "list", "")
        self.assertEqual((status, out.getvalue()), (1, "the answer was not JSON\n"))


@contextlib.contextmanager
def agent_folder(profile=True, var=VAR):
    """A temporary agent folder (the helper reads `.testpilot/` and `audits/` from the folder it is run in), with a profile unless told not to."""
    old, d = os.getcwd(), tempfile.mkdtemp()
    try:
        os.chdir(d)
        if profile:
            Path(".testpilot/projects").mkdir(parents=True)
            Path(".testpilot/testbench.json").write_text(json.dumps({"baseUrl": "http://127.0.0.1:1", "activeProject": "p"}))
            Path(".testpilot/projects/p.json").write_text(json.dumps({"projectId": 7, **({"requestTokenEnvVar": var} if var else {})}))
        yield Path(d)
    finally:
        os.chdir(old)
        shutil.rmtree(d, ignore_errors=True)


def run_main(args, *, send=None, token=TOKEN):
    """Runs the helper in the current folder with the call to TestBench replaced by `send` (a function, or an exception to raise). Returns (exit status, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    env = {"PATH": os.environ.get("PATH", "")}
    if token is not None:
        env[VAR] = token
    with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(request_call, "send", side_effect=send), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        status = request_call.main(args)
    return status, out.getvalue(), err.getvalue()


def answer(code, data):
    return lambda *a, **k: (code, json.dumps(data).encode() if not isinstance(data, bytes) else data)


FOLDER = "audits/request-12/20261123-194213"
FINDINGS = {"findings": [{"kind": "observation", "title": "One", "severity": "info"}]}


def put(path, content):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(content if isinstance(content, str) else json.dumps(content))


DOT = "\u00b7"


def rows(*lines):
    return "\n".join(l.replace(" | ", f" {DOT} ") for l in lines) + "\n"


FORM_ALL = rows(
    "## /form.html",
    "Name | empty | tried | actions 1 | required message seen",
    "Name | wrong-kind | tried | actions 2, 3 | emoji accepted",
    "Name | too-long | tried | actions 4 | 300 letters accepted",
    "Name | boundary | tried | actions 5 | one letter accepted",
    "Email | format | tried | actions 6 | no @ refused",
    "Form | enter | tried | actions 7 | Enter sent it",
    "## /about.html",
    "Page | links | tried | actions 8 | same origin links open",
)
COVERAGE = f"{FOLDER}/coverage.md"
ACTIONS_LOG = "1. /form.html: x\n2. /form.html: y\n8. /about.html: z\n"


class PrecheckSeesWhatIsMissingBeforeLogout(unittest.TestCase):
    def check(self, coverage, log=ACTIONS_LOG, args=None):
        with agent_folder():
            put(COVERAGE, coverage)
            put(f"{FOLDER}/actions.md", log)
            status, out, err = run_main(args or ["precheck", "12", f"--coverage={COVERAGE}"])
        return status, out.splitlines()

    def test_a_form_with_every_input_class_and_a_page_with_only_links_is_ok(self):
        status, lines = self.check(FORM_ALL)
        self.assertEqual(status, 0, lines)
        self.assertRegex(lines[0], r"^precheck: 2 pages, 7 rows \(tried 7, issue 0, not tried 0\), 0 gaps$")

    def test_a_form_page_without_too_long_boundary_format_and_enter_is_a_gap_that_names_them(self):
        short = rows("## /form.html", "Name | empty | tried | actions 1 | x", "Name | wrong-kind | tried | actions 2 | x", "## /about.html", "Page | links | tried | actions 8 | x")
        status, lines = self.check(short)
        self.assertEqual(status, 1)
        self.assertIn("GAP /form.html: takes input, but no row for: too-long, boundary, format, enter", lines)

    def test_a_row_can_name_several_classes_at_once(self):
        both = FORM_ALL.replace(f"Name {DOT} too-long {DOT} tried {DOT} actions 4", f"Name {DOT} too-long/boundary {DOT} tried {DOT} actions 4").replace(f"Name {DOT} boundary {DOT} tried {DOT} actions 5 {DOT} one letter accepted\n", "")
        status, lines = self.check(both)
        self.assertEqual(status, 0, lines)

    def test_a_page_acted_on_in_the_log_with_no_rows_is_a_gap(self):
        status, lines = self.check(FORM_ALL, log=ACTIONS_LOG + "9. /cart.html?id=4: pressed\n")
        self.assertEqual(status, 1)
        self.assertIn("GAP /cart.html: acted on in actions.md but no coverage rows", lines)

    def test_a_row_that_says_tried_without_action_numbers_counts_as_not_tried_and_is_a_gap(self):
        bad = FORM_ALL.replace(f"Form {DOT} enter {DOT} tried {DOT} actions 7 {DOT} Enter sent it", f"Form {DOT} enter {DOT} tried {DOT} it worked")
        status, lines = self.check(bad)
        self.assertEqual(status, 1)
        self.assertRegex(lines[0], r"\(tried 6, issue 0, not tried 1\), 1 gaps$")
        self.assertTrue(any(l.startswith("GAP /form.html | Form | enter: says tried but names no action numbers") for l in lines), lines)

    def test_a_not_tried_row_with_a_reason_is_listed_as_left_and_is_not_a_gap(self):
        left = FORM_ALL.replace(f"Form {DOT} enter {DOT} tried {DOT} actions 7 {DOT} Enter sent it", f"Form {DOT} enter {DOT} not tried {DOT} a CAPTCHA")
        status, lines = self.check(left)
        self.assertEqual(status, 0, lines)
        self.assertIn("LEFT /form.html | Form | enter | a CAPTCHA", lines)

    def test_a_not_tried_row_with_a_soft_reason_is_a_gap_because_that_is_how_deep_run_3_left_the_checkout_form(self):
        soft = FORM_ALL.replace(f"Form {DOT} enter {DOT} tried {DOT} actions 7 {DOT} Enter sent it", f"Form {DOT} enter {DOT} not tried {DOT} not reached in this run")
        status, lines = self.check(soft)
        self.assertEqual(status, 1)
        self.assertTrue(any(l.startswith("GAP /form.html | Form | enter: not tried, and \"not reached in this run\" is not a hard reason") for l in lines), lines)

    def test_the_reasons_that_only_say_it_was_not_done_are_gaps_too_as_not_looked_at_was_for_three_pages_in_deep_key1(self):
        for why in ("not looked at in another size", "did not look at it", "didn't look at it", "never looked at at tablet size", "not checked", "not examined", "not covered", "not tried yet"):
            with self.subTest(why=why):
                soft = FORM_ALL.replace(f"Form {DOT} enter {DOT} tried {DOT} actions 7 {DOT} Enter sent it", f"Form {DOT} enter {DOT} not tried {DOT} {why}")
                status, lines = self.check(soft)
                self.assertEqual(status, 1, lines)
                self.assertTrue(any(l.startswith("GAP /form.html | Form | enter: not tried") for l in lines), lines)

    def test_a_reason_that_says_why_it_could_not_be_done_is_still_not_a_gap(self):
        for why in ("a CAPTCHA", "another origin (x.com): not followed", "no PDF renderer here", "the session had ended on its own"):
            with self.subTest(why=why):
                left = FORM_ALL.replace(f"Form {DOT} enter {DOT} tried {DOT} actions 7 {DOT} Enter sent it", f"Form {DOT} enter {DOT} not tried {DOT} {why}")
                status, lines = self.check(left)
                self.assertEqual(status, 0, lines)

    def test_a_file_outside_the_request_folder_or_not_markdown_is_refused(self):
        for path in ("elsewhere.md", f"{FOLDER}/coverage.txt"):
            with self.subTest(path=path):
                with agent_folder():
                    put(path, FORM_ALL)
                    status, out, err = run_main(["precheck", "12", f"--coverage={path}"])
                self.assertEqual((status, out.strip()), (1, "the file must be a .md file inside audits/request-12/"))

    def test_it_needs_no_token_and_makes_no_call(self):
        with agent_folder():
            put(COVERAGE, FORM_ALL)
            status, out, err = run_main(["precheck", "12", f"--coverage={COVERAGE}"], token=None, send=AssertionError("a call was made"))
        self.assertEqual(status, 0, out)


class KnownAndKeysInFindings(unittest.TestCase):
    """`known` lists what earlier requests already made and keyed; a finding can carry a `key`, and the helper says when TestBench saw a thing again."""
    KNOWN = {"test_cases": [{"id": 3, "number": 12, "key": "case:cart:empty-checkout", "title": "Checkout with an empty cart", "seen": 2}],
             "bug_reports": [{"id": 9, "key": "cart:float-total", "title": "Item total shows a float\x1b[31m error", "seen": 0}], "observations": []}

    def test_known_prints_one_cleaned_line_per_post_and_a_fixed_line_when_there_is_nothing(self):
        with agent_folder():
            status, out, _ = run_main(["known", "12"], send=answer(200, self.KNOWN))
        self.assertEqual(status, 0)
        lines = [json.loads(x) for x in out.splitlines() if x.startswith("{")]
        self.assertEqual([x["kind"] for x in lines], ["test_case", "bug_report"])
        self.assertEqual(lines[0]["number"], 12)
        self.assertEqual(lines[0]["seen_again"], 2)
        self.assertTrue(printable_only(out), out)
        with agent_folder():
            status, out, _ = run_main(["known", "12"], send=answer(200, {"test_cases": [], "bug_reports": [], "observations": []}))
        self.assertIn("nothing earlier is known", out)

    def test_known_needs_a_request_number_and_is_a_get(self):
        with agent_folder():
            self.assertEqual(run_main(["known"], send=answer(200, self.KNOWN))[0], 1)
            calls = []
            run_main(["known", "12"], send=lambda m, u, h, b, t: (calls.append((m, u, b)) or (200, json.dumps(self.KNOWN).encode())))
        self.assertEqual(calls[0][0], "GET")
        self.assertTrue(calls[0][1].endswith("/api/agent/projects/7/requests/12/known"), calls[0][1])
        self.assertIsNone(calls[0][2])

    def test_a_key_is_checked_before_anything_is_sent(self):
        bad = [({"kind": "plan_item", "title": "x", "key": "cart:total"}, "key is for a test_case"), ({"kind": "bug_report", "title": "x", "key": "Cart Total"}, "lower case words"),
               ({"kind": "bug_report", "title": "x", "key": "cart"}, "lower case words"), ({"kind": "observation", "title": "x", "key": 5}, "lower case words")]
        for f, why in bad:
            with self.subTest(f=f):
                with agent_folder():
                    put(f"{FOLDER}/findings-1.json", {"findings": [f]})
                    calls = []
                    status, out, _ = run_main(["findings", "12", f"--findings={FOLDER}/findings-1.json"], send=lambda *a, **k: calls.append(a))
                self.assertEqual(status, 1)
                self.assertIn(why, out)
                self.assertEqual(calls, [], "nothing was sent")

    def test_a_good_key_is_sent_and_a_sighting_or_a_possible_duplicate_is_shown(self):
        f = {"kind": "test_case", "title": "x", "key": "case:cart:empty-checkout"}
        with agent_folder():
            put(f"{FOLDER}/findings-1.json", {"findings": [f, {**f, "key": "case:cart:other"}]})
            sent = []
            replies = iter([(201, json.dumps({"kind": "test_case", "id": 3, "number": 12, "seenAgain": True, "findingsOnRequest": 1}).encode()),
                            (201, json.dumps({"kind": "test_case", "id": 4, "number": 13, "possibleDuplicateOf": 3, "sourceId": "$agent-12-2", "findingsOnRequest": 2}).encode())])
            status, out, _ = run_main(["findings", "12", f"--findings={FOLDER}/findings-1.json"], send=lambda m, u, h, b, t: (sent.append(json.loads(b)) or next(replies)))
        self.assertEqual(status, 0, out)
        self.assertEqual(sent[0]["key"], "case:cart:empty-checkout")
        lines = [json.loads(x) for x in out.splitlines() if x.startswith("{")]
        self.assertTrue(lines[0]["seenAgain"])
        self.assertEqual(lines[0]["number"], 12)
        self.assertEqual(lines[1]["possibleDuplicateOf"], 3)
        self.assertNotIn("seenAgain", lines[1])


class TheHelperIsTerminalSafeOnItsOwnLines(unittest.TestCase):
    def test_a_failed_call_whose_reason_comes_from_a_library_or_a_certificate_prints_ascii_only(self):
        rng = random.Random(10)
        for i in range(60):
            reason = nasty(rng, 40)
            with agent_folder():
                status, out, err = run_main(["list"], send=urllib.error.URLError(reason))
            self.assertEqual(status, 1)
            self.assertTrue(printable_only(out + err), f"round {i}: {out!r}")
            self.assertIn("the call failed (network or timeout", out)

    def test_a_refused_finding_with_text_from_the_server_prints_ascii_only(self):
        rng = random.Random(11)
        for i in range(60):
            with agent_folder():
                put(f"{FOLDER}/findings-1.json", FINDINGS)
                status, out, err = run_main(["findings", "12", f"--findings={FOLDER}/findings-1.json"], send=answer(409, {"error": nasty(rng, 40)}))
            self.assertEqual(status, 1)
            self.assertTrue(printable_only(out + err), f"round {i}: {out!r}")


class TheContractInTheDocs(unittest.TestCase):
    """Each row of the table in docs/agent-requests.md is run here. The test fails when a row is not run, when the docs say another exit code than the code gives, or when the first line is not the one written."""

    def rows(self):
        part = DOCS.split("## What the helper prints, and its exit codes", 1)[1].split("\n## ", 1)[0]
        rows = {}
        for line in part.splitlines():
            m = re.match(r"\| `([a-z0-9-]+)` \|(.*)\|\s*(\d)\s*\|\s*$", line)
            if m:
                rows[m.group(1)] = int(m.group(3))
        return rows

    def scenarios(self):
        """id -> (exit status, stdout lines, stderr) for the row, by running the helper."""
        out = {}

        def go(name, args, folder=None, **kw):
            with agent_folder(**(folder or {})) as d:
                for path, content in (kw.pop("files", {}) or {}).items():
                    put(path, content)
                status, so, se = run_main(args, **kw)
            out[name] = (status, so.splitlines(), se)

        go("bad-arguments", ["bogus"])
        go("config-unreadable", ["list"], folder={"profile": False}, files={".testpilot/testbench.json": "{not json"})
        go("no-token-variable", ["list"], folder={"var": None})
        go("no-token", ["list"], token=None)
        go("file-refused", ["findings", "12", "--findings=elsewhere.json"], files={"elsewhere.json": FINDINGS})
        go("call-failed", ["list"], send=urllib.error.URLError("refused"))
        go("answered-200", ["list"], send=answer(200, []))
        go("answered-other", ["list"], send=answer(404, {"error": "not found"}))
        go("not-json", ["list"], send=answer(200, b"<html>no</html>"))
        go("findings-made", ["findings", "12", f"--findings={FOLDER}/findings-1.json"], files={f"{FOLDER}/findings-1.json": FINDINGS}, send=answer(201, {"id": 5, "sourceId": "$agent-12-1"}))
        go("precheck-ok", ["precheck", "12", f"--coverage={COVERAGE}"], files={COVERAGE: FORM_ALL, f"{FOLDER}/actions.md": ACTIONS_LOG})
        go("precheck-gaps", ["precheck", "12", f"--coverage={COVERAGE}"], files={COVERAGE: rows("## /form.html", "Name | empty | tried | actions 1 | x"), f"{FOLDER}/actions.md": ACTIONS_LOG})
        go("precheck-refused", ["precheck", "12", "--coverage=elsewhere.md"], files={"elsewhere.md": FORM_ALL})
        go("findings-stopped", ["findings", "12", f"--findings={FOLDER}/findings-1.json"], files={f"{FOLDER}/findings-1.json": FINDINGS}, send=answer(409, {"error": "full"}))
        return out

    SHAPE = {
        "bad-arguments": r"^The action must be list, claim",
        "config-unreadable": r"^The TestPilot configuration could not be read",
        "no-token-variable": r"^requestTokenEnvVar is not set",
        "no-token": r"^no usable request token$",
        "file-refused": r"^the file must be a \.json file inside audits/request-12/$",
        "call-failed": r"^the call failed \(network or timeout.*\): not retried here$",
        "answered-200": r"^list HTTP 200$",
        "answered-other": r"^list HTTP 404$",
        "not-json": r"^list HTTP 200$",
        "findings-made": r"^\{\"n\": 1, \"kind\": \"observation\"",
        "precheck-ok": r"^precheck: \d+ pages, \d+ rows \(tried \d+, issue \d+, not tried \d+\), 0 gaps$",
        "precheck-gaps": r"^precheck: \d+ pages, \d+ rows \(tried \d+, issue \d+, not tried \d+\), [1-9]\d* gaps$",
        "precheck-refused": r"^the file must be a \.md file inside audits/request-12/$",
        "findings-stopped": r"^\{\"stopped_at\": 1, ",
    }

    def test_every_row_of_the_table_is_run_and_nothing_is_run_that_the_table_does_not_name(self):
        self.assertEqual(sorted(self.rows()), sorted(self.SHAPE), "the ids of the table in the docs and the rows run here")

    def test_the_exit_code_of_each_row_is_the_one_in_the_docs_and_its_first_line_has_the_documented_shape(self):
        docs, ran = self.rows(), self.scenarios()
        for name, (status, lines, err) in ran.items():
            with self.subTest(row=name):
                self.assertEqual(status, docs[name], f"{name}: the docs say exit {docs[name]}")
                self.assertTrue(lines, f"{name} printed nothing")
                self.assertRegex(lines[0], self.SHAPE[name])

    def test_the_second_line_of_an_answer_is_the_one_the_docs_name(self):
        ran = self.scenarios()
        self.assertTrue(ran["answered-other"][1][1].startswith("ERROR: "))
        self.assertEqual(ran["not-json"][1][1], "the answer was not JSON")
        self.assertIn('"made"', ran["findings-made"][1][-1])
        self.assertEqual(len(ran["findings-made"][1]), 2, "one line per finding, then the summary")
        self.assertIn('"stopped_at"', ran["findings-stopped"][1][-1])

    def test_nothing_it_prints_in_any_row_holds_the_token_or_anything_but_ascii(self):
        for name, (status, lines, err) in self.scenarios().items():
            with self.subTest(row=name):
                text = "\n".join(lines) + err
                self.assertNotIn(TOKEN, text)
                self.assertTrue(printable_only(text), repr(text))

    def test_the_docs_make_the_promises_the_tests_hold_it_to(self):
        part = DOCS.split("## What the helper prints, and its exit codes", 1)[1].split("\n## ", 1)[0]
        for must in ("**Everything it prints is printable ASCII** (and line breaks).", "**It never prints the token**", "Existing lines do not change; a new line or key may be added."):
            with self.subTest(must=must):
                self.assertIn(must, part)


if __name__ == "__main__":
    unittest.main()


PNG = b"\x89PNG\r\n\x1a\n" + b"\x01" * 32


def put_bytes(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_bytes(data)


class ScreenshotsOfABug(unittest.TestCase):
    """Plan step 3b: a bug_report may name a `before` and a `bug` picture in the folder of the claim. The helper reads them all before anything is sent, sends the bug, and then each
    picture to the bug TestBench made. A bug that was seen again gets none. A refused picture leaves the bug made, and the line says so."""

    BUG = {"kind": "bug_report", "title": "Cart: total wrong", "actual": "0", "url": "http://localhost/cart", "screenshots": {"before": f"{FOLDER}/b1-before.png", "bug": f"{FOLDER}/b1-bug.png"}}

    def run_with(self, finding, answers, pictures=(("b1-before.png", PNG), ("b1-bug.png", PNG))):
        calls = []

        def send(method, url, headers, body, timeout):
            calls.append((url, headers.get("Content-Type", ""), body))
            return answers(url)
        with agent_folder():
            for name, data in pictures:
                put_bytes(f"{FOLDER}/{name}", data)
            put(f"{FOLDER}/findings-1.json", {"findings": [finding]})
            status, out, _ = run_main(["findings", "12", f"--findings={FOLDER}/findings-1.json"], send=send)
        return status, out.splitlines(), calls

    def test_the_bug_is_sent_without_the_screenshots_field_and_each_picture_goes_to_the_bug_it_became(self):
        made = lambda url: (201, json.dumps({"id": 44, "sourceId": "$agent-12-1"} if url.endswith("/findings") else {"id": 1}).encode())
        status, lines, calls = self.run_with(self.BUG, made)
        self.assertEqual(status, 0, lines)
        self.assertNotIn(b"screenshots", calls[0][2], "the field is the helper's own")
        self.assertEqual([c[0].split("/requests/")[1] for c in calls], ["12/findings", "12/bugs/44/screenshots", "12/bugs/44/screenshots"])
        self.assertTrue(calls[1][1].startswith("multipart/form-data; boundary="))
        self.assertIn(b'name="label"\r\n\r\nbefore', calls[1][2])
        self.assertIn(PNG, calls[1][2])
        self.assertEqual(json.loads(lines[0])["screenshots"], {"before": "added", "bug": "added"})

    def test_a_bug_seen_again_gets_no_picture(self):
        seen = lambda url: (201, json.dumps({"id": 9, "seenAgain": True}).encode())
        status, lines, calls = self.run_with(self.BUG, seen)
        self.assertEqual(status, 0, lines)
        self.assertEqual(len(calls), 1)
        self.assertTrue(json.loads(lines[0])["screenshots"]["before"].startswith("not sent"))

    def test_a_refused_picture_leaves_the_bug_and_says_so(self):
        def answers(url):
            if url.endswith("/findings"):
                return 201, json.dumps({"id": 44}).encode()
            return 400, json.dumps({"error": "The screenshot must be a png"}).encode()
        status, lines, _ = self.run_with(self.BUG, answers)
        self.assertEqual(status, 0, lines)
        self.assertTrue(json.loads(lines[0])["screenshots"]["bug"].startswith("not added (HTTP 400"))

    def test_a_wrong_picture_stops_the_call_before_anything_is_sent(self):
        never = lambda url: self.fail("nothing may be sent")
        for name, case in (("a real picture outside the folder of the request", dict(self.BUG, screenshots={"before": "audits/elsewhere.png"})),
                           ("not a picture", None),
                           ("a label that is not before or bug", dict(self.BUG, screenshots={"after": f"{FOLDER}/b1-before.png"})),
                           ("on an observation", {"kind": "observation", "title": "x", "severity": "info", "screenshots": {"before": f"{FOLDER}/b1-before.png"}})):
            with self.subTest(case=name):
                pictures = (("b1-before.png", b"<html>"), ("b1-bug.png", PNG)) if case is None else (("b1-before.png", PNG), ("b1-bug.png", PNG), ("../../elsewhere.png", PNG))
                status, lines, calls = self.run_with(case or self.BUG, never, pictures)
                self.assertNotEqual(status, 0)
                self.assertEqual(calls, [])



READ_ROWS = rows(
    "## /contact.html",
    "Name | empty | tried | values 2 | no message",
    "Name | wrong-kind/too-long/boundary/format | tried | values 2 | accepted everything",
    "Name | emoji | issue | values 2 | emoji accepted in a name",
    "Phone | empty | issue | values 1 | lock 2: the field sent data on its first value",
    "Phone | wrong-kind/too-long/boundary/format/emoji | not tried | lock 2: the field sent data",
    "## /login.html",
    "Upload | all | not tried | a file field",
)


class PrecheckOfTheReadOnlyDiscover(unittest.TestCase):
    """Körning 5: `--read` checks the rows of the read-only discover: its own six classes (emoji, no Enter), "values N" as the proof, and every class for every field."""

    def check(self, coverage, values="2"):
        with agent_folder():
            put(COVERAGE, coverage)
            status, out, err = run_main(["precheck", "12", f"--coverage={COVERAGE}", "--read", f"--values={values}"])
        return status, out.splitlines()

    def test_every_class_for_every_field_with_enough_values_is_ok_and_a_field_never_typed_in_is_left_with_its_reason(self):
        status, lines = self.check(READ_ROWS)
        self.assertEqual(status, 0, lines)
        self.assertFalse([l for l in lines if l.startswith("GAP")], lines)
        self.assertEqual(sorted(l.split(" | ")[1] for l in lines if l.startswith("LEFT")), ["Phone", "Upload"])
        self.assertTrue(lines[-1].endswith("before you hand in the findings."), lines[-1])

    def test_a_field_without_a_class_is_a_gap_that_names_the_field_and_the_class(self):
        status, lines = self.check(READ_ROWS + rows("## /register.html", "Email | empty | tried | values 2 | nothing"))
        self.assertEqual(status, 1)
        self.assertIn("GAP /register.html | Email: no row for: wrong-kind, too-long, boundary, format, emoji", lines)
        self.assertTrue(lines[-1].endswith("and only then hand in the findings."), lines[-1])

    def test_fewer_values_than_the_depth_asks_is_a_gap_and_a_row_without_values_counts_as_not_tried(self):
        status, lines = self.check(READ_ROWS.replace(f"emoji {DOT} issue {DOT} values 2", f"emoji {DOT} issue {DOT} values 1"))
        self.assertEqual(status, 1)
        self.assertTrue(any("emoji: 1 value(s), and this depth asks for 2" in l for l in lines), lines)
        status, lines = self.check(READ_ROWS.replace(f"emoji {DOT} issue {DOT} values 2 {DOT}", f"emoji {DOT} issue {DOT} looked {DOT}"))
        self.assertTrue(any("but not how many values were tried" in l for l in lines), lines)

    def test_enter_is_not_a_class_of_the_read_only_discover_and_a_soft_reason_is_a_gap(self):
        status, lines = self.check(READ_ROWS)
        self.assertFalse(any("enter" in l for l in lines if l.startswith("GAP")))
        status, lines = self.check(READ_ROWS + rows("## /index.html", "Search | all | not tried | no time"))
        self.assertEqual(status, 1)
        self.assertTrue(any(l.startswith("GAP /index.html | Search") and "is not a hard reason" in l for l in lines), lines)

    def test_values_must_be_a_small_number(self):
        status, lines = self.check(READ_ROWS, values="x")
        self.assertNotEqual(status, 0)


    def test_wrong_kind_and_too_long_may_be_written_with_a_space(self):
        # körning 6: the agent wrote "wrong kind" and "too long" and had to rename 14 rows to get past precheck
        status, lines = self.check(READ_ROWS.replace("wrong-kind/too-long", "wrong kind/too long"))
        self.assertEqual(status, 0, lines)

    def test_a_class_with_one_value_is_a_gap_unless_lock_2_stopped_the_field(self):
        status, lines = self.check(READ_ROWS.replace(f"values 1 {DOT} lock 2: the field sent data on its first value", f"values 1 {DOT} it showed no message"))
        self.assertEqual(status, 1)
        self.assertTrue(any("Phone | empty: 1 value(s), and this depth asks for 2" in l for l in lines), lines)
