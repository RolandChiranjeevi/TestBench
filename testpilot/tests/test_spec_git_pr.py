"""Git mode `pr`: `spec_git.py push` pushes the ONE new branch that `write` made and opens ONE pull request, and nothing else.

Nothing here touches the network or a real repository: the remote is a bare repository in a temporary folder, the GitHub API is a recording fake, and the token is made up. What is held
to the tool is every lock of the design: it needs `pr` from the profile, the rules file AND the person's confirmation, a protection-confirmed date, a token of the person's own; it pushes
only a new branch of exactly one commit with new spec files, never an existing remote branch, never the base branch; the text of the pull request is the tool's own; the token is never
printed and never on a command line; and the only two hosts it can name are github.com and api.github.com.
Run: python3 -m unittest discover -s testpilot/tests
"""
import base64
import contextlib
import io
import os
import subprocess
import sys
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "tools"))
import spec_git  # noqa: E402
import test_spec_git as base  # noqa: E402

TOKEN = "ghp_" + "x" * 30
BRANCH = "testpilot/discover-7"


@contextlib.contextmanager
def chdir(path):
    old = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(old)


class FakeApi:
    """The GitHub API as the tool uses it: three calls, each recorded with the token it was given."""

    def __init__(self, ref_exists=False, full_name="acme/shop", pr_code=201, pr_url="https://github.com/acme/shop/pull/12"):
        self.calls, self.ref_exists, self.full_name, self.pr_code, self.pr_url = [], ref_exists, full_name, pr_code, pr_url

    def __call__(self, method, path, token, body=None):
        self.calls.append((method, path, body, token))
        if method == "GET" and path == "/repos/acme/shop":
            return 200, {"full_name": self.full_name}
        if method == "GET" and path.startswith("/repos/acme/shop/git/ref/heads/"):
            return (200, {"ref": "x"}) if self.ref_exists else (404, {"message": "Not Found"})
        if method == "POST" and path == "/repos/acme/shop/pulls":
            return self.pr_code, ({"html_url": self.pr_url} if self.pr_code == 201 else {"message": "Validation Failed"})
        raise AssertionError(f"the tool made a call it should not: {method} {path}")


class PrWorld(base.World):
    """A checkout with rules that allow pr, a bare repository standing in for GitHub, and a profile that names the token variable."""

    def __init__(self, test, protection="2026-11-25", token_var="TP_TOKEN", mode="pr", mode_max="pr", **kw):
        rules = base.RULES.replace("mode-max: local", f"mode-max: {mode_max}") + (f"protection-confirmed: {protection}\n" if protection else "")
        super().__init__(test, rules=rules, mode=mode, **kw)
        if token_var:
            self.set_profile(pushTokenEnvVar=token_var)
        self.bare = self.tmp / "remote.git"
        base.sh(self.tmp, "init", "-q", "--bare", "-b", "main", str(self.bare))
        base.sh(self.repo, "push", "-q", str(self.bare), "main:main")

    def wrote(self, items=None):
        p = self.write(items or [base.S()], confirmed="pr")
        assert p.returncode == 0, p.out
        return base.sh(self.repo, "rev-parse", BRANCH).stdout.strip()

    def remote_refs(self):
        return base.sh(self.bare, "for-each-ref", "--format=%(refname) %(objectname)").stdout

    def push(self, rid="7", confirmed="pr", token=TOKEN, api=None, spy=None):
        fake = api or FakeApi()
        out = io.StringIO()
        with chdir(self.agent), mock.patch.dict(os.environ, {"TP_TOKEN": token} if token else {}), mock.patch.object(spec_git, "api", fake), \
                mock.patch.object(spec_git, "remote_url", lambda repo: self.bare.as_uri()), contextlib.redirect_stdout(out):
            if token is None:
                os.environ.pop("TP_TOKEN", None)
            if spy is not None:
                real = subprocess.run
                with mock.patch.object(spec_git.subprocess, "run", side_effect=lambda *a, **k: (spy.append((a, k)), real(*a, **k))[1]):
                    code = self.run_push(rid, confirmed, out)
            else:
                code = self.run_push(rid, confirmed, out)
        return code, out.getvalue(), fake

    @staticmethod
    def run_push(rid, confirmed, out):
        try:
            spec_git.push(rid, confirmed)
            return 0
        except spec_git.Stop as s:
            out.write(s.reason)
            return 1


class CheckSaysWhetherPrIsPossible(unittest.TestCase):
    def test_pr_yes_needs_the_profile_the_rules_a_protection_date_and_a_token_variable(self):
        out = PrWorld(self).run("check").out
        self.assertIn("pr: yes (the profile and TESTPILOT.md allow pr, protection confirmed 2026-11-25, token from the environment variable TP_TOKEN)", out)
        self.assertIn("ceiling: local (the pr line says whether the branch may also be pushed)", out)
        for kw, why in (({"protection": ""}, "has no protection-confirmed date"), ({"token_var": ""}, "the profile has no pushTokenEnvVar"), ({"mode": "local"}, "is below pr"), ({"mode_max": "local"}, "is below pr")):
            with self.subTest(why=why):
                out = PrWorld(self, **kw).run("check").out
                self.assertIn("pr: no (", out)
                self.assertIn(why, out)

    def test_a_protection_date_that_is_not_a_date_is_an_error_and_never_a_silent_yes(self):
        for bad in ("yes", "true", "2026-13-01", "26-11-25", "2026-11-25 maybe"):
            with self.subTest(bad=bad):
                out = PrWorld(self, protection=bad).run("check").out
                self.assertIn("mode: off", out)
                self.assertIn("protection-confirmed must be a date", out)

    def test_a_bad_token_variable_name_is_refused_and_a_token_value_is_never_shown(self):
        out = PrWorld(self, token_var="not a name").run("check").out
        self.assertIn("pushTokenEnvVar in the project profile must be the NAME of an environment variable", out)
        self.assertNotIn(TOKEN, PrWorld(self).run("check", env={"TP_TOKEN": TOKEN}).out)


class PushDoesExactlyOneThing(unittest.TestCase):
    def test_it_pushes_the_new_branch_and_opens_one_pull_request_with_text_of_its_own(self):
        w = PrWorld(self)
        before = w.remote_refs()
        sha = w.wrote()
        spy = []
        code, out, api = w.push(spy=spy)
        self.assertEqual(code, 0, out)
        self.assertIn(f"pushed: {BRANCH} to acme/shop, as a new branch; nothing else was pushed", out)
        self.assertIn("pull request: https://github.com/acme/shop/pull/12", out)
        self.assertEqual(sorted(w.remote_refs().splitlines()), sorted(before.splitlines() + [f"refs/heads/{BRANCH} {sha}"]), "only the new branch was added: main and everything else are as they were")
        post = [c for c in api.calls if c[0] == "POST"]
        self.assertEqual(len(post), 1)
        body = post[0][2]
        self.assertEqual((body["head"], body["base"]), (BRANCH, "main"))
        self.assertNotIn("draft", body)
        self.assertIn("1 new spec file under e2e/tests", body["body"])
        self.assertIn("the agent never merges", body["body"])
        self.assertIn("- e2e/tests/shop/cart.spec.ts", body["body"])
        self.assertEqual({c[1] for c in api.calls}, {"/repos/acme/shop", f"/repos/acme/shop/git/ref/heads/{BRANCH}", "/repos/acme/shop/pulls"}, "only these three calls, all of this one repository")
        self.assertNotIn(TOKEN, out)
        argv = " ".join(" ".join(a[0][0]) for a in spy)
        self.assertNotIn(TOKEN, argv, "the token is never on a command line")
        self.assertNotIn(base64.b64encode(f"x-access-token:{TOKEN}".encode()).decode(), argv)

    def test_the_push_is_one_refspec_without_force_or_tags(self):
        w = PrWorld(self)
        w.wrote()
        spy = []
        w.push(spy=spy)
        pushes = [list(a[0]) for a, k in spy if "push" in a[0]]
        self.assertEqual(len(pushes), 1)
        rest = pushes[0][pushes[0].index("push") + 1:]
        self.assertEqual(rest, ["--no-verify", w.bare.as_uri(), f"refs/heads/{BRANCH}:refs/heads/{BRANCH}"])
        for banned in ("--force", "-f", "--tags", "--mirror", "--delete", "--all", "+"):
            self.assertFalse(any(banned in x for x in rest), banned)

    def test_the_real_remote_is_github_com_for_the_repository_named_and_the_api_host_and_paths_are_fixed(self):
        self.assertEqual(spec_git.remote_url("acme/shop"), "https://github.com/acme/shop.git")
        self.assertEqual(spec_git.GITHUB_API, "https://api.github.com")
        seen = []

        class Resp:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self, n=-1):
                return b"{}"
        with mock.patch.object(urllib.request, "urlopen", side_effect=lambda req, timeout=None: (seen.append(req), Resp())[1]):
            spec_git.api("GET", "/repos/acme/shop", TOKEN)
        self.assertEqual(seen[0].full_url, "https://api.github.com/repos/acme/shop")
        self.assertEqual(seen[0].get_header("Authorization"), "Bearer " + TOKEN)
        for bad in ("/user", "/repos/acme", "/repos/acme/shop/../../../user", "/orgs/acme/repos", "//evil.example.com/repos/a/b", "https://evil.example.com/repos/a/b", "/repos/a/b?x=1"):
            with self.subTest(bad=bad), mock.patch.object(urllib.request, "urlopen", side_effect=AssertionError("must not be called")), self.assertRaises(spec_git.Stop):
                spec_git.api("GET", bad, TOKEN)


class PushRefusesEverythingElse(unittest.TestCase):
    def refused(self, w, want, **kw):
        before = w.remote_refs()
        code, out, api = w.push(**kw)
        self.assertEqual(code, 1, out)
        self.assertIn(want, out)
        self.assertEqual(w.remote_refs(), before, "a refusal pushes nothing")
        self.assertEqual([c for c in api.calls if c[0] == "POST"], [], "and opens nothing")
        self.assertNotIn(TOKEN, out)
        return out, api

    def test_it_needs_the_persons_own_confirmation_of_pr(self):
        for confirmed in ("local", "off", ""):
            with self.subTest(confirmed=confirmed):
                w = PrWorld(self)
                w.wrote()
                self.refused(w, "push needs --confirmed pr", confirmed=confirmed)

    def test_it_needs_pr_in_the_profile_and_the_rules_a_protection_date_and_a_token_variable(self):
        for kw in ({"protection": ""}, {"token_var": ""}, {"mode": "local"}, {"mode_max": "local"}):
            with self.subTest(kw=kw):
                w = PrWorld(self, **kw)
                w.wrote()
                self.refused(w, "git mode pr is not allowed here")

    def test_it_needs_a_token_that_looks_like_one_in_the_variable_the_profile_names(self):
        for token in (None, "short", "has a space in it which is no token at all"):
            with self.subTest(token=token):
                w = PrWorld(self)
                w.wrote()
                self.refused(w, "does not hold a GitHub token", token=token)

    def test_it_needs_the_local_branch_that_write_made(self):
        self.refused(PrWorld(self), f"there is no local branch {BRANCH}")

    def test_the_branch_must_be_one_commit_on_top_of_the_base_branch(self):
        w = PrWorld(self)
        w.wrote()
        wt = w.tmp / "wt"
        base.sh(w.repo, "worktree", "add", "-q", str(wt), BRANCH)
        (wt / "e2e/tests/shop/extra.spec.ts").write_text('test("x @CASE-9", async () => {});\n')
        base.sh(wt, "add", "-A")
        base.sh(wt, "commit", "-qm", "extra", "--no-verify")
        base.sh(w.repo, "worktree", "remove", "--force", str(wt))
        self.refused(w, "must be exactly one commit on top of origin/main")

    def test_a_branch_that_changes_an_existing_file_or_adds_something_that_is_not_a_spec_is_refused(self):
        def readme(wt):
            (wt / "README.md").write_text("changed\n")

        def notes(wt):
            (wt / "e2e/tests/shop").mkdir(parents=True, exist_ok=True)
            (wt / "e2e/tests/shop/notes.md").write_text("n\n")

        def outside(wt):
            (wt / "e2e/support").mkdir(parents=True, exist_ok=True)
            (wt / "e2e/support/x.spec.ts").write_text("x\n")
        for make in (readme, notes, outside):
            with self.subTest(make=make.__name__):
                w = PrWorld(self)
                wt = w.tmp / "wt"
                base.sh(w.repo, "worktree", "add", "-q", "-b", BRANCH, str(wt), "origin/main")
                make(wt)
                base.sh(wt, "add", "-A")
                base.sh(wt, "commit", "-qm", "hand made", "--no-verify")
                base.sh(w.repo, "worktree", "remove", "--force", str(wt))
                self.refused(w, "is not a new spec file in the places the rules allow")

    def test_a_branch_that_changes_a_spec_that_already_exists_is_refused_because_only_new_files_are_pushed(self):
        def setup(repo):
            (repo / "e2e/tests/shop").mkdir(parents=True)
            (repo / "e2e/tests/shop/old.spec.ts").write_text('test("old @SHOP-1", async () => {});\n')
        w = PrWorld(self, setup=setup)
        wt = w.tmp / "wt"
        base.sh(w.repo, "worktree", "add", "-q", "-b", BRANCH, str(wt), "origin/main")
        (wt / "e2e/tests/shop/old.spec.ts").write_text('test("old @SHOP-1 changed", async () => {});\n')
        base.sh(wt, "add", "-A")
        base.sh(wt, "commit", "-qm", "changed an existing spec", "--no-verify")
        base.sh(w.repo, "worktree", "remove", "--force", str(wt))
        self.refused(w, "is not a new spec file in the places the rules allow")

    def test_a_branch_that_is_already_on_github_is_never_pushed_to(self):
        w = PrWorld(self)
        w.wrote()
        self.refused(w, f"{BRANCH} is already on GitHub", api=FakeApi(ref_exists=True))

    def test_github_must_confirm_the_repository_the_profile_names(self):
        w = PrWorld(self)
        w.wrote()
        self.refused(w, "GitHub did not confirm the repository acme/shop", api=FakeApi(full_name="someone/else"))

    def test_when_the_pull_request_fails_it_says_that_the_branch_was_pushed_and_what_to_do(self):
        w = PrWorld(self)
        sha = w.wrote()
        code, out, _ = w.push(api=FakeApi(pr_code=422))
        self.assertEqual(code, 1)
        self.assertIn(f"the branch {BRANCH} was pushed, but GitHub did not open the pull request (HTTP 422) Validation Failed: open it yourself on GitHub", out)
        self.assertIn(f"refs/heads/{BRANCH} {sha}", w.remote_refs())

    def test_a_pull_request_address_that_is_not_this_repository_is_not_believed(self):
        w = PrWorld(self)
        w.wrote()
        code, out, _ = w.push(api=FakeApi(pr_url="https://evil.example.com/acme/shop/pull/1"))
        self.assertEqual(code, 1)
        self.assertIn("did not open the pull request", out)
        self.assertNotIn("pull request: https://evil.example.com", out)


class PushIsAnActionOfTheCommandLine(unittest.TestCase):
    def test_push_needs_a_request_number_and_a_confirmation(self):
        w = PrWorld(self)
        for args in (("push",), ("push", "x", "--confirmed", "pr"), ("push", "7")):
            with self.subTest(args=args):
                self.assertEqual(w.run(*args).returncode, 1, args)

    def test_the_git_calls_it_adds_are_exactly_these_three(self):
        before = {("rev-parse",), ("show",), ("ls-tree",), ("remote", "get-url"), ("worktree", "add"), ("worktree", "remove"), ("worktree", "prune"), ("add",), ("commit",), ("update-ref",)}
        self.assertEqual(spec_git.GIT_OK - before, {("rev-list",), ("diff",), ("push",)})


if __name__ == "__main__":
    unittest.main()
