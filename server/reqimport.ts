import { z } from "zod";
import { db, parseJson } from "./db.ts";
import { actorName, actorUserId } from "./actor.ts";
import { audit } from "./accounts.ts";
import { createRequirement, kindProblem, recordRevision, REQUIREMENT_KINDS, type RevisionChange } from "./requirements.ts";
import { idText, normViewports, normWcag, PRIORITIES, str, viewportSchema, wcagCriterion, type Viewport } from "./shapes.ts";

/**
 * Requirements in a structured file, for a Testbench project.
 *   { "format": "testbench-requirements", "version": 1, "project": "SHOP", "requirements": [ { "id": "CHK-001", "title": "…" } ] }
 * Rules:
 *  - An import never approves a requirement. A new requirement lands as a draft (whatever status the file gives it, except "deprecated"), with who ran the import,
 *    when, and the file's name. A requirement that already exists keeps its status (an import can retire it, not approve it). A person then approves the drafts
 *    ("Review and approve N requirements", approveImported below).
 *  - The file names the project it is for; a file for another project is refused whole, and requirements are only ever looked up in the
 *    project being imported into.
 *  - A requirement is identified by `id`: a stable id it was imported with, or a Testbench number (REQ-3) of an existing requirement.
 *    The same file imported twice changes nothing. A new stable id creates a requirement; an id that is already there updates it.
 *  - Requirements that are not in the file are left alone. Nothing is deleted by an import.
 *  - It is all or nothing: one invalid requirement refuses the file.
 *  - The same shape is what the agent export produces, so an exported file can be edited and imported again.
 */

export class RequirementImportError extends Error {
  constructor(public status: 400 | 404, message: string, public problems: string[] = []) {
    super(message);
  }
}

export const REQUIREMENT_FILE_LIMIT = 500;
export const STATUS_ALIASES: Record<string, "draft" | "approved" | "deprecated"> = {
  draft: "draft", approved: "approved", active: "approved", deprecated: "deprecated", retired: "deprecated", archived: "deprecated",
};

const itemSchema = z.object({
  id: idText,
  title: z.string().trim().min(1).max(300),
  description: str(50000).default(""),
  kind: z.enum(REQUIREMENT_KINDS).default("functional"),
  priority: z.enum(PRIORITIES).default("medium"),
  status: z.string().trim().toLowerCase().default("approved").refine((v) => v in STATUS_ALIASES, "use draft, active (approved) or retired (deprecated)").transform((v) => STATUS_ALIASES[v]),
  source: z.string().trim().max(300).default(""),
  wcag: z.array(wcagCriterion).max(20).default([]),
  viewports: z.array(viewportSchema).max(10).default([]),
});
const fileSchema = z.object({
  format: z.literal("testbench-requirements"),
  version: z.literal(1),
  project: z.string().min(1).max(40),
  requirements: z.array(z.unknown()).max(REQUIREMENT_FILE_LIMIT),
});

type Item = z.infer<typeof itemSchema>;
interface Fields { title: string; description: string; kind: string; priority: string; status: string; source: string; wcag: string[]; viewports: Viewport[] }
const FIELD_ORDER: (keyof Fields)[] = ["title", "description", "kind", "priority", "status", "source", "wcag", "viewports"];
const FIELD_LABEL: Record<keyof Fields, string> = { title: "Title", description: "Description", kind: "Kind", priority: "Priority", status: "Status", source: "Source", wcag: "WCAG criteria", viewports: "Viewports" };
const viewportText = (x: Viewport) => [x.device, x.width ? `${x.width}${x.height ? `×${x.height}` : ""}` : "", x.breakpoint ? `breakpoint ${x.breakpoint}` : ""].filter(Boolean).join(" ");
const text = (f: keyof Fields, v: unknown) => (Array.isArray(v) ? (f === "viewports" ? (v as Viewport[]).map(viewportText).join("; ") : v.join(", ")) : String(v ?? ""));

export interface RequirementImportItem {
  id: string;
  title: string;
  action: "new" | "unchanged" | "update";
  /** The existing requirement this updates, as REQ-n. */
  matches: string | null;
  changes: { field: string; from: string; to: string }[];
  warnings: string[];
}
export interface RequirementImportSummary {
  dryRun: boolean;
  project: string;
  counts: { new: number; unchanged: number; updated: number };
  /** How many of the new requirements will be drafts (all of them, except any the file retires). */
  asDrafts: number;
  /** Requirements of the project that are not in the file. They are left as they are. */
  untouched: number;
  items: RequirementImportItem[];
}

function parse(content: string, project: { key: string }): Item[] {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new RequirementImportError(400, "The file is not valid JSON.");
  }
  const head = fileSchema.safeParse(raw);
  if (!head.success) {
    throw new RequirementImportError(400, `Not a requirements file: ${head.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}. Expected "format": "testbench-requirements", "version": 1, "project" and "requirements".`);
  }
  if (head.data.project.toUpperCase() !== project.key.toUpperCase()) {
    throw new RequirementImportError(400, `This file is for project "${head.data.project}", but it is being imported into "${project.key}". Nothing was imported.`);
  }
  const problems: string[] = [];
  const items: Item[] = [];
  const seen = new Set<string>();
  head.data.requirements.forEach((r, i) => {
    const label = `requirement #${i + 1}${typeof (r as { id?: unknown })?.id === "string" ? ` (${(r as { id: string }).id})` : ""}`;
    const p = itemSchema.safeParse(r);
    if (!p.success) {
      problems.push(`${label}: ${p.error.issues.slice(0, 3).map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`).join("; ")}`);
      return;
    }
    const why = kindProblem(p.data.kind, p.data.wcag, p.data.viewports);
    if (why) problems.push(`${label}: ${why}`);
    const key = p.data.id.toLowerCase();
    if (seen.has(key)) problems.push(`${label}: the id appears twice in the file`);
    seen.add(key);
    items.push({ ...p.data, wcag: normWcag(p.data.wcag), viewports: normViewports(p.data.viewports) });
  });
  if (problems.length) throw new RequirementImportError(400, `The file has ${problems.length} problem${problems.length === 1 ? "" : "s"}. Nothing was imported.`, problems.slice(0, 20));
  return items;
}

interface Row { id: number; number: number; external_id: string | null; title: string; description: string; kind: string; priority: string; status: string; source: string; wcag: string; viewports: string }

function plan(projectId: number, items: Item[]) {
  const rows = db.prepare("SELECT id, number, external_id, title, description, kind, priority, status, source, wcag, viewports FROM requirements WHERE project_id = ?").all(projectId) as Row[];
  const byExternal = new Map(rows.filter((r) => r.external_id).map((r) => [r.external_id!.toLowerCase(), r]));
  const byNumber = new Map(rows.map((r) => [r.number, r]));
  const problems: string[] = [];
  const planned = items.map((it) => {
    const m = /^REQ-(\d+)$/i.exec(it.id);
    const existing = byExternal.get(it.id.toLowerCase()) ?? (m ? byNumber.get(Number(m[1])) : undefined);
    if (!existing && m) problems.push(`${it.id}: there is no requirement with that number in this project. A new requirement needs a stable id of its own, not a REQ-n number.`);
    const warnings: string[] = [];
    if (!existing) {
      const same = rows.find((r) => r.title.trim().toLowerCase() === it.title.toLowerCase());
      if (same) warnings.push(`REQ-${same.number} in this project has the same title. If this is that requirement, use the id REQ-${same.number} to update it instead of adding a second one.`);
    }
    // An import never approves: a new requirement is a draft (or retired, if the file says so); an existing one keeps its status unless the file retires it.
    const status = existing ? (it.status === "deprecated" ? "deprecated" : existing.status) : it.status === "approved" ? "draft" : it.status;
    const next: Fields = { title: it.title, description: it.description, kind: it.kind, priority: it.priority, status, source: it.source, wcag: it.wcag, viewports: it.viewports };
    const changes: { field: keyof Fields; from: string; to: string }[] = [];
    if (existing) {
      const cur: Fields = { ...existing, wcag: parseJson<string[]>(existing.wcag, []), viewports: parseJson<Viewport[]>(existing.viewports, []) };
      for (const f of FIELD_ORDER) if (JSON.stringify(cur[f]) !== JSON.stringify(next[f])) changes.push({ field: f, from: text(f, cur[f]), to: text(f, next[f]) });
    }
    return { it, existing, next, changes, warnings };
  });
  // Two entries that end up on the same requirement (REQ-3 and the stable id it already has) would be one requirement written twice.
  const target = new Map<number, string>();
  for (const p of planned) if (p.existing) {
    const other = target.get(p.existing.id);
    if (other) problems.push(`${p.it.id} and ${other} are the same requirement (REQ-${p.existing.number}).`);
    target.set(p.existing.id, p.it.id);
  }
  if (problems.length) throw new RequirementImportError(400, `The file has ${problems.length} problem${problems.length === 1 ? "" : "s"}. Nothing was imported.`, problems.slice(0, 20));
  return { planned, rows };
}

/** Reads and checks a requirements file against the project. With dryRun it only says what would happen. */
export function importRequirements(projectId: number, content: string, opts: { dryRun?: boolean; fileName?: string } = {}): RequirementImportSummary {
  const project = db.prepare("SELECT id, key FROM projects WHERE id = ?").get(projectId) as { id: number; key: string } | undefined;
  if (!project) throw new RequirementImportError(404, "Project not found");
  if (content.length > 5 * 1024 * 1024) throw new RequirementImportError(400, "The file is larger than 5 MB.");
  const items = parse(content, project);
  const { planned, rows } = plan(projectId, items);

  const counts = { new: 0, unchanged: 0, updated: 0 };
  const summary: RequirementImportSummary = {
    dryRun: !!opts.dryRun, project: project.key, counts, asDrafts: planned.filter((p) => !p.existing && p.next.status === "draft").length,
    untouched: rows.length - planned.filter((p) => p.existing).length,
    items: planned.map((p) => {
      const action = !p.existing ? "new" : p.changes.length ? "update" : "unchanged";
      counts[action === "update" ? "updated" : action] += 1;
      return {
        id: p.it.id, title: p.it.title, action, matches: p.existing ? `REQ-${p.existing.number}` : null,
        changes: p.changes.map((c) => ({ field: FIELD_LABEL[c.field], from: c.from, to: c.to })), warnings: p.warnings,
      };
    }),
  };
  if (opts.dryRun) return summary;

  db.transaction(() => {
    for (const p of planned) {
      if (!p.existing) {
        const id = createRequirement(projectId, { ...p.next, externalId: p.it.id, origin: "import" });
        db.prepare("UPDATE requirements SET imported_by = ?, imported_by_user_id = ?, imported_at = datetime('now'), import_ref = ? WHERE id = ?").run(actorName(), actorUserId(), (opts.fileName ?? "").slice(0, 200), id);
      } else if (p.changes.length) {
        const n = p.next;
        // Who approved a requirement is not touched by an import.
        db.prepare("UPDATE requirements SET title = ?, description = ?, kind = ?, priority = ?, status = ?, source = ?, wcag = ?, viewports = ?, updated_at = datetime('now') WHERE id = ?")
          .run(n.title, n.description, n.kind, n.priority, n.status, n.source, JSON.stringify(n.wcag), JSON.stringify(n.viewports), p.existing.id);
        const changes: RevisionChange[] = p.changes.map((c) => ({ field: c.field, from: c.from, to: c.to }));
        // A changed title or description asks for a second look at the linked test cases, like an edit in the editor does.
        recordRevision(p.existing.id, changes, p.changes.some((c) => c.field === "title" || c.field === "description"));
      }
    }
  })();
  return summary;
}

/**
 * The explicit step after an import: a person reviews the imported drafts and approves them, all or the ones they pick. Only drafts that came from an import, in this
 * project, are touched. The approver is the person signed in (with their account), and the audit log says how many were approved.
 */
export function approveImported(projectId: number, ids?: unknown, ip = ""): { approved: number; ids: number[] } {
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > REQUIREMENT_FILE_LIMIT * 2 || ids.some((i) => !Number.isInteger(i)))) throw new RequirementImportError(400, "ids must be a list of requirement ids");
  const pick = ids as number[] | undefined;
  return db.transaction(() => {
    const rows = db.prepare(`SELECT id FROM requirements WHERE project_id = ? AND origin = 'import' AND status = 'draft'${pick ? ` AND id IN (${pick.map(() => "?").join(",") || "NULL"})` : ""} ORDER BY number`)
      .all(projectId, ...(pick ?? [])) as { id: number }[];
    const me = actorName();
    for (const r of rows) {
      db.prepare("UPDATE requirements SET status = 'approved', approved_by = ?, approved_by_user_id = ?, approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(me, actorUserId(), r.id);
      recordRevision(r.id, [{ field: "status", from: "draft", to: "approved" }, { field: "approved by", from: "", to: me }], false);
    }
    if (rows.length) audit({ userId: actorUserId(), label: me, ip }, "requirements.bulk_approved", { projectId, detail: { count: rows.length } });
    return { approved: rows.length, ids: rows.map((r) => r.id) };
  })();
}
