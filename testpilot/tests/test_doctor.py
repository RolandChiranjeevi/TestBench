"""testpilot/tools/doctor.py: it reads an agent folder and says what is wrong, it never prints a token, and it never writes or fetches.

Every check is tried with a folder made for the test (a profile, a token, the docs of this repository, a permission list built from those docs, a real git checkout with a real origin). The one network call
goes to a small local server that answers 200, 401 or 404 and keeps what it was sent, so the test can see that the token was sent and never shown.
Run: python3 -m unittest discover -s testpilot/tests
"""
import contextlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "testpilot" / "tools"))
import doctor  # noqa: E402

TOKEN = "tbrq_" + "Abc123_-" * 6
DOCS = (ROOT / "docs" / "agent-requests.md").read_text()


def blocks():
    out = []
    for m in re.finditer(r"```json\n(.*?)\n```", DOCS, re.S):
        try:
            perms = json.loads(m.group(1)).get("permissions")
        except (ValueError, AttributeError):
            continue
        if isinstance(perms, dict) and "allow" in perms and "deny" in perms:
            out.append(perms)
    return out


class Folder(unittest.TestCase):
    """A folder that holds `.testpilot/`, the way an agent folder does, with everything in order."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        old = os.getcwd()
        os.chdir(self.dir)
        self.addCleanup(os.chdir, old)
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("TB_TOKEN", None)
        self.profile = {"projectId": 1, "projectKey": "SD", "permissionMode": "full", "requestTokenEnvVar": "TB_TOKEN", "gitMode": "off"}
        self.base = "http://127.0.0.1:1"
        self.write_config()
        (self.dir / ".env").write_text(f"TB_TOKEN={TOKEN}\n")
        (self.dir / "docs").mkdir()
        (self.dir / "docs" / "agent-requests.md").write_text(DOCS)
        deny = set.intersection(*[set(b["deny"]) for b in blocks()])
        allow = {r for b in blocks() for r in b["allow"]}
        self.settings = {"permissions": {"allow": sorted(allow), "deny": sorted(deny)}}
        self.write_settings()

    def write_config(self):
        (self.dir / ".testpilot" / "projects").mkdir(parents=True, exist_ok=True)
        (self.dir / ".testpilot" / "testbench.json").write_text(json.dumps({"baseUrl": self.base, "activeProject": "p"}))
        (self.dir / ".testpilot" / "projects" / "p.json").write_text(json.dumps(self.profile))

    def write_settings(self):
        (self.dir / ".claude").mkdir(exist_ok=True)
        (self.dir / ".claude" / "settings.local.json").write_text(json.dumps(self.settings))

    def status(self, name, offline=True):
        got = [(s, t) for s, t in doctor.run(offline=offline) if t.split(":")[0].split()[-1] == name]
        self.assertEqual(len(got), 1, got)
        return got[0]


class ConfigAndToken(Folder):
    def test_a_folder_in_order_says_ok_for_the_config_the_token_and_the_permissions(self):
        for name in ("config", "token", "permissions", "git"):
            with self.subTest(name=name):
                self.assertEqual(self.status(name)[0], "ok", self.status(name))

    def test_a_profile_that_cannot_be_read_is_a_fail_with_the_kind_of_error_only(self):
        (self.dir / ".testpilot" / "projects" / "p.json").unlink()
        status, text = self.status("config")
        self.assertEqual(status, "fail")
        self.assertIn("FileNotFoundError", text)

    def test_a_profile_with_a_bad_project_id_or_variable_or_mode_is_a_fail_naming_each_problem(self):
        self.profile.update({"projectId": "x", "requestTokenEnvVar": "bad name", "permissionMode": "everything"})
        self.write_config()
        status, text = self.status("config")
        self.assertEqual(status, "fail")
        for part in ("projectId must be a number", "requestTokenEnvVar must name an environment variable", "permissionMode must be observe_only or full"):
            self.assertIn(part, text)

    def test_plain_http_to_another_host_is_refused_as_the_helper_refuses_it(self):
        self.base = "http://example.com"
        self.write_config()
        self.assertIn("plain http to a non-local host", self.status("config")[1])

    def test_a_missing_token_and_a_token_of_the_wrong_kind_are_fails(self):
        (self.dir / ".env").write_text("")
        self.assertEqual(self.status("token")[0], "fail")
        (self.dir / ".env").write_text("TB_TOKEN=not-a-token\n")
        status, text = self.status("token")
        self.assertEqual(status, "fail")
        self.assertIn("not a request token", text)
        self.assertNotIn("not-a-token", text)

    def test_the_token_value_is_never_in_the_output_whether_it_is_in_the_environment_or_in_env(self):
        for where in ("env", "environment"):
            with self.subTest(where=where):
                if where == "environment":
                    (self.dir / ".env").write_text("")
                    os.environ["TB_TOKEN"] = TOKEN
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    doctor.main(["--offline"])
                self.assertNotIn(TOKEN, out.getvalue())
                self.assertNotIn(TOKEN[5:20], out.getvalue())
                self.assertIn("looks like a request token", out.getvalue())

    def test_a_token_that_is_inside_some_other_text_is_redacted_on_the_way_out(self):
        self.settings["permissions"]["allow"].append(f"Bash(curl -H {TOKEN})")
        self.write_settings()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            doctor.main(["--offline"])
        self.assertIn("tbrq_[redacted]", out.getvalue())
        self.assertNotIn(TOKEN, out.getvalue())


class Permissions(Folder):
    def test_a_deny_rule_that_every_list_of_the_docs_has_but_this_file_lacks_is_a_fail(self):
        self.settings["permissions"]["deny"].remove("Bash(git:*)")
        self.write_settings()
        status, text = self.status("permissions")
        self.assertEqual(status, "fail")
        self.assertIn("Bash(git:*)", text)

    def test_the_four_readers_and_the_two_listers_are_among_the_rules_it_demands(self):
        for rule in ("Bash(cat:*)", "Bash(grep:*)", "Bash(head:*)", "Bash(sed:*)", "Bash(find:*)", "Bash(ls:*)", "Read(./.env)", "Read(./.mcp.json)", "Bash(gh:*)"):
            with self.subTest(rule=rule):
                full = list(self.settings["permissions"]["deny"])
                self.settings["permissions"]["deny"] = [r for r in full if r != rule]
                self.write_settings()
                self.assertIn(rule, self.status("permissions")[1])
                self.settings["permissions"]["deny"] = full

    def test_an_allow_rule_that_no_list_has_is_a_warn_and_a_full_blanket_is_named(self):
        self.settings["permissions"]["allow"].append("Bash(*)")
        self.write_settings()
        status, text = self.status("permissions")
        self.assertEqual(status, "warn")
        self.assertIn("Bash(*)", text)

    def test_the_absolute_write_path_of_the_folder_is_the_persons_own_and_is_not_a_difference(self):
        self.settings["permissions"]["allow"] = [r for r in self.settings["permissions"]["allow"] if not r.startswith("Write(//")] + ["Write(//Users/someone/else/audits/**)"]
        self.write_settings()
        self.assertEqual(self.status("permissions")[0], "ok", self.status("permissions"))

    def test_no_settings_file_is_a_warn_and_a_broken_one_is_a_fail_and_missing_docs_is_a_warn(self):
        (self.dir / ".claude" / "settings.local.json").write_text("{not json")
        self.assertEqual(self.status("permissions")[0], "fail")
        (self.dir / ".claude" / "settings.local.json").unlink()
        self.assertEqual(self.status("permissions")[0], "warn")
        (self.dir / "docs" / "agent-requests.md").unlink()
        self.assertIn("was not found here", self.status("permissions")[1])


class Server(Folder):
    def serve(self, code):
        seen = []

        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append((self.path, self.headers.get("Authorization")))
                self.send_response(code)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"[]")

            def log_message(self, *a):
                pass

        srv = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        self.addCleanup(srv.server_close)
        self.base = f"http://127.0.0.1:{srv.server_address[1]}"
        self.write_config()
        return seen

    def test_the_server_answers_and_takes_the_token_for_the_project(self):
        seen = self.serve(200)
        status, text = self.status("server", offline=False)
        self.assertEqual(status, "ok")
        self.assertEqual(seen, [("/api/agent/projects/1/requests", "Bearer " + TOKEN)])
        self.assertNotIn(TOKEN, text)

    def test_a_refused_token_a_missing_project_and_an_unreachable_address_are_fails(self):
        self.serve(401)
        self.assertIn("the token is refused", self.status("server", offline=False)[1])
        self.serve(404)
        self.assertIn("project 1 was not found", self.status("server", offline=False)[1])
        self.base = "http://127.0.0.1:1"
        self.write_config()
        status, text = self.status("server", offline=False)
        self.assertEqual(status, "fail")
        self.assertIn("could not be reached", text)

    def test_offline_makes_no_call_at_all(self):
        seen = self.serve(200)
        self.assertEqual([s for s, t in doctor.run(offline=True) if t.split(":")[0].endswith("server")], [])
        self.assertEqual(seen, [])


class Skills(Folder):
    def sh(self, cwd, *args):
        return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-C", str(cwd), *args], capture_output=True, text=True, check=True)

    def make_checkout(self):
        """A checkout whose origin is a real bare repository, with a watched file on main."""
        origin = self.dir / "origin.git"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
        seed = self.dir / "seed"
        seed.mkdir()
        self.sh(seed, "init", "-q", "-b", "main")
        (seed / ".claude" / "skills").mkdir(parents=True)
        (seed / ".claude" / "skills" / "a.md").write_text("one\n")
        self.sh(seed, "add", ".")
        self.sh(seed, "commit", "-q", "-m", "one")
        self.sh(seed, "remote", "add", "origin", str(origin))
        self.sh(seed, "push", "-q", "origin", "main")
        work = self.dir / "work"
        subprocess.run(["git", "clone", "-q", str(origin), str(work)], check=True)
        return seed, work

    def test_a_folder_that_is_not_a_git_checkout_is_a_warn(self):
        self.assertEqual(self.status("skills")[0], "warn")
        self.assertIn("not a git checkout", self.status("skills")[1])

    def test_a_checkout_that_matches_origin_is_ok_and_one_that_is_behind_is_stale_and_one_changed_here_is_modified(self):
        seed, work = self.make_checkout()
        os.chdir(work)
        self.assertEqual(self.status("skills")[0], "ok", self.status("skills"))
        (seed / ".claude" / "skills" / "a.md").write_text("two\n")
        self.sh(seed, "commit", "-q", "-am", "two")
        self.sh(seed, "push", "-q", "origin", "main")
        self.sh(work, "fetch", "-q")
        status, text = self.status("skills")
        self.assertEqual((status, "stale" in text), ("warn", True), text)
        self.sh(work, "merge", "-q", "--ff-only", "origin/main")
        self.assertEqual(self.status("skills")[0], "ok")
        (work / ".claude" / "skills" / "a.md").write_text("mine\n")
        status, text = self.status("skills")
        self.assertEqual((status, "modified here" in text, ".claude/skills/a.md" in text), ("warn", True, True), text)

    def test_a_change_outside_the_watched_folders_is_not_reported_and_nothing_is_fetched(self):
        seed, work = self.make_checkout()
        os.chdir(work)
        (work / "notes.txt").write_text("not watched\n")
        self.assertEqual(self.status("skills")[0], "ok")
        (seed / ".claude" / "skills" / "a.md").write_text("three\n")
        self.sh(seed, "commit", "-q", "-am", "three")
        self.sh(seed, "push", "-q", "origin", "main")
        before = self.sh(work, "rev-parse", "refs/remotes/origin/main").stdout
        self.assertEqual(self.status("skills")[0], "ok")  # not fetched, so it cannot know
        self.assertEqual(self.sh(work, "rev-parse", "refs/remotes/origin/main").stdout, before)


class Exit(Folder):
    def run_main(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = doctor.main(list(args))
        return code, out.getvalue()

    def test_the_exit_code_is_1_only_when_something_failed_and_the_last_line_counts(self):
        code, out = self.run_main("--offline")
        self.assertEqual(code, 0)
        self.assertRegex(out.strip().splitlines()[-1], r"^doctor: \d+ ok, \d+ warn, 0 fail$")
        (self.dir / ".env").write_text("")
        code, out = self.run_main("--offline")
        self.assertEqual(code, 1)
        self.assertRegex(out.strip().splitlines()[-1], r"fail$")

    def test_an_argument_that_is_not_offline_is_refused_with_the_usage(self):
        code, out = self.run_main("--fetch")
        self.assertEqual(code, 1)
        self.assertIn("Usage: doctor.py [--offline]", out)

    def test_it_writes_nothing_in_the_folder(self):
        def snapshot():
            return {str(p.relative_to(self.dir)): p.read_bytes() for p in self.dir.rglob("*") if p.is_file() and ".git/" not in str(p)}
        before = snapshot()
        self.run_main("--offline")
        self.assertEqual(snapshot(), before)


class Documented(unittest.TestCase):
    def test_the_docs_and_the_readme_describe_it_and_it_is_not_in_the_lists_the_agent_runs_from(self):
        self.assertIn("## Checking the set-up: `doctor`", DOCS)
        self.assertIn("**never prints a token**", DOCS)
        self.assertIn("python3 -I testpilot/tools/doctor.py", " ".join((ROOT / "testpilot" / "README.md").read_text().split()))
        for b in blocks():
            self.assertFalse([r for r in b["allow"] if "doctor" in r], "the agent does not run doctor: the person does")


if __name__ == "__main__":
    unittest.main()
