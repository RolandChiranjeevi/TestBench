import "./env.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildSpec, specFileName } from "../server/automation.ts";
import { codeOf, runCommand, shellWord, specRunState, todoNotice } from "../web/src/specrun.ts";

// F-A: TestBench runs nothing. After Apply the spec card tells a person how to run the file themselves. These tests are for what the box says: when a spec counts as runnable (test.fixme gone),
// how many TODO lines are left, and the command. The box never says the test is correct, and nothing in it can start anything.

const made = (extra: Partial<Parameters<typeof buildSpec>[0]> = {}) => buildSpec({ source: "plan item TPI-1", title: "Add a todo", steps: ["Type the text", "Press Enter"], assertions: ["The text is shown"], testData: "", ...extra });

describe("is test.fixme still in the text", () => {
  it("a spec made by the template has it, so it is not runnable yet", () => {
    assert.equal(specRunState(made()).hasFixme, true);
  });

  it("removing the test.fixme line makes it runnable", () => {
    const text = made().split("\n").filter((l) => !l.includes("test.fixme(")).join("\n");
    assert.equal(specRunState(text).hasFixme, false);
  });

  it("other fixme forms count too: test.describe.fixme and a fixme with other arguments", () => {
    assert.equal(specRunState('test.describe.fixme("x", () => {});').hasFixme, true);
    assert.equal(specRunState('test.fixme(({ browserName }) => browserName === "webkit", "later");').hasFixme, true);
    assert.equal(specRunState("test.fixme ( true );").hasFixme, true);
  });

  it("a mention in a comment or in a string is not a fixme call", () => {
    const text = [
      "// test.fixme(true, 'remove me') used to be here",
      "/* test.fixme(true) in a block",
      "   comment */",
      'await test.step("do test.fixme(x) later", async () => {});',
      "const note = `test.fixme(`;",
      "test('x', async () => {});",
    ].join("\n");
    assert.equal(specRunState(text).hasFixme, false);
    assert.equal(codeOf(text).includes("fixme"), false);
  });

  it("an empty text has none", () => {
    assert.deepEqual(specRunState(""), { hasFixme: false, todoLines: 0 });
  });
});

describe("TODO lines", () => {
  it("counts the lines that still say TODO, and none once they are gone", () => {
    const text = made();
    assert.equal(specRunState(text).todoLines, text.split("\n").filter((l) => l.includes("TODO")).length);
    assert.ok(specRunState(text).todoLines >= 3);
    assert.equal(specRunState("test('x', async () => {\n  expect(1).toBe(1);\n});").todoLines, 0);
    assert.equal(specRunState("// TODO one\n// TODO two\nconst todone = 1; // todo lower case is not counted").todoLines, 2);
  });

  it("is worded as a notice, in the singular and the plural", () => {
    assert.equal(todoNotice(1), "1 TODO line is still in the text");
    assert.equal(todoNotice(4), "4 TODO lines are still in the text");
  });
});

describe("the command", () => {
  it("is npx playwright test and the file name of the spec", () => {
    assert.equal(runCommand("tpi-1-add-a-todo.spec.ts"), "npx playwright test tpi-1-add-a-todo.spec.ts");
    assert.equal(runCommand(specFileName("req-7", "Todo can be added")), "npx playwright test req-7-todo-can-be-added.spec.ts");
  });

  it("is only the file name: a name with spaces or quotes is one quoted word, so nothing can be added to the command", () => {
    assert.equal(shellWord("a b.spec.ts"), "'a b.spec.ts'");
    assert.equal(shellWord("x; rm -rf ~"), "'x; rm -rf ~'");
    assert.equal(shellWord("it's.spec.ts"), "'it'\\''s.spec.ts'");
    assert.equal(runCommand("$(whoami).spec.ts"), "npx playwright test '$(whoami).spec.ts'");
  });

  it("the file names the server makes are always plain, so they are never quoted", () => {
    for (const title of ["Add a todo", 'Évil "title" `x` $(y) ; rm', "../../etc/passwd", "", "x".repeat(300)]) {
      const name = specFileName("tpi-1", title);
      assert.equal(shellWord(name), name, name);
    }
  });
});

describe("the box in the spec card", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "web", "src", "pages", "AutomationSuggestions.tsx"), "utf8");
  const box = src.slice(src.indexOf("function RunItYourself"), src.indexOf("function SuggestionEditor"));

  it("starts nothing: it has no button, no request and no link to a route that runs anything", () => {
    assert.ok(box.length > 500, "found the component");
    assert.doesNotMatch(box, /<Button|onClick|api\.|fetch\(|useMutation|\.post\(/);
    assert.match(box, /to=\{`\/p\/\$\{pid\}\/import`\}/);
  });

  it("says that TestBench does not run tests and has not checked the test, and never calls it correct, passing or verified", () => {
    assert.match(box, /TestBench does not run tests/);
    assert.match(box, /TestBench has not checked it/);
    assert.doesNotMatch(box, /\b(correct|verified|passes|passing|works)\b/i);
  });

  it("adds no status region to the card: the card's own message (\"already has a spec suggestion\") is the only one", () => {
    assert.doesNotMatch(box, /role="status"|aria-live/);
  });

  it("shows only for an applied spec that is not rejected or ignored", () => {
    assert.match(src, /s\.isSpec && s\.appliedAt && s\.status !== "rejected" && s\.status !== "ignored" && s\.artifactName && <RunItYourself/);
  });
});
