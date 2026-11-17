import "./env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { AuditError } from "../server/auditcommon.ts";
import { db } from "../server/db.ts";
import { importReport } from "../server/importers/import.ts";
import { parseReport } from "../server/importers/parse.ts";
import { suggestSpecFromRequirement } from "../server/automation.ts";
import { COMPARE_EXACT_CELLS, NOTE_MAX, RESULT_TITLES_MAX, compareSpec, createSpec, editSpec, fileMatchesSpec, getSpec, lineChanges, listSpecs, SPEC_LIMITS } from "../server/specs.ts";
import { makeCase, makeProject } from "./helpers.ts";

// S3: what imported runs say about a spec's file, the comparison with the person's own copy of the file, a note on a change of the text, and the tag @REQ-n on a requirement's spec.
// Nothing here runs a spec. The comparison stores and logs nothing.

let n = 0;
const proj = () => makeProject(`SR${++n}`, `Spec results ${n}`);
const refused = (fn: () => unknown, status: number, text: RegExp) => assert.throws(fn, (e: unknown) => e instanceof AuditError && e.status === status && text.test(e.message), `${status} ${text}`);
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const TEXT = 'import { test } from "@playwright/test";\ntest("x", async () => {});\n';
const make = (projectId: number, fileName = "login.spec.ts", text = TEXT) => createSpec(projectId, { fileName, text });
let t = 0;
/** An imported automated test, as the import leaves it. */
const imported = (projectId: number, file: string, status: string | null, over: { title?: string; seen?: string; caseId?: number | null } = {}) => {
  const title = over.title ?? `test ${++t}`;
  return db.prepare("INSERT INTO automated_tests (project_id, framework, file, title, full_name, last_status, last_seen, case_id) VALUES (?, 'playwright', ?, ?, ?, ?, ?, ?)")
    .run(projectId, file, title, `${file} > ${title} #${++t}`, status, over.seen ?? "2026-11-01 10:00:00", over.caseId ?? null);
};

describe("which imported tests belong to a spec", () => {
  it("those whose file is the spec's name, or ends in /<name>, whatever the case of the letters and the kind of slash", () => {
    const yes = ["login.spec.ts", "e2e/login.spec.ts", "a/b/login.spec.ts", "E2E\\Login.SPEC.ts", "LOGIN.spec.ts", "/abs/path/login.spec.ts"];
    const no = ["", "mylogin.spec.ts", "login.spec.ts.bak", "login.spec.tsx", "e2e/logins.spec.ts", "e2e/login-spec.ts", "e2e/login.spec.ts/x", "xlogin.spec.ts"];
    for (const f of yes) assert.equal(fileMatchesSpec(f, "login.spec.ts"), true, f);
    for (const f of no) assert.equal(fileMatchesSpec(f, "login.spec.ts"), false, JSON.stringify(f));
  });

  it("only the tests of the spec's own project, and a spec with none has an empty result", () => {
    const p = proj(), q = proj();
    const s = make(p.id);
    const other = make(q.id);
    imported(q.id, "login.spec.ts", "failed");
    assert.deepEqual([s.results.tests, s.results.lastSeen, s.results.files, s.results.ambiguous], [0, null, [], false]);
    assert.equal(getSpec(s.id).results.tests, 0, "another project's test is not this spec's");
    assert.equal(getSpec(other.id).results.tests, 1);
    imported(p.id, "e2e/login.spec.ts", "passed");
    assert.equal(getSpec(s.id).results.tests, 1);
  });

  it("counts each status, and puts what has no known status under other", () => {
    const p = proj(); const s = make(p.id);
    for (const st of ["passed", "passed", "failed", "skipped", "blocked", null, "untested"]) imported(p.id, "login.spec.ts", st);
    const r = getSpec(s.id).results;
    assert.deepEqual([r.tests, r.passed, r.failed, r.skipped, r.blocked, r.other], [7, 2, 1, 1, 1, 2]);
    assert.equal(listSpecs(p.id)[0].results.failed, 1, "the list says the same");
  });

  it("says when a test was last seen: the latest of them", () => {
    const p = proj(); const s = make(p.id);
    imported(p.id, "login.spec.ts", "passed", { seen: "2026-11-01 10:00:00" });
    imported(p.id, "login.spec.ts", "failed", { seen: "2026-11-09 08:30:00" });
    imported(p.id, "login.spec.ts", "passed", { seen: "2026-10-20 23:59:59" });
    assert.equal(getSpec(s.id).results.lastSeen, "2026-11-09 08:30:00");
  });

  it("lists every matching file, and says so when there is more than one", () => {
    const p = proj(); const s = make(p.id);
    imported(p.id, "b/login.spec.ts", "passed"); imported(p.id, "a/login.spec.ts", "failed"); imported(p.id, "a/login.spec.ts", "passed");
    const r = getSpec(s.id).results;
    assert.deepEqual([r.files, r.ambiguous, r.tests, r.passed, r.failed], [["a/login.spec.ts", "b/login.spec.ts"], true, 3, 2, 1]);
    imported(p.id, "A/Login.spec.ts", "passed");
    assert.equal(getSpec(s.id).results.files.length, 3, "a file spelled in another case is another file, listed as it was imported");
  });

  it("shows at most 20 test titles, the failing ones first, with the test case each is linked to, and says how many more there are", () => {
    const p = proj(); const s = make(p.id);
    const c = makeCase(p.id, "A case");
    for (let i = 0; i < 25; i++) imported(p.id, "login.spec.ts", i === 24 ? "failed" : "passed", { title: `title ${String(i).padStart(2, "0")}`, caseId: i === 24 ? c.id : null });
    const g = getSpec(s.id);
    assert.equal(g.resultTests.length, RESULT_TITLES_MAX);
    assert.equal(g.moreResultTests, 5);
    assert.deepEqual([g.resultTests[0].title, g.resultTests[0].status, g.resultTests[0].testCase?.key], ["title 24", "failed", `${p.key}-${c.number}`]);
    assert.deepEqual(g.resultTests.slice(1, 4).map((x) => x.title), ["title 00", "title 01", "title 02"]);
    assert.equal(g.results.tests, 25, "the counts are of all of them");
    assert.equal("resultTests" in listSpecs(p.id)[0], false, "the list has no titles");
  });

  it("follows a real import: the spec's card has the tests of the report, and a later import changes their status", () => {
    const p = proj(); const s = make(p.id, "checkout.spec.ts");
    const report = (status: string) => JSON.stringify({
      config: { rootDir: "/repo/e2e" }, stats: { startTime: "2026-01-02T03:04:05.000Z" },
      suites: [{ title: "checkout.spec.ts", file: "checkout.spec.ts", specs: [{ title: "pays", file: "checkout.spec.ts", line: 3, column: 1, tests: [{ projectName: "chromium", status: status === "passed" ? "expected" : "unexpected", results: [{ status, duration: 5, retry: 0 }] }] }] }],
    });
    importReport(parseReport(report("failed")), { projectId: p.id, source: "upload", title: "one" });
    assert.deepEqual([getSpec(s.id).results.failed, getSpec(s.id).results.files], [1, ["checkout.spec.ts"]]);
    importReport(parseReport(report("passed")), { projectId: p.id, source: "upload", title: "two" });
    assert.deepEqual([getSpec(s.id).results.failed, getSpec(s.id).results.passed], [0, 1]);
  });
});

describe("comparing a spec with the person's own file", () => {
  const cmp = (id: number, text: string, fileName?: string) => compareSpec(id, { text, fileName });

  it("says same for the same text, with both hashes and sizes", () => {
    const p = proj(); const s = make(p.id);
    const r = cmp(s.id, TEXT);
    assert.deepEqual([r.outcome, r.added, r.removed, r.approximate, r.warning], ["same", 0, 0, false, null]);
    assert.deepEqual([r.stored.sha256, r.uploaded.sha256], [sha(TEXT), sha(TEXT)]);
    assert.deepEqual([r.stored.bytes, r.uploaded.bytes], [Buffer.byteLength(TEXT), Buffer.byteLength(TEXT)]);
  });

  it("says same except line endings when only CRLF or CR, or the newlines at the very end, differ", () => {
    const p = proj(); const s = make(p.id, "a.spec.ts", "one\ntwo\nthree\n");
    for (const other of ["one\r\ntwo\r\nthree\r\n", "one\rtwo\rthree\r", "one\ntwo\nthree", "one\ntwo\nthree\n\n\n", "one\r\ntwo\nthree\n"]) {
      const r = cmp(s.id, other);
      assert.equal(r.outcome, "same except line endings", JSON.stringify(other));
      assert.notEqual(r.stored.sha256, r.uploaded.sha256, "the bytes do differ");
      assert.deepEqual([r.added, r.removed], [0, 0]);
    }
  });

  it("says differs for anything else, and counts the lines added and removed", () => {
    const p = proj(); const s = make(p.id, "a.spec.ts", "a\nb\nc\n");
    assert.deepEqual((({ outcome, added, removed, approximate }) => [outcome, added, removed, approximate])(cmp(s.id, "a\nx\nc\nd\n")), ["differs", 2, 1, false]);
    assert.deepEqual((({ added, removed }) => [added, removed])(cmp(s.id, "a\nb\n")), [0, 1], "a line removed");
    assert.deepEqual((({ added, removed }) => [added, removed])(cmp(s.id, "z\na\nb\nc\n")), [1, 0], "a line added at the start");
    assert.equal(cmp(s.id, "a\nb \nc\n").outcome, "differs", "a space at the end of a line is a difference");
    assert.equal(cmp(s.id, "a\n\nb\nc\n").outcome, "differs", "an empty line in the middle is a difference");
    assert.equal(cmp(s.id, "A\nb\nc\n").outcome, "differs", "the case of a letter is a difference");
    assert.equal(cmp(s.id, "\na\nb\nc\n").outcome, "differs", "a new line at the very start is a difference");
    assert.equal(cmp(s.id, "a\nb\nc \n").outcome, "differs", "a space at the end of the last line is a difference");
    assert.equal(cmp(s.id, "a\nb\nc\t").outcome, "differs", "a tab at the end is a difference");
  });

  it("counts exactly up to a limit, and above it says that the count is approximate", () => {
    assert.deepEqual(lineChanges("a\nb\nc", "a\nx\nc"), { added: 1, removed: 1, approximate: false });
    const rows = Math.ceil(Math.sqrt(COMPARE_EXACT_CELLS)) + 50;
    const from = Array.from({ length: rows }, (_, i) => `old ${i}`).join("\n");
    const to = Array.from({ length: rows }, (_, i) => (i < 10 ? `old ${i}` : `new ${i}`)).join("\n");
    const started = Date.now();
    const big = lineChanges(from, to);
    assert.ok(Date.now() - started < 3000, "it does not keep the server busy");
    assert.deepEqual([big.approximate, big.added, big.removed], [true, rows - 10, rows - 10]);
  });

  it("refuses an empty text, a text with a NUL character, a text over 204 800 bytes and what is not text; and takes exactly 204 800", () => {
    const p = proj(); const s = make(p.id);
    refused(() => cmp(s.id, ""), 400, /file is empty/);
    refused(() => cmp(s.id, " \n\t "), 400, /file is empty/);
    refused(() => cmp(s.id, `abc${String.fromCharCode(0)}def`), 400, /NUL/);
    refused(() => cmp(s.id, "a".repeat(SPEC_LIMITS.textBytes + 1)), 400, /at most 200 kB/);
    refused(() => compareSpec(s.id, { text: 5 }), 400, /must be text/);
    refused(() => compareSpec(s.id, { text: undefined }), 400, /must be text/);
    assert.equal(cmp(s.id, "a".repeat(SPEC_LIMITS.textBytes)).outcome, "differs");
    refused(() => cmp(999999, TEXT), 404, /Spec not found/);
  });

  it("warns, and still compares, when the file has another name than the spec; the path and the case of the letters do not count", () => {
    const p = proj(); const s = make(p.id, "login.spec.ts");
    const w = cmp(s.id, TEXT, "other.spec.ts");
    assert.match(w.warning ?? "", /called other\.spec\.ts.*called login\.spec\.ts/);
    assert.equal(w.outcome, "same");
    for (const name of ["login.spec.ts", "e2e/Login.SPEC.ts", "C:\\repo\\e2e\\login.spec.ts", "", undefined]) assert.equal(cmp(s.id, TEXT, name).warning, null, String(name));
    refused(() => compareSpec(s.id, { text: TEXT, fileName: "x".repeat(301) }), 400, /file name must be text/);
    refused(() => compareSpec(s.id, { text: TEXT, fileName: 7 }), 400, /file name must be text/);
  });

  it("stores nothing: the spec, its history and who changed it are as they were", () => {
    const p = proj(); const s = make(p.id);
    db.prepare("UPDATE specs SET updated_at = '2020-01-01 00:00:00', updated_by = 'Earlier' WHERE id = ?").run(s.id);
    const before = JSON.stringify(getSpec(s.id));
    const rows = count("SELECT COUNT(*) AS n FROM spec_revisions") + count("SELECT COUNT(*) AS n FROM specs");
    for (const text of [TEXT, "other text\n", "a\r\nb"]) cmp(s.id, text, "x.spec.ts");
    assert.equal(JSON.stringify(getSpec(s.id)), before);
    assert.equal(count("SELECT COUNT(*) AS n FROM spec_revisions") + count("SELECT COUNT(*) AS n FROM specs"), rows);
    assert.equal(count("SELECT COUNT(*) AS n FROM audit_log"), 0, "and it writes nothing to the audit log");
  });
});

describe("a note on a change of the text", () => {
  it("is kept in the revision of that change, trimmed, and shown in the history", () => {
    const p = proj(); const s = make(p.id);
    const g = editSpec(s.id, { text: `${TEXT}// from the repo\n`, note: "  Updated from my repo  " }).spec;
    const edited = g.history.find((h) => h.kind === "edited")!;
    assert.equal(edited.note, "Updated from my repo");
    assert.equal(g.history.find((h) => h.kind === "created")!.note, "");
    assert.equal(editSpec(s.id, { text: `${TEXT}// again\n`, note: "" }).spec.history.at(-1)!.note, "", "an empty note is no note");
  });

  it("is at most 200 characters, and text; and it goes only with a change of the text", () => {
    const p = proj(); const s = make(p.id);
    assert.equal(editSpec(s.id, { text: `${TEXT}// a\n`, note: "x".repeat(NOTE_MAX) }).spec.history.at(-1)!.note.length, NOTE_MAX);
    refused(() => editSpec(s.id, { text: `${TEXT}// b\n`, note: "x".repeat(NOTE_MAX + 1) }), 400, /at most 200 characters/);
    refused(() => editSpec(s.id, { text: `${TEXT}// b\n`, note: 7 }), 400, /note must be text/);
    refused(() => editSpec(s.id, { status: "ready", note: "no text changed" }), 400, /goes with a change of the text/);
    refused(() => editSpec(s.id, { text: getSpec(s.id).text, note: "same text" }), 400, /goes with a change of the text/);
    assert.deepEqual([getSpec(s.id).status, getSpec(s.id).history.length], ["draft", 2], "none of the refused ones changed anything");
  });

  it("is made by the change and not by the comparison: comparing leaves no note, using the repo's version leaves one", () => {
    const p = proj(); const s = make(p.id, "a.spec.ts", "old\n");
    const r = compareSpec(s.id, { text: "new\n" });
    assert.equal(r.outcome, "differs");
    assert.equal(getSpec(s.id).history.length, 1);
    editSpec(s.id, { text: "new\n", note: "Updated from my repo" });
    const h = getSpec(s.id).history;
    assert.deepEqual([h.length, h.at(-1)!.kind, h.at(-1)!.note], [2, "edited", "Updated from my repo"]);
    assert.equal(compareSpec(s.id, { text: "new\n" }).outcome, "same", "and now the copy is the repo's");
  });
});

describe("@REQ-n on a requirement's spec", () => {
  const fields = { title: "Todo can be added", description: "A user.", acceptanceCriteria: "- The text is shown", kind: "functional", priority: "high", wcag: [], viewports: [] };
  const titleOf = (text: string) => JSON.parse(/^ {2}test\((".*"), async/m.exec(text)![1]) as string;
  const report = (title: string, file = "x.spec.ts") => JSON.stringify({
    config: { rootDir: "/repo/e2e" }, stats: { startTime: "2026-01-02T03:04:05.000Z" },
    suites: [{ title: file, file, specs: [{ title, file, line: 3, column: 1, tests: [{ projectName: "chromium", status: "expected", results: [{ status: "passed", duration: 5, retry: 0 }] }] }] }],
  });

  it("is in the title of a new draft, which a draft already made keeps as it was", () => {
    const made = suggestSpecFromRequirement(fields, 7);
    assert.ok("content" in made);
    assert.equal(titleOf(made.content.artifactText!), "Todo can be added @REQ-7");
    const stored = "// an earlier draft\ntest(\"Todo can be added\", async () => {});\n";
    const p = proj(); const spec = make(p.id, "earlier.spec.ts", stored);
    assert.equal(getSpec(spec.id).text, stored, "what was stored is not touched");
  });

  it("covers the requirement only once the test is linked to a test case: the import reads the tag only then", () => {
    const p = proj();
    const reqId = (db.prepare("INSERT INTO requirements (project_id, number, title, status, acceptance_criteria) VALUES (?, 3, 'R', 'approved', '- ok') RETURNING id").get(p.id) as { id: number }).id;
    const c = makeCase(p.id, "The case");
    const made = suggestSpecFromRequirement(fields, 3);
    assert.ok("content" in made);
    const title = titleOf(made.content.artifactText!);
    assert.equal(title, "Todo can be added @REQ-3");
    const links = () => count("SELECT COUNT(*) AS n FROM requirement_cases WHERE requirement_id = ?", reqId);
    importReport(parseReport(report(title, made.fileName)), { projectId: p.id, source: "upload", title: "first" });
    const test = db.prepare("SELECT id, case_id FROM automated_tests WHERE project_id = ?").get(p.id) as { id: number; case_id: number | null };
    assert.equal(test.case_id, null, "the tag names no test case");
    assert.equal(links(), 0, "so the requirement is not covered");
    db.prepare("UPDATE automated_tests SET case_id = ? WHERE id = ?").run(c.id, test.id);
    importReport(parseReport(report(title, made.fileName)), { projectId: p.id, source: "upload", title: "second" });
    assert.equal(links(), 1, "linked to a test case, the tag covers the requirement");
    assert.equal(count("SELECT COUNT(*) AS n FROM requirement_cases WHERE requirement_id = ? AND case_id = ?", reqId, c.id), 1);
  });
});
