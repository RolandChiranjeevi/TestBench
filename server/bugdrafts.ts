import { createHash } from "node:crypto";
import { db } from "./db.ts";
import { actorName, actorUserId } from "./actor.ts";
import { AuditError, hashOf } from "./auditcommon.ts";

/**
 * Bug drafts: a tester attaches a screenshot and a short note, and a fixed rule makes a DRAFT bug report from a template.
 *  - The rule has no model and no network. The picture is not looked at: it is kept as evidence. The title is the first line of the note, the steps are a skeleton of TODO lines, and
 *    "expected" and "actual" are TODO for a person to write. A draft says it was made by a rule ("Suggested by rule"), never that it was made by AI.
 *  - Only a person decides: edits it (the edit is kept in the history), approves it, rejects it, or ignores it. Nothing is accepted, finished or sent anywhere by this.
 *  - Apply makes a bug report of it that stays `proposed` (source manual, origin $screenshot, SCR-n), with the picture attached. A person still has to accept it as a real bug, with the
 *    bug's own review. Applying twice is refused. A rejected or ignored draft has to be changed or put back first.
 *  - Nothing is run, nothing is analysed, nothing is generated, and nothing leaves this server.
 * The picture is stored by the route (this module only knows its stored name) and is only ever served by its own route, as an attachment.
 */

export const RULE_BUG_DRAFT = "bug_draft_from_note";
export const RULE_BUG_DRAFT_LABEL = "rule: bug draft from note";
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
export const LIMITS = { note: 4000, title: 300, description: 8000, text: 2000, step: 500, steps: 30 };

// Control characters (but not line breaks or tabs), bidi controls, zero-width and line-separator characters: none of them is wanted in a bug report.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
/** Text with line breaks kept: no control or invisible characters, trailing spaces gone, at most two empty lines in a row. */
export const cleanMultiline = (s: string) => s.replace(/\r\n?/g, "\n").replace(UNSAFE, " ").split("\n").map((l) => l.replace(/[ \t]+$/g, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
const cleanLine = (s: string, n: number) => clip(s.replace(UNSAFE, " ").replace(/\s+/g, " ").trim(), n);

export interface BugDraftContent { title: string; description: string; steps: string[]; expected: string; actual: string }
const STEP_TODOS = ["TODO: open the page or screen where the screenshot was taken", "TODO: describe what you did, step by step, until the problem appeared"];

/** The rule: the same note always gives the same draft. Without a note nothing is made. */
export function buildBugDraft(noteRaw: string): { content: BugDraftContent; note: string } | { reason: string } {
  const note = cleanMultiline(noteRaw);
  if (!note) return { reason: "A note is needed: write a few words about what the screenshot shows." };
  if (note.length > LIMITS.note) return { reason: `The note is too long (at most ${LIMITS.note} characters).` };
  const first = note.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return {
    note,
    content: {
      title: cleanLine(first, LIMITS.title) || "Bug from a screenshot",
      description: `${note}\n\nEvidence: screenshot attached. Not analysed.`,
      steps: [...STEP_TODOS],
      expected: "TODO: what you expected to happen",
      actual: "TODO: what happened instead (see the screenshot)",
    },
  };
}

/**
 * The picture is checked by its first bytes, not by its name or the type the browser says. Only png, jpg, webp and gif, at most 5 MB. SVG and anything else that can hold script is not an image here.
 */
export function checkScreenshot(buf: Buffer | null, truncated = false): { ext: string; mime: string; size: number; sha256: string } {
  if (!buf || !buf.length) throw new AuditError(400, "A screenshot is needed: attach a png, jpg, webp or gif.");
  if (truncated || buf.length > MAX_SCREENSHOT_BYTES) throw new AuditError(400, "The screenshot is too large (at most 5 MB).");
  let kind: { ext: string; mime: string } | null = null;
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) kind = { ext: "png", mime: "image/png" };
  else if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) kind = { ext: "jpg", mime: "image/jpeg" };
  else if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("latin1"))) kind = { ext: "gif", mime: "image/gif" };
  else if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") kind = { ext: "webp", mime: "image/webp" };
  if (!kind) throw new AuditError(400, "The screenshot must be a png, jpg, webp or gif picture. This file is not.");
  return { ...kind, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
}

type Who = { name: string; userId: number | null };
const ruleWho: Who = { name: "Rule: bug draft from note", userId: null };
const person = (): Who => ({ name: actorName(), userId: actorUserId() });
const stamp = (w: Who) => ["edited_by = ?, edited_by_user_id = ?, edited_at = datetime('now')", [w.name, w.userId]] as const;
export type BugDraftStatus = "proposed" | "draft" | "approved" | "rejected" | "ignored";
const FIELD_LABEL: Record<keyof BugDraftContent, string> = { title: "Title", description: "Description", steps: "Steps", expected: "Expected", actual: "Actual" };

const contentOf = (r: Record<string, any>): BugDraftContent => ({ title: r.title, description: r.description, steps: JSON.parse(r.steps) as string[], expected: r.expected, actual: r.actual });
const keyOf = (c: BugDraftContent) => JSON.stringify([c.title, c.description, c.steps, c.expected, c.actual]);
const changesOf = (from: BugDraftContent, to: BugDraftContent) => {
  const show = (v: string | string[]) => (Array.isArray(v) ? v.join("\n") : v);
  return (Object.keys(FIELD_LABEL) as (keyof BugDraftContent)[]).filter((k) => JSON.stringify(from[k]) !== JSON.stringify(to[k])).map((k) => ({ field: FIELD_LABEL[k], from: show(from[k]), to: show(to[k]) }));
};

function revise(id: number, kind: string, who: Who, content: BugDraftContent, status: string, note = "") {
  const rev = (db.prepare("SELECT COALESCE(MAX(rev), 0) + 1 AS n FROM bug_draft_revisions WHERE draft_id = ?").get(id) as { n: number }).n;
  db.prepare("INSERT INTO bug_draft_revisions (draft_id, rev, kind, actor, actor_user_id, note, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, rev, kind, who.name, who.userId, note, JSON.stringify({ content, status }));
}

const rowOf = (id: number) => {
  const r = db.prepare("SELECT * FROM bug_drafts WHERE id = ?").get(id) as Record<string, any> | undefined;
  if (!r) throw new AuditError(404, "Bug draft not found");
  return r;
};

/** One draft for its view: what it says, who made it, what became of it, the picture, the bug report made of it, and its history. */
function view(r: Record<string, any>) {
  const revs = db.prepare("SELECT * FROM bug_draft_revisions WHERE draft_id = ? ORDER BY id").all(r.id) as Record<string, any>[];
  let before: BugDraftContent | null = null;
  const history = revs.map((h) => {
    const snap = JSON.parse(h.snapshot) as { content: BugDraftContent; status: string };
    const out = { rev: h.rev as number, at: h.at as string, kind: h.kind as string, actor: h.actor as string, byRule: h.actor_user_id === null, note: h.note as string, status: snap.status, changes: before ? changesOf(before, snap.content) : [] };
    before = snap.content;
    return out;
  });
  return {
    id: r.id as number, number: r.number as number, label: `SCR-${r.number}`, rule: r.rule as string, origin: r.origin as "rule" | "agent", proposedBy: r.proposed_by as string,
    suggestedBy: r.origin === "rule" ? "Suggested by rule" : "Suggested by an agent",
    note: r.note as string, ...contentOf(r), status: r.review_status as BugDraftStatus,
    createdBy: r.created_by as string, createdAt: r.created_at as string,
    editedBy: (r.edited_by as string) || null, editedAt: r.edited_at as string | null, decidedBy: (r.decided_by as string) || null, decidedAt: r.decided_at as string | null,
    appliedBy: (r.applied_by as string) || null, appliedAt: r.applied_at as string | null,
    screenshot: { filename: r.screenshot_filename as string, mime: r.screenshot_mime as string, size: r.screenshot_size as number, url: `/api/bug-drafts/${r.id}/screenshot` },
    bug: r.bug_id ? { id: r.bug_id as number } : null,
    history,
  };
}
export type BugDraftView = ReturnType<typeof view>;

export const listBugDrafts = (projectId: number): BugDraftView[] => (db.prepare("SELECT * FROM bug_drafts WHERE project_id = ? ORDER BY id").all(projectId) as Record<string, any>[]).map(view);
export const getBugDraft = (id: number): BugDraftView => view(rowOf(id));

/** Makes the draft from the note and the stored picture. The rule decides; the person who asked is recorded. */
export function createBugDraft(projectId: number, noteRaw: string, shot: { storedName: string; filename: string; mime: string; size: number; sha256: string }): BugDraftView {
  if (!db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId)) throw new AuditError(404, "Project not found");
  const made = buildBugDraft(noteRaw);
  if ("reason" in made) throw new AuditError(400, made.reason);
  const asker = person();
  const c = made.content;
  const id = db.transaction(() => {
    const number = (db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM bug_drafts WHERE project_id = ?").get(projectId) as { n: number }).n;
    const newId = (db.prepare(`INSERT INTO bug_drafts (project_id, number, rule, origin, proposed_by, note, title, description, steps, expected, actual, original, screenshot_name, screenshot_filename, screenshot_mime, screenshot_size, screenshot_sha256, created_by, created_by_user_id)
        VALUES (?, ?, ?, 'rule', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .get(projectId, number, RULE_BUG_DRAFT, RULE_BUG_DRAFT_LABEL, made.note, c.title, c.description, JSON.stringify(c.steps), c.expected, c.actual, JSON.stringify(c), shot.storedName, cleanLine(shot.filename, 120), shot.mime, shot.size, shot.sha256, asker.name, asker.userId) as { id: number }).id;
    revise(newId, "suggested", ruleWho, c, "proposed", `Made by a fixed rule from ${asker.name}'s note. The screenshot is attached as evidence and was not analysed.`);
    return newId;
  })();
  return view(rowOf(id));
}

function normalize(c: BugDraftContent): BugDraftContent {
  return { title: cleanLine(c.title, LIMITS.title), description: cleanMultiline(c.description), steps: c.steps.map((s) => cleanLine(s, LIMITS.step)).filter(Boolean), expected: cleanMultiline(c.expected), actual: cleanMultiline(c.actual) };
}

/** A person edits a draft. It becomes theirs (a draft, also when it was approved or rejected: the decision was about the earlier text). No change, no entry. */
export function editBugDraft(id: number, patch: Partial<BugDraftContent>) {
  const r = rowOf(id);
  const cur = contentOf(r);
  const next = normalize({ ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
  if (!next.title) throw new AuditError(400, "A bug draft needs a title");
  if (!next.steps.length) throw new AuditError(400, "A bug draft needs at least one step");
  if (next.steps.length > LIMITS.steps) throw new AuditError(400, `A bug draft has at most ${LIMITS.steps} steps`);
  if (next.description.length > LIMITS.description || next.expected.length > LIMITS.text || next.actual.length > LIMITS.text) throw new AuditError(400, "The text is too long");
  if (keyOf(next) === keyOf(cur)) return;
  const w = person();
  const [sets, vals] = stamp(w);
  db.transaction(() => {
    db.prepare(`UPDATE bug_drafts SET title = ?, description = ?, steps = ?, expected = ?, actual = ?, review_status = 'draft', ${sets} WHERE id = ?`).run(next.title, next.description, JSON.stringify(next.steps), next.expected, next.actual, ...vals, id);
    revise(id, "edited", w, next, "draft", r.review_status === "draft" ? "" : r.review_status === "proposed" ? "Taken over from the rule's draft" : `Back to draft: the ${r.review_status} decision was about the earlier text`);
  })();
}

/** A person saves as a draft, approves, rejects or ignores a draft, or puts an ignored one back to Suggested. Approve, reject and ignore record who decided and when. */
export function decideBugDraft(id: number, status: BugDraftStatus, note?: string) {
  const r = rowOf(id);
  if (r.review_status === status) return;
  if (status === "proposed" && r.review_status !== "ignored") throw new AuditError(409, "Only an ignored draft can be put back to Suggested.");
  const w = person();
  db.transaction(() => {
    if (status === "draft") {
      const [sets, vals] = stamp(w);
      db.prepare(`UPDATE bug_drafts SET review_status = 'draft', ${sets} WHERE id = ?`).run(...vals, id);
    } else if (status === "proposed") {
      db.prepare("UPDATE bug_drafts SET review_status = 'proposed' WHERE id = ?").run(id);
    } else {
      db.prepare("UPDATE bug_drafts SET review_status = ?, decided_by = ?, decided_by_user_id = ?, decided_at = datetime('now') WHERE id = ?").run(status, w.name, w.userId, id);
    }
    revise(id, status === "proposed" ? "restored" : status, w, contentOf(r), status, note?.trim() ?? "");
  })();
}

/**
 * A person applies a draft: a bug report is made of it, in one transaction. The report stays `proposed` (a person accepts it with the bug review) and has the screenshot attached. The draft is
 * never approved by this: it becomes a draft when it was still only suggested, and approving it is a decision of its own. Applying twice makes no second report.
 */
export function applyBugDraft(id: number): { bugId: number } {
  const r = rowOf(id);
  if (r.review_status === "ignored") throw new AuditError(409, "This draft was ignored. Put it back to Suggested first.");
  if (r.review_status === "rejected") throw new AuditError(409, "This draft was rejected. Approve or edit it first if you want to apply it.");
  if (r.bug_id || r.applied_at) throw new AuditError(409, `This draft was already applied: it is the bug report SCR-${r.number}.`);
  const w = person();
  const c = contentOf(r);
  const payload = {
    title: c.title, description: c.description, steps: c.steps, expected: c.expected, actual: c.actual, environment: "", url: "", toolImpact: null, agentSeverity: null, confidence: null, foundAt: null,
    agentReview: null, fingerprint: "", recurrenceOf: "", refs: { requirements: [], cases: [], tests: [] }, evidence: [],
  };
  return db.transaction(() => {
    const bugId = (db.prepare(`INSERT INTO bug_reports (project_id, audit_id, origin_audit_id, origin, source_id, title, description, steps, expected, actual, source)
        VALUES (?, NULL, '$screenshot', ?, ?, ?, ?, ?, ?, ?, 'manual') RETURNING id`)
      .get(r.project_id, JSON.stringify({ bugDraft: `SCR-${r.number}` }), `SCR-${r.number}`, c.title, c.description, JSON.stringify(c.steps), c.expected, c.actual) as { id: number }).id;
    db.prepare("INSERT INTO bug_revisions (bug_report_id, rev, payload, content_hash) VALUES (?, 1, ?, ?)").run(bugId, JSON.stringify(payload), hashOf(payload));
    db.prepare("INSERT INTO bug_attachments (bug_report_id, declared_path, filename, mime, size, sha256, label, stored_name, state, reason, active) VALUES (?, ?, ?, ?, ?, ?, 'screenshot', ?, 'stored', '', 1)")
      .run(bugId, r.screenshot_filename || `screenshot-${r.number}`, r.screenshot_filename || `screenshot-${r.number}`, r.screenshot_mime, r.screenshot_size, r.screenshot_sha256, r.screenshot_name);
    if (r.review_status === "proposed") {
      const [sets, vals] = stamp(w);
      db.prepare(`UPDATE bug_drafts SET review_status = 'draft', applied_at = datetime('now'), applied_by = ?, applied_by_user_id = ?, bug_id = ?, ${sets} WHERE id = ?`).run(w.name, w.userId, bugId, ...vals, id);
    } else {
      db.prepare("UPDATE bug_drafts SET applied_at = datetime('now'), applied_by = ?, applied_by_user_id = ?, bug_id = ? WHERE id = ?").run(w.name, w.userId, bugId, id);
    }
    revise(id, "applied", w, c, r.review_status === "proposed" ? "draft" : r.review_status, `Bug report SCR-${r.number} made. It stays proposed: a person accepts it with the bug review. The screenshot is attached.`);
    return { bugId };
  })();
}

/** The stored picture of a draft: what the route needs to serve it. */
export function bugDraftScreenshot(id: number): { storedName: string; mime: string; fileName: string } {
  const r = rowOf(id);
  const ext = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as Record<string, string>)[r.screenshot_mime as string] ?? "bin";
  return { storedName: r.screenshot_name as string, mime: r.screenshot_mime as string, fileName: `scr-${r.number}-screenshot.${ext}` };
}
