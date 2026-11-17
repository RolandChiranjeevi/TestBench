import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAs, type AccountUser } from "../server/accountcontext.ts";
import { AuditError } from "../server/auditcommon.ts";
import { db } from "../server/db.ts";
import { deleteCases } from "../server/deletion.ts";
import { cleanSpecName, createSpec, editSpec, getSpec, listSpecs, removeSpec, renameSpec, specFile, SPEC_LIMITS } from "../server/specs.ts";
import { makeCase, makeProject } from "./helpers.ts";

// Own specs (S2): a copy of a file in a person's repo. The name, the size, the revisions, the test case and the project. Nothing here runs or writes a spec.

let n = 0;
const proj = () => makeProject(`SP${++n}`, `Specs ${n}`);
const refused = (fn: () => unknown, status: number, text: RegExp) => assert.throws(fn, (e: unknown) => e instanceof AuditError && e.status === status && text.test(e.message), `${status} ${text}`);
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
const TEXT = 'import { test } from "@playwright/test";\ntest("x", async () => {});\n';
const make = (projectId: number, fileName = "login.spec.ts", over: Record<string, unknown> = {}) => createSpec(projectId, { fileName, text: TEXT, ...over });
const NUL = String.fromCharCode(0), LS = String.fromCharCode(0x2028), BIDI = String.fromCharCode(0x202e);

describe("the file name", () => {
  it("is a flat name of letters, digits, - and _ followed by exactly .spec.ts, and is trimmed", () => {
    for (const name of ["login.spec.ts", "Login-Flow_2.spec.ts", "a.spec.ts", "tc-10-checkout-with-a-coupon.spec.ts", "9.spec.ts", "a".repeat(SPEC_LIMITS.nameMax - 8) + ".spec.ts"]) assert.equal(cleanSpecName(name), name, name);
    assert.equal(cleanSpecName("  login.spec.ts \n"), "login.spec.ts");
  });

  it("is refused with a reason when it holds a folder, a dot, a space, a control character or the wrong ending, or is too long or not text", () => {
    const cases: [unknown, RegExp][] = [
      ["", /Give the spec a file name/], ["   ", /Give the spec a file name/], [7, /must be text/], [null, /must be text/],
      ["e2e/login.spec.ts", /folder/], ["..\\login.spec.ts", /folder/], ["../login.spec.ts", /folder/], ["/etc/x.spec.ts", /folder/],
      ["login.ts", /must end with \.spec\.ts/], ["login.spec.js", /must end with \.spec\.ts/], ["login.spec.ts.txt", /must end with \.spec\.ts/], ["login", /must end with \.spec\.ts/],
      ["login v2.spec.ts", /only letters, digits/], ["login.v2.spec.ts", /only letters, digits/], [".spec.ts", /only letters, digits/], ["-a.spec.ts", /only letters, digits/], ["_a.spec.ts", /only letters, digits/],
      [`log${NUL}in.spec.ts`, /only letters, digits/], ["log\nin.spec.ts", /only letters, digits/], ["lögin.spec.ts", /only letters, digits/], [`a${BIDI}.spec.ts`, /only letters, digits/], [`a${LS}.spec.ts`, /only letters, digits/],
      ["a".repeat(SPEC_LIMITS.nameMax - 7) + ".spec.ts", /at most 80/],
    ];
    for (const [name, re] of cases) refused(() => cleanSpecName(name), 400, re);
  });
});

describe("the text", () => {
  it("is at most 204 800 bytes in UTF-8, so a byte more is refused, and multi-byte letters count as their bytes", () => {
    const p = proj();
    assert.equal(make(p.id, "exact.spec.ts", { text: "a".repeat(SPEC_LIMITS.textBytes) }).size, SPEC_LIMITS.textBytes);
    refused(() => make(p.id, "over.spec.ts", { text: "a".repeat(SPEC_LIMITS.textBytes + 1) }), 400, /at most 200 kB/);
    assert.equal(make(p.id, "wide.spec.ts", { text: "é".repeat(SPEC_LIMITS.textBytes / 2) }).size, SPEC_LIMITS.textBytes, "two bytes each");
    refused(() => make(p.id, "wider.spec.ts", { text: "é".repeat(SPEC_LIMITS.textBytes / 2 + 1) }), 400, /at most 200 kB/);
    assert.equal(count("SELECT COUNT(*) AS n FROM specs WHERE project_id = ?", p.id), 2, "the refused ones were not kept");
  });

  it("is never empty, never a NUL character, and always text", () => {
    const p = proj();
    for (const text of ["", "  \n\t ", NUL]) refused(() => make(p.id, "a.spec.ts", { text }), 400, /needs its text|NUL/);
    refused(() => make(p.id, "a.spec.ts", { text: 5 }), 400, /must be text/);
    refused(() => make(p.id, "a.spec.ts", { text: undefined }), 400, /must be text/);
    assert.equal(count("SELECT COUNT(*) AS n FROM specs WHERE project_id = ?", p.id), 0);
  });

  it("is kept exactly as it was given, and downloaded as it is stored", () => {
    const p = proj();
    const weird = "  // leading spaces\r\n\ttabs and CRLF and trailing space \n\n\n";
    const s = make(p.id, "keep.spec.ts", { text: weird });
    assert.deepEqual(specFile(s.id), { fileName: "keep.spec.ts", text: weird });
    assert.equal(getSpec(s.id).text, weird);
  });
});

describe("making, changing, renaming and removing a spec", () => {
  it("a new spec is a draft with its text, its size and who made it, and its first revision", () => {
    const p = proj();
    const s = make(p.id);
    assert.deepEqual([s.fileName, s.status, s.testCase, s.size, s.projectId], ["login.spec.ts", "draft", null, Buffer.byteLength(TEXT), p.id]);
    assert.ok(s.createdBy && s.createdAt && s.updatedAt);
    assert.deepEqual(s.history.map((h) => [h.rev, h.kind]), [[1, "created"]]);
    refused(() => createSpec(999999, { fileName: "a.spec.ts", text: TEXT }), 404, /Project not found/);
    refused(() => make(p.id, "b.spec.ts", { status: "published" }), 400, /status must be one of/);
  });

  it("a file name is used once in a project, whatever the case of its letters, and another project may use it", () => {
    const p = proj(), q = proj();
    const a = make(p.id, "Login.spec.ts");
    refused(() => make(p.id, "login.spec.ts"), 409, /already exists/);
    refused(() => make(p.id, "LOGIN.spec.ts"), 409, /already exists/);
    const other = make(p.id, "other.spec.ts");
    refused(() => renameSpec(other.id, "LOGIN.spec.ts"), 409, /already exists/);
    assert.equal(getSpec(other.id).fileName, "other.spec.ts", "a refused rename changes nothing");
    assert.equal(make(q.id, "login.spec.ts").projectId, q.id);
    assert.equal(renameSpec(a.id, "LOGIN.spec.ts").spec.fileName, "LOGIN.spec.ts", "a spec may change the case of its own name");
  });

  it("the test case is optional, must be in the same project, and can be taken away", () => {
    const p = proj(), q = proj();
    const mine = makeCase(p.id, "Mine"), theirs = makeCase(q.id, "Theirs");
    const s = make(p.id, "case.spec.ts", { caseId: mine.id });
    assert.equal(s.testCase?.key, `${p.key}-${mine.number}`);
    refused(() => make(p.id, "x.spec.ts", { caseId: theirs.id }), 400, /not in this project/);
    refused(() => editSpec(s.id, { caseId: theirs.id }), 400, /not in this project/);
    refused(() => editSpec(s.id, { caseId: 1.5 }), 400, /whole number/);
    refused(() => editSpec(s.id, { caseId: 999999 }), 400, /not in this project/);
    assert.equal(editSpec(s.id, { caseId: null }).spec.testCase, null);
    assert.equal(editSpec(s.id, { caseId: mine.id }).spec.testCase?.id, mine.id);
  });

  it("each kind of change makes its own revision: edited, status, case and renamed, with who and what; several at once make several", () => {
    const p = proj(); const c = makeCase(p.id, "C");
    const s = make(p.id);
    editSpec(s.id, { text: `${TEXT}// more\n` });
    editSpec(s.id, { status: "ready" });
    editSpec(s.id, { caseId: c.id });
    renameSpec(s.id, "checkout.spec.ts");
    assert.deepEqual(getSpec(s.id).history.map((h) => h.kind), ["created", "edited", "status", "case", "renamed"]);
    editSpec(s.id, { text: "// all\n", status: "draft", caseId: null });
    assert.deepEqual(getSpec(s.id).history.slice(5).map((h) => h.kind), ["edited", "status", "case"]);
    const h = getSpec(s.id).history;
    assert.equal(h.find((x) => x.kind === "status")!.note, "draft to ready");
    assert.equal(h.find((x) => x.kind === "renamed")!.note, "login.spec.ts to checkout.spec.ts");
    assert.ok(h.every((x) => x.actor && x.at && x.rev > 0));
    assert.ok(h.every((x) => !("text" in x.snapshot)), "the history sent to the screen carries no text");
  });

  it("a change that changes nothing makes no revision and does not touch who and when", () => {
    const p = proj(); const c = makeCase(p.id, "C");
    const s = make(p.id, "same.spec.ts", { caseId: c.id });
    db.prepare("UPDATE specs SET updated_at = '2020-01-01 00:00:00', updated_by = 'Earlier' WHERE id = ?").run(s.id);
    const before = JSON.stringify(getSpec(s.id));
    assert.deepEqual(editSpec(s.id, { text: TEXT, status: "draft", caseId: c.id }).changed, []);
    assert.deepEqual(editSpec(s.id, {}).changed, []);
    renameSpec(s.id, "same.spec.ts");
    assert.equal(JSON.stringify(getSpec(s.id)), before);
    assert.equal(getSpec(s.id).history.length, 1);
    assert.equal(getSpec(s.id).updatedBy, "Earlier");
  });

  it("an edit that is refused changes nothing at all", () => {
    const p = proj();
    const s = make(p.id);
    refused(() => editSpec(s.id, { text: "", status: "ready" }), 400, /needs its text/);
    refused(() => editSpec(s.id, { status: "nope" }), 400, /status must be one of/);
    refused(() => editSpec(999999, { status: "ready" }), 404, /Spec not found/);
    assert.deepEqual([getSpec(s.id).status, getSpec(s.id).history.length], ["draft", 1]);
  });

  it("the list has no text but gives each spec's size, newest change first", () => {
    const p = proj();
    const a = make(p.id, "a.spec.ts");
    make(p.id, "b.spec.ts", { text: "x".repeat(1000) });
    db.prepare("UPDATE specs SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(a.id);
    const list = listSpecs(p.id);
    assert.deepEqual(list.map((x) => x.fileName), ["b.spec.ts", "a.spec.ts"]);
    assert.deepEqual(list.map((x) => x.size), [1000, Buffer.byteLength(TEXT)]);
    assert.ok(list.every((x) => !("text" in x)));
    refused(() => listSpecs(999999), 404, /Project not found/);
  });

  it("removing a spec removes its history, and only its", () => {
    const p = proj();
    const a = make(p.id, "a.spec.ts"), b = make(p.id, "b.spec.ts");
    editSpec(a.id, { status: "ready" });
    assert.deepEqual(removeSpec(a.id), { id: a.id, projectId: p.id, fileName: "a.spec.ts" });
    assert.equal(count("SELECT COUNT(*) AS n FROM spec_revisions WHERE spec_id = ?", a.id), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM spec_revisions WHERE spec_id = ?", b.id), 1);
    refused(() => getSpec(a.id), 404, /Spec not found/);
    refused(() => removeSpec(a.id), 404, /Spec not found/);
  });

  it("a project has at most 500 specs", () => {
    const p = proj();
    const ins = db.prepare("INSERT INTO specs (project_id, file_name, text) VALUES (?, ?, 'x')");
    db.transaction(() => { for (let i = 0; i < SPEC_LIMITS.perProject; i++) ins.run(p.id, `s${i}.spec.ts`); })();
    refused(() => make(p.id, "one-too-many.spec.ts"), 409, /at most 500 specs/);
    assert.equal(make(proj().id, "other-project.spec.ts").fileName, "other-project.spec.ts");
  });
});

describe("when a test case or a project goes", () => {
  it("a test case that goes leaves its specs, with no test case (one, many at once)", () => {
    const p = proj();
    const a = makeCase(p.id, "A"), b = makeCase(p.id, "B");
    const sa = make(p.id, "a.spec.ts", { caseId: a.id }), sb = make(p.id, "b.spec.ts", { caseId: b.id });
    db.prepare("DELETE FROM cases WHERE id = ?").run(a.id);
    assert.deepEqual([getSpec(sa.id).testCase, getSpec(sb.id).testCase?.id], [null, b.id]);
    deleteCases(p.id, [b.id]);
    assert.equal(getSpec(sb.id).testCase, null);
    assert.equal(count("SELECT COUNT(*) AS n FROM specs WHERE project_id = ?", p.id), 2, "no spec went with a case");
  });

  it("a project that goes takes its specs and their history, and nobody else's", () => {
    const p = proj(), q = proj();
    const s = make(p.id); editSpec(s.id, { status: "ready" });
    make(q.id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(p.id);
    assert.equal(count("SELECT COUNT(*) AS n FROM specs WHERE project_id = ?", p.id), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM spec_revisions WHERE spec_id = ?", s.id), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM specs WHERE project_id = ?", q.id), 1);
  });
});

// Last in the file: it adds an account, and from then on every write needs a person.
describe("with accounts, a person is behind every write", () => {
  const user = (name: string): AccountUser => {
    const id = (db.prepare("INSERT INTO users (email, name, password_hash) VALUES (?, ?, 'h') RETURNING id").get(`${name.toLowerCase().replace(/\W/g, "")}@x.io`, name) as { id: number }).id;
    return { id, email: "", name, isOwner: false, disabledAt: null, createdAt: "", lastLoginAt: null };
  };
  const noPerson = (fn: () => unknown) => assert.throws(fn, /needs a person with an account/);

  it("a test case that goes still works for a spec made before accounts existed, because that is not a person's change", () => {
    const p = proj(); const c = makeCase(p.id, "Early");
    const early = make(p.id, "early.spec.ts", { caseId: c.id }); // no account yet: nobody behind it
    assert.equal(getSpec(early.id).testCase?.id, c.id);
    user("Ola Owner");
    db.prepare("DELETE FROM cases WHERE id = ?").run(c.id);
    assert.equal(getSpec(early.id).testCase, null, "the case went, and nothing stopped it");
  });

  it("the database refuses a spec, a change or a rename that has no person behind it, and accepts one that has", () => {
    const p = proj();
    const ada = user("Ada Spec");
    noPerson(() => make(p.id, "nobody.spec.ts"));
    noPerson(() => db.prepare("INSERT INTO specs (project_id, file_name, text) VALUES (?, 'raw.spec.ts', 'x')").run(p.id));
    assert.equal(count("SELECT COUNT(*) AS n FROM specs WHERE project_id = ?", p.id), 0, "nothing was made");
    const s = runAs(ada, () => make(p.id, "ada.spec.ts"));
    const row = db.prepare("SELECT created_by, created_by_user_id AS c, updated_by_user_id AS u FROM specs WHERE id = ?").get(s.id) as { created_by: string; c: number; u: number };
    assert.deepEqual([row.created_by, row.c, row.u], ["Ada Spec", ada.id, ada.id]);
    assert.equal(getSpec(s.id).history[0].actor, "Ada Spec");
    noPerson(() => editSpec(s.id, { status: "ready" }));
    noPerson(() => renameSpec(s.id, "renamed.spec.ts"));
    noPerson(() => db.prepare("UPDATE specs SET status = 'ready', updated_by_user_id = NULL WHERE id = ?").run(s.id));
    assert.deepEqual([getSpec(s.id).status, getSpec(s.id).fileName, getSpec(s.id).history.length], ["draft", "ada.spec.ts", 1], "nothing changed");
    assert.equal(runAs(ada, () => editSpec(s.id, { status: "ready" })).spec.status, "ready");
    assert.equal(runAs(ada, () => renameSpec(s.id, "renamed.spec.ts")).spec.fileName, "renamed.spec.ts");
  });
});
