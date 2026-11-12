import "./env.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { runAs, type AccountUser } from "../server/accountcontext.ts";
import { db } from "../server/db.ts";
import { getBugReport } from "../server/audits.ts";
import { applyBugDraft, buildBugDraft, bugDraftScreenshot, checkScreenshot, cleanMultiline, createBugDraft, decideBugDraft, editBugDraft, getBugDraft, listBugDrafts, MAX_SCREENSHOT_BYTES } from "../server/bugdrafts.ts";
import { makeProject } from "./helpers.ts";

// G: a screenshot and a short note become a draft bug report by a fixed rule. A person edits and decides it; Apply makes a bug report that stays proposed, with the picture attached.
// The picture is checked by its first bytes and is never analysed. Nothing is run, nothing is generated, and nothing leaves the server.

let n = 0;
const proj = () => makeProject(`BD${++n}`, `Bug draft ${n}`);
const user = (name: string): AccountUser => {
  const id = (db.prepare("INSERT INTO users (email, name, password_hash) VALUES (?, ?, 'h') RETURNING id").get(`${name.toLowerCase().replace(/\W/g, "")}@x.io`, name) as { id: number }).id;
  return { id, email: "", name, isOwner: false, disabledAt: null, createdAt: "", lastLoginAt: null };
};
const shot = (over: Record<string, unknown> = {}) => ({ storedName: `draft-test-${++n}.png`, filename: "Screen Shot.png", mime: "image/png", size: 1234, sha256: "ab".repeat(32), ...over });
const row = (id: number) => db.prepare("SELECT * FROM bug_drafts WHERE id = ?").get(id) as Record<string, any>;
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
const NOTE = "The cart total is wrong after removing an item\nI removed the second item and the total stayed the same.";
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

// Runs first on purpose: there is no account yet, so this is what a single-person install does.
describe("without accounts (nothing changes for a single-person install)", () => {
  it("a person can make, edit, approve and apply a draft, and no account is saved", () => {
    const p = proj();
    const d = createBugDraft(p.id, NOTE, shot());
    editBugDraft(d.id, { title: "Cart total is wrong" });
    decideBugDraft(d.id, "approved");
    const { bugId } = applyBugDraft(d.id);
    assert.ok(bugId);
    const r = row(d.id);
    assert.deepEqual([r.review_status, r.created_by_user_id, r.edited_by_user_id, r.decided_by_user_id, r.applied_by_user_id], ["approved", null, null, null, null]);
  });
});

describe("the rule", () => {
  it("makes the same draft from the same note: the title is the first line, the steps are a skeleton of TODO lines, expected and actual are TODO, the description is the whole note and says the picture was not analysed", () => {
    const a = buildBugDraft(NOTE), b = buildBugDraft(NOTE);
    assert.deepEqual(a, b);
    assert.ok("content" in a);
    assert.equal(a.content.title, "The cart total is wrong after removing an item");
    assert.deepEqual(a.content.steps, ["TODO: open the page or screen where the screenshot was taken", "TODO: describe what you did, step by step, until the problem appeared"]);
    assert.equal(a.content.expected, "TODO: what you expected to happen");
    assert.equal(a.content.actual, "TODO: what happened instead (see the screenshot)");
    assert.equal(a.content.description, `${NOTE}\n\nEvidence: screenshot attached. Not analysed.`);
  });

  it("cleans the note: invisible and control characters go, a long first line is clipped, line breaks stay in the description", () => {
    const evil = "Broken \u202etitle\u202c\u0000 with\u2028tricks\n" + "x".repeat(400);
    const r = buildBugDraft(evil);
    assert.ok("content" in r);
    assert.doesNotMatch(r.content.title + r.content.description, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/);
    assert.match(r.content.title, /^Broken title with tricks$/);
    assert.ok(buildBugDraft("y".repeat(1000)) && (buildBugDraft("y".repeat(1000)) as { content: { title: string } }).content.title.length <= 300);
    assert.equal(cleanMultiline("a\r\nb\r\n\r\n\r\n\r\nc  \n"), "a\nb\n\nc");
  });

  it("without a note, or with an enormous one, nothing is made, and the message says why", () => {
    assert.deepEqual(buildBugDraft(" \n\t "), { reason: "A note is needed: write a few words about what the screenshot shows." });
    assert.match((buildBugDraft("n".repeat(4001)) as { reason: string }).reason, /too long/);
  });
});

describe("the screenshot", () => {
  it("is accepted by its first bytes: png, jpg, gif and webp, with the type found there and not the one the browser says", () => {
    assert.deepEqual(checkScreenshot(png), { ext: "png", mime: "image/png", size: png.length, sha256: checkScreenshot(png).sha256 });
    assert.equal(checkScreenshot(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])).mime, "image/jpeg");
    assert.equal(checkScreenshot(Buffer.from("GIF89a....")).mime, "image/gif");
    assert.equal(checkScreenshot(Buffer.from("RIFF\u0001\u0000\u0000\u0000WEBPVP8 ", "latin1")).mime, "image/webp");
    assert.match(checkScreenshot(png).sha256, /^[0-9a-f]{64}$/);
  });

  it("refuses what is not a picture, whatever it is called: text, svg, html, a zip, an empty file, nothing", () => {
    for (const bytes of [Buffer.from("just text"), Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"), Buffer.from("<html><script>1</script></html>"), Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(0)]) {
      assert.throws(() => checkScreenshot(bytes), /must be a png, jpg, webp or gif|screenshot is needed/);
    }
    assert.throws(() => checkScreenshot(null), /screenshot is needed/);
  });

  it("refuses a picture over 5 MB, and one the upload cut short", () => {
    assert.throws(() => checkScreenshot(Buffer.concat([png, Buffer.alloc(MAX_SCREENSHOT_BYTES)])), /too large/);
    assert.throws(() => checkScreenshot(png, true), /too large/);
    assert.equal(checkScreenshot(Buffer.concat([png, Buffer.alloc(MAX_SCREENSHOT_BYTES - png.length)])).size, MAX_SCREENSHOT_BYTES);
  });
});

describe("a draft", () => {
  let tina!: AccountUser;
  before(() => { tina = user("Tina Tester"); });

  it("is the rule's: Suggested by rule (never AI), proposed, numbered SCR-n in its project, with the picture, and the history says the rule made it", () => {
    const p = proj(), q = proj();
    const a = runAs(tina, () => createBugDraft(p.id, NOTE, shot())), b = runAs(tina, () => createBugDraft(p.id, "Second", shot())), c = runAs(tina, () => createBugDraft(q.id, "Other project", shot()));
    assert.deepEqual([a.label, b.label, c.label], ["SCR-1", "SCR-2", "SCR-1"]);
    assert.deepEqual([a.origin, a.suggestedBy, a.status, a.createdBy, a.decidedBy, a.appliedAt, a.bug], ["rule", "Suggested by rule", "proposed", "Tina Tester", null, null, null]);
    assert.doesNotMatch(JSON.stringify(a), /\bAI\b/);
    assert.deepEqual(a.history.map((h) => [h.kind, h.byRule, h.actor]), [["suggested", true, "Rule: bug draft from note"]]);
    assert.deepEqual([a.screenshot.filename, a.screenshot.mime, a.screenshot.url], ["Screen Shot.png", "image/png", `/api/bug-drafts/${a.id}/screenshot`]);
    assert.deepEqual(listBugDrafts(p.id).map((d) => d.label), ["SCR-1", "SCR-2"]);
    assert.equal(row(a.id).created_by_user_id, tina.id);
  });

  it("an unknown project is 404, and an empty note is 400; nothing is stored in either case", () => {
    const p = proj();
    assert.throws(() => createBugDraft(999999, NOTE, shot()), /Project not found/);
    assert.throws(() => createBugDraft(p.id, "  ", shot()), /A note is needed/);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_drafts WHERE project_id = ?", p.id), 0);
  });

  it("a person's edit makes it theirs (a draft), is kept in the history with what changed, and an edit with no change makes no entry", () => {
    const p = proj();
    const d = runAs(tina, () => createBugDraft(p.id, NOTE, shot()));
    runAs(tina, () => editBugDraft(d.id, { title: "  Cart total ignores removals  ", expected: "The total drops by the price of the removed item" }));
    const e = getBugDraft(d.id);
    assert.deepEqual([e.status, e.editedBy, e.title, e.expected], ["draft", "Tina Tester", "Cart total ignores removals", "The total drops by the price of the removed item"]);
    assert.deepEqual(e.history.map((h) => h.kind), ["suggested", "edited"]);
    assert.deepEqual(e.history[1].changes.map((c) => c.field), ["Title", "Expected"]);
    assert.equal(e.history[1].note, "Taken over from the rule's draft");
    runAs(tina, () => editBugDraft(d.id, { title: "Cart total ignores removals" }));
    assert.equal(getBugDraft(d.id).history.length, 2);
    assert.equal(row(d.id).edited_by_user_id, tina.id);
  });

  it("must keep a title and a step, and keeps its limits", () => {
    const p = proj();
    const d = runAs(tina, () => createBugDraft(p.id, NOTE, shot()));
    assert.throws(() => runAs(tina, () => editBugDraft(d.id, { title: "  " })), /needs a title/);
    assert.throws(() => runAs(tina, () => editBugDraft(d.id, { steps: [" ", ""] })), /at least one step/);
    assert.throws(() => runAs(tina, () => editBugDraft(d.id, { steps: Array.from({ length: 31 }, (_, i) => `s${i}`) })), /at most 30 steps/);
    assert.throws(() => runAs(tina, () => editBugDraft(d.id, { description: "d".repeat(8001) })), /too long/);
    assert.equal(getBugDraft(d.id).history.length, 1, "nothing was changed");
  });

  it("approve, reject and ignore record who and when, put back works only for an ignored one, and everything is in the history in order", () => {
    const p = proj();
    const d = runAs(tina, () => createBugDraft(p.id, NOTE, shot()));
    runAs(tina, () => decideBugDraft(d.id, "approved"));
    assert.deepEqual([getBugDraft(d.id).status, getBugDraft(d.id).decidedBy, row(d.id).decided_by_user_id], ["approved", "Tina Tester", tina.id]);
    assert.throws(() => runAs(tina, () => decideBugDraft(d.id, "proposed")), /Only an ignored draft/);
    runAs(tina, () => decideBugDraft(d.id, "ignored"));
    runAs(tina, () => decideBugDraft(d.id, "proposed"));
    runAs(tina, () => decideBugDraft(d.id, "rejected", "not a bug"));
    assert.deepEqual(getBugDraft(d.id).history.map((h) => h.kind), ["suggested", "approved", "ignored", "restored", "rejected"]);
    assert.equal(getBugDraft(d.id).history.at(-1)!.note, "not a bug");
  });
});

describe("Apply makes a bug report that stays proposed", () => {
  let ada!: AccountUser;
  before(() => { ada = user("Ada Apply"); });
  const prepared = (note = NOTE) => { const p = proj(); const d = runAs(ada, () => createBugDraft(p.id, note, shot())); return { p, d }; };

  it("a bug report is made: source manual, origin $screenshot, SCR-n, proposed (never accepted), with the draft's text and the screenshot attached; the draft records who and when and becomes a draft, never approved", () => {
    const { p, d } = prepared();
    runAs(ada, () => editBugDraft(d.id, { actual: "The total stays 30.00" }));
    const { bugId } = runAs(ada, () => applyBugDraft(d.id));
    const b = db.prepare("SELECT * FROM bug_reports WHERE id = ?").get(bugId) as Record<string, any>;
    assert.deepEqual([b.project_id, b.audit_id, b.origin_audit_id, b.source_id, b.source, b.review_status, b.title, b.actual], [p.id, null, "$screenshot", "SCR-1", "manual", "proposed", d.title, "The total stays 30.00"]);
    assert.equal(b.reviewed_at, null);
    assert.match(b.description, /Evidence: screenshot attached\. Not analysed\.$/);
    const att = db.prepare("SELECT * FROM bug_attachments WHERE bug_report_id = ?").all(bugId) as Record<string, any>[];
    assert.equal(att.length, 1);
    assert.deepEqual([att[0].stored_name, att[0].mime, att[0].size, att[0].state, att[0].active, att[0].label], [row(d.id).screenshot_name, "image/png", 1234, "stored", 1, "screenshot"]);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_revisions WHERE bug_report_id = ?", bugId), 1);
    const r = row(d.id);
    assert.deepEqual([r.review_status, r.applied_by, r.applied_by_user_id, r.bug_id], ["draft", "Ada Apply", ada.id, bugId]);
    assert.ok(r.applied_at);
    assert.notEqual(r.review_status, "approved");
    assert.deepEqual(getBugDraft(d.id).bug, { id: bugId });
    assert.equal(getBugDraft(d.id).history.at(-1)!.kind, "applied");
    // the bug report can be read like any other
    const view = getBugReport(bugId) as unknown as { title: string; attachments: unknown[]; fromScreenshot: boolean; source: string };
    assert.deepEqual([view.fromScreenshot, view.source], [true, "manual"], "the bug report says it came from a screenshot");
    assert.equal(view.title, d.title);
    assert.equal(view.attachments.length, 1);
  });

  it("a draft a person had already approved stays approved", () => {
    const { d } = prepared();
    runAs(ada, () => decideBugDraft(d.id, "approved"));
    runAs(ada, () => applyBugDraft(d.id));
    assert.equal(row(d.id).review_status, "approved");
  });

  it("applying twice is refused (409) and makes no second bug report", () => {
    const { p, d } = prepared();
    runAs(ada, () => applyBugDraft(d.id));
    assert.throws(() => runAs(ada, () => applyBugDraft(d.id)), /already applied/);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), 1);
  });

  it("a rejected or an ignored draft is not applied, and nothing is made", () => {
    const { p, d } = prepared();
    const e = runAs(ada, () => createBugDraft(p.id, "Another", shot()));
    runAs(ada, () => decideBugDraft(d.id, "rejected")); runAs(ada, () => decideBugDraft(e.id, "ignored"));
    assert.throws(() => runAs(ada, () => applyBugDraft(d.id)), /was rejected/);
    assert.throws(() => runAs(ada, () => applyBugDraft(e.id)), /was ignored/);
    assert.equal(count("SELECT COUNT(*) AS n FROM bug_reports WHERE project_id = ?", p.id), 0);
  });

  it("each draft is its own bug report, numbered by the draft", () => {
    const p = proj();
    const a = runAs(ada, () => createBugDraft(p.id, "One", shot())), b = runAs(ada, () => createBugDraft(p.id, "Two", shot()));
    runAs(ada, () => applyBugDraft(b.id)); runAs(ada, () => applyBugDraft(a.id));
    assert.deepEqual((db.prepare("SELECT source_id FROM bug_reports WHERE project_id = ? ORDER BY id").all(p.id) as { source_id: string }[]).map((x) => x.source_id), ["SCR-2", "SCR-1"]);
  });

  it("the screenshot route gets the stored name, the type the file header gave, and a name that is not the user's", () => {
    const { d } = prepared();
    const s = bugDraftScreenshot(d.id);
    assert.deepEqual([s.storedName, s.mime, s.fileName], [row(d.id).screenshot_name, "image/png", "scr-1-screenshot.png"]);
    assert.throws(() => bugDraftScreenshot(999999), /not found/);
  });
});

describe("with accounts, deciding and applying need an account in the database itself", () => {
  let rita!: AccountUser;
  before(() => { rita = user("Rita Rule"); });

  it("the database refuses a decision, a takeover and an Apply without an account; nothing changes", () => {
    const p = proj();
    const d = runAs(rita, () => createBugDraft(p.id, NOTE, shot()));
    assert.throws(() => db.prepare("UPDATE bug_drafts SET review_status = 'approved', decided_by = 'x' WHERE id = ?").run(d.id), /needs a person with an account/);
    assert.throws(() => db.prepare("UPDATE bug_drafts SET review_status = 'draft', edited_by = 'x' WHERE id = ?").run(d.id), /needs a person with an account/);
    assert.throws(() => db.prepare("UPDATE bug_drafts SET applied_at = datetime('now'), applied_by = 'x' WHERE id = ?").run(d.id), /needs a person with an account/);
    assert.deepEqual([row(d.id).review_status, row(d.id).applied_at], ["proposed", null]);
  });

  it("the rule is not a person: a new draft is only proposed, nobody decided or applied it", () => {
    const p = proj();
    const d = runAs(rita, () => createBugDraft(p.id, NOTE, shot()));
    const r = row(d.id);
    assert.deepEqual([r.review_status, r.decided_by_user_id, r.edited_by_user_id, r.applied_by_user_id, r.bug_id], ["proposed", null, null, null, null]);
  });

  it("nothing in the module but the person's functions decides or applies, and it writes no file, runs nothing and makes no network call", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "server", "bugdrafts.ts"), "utf8");
    assert.doesNotMatch(src, /node:fs|node:child_process|node:net|node:http|\bfetch\(|\bspawn\(|\bexec\(|\beval\(|new Function|process\.env|writeFile|readFile/);
  });
});
