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

const summary = (r: Row & { size: number }) => ({
  id: r.id, projectId: r.project_id, fileName: r.file_name, status: r.status, testCase: caseKeyOf(r.case_id), size: r.size,
  createdBy: r.created_by, createdAt: r.created_at, updatedBy: r.updated_by, updatedAt: r.updated_at,
});
export type SpecSummary = ReturnType<typeof summary>;

/** The specs of a project, newest change first. The text is not in the list (a spec can be 200 kB); `size` is its bytes. */
export function listSpecs(projectId: number): SpecSummary[] {
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new AuditError(404, "Project not found");
  const rows = db.prepare("SELECT s.*, LENGTH(CAST(s.text AS BLOB)) AS size FROM specs s WHERE s.project_id = ? ORDER BY s.updated_at DESC, s.id DESC").all(projectId) as (Row & { size: number })[];
  return rows.map(summary);
}

interface Snapshot { fileName: string; status: SpecStatus; caseId: number | null; text?: string }
function revise(specId: number, kind: "created" | "edited" | "renamed" | "status" | "case", who: Who, snapshot: Snapshot, note = "") {
  const rev = (db.prepare("SELECT COALESCE(MAX(rev), 0) + 1 AS n FROM spec_revisions WHERE spec_id = ?").get(specId) as { n: number }).n;
  db.prepare("INSERT INTO spec_revisions (spec_id, rev, kind, actor, actor_user_id, note, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)").run(specId, rev, kind, who.name, who.userId, note, JSON.stringify(snapshot));
}

/** One spec with its text and its history (who did what and when; the text of each edit is kept in the revision but is not sent in the list). */
export function getSpec(id: number) {
  const r = rowOf(id);
  const history = (db.prepare("SELECT rev, at, kind, actor, note, snapshot FROM spec_revisions WHERE spec_id = ? ORDER BY rev").all(id) as { rev: number; at: string; kind: string; actor: string; note: string; snapshot: string }[])
    .map((h) => {
      const { text: _text, ...rest } = JSON.parse(h.snapshot) as Snapshot;
      return { rev: h.rev, at: h.at, kind: h.kind, actor: h.actor, note: h.note, snapshot: rest };
    });
  return { ...summary({ ...r, size: Buffer.byteLength(r.text, "utf8") }), text: r.text, history };
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

export interface SpecPatch { text?: unknown; status?: unknown; caseId?: unknown }

/** Changes the text, the status or the test case. What is not given stays. What does not change makes no revision and does not touch "updated". Returns what changed, for the audit log. */
export function editSpec(id: number, patch: SpecPatch) {
  const cur = rowOf(id);
  const text = patch.text === undefined ? cur.text : cleanText(patch.text);
  const status = patch.status === undefined ? cur.status : cleanStatus(patch.status);
  const caseId = patch.caseId === undefined ? cur.case_id : cleanCase(cur.project_id, patch.caseId);
  const changed: ("text" | "status" | "case")[] = [];
  if (text !== cur.text) changed.push("text");
  if (status !== cur.status) changed.push("status");
  if (caseId !== cur.case_id) changed.push("case");
  if (!changed.length) return { spec: getSpec(id), changed, projectId: cur.project_id, fileName: cur.file_name };
  const w = person();
  db.transaction(() => {
    db.prepare("UPDATE specs SET text = ?, status = ?, case_id = ?, updated_by = ?, updated_by_user_id = ?, updated_at = datetime('now') WHERE id = ?").run(text, status, caseId, w.name, w.userId, id);
    if (changed.includes("text")) revise(id, "edited", w, { fileName: cur.file_name, status, caseId, text });
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
