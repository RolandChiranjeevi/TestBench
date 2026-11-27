"""Tests for testpilot/tools/spec_git.py: the guard that puts specs on a LOCAL branch of the person's checkout and nowhere else.

Every test builds real temporary git repositories (no network, no mock of git), runs the tool as its own process the way a skill will, and looks at what the repository holds afterwards.
A refusal must leave nothing behind: same refs, same worktrees, no temporary folder, same working tree.
Run: python3 -m unittest discover -s testpilot/tests
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent / "tools"
CONFIG = Path(__file__).resolve().parent.parent / "config"
TOOL = TOOLS / "spec_git.py"
sys.path.insert(0, str(TOOLS))
import spec_git  # noqa: E402

ORIGIN = "https://shop.example.com"
URL = "https://github.com/acme/shop.git"
RULES = """repo: acme/shop
base: main
mode-max: local
branch-prefix: testpilot/
tests-dir: e2e/tests
allowed-new-paths: [e2e/]
never-touch: [e2e/tests/private/]
max-files: 3
max-lines: 60
"""


def spec(body, head=""):
    return f'import {{ test, expect }} from "@playwright/test";\n{head}\ntest("cart @CASE-1", async ({{ page }}) => {{\n  {body}\n}});\n'


GOOD = spec('await page.goto("https://shop.example.com/cart");')


def S(path="e2e/tests/shop/cart.spec.ts", content=GOOD):
    return {"path": path, "content": content}


def sh(cwd, *args, check=True):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=check)


class World:
    """A person's checkout (with origin/main and a rules file on it), and the folder the agent works from, with a profile that points at the checkout."""

    def __init__(self, test, rules=RULES, mode="local", url=URL, setup=None):
        self.tmp = Path(tempfile.mkdtemp())
        test.addCleanup(shutil.rmtree, self.tmp, True)
        self.repo, self.agent, self.tmpdir = (self.tmp / n for n in ("repo", "agent", "tmpdir"))
        for d in (self.repo, self.tmpdir, self.agent / ".testpilot" / "projects", self.agent / "audits" / "request-7"):
            d.mkdir(parents=True)
        sh(self.repo, "init", "-q", "-b", "main")
        for k, v in (("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false")):
            sh(self.repo, "config", k, v)
        (self.repo / "README.md").write_text("hello\n")
        if rules is not None:
            (self.repo / "TESTPILOT.md").write_text(rules)
        if setup:
            setup(self.repo)
        sh(self.repo, "add", "-A")
        sh(self.repo, "commit", "-qm", "base")
        sh(self.repo, "remote", "add", "origin", url)
        sh(self.repo, "update-ref", "refs/remotes/origin/main", "HEAD")
        (self.agent / ".testpilot" / "testbench.json").write_text(json.dumps({"activeProject": "shop", "baseUrl": "http://localhost:4100"}))
        (self.agent / ".testpilot" / "projects" / "shop.json").write_text(json.dumps({"projectId": "1", "gitMode": mode, "repo": "acme/shop", "repoPath": str(self.repo)}))

    def set_profile(self, **kw):
        f = self.agent / ".testpilot" / "projects" / "shop.json"
        p = json.loads(f.read_text())
        p.update(kw)
        f.write_text(json.dumps({k: v for k, v in p.items() if v is not None}))

    def run(self, *args, env=None):
        p = subprocess.run([sys.executable, "-I", str(TOOL), *args], cwd=self.agent, capture_output=True, text=True, env={**os.environ, "TMPDIR": str(self.tmpdir), "HOME": str(self.tmpdir / "_home"), **(env or {})})  # never the developer's own ~/.testpilot/
        p.out = p.stdout + p.stderr
        return p

    def specs(self, items, name="specs.json"):
        rel = f"audits/request-7/{name}"
        (self.agent / rel).write_text(json.dumps({"specs": items}))
        return rel

    def write(self, items=None, *, rel=None, confirmed="local", origin=ORIGIN, env=None):
        return self.run("write", "7", "--confirmed", confirmed, "--origin", origin, "--specs", rel or self.specs(items), env=env)

    def state(self):
        return (sh(self.repo, "for-each-ref", "--format=%(refname) %(objectname)").stdout, sh(self.repo, "worktree", "list", "--porcelain").stdout, sorted(os.listdir(self.tmpdir)), sh(self.repo, "status", "--porcelain").stdout)


class CheckTests(unittest.TestCase):
    def test_everything_in_order(self):
        w = World(self)
        p = w.run("check")
        self.assertEqual(p.returncode, 0, p.out)
        for line in ("repo: acme/shop", "ceiling: local", f"checkout: {os.path.realpath(w.repo)}", "tests-dir: e2e/tests", "branch: testpilot/discover-<request number>", "limits: 3 files, 60 lines", "logged-in: no"):
            self.assertIn(line, p.out)

    def test_logged_in_is_read_from_the_rules_and_only_yes_or_no(self):
        self.assertIn("logged-in: yes", World(self, rules=RULES + "logged-in: yes\n").run("check").out)
        self.assertIn("logged-in: no", World(self, rules=RULES + "logged-in: no\n").run("check").out)
        p = World(self, rules=RULES + "logged-in: maybe\n").run("check")
        self.assertIn("logged-in must be yes or no", p.out)
        self.assertIn("mode: off", p.out)

    def test_the_ceiling_is_the_lowest_of_the_profile_and_the_rules(self):
        for profile, rules, want in (("local", "local", "ceiling: local"), ("pr", "local", "ceiling: local"), ("local", "pr", "ceiling: local"), ("pr", "pr", "ceiling: local (the pr line says whether the branch may also be pushed)"), ("off", "pr", "mode: off"), ("local", "off", "mode: off")):
            with self.subTest(profile=profile, rules=rules):
                p = World(self, rules=RULES.replace("mode-max: local", f"mode-max: {rules}"), mode=profile).run("check")
                self.assertEqual(p.returncode, 0, p.out)
                self.assertIn(want, p.out)

    def test_a_confirmation_can_only_lower_the_mode(self):
        w = World(self)
        for confirmed, want in (("off", "mode: off"), ("local", "mode: local"), ("pr", "mode: local")):
            with self.subTest(confirmed=confirmed):
                self.assertIn(want, w.run("check", "--confirmed", confirmed).out)
        self.assertEqual(w.run("check", "--confirmed", "everything").returncode, 1)

    def test_no_rules_file_on_origin_means_off(self):
        w = World(self, rules=None)
        (w.repo / "TESTPILOT.md").write_text(RULES)  # in the working folder only: it is not on origin/main, so it does not count
        p = w.run("check")
        self.assertIn("mode: off", p.out)
        self.assertIn("TESTPILOT.md was not found on origin/main", p.out)

    def test_the_rules_are_read_from_origin_and_not_from_the_working_folder_or_a_branch(self):
        w = World(self, rules=RULES.replace("mode-max: local", "mode-max: off"))
        (w.repo / "TESTPILOT.md").write_text(RULES.replace("mode-max: local", "mode-max: pr"))
        sh(w.repo, "switch", "-q", "-c", "agent")
        sh(w.repo, "commit", "-qam", "the agent's own copy")
        p = w.run("check")
        self.assertIn("mode: off", p.out)
        self.assertIn("git mode is off", p.out)

    def test_the_three_repository_names_must_agree(self):
        for label, kw, want in (("origin", dict(url="https://github.com/acme/other.git"), "must name the same repository"), ("rules", dict(rules=RULES.replace("repo: acme/shop", "repo: acme/other")), "must name the same repository"), ("base", dict(rules=RULES.replace("base: main", "base: dev")), "says base dev")):
            with self.subTest(label):
                p = World(self, **kw).run("check")
                self.assertIn("mode: off", p.out)
                self.assertIn(want, p.out)
        w = World(self)
        w.set_profile(repo="acme/other")
        self.assertIn("must name the same repository", w.run("check").out)

    def test_origin_forms_and_look_alikes(self):
        for url, ok in ((URL, True), ("https://github.com/acme/shop", True), ("git@github.com:acme/shop.git", True), ("ssh://git@github.com/acme/shop.git", True), ("https://user:pw@github.com/acme/shop.git", True), ("https://GitHub.com/Acme/Shop.git", True),
                        ("https://evil.example/x/github.com/acme/shop.git", False), ("https://github.com.evil.example/acme/shop.git", False), ("https://evil.example/github.com/acme/shop", False)):
            with self.subTest(url=url):
                p = World(self, url=url).run("check")
                self.assertIn("ceiling: local" if ok else "no GitHub origin", p.out)

    def test_a_token_in_the_origin_address_is_never_shown(self):
        w = World(self, url="https://user:s3cr3tvalue@github.com/acme/shop.git")
        for p in (w.run("check"), w.write([S()])):
            self.assertEqual(p.returncode, 0, p.out)
            self.assertNotIn("s3cr3tvalue", p.out)

    def test_a_bad_rules_file_means_off_and_says_why(self):
        for label, text, want in (
            ("typo", RULES.replace("never-touch", "never-tuch"), "not a rule this tool knows"),
            ("twice", RULES + "max-files: 5\n", "given twice"),
            ("missing", RULES.replace("tests-dir: e2e/tests\n", ""), "the rule tests-dir is missing"),
            ("whole repository", RULES.replace("[e2e/]", "[./]"), "not a plain relative path"),
            ("up", RULES.replace("[e2e/]", "[../x/]"), "not a plain relative path"),
            ("absolute", RULES.replace("[e2e/]", "[/etc/]"), "not a plain relative path"),
            ("glob", RULES.replace("[e2e/]", "[e2e/*]"), "not a plain relative path"),
            ("tests-dir outside", RULES.replace("tests-dir: e2e/tests", "tests-dir: other/tests"), "must lie inside allowed-new-paths"),
            ("mode", RULES.replace("mode-max: local", "mode-max: all"), "mode-max must be"),
            ("prefix", RULES.replace("branch-prefix: testpilot/", "branch-prefix: ../"), "branch-prefix must be"),
            ("limit", RULES.replace("max-files: 3", "max-files: 0"), "max-files must be"),
            ("not a list", RULES.replace("[e2e/]", "e2e/"), "must be a list"),
        ):
            with self.subTest(label):
                p = World(self, rules=text).run("check")
                self.assertEqual(p.returncode, 0, p.out)
                self.assertIn("mode: off", p.out)
                self.assertIn(want, p.out)

    def test_a_missing_or_wrong_checkout_means_off(self):
        w = World(self)
        (w.repo / "sub").mkdir()
        for path in (str(w.repo / "sub"), str(w.tmp / "nowhere")):
            with self.subTest(path=Path(path).name):
                w.set_profile(repoPath=path)
                self.assertIn("not the top folder of a git checkout", w.run("check").out)

    def test_profile_problems(self):
        w = World(self, mode="off")
        p = w.run("check")
        self.assertEqual(p.returncode, 0, p.out)
        self.assertIn("the profile's gitMode is off", p.out)
        w.set_profile(gitMode="everything")
        p = w.run("check")
        self.assertEqual(p.returncode, 1, p.out)
        self.assertIn("must be off, local or pr", p.out)
        w.set_profile(gitMode="local", repo=None)
        self.assertIn("needs repo", w.run("check").out)
        (w.agent / ".testpilot" / "testbench.json").unlink()
        p = w.run("check")
        self.assertEqual(p.returncode, 1, p.out)
        self.assertIn("could not be read", p.out)

    def test_project_picks_the_profile_and_a_name_that_could_leave_the_folder_is_refused(self):
        """Plan 10b, P2: every project has its own profile, and its own repo."""
        w = World(self, mode="off")
        (w.agent / ".testpilot" / "projects" / "other.json").write_text(json.dumps({"projectId": "2", "gitMode": "everything", "repo": "acme/other", "repoPath": str(w.repo)}))
        self.assertIn("the profile's gitMode is off", w.run("check").out)
        self.assertIn("must be off, local or pr", w.run("check", "--project", "other").out)
        p = w.run("check", "--project", "../shop")
        self.assertEqual(p.returncode, 1, p.out)
        self.assertIn("--project is the name of a profile", p.out)

    def test_with_no_profile_here_the_one_in_the_home_folder_is_read(self):
        """Plan 10b, P1: claude started in any folder, the configuration in ~/.testpilot/."""
        w = World(self, mode="off")
        home = w.tmpdir / "_home"
        home.mkdir(parents=True)
        (w.agent / ".testpilot").rename(home / ".testpilot")
        p = w.run("check")
        self.assertEqual(p.returncode, 0, p.out)
        self.assertIn("the profile's gitMode is off", p.out)
        (home / ".testpilot" / "testbench.json").write_text("{not json")
        p = w.run("check")
        self.assertEqual(p.returncode, 1, p.out)
        self.assertIn(str(home / ".testpilot" / "testbench.json"), p.out)


class WriteTests(unittest.TestCase):
    def assertRefused(self, w, items, want, **kw):
        before = w.state()
        p = w.write(items, **kw)
        self.assertEqual(p.returncode, 1, p.out)
        self.assertIn(want, p.out)
        self.assertEqual(w.state(), before, "a refusal must leave nothing behind")
        return p

    def test_writes_a_local_branch_and_touches_nothing_else(self):
        w = World(self)
        (w.repo / "README.md").write_text("changed, not committed\n")  # a dirty checkout is left alone
        main_sha, origin_sha = (sh(w.repo, "rev-parse", r).stdout.strip() for r in ("main", "origin/main"))
        second = spec('await page.goto("https://shop.example.com/pay");')
        p = w.write([S(), S("e2e/tests/shop/pay.spec.ts", second)])
        self.assertEqual(p.returncode, 0, p.out)
        for want in ("git mode: local", "branch: testpilot/discover-7", "nothing was pushed", "files: 2", "e2e/tests/shop/cart.spec.ts"):
            self.assertIn(want, p.out)
        self.assertEqual(sh(w.repo, "rev-parse", "testpilot/discover-7^").stdout.strip(), origin_sha)
        self.assertEqual(sorted(sh(w.repo, "diff", "--name-status", "origin/main", "testpilot/discover-7").stdout.split("\n"))[1:], ["A\te2e/tests/shop/cart.spec.ts", "A\te2e/tests/shop/pay.spec.ts"])
        added = sum(int(line.split("\t")[0]) for line in sh(w.repo, "diff", "--numstat", "origin/main", "testpilot/discover-7").stdout.splitlines())
        self.assertEqual(added, 10)
        self.assertIn(f"files: 2, {added} lines (not run)", p.out, "the tool reports the lines git counts, not one more per file")
        self.assertEqual(sh(w.repo, "show", "testpilot/discover-7:e2e/tests/shop/cart.spec.ts").stdout, GOOD)
        self.assertIn("request 7", sh(w.repo, "log", "-1", "--format=%B", "testpilot/discover-7").stdout)
        self.assertEqual(sh(w.repo, "symbolic-ref", "HEAD").stdout.strip(), "refs/heads/main")
        self.assertEqual((sh(w.repo, "rev-parse", "main").stdout.strip(), sh(w.repo, "rev-parse", "origin/main").stdout.strip()), (main_sha, origin_sha))
        self.assertEqual(sh(w.repo, "status", "--porcelain").stdout, " M README.md\n")
        self.assertEqual(sh(w.repo, "worktree", "list").stdout.count("\n"), 1)
        self.assertEqual(os.listdir(w.tmpdir), [])

    def test_a_confirmation_of_off_writes_nothing_and_pr_counts_as_local(self):
        w = World(self)
        before = w.state()
        p = w.write([S()], confirmed="off")
        self.assertEqual(p.returncode, 2, p.out)
        self.assertIn("you confirmed git mode off", p.out)
        self.assertEqual(w.state(), before)
        p = w.write([S()], confirmed="pr")
        self.assertEqual(p.returncode, 0, p.out)
        self.assertIn("git mode: local", p.out)

    def test_pr_in_both_the_profile_and_the_rules_still_only_writes_a_local_branch(self):
        w = World(self, rules=RULES.replace("mode-max: local", "mode-max: pr"), mode="pr")
        p = w.write([S()], confirmed="pr")
        self.assertEqual(p.returncode, 0, p.out)
        self.assertIn("git mode: local (profile and TESTPILOT.md allow local, you confirmed pr)", p.out)
        self.assertIn("nothing was pushed", p.out)

    def test_the_mode_off_in_the_profile_writes_nothing(self):
        w = World(self, mode="off")
        before = w.state()
        p = w.write([S()])
        self.assertEqual(p.returncode, 2, p.out)
        self.assertEqual(w.state(), before)

    def test_a_request_alone_is_never_a_confirmation(self):
        w = World(self)
        p = w.run("write", "7", "--origin", ORIGIN, "--specs", w.specs([S()]))
        self.assertEqual(p.returncode, 1)
        self.assertIn("a request is never a confirmation", p.out)

    def test_paths(self):
        w = World(self)
        for path, want in (
            ("/etc/cron.d/x.spec.ts", "not a plain relative path"), ("e2e/tests/../../.github/x.spec.ts", "not a plain relative path"), ("e2e\\tests\\a\\b.spec.ts", "not a plain relative path"),
            ("e2e/tests/.git/b.spec.ts", "not a plain relative path"), ("e2e/tests/a/.hidden.spec.ts", "not a plain relative path"), ("", "not a plain relative path"), (123, "not a plain relative path"),
            ("e2e/other/a/b.spec.ts", "outside the tests folder"), (".github/workflows/a.spec.ts", "not a plain relative path"), ("E2E/Tests/a/b.spec.ts", "outside the tests folder"),
            ("e2e/tests/shop.spec.ts", "must be <tests folder>/<area>/<flow>.spec.ts"), ("e2e/tests/a/b/c.spec.ts", "must be <tests folder>/<area>/<flow>.spec.ts"), ("e2e/tests/a/b.ts", "must be <tests folder>/<area>/<flow>.spec.ts"),
            ("e2e/tests/private/b.spec.ts", "never-touch"), ("e2e/tests/PRIVATE/b.spec.ts", "never-touch"),
        ):
            with self.subTest(path=path):
                self.assertRefused(w, [S(path)], want)

    def test_the_built_in_never_touch_list_cannot_be_opened_by_the_rules(self):
        # a rules file that names a built-in file as the tests folder still cannot open it
        w = World(self, rules=RULES.replace("tests-dir: e2e/tests", "tests-dir: package.json").replace("[e2e/]", "[package.json/]"))
        self.assertRefused(w, [S("package.json/a/b.spec.ts")], "never-touch")
        # and a folder that starts with a dot (.git, .github) is out of reach whatever the rules say
        w = World(self, rules=RULES.replace("tests-dir: e2e/tests", "tests-dir: .github/tests").replace("[e2e/]", "[.github/]"))
        self.assertRefused(w, [S(".github/tests/a/b.spec.ts")], "not a plain relative path")

    def test_only_new_files(self):
        def setup(repo):
            (repo / "e2e/tests/shop").mkdir(parents=True)
            (repo / "e2e/tests/shop/cart.spec.ts").write_text("// mine\n")
        w = World(self, setup=setup)
        self.assertRefused(w, [S()], "already exists")
        self.assertRefused(w, [S("e2e/tests/shop/CART.spec.ts")], "already exists")  # a case-insensitive disk would overwrite it
        self.assertRefused(w, [S("e2e/tests/shop/a.spec.ts"), S("e2e/tests/shop/a.spec.ts")], "already exists")
        self.assertRefused(w, [S("e2e/tests/shop/a.spec.ts"), S("e2e/tests/shop/A.spec.ts")], "already exists")

    def tagged_world(self):
        def setup(repo):
            (repo / "e2e/tests/shop").mkdir(parents=True)
            (repo / "e2e/tests/shop/cart.spec.ts").write_text('import { test } from "@playwright/test";\ntest("cart @SHOP-1", async () => {});\ntest("cart again @SHOP-1", async () => {});\ntest("pay @shop-12", async () => {});\n')
            (repo / "e2e/tests/shop/notes.md").write_text("@SHOP-5 is only a note\n")  # not a spec
            (repo / "e2e/other").mkdir(parents=True)
            (repo / "e2e/other/x.spec.ts").write_text('test("elsewhere @SHOP-7", async () => {});\n')  # outside tests-dir
        return World(self, setup=setup)

    def test_a_test_case_that_already_has_a_spec_on_the_base_branch_gets_no_second_one_whatever_the_file_is_called(self):
        """Deep key 4 renamed all 11 of its spec files with a suffix to get past the file name check, and every one of them carried a tag that main already had."""
        w = self.tagged_world()
        (w.repo / "e2e/tests/shop/cart.spec.ts").write_text("// edited and not committed: the tags are read from origin/main, not from here\n")
        again = spec("await page.goto('https://shop.example.com/cart');").replace("@CASE-1", "@SHOP-1")
        p = self.assertRefused(w, [S("e2e/tests/shop/cart-d10.spec.ts", again)], "uses the tag @SHOP-1, which e2e/tests/shop/cart.spec.ts on origin/main already has")
        self.assertIn("whatever the file is called", p.out)
        self.assertRefused(w, [S("e2e/tests/shop/pay.spec.ts", spec("await page.goto('https://shop.example.com/pay');").replace("@CASE-1", "@SHOP-12"))], "@SHOP-12")  # the case of the letters does not matter
        self.assertRefused(w, [S("e2e/tests/shop/new.spec.ts"), S("e2e/tests/other/again.spec.ts", again)], "uses the tag @SHOP-1")  # one refused spec makes none

    def test_a_new_tag_a_tag_in_a_note_a_tag_outside_tests_dir_and_a_tag_only_in_the_working_folder_do_not_block(self):
        w = self.tagged_world()
        (w.repo / "e2e/tests/shop/mine.spec.ts").write_text('test("not committed @SHOP-9", async () => {});\n')  # the checkout is never read, only origin/main
        items = [S("e2e/tests/shop/a.spec.ts", spec("await page.goto('https://shop.example.com/a');").replace("@CASE-1", "@SHOP-5")),
                 S("e2e/tests/shop/b.spec.ts", spec("await page.goto('https://shop.example.com/b');").replace("@CASE-1", "@SHOP-7")),
                 S("e2e/tests/shop/c.spec.ts", spec("await page.goto('https://shop.example.com/c');").replace("@CASE-1", "@SHOP-9"))]
        self.assertEqual(w.write(items).returncode, 0, w.write(items).out)

    def test_check_lists_the_tags_that_already_have_a_spec_so_that_the_agent_skips_them(self):
        p = self.tagged_world().run("check")
        self.assertEqual(p.returncode, 0, p.out)
        self.assertIn("tagged: 2 test cases already have a spec on origin/main: SHOP-1, SHOP-12", p.out)
        self.assertNotIn("SHOP-5", p.out)
        self.assertNotIn("SHOP-7", p.out)
        self.assertIn("tagged: 0 test cases already have a spec on origin/main", World(self).run("check").out)

    def test_limits_on_files_and_lines(self):
        w = World(self)
        self.assertRefused(w, [S(f"e2e/tests/shop/f{i}.spec.ts") for i in range(4)], "must hold 1 to 3")
        self.assertRefused(w, [], "must hold 1 to 3")
        big = spec("\n  ".join(['await page.goto("https://shop.example.com/");'] * 40))
        self.assertEqual(w.write([S("e2e/tests/shop/a.spec.ts", big)]).returncode, 0)
        w = World(self)
        self.assertRefused(w, [S("e2e/tests/shop/a.spec.ts", big), S("e2e/tests/shop/b.spec.ts", big)], "over max-lines 60")

    def test_the_line_limit_is_the_number_of_lines_git_counts(self):
        two = [S(), S("e2e/tests/shop/pay.spec.ts", spec('await page.goto("https://shop.example.com/pay");'))]  # five lines each
        w = World(self, rules=RULES.replace("max-lines: 60", "max-lines: 10"))
        self.assertEqual(w.write(two).returncode, 0, "exactly the limit is allowed")
        w = World(self, rules=RULES.replace("max-lines: 60", "max-lines: 9"))
        self.assertRefused(w, two, "10 lines is over max-lines 9")

    def test_the_branch_is_made_once(self):
        w = World(self)
        self.assertEqual(w.write([S()]).returncode, 0)
        self.assertRefused(w, [S("e2e/tests/shop/other.spec.ts")], "the branch testpilot/discover-7 already exists")

    def test_a_link_in_the_way_is_refused(self):
        def setup(repo):
            (repo / "e2e/tests").mkdir(parents=True)
            os.symlink("../../outside", repo / "e2e/tests/shop")
        w = World(self, setup=setup)
        self.assertRefused(w, [S("e2e/tests/shop/new.spec.ts")], "through a link")

    def test_hooks_in_the_repository_do_not_run(self):
        w = World(self)
        marker = w.tmp / "marker"
        for name in ("pre-commit", "post-checkout", "post-commit", "commit-msg"):
            hook = w.repo / ".git" / "hooks" / name
            hook.write_text(f'#!/bin/sh\ntouch "{marker}"\n')
            hook.chmod(0o755)
        p = w.write([S()])
        self.assertEqual(p.returncode, 0, p.out)
        self.assertFalse(marker.exists(), "a hook ran")

    def test_git_environment_variables_are_ignored(self):
        w, other = World(self), World(self)
        p = w.write([S()], env={"GIT_DIR": str(other.repo / ".git"), "GIT_WORK_TREE": str(other.repo), "GIT_INDEX_FILE": str(w.tmp / "index")})
        self.assertEqual(p.returncode, 0, p.out)
        self.assertEqual(sh(w.repo, "branch", "--list", "testpilot/*").stdout.split(), ["testpilot/discover-7"])
        self.assertEqual(sh(other.repo, "branch", "--list", "testpilot/*").stdout, "")

    def test_a_commit_that_cannot_be_made_leaves_nothing(self):
        w = World(self)
        sh(w.repo, "config", "user.useConfigOnly", "true")
        sh(w.repo, "config", "--unset", "user.name")
        sh(w.repo, "config", "--unset", "user.email")
        env = {"HOME": str(w.tmp), "XDG_CONFIG_HOME": str(w.tmp)}  # no identity from the person's own configuration either
        before = w.state()
        p = w.write([S()], env=env)
        self.assertEqual(p.returncode, 1, p.out)
        self.assertIn("git could not commit", p.out)
        self.assertEqual(w.state(), before)

    def test_the_specs_file(self):
        w = World(self)
        good = w.specs([S()])
        (w.agent / "audits" / "request-8").mkdir()
        (w.agent / "audits" / "request-8" / "specs.json").write_text((w.agent / good).read_text())
        (w.agent / "specs.json").write_text((w.agent / good).read_text())
        (w.agent / "audits" / "request-7" / "specs.txt").write_text((w.agent / good).read_text())
        os.symlink(w.agent / good, w.agent / "audits" / "request-7" / "link.json")
        for label, rel in (("outside the folder", "specs.json"), ("another request's folder", "audits/request-8/specs.json"), ("not .json", "audits/request-7/specs.txt"), ("a link", "audits/request-7/link.json"), ("missing", "audits/request-7/none.json"), ("a folder up", "audits/request-7/../request-8/specs.json")):
            with self.subTest(label):
                self.assertRefused(w, None, "must be a plain .json file inside audits/request-7/", rel=rel)
        for label, body, want in (("not json", "{", "must be {"), ("not a list", '{"specs": "x"}', "must hold 1 to 3"), ("missing content", '{"specs": [{"path": "a"}]}', "exactly"), ("extra key", '{"specs": [{"path": "a", "content": "b", "mode": "x"}]}', "exactly"),
                                  ("content is not text", '{"specs": [{"path": "a", "content": 5}]}', "exactly"), ("a list of strings", '{"specs": ["a"]}', "exactly")):
            with self.subTest(label):
                (w.agent / "audits/request-7/bad.json").write_text(body)
                self.assertRefused(w, None, want, rel="audits/request-7/bad.json")

    def test_the_confirmed_address(self):
        w = World(self)
        for origin in ("https://shop.example.com/cart", "shop.example.com", "https://shop.example.com@evil.example", "", "javascript:alert(1)"):
            with self.subTest(origin=origin):
                self.assertRefused(w, [S()], "--origin must be the confirmed address", origin=origin)

    def test_a_spec_with_forbidden_text_is_refused_through_the_tool_too(self):
        w = World(self)
        self.assertRefused(w, [S(content=spec('await fetch("https://shop.example.com/");'))], "uses fetch")
        self.assertRefused(w, [S(), S("e2e/tests/shop/bad.spec.ts", spec('await page.goto("https://evil.example.com/");'))], "other than the confirmed one")  # one bad spec stops all of them


BAD_CONTENT = (
    ("require", spec('const x = require("fs");'), "uses require"),
    ("other import", spec("", head='import fs from "fs";'), "only import allowed"),
    ("relative import", spec("", head='import { h } from "./helper";'), "only import allowed"),
    ("dynamic import", spec('await import("fs");'), "only import allowed"),
    ("eval", spec("eval('1');"), "uses eval"),
    ("Function", spec("new Function('1')();"), "uses Function"),
    ("child_process", spec('const c = "child_process";'), "uses child_process"),
    ("process", spec("console.log(process.env.X);"), "uses process"),
    ("fetch", spec('await fetch("https://shop.example.com/");'), "uses fetch"),
    ("evaluate", spec("await page.evaluate(() => 1);"), "uses evaluate"),
    ("route", spec('await page.route("**/*", r => r.abort());'), "uses route"),
    ("placeholder", spec("await page.goto(`https://shop.example.com/${id}`);"), "placeholders"),
    ("other host", spec('await page.goto("https://evil.example.com/x");'), "other than the confirmed one"),
    ("user info", spec('await page.goto("https://shop.example.com@evil.example.com/");'), "other than the confirmed one"),
    ("other port", spec('await page.goto("https://shop.example.com:8443/x");'), "other than the confirmed one"),
    ("http instead of https", spec('await page.goto("http://shop.example.com/x");'), "other than the confirmed one"),
    ("javascript:", spec('await page.goto("javascript:alert(1)");'), "javascript:"),
    ("data:", spec('await page.goto("data:text/html,x");'), "javascript:"),
    ("protocol-relative", spec('await page.goto("//evil.example.com/x");'), "protocol-relative"),
    ("bidi override", spec("// \u202e"), "invisible"),
    ("zero-width space", spec("// a\u200bb"), "invisible"),
    ("no-break space", spec("// a\u00a0b"), "invisible"),
    ("lone carriage return", spec("// a\rb"), "invisible"),
    ("no test", 'import { test } from "@playwright/test";\n', "not a Playwright spec"),
    ("no import", 'test("a", async () => {});\n', "not a Playwright spec"),
    ("too long", spec("// " + "x" * 61000), "over 60 kB"),
)
GOOD_CONTENT = (
    GOOD,
    spec('test.fixme(true, "TODO: no stable selector for the pay button yet");'),
    spec('await page.goto("https://shop.example.com/");\n  await expect(page.getByText("Varukorgen öppnas")).toBeVisible();'),
    "import { test } from '@playwright/test';\ntest.describe(\"a\", () => { test(\"b @CASE-2\", async ({ page }) => { await page.goto(\"https://shop.example.com/a?x=1#y\"); }); });\n",
)


class ContentTests(unittest.TestCase):
    def test_refused_text(self):
        for label, text, want in BAD_CONTENT:
            with self.subTest(label):
                found = spec_git.check_content(text, ORIGIN)
                self.assertIsNotNone(found)
                self.assertIn(want, found)

    def test_accepted_text(self):
        for i, text in enumerate(GOOD_CONTENT):
            with self.subTest(i):
                self.assertIsNone(spec_git.check_content(text, ORIGIN))

    def test_the_address_of_another_origin_would_be_accepted_only_if_confirmed(self):
        text = spec('await page.goto("https://other.example.com/x");')
        self.assertIsNotNone(spec_git.check_content(text, ORIGIN))
        self.assertIsNone(spec_git.check_content(text, "https://other.example.com"))


class AllowListTests(unittest.TestCase):
    def test_only_the_listed_git_calls_can_be_made(self):
        for args in (("fetch",), ("pull",), ("merge", "x"), ("clone", "x"), ("init",), ("config", "x", "y"), ("checkout", "x"), ("switch", "x"), ("branch", "-D", "x"), ("reset", "--hard"), ("remote", "add", "x", "y"),
                     ("remote", "set-url", "origin", "y"), ("worktree", "move", "a", "b"), ("gc",), ("tag", "x"), ("rebase", "x"), ("cherry-pick", "x"), ("stash",), ("clean", "-fd"), ("submodule", "update")):
            with self.subTest(args=args), self.assertRaises(RuntimeError):
                spec_git.git(".", *args)

    def test_the_list_is_exactly_this(self):
        # a call added to the list must be added here too, so that it is seen in review
        self.assertEqual(spec_git.GIT_OK, {("rev-parse",), ("show",), ("ls-tree",), ("remote", "get-url"), ("worktree", "add"), ("worktree", "remove"), ("worktree", "prune"), ("add",), ("commit",), ("update-ref",), ("rev-list",), ("diff",), ("push",)})


class TemplateTests(unittest.TestCase):
    def test_the_rules_template_is_valid_and_shows_every_rule(self):
        text = (CONFIG / "TESTPILOT.example.md").read_text()
        rules = spec_git.parse_rules(text)
        self.assertEqual((rules["mode-max"], rules["tests-dir"], rules["allowed"]), ("local", "e2e/tests", ["e2e/"]))
        for key in spec_git.RULE_KEYS - {"protection-confirmed"}:
            self.assertRegex(text, rf"(?m)^{key}:")  # the template cannot fall behind the tool
        # the one rule that is the person's own word is shown but never switched on in a template that people copy
        self.assertRegex(text, r"(?m)^# protection-confirmed: ")
        self.assertEqual(rules["protection-confirmed"], "")
        self.assertIsNone(spec_git.check_path("e2e/tests/shop/cart.spec.ts", rules))
        self.assertIsNotNone(spec_git.check_path("e2e/support/shop/cart.spec.ts", rules))

    def test_the_profile_template_has_git_off(self):
        p = json.loads((CONFIG / "projects" / "shop.example.json").read_text())
        self.assertEqual((p["gitMode"], p["repo"], p["baseBranch"]), ("off", "owner/name", "main"))


class UsageTests(unittest.TestCase):
    def test_bad_calls(self):
        w = World(self)
        for args in (("push",), ("write",), ("write", "abc", "--confirmed", "local"), ("write", "7", "--confirmed", "local")):
            with self.subTest(args=args):
                self.assertEqual(w.run(*args).returncode, 1)


if __name__ == "__main__":
    unittest.main()
