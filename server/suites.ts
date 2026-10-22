import { db } from "./db.ts";

export class SuiteMoveError extends Error {
  constructor(public status: 400 | 404, message: string) {
    super(message);
  }
}

/**
 * Move a suite under `parentId` (null = top level), placed before the sibling `beforeId`, or last when that is null/undefined.
 * Siblings are renumbered 0..n so their order is exactly what was asked for.
 */
export function moveSuite(id: number, parentId: number | null, beforeId?: number | null) {
  const cur = db.prepare("SELECT id, project_id FROM suites WHERE id = ?").get(id) as { id: number; project_id: number } | undefined;
  if (!cur) throw new SuiteMoveError(404, "Suite not found");
  if (parentId != null) {
    const parent = db.prepare("SELECT project_id FROM suites WHERE id = ?").get(parentId) as { project_id: number } | undefined;
    if (!parent || parent.project_id !== cur.project_id) throw new SuiteMoveError(400, "That suite is in another project");
    // Walk up from the new parent: meeting the moved suite means it would end up inside itself.
    for (let a: number | null = parentId; a != null; a = (db.prepare("SELECT parent_id FROM suites WHERE id = ?").get(a) as { parent_id: number | null } | undefined)?.parent_id ?? null) {
      if (a === id) throw new SuiteMoveError(400, "A suite can't be moved into itself");
    }
  }
  db.transaction(() => {
    const siblings = (db.prepare("SELECT id FROM suites WHERE project_id = ? AND parent_id IS ? AND id != ? ORDER BY position, id").all(cur.project_id, parentId, id) as { id: number }[]).map((r) => r.id);
    const at = beforeId == null ? siblings.length : siblings.indexOf(beforeId);
    if (at === -1) throw new SuiteMoveError(400, "The suite to place it before is not in that folder");
    siblings.splice(at, 0, id);
    siblings.forEach((sid, i) => db.prepare("UPDATE suites SET position = ? WHERE id = ?").run(i, sid));
    db.prepare("UPDATE suites SET parent_id = ? WHERE id = ?").run(parentId, id);
  })();
  return db.prepare("SELECT * FROM suites WHERE id = ?").get(id);
}
