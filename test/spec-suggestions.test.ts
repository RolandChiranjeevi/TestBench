import "./env.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { runAs, type AccountUser } from "../server/accountcontext.ts";
import { db } from "../server/db.ts";
import { bagFromFiles } from "../server/importers/bag.ts";
import { decidePlanItem, importAuditPackage } from "../server/audits.ts";
import {
  applyAutomationSuggestion, applySpecSuggestion, buildSpec, cleanText, decideAutomationSuggestion, editAutomationSuggestion, getAutomationSuggestion, specFile, specFileName, suggestAutomation,
  suggestSpecForPlanItem, suggestSpecFromPlanItem,
} from "../server/automation.ts";
import { makeProject } from "./helpers.ts";

// A Playwright spec suggestion is made from a fixed template for an approved plan item. It starts with test.fixme, invents no selector or URL, and cannot turn text into code. A person edits
// and decides it; Apply makes it a draft spec, and only then can the file be downloaded. Nothing is run, and nothing is written to disk or to git.

let n = 0;
const proj = () => makeProject(`SP${++n}`, `Spec ${n}`);
const item = (over: Record<string, unknown> = {}) => ({
  sourceId: "TPI-001", title: "Add a todo", type: "Functional", risk: "High", priority: "High", readiness: "ready", preconditions: "An empty list", testData: "QA-AUDIT-1",
  steps: ["Type the text", "Press Enter"], acceptanceCriteria: "- The text is shown in the list\n- The input is cleared", automation: "", refs: { requirements: [] }, ...over,
});
function pkg(p: { key: string }, planItems: unknown[]) {
  const f = new Map<string, Uint8Array>();
  f.set("manifest.json", Buffer.from(JSON.stringify({ format: "testbench-audit-package", version: 1, audit: { id: "a1", title: "Audit", project: p.key }, files: [], parts: {} })));
  f.set("bugs.json", Buffer.from(JSON.stringify({ version: 1, bugs: [] })));
  f.set("test-plan.json", Buffer.from(JSON.stringify({ version: 1, planItems, coverageGaps: [] })));
  return bagFromFiles(f);
}
const user = (name: string): AccountUser => {
  const id = (db.prepare("INSERT INTO users (email, name, password_hash) VALUES (?, ?, 'h') RETURNING id").get(`${name.toLowerCase().replace(/\W/g, "")}@x.io`, name) as { id: number }).id;
  return { id, email: "", name, isOwner: false, disabledAt: null, createdAt: "", lastLoginAt: null };
};
const row = (id: number) => db.prepare("SELECT * FROM automation_suggestions WHERE id = ?").get(id) as Record<string, any>;
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
/** An audit whose plan items are imported; `approve` approves them as this person (or without one when accounts are off); false leaves them proposed. */
function seeded(items: Record<string, unknown>[] = [item()], approve: AccountUser | null | false = false) {
  const p = proj();
  importAuditPackage(pkg(p, items), { projectId: p.id, source: "upload" }, { dryRun: false });
  const a = (db.prepare("SELECT id FROM audits WHERE project_id = ? AND agent_audit_id = 'a1'").get(p.id) as { id: number }).id;
  if (approve !== false) for (const i of items) { const go = () => decidePlanItem(a, i.sourceId as string, "approved"); if (approve) runAs(approve, go); else go(); }
  return { p, a };
}
const makeSpec = (a: number, sourceId = "TPI-001") => { const r = suggestSpecForPlanItem(a, sourceId); assert.equal(r.created.length, 1, r.message); return r.created[0]; };

/** Every line of a spec is one of the template's lines. Text from the source is only ever inside a JSON string literal or a `//` comment. Returns the string literals, parsed. */
function literalsOf(text: string): string[] {
  const lit = String.raw`"(?:[^"\\\n]|\\.)*"`;
  const allowed = [
    /^$/, /^\/\/ .*$/, /^import \{ test, expect \} from "@playwright\/test";$/, new RegExp(`^test\\.describe\\((${lit}), \\(\\) => \\{$`), new RegExp(`^ {2}test\\((${lit}), async \\(\\{ page \\}\\) => \\{$`),
    /^ {4}test\.fixme\(true, "Draft from TestBench: not reviewed, not run\. Remove this line when a person has finished the test\."\);$/, /^ {4}\/\/ .*$/, /^ {6}\/\/ .*$/,
    new RegExp(`^ {4}await test\\.step\\((${lit}), async \\(\\) => \\{$`), /^ {4}\}\);$/, /^ {2}\}\);$/, /^\}\);$/,
  ];
  const out: string[] = [];
  const lines = text.split("\n");
  assert.equal(lines.at(-1), "", "ends with one newline");
  for (const line of lines) {
    const hit = allowed.map((re) => re.exec(line)).find((m) => m);
    assert.ok(hit, `not a template line: ${JSON.stringify(line)}`);
    if (hit[1] !== undefined) out.push(JSON.parse(hit[1]) as string);
  }
  return out;
}
// eslint-disable-next-line no-control-regex
const RAW_UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;

// Runs first on purpose: there is no account yet, so this is what a single-person install does.
describe("without accounts (nothing changes for a single-person install)", () => {
  it("a person can ask for a spec, edit it, approve it, apply it and download it, and no account is saved", () => {
    const { a } = seeded([item()], null);
    const s = makeSpec(a);
    editAutomationSuggestion(s.id, { artifactText: `${s.artifactText}// mine\n` });
    decideAutomationSuggestion(s.id, "approved");
    applySpecSuggestion(s.id);
    assert.match(specFile(s.id).text, /\/\/ mine\n$/);
    const r = row(s.id);
    assert.deepEqual([r.review_status, r.decided_by_user_id, r.applied_by_user_id], ["approved", null, null]);
    assert.ok(r.applied_at);
  });
});

describe("the file name", () => {
  it("is the reference and the title as lower case letters, digits and hyphens, with the extension", () => {
    assert.equal(specFileName("TPI-001", "Add a todo"), "tpi-001-add-a-todo.spec.ts");
    assert.equal(specFileName("TPI-002", "Å, ä & ö: räksmörgås!"), "tpi-002-a-a-o-raksmorgas.spec.ts");
  });
  it("can never be a path or hold anything but those characters, whatever the title says", () => {
    for (const title of ["../../etc/passwd; rm -rf *", "a/b\\c", "x\u202ey.js", "```\n`", "\u0000\u0001", "", "   ", "A".repeat(500)]) {
      const name = specFileName("TPI-1", title);
      assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*\.spec\.ts$/, name);
      assert.ok(name.length <= 90, name);
    }
    assert.equal(specFileName("", ""), "spec.spec.ts");
  });
});

describe("the template", () => {
  const input = { source: "plan item TPI-001", title: "Add a todo", steps: ["Open the list", "Type the text"], assertions: ["The text is shown"], testData: "QA-AUDIT-1\nSecond line" };

  it("is a draft: a header, the import, describe and test, test.fixme, the test data, a test.step and a TODO per step, and a TODO per check", () => {
    assert.equal(buildSpec(input), [
      "// DRAFT: made by TestBench from plan item TPI-001 by a fixed rule. Not reviewed and not run.",
      "// A person rewrites every TODO. Remove test.fixme only when the test is finished and reviewed.",
      'import { test, expect } from "@playwright/test";',
      "",
      'test.describe("Add a todo", () => {',
      '  test("Add a todo", async ({ page }) => {',
      '    test.fixme(true, "Draft from TestBench: not reviewed, not run. Remove this line when a person has finished the test.");',
      "    // Test data (from the source):",
      "    //   QA-AUDIT-1",
      "    //   Second line",
      '    await test.step("Open the list", async () => {',
      "      // TODO: where this starts and what to do (no selector or URL is known here)",
      "    });",
      '    await test.step("Type the text", async () => {',
      "      // TODO: where this starts and what to do (no selector or URL is known here)",
      "    });",
      "    // Checks (from the acceptance criteria):",
      "    // TODO: expect(...) for: The text is shown",
      "  });",
      "});",
      "",
    ].join("\n"));
  });

  it("always has test.fixme, exactly once, whatever it is made from", () => {
    for (const o of [input, { ...input, steps: [], assertions: [], testData: "" }, { ...input, title: "", steps: ["", "  "] }, { ...input, title: 'x"); test.only(' }]) {
      const text = buildSpec(o);
      assert.equal((text.match(/test\.fixme\(/g) ?? []).length, 1);
      literalsOf(text);
    }
  });

  it("makes up no selector and no URL: nothing in it can find an element or open a page", () => {
    const text = buildSpec(input);
    assert.doesNotMatch(text, /page\.(goto|locator|getBy|click|fill|\$)|https?:\/\/|\bwaitFor|\.click\(|querySelector/);
  });

  it("cannot turn text into code: hostile text is only ever inside a string literal or a comment, and none of its tricky characters survive", () => {
    const hostile = [
      '"); require("child_process").execSync("touch /tmp/x"); //', "`${process.env.SECRET}`", "*/ evil(); /*", "line one\nawait page.goto('http://evil');\nline three", "a\u2028evil();\u2029b", "a\u0085evil()",
      "text\u202e)(live\u2066", "nul\u0000byte", "tab\tand\rcarriage", "\\\\\" \\", "</script><script>alert(1)</script>", "x".repeat(5000), "\u200bzero\u200dwidth\ufeff",
    ];
    for (const h of hostile) {
      const text = buildSpec({ source: h, title: h, steps: [h, `${h}2`], assertions: [h], testData: h });
      const literals = literalsOf(text);
      assert.ok(literals.length >= 4, "the title twice and one literal per step");
      for (const l of literals) { assert.equal(l, cleanText(l, 300), "the literal is exactly cleaned text"); assert.doesNotMatch(l, RAW_UNSAFE); }
      assert.doesNotMatch(text.replace(/\n/g, " "), RAW_UNSAFE, JSON.stringify(h).slice(0, 40));
      const code = text.split("\n").filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/"(?:[^"\\\n]|\\.)*"/g, '""')).join("\n");
      assert.doesNotMatch(code, /require|evil|process|goto|http|SECRET|alert/, "outside strings and comments there is only the template's own code");
    }
  });
});

describe("the spec suggestion for a plan item", () => {
  let tess!: AccountUser;
  before(() => { tess = user("Tess Spec"); });

  it("is made by the rule from the plan item's own text, the same every time, and says so", () => {
    const f = { title: "Add a todo", type: "Functional", risk: "High", priority: "High", readiness: "ready", preconditions: "An empty list", testData: "QA-AUDIT-1", steps: ["Type the text", "Press Enter"], acceptanceCriteria: "- The text is shown in the list\n- The input is cleared", automation: "", requirements: [] };
    const one = suggestSpecFromPlanItem(f, "TPI-001"); const two = suggestSpecFromPlanItem(structuredClone(f), "TPI-001");
    assert.deepEqual(one, two);
    assert.ok("content" in one);
    if (!("content" in one)) return;
    assert.equal(one.fileName, "tpi-001-add-a-todo.spec.ts");
    assert.deepEqual(one.content.steps, ["Set up: An empty list", "Type the text", "Press Enter"]);
    assert.deepEqual(one.content.assertions, ["The text is shown in the list", "The input is cleared"]);
    assert.equal(literalsOf(one.content.artifactText!).length, 5, "the title twice and three steps");
    assert.match(one.content.summary, /^Playwright spec tpi-001-add-a-todo\.spec\.ts for “Add a todo”: 3 steps and 2 checks, as a draft to finish\.$/);
    assert.match(one.content.plan, /Nothing is run by TestBench and nothing is written to disk or to git\./);
  });

  it("without steps or without acceptance criteria nothing is made, and the message says which", () => {
    const { a } = seeded([item({ steps: [] })], tess);
    const r = runAs(tess, () => suggestSpecForPlanItem(a, "TPI-001"));
    assert.deepEqual([r.created, r.message], [[], "Nothing was generated: the plan item has no steps. Add it to the plan item and ask again."]);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestions WHERE audit_id = ?", a), 0);
  });

  it("only an approved plan item gets one: a proposed or rejected one is refused with 409, an unknown one is 404, and nothing is stored", () => {
    const { a } = seeded([item(), item({ sourceId: "TPI-002", title: "Second" })], false);
    runAs(tess, () => decidePlanItem(a, "TPI-002", "rejected"));
    for (const id of ["TPI-001", "TPI-002"]) assert.throws(() => runAs(tess, () => suggestSpecForPlanItem(a, id)), /Approve the plan item first/, id);
    assert.throws(() => runAs(tess, () => suggestSpecForPlanItem(a, "NOPE")), /Plan item not found/);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestions WHERE audit_id = ?", a), 0);
  });

  it("is the rule's: origin rule, labelled Suggested by rule, a spec with a file name, proposed, not applied, and the history says the rule made it", () => {
    const { a } = seeded([item()], tess);
    const s = runAs(tess, () => makeSpec(a));
    assert.deepEqual([s.origin, s.label, s.rule, s.isSpec, s.artifactName, s.status, s.appliedAt, s.testCase], ["rule", "Suggested by rule", "playwright_spec_from_plan_item", true, "tpi-001-add-a-todo.spec.ts", "proposed", null, null]);
    assert.deepEqual(s.history.map((h) => [h.kind, h.byRule, h.actor]), [["suggested", true, "Rule: playwright spec from plan item"]]);
    assert.match(s.artifactText, /test\.fixme\(true,/);
  });

  it("once per plan item: asking again makes no second one, and a rejected or ignored one is not made again; it lives beside the automation suggestion", () => {
    const { a } = seeded([item(), item({ sourceId: "TPI-002", title: "Second" }), item({ sourceId: "TPI-003", title: "Third" })], tess);
    const one = runAs(tess, () => makeSpec(a, "TPI-001"));
    const again = runAs(tess, () => suggestSpecForPlanItem(a, "TPI-001"));
    assert.deepEqual([again.created, again.message], [[], "This plan item already has a spec suggestion."]);
    const rejected = runAs(tess, () => makeSpec(a, "TPI-002")); runAs(tess, () => decideAutomationSuggestion(rejected.id, "rejected"));
    const ignored = runAs(tess, () => makeSpec(a, "TPI-003")); runAs(tess, () => decideAutomationSuggestion(ignored.id, "ignored"));
    assert.match(runAs(tess, () => suggestSpecForPlanItem(a, "TPI-002")).message, /already has a spec suggestion, and you rejected it\. It is not made again/);
    assert.match(runAs(tess, () => suggestSpecForPlanItem(a, "TPI-003")).message, /already has a spec suggestion, and you ignored it\. It is not made again/);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestions WHERE audit_id = ?", a), 3);
    const auto = runAs(tess, () => suggestAutomation(a, "TPI-001"));
    assert.equal(auto.created.length, 1, "the automation suggestion for the same plan item is a different rule");
    assert.deepEqual([auto.created[0].isSpec, one.isSpec], [false, true]);
    assert.equal(count("SELECT COUNT(*) AS n FROM automation_suggestions WHERE audit_id = ? AND subject_ref = 'TPI-001'", a), 2);
  });
});

describe("a person's work on the spec text", () => {
  let anna!: AccountUser; let sam!: AccountUser;
  before(() => { anna = user("Anna Spec"); sam = user("Sam Spec"); });
  const fresh = () => { const { a } = seeded([item()], anna); return runAs(anna, () => makeSpec(a)); };

  it("the text can be edited, and the edit is a draft by that person, kept in the history as a change of the spec text; the rule's own text is kept", () => {
    const s = fresh();
    const mine = s.artifactText.replace("      // TODO: where this starts and what to do (no selector or URL is known here)", "      await page.goto('/todos');");
    runAs(anna, () => editAutomationSuggestion(s.id, { artifactText: mine }));
    const r = row(s.id);
    assert.deepEqual([r.review_status, r.edited_by, r.edited_by_user_id, r.artifact_text], ["draft", "Anna Spec", anna.id, mine]);
    assert.equal(JSON.parse(r.original).artifactText, s.artifactText, "the rule's text is kept as it was made");
    const h = getAutomationSuggestion(s.id).history;
    assert.deepEqual(h.map((x) => x.kind), ["suggested", "edited"]);
    assert.deepEqual(h[1].changes.map((c) => c.field), ["Spec text"]);
    assert.match(h[1].changes[0].to, /page\.goto\('\/todos'\)/);
    assert.match(h[1].changes[0].from, /TODO: where this starts/);
    runAs(sam, () => editAutomationSuggestion(s.id, { artifactText: mine })); // the same text again
    assert.equal(row(s.id).edited_by_user_id, anna.id, "no new edit");
  });

  it("the text must not be empty or enormous, and always ends with one newline", () => {
    const s = fresh();
    assert.throws(() => runAs(anna, () => editAutomationSuggestion(s.id, { artifactText: "  \n " })), /A spec needs its text/);
    assert.throws(() => runAs(anna, () => editAutomationSuggestion(s.id, { artifactText: "x".repeat(100001) })), /too long/);
    runAs(anna, () => editAutomationSuggestion(s.id, { artifactText: "// only this\n\n\n" }));
    assert.equal(row(s.id).artifact_text, "// only this\n");
  });

  it("approve, reject, ignore and put back work as for any suggestion, and are in the history in order", () => {
    const s = fresh();
    runAs(anna, () => decideAutomationSuggestion(s.id, "approved"));
    runAs(sam, () => decideAutomationSuggestion(s.id, "ignored"));
    runAs(sam, () => decideAutomationSuggestion(s.id, "proposed"));
    runAs(anna, () => decideAutomationSuggestion(s.id, "rejected"));
    assert.deepEqual(getAutomationSuggestion(s.id).history.map((x) => [x.kind, x.actor]), [["suggested", "Rule: playwright spec from plan item"], ["approved", "Anna Spec"], ["ignored", "Sam Spec"], ["restored", "Sam Spec"], ["rejected", "Anna Spec"]]);
  });
});

describe("Apply makes a draft spec, and only then can the file be downloaded", () => {
  let ada!: AccountUser;
  before(() => { ada = user("Ada Apply"); });
  const prepared = () => { const { p, a } = seeded([item()], ada); const s = runAs(ada, () => makeSpec(a)); return { p, a, s }; };

  it("before Apply the file cannot be downloaded", () => {
    const { s } = prepared();
    assert.throws(() => specFile(s.id), /Apply the spec first/);
  });

  it("Apply records who and when, makes the suggestion a draft (never approved) and makes the file downloadable with the text as it is now, a person's edits included", () => {
    const { s } = prepared();
    const made = runAs(ada, () => applySpecSuggestion(s.id));
    assert.equal(made.fileName, "tpi-001-add-a-todo.spec.ts");
    const r = row(s.id);
    assert.deepEqual([r.review_status, r.applied_by, r.applied_by_user_id, r.edited_by_user_id, r.decided_by_user_id], ["draft", "Ada Apply", ada.id, ada.id, null]);
    assert.ok(r.applied_at);
    assert.notEqual(r.review_status, "approved");
    assert.deepEqual(specFile(s.id), { fileName: "tpi-001-add-a-todo.spec.ts", text: s.artifactText });
    runAs(ada, () => editAutomationSuggestion(s.id, { artifactText: "// edited after apply\n" }));
    assert.equal(specFile(s.id).text, "// edited after apply\n", "the download is the text as it is now");
    assert.deepEqual(getAutomationSuggestion(s.id).history.map((h) => h.kind), ["suggested", "applied", "edited"]);
    assert.match(getAutomationSuggestion(s.id).history[1].note, /Draft spec tpi-001-add-a-todo\.spec\.ts made\. It can now be downloaded\. It is a draft/);
  });

  it("a suggestion a person had already approved stays approved; applying twice is refused", () => {
    const { s } = prepared();
    runAs(ada, () => decideAutomationSuggestion(s.id, "approved"));
    runAs(ada, () => applySpecSuggestion(s.id));
    assert.equal(row(s.id).review_status, "approved");
    assert.throws(() => runAs(ada, () => applySpecSuggestion(s.id)), /already applied/);
  });

  it("a rejected or ignored suggestion is not applied; and once applied, rejecting or ignoring it stops the download", () => {
    const { a } = seeded([item(), item({ sourceId: "TPI-002", title: "Second" }), item({ sourceId: "TPI-003", title: "Third" })], ada);
    const one = runAs(ada, () => makeSpec(a, "TPI-001")); const two = runAs(ada, () => makeSpec(a, "TPI-002")); const three = runAs(ada, () => makeSpec(a, "TPI-003"));
    runAs(ada, () => decideAutomationSuggestion(one.id, "rejected")); runAs(ada, () => decideAutomationSuggestion(two.id, "ignored"));
    assert.throws(() => runAs(ada, () => applySpecSuggestion(one.id)), /was rejected/);
    assert.throws(() => runAs(ada, () => applySpecSuggestion(two.id)), /was ignored/);
    runAs(ada, () => applySpecSuggestion(three.id));
    assert.ok(specFile(three.id).text);
    runAs(ada, () => decideAutomationSuggestion(three.id, "ignored"));
    assert.throws(() => specFile(three.id), /ignored, so it cannot be downloaded/);
    runAs(ada, () => decideAutomationSuggestion(three.id, "proposed"));
    assert.ok(specFile(three.id).text, "put back, the applied spec can be downloaded again");
  });

  it("a spec is not a test case: Apply for test cases refuses it, Apply for specs refuses a test-case suggestion, and no test case is made", () => {
    const { p, a, s } = prepared();
    assert.throws(() => runAs(ada, () => applyAutomationSuggestion(s.id)), /This is a spec suggestion/);
    const auto = runAs(ada, () => suggestAutomation(a, "TPI-001")).created[0];
    assert.throws(() => runAs(ada, () => applySpecSuggestion(auto.id)), /not a spec suggestion/);
    assert.throws(() => specFile(auto.id), /no spec file/);
    runAs(ada, () => applySpecSuggestion(s.id));
    assert.equal(count("SELECT COUNT(*) AS n FROM cases WHERE project_id = ?", p.id), 0);
  });
});

describe("with accounts, applying and deciding need an account in the database itself", () => {
  let carl!: AccountUser;
  before(() => { carl = user("Carl Check"); });

  it("the database refuses to mark a spec applied without an account, and so does the function; nothing changes", () => {
    const { a } = seeded([item()], carl);
    const s = runAs(carl, () => makeSpec(a));
    assert.throws(() => db.prepare("UPDATE automation_suggestions SET applied_at = datetime('now') WHERE id = ?").run(s.id), /Applying a spec needs a person with an account/);
    assert.throws(() => applySpecSuggestion(s.id), /needs a person with an account/);
    assert.throws(() => db.prepare("UPDATE automation_suggestions SET review_status = 'approved' WHERE id = ?").run(s.id), /needs a person with an account/);
    assert.deepEqual([row(s.id).applied_at, row(s.id).review_status], [null, "proposed"]);
    assert.throws(() => specFile(s.id), /Apply the spec first/);
  });

  it("the rule is not a person: asking leaves a proposal, nobody applied it, and the file cannot be downloaded", () => {
    const { a } = seeded([item()], carl);
    const s = runAs(carl, () => makeSpec(a));
    const r = row(s.id);
    assert.ok(r.review_status === "proposed" && !r.decided_by && r.applied_at === null && r.applied_by_user_id === null && !r.edited_by);
  });

  it("nothing in the server but the person's functions applies or decides, and the module writes no file, runs nothing and makes no network call", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "server", "automation.ts"), "utf8");
    const ask = src.slice(src.indexOf("export function suggestSpecForPlanItem"), src.indexOf("/**\n * A person asks for an automation suggestion for an approved requirement"));
    assert.ok(ask.length > 300);
    assert.doesNotMatch(ask, /review_status\s*=|decided_by|applied_at|edited_by\s*=/, "asking for a spec never decides, edits or applies");
    assert.doesNotMatch(src, /node:fs|writeFile|appendFile|createWriteStream|child_process|node:http|node:net|fetch\(|https?:\/\/|eval\(|new Function/, "no file, no process, no network, no eval");
    for (const f of ["audits.ts", "index.ts", "manualtests.ts", "ci.ts", "observations.ts", "auditplan.ts"]) {
      assert.doesNotMatch(readFileSync(join(import.meta.dirname, "..", "server", f), "utf8"), /automation_suggestions SET[^;`]*applied_at/, f);
    }
  });
});
