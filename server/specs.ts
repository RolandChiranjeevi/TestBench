import { createHash } from "node:crypto";
import { db } from "./db.ts";
import { actorName, actorUserId } from "./actor.ts";
import { AuditError } from "./auditcommon.ts";

/**
 * Own specs (S2): a Playwright spec that a person writes or pastes into TestBench. It is a COPY: the person's repo is the source, and TestBench keeps the text, its history and a download.
 *
 *  - TestBench never runs a spec, never reads it as anything but text, and never writes it to disk or git. It is returned as text and downloaded as a plain file.
 *  - Only a signed-in person makes or changes one, through the UI. No agent token reaches any of this (see the guard in server/index.ts). With accounts on, the database refuses a write
 *    that has no person behind it (triggers on `specs`).
 *  - The file name is flat (no folders), ends in `.spec.ts`, and is unique in the project whatever the case of its letters. The text is at most 200 kB (UTF-8) and never empty.
 *  - Every change is a revision (who, when, what). A change that changes nothing makes none. Text is kept only in the revisions of its own changes (made and edited).
 *  - The audit log (in the route) records who did what and to which file. It never holds the text.
 */

export const SPEC_LIMITS = { textBytes: 200 * 1024, perProject: 500, nameMax: 80 };
export const SPEC_STATUSES = ["draft", "ready"] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];

const bad = (message: string) => new AuditError(400, message);

/** A flat file name: letters, digits, `-` and `_`, then exactly `.spec.ts`. No folder, no dot but the ending, no space, no control character. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*\.spec\.ts$/;
export function cleanSpecName(input: unknown): string {
  if (typeof input !== "string") throw bad("The file name must be text");
  const name = input.trim();
  if (!name) throw bad("Give the spec a file name, for example login.spec.ts");
  if (name.length > SPEC_LIMITS.nameMax) throw bad(`The file name can be at most ${SPEC_LIMITS.nameMax} characters`);
  if (/[\\/]/.test(name)) throw bad("The file name cannot hold a folder: use a name like login.spec.ts, not e2e/login.spec.ts");
  if (!name.endsWith(".spec.ts")) throw bad("The file name must end with .spec.ts");
  if (!NAME.test(name)) throw bad("The file name can hold only letters, digits, - and _ before .spec.ts (no space, no other dot)");
  return name;
}

function cleanText(input: unknown): string {
  if (typeof input !== "string") throw bad("The spec text must be text");
  if (!input.trim()) throw bad("The spec needs its text");
  if (input.includes("\u0000")) throw bad("The spec text cannot hold a NUL character");
  if (Buffer.byteLength(input, "utf8") > SPEC_LIMITS.textBytes) throw bad(`The spec text can be at most ${SPEC_LIMITS.textBytes / 1024} kB`);
  return input;
}

function cleanStatus(input: unknown): SpecStatus {
  if (!(SPEC_STATUSES as readonly unknown[]).includes(input)) throw bad(`The status must be one of ${SPEC_STATUSES.join(", ")}`);
  return input as SpecStatus;
}

/** A note on a change of the text, for the history (for example "Updated from my repo"): text, at most 200 characters, trimmed. Nothing means none. */
function cleanNote(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "string") throw bad("The note must be text");
  const note = input.trim();
  if (note.length > NOTE_MAX) throw bad(`The note can be at most ${NOTE_MAX} characters`);
  return note;
}

/** The test case a spec is about, if any: it must be in the same project. Null (or nothing) means none. */
function cleanCase(projectId: number, input: unknown): number | null {
  if (input === undefined || input === null) return null;
  if (!Number.isInteger(input)) throw bad("The test case must be a whole number");
  if (!db.prepare("SELECT 1 FROM cases WHERE id = ? AND project_id = ?").get(input, projectId)) throw bad("That test case is not in this project");
  return input as number;
}

interface Row {
  id: number; project_id: number; file_name: string; text: string; case_id: number | null; status: SpecStatus;
  created_by: string; created_by_user_id: number | null; created_at: string; updated_by: string; updated_by_user_id: number | null; updated_at: string;
}
type Who = { name: string; userId: number | null };
const person = (): Who => ({ name: actorName(), userId: actorUserId() });

const rowOf = (id: number) => {
  const r = db.prepare("SELECT * FROM specs WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new AuditError(404, "Spec not found");
  return r;
};
const caseKeyOf = (caseId: number | null) => {
  if (caseId == null) return null;
  const c = db.prepare("SELECT c.id, c.number, p.key FROM cases c JOIN projects p ON p.id = c.project_id WHERE c.id = ?").get(caseId) as { id: number; number: number; key: string } | undefined;
  return c ? { id: c.id, number: c.number, key: `${c.key}-${c.number}` } : null;
};

// ---- Results: what imported runs say about the file this spec is a copy of ----

/** The last part of a path, in lower case, whatever the slash. */
const baseName = (file: string) => (file.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase();

/** Does an imported test's file belong to the spec? It is the spec's name, or ends in /<name>; the case of the letters and the kind of slash do not matter. */
export const fileMatchesSpec = (file: string, specName: string) => !!file && baseName(file) === specName.toLowerCase();

interface TestRow { file: string; title: string; last_status: string | null; last_seen: string; case_id: number | null }

/** The imported tests of a project that have a file, by the last part of that file, so that a spec finds its tests without looking at all of them. */
function testsByFile(projectId: number) {
  const rows = db.prepare("SELECT file, title, last_status, last_seen, case_id FROM automated_tests WHERE project_id = ? AND file != ''").all(projectId) as TestRow[];
  const by = new Map<string, TestRow[]>();
  for (const r of rows) {
    const k = baseName(r.file);
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  return by;
}

const SEVERITY = ["failed", "blocked", "skipped", "passed"];

/** What the imported results say about one spec: how many tests, how many in each status, when one was last seen, which files they are in, and whether that is more than one. */
function resultsOf(mine: TestRow[]) {
  const n = (st: string) => mine.filter((r) => r.last_status === st).length;
  const passed = n("passed"), failed = n("failed"), skipped = n("skipped"), blocked = n("blocked");
  const files = [...new Set(mine.map((r) => r.file))].sort();
  return {
    tests: mine.length, passed, failed, skipped, blocked, other: mine.length - passed - failed - skipped - blocked,
    lastSeen: mine.reduce<string | null>((m, r) => (m === null || r.last_seen > m ? r.last_seen : m), null),
    files, ambiguous: files.length > 1,
  };
}
export type SpecResults = ReturnType<typeof resultsOf>;

const summary = (r: Row & { size: number }, results: SpecResults) => ({
  id: r.id, projectId: r.project_id, fileName: r.file_name, status: r.status, testCase: caseKeyOf(r.case_id), size: r.size,
  createdBy: r.created_by, createdAt: r.created_at, updatedBy: r.updated_by, updatedAt: r.updated_at, results,
});
export type SpecSummary = ReturnType<typeof summary>;

/** The specs of a project, newest change first. The text is not in the list (a spec can be 200 kB); `size` is its bytes. */
export function listSpecs(projectId: number): SpecSummary[] {
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new AuditError(404, "Project not found");
  const rows = db.prepare("SELECT s.*, LENGTH(CAST(s.text AS BLOB)) AS size FROM specs s WHERE s.project_id = ? ORDER BY s.updated_at DESC, s.id DESC").all(projectId) as (Row & { size: number })[];
  const tests = testsByFile(projectId);
  return rows.map((r) => summary(r, resultsOf(tests.get(r.file_name.toLowerCase()) ?? [])));
}

interface Snapshot { fileName: string; status: SpecStatus; caseId: number | null; text?: string }
function revise(specId: number, kind: "created" | "edited" | "renamed" | "status" | "case", who: Who, snapshot: Snapshot, note = "") {
  const rev = (db.prepare("SELECT COALESCE(MAX(rev), 0) + 1 AS n FROM spec_revisions WHERE spec_id = ?").get(specId) as { n: number }).n;
  db.prepare("INSERT INTO spec_revisions (spec_id, rev, kind, actor, actor_user_id, note, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)").run(specId, rev, kind, who.name, who.userId, note, JSON.stringify(snapshot));
}

export const RESULT_TITLES_MAX = 20;

/** One spec with its text, its history (who did what and when; the text of each edit is kept in the revision but is not sent) and what imported runs say about its file. */
export function getSpec(id: number) {
  const r = rowOf(id);
  const history = (db.prepare("SELECT rev, at, kind, actor, note, snapshot FROM spec_revisions WHERE spec_id = ? ORDER BY rev").all(id) as { rev: number; at: string; kind: string; actor: string; note: string; snapshot: string }[])
    .map((h) => {
      const { text: _text, ...rest } = JSON.parse(h.snapshot) as Snapshot;
      return { rev: h.rev, at: h.at, kind: h.kind, actor: h.actor, note: h.note, snapshot: rest };
    });
  const mine = testsByFile(r.project_id).get(r.file_name.toLowerCase()) ?? [];
  const shown = [...mine].sort((a, b) => SEVERITY.indexOf(a.last_status ?? "") - SEVERITY.indexOf(b.last_status ?? "") || a.title.localeCompare(b.title)).slice(0, RESULT_TITLES_MAX);
  const tests = shown.map((t) => ({ title: t.title, file: t.file, status: t.last_status, lastSeen: t.last_seen, testCase: caseKeyOf(t.case_id) }));
  return { ...summary({ ...r, size: Buffer.byteLength(r.text, "utf8") }, resultsOf(mine)), text: r.text, history, resultTests: tests, moreResultTests: Math.max(0, mine.length - tests.length) };
}

const taken = (e: unknown) => e instanceof Error && /UNIQUE constraint failed: specs\.project_id, specs\.file_name/.test(e.message);
const NAME_TAKEN = "A spec with that file name already exists in this project (names are the same whatever the case of their letters)";

export interface NewSpec { fileName: unknown; text: unknown; status?: unknown; caseId?: unknown }

export function createSpec(projectId: number, input: NewSpec) {
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new AuditError(404, "Project not found");
  const fileName = cleanSpecName(input.fileName);
  const text = cleanText(input.text);
  const status = input.status === undefined ? "draft" : cleanStatus(input.status);
  const caseId = cleanCase(projectId, input.caseId);
  const have = (db.prepare("SELECT COUNT(*) AS n FROM specs WHERE project_id = ?").get(projectId) as { n: number }).n;
  if (have >= SPEC_LIMITS.perProject) throw new AuditError(409, `A project can have at most ${SPEC_LIMITS.perProject} specs. Delete one first`);
  const w = person();
  try {
    return db.transaction(() => {
      const id = (db.prepare(`INSERT INTO specs (project_id, file_name, text, case_id, status, created_by, created_by_user_id, updated_by, updated_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(projectId, fileName, text, caseId, status, w.name, w.userId, w.name, w.userId) as { id: number }).id;
      revise(id, "created", w, { fileName, status, caseId, text });
      return getSpec(id);
    })();
  } catch (e) {
    if (taken(e)) throw new AuditError(409, NAME_TAKEN);
    throw e;
  }
}

export interface SpecPatch { text?: unknown; status?: unknown; caseId?: unknown; note?: unknown }
export const NOTE_MAX = 200;

/** Changes the text, the status or the test case. What is not given stays. What does not change makes no revision and does not touch "updated". Returns what changed, for the audit log. */
export function editSpec(id: number, patch: SpecPatch) {
  const cur = rowOf(id);
  const note = cleanNote(patch.note);
  const text = patch.text === undefined ? cur.text : cleanText(patch.text);
  const status = patch.status === undefined ? cur.status : cleanStatus(patch.status);
  const caseId = patch.caseId === undefined ? cur.case_id : cleanCase(cur.project_id, patch.caseId);
  const changed: ("text" | "status" | "case")[] = [];
  if (text !== cur.text) changed.push("text");
  if (status !== cur.status) changed.push("status");
  if (caseId !== cur.case_id) changed.push("case");
  if (note && !changed.includes("text")) throw bad("A note goes with a change of the text");
  if (!changed.length) return { spec: getSpec(id), changed, projectId: cur.project_id, fileName: cur.file_name };
  const w = person();
  db.transaction(() => {
    db.prepare("UPDATE specs SET text = ?, status = ?, case_id = ?, updated_by = ?, updated_by_user_id = ?, updated_at = datetime('now') WHERE id = ?").run(text, status, caseId, w.name, w.userId, id);
    if (changed.includes("text")) revise(id, "edited", w, { fileName: cur.file_name, status, caseId, text }, note);
    if (changed.includes("status")) revise(id, "status", w, { fileName: cur.file_name, status, caseId }, `${cur.status} to ${status}`);
    if (changed.includes("case")) revise(id, "case", w, { fileName: cur.file_name, status, caseId });
  })();
  return { spec: getSpec(id), changed, projectId: cur.project_id, fileName: cur.file_name };
}

export function renameSpec(id: number, fileName: unknown) {
  const cur = rowOf(id);
  const next = cleanSpecName(fileName);
  if (next === cur.file_name) return { spec: getSpec(id), from: cur.file_name, projectId: cur.project_id };
  const w = person();
  try {
    db.transaction(() => {
      db.prepare("UPDATE specs SET file_name = ?, updated_by = ?, updated_by_user_id = ?, updated_at = datetime('now') WHERE id = ?").run(next, w.name, w.userId, id);
      revise(id, "renamed", w, { fileName: next, status: cur.status, caseId: cur.case_id }, `${cur.file_name} to ${next}`);
    })();
  } catch (e) {
    if (taken(e)) throw new AuditError(409, NAME_TAKEN);
    throw e;
  }
  return { spec: getSpec(id), from: cur.file_name, projectId: cur.project_id };
}

/** Removes a spec and its history. Returns what it was, for the audit log. */
export function removeSpec(id: number) {
  const cur = rowOf(id);
  db.prepare("DELETE FROM specs WHERE id = ?").run(id);
  return { id, projectId: cur.project_id, fileName: cur.file_name };
}

/** The file to download: its name and its text exactly as stored. */
export function specFile(id: number): { fileName: string; text: string } {
  const r = rowOf(id);
  return { fileName: r.file_name, text: r.text };
}

// ---- Compare with the person's repo ----

export type CompareOutcome = "same" | "same except line endings" | "differs";
/** Above this many lines-against-lines, counting what changed is approximate: it must not be able to keep the server busy. */
export const COMPARE_EXACT_CELLS = 4_000_000;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** Line endings made alike (CRLF and CR become LF) and the ending newlines dropped: what "same except line endings" means. */
const alike = (text: string) => text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");

/**
 * How many lines were added and removed going from one text to the other. The same lines at the start and at the end are left out first; what is left in the middle is compared line by line
 * (the longest common run of lines) when that is small enough, and otherwise by counting the lines that have no partner, wherever they stand, which is then marked approximate.
 */
export function lineChanges(from: string, to: string): { added: number; removed: number; approximate: boolean } {
  const x = from.split("\n"), y = to.split("\n");
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let ex = x.length, ey = y.length;
  while (ex > start && ey > start && x[ex - 1] === y[ey - 1]) { ex--; ey--; }
  const a = x.slice(start, ex), b = y.slice(start, ey);
  if (a.length * b.length <= COMPARE_EXACT_CELLS) {
    let prev = new Uint32Array(b.length + 1), cur = new Uint32Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      [prev, cur] = [cur, prev];
    }
    const common = prev[b.length];
    return { added: b.length - common, removed: a.length - common, approximate: false };
  }
  const count = (lines: string[]) => lines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>());
  const ca = count(a), cb = count(b);
  let removed = 0, added = 0;
  for (const [l, n] of ca) removed += Math.max(0, n - (cb.get(l) ?? 0));
  for (const [l, n] of cb) added += Math.max(0, n - (ca.get(l) ?? 0));
  return { added, removed, approximate: true };
}

/**
 * The person gives TestBench the text of the file in their repo (uploaded or pasted), and TestBench says whether it is the same as its copy. It stores nothing, logs nothing and runs nothing.
 * An empty text, a text with a NUL character (not a text file) and a text over 200 kB are refused. A file with another name than the spec is only a warning.
 */
export function compareSpec(id: number, input: { text: unknown; fileName?: unknown }) {
  const cur = rowOf(id);
  const text = input.text;
  if (typeof text !== "string") throw bad("The text to compare must be text");
  if (!text.trim()) throw bad("The file is empty");
  if (text.includes("\u0000")) throw bad("That does not look like a text file: it holds a NUL character");
  if (Buffer.byteLength(text, "utf8") > SPEC_LIMITS.textBytes) throw bad(`The text can be at most ${SPEC_LIMITS.textBytes / 1024} kB, like a spec`);
  let warning: string | null = null;
  if (input.fileName !== undefined && input.fileName !== null && input.fileName !== "") {
    if (typeof input.fileName !== "string" || input.fileName.length > 300) throw bad("The file name must be text of at most 300 characters");
    const name = input.fileName.replace(/\\/g, "/").split("/").pop() ?? "";
    if (name.toLowerCase() !== cur.file_name.toLowerCase()) warning = `This file is called ${name}, and the spec is called ${cur.file_name}. It is compared anyway.`;
  }
  const stored = { sha256: sha256(cur.text), bytes: Buffer.byteLength(cur.text, "utf8") };
  const uploaded = { sha256: sha256(text), bytes: Buffer.byteLength(text, "utf8") };
  const outcome: CompareOutcome = stored.sha256 === uploaded.sha256 ? "same" : alike(cur.text) === alike(text) ? "same except line endings" : "differs";
  const changes = outcome === "differs" ? lineChanges(alike(cur.text), alike(text)) : { added: 0, removed: 0, approximate: false };
  return { outcome, stored, uploaded, ...changes, warning };
}
