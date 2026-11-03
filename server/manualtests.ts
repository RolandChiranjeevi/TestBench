import { db, parseJson } from "./db.ts";
import { AuditError, hashOf, resolveOne, resolveRefs, type RefNames, type ResolvedRef } from "./auditcommon.ts";
import type { ManualCategory, ManualTestItem, ParsedPackage } from "./importers/auditpackage.ts";
import { MANUAL_CATEGORIES } from "./importers/auditpackage.ts";
import { PRIORITIES, type Viewport } from "./shapes.ts";
import type { Presence } from "./audits.ts";

/**
 * Manual test cases from an audit package (manual-tests.json). The agent proposes them; a person reviews, edits and runs them.
 *  - They are kept apart from the project's own test cases, from automated results and from bug reports.
 *  - Importing always creates them as `proposed`. Nothing in the file can set a status, and the agent never gives a result.
 *  - Identity is (project, the agent's audit id, the test's sourceId). Same rules as bug reports for what a repeat may change:
 *    an untouched proposal is updated, anything a person reviewed or edited keeps their version and the newer one waits as a revision.
 *  - A test that is not in the latest run is shown as such and otherwise left alone.
 */

export type ManualStatus = "proposed" | "accepted" | "rejected";
type Priority = (typeof PRIORITIES)[number];

export interface ManualPayload {
  title: string; description: string; preconditions: string; steps: string[]; expected: string;
  priority: Priority; category: ManualCategory; wcag: string[]; viewports: Viewport[]; refs: RefNames;
}

export interface PlannedManual {
  sourceId: string; payload: ManualPayload; hash: string; refs: ResolvedRef[];
  action: "new" | "unchanged" | "update" | "pending";
  existing: { id: number; latest_rev: number } | null;
}

const payloadOf = (t: ManualTestItem): ManualPayload => ({
  title: t.title, description: t.description, preconditions: t.preconditions, steps: t.steps, expected: t.expected,
  priority: t.priority, category: t.category, wcag: t.wcag, viewports: t.viewports,
  refs: { requirements: [...new Set(t.refs.requirements)], cases: [...new Set(t.refs.cases)], tests: [...new Set(t.refs.tests)] },
});

const FIELD_LABEL: Record<string, string> = {
  title: "Title", description: "Description", preconditions: "Preconditions", steps: "Steps", expected: "Expected result",
  priority: "Agent's priority", category: "Category", wcag: "WCAG criteria", viewports: "Viewports and devices",
};
const viewportText = (v: Viewport) => [v.device, v.width ? `${v.width}${v.height ? `×${v.height}` : ""}` : "", v.breakpoint ? `breakpoint ${v.breakpoint}` : ""].filter(Boolean).join(" · ");

// ---------- References ----------

function replaceRefs(id: number, refs: ResolvedRef[]) {
  db.prepare("DELETE FROM manual_test_refs WHERE manual_test_id = ?").run(id);
  const ins = db.prepare("INSERT INTO manual_test_refs (manual_test_id, kind, raw, case_id, requirement_id, automated_test_id, state, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const r of refs) ins.run(id, r.kind, r.raw, r.caseId, r.requirementId, r.automatedTestId, r.state, r.reason);
}

/** Tries again to resolve references that were unresolved when the test was imported. */
export function relinkManualRefs(projectId: number, onlyId?: number): number {
  const project = db.prepare("SELECT key FROM projects WHERE id = ?").get(projectId) as { key: string } | undefined;
  if (!project) return 0;
  const rows = db
    .prepare(`SELECT r.id, r.kind, r.raw FROM manual_test_refs r JOIN manual_tests m ON m.id = r.manual_test_id
              WHERE m.project_id = ? AND r.state != 'resolved' ${onlyId ? "AND m.id = ?" : ""}`)
    .all(...(onlyId ? [projectId, onlyId] : [projectId])) as { id: number; kind: ResolvedRef["kind"]; raw: string }[];
  let fixed = 0;
  const upd = db.prepare("UPDATE manual_test_refs SET case_id = ?, requirement_id = ?, automated_test_id = ?, state = ?, reason = ? WHERE id = ?");
  for (const r of rows) {
    const n = resolveOne(projectId, project.key, r.kind, r.raw);
    upd.run(n.caseId, n.requirementId, n.automatedTestId, n.state, n.reason, r.id);
    if (n.state === "resolved") fixed++;
  }
  return fixed;
}

// ---------- Import ----------

/** What an import would do with each manual test of the package. Reads only. */
export function planManualTests(pkg: ParsedPackage, project: { id: number; key: string }): PlannedManual[] {
  return (pkg.manualTests ?? []).map((item) => {
    const payload = payloadOf(item);
    const hash = hashOf(payload);
    const existing = db.prepare("SELECT id, review_status, edited_at, latest_rev FROM manual_tests WHERE project_id = ? AND origin_audit_id = ? AND source_id = ?")
      .get(project.id, pkg.manifest.audit.id, item.sourceId) as { id: number; review_status: string; edited_at: string | null; latest_rev: number } | undefined;
    let action: PlannedManual["action"] = "new";
    if (existing) {
      const latest = db.prepare("SELECT content_hash FROM manual_test_revisions WHERE manual_test_id = ? AND rev = ?").get(existing.id, existing.latest_rev) as { content_hash: string } | undefined;
      if (latest?.content_hash === hash) action = "unchanged";
      else action = existing.review_status === "proposed" && !existing.edited_at ? "update" : "pending";
    }
    return { sourceId: item.sourceId, payload, hash, refs: resolveRefs(project.id, project.key, payload.refs), action, existing: existing ? { id: existing.id, latest_rev: existing.latest_rev } : null };
  });
}

const writeCopy = (id: number, p: ManualPayload, rev: number) =>
  db.prepare(`UPDATE manual_tests SET title = ?, description = ?, preconditions = ?, steps = ?, expected = ?, category = ?, wcag = ?, viewports = ?, agent_priority = ?,
      applied_rev = ?, latest_rev = ? WHERE id = ?`)
    .run(p.title, p.description, p.preconditions, JSON.stringify(p.steps), p.expected, p.category, JSON.stringify(p.wcag), JSON.stringify(p.viewports), p.priority, rev, rev, id);

/** Writes the plan. Must run inside the import's transaction, so a failed import leaves no manual tests behind. */
export function writeManualTests(plan: PlannedManual[], ctx: { projectId: number; auditId: number; agentAuditId: string; origin: string; importId: number }) {
  const addRevision = (id: number, rev: number, p: PlannedManual) =>
    db.prepare("INSERT INTO manual_test_revisions (manual_test_id, rev, payload, content_hash, audit_import_id) VALUES (?, ?, ?, ?, ?)").run(id, rev, JSON.stringify(p.payload), p.hash, ctx.importId);
  const sighted = db.prepare("INSERT OR IGNORE INTO manual_test_sightings (manual_test_id, audit_import_id) VALUES (?, ?)");
  for (const p of plan) {
    let id: number;
    if (p.action === "new") {
      const x = p.payload;
      id = (db.prepare(`INSERT INTO manual_tests (project_id, audit_id, origin_audit_id, origin, source_id, title, description, preconditions, steps, expected, category, wcag, viewports, agent_priority)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
        .get(ctx.projectId, ctx.auditId, ctx.agentAuditId, ctx.origin, p.sourceId, x.title, x.description, x.preconditions, JSON.stringify(x.steps), x.expected, x.category,
          JSON.stringify(x.wcag), JSON.stringify(x.viewports), x.priority) as { id: number }).id;
      addRevision(id, 1, p);
      replaceRefs(id, p.refs);
    } else {
      id = p.existing!.id;
      db.prepare("UPDATE manual_tests SET audit_id = ? WHERE id = ? AND audit_id IS NULL").run(ctx.auditId, id); // the audit was deleted earlier and is back
      if (p.action !== "unchanged") {
        const rev = p.existing!.latest_rev + 1;
        addRevision(id, rev, p);
        if (p.action === "update") {
          writeCopy(id, p.payload, rev);
          replaceRefs(id, p.refs);
        } else {
          // A person has reviewed or edited this test: the newer version waits as a revision until they apply or ignore it.
          db.prepare("UPDATE manual_tests SET latest_rev = ? WHERE id = ?").run(rev, id);
        }
      }
    }
    sighted.run(id, ctx.importId);
  }
  relinkManualRefs(ctx.projectId);
}

// ---------- Presence in the latest run ----------

/**
 * Where a manual test stands against the latest run of its audit. Only a run whose package had a manual-tests.json says anything about
 * manual tests: if the latest run had none, nothing can be said and the test is "no_later_run", never "missing".
 */
const PRESENCE_CTE = `latest AS (SELECT i.audit_id, MAX(i.id) AS import_id, COUNT(CASE WHEN i.manual_listed = 1 THEN 1 END) AS n FROM audit_imports i GROUP BY i.audit_id),
  cur AS (SELECT l.audit_id, l.import_id, l.n, i.manual_listed AS listed FROM latest l JOIN audit_imports i ON i.id = l.import_id)`;
const PRESENCE_EXPR = `CASE WHEN c.import_id IS NULL OR c.listed = 0 THEN 'no_later_run'
  WHEN EXISTS (SELECT 1 FROM manual_test_sightings s WHERE s.manual_test_id = m.id AND s.audit_import_id = c.import_id) THEN CASE WHEN c.n >= 2 THEN 'present' ELSE 'no_later_run' END
  ELSE 'missing' END`;

interface RunRef { run: number; importId: number; importedAt: string; source: string; github: { repo: string; runId: number; url: string } | null }

export function manualStanding(m: { id: number; audit_id: number | null }) {
  const imports = (m.audit_id
    ? db.prepare("SELECT id, imported_at, source, manual_listed, github_repo, github_run_id FROM audit_imports WHERE audit_id = ? ORDER BY id").all(m.audit_id)
    : []) as { id: number; imported_at: string; source: string; manual_listed: number; github_repo: string | null; github_run_id: number | null }[];
  const seen = new Set((db.prepare("SELECT audit_import_id AS i FROM manual_test_sightings WHERE manual_test_id = ?").all(m.id) as { i: number }[]).map((r) => r.i));
  const ref = (i: (typeof imports)[number] | undefined): RunRef | null => !i ? null : {
    run: imports.indexOf(i) + 1, importId: i.id, importedAt: i.imported_at, source: i.source,
    github: i.github_repo && i.github_run_id ? { repo: i.github_repo, runId: i.github_run_id, url: `https://github.com/${i.github_repo}/actions/runs/${i.github_run_id}` } : null,
  };
  const latest = imports.at(-1);
  const lastSeen = [...imports].reverse().find((i) => seen.has(i.id));
  const withManual = imports.filter((i) => i.manual_listed).length;
  let presence: Presence;
  let reason = "";
  if (!latest) { presence = "no_later_run"; reason = "The audit this test came from was deleted from Testbench, so there is no run to compare with."; }
  else if (!latest.manual_listed) { presence = "no_later_run"; reason = "The latest run of this audit had no manual-tests.json, so it says nothing about manual tests."; }
  else if (seen.has(latest.id)) { presence = withManual >= 2 ? "present" : "no_later_run"; if (presence === "no_later_run") reason = "Only one run of this audit has listed manual tests, so there is nothing to compare with yet."; }
  else presence = "missing";
  return { presence, reason, runs: imports.length, latest: ref(latest), lastSeen: ref(lastSeen) };
}

// ---------- Reading ----------

const json = <T>(s: string | null, fallback: T): T => parseJson<T>(s, fallback);
const effective = (r: Record<string, any>) => (r.human_priority ?? r.agent_priority) as Priority;
export const MANUAL_STATUSES: ManualStatus[] = ["proposed", "accepted", "rejected"];

export interface ManualListOpts { status?: string; q?: string; category?: string; priority?: string; wcag?: string; presence?: string }

export function listManualTests(projectId: number, opts: ManualListOpts = {}) {
  const bad = (what: string, values: readonly string[]) => new AuditError(400, `${what} must be one of ${values.join(", ")}`);
  if (opts.presence && !["present", "missing", "no_later_run"].includes(opts.presence)) throw bad("presence", ["present", "missing", "no_later_run"]);
  if (opts.category && !(MANUAL_CATEGORIES as readonly string[]).includes(opts.category)) throw bad("category", MANUAL_CATEGORIES);
  if (opts.priority && !(PRIORITIES as readonly string[]).includes(opts.priority)) throw bad("priority", PRIORITIES);
  if (opts.status && opts.status !== "all" && !MANUAL_STATUSES.includes(opts.status as ManualStatus)) throw bad("status", [...MANUAL_STATUSES, "all"]);
  const where = ["m.project_id = ?"];
  const args: (string | number)[] = [projectId];
  if (opts.status && opts.status !== "all") { where.push("m.review_status = ?"); args.push(opts.status); }
  if (opts.category) { where.push("m.category = ?"); args.push(opts.category); }
  if (opts.priority) { where.push("COALESCE(m.human_priority, m.agent_priority) = ?"); args.push(opts.priority); }
  if (opts.wcag === "any") where.push("json_array_length(m.wcag) > 0");
  else if (opts.wcag) { where.push("EXISTS (SELECT 1 FROM json_each(m.wcag) j WHERE j.value = ?)"); args.push(opts.wcag); }
  if (opts.q?.trim()) { where.push("(m.title LIKE ? OR m.description LIKE ? OR m.source_id LIKE ?)"); const like = `%${opts.q.trim().replace(/[%_]/g, "")}%`; args.push(like, like, like); }
  const base = [...args];
  const baseWhere = [...where];
  if (opts.presence) { where.push(`${PRESENCE_EXPR} = ?`); args.push(opts.presence); }
  const rows = db.prepare(`
    WITH ${PRESENCE_CTE}
    SELECT m.id, m.source_id, m.title, m.review_status, m.category, m.wcag, m.viewports, m.agent_priority, m.human_priority, m.imported_at, m.audit_id, m.origin, m.latest_rev, m.applied_rev, m.ignored_rev, m.edited_at,
      ${PRESENCE_EXPR} AS presence,
      (SELECT COUNT(*) FROM manual_test_refs r WHERE r.manual_test_id = m.id AND r.state != 'resolved') AS unresolved_refs,
      (SELECT COUNT(*) FROM manual_test_refs r WHERE r.manual_test_id = m.id AND r.requirement_id IS NOT NULL) AS requirements
    FROM manual_tests m LEFT JOIN cur c ON c.audit_id = m.audit_id WHERE ${where.join(" AND ")} ORDER BY m.imported_at DESC, m.id DESC LIMIT 500`).all(...args) as Record<string, any>[];
  const counts = db.prepare("SELECT review_status AS s, COUNT(*) AS n FROM manual_tests WHERE project_id = ? GROUP BY review_status").all(projectId) as { s: string; n: number }[];
  const presenceCounts: Record<Presence, number> = { present: 0, missing: 0, no_later_run: 0 };
  for (const r of db.prepare(`WITH ${PRESENCE_CTE} SELECT ${PRESENCE_EXPR} AS p, COUNT(*) AS n FROM manual_tests m LEFT JOIN cur c ON c.audit_id = m.audit_id WHERE ${baseWhere.join(" AND ")} GROUP BY p`).all(...base) as { p: Presence; n: number }[]) presenceCounts[r.p] = r.n;
  const criteria = new Set<string>();
  for (const r of db.prepare("SELECT wcag FROM manual_tests WHERE project_id = ? AND wcag != '[]'").all(projectId) as { wcag: string }[]) for (const c of json<string[]>(r.wcag, [])) criteria.add(c);
  return {
    items: rows.map((r) => ({
      id: r.id, sourceId: r.source_id, title: r.title, status: r.review_status as ManualStatus, category: r.category as ManualCategory,
      priority: effective(r), wcag: json<string[]>(r.wcag, []), viewports: json<Viewport[]>(r.viewports, []).map(viewportText),
      importedAt: r.imported_at, auditTitle: json<{ title?: string }>(r.origin, {}).title ?? "", auditDeleted: r.audit_id == null,
      unresolvedRefs: r.unresolved_refs, requirements: r.requirements, edited: !!r.edited_at,
      pendingUpdate: r.latest_rev > r.applied_rev && r.latest_rev > r.ignored_rev, presence: r.presence as Presence,
    })),
    presenceCounts,
    counts: Object.fromEntries(counts.map((c) => [c.s, c.n])) as Record<string, number>,
    wcagCriteria: [...criteria].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
  };
}

export function getManualTest(id: number) {
  const m = db.prepare("SELECT * FROM manual_tests WHERE id = ?").get(id) as Record<string, any> | undefined;
  if (!m) throw new AuditError(404, "Manual test not found");
  const refs = (db.prepare(`
    SELECT r.*, c.number AS case_number, c.title AS case_title, q.number AS req_number, q.title AS req_title, t.title AS test_title
    FROM manual_test_refs r LEFT JOIN cases c ON c.id = r.case_id LEFT JOIN requirements q ON q.id = r.requirement_id LEFT JOIN automated_tests t ON t.id = r.automated_test_id
    WHERE r.manual_test_id = ? ORDER BY r.id`).all(id) as Record<string, any>[]).map((r) => {
    const target = r.case_id ? { kind: "case", id: r.case_id } : r.requirement_id ? { kind: "requirement", id: r.requirement_id } : r.automated_test_id ? { kind: "test", id: r.automated_test_id } : null;
    const state = r.state === "resolved" && !target ? "target_deleted" : r.state;
    const label = r.case_id ? `${r.raw} · ${r.case_title}` : r.requirement_id ? `REQ-${r.req_number} · ${r.req_title}` : r.automated_test_id ? r.test_title : r.raw;
    return { id: r.id, kind: r.kind, raw: r.raw, state, reason: state === "target_deleted" ? "the target was deleted after the import" : r.reason, label, target };
  });
  const revisions = db.prepare("SELECT rev, imported_at FROM manual_test_revisions WHERE manual_test_id = ? ORDER BY rev DESC").all(id) as { rev: number; imported_at: string }[];
  const payloadAt = (rev: number) => json<ManualPayload | null>((db.prepare("SELECT payload FROM manual_test_revisions WHERE manual_test_id = ? AND rev = ?").get(id, rev) as { payload: string } | undefined)?.payload ?? null, null);
  const cur: Record<string, string> = {
    title: m.title, description: m.description, preconditions: m.preconditions, steps: json<string[]>(m.steps, []).join("\n"), expected: m.expected, priority: m.agent_priority,
    category: m.category, wcag: json<string[]>(m.wcag, []).join(", "), viewports: json<Viewport[]>(m.viewports, []).map(viewportText).join("\n"),
  };
  const pendingUpdate = m.latest_rev > m.applied_rev && m.latest_rev > m.ignored_rev;
  let pending: { rev: number; changes: { field: string; from: string; to: string }[] } | null = null;
  if (pendingUpdate) {
    const p = payloadAt(m.latest_rev);
    if (p) {
      const next: Record<string, string> = {
        title: p.title, description: p.description, preconditions: p.preconditions, steps: p.steps.join("\n"), expected: p.expected, priority: p.priority,
        category: p.category, wcag: p.wcag.join(", "), viewports: p.viewports.map(viewportText).join("\n"),
      };
      pending = { rev: m.latest_rev, changes: Object.keys(cur).filter((k) => cur[k] !== next[k]).map((k) => ({ field: FIELD_LABEL[k], from: cur[k], to: next[k] })) };
    }
  }
  // What the agent said, kept apart from what a person made of it.
  const agent = payloadAt(m.applied_rev);
  const audit = m.audit_id ? (db.prepare("SELECT id, title, agent_audit_id, run_id, run_state, source, github_repo, github_run_id FROM audits WHERE id = ?").get(m.audit_id) as Record<string, any>) : null;
  const latestRevAt = (db.prepare("SELECT MAX(imported_at) AS t FROM manual_test_revisions WHERE manual_test_id = ?").get(id) as { t: string }).t;
  return {
    id: m.id, projectId: m.project_id, sourceId: m.source_id, status: m.review_status as ManualStatus, reviewedAt: m.reviewed_at, reviewNote: m.review_note, editedAt: m.edited_at,
    title: m.title, description: m.description, preconditions: m.preconditions, steps: json<string[]>(m.steps, []), expected: m.expected,
    category: m.category as ManualCategory, wcag: json<string[]>(m.wcag, []), viewports: json<Viewport[]>(m.viewports, []),
    priority: { agent: m.agent_priority as Priority, human: m.human_priority as Priority | null, effective: effective(m) },
    agentVersion: agent ? { title: agent.title, steps: agent.steps, expected: agent.expected, priority: agent.priority } : null,
    importedAt: m.imported_at, agentUpdatedAt: latestRevAt, origin: json<Record<string, any>>(m.origin, {}), originAuditId: m.origin_audit_id, audit,
    refs, revisions, pendingUpdate: pending, latestRun: manualStanding(m as { id: number; audit_id: number | null }),
    requiresHumanCheck: true,
  };
}

// ---------- Review ----------

const exists = (id: number) => {
  const m = db.prepare("SELECT id, project_id FROM manual_tests WHERE id = ?").get(id) as { id: number; project_id: number } | undefined;
  if (!m) throw new AuditError(404, "Manual test not found");
  return m;
};

export interface ManualPatch {
  title?: string; description?: string; preconditions?: string; steps?: string[]; expected?: string; humanPriority?: Priority | null;
  /** The requirements this test covers, named as REQ-n or by their stable id. Replaces the list; an unknown name is kept as unresolved. */
  requirements?: string[];
}

/** A person edits the working copy. The agent's version stays in the revisions; a later import will not overwrite this. */
export function updateManualTest(id: number, patch: ManualPatch) {
  const m = exists(id);
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [col, v] of [["title", patch.title], ["description", patch.description], ["preconditions", patch.preconditions], ["expected", patch.expected]] as const) {
    if (v !== undefined) { sets.push(`${col} = ?`); args.push(v); }
  }
  if (patch.steps !== undefined) { sets.push("steps = ?"); args.push(JSON.stringify(patch.steps)); }
  if (patch.humanPriority !== undefined) { sets.push("human_priority = ?"); args.push(patch.humanPriority); }
  if (!sets.length && patch.requirements === undefined) throw new AuditError(400, "Nothing to change");
  db.transaction(() => {
    if (patch.requirements !== undefined) {
      const project = db.prepare("SELECT key FROM projects WHERE id = ?").get(m.project_id) as { key: string };
      const keep = db.prepare("SELECT kind, raw, case_id, requirement_id, automated_test_id, state, reason FROM manual_test_refs WHERE manual_test_id = ? AND kind != 'requirement'").all(id) as Record<string, any>[];
      const wanted = [...new Set(patch.requirements.map((r) => r.trim()).filter(Boolean))];
      db.prepare("DELETE FROM manual_test_refs WHERE manual_test_id = ?").run(id);
      const ins = db.prepare("INSERT INTO manual_test_refs (manual_test_id, kind, raw, case_id, requirement_id, automated_test_id, state, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const k of keep) ins.run(id, k.kind, k.raw, k.case_id, k.requirement_id, k.automated_test_id, k.state, k.reason);
      for (const raw of wanted) { const r = resolveOne(m.project_id, project.key, "requirement", raw); ins.run(id, r.kind, r.raw, r.caseId, r.requirementId, r.automatedTestId, r.state, r.reason); }
    }
    db.prepare(`UPDATE manual_tests SET ${[...sets, "edited_at = datetime('now')"].join(", ")} WHERE id = ?`).run(...args, id);
  })();
}

/** Only a person calls this. Accepting changes nothing anywhere else, and nothing here runs the test. */
export function reviewManualTest(id: number, status: ManualStatus, note?: string) {
  exists(id);
  db.prepare(`UPDATE manual_tests SET review_status = ?, reviewed_at = CASE WHEN ? = 'proposed' THEN NULL ELSE datetime('now') END, review_note = COALESCE(?, review_note) WHERE id = ?`)
    .run(status, status, note ?? null, id);
}

/** A person chooses the agent's newer version over the current working copy. Review status and the person's own priority stay. */
export function applyManualUpdate(id: number) {
  const m = db.prepare("SELECT project_id, applied_rev, latest_rev FROM manual_tests WHERE id = ?").get(id) as { project_id: number; applied_rev: number; latest_rev: number } | undefined;
  if (!m) throw new AuditError(404, "Manual test not found");
  if (!(m.latest_rev > m.applied_rev)) throw new AuditError(400, "There is no newer version to apply");
  const rev = db.prepare("SELECT payload FROM manual_test_revisions WHERE manual_test_id = ? AND rev = ?").get(id, m.latest_rev) as { payload: string };
  const p = json<ManualPayload>(rev.payload, null as unknown as ManualPayload);
  const project = db.prepare("SELECT key FROM projects WHERE id = ?").get(m.project_id) as { key: string };
  db.transaction(() => {
    writeCopy(id, p, m.latest_rev);
    replaceRefs(id, resolveRefs(m.project_id, project.key, p.refs));
  })();
}

/** A person keeps the current working copy. The same newer version will not be flagged again. */
export function ignoreManualUpdate(id: number) {
  const m = db.prepare("SELECT latest_rev FROM manual_tests WHERE id = ?").get(id) as { latest_rev: number } | undefined;
  if (!m) throw new AuditError(404, "Manual test not found");
  db.prepare("UPDATE manual_tests SET ignored_rev = ? WHERE id = ?").run(m.latest_rev, id);
}

export function deleteManualTest(id: number, force = false) {
  const m = db.prepare("SELECT review_status FROM manual_tests WHERE id = ?").get(id) as { review_status: string } | undefined;
  if (!m) throw new AuditError(404, "Manual test not found");
  if (m.review_status === "accepted" && !force) throw new AuditError(409, "This manual test is accepted. Confirm to delete it.");
  db.prepare("DELETE FROM manual_tests WHERE id = ?").run(id);
}

/** Which manual tests an audit deletion would remove: only untouched proposals. Reviewed or edited ones stay as standalone tests. */
export function manualTestsOfAudit(auditId: number) {
  const rows = db.prepare("SELECT id, review_status, edited_at FROM manual_tests WHERE audit_id = ?").all(auditId) as { id: number; review_status: string; edited_at: string | null }[];
  const removable = rows.filter((r) => r.review_status === "proposed" && !r.edited_at).map((r) => r.id);
  return { removable, deleted: removable.length, kept: rows.length - removable.length };
}
