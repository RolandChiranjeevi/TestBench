import { z } from "zod";
import { db } from "./db.ts";
import { hashOf } from "./auditcommon.ts";

/**
 * Observations: results of load tests and security reviews that are not bugs (measurements, risks, findings that need a human).
 *  - They are separate from bug reports and have their own status model. Nothing here changes the bug model; a person can turn one into a bug
 *    (`convertToBug`), and nothing does it automatically.
 *  - The agent's id is kept as `source_id` (unique per project). Testbench numbers observations OBS-n per project.
 *  - Evidence is a file of the audit, identified by path (+ sha256), the same evidence the bug reports of the audit carry. The agent may name it with a
 *    label such as EV-1; an `evidence` list next to the observations says which file a label means.
 *  - A status that a person has set is never overwritten by a later import. The agent's other fields are updated, and the change is shown as `pending`.
 *  - Life cycle: observed, needs_review and confirmed are open. A person closes an observation as resolved or archived (not a bug, nothing to follow up) and can
 *    reopen it. converted means it is tracked as a bug; it is set by `convertToBug` only and such an observation cannot be closed here.
 */

export const KINDS = ["load_test", "security_review"] as const;
export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export const STATUSES = ["observed", "needs_review", "confirmed", "resolved", "archived", "converted"] as const;
/** What a person can set by hand without closing it. */
export const OPEN_STATUSES = ["observed", "needs_review", "confirmed"] as const;
/** What an agent may send. archived and converted are decisions made in Testbench. */
export const AGENT_STATUSES = ["observed", "needs_review", "confirmed", "resolved"] as const;
export type Kind = (typeof KINDS)[number];
export type Severity = (typeof SEVERITIES)[number];
export type Status = (typeof STATUSES)[number];

export const LIMITS = { items: 500, evidenceIds: 50, title: 300, text: 4000, short: 300 };

export class ObservationError extends Error {
  constructor(public status: 400 | 404 | 409, message: string, public problems: string[] = []) {
    super(message);
  }
}

const finite = z.number().refine(Number.isFinite, "must be a finite number");
const ItemSchema = z.object({
  id: z.string().trim().min(1).max(LIMITS.short),
  auditId: z.string().trim().min(1).max(LIMITS.short),
  kind: z.enum(KINDS),
  title: z.string().trim().min(1).max(LIMITS.title),
  severity: z.enum(SEVERITIES),
  status: z.enum(AGENT_STATUSES, { error: "must be observed, needs_review, confirmed or resolved (archived and converted are set by a person in Testbench)" }).default("observed"),
  metric: z.string().trim().min(1).max(LIMITS.short).nullish(),
  value: finite.nullish(),
  threshold: finite.nullish(),
  evidence: z.string().max(LIMITS.text).default(""),
  evidenceIds: z.array(z.string().trim().min(1).max(500)).max(LIMITS.evidenceIds).default([]),
  recommendation: z.string().max(LIMITS.text).default(""),
  source: z.string().max(LIMITS.short).default(""),
}).strict();
type Item = z.infer<typeof ItemSchema>;

/** Which file an EV-... label means. */
const LabelSchema = z.object({ id: z.string().trim().min(1), path: z.string().trim().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/i, "must be a sha256 in hex").nullish() }).strict();

interface EvidenceRef { ref: string; path: string; sha256: string | null; attachmentId: number | null; state: "ok" | "problem" | "unresolved"; reason: string }
interface Planned {
  item: Item; hash: string; auditRowId: number; evidence: EvidenceRef[];
  action: "new" | "unchanged" | "update" | "pending";
  existing: { id: number; number: number } | null;
}

export interface ObservationImportSummary {
  dryRun: boolean;
  counts: { new: number; unchanged: number; updated: number; pending: number };
  /** Distinct evidence files the observations name: `ok` were found in the audit, `problems` were found but are missing, rejected or have another checksum. */
  evidence: { ok: number; problems: number };
  /** Evidence that matched no file of the audit at all. */
  unresolved_refs: number;
  items: { id: string; number: number | null; action: Planned["action"]; evidence: { ref: string; state: string; reason: string }[] }[];
}

// ---------- Reading the request ----------

/** The body is a JSON array of observations, or `{ observations: [...], evidence: [{ id, path, sha256? }] }` when EV-... labels need translating. */
function readBody(body: unknown): { items: unknown[]; labels: Map<string, { path: string; sha256: string | null }> } {
  const labels = new Map<string, { path: string; sha256: string | null }>();
  let items: unknown;
  if (Array.isArray(body)) items = body;
  else if (body && typeof body === "object" && Array.isArray((body as { observations?: unknown }).observations)) {
    items = (body as { observations: unknown[] }).observations;
    const extra = Object.keys(body).filter((k) => k !== "observations" && k !== "evidence");
    if (extra.length) throw new ObservationError(400, `Unknown field${extra.length > 1 ? "s" : ""}: ${extra.join(", ")}`);
    const ev = (body as { evidence?: unknown }).evidence;
    if (ev !== undefined) {
      const parsed = z.array(LabelSchema).max(2000).safeParse(ev);
      if (!parsed.success) throw new ObservationError(400, "The evidence list is not valid", parsed.error.issues.map((i) => `evidence.${i.path.join(".")}: ${i.message}`));
      for (const l of parsed.data) labels.set(l.id, { path: l.path, sha256: l.sha256?.toLowerCase() ?? null });
    }
  } else throw new ObservationError(400, "Send a JSON array of observations");
  const list = items as unknown[];
  if (!list.length) throw new ObservationError(400, "There are no observations in the request");
  if (list.length > LIMITS.items) throw new ObservationError(400, `At most ${LIMITS.items} observations at a time`);
  return { items: list, labels };
}

function resolveEvidence(projectId: number, auditRowId: number, refs: string[], labels: Map<string, { path: string; sha256: string | null }>): EvidenceRef[] {
  const find = db.prepare(`SELECT a.id, a.state, a.sha256, a.reason FROM bug_attachments a JOIN bug_reports b ON b.id = a.bug_report_id
    WHERE b.project_id = ? AND b.audit_id = ? AND a.declared_path = ? AND a.active = 1 ORDER BY (a.state = 'stored') DESC, a.id`);
  return [...new Set(refs)].map((ref) => {
    const label = labels.get(ref);
    const path = label?.path ?? ref;
    const sha256 = label?.sha256 ?? null;
    const rows = find.all(projectId, auditRowId, path) as { id: number; state: string; sha256: string | null; reason: string }[];
    const base = { ref, path, sha256 };
    if (!rows.length) return { ...base, attachmentId: null, state: "unresolved" as const, reason: "no evidence file with this path in the audit" };
    const hit = sha256 ? rows.find((r) => r.sha256?.toLowerCase() === sha256) : rows[0];
    if (!hit) return { ...base, attachmentId: null, state: "problem" as const, reason: "the checksum does not match the evidence of the audit" };
    if (hit.state !== "stored") return { ...base, attachmentId: hit.id, state: "problem" as const, reason: hit.reason || `the evidence file is ${hit.state}` };
    return { ...base, attachmentId: hit.id, state: "ok" as const, reason: "" };
  });
}

// ---------- Import ----------

function plan(projectId: number, body: unknown): Planned[] {
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new ObservationError(404, "Project not found");
  const { items, labels } = readBody(body);
  const problems: string[] = [];
  const planned: Planned[] = [];
  const seen = new Set<string>();
  const auditByAgentId = new Map<string, number | null>();
  const auditRow = (agentId: string) => {
    if (!auditByAgentId.has(agentId)) {
      const r = db.prepare("SELECT id FROM audits WHERE project_id = ? AND agent_audit_id = ?").get(projectId, agentId) as { id: number } | undefined;
      auditByAgentId.set(agentId, r?.id ?? null);
    }
    return auditByAgentId.get(agentId)!;
  };
  items.forEach((raw, i) => {
    const where = `#${i + 1}${raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string" ? ` (${(raw as { id: string }).id})` : ""}`;
    const parsed = ItemSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) problems.push(`${where}: ${issue.path.join(".") || "item"}: ${issue.message}`);
      return;
    }
    const it = parsed.data;
    const own: string[] = [];
    if (seen.has(it.id)) own.push(`id "${it.id}" appears more than once in the request`);
    seen.add(it.id);
    if (it.kind === "load_test") {
      if (!it.metric) own.push("metric is required for a load_test");
      if (it.value == null) own.push("value is required for a load_test");
      if (it.threshold == null) own.push("threshold is required for a load_test");
    } else {
      for (const f of ["metric", "value", "threshold"] as const) if (it[f] != null) own.push(`${f} is only for a load_test`);
    }
    const auditRowId = auditRow(it.auditId);
    if (auditRowId == null) own.push(`auditId "${it.auditId}" is not an audit of this project`);
    if (own.length || auditRowId == null) {
      problems.push(...own.map((m) => `${where}: ${m}`));
      return;
    }
    const hash = hashOf({
      auditId: it.auditId, kind: it.kind, title: it.title, severity: it.severity, status: it.status, metric: it.metric ?? null, value: it.value ?? null,
      threshold: it.threshold ?? null, evidence: it.evidence, evidenceIds: it.evidenceIds, recommendation: it.recommendation, source: it.source,
    });
    const existing = db.prepare("SELECT id, number, content_hash, status_set_by FROM observations WHERE project_id = ? AND source_id = ?").get(projectId, it.id) as
      { id: number; number: number; content_hash: string; status_set_by: "agent" | "human" } | undefined;
    const action: Planned["action"] = !existing ? "new" : existing.content_hash === hash ? "unchanged" : existing.status_set_by === "human" ? "pending" : "update";
    planned.push({ item: it, hash, auditRowId, evidence: resolveEvidence(projectId, auditRowId, it.evidenceIds, labels), action, existing: existing ? { id: existing.id, number: existing.number } : null });
  });
  if (problems.length) throw new ObservationError(400, `Nothing was imported: ${problems.length} problem${problems.length === 1 ? "" : "s"} in the request`, problems);
  return planned;
}

function summarize(planned: Planned[], dryRun: boolean): ObservationImportSummary {
  const counts = { new: 0, unchanged: 0, updated: 0, pending: 0 };
  const files = new Map<string, EvidenceRef["state"]>();
  let unresolved = 0;
  for (const p of planned) {
    counts[p.action === "update" ? "updated" : p.action] += 1;
    for (const e of p.evidence) {
      if (e.state === "unresolved") unresolved++;
      else files.set(`${p.auditRowId}\0${e.path}`, e.state);
    }
  }
  const states = [...files.values()];
  return {
    dryRun, counts, evidence: { ok: states.filter((s) => s === "ok").length, problems: states.filter((s) => s === "problem").length }, unresolved_refs: unresolved,
    items: planned.map((p) => ({ id: p.item.id, number: p.existing?.number ?? null, action: p.action, evidence: p.evidence.filter((e) => e.state !== "ok").map((e) => ({ ref: e.ref, state: e.state, reason: e.reason })) })),
  };
}

/** Validates all observations first; if any is wrong nothing is written. `dryRun` only says what would happen. */
export function importObservations(projectId: number, body: unknown, opts: { dryRun?: boolean } = {}): ObservationImportSummary {
  const planned = plan(projectId, body);
  if (opts.dryRun) return summarize(planned, true);
  db.transaction(() => {
    const putEvidence = (obsId: number, evidence: EvidenceRef[]) => {
      db.prepare("DELETE FROM observation_evidence WHERE observation_id = ?").run(obsId);
      const ins = db.prepare("INSERT INTO observation_evidence (observation_id, ref, path, sha256, attachment_id, state, reason) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const e of evidence) ins.run(obsId, e.ref, e.path, e.sha256, e.attachmentId, e.state, e.reason);
    };
    for (const p of planned) {
      const x = p.item;
      let id: number;
      if (p.action === "new") {
        id = (db.prepare(`INSERT INTO observations (project_id, number, source_id, audit_id, origin_audit_id, kind, title, severity, status, metric, value, threshold, evidence, recommendation, source, content_hash)
            VALUES (?, (SELECT COALESCE(MAX(number), 0) + 1 FROM observations WHERE project_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
          .get(projectId, projectId, x.id, p.auditRowId, x.auditId, x.kind, x.title, x.severity, x.status, x.metric ?? null, x.value ?? null, x.threshold ?? null, x.evidence, x.recommendation, x.source, p.hash) as { id: number }).id;
      } else {
        id = p.existing!.id;
        if (p.action === "unchanged") db.prepare("UPDATE observations SET audit_id = ? WHERE id = ? AND audit_id IS NULL").run(p.auditRowId, id); // the audit was deleted earlier and is back
        else {
          // update: nobody has judged it, so the agent's status counts too. pending: a person set the status; it stays, and the page says the content changed since.
          db.prepare(`UPDATE observations SET audit_id = ?, origin_audit_id = ?, kind = ?, title = ?, severity = ?, metric = ?, value = ?, threshold = ?, evidence = ?, recommendation = ?, source = ?,
              content_hash = ?, updated_at = datetime('now'),
              status = CASE WHEN ? = 'pending' THEN status ELSE ? END, changed_since_review = CASE WHEN ? = 'pending' THEN 1 ELSE 0 END WHERE id = ?`)
            .run(p.auditRowId, x.auditId, x.kind, x.title, x.severity, x.metric ?? null, x.value ?? null, x.threshold ?? null, x.evidence, x.recommendation, x.source, p.hash, p.action, x.status, p.action, id);
        }
      }
      putEvidence(id, p.evidence); // also for unchanged ones: evidence that arrived later is found now
    }
  })();
  return summarize(planned, false);
}

// ---------- Reading ----------

export interface ObservationView {
  id: number; number: number; label: string; sourceId: string; auditId: number | null; agentAuditId: string; auditTitle: string;
  kind: Kind; title: string; severity: Severity; status: Status; statusSetBy: "agent" | "human"; statusChangedAt: string | null; changedSinceReview: boolean;
  metric: string | null; value: number | null; threshold: number | null; evidence: string; recommendation: string; source: string;
  evidenceFiles: { ref: string; path: string; sha256: string | null; state: string; reason: string }[];
  convertedBugId: number | null; createdAt: string; updatedAt: string;
}

const SELECT = `SELECT o.*, a.title AS audit_title FROM observations o LEFT JOIN audits a ON a.id = o.audit_id`;

function views(rows: Record<string, any>[]): ObservationView[] {
  if (!rows.length) return [];
  const ev = db.prepare(`SELECT observation_id, ref, path, sha256, state, reason FROM observation_evidence WHERE observation_id IN (${rows.map(() => "?").join(",")}) ORDER BY id`)
    .all(...rows.map((r) => r.id)) as { observation_id: number; ref: string; path: string; sha256: string | null; state: string; reason: string }[];
  return rows.map((r) => ({
    id: r.id, number: r.number, label: `OBS-${r.number}`, sourceId: r.source_id, auditId: r.audit_id, agentAuditId: r.origin_audit_id, auditTitle: r.audit_title ?? "",
    kind: r.kind, title: r.title, severity: r.severity, status: r.status, statusSetBy: r.status_set_by, statusChangedAt: r.status_changed_at, changedSinceReview: !!r.changed_since_review,
    metric: r.metric, value: r.value, threshold: r.threshold, evidence: r.evidence, recommendation: r.recommendation, source: r.source,
    evidenceFiles: ev.filter((e) => e.observation_id === r.id).map(({ ref, path, sha256, state, reason }) => ({ ref, path, sha256, state, reason })),
    convertedBugId: r.converted_bug_id, createdAt: r.created_at, updatedAt: r.updated_at,
  }));
}

export interface ObservationFilter { kind?: string; severity?: string; status?: string; audit?: number; q?: string }

export function listObservations(projectId: number, f: ObservationFilter = {}) {
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new ObservationError(404, "Project not found");
  const check = (name: string, v: string | undefined, allowed: readonly string[]) => {
    if (v && !allowed.includes(v)) throw new ObservationError(400, `Unknown ${name} "${v}". Use one of: ${allowed.join(", ")}`);
  };
  check("kind", f.kind, KINDS);
  check("severity", f.severity, SEVERITIES);
  // No status means the open ones (observed, needs_review, confirmed): archived, resolved and converted leave the working list. "all" shows everything, and
  // a comma list such as "archived,resolved" shows those.
  const statuses = !f.status ? [...OPEN_STATUSES] : f.status === "all" ? [] : f.status.split(",").map((x) => x.trim()).filter(Boolean);
  for (const st of statuses) check("status", st, STATUSES);
  const where = ["o.project_id = ?"];
  const args: (string | number)[] = [projectId];
  for (const [col, v] of [["kind", f.kind], ["severity", f.severity]] as const) if (v) { where.push(`o.${col} = ?`); args.push(v); }
  if (statuses.length) { where.push(`o.status IN (${statuses.map(() => "?").join(",")})`); args.push(...statuses); }
  if (f.audit) { where.push("o.audit_id = ?"); args.push(f.audit); }
  if (f.q?.trim()) { where.push("(o.title LIKE ? ESCAPE '\\' OR o.source_id LIKE ? ESCAPE '\\' OR o.recommendation LIKE ? ESCAPE '\\')"); const like = `%${f.q.trim().replace(/[\\%_]/g, "\\$&")}%`; args.push(like, like, like); }
  const rank = `CASE o.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END`;
  const rows = db.prepare(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY ${rank} DESC, o.number DESC`).all(...args) as Record<string, any>[];
  // The chips show the whole project, so the numbers do not change while you filter.
  const group = (col: string, keys: readonly string[]) => {
    const got = new Map((db.prepare(`SELECT ${col} AS k, COUNT(*) AS n FROM observations WHERE project_id = ? GROUP BY ${col}`).all(projectId) as { k: string; n: number }[]).map((r) => [r.k, r.n]));
    return Object.fromEntries(keys.map((k) => [k, got.get(k) ?? 0]));
  };
  const total = (db.prepare("SELECT COUNT(*) AS n FROM observations WHERE project_id = ?").get(projectId) as { n: number }).n;
  return { counts: { total, kind: group("kind", KINDS), severity: group("severity", SEVERITIES), status: group("status", STATUSES) }, items: views(rows) };
}

export function getObservation(id: number): ObservationView | undefined {
  return views(db.prepare(`${SELECT} WHERE o.id = ?`).all(id) as Record<string, any>[])[0];
}

const isOpen = (st: string) => (OPEN_STATUSES as readonly string[]).includes(st);

function current(id: number) {
  const o = db.prepare("SELECT id, number, status, converted_bug_id FROM observations WHERE id = ?").get(id) as { id: number; number: number; status: Status; converted_bug_id: number | null } | undefined;
  if (!o) throw new ObservationError(404, "Observation not found");
  return { id: o.id, label: `OBS-${o.number}`, status: o.status, bugId: o.converted_bug_id };
}

/** Records a person's decision. It is kept when the agent sends the observation again, and it clears the "changed since review" mark. */
function decide(id: number, status: Status): ObservationView {
  db.prepare("UPDATE observations SET status = ?, status_set_by = 'human', status_changed_at = datetime('now'), changed_since_review = 0, updated_at = datetime('now') WHERE id = ?").run(status, id);
  return getObservation(id)!;
}

/** Why an observation in this status cannot be closed. */
function cannotClose(o: ReturnType<typeof current>, to: "archived" | "resolved"): string {
  const verb = to === "archived" ? "archived" : "marked as resolved";
  if (o.status === "converted") return `${o.label} is already tracked as a bug report, so it cannot be ${verb}.`;
  if (o.status === to) return `${o.label} is already ${to}.`;
  return `${o.label} is ${o.status}. Reopen it first.`;
}

/** Sets one of the open statuses by hand (observed, needs_review, confirmed). Closing and reopening have their own actions. */
export function setObservationStatus(id: number, status: unknown): ObservationView {
  if (typeof status !== "string" || !(OPEN_STATUSES as readonly string[]).includes(status)) {
    throw new ObservationError(400, `status must be one of: ${OPEN_STATUSES.join(", ")}. Use archive, resolve or reopen to close or reopen an observation.`);
  }
  const o = current(id);
  if (!isOpen(o.status)) throw new ObservationError(409, `${o.label} is ${o.status}. ${o.status === "converted" ? "It is tracked as a bug report." : "Reopen it first."}`);
  return decide(id, status as Status);
}

/** Archive: not a bug and nothing to follow up (a false positive, something that is only information, a duplicate). Only an open observation. */
export function archiveObservation(id: number): ObservationView {
  const o = current(id);
  if (!isOpen(o.status)) throw new ObservationError(409, cannotClose(o, "archived"));
  return decide(id, "archived");
}

/** Mark as resolved: fixed, or no longer relevant. Only an open observation. */
export function resolveObservation(id: number): ObservationView {
  const o = current(id);
  if (!isOpen(o.status)) throw new ObservationError(409, cannotClose(o, "resolved"));
  return decide(id, "resolved");
}

/** Back to needs_review, from archived or resolved. A converted one stays with its bug report, unless that report has been deleted. */
export function reopenObservation(id: number): ObservationView {
  const o = current(id);
  const orphaned = o.status === "converted" && o.bugId == null;
  if (o.status !== "archived" && o.status !== "resolved" && !orphaned) {
    throw new ObservationError(409, o.status === "converted" ? `${o.label} is tracked as a bug report, so it cannot be reopened here.` : `${o.label} is ${o.status}, not closed.`);
  }
  return decide(id, "needs_review");
}

// ---------- Observation to bug ----------

const BUG_SEVERITY: Record<Severity, "low" | "medium" | "high" | "critical" | null> = { info: null, low: "low", medium: "medium", high: "high", critical: "critical" };

/**
 * A manual action. Makes a bug report (proposed, like every report until a person decides) from the observation and remembers which one. The observation stays,
 * with the status "converted". The evidence files are named in the report, not copied.
 */
export function convertToBug(id: number): { bugId: number } {
  const o = getObservation(id);
  if (!o) throw new ObservationError(404, "Observation not found");
  if (o.convertedBugId) throw new ObservationError(409, "This observation has already been turned into a bug report");
  const lines = [`Made from observation ${o.label} (${o.kind === "load_test" ? "load test" : "security review"}, severity ${o.severity}).`, ""];
  if (o.kind === "load_test") lines.push(`Metric: ${o.metric} = ${o.value}, threshold ${o.threshold}`, "");
  if (o.evidence) lines.push(o.evidence, "");
  if (o.recommendation) lines.push(`Recommendation: ${o.recommendation}`, "");
  if (o.evidenceFiles.length) lines.push(`Evidence: ${o.evidenceFiles.map((e) => e.path).join(", ")}`, "");
  if (o.source) lines.push(`Source: ${o.source}`);
  const payload = {
    title: o.title, description: lines.join("\n").trim(), steps: [] as string[], expected: "", actual: "", environment: "", url: "", toolImpact: null, agentSeverity: BUG_SEVERITY[o.severity],
    confidence: null, foundAt: null, agentReview: null, fingerprint: "", recurrenceOf: "", refs: { requirements: [], cases: [], tests: [] }, evidence: [],
  };
  const projectId = (db.prepare("SELECT project_id FROM observations WHERE id = ?").get(id) as { project_id: number }).project_id;
  return db.transaction(() => {
    const bugId = (db.prepare(`INSERT INTO bug_reports (project_id, audit_id, origin_audit_id, origin, source_id, title, description, steps, agent_severity, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, 'manual') RETURNING id`)
      .get(projectId, o.auditId, o.agentAuditId, JSON.stringify({ observation: o.label, sourceId: o.sourceId }), o.label, payload.title, payload.description, payload.agentSeverity) as { id: number }).id;
    db.prepare("INSERT INTO bug_revisions (bug_report_id, rev, payload, content_hash) VALUES (?, 1, ?, ?)").run(bugId, JSON.stringify(payload), hashOf(payload));
    db.prepare("UPDATE observations SET converted_bug_id = ?, status = 'converted', status_set_by = 'human', status_changed_at = datetime('now'), changed_since_review = 0, updated_at = datetime('now') WHERE id = ?").run(bugId, id);
    return { bugId };
  })();
}
