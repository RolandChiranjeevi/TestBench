import { createHash } from "node:crypto";
import { db } from "./db.ts";

/** Pieces shared by the bug reports and the manual test cases that arrive in an audit package. */

export class AuditError extends Error {
  constructor(public status: 400 | 404 | 409, message: string) {
    super(message);
  }
}

export const hashOf = (p: unknown) => createHash("sha256").update(JSON.stringify(p)).digest("hex");

export const toSqlDate = (iso: string | null | undefined) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace("T", " ");
};

export interface RefNames { requirements: string[]; cases: string[]; tests: string[] }

export interface ResolvedRef {
  kind: "requirement" | "case" | "test"; raw: string; caseId: number | null; requirementId: number | null; automatedTestId: number | null;
  state: "resolved" | "unresolved" | "wrong_project" | "ambiguous"; reason: string;
}

/** Looks one reference up in the project it is imported into, and only there. */
export function resolveOne(projectId: number, projectKey: string, kind: ResolvedRef["kind"], raw: string): ResolvedRef {
  const base = { kind, raw, caseId: null, requirementId: null, automatedTestId: null };
  if (kind === "requirement") {
    const text = raw.trim();
    const m = /^REQ-(\d+)$/i.exec(text);
    // A requirement is named by its Testbench number (REQ-3) or by the stable id it was imported with.
    const row = (m
      ? db.prepare("SELECT id FROM requirements WHERE project_id = ? AND number = ?").get(projectId, Number(m[1]))
      : db.prepare("SELECT id FROM requirements WHERE project_id = ? AND external_id = ?").get(projectId, text)) as { id: number } | undefined;
    if (row) return { ...base, requirementId: row.id, state: "resolved", reason: "" };
    return { ...base, state: "unresolved", reason: m ? "no such requirement in this project" : "not a requirement reference such as REQ-3, and no requirement in this project has that id" };
  }
  if (kind === "case") {
    const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(raw.trim());
    if (!m) return { ...base, state: "unresolved", reason: "not a test case reference such as SHOP-12" };
    if (m[1].toUpperCase() !== projectKey.toUpperCase()) return { ...base, state: "wrong_project", reason: `belongs to project ${m[1].toUpperCase()}, not ${projectKey}` };
    const row = db.prepare("SELECT id FROM cases WHERE project_id = ? AND number = ?").get(projectId, Number(m[2])) as { id: number } | undefined;
    return row ? { ...base, caseId: row.id, state: "resolved", reason: "" } : { ...base, state: "unresolved", reason: "no such test case in this project" };
  }
  const rows = db.prepare("SELECT id FROM automated_tests WHERE project_id = ? AND (full_name = ? OR title = ?)").all(projectId, raw, raw) as { id: number }[];
  if (rows.length === 1) return { ...base, automatedTestId: rows[0].id, state: "resolved", reason: "" };
  return { ...base, state: rows.length ? "ambiguous" : "unresolved", reason: rows.length ? `${rows.length} automated tests match` : "no automated test with that name in this project" };
}

export function resolveRefs(projectId: number, projectKey: string, refs: RefNames): ResolvedRef[] {
  return [
    ...refs.requirements.map((r) => resolveOne(projectId, projectKey, "requirement", r)),
    ...refs.cases.map((r) => resolveOne(projectId, projectKey, "case", r)),
    ...refs.tests.map((r) => resolveOne(projectId, projectKey, "test", r)),
  ];
}
