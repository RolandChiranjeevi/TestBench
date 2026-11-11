import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, parseJson, UPLOAD_DIR } from "./db.ts";
import { actorName, actorUserId } from "./actor.ts";
import { addEvent, BUG_SOURCES, bugEvents, ciDetail, WORKFLOW_STATUSES, type WorkflowStatus } from "./ci.ts";
import { latestRuns, newBugIds } from "./latestruns.ts";
import type { FileBag } from "./importers/bag.ts";
import { AuditError, hashOf, resolveOne, resolveRefs, toSqlDate, type ResolvedRef } from "./auditcommon.ts";
export { AuditError } from "./auditcommon.ts";
import { manualTestsOfAudit, planManualTests, writeManualTests, type PlannedManual } from "./manualtests.ts";
import { inspectEvidence, PackageError, parsePackage, readEvidence, safeRelPath, type BugItem, type EvidenceCheck, type ParsedPackage } from "./importers/auditpackage.ts";
import { addPlanItem, auditPlan, decidePlanItem, editPlanItem, planCounts, planHistory, planTestPlan, resolvePending, storeTestPlan } from "./auditplan.ts";
export { addPlanItem, decidePlanItem, editPlanItem, planHistory, resolvePending };
import type { PlannedTestPlan } from "./auditplan.ts";

/**
 * Audit packages and the bug reports in them.
 *  - Importing always creates reports as `proposed`. The agent's own review is stored as source information and never decides anything.
 *  - A report is identified by (project, the agent's audit id, the agent's bug id), not by any GitHub id, so the same package arriving
 *    twice (GitHub and an upload, or a re-run) is the same report.
 *  - A report outlives its audit: `audit_id` can become NULL and what the audit said about it is kept on the report (`origin`).
 */

export type ReviewStatus = "proposed" | "accepted" | "rejected" | "duplicate";
type Sev = "low" | "medium" | "high" | "critical";

export interface ImportContext {
  projectId: number;
  source: "upload" | "github";
  /** The GitHub run and artifact Testbench itself saw. For uploads the manifest's own claim is used instead. */
  github?: { repo: string; runId: number; artifactId: number };
}

interface Payload {
  title: string; description: string; steps: string[]; expected: string; actual: string; environment: string; url: string;
  toolImpact: BugItem["toolImpact"] | null; agentSeverity: Sev | null; confidence: number | null; foundAt: string | null;
  agentReview: BugItem["agentReview"] | null; fingerprint: string; recurrenceOf: string;
  refs: { requirements: string[]; cases: string[]; tests: string[] };
  evidence: { path: string; label: string; sha256: string | null }[];
}

interface PlannedBug {
  sourceId: string; payload: Payload; hash: string; refs: ResolvedRef[];
  action: "new" | "unchanged" | "update" | "pending";
  existing: { id: number; latest_rev: number } | null;
  evidence: { check: EvidenceCheck; label: string; sha256: string | null }[];
}

export interface ImportSummary {
  dryRun: boolean;
  audit: { agentAuditId: string; title: string; agent: string; isNew: boolean; source: string; github: { repo: string; runId: number } | null; runState: "linked" | "pending" | "none" };
  counts: { new: number; unchanged: number; updated: number; pending: number };
  evidence: { ok: number; problems: number };
  unresolvedRefs: number;
  /** The test plan of the package (test-plan.json), compared with the audit's stored plan. `listed` is false when the package has none: the audit's earlier plan is then left as it is. */
  testPlan: { listed: boolean; planItems: PlannedTestPlan["planItems"]; coverageGaps: PlannedTestPlan["coverageGaps"]; unresolvedRefs: number };
  /** The manual tests of the package. `listed` is false when it has no manual-tests.json. */
  manualTests: {
    listed: boolean; counts: { new: number; unchanged: number; updated: number; pending: number }; unresolvedRefs: number;
    items: { sourceId: string; title: string; action: PlannedManual["action"]; category: string; priority: string; unresolvedRefs: number }[];
  };
  warnings: string[];
  items: { sourceId: string; title: string; action: PlannedBug["action"]; severity: string | null; unresolvedRefs: number; evidenceProblems: number }[];
  auditId: number | null;
}

const attKey = (path: string, sha: string | null) => `${path}\0${sha ?? ""}`;

function payloadOf(b: BugItem, pkg: ParsedPackage): Payload {
  return {
    title: b.title, description: b.description, steps: b.steps, expected: b.expected, actual: b.actual, environment: b.environment, url: b.url,
    toolImpact: b.toolImpact ?? null, agentSeverity: b.agentSeverity ?? null, confidence: b.confidence ?? null, foundAt: b.foundAt ?? null,
    agentReview: b.agentReview ?? null, fingerprint: b.fingerprint, recurrenceOf: b.recurrenceOf,
    refs: { requirements: [...new Set(b.refs.requirements)], cases: [...new Set(b.refs.cases)], tests: [...new Set(b.refs.tests)] },
    evidence: b.evidence.map((e) => {
      const path = safeRelPath(e.path) ?? e.path;
      return { path, label: e.label, sha256: pkg.declared.get(path)?.sha256 ?? null };
    }),
  };
}

// ---------- References ----------

function replaceRefs(bugId: number, refs: ResolvedRef[]) {
  db.prepare("DELETE FROM bug_refs WHERE bug_report_id = ?").run(bugId);
  const ins = db.prepare("INSERT INTO bug_refs (bug_report_id, kind, raw, case_id, requirement_id, automated_test_id, state, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const r of refs) ins.run(bugId, r.kind, r.raw, r.caseId, r.requirementId, r.automatedTestId, r.state, r.reason);
}

/** Tries again to resolve references that were unresolved when the report was imported (a case or requirement may exist now). */
export function relinkBugRefs(projectId: number, onlyBugId?: number): number {
  const project = db.prepare("SELECT key FROM projects WHERE id = ?").get(projectId) as { key: string } | undefined;
  if (!project) return 0;
  const rows = db
    .prepare(`SELECT r.id, r.kind, r.raw FROM bug_refs r JOIN bug_reports b ON b.id = r.bug_report_id
              WHERE b.project_id = ? AND r.state != 'resolved' ${onlyBugId ? "AND b.id = ?" : ""}`)
    .all(...(onlyBugId ? [projectId, onlyBugId] : [projectId])) as { id: number; kind: ResolvedRef["kind"]; raw: string }[];
  let fixed = 0;
  const upd = db.prepare("UPDATE bug_refs SET case_id = ?, requirement_id = ?, automated_test_id = ?, state = ?, reason = ? WHERE id = ?");
  for (const r of rows) {
    const n = resolveOne(projectId, project.key, r.kind, r.raw);
    upd.run(n.caseId, n.requirementId, n.automatedTestId, n.state, n.reason, r.id);
    if (n.state === "resolved") fixed++;
  }
  return fixed;
}

// ---------- Run link ----------

const externalRunId = (repo: string, runId: number) => `${repo}#${runId}`;

function linkBugRun(bugId: number) {
  const b = db.prepare("SELECT b.run_id, b.result_id, a.run_id AS audit_run FROM bug_reports b LEFT JOIN audits a ON a.id = b.audit_id WHERE b.id = ?").get(bugId) as
    | { run_id: number | null; result_id: number | null; audit_run: number | null } | undefined;
  if (!b) return;
  const runId = b.run_id ?? b.audit_run;
  if (runId && !b.run_id) db.prepare("UPDATE bug_reports SET run_id = ? WHERE id = ?").run(runId, bugId);
  if (runId && !b.result_id) {
    const tests = db.prepare("SELECT automated_test_id AS id FROM bug_refs WHERE bug_report_id = ? AND state = 'resolved' AND automated_test_id IS NOT NULL").all(bugId) as { id: number }[];
    if (tests.length) {
      const results = db.prepare(`SELECT id FROM results WHERE run_id = ? AND automated_test_id IN (${tests.map(() => "?").join(",")})`).all(runId, ...tests.map((t) => t.id)) as { id: number }[];
      // Only an unambiguous match is linked; two possible results means none.
      if (results.length === 1) db.prepare("UPDATE bug_reports SET result_id = ? WHERE id = ?").run(results[0].id, bugId);
    }
  }
}

/** Called when a GitHub run has been imported: audits that named this run (and arrived earlier) are linked to it now. */
export function linkAuditsToRun(projectId: number, externalId: string, runId: number): number {
  const audits = db
    .prepare("SELECT id FROM audits WHERE project_id = ? AND run_id IS NULL AND github_repo IS NOT NULL AND github_run_id IS NOT NULL AND github_repo || '#' || github_run_id = ?")
    .all(projectId, externalId) as { id: number }[];
  for (const a of audits) {
    db.prepare("UPDATE audits SET run_id = ?, run_state = 'linked' WHERE id = ?").run(runId, a.id);
    for (const b of db.prepare("SELECT id FROM bug_reports WHERE audit_id = ?").all(a.id) as { id: number }[]) linkBugRun(b.id);
  }
  return audits.length;
}

// ---------- Import ----------

const hasPublication = (bugId: number) => !!db.prepare("SELECT 1 FROM bug_publications WHERE bug_report_id = ?").get(bugId);

function planImport(pkg: ParsedPackage, ctx: ImportContext) {
  const project = db.prepare("SELECT id, key FROM projects WHERE id = ?").get(ctx.projectId) as { id: number; key: string } | undefined;
  if (!project) throw new AuditError(404, "Project not found");
  if (pkg.manifest.audit.project.toUpperCase() !== project.key.toUpperCase()) {
    throw new PackageError(`This package is for project "${pkg.manifest.audit.project}", but it is being imported into "${project.key}". Nothing was imported.`);
  }
  const warnings = [...pkg.warnings];
  const budget = { used: 0 };
  const checks = new Map<string, EvidenceCheck>();
  const planned: PlannedBug[] = [];
  for (const item of pkg.bugs) {
    const payload = payloadOf(item, pkg);
    const hash = hashOf(payload);
    const existing = db.prepare("SELECT id, review_status, edited_at, latest_rev FROM bug_reports WHERE project_id = ? AND origin_audit_id = ? AND source_id = ?")
      .get(project.id, pkg.manifest.audit.id, item.sourceId) as { id: number; review_status: string; edited_at: string | null; latest_rev: number } | undefined;
    let action: PlannedBug["action"] = "new";
    if (existing) {
      const latest = db.prepare("SELECT content_hash FROM bug_revisions WHERE bug_report_id = ? AND rev = ?").get(existing.id, existing.latest_rev) as { content_hash: string } | undefined;
      if (latest?.content_hash === hash) action = "unchanged";
      else action = existing.review_status === "proposed" && !existing.edited_at && !hasPublication(existing.id) ? "update" : "pending";
    }
    const evidence = payload.evidence.map((e) => {
      let check = checks.get(e.path);
      if (!check) {
        check = inspectEvidence(pkg, e.path, budget);
        checks.set(e.path, check);
      }
      return { check, label: e.label, sha256: e.sha256 };
    });
    planned.push({ sourceId: item.sourceId, payload, hash, refs: resolveRefs(project.id, project.key, payload.refs), action, existing: existing ? { id: existing.id, latest_rev: existing.latest_rev } : null, evidence });
  }
  const gh = ctx.github ?? (pkg.manifest.audit.github ? { ...pkg.manifest.audit.github, artifactId: null as number | null } : null);
  if (ctx.github && pkg.manifest.audit.github && (pkg.manifest.audit.github.repo !== ctx.github.repo || pkg.manifest.audit.github.runId !== ctx.github.runId)) {
    warnings.push(`The manifest names GitHub run ${pkg.manifest.audit.github.repo}#${pkg.manifest.audit.github.runId}, but the package came from ${ctx.github.repo}#${ctx.github.runId}. The real run is used.`);
  }
  const run = gh ? (db.prepare("SELECT id FROM runs WHERE project_id = ? AND source = 'github' AND external_id = ?").get(project.id, externalRunId(gh.repo, gh.runId)) as { id: number } | undefined) : undefined;
  const runState: "linked" | "pending" | "none" = !gh ? "none" : run ? "linked" : "pending";
  const manual = planManualTests(pkg, project);
  return { project, planned, manual, warnings, gh, run: run?.id ?? null, runState, testPlan: planTestPlan(pkg, project) };
}

function summarize(pkg: ParsedPackage, ctx: ImportContext, plan: ReturnType<typeof planImport>, dryRun: boolean, auditId: number | null, isNew: boolean): ImportSummary {
  const a = pkg.manifest.audit;
  const counts = { new: 0, unchanged: 0, updated: 0, pending: 0 };
  let ok = 0, problems = 0, unresolved = 0;
  const seen = new Set<string>();
  const items = plan.planned.map((p) => {
    counts[p.action === "update" ? "updated" : p.action] += 1;
    const bad = p.evidence.filter((e) => e.check.state !== "ok").length;
    const un = p.refs.filter((r) => r.state !== "resolved").length;
    for (const e of p.evidence) if (!seen.has(e.check.path)) { seen.add(e.check.path); if (e.check.state === "ok") ok++; else problems++; }
    unresolved += un;
    return { sourceId: p.sourceId, title: p.payload.title, action: p.action, severity: p.payload.agentSeverity, unresolvedRefs: un, evidenceProblems: bad };
  });
  return {
    dryRun,
    audit: { agentAuditId: a.id, title: a.title, agent: [a.agent.name, a.agent.version].filter(Boolean).join(" "), isNew, source: ctx.source, github: plan.gh ? { repo: plan.gh.repo, runId: plan.gh.runId } : null, runState: plan.runState },
    counts, evidence: { ok, problems }, unresolvedRefs: unresolved, warnings: plan.warnings, items, auditId,
    testPlan: { listed: plan.testPlan.listed, planItems: plan.testPlan.planItems, coverageGaps: plan.testPlan.coverageGaps, unresolvedRefs: plan.testPlan.unresolvedRefs },
    manualTests: {
      listed: pkg.manualTests !== null,
      counts: plan.manual.reduce((c, m) => { c[m.action === "update" ? "updated" : m.action] += 1; return c; }, { new: 0, unchanged: 0, updated: 0, pending: 0 }),
      unresolvedRefs: plan.manual.reduce((n, m) => n + m.refs.filter((r) => r.state !== "resolved").length, 0),
      items: plan.manual.map((m) => ({ sourceId: m.sourceId, title: m.payload.title, action: m.action, category: m.payload.category, priority: m.payload.priority, unresolvedRefs: m.refs.filter((r) => r.state !== "resolved").length })),
    },
  };
}

/** Reads, validates and (unless dryRun) imports an audit package. Throws PackageError for a package that can never be imported. */
export function importAuditPackage(bag: FileBag, ctx: ImportContext, opts: { dryRun?: boolean } = {}): ImportSummary {
  const pkg = parsePackage(bag);
  const plan = planImport(pkg, ctx);
  const a = pkg.manifest.audit;
  const existingAudit = db.prepare("SELECT id FROM audits WHERE project_id = ? AND agent_audit_id = ?").get(ctx.projectId, a.id) as { id: number } | undefined;
  if (opts.dryRun) return summarize(pkg, ctx, plan, true, existingAudit?.id ?? null, !existingAudit);

  // Files are written as we go; if the import fails half way they are removed again. Replaced files are removed after the commit.
  const written: string[] = [];
  const obsolete: string[] = [];
  const store = (bytes: Uint8Array, ext: string) => {
    const name = `${randomUUID()}${ext}`;
    writeFileSync(join(UPLOAD_DIR, name), bytes);
    written.push(name);
    return name;
  };
  let summary!: ImportSummary;
  try {
    db.transaction(() => {
      // --- the audit
      let narrativeName: string | null = null;
      if (pkg.narrative) narrativeName = store(pkg.narrative, ".md");
      const github = plan.gh;
      let auditId: number;
      if (existingAudit) {
        auditId = existingAudit.id;
        const old = db.prepare("SELECT narrative_stored_name FROM audits WHERE id = ?").get(auditId) as { narrative_stored_name: string | null };
        if (narrativeName && old.narrative_stored_name) obsolete.push(old.narrative_stored_name);
        db.prepare(`UPDATE audits SET title = ?, agent_name = ?, agent_version = ?, agent_model = ?, started_at = ?, finished_at = ?,
            review_status = ?, review_method = ?, review_reviewer = ?, source = ?,
            github_repo = COALESCE(?, github_repo), github_run_id = COALESCE(?, github_run_id), github_artifact_id = COALESCE(?, github_artifact_id),
            run_id = COALESCE(?, run_id), run_state = CASE WHEN ? IS NOT NULL THEN 'linked' WHEN ? IS NOT NULL THEN 'pending' ELSE run_state END,
            package_sha256 = ?, narrative_stored_name = COALESCE(?, narrative_stored_name), last_imported_at = datetime('now') WHERE id = ?`)
          .run(a.title, a.agent.name, a.agent.version, a.agent.model, toSqlDate(a.startedAt), toSqlDate(a.finishedAt),
            a.review?.status ?? "", a.review?.method ?? "", a.review?.reviewer ?? "", ctx.source,
            github?.repo ?? null, github?.runId ?? null, github?.artifactId ?? null, plan.run, plan.run, github?.runId ?? null, pkg.packageSha256, narrativeName, auditId);
      } else {
        auditId = (db.prepare(`INSERT INTO audits (project_id, agent_audit_id, title, agent_name, agent_version, agent_model, started_at, finished_at,
            review_status, review_method, review_reviewer, source, github_repo, github_run_id, github_artifact_id, run_id, run_state, package_sha256, narrative_stored_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
          .get(ctx.projectId, a.id, a.title, a.agent.name, a.agent.version, a.agent.model, toSqlDate(a.startedAt), toSqlDate(a.finishedAt),
            a.review?.status ?? "", a.review?.method ?? "", a.review?.reviewer ?? "", ctx.source, github?.repo ?? null, github?.runId ?? null, github?.artifactId ?? null,
            plan.run, plan.runState, pkg.packageSha256, narrativeName) as { id: number }).id;
      }
      const importId = (db.prepare("INSERT INTO audit_imports (audit_id, source, artifact_id, warnings, sightings_recorded, github_repo, github_run_id, manual_listed) VALUES (?, ?, ?, ?, 1, ?, ?, ?) RETURNING id")
        .get(auditId, ctx.source, github?.artifactId ?? null, JSON.stringify(plan.warnings), github?.repo ?? null, github?.runId ?? null, pkg.manualTests ? 1 : 0) as { id: number }).id;
      const sighted = db.prepare("INSERT OR IGNORE INTO bug_sightings (bug_report_id, audit_import_id) VALUES (?, ?)");
      const origin = JSON.stringify({
        auditId: a.id, title: a.title, agent: a.agent, review: a.review ?? null, startedAt: a.startedAt ?? null, finishedAt: a.finishedAt ?? null,
        source: ctx.source, github: github ? { repo: github.repo, runId: github.runId, artifactId: github.artifactId } : null, packageSha256: pkg.packageSha256,
      });

      // --- evidence for one report
      const findAtt = db.prepare("SELECT id, state FROM bug_attachments WHERE bug_report_id = ? AND declared_path = ? AND COALESCE(sha256, '') = ?");
      const putEvidence = (bugId: number, e: PlannedBug["evidence"][number]) => {
        const c = e.check;
        const ex = findAtt.get(bugId, c.path, e.sha256 ?? "") as { id: number; state: string } | undefined;
        if (ex?.state === "stored") return;
        const bytes = c.state === "ok" ? readEvidence(pkg, c.path) : null;
        const stored = bytes ? store(bytes, c.ext) : null;
        const state = stored ? "stored" : c.state === "ok" ? "missing" : c.state;
        const reason = stored ? "" : c.state === "ok" ? "the file could not be read" : c.reason;
        if (ex) db.prepare("UPDATE bug_attachments SET stored_name = ?, state = ?, reason = ?, mime = ?, size = ? WHERE id = ?").run(stored, state, reason, c.mime, c.size, ex.id);
        else db.prepare("INSERT INTO bug_attachments (bug_report_id, declared_path, filename, mime, size, sha256, label, stored_name, state, reason, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)")
          .run(bugId, c.path, c.filename, c.mime, c.size, e.sha256, e.label, stored, state, reason);
      };
      /** Make the evidence of `payload` the active set: switch on what belongs to it, drop what does not. */
      const activate = (bugId: number, payload: Payload) => {
        const keep = new Set(payload.evidence.map((e) => attKey(e.path, e.sha256)));
        for (const r of db.prepare("SELECT id, declared_path, sha256, stored_name FROM bug_attachments WHERE bug_report_id = ?").all(bugId) as { id: number; declared_path: string; sha256: string | null; stored_name: string | null }[]) {
          if (keep.has(attKey(r.declared_path, r.sha256))) db.prepare("UPDATE bug_attachments SET active = 1 WHERE id = ?").run(r.id);
          else {
            db.prepare("DELETE FROM bug_attachments WHERE id = ?").run(r.id);
            if (r.stored_name) obsolete.push(r.stored_name);
          }
        }
      };
      const writeCopy = (bugId: number, p: Payload, rev: number) => {
        db.prepare(`UPDATE bug_reports SET title = ?, description = ?, steps = ?, expected = ?, actual = ?, environment = ?, url = ?, tool_impact = ?, agent_severity = ?,
            confidence = ?, agent_review = ?, found_at = ?, fingerprint = ?, recurrence_hint = ?, applied_rev = ?, latest_rev = ? WHERE id = ?`)
          .run(p.title, p.description, JSON.stringify(p.steps), p.expected, p.actual, p.environment, p.url, p.toolImpact ? JSON.stringify(p.toolImpact) : null, p.agentSeverity,
            p.confidence, p.agentReview ? JSON.stringify(p.agentReview) : null, toSqlDate(p.foundAt), p.fingerprint, p.recurrenceOf, rev, rev, bugId);
      };
      const addRevision = (bugId: number, rev: number, p: PlannedBug) =>
        db.prepare("INSERT INTO bug_revisions (bug_report_id, rev, payload, content_hash, audit_import_id) VALUES (?, ?, ?, ?, ?)").run(bugId, rev, JSON.stringify(p.payload), p.hash, importId);

      // --- the reports
      for (const p of plan.planned) {
        let bugId: number;
        if (p.action === "new") {
          const x = p.payload;
          bugId = (db.prepare(`INSERT INTO bug_reports (project_id, audit_id, origin_audit_id, origin, source_id, title, description, steps, expected, actual, environment, url,
              tool_impact, agent_severity, confidence, agent_review, found_at, fingerprint, recurrence_hint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
            .get(ctx.projectId, auditId, a.id, origin, p.sourceId, x.title, x.description, JSON.stringify(x.steps), x.expected, x.actual, x.environment, x.url,
              x.toolImpact ? JSON.stringify(x.toolImpact) : null, x.agentSeverity, x.confidence, x.agentReview ? JSON.stringify(x.agentReview) : null, toSqlDate(x.foundAt), x.fingerprint, x.recurrenceOf) as { id: number }).id;
          addRevision(bugId, 1, p);
          replaceRefs(bugId, p.refs);
          for (const e of p.evidence) putEvidence(bugId, e);
          activate(bugId, p.payload);
        } else {
          bugId = p.existing!.id;
          db.prepare("UPDATE bug_reports SET audit_id = ? WHERE id = ? AND audit_id IS NULL").run(auditId, bugId); // the audit was deleted earlier and is back
          if (p.action === "unchanged") {
            for (const e of p.evidence) putEvidence(bugId, e); // fills in evidence that was missing the first time
          } else {
            const rev = p.existing!.latest_rev + 1;
            addRevision(bugId, rev, p);
            for (const e of p.evidence) putEvidence(bugId, e);
            if (p.action === "update") {
              writeCopy(bugId, p.payload, rev);
              replaceRefs(bugId, p.refs);
              activate(bugId, p.payload);
            } else {
              // A human has reviewed or edited this report: the new version waits as a revision until they apply or ignore it.
              db.prepare("UPDATE bug_reports SET latest_rev = ? WHERE id = ?").run(rev, bugId);
            }
          }
        }
        sighted.run(bugId, importId); // this run contained the report, whatever happened to its content
        linkBugRun(bugId);
      }
      relinkBugRefs(ctx.projectId);
      writeManualTests(plan.manual, { projectId: ctx.projectId, auditId, agentAuditId: a.id, origin, importId });
      storeTestPlan(auditId, plan.testPlan); // follows the package for items nobody owns; items a person owns are kept (the agent's version waits); no test-plan.json leaves the plan alone
      summary = summarize(pkg, ctx, plan, false, auditId, !existingAudit);
      db.prepare("UPDATE audit_imports SET new_count = ?, unchanged_count = ?, updated_count = ?, pending_count = ? WHERE id = ?")
        .run(summary.counts.new, summary.counts.unchanged, summary.counts.updated, summary.counts.pending, importId);
    })();
  } catch (e) {
    removeFiles(written);
    throw e;
  }
  removeFiles(obsolete);
  return summary;
}

function removeFiles(names: string[]) {
  for (const f of names) {
    try {
      unlinkSync(join(UPLOAD_DIR, f));
    } catch {
      /* already gone */
    }
  }
}

// ---------- Reading ----------

const json = <T>(s: string | null, fallback: T): T => parseJson<T>(s, fallback);
const effective = (r: Record<string, any>): string | null => r.human_severity ?? r.agent_severity ?? null;
/**
 * Where the severity that counts comes from. A person's decision (human_severity) is the only one that is decided; agent_severity is a suggestion: from an AI
 * (an audit agent, or an observation's severity) or, for a test that failed in CI, a default by rule that is not AI and not a decision.
 */
export type SeveritySource = "human" | "ai" | "ci_default";
const severitySource = (r: Record<string, any>): SeveritySource | null => (r.human_severity ? "human" : r.agent_severity ? (r.source === "ci" ? "ci_default" : "ai") : null);
/** What a severity is called in the screens and the log. The stored value stays "high": it is part of the agent package, CI, Linear and the requirements' priority. */
export const SEVERITY_WORD: Record<string, string> = { low: "Low", medium: "Medium", high: "Major", critical: "Critical" };
const sevWord = (v: string | null) => (v ? SEVERITY_WORD[v] ?? v : "Not set");

export type Presence = "present" | "missing" | "no_later_run";
export const PRESENCE_VALUES: Presence[] = ["present", "missing", "no_later_run"];

/**
 * Where a report stands against the latest run of its audit, as SQL. A run is one import of a package of that audit.
 * present: the latest run contained it (and there is an earlier run to compare with). missing: the latest run did not.
 * no_later_run: nothing to compare with: the audit has had one run only, was deleted, or its latest run was imported before runs were recorded.
 */
const PRESENCE_CTE = `latest AS (SELECT i.audit_id, MAX(i.id) AS import_id, COUNT(*) AS n FROM audit_imports i GROUP BY i.audit_id),
  cur AS (SELECT l.audit_id, l.import_id, l.n, i.sightings_recorded AS tracked FROM latest l JOIN audit_imports i ON i.id = l.import_id)`;
const PRESENCE_EXPR = `CASE WHEN c.import_id IS NULL OR c.tracked = 0 THEN 'no_later_run'
  WHEN EXISTS (SELECT 1 FROM bug_sightings s WHERE s.bug_report_id = b.id AND s.audit_import_id = c.import_id) THEN CASE WHEN c.n >= 2 THEN 'present' ELSE 'no_later_run' END
  ELSE 'missing' END`;

/** `new`: only the bugs that came with the latest CI run (`ci`), the latest audit import (`audit`) or either (`any`). */
export interface BugListFilter { status?: string; q?: string; presence?: string; source?: string; workflow?: string; severity?: string; tag?: string; testKey?: string; assignee?: string; new?: string }

export function listBugReports(projectId: number, opts: BugListFilter = {}) {
  if (opts.new && !["ci", "audit", "any"].includes(opts.new)) throw new AuditError(400, "new must be ci, audit or any");
  const fresh = newBugIds(projectId);
  if (opts.presence && !PRESENCE_VALUES.includes(opts.presence as Presence)) throw new AuditError(400, `presence must be one of ${PRESENCE_VALUES.join(", ")}`);
  if (opts.source && !(BUG_SOURCES as readonly string[]).includes(opts.source)) throw new AuditError(400, `source must be one of ${BUG_SOURCES.join(", ")}`);
  if (opts.workflow && !(WORKFLOW_STATUSES as readonly string[]).includes(opts.workflow)) throw new AuditError(400, `workflow must be one of ${WORKFLOW_STATUSES.join(", ")}`);
  if (opts.severity && !["low", "medium", "high", "critical", "none"].includes(opts.severity)) throw new AuditError(400, "severity must be low, medium, high, critical or none");
  const where = ["b.project_id = ?"];
  const args: (string | number)[] = [projectId];
  if (opts.status && opts.status !== "all") { where.push("b.review_status = ?"); args.push(opts.status); }
  if (opts.source) { where.push("b.source = ?"); args.push(opts.source); }
  if (opts.workflow) { where.push("b.workflow_status = ?"); args.push(opts.workflow); }
  if (opts.severity) where.push(opts.severity === "none" ? "COALESCE(b.human_severity, b.agent_severity) IS NULL" : "COALESCE(b.human_severity, b.agent_severity) = ?");
  if (opts.severity && opts.severity !== "none") args.push(opts.severity);
  if (opts.tag) { where.push("EXISTS (SELECT 1 FROM json_each(b.tags) t WHERE t.value = ?)"); args.push(opts.tag); }
  if (opts.testKey) { where.push("b.test_key = ?"); args.push(opts.testKey); }
  if (opts.assignee) { where.push(opts.assignee === "none" ? "b.assignee = ''" : "b.assignee = ?"); if (opts.assignee !== "none") args.push(opts.assignee); }
  if (opts.new) {
    const ids = opts.new === "ci" ? [...fresh.ci] : opts.new === "audit" ? [...fresh.audit] : [...fresh.ci, ...fresh.audit];
    where.push("b.id IN (SELECT value FROM json_each(?))");
    args.push(JSON.stringify(ids));
  }
  if (opts.q?.trim()) { where.push("(b.title LIKE ? OR b.description LIKE ? OR b.source_id LIKE ? OR b.test_key LIKE ?)"); const like = `%${opts.q.trim().replace(/[%_]/g, "")}%`; args.push(like, like, like, like); }
  const base = [...args];
  const baseWhere = [...where];
  if (opts.presence) { where.push(`${PRESENCE_EXPR} = ?`); args.push(opts.presence); }
  const rows = db.prepare(`
    WITH ${PRESENCE_CTE}
    SELECT b.id, b.source_id, b.title, b.review_status, b.reviewed_by, b.reviewed_at, b.agent_severity, b.human_severity, b.severity_by, b.source, b.found_at, b.imported_at, b.audit_id, b.origin, b.latest_rev, b.applied_rev, b.ignored_rev,
      b.source, b.test_key, b.tags, b.workflow_status, b.assignee, b.last_ci_status, b.last_ci_at, b.ci_flaky,
      (SELECT COUNT(*) FROM bug_occurrences o JOIN ci_results x ON x.id = o.ci_result_id WHERE o.bug_report_id = b.id AND x.status = 'failed') AS failed_runs,
      (SELECT r.branch || char(31) || r.commit_sha || char(31) || r.pipeline_url FROM bug_occurrences o JOIN ci_results x ON x.id = o.ci_result_id JOIN ci_runs r ON r.id = x.ci_run_id
        WHERE o.bug_report_id = b.id ORDER BY o.id DESC LIMIT 1) AS last_occurrence,
      ${PRESENCE_EXPR} AS presence,
      (SELECT COUNT(*) FROM bug_refs r WHERE r.bug_report_id = b.id AND r.state != 'resolved') AS unresolved_refs,
      (SELECT COUNT(*) FROM bug_attachments x WHERE x.bug_report_id = b.id AND x.active = 1 AND x.state = 'stored') AS attachments,
      (SELECT COUNT(*) FROM bug_attachments x WHERE x.bug_report_id = b.id AND x.active = 1 AND x.state != 'stored') AS attachment_problems,
      (SELECT COUNT(*) FROM bug_publications p WHERE p.bug_report_id = b.id AND p.state IN ('sent', 'pending', 'unknown')) AS publications
    FROM bug_reports b LEFT JOIN cur c ON c.audit_id = b.audit_id WHERE ${where.join(" AND ")} ORDER BY b.imported_at DESC, b.id DESC LIMIT 500`).all(...args) as Record<string, any>[];
  const counts = db.prepare("SELECT review_status AS s, COUNT(*) AS n FROM bug_reports WHERE project_id = ? GROUP BY review_status").all(projectId) as { s: string; n: number }[];
  // How many reports stand each way within the chosen status and search, whichever presence filter is on.
  const presenceCounts = Object.fromEntries(PRESENCE_VALUES.map((v) => [v, 0])) as Record<Presence, number>;
  for (const r of db.prepare(`WITH ${PRESENCE_CTE} SELECT ${PRESENCE_EXPR} AS p, COUNT(*) AS n FROM bug_reports b LEFT JOIN cur c ON c.audit_id = b.audit_id WHERE ${baseWhere.join(" AND ")} GROUP BY p`).all(...base) as { p: Presence; n: number }[]) presenceCounts[r.p] = r.n;
  return {
    items: rows.map((r) => ({
      id: r.id, sourceId: r.source_id, title: r.title, status: r.review_status as ReviewStatus, reviewedBy: (r.reviewed_by as string) || null, reviewedAt: r.reviewed_at as string | null, severity: effective(r), severitySource: severitySource(r), severityBy: r.human_severity ? ((r.severity_by as string) || null) : null, foundAt: r.found_at, importedAt: r.imported_at,
      auditTitle: json<{ title?: string }>(r.origin, {}).title ?? "", auditDeleted: r.audit_id == null && r.source === "agent_audit",
      source: r.source as string, testKey: r.test_key as string | null, tags: json<string[]>(r.tags, []), workflowStatus: r.workflow_status as WorkflowStatus, assignee: r.assignee as string,
      ci: r.source === "ci" ? (() => {
        const [branch = "", commit = "", pipelineUrl = ""] = String(r.last_occurrence ?? "").split("\u001f");
        return { lastStatus: r.last_ci_status as string | null, lastAt: r.last_ci_at as string | null, flaky: !!r.ci_flaky, failedRuns: r.failed_runs as number, branch, commit, pipelineUrl };
      })() : null,
      unresolvedRefs: r.unresolved_refs, attachments: r.attachments, attachmentProblems: r.attachment_problems,
      pendingUpdate: r.latest_rev > r.applied_rev && r.latest_rev > r.ignored_rev, published: r.publications > 0, presence: r.presence as Presence,
      /** Where the bug is new: in the project's latest CI run or latest audit import. null when it came with an earlier one. */
      newIn: fresh.ci.has(r.id) ? ("ci" as const) : fresh.audit.has(r.id) ? ("audit" as const) : null,
    })),
    /** The latest run or import of each source, and how many bugs came with it (all statuses, whichever filter is on). */
    latestRuns: latestRuns(projectId, fresh),
    presenceCounts,
    counts: Object.fromEntries(counts.map((c) => [c.s, c.n])) as Record<string, number>,
  };
}

export interface RunRef {
  /** The run's place among the runs of its audit: 1 for the first import, 2 for the second, and so on. */
  run: number; importId: number; importedAt: string; source: string;
  /** False for runs imported before sightings were recorded: only runs that changed a report are known for those. */
  recorded: boolean;
  github: { repo: string; runId: number; url: string } | null;
}

/** Where one report stands against the latest run of its audit, with the dates and runs to show. Reads only. */
export function runStanding(b: { id: number; audit_id: number | null }) {
  const imports = (b.audit_id
    ? db.prepare("SELECT id, imported_at, source, sightings_recorded, github_repo, github_run_id FROM audit_imports WHERE audit_id = ? ORDER BY id").all(b.audit_id)
    : []) as { id: number; imported_at: string; source: string; sightings_recorded: number; github_repo: string | null; github_run_id: number | null }[];
  const seen = new Set((db.prepare("SELECT audit_import_id AS i FROM bug_sightings WHERE bug_report_id = ?").all(b.id) as { i: number }[]).map((r) => r.i));
  const ref = (i: (typeof imports)[number] | undefined): RunRef | null => !i ? null : {
    run: imports.indexOf(i) + 1, importId: i.id, importedAt: i.imported_at, source: i.source, recorded: !!i.sightings_recorded,
    github: i.github_repo && i.github_run_id ? { repo: i.github_repo, runId: i.github_run_id, url: `https://github.com/${i.github_repo}/actions/runs/${i.github_run_id}` } : null,
  };
  const latest = imports.at(-1);
  const lastSeen = [...imports].reverse().find((i) => seen.has(i.id));
  let presence: Presence;
  let reason = "";
  if (!latest) { presence = "no_later_run"; reason = "The audit this report came from was deleted from Testbench, so there is no run to compare with."; }
  else if (!latest.sightings_recorded) { presence = "no_later_run"; reason = "The latest run was imported before Testbench recorded which reports a run contained. Import the audit again and this will be known."; }
  else if (seen.has(latest.id)) { presence = imports.length >= 2 ? "present" : "no_later_run"; if (presence === "no_later_run") reason = "This audit has had one run so far, so there is nothing to compare with yet."; }
  else presence = "missing";
  return { presence, reason, runs: imports.length, latest: ref(latest), lastSeen: ref(lastSeen) };
}

const FIELD_LABEL: Record<string, string> = { title: "Title", description: "Description", steps: "Steps", expected: "Expected result", actual: "Actual result", environment: "Environment", url: "URL", agentSeverity: "Agent severity" };

export function getBugReport(id: number) {
  const b = db.prepare("SELECT * FROM bug_reports WHERE id = ?").get(id) as Record<string, any> | undefined;
  if (!b) throw new AuditError(404, "Bug report not found");
  const refs = (db.prepare(`
    SELECT r.*, c.number AS case_number, c.title AS case_title, q.number AS req_number, q.title AS req_title, t.title AS test_title
    FROM bug_refs r LEFT JOIN cases c ON c.id = r.case_id LEFT JOIN requirements q ON q.id = r.requirement_id LEFT JOIN automated_tests t ON t.id = r.automated_test_id
    WHERE r.bug_report_id = ? ORDER BY r.id`).all(id) as Record<string, any>[]).map((r) => {
    const target = r.case_id ? { kind: "case", id: r.case_id } : r.requirement_id ? { kind: "requirement", id: r.requirement_id } : r.automated_test_id ? { kind: "test", id: r.automated_test_id } : null;
    // A reference that was resolved and whose target has been deleted since is reported as such, not as a plain unresolved one.
    const state = r.state === "resolved" && !target ? "target_deleted" : r.state;
    const label = r.case_id ? `${r.raw} · ${r.case_title}` : r.requirement_id ? `${r.raw} · ${r.req_title}` : r.automated_test_id ? r.test_title : r.raw;
    return { id: r.id, kind: r.kind, raw: r.raw, state, reason: state === "target_deleted" ? "the target was deleted after the import" : r.reason, label, target };
  });
  const attachments = db.prepare("SELECT id, declared_path, filename, mime, size, sha256, label, stored_name, state, reason, active FROM bug_attachments WHERE bug_report_id = ? ORDER BY id").all(id) as Record<string, any>[];
  const revisions = db.prepare("SELECT rev, imported_at, content_hash FROM bug_revisions WHERE bug_report_id = ? ORDER BY rev DESC").all(id) as { rev: number; imported_at: string; content_hash: string }[];
  const pendingUpdate = b.latest_rev > b.applied_rev && b.latest_rev > b.ignored_rev;
  let pending: { rev: number; changes: { field: string; from: string; to: string }[]; evidenceAdded: number; evidenceRemoved: number } | null = null;
  if (pendingUpdate) {
    const rev = db.prepare("SELECT payload FROM bug_revisions WHERE bug_report_id = ? AND rev = ?").get(id, b.latest_rev) as { payload: string } | undefined;
    const p = rev ? json<Payload | null>(rev.payload, null) : null;
    if (p) {
      const cur: Record<string, string> = { title: b.title, description: b.description, steps: json<string[]>(b.steps, []).join("\n"), expected: b.expected, actual: b.actual, environment: b.environment, url: b.url, agentSeverity: b.agent_severity ?? "" };
      const next: Record<string, string> = { title: p.title, description: p.description, steps: p.steps.join("\n"), expected: p.expected, actual: p.actual, environment: p.environment, url: p.url, agentSeverity: p.agentSeverity ?? "" };
      const have = new Set(attachments.filter((a) => a.active).map((a) => attKey(a.declared_path, a.sha256)));
      const want = new Set(p.evidence.map((e) => attKey(e.path, e.sha256)));
      pending = {
        rev: b.latest_rev,
        changes: Object.keys(cur).filter((k) => cur[k] !== next[k]).map((k) => ({ field: FIELD_LABEL[k], from: cur[k], to: next[k] })),
        evidenceAdded: [...want].filter((k) => !have.has(k)).length,
        evidenceRemoved: [...have].filter((k) => !want.has(k)).length,
      };
    }
  }
  const audit = b.audit_id ? (db.prepare("SELECT id, title, agent_audit_id, run_id, run_state, source, github_repo, github_run_id, (narrative_stored_name IS NOT NULL) AS has_report FROM audits WHERE id = ?").get(b.audit_id) as Record<string, any>) : null;
  const dupOf = b.duplicate_of_id ? (db.prepare("SELECT id, title FROM bug_reports WHERE id = ?").get(b.duplicate_of_id) as { id: number; title: string } | undefined) : undefined;
  return {
    id: b.id, projectId: b.project_id, sourceId: b.source_id, status: b.review_status as ReviewStatus, reviewedAt: b.reviewed_at, reviewedBy: (b.reviewed_by as string) || null, reviewNote: b.review_note, editedAt: b.edited_at,
    title: b.title, description: b.description, steps: json<string[]>(b.steps, []), expected: b.expected, actual: b.actual, environment: b.environment, url: b.url,
    severity: {
      tool: json(b.tool_impact, null), agent: b.agent_severity, human: b.human_severity, effective: effective(b), source: severitySource(b),
      /** The person who decided it, when a decision exists. */
      decidedBy: b.human_severity ? (b.severity_by as string) || null : null, decidedAt: b.human_severity ? (b.severity_at as string | null) : null, reason: b.human_severity ? (b.severity_reason as string) : "",
    },
    confidence: b.confidence, agentReview: json(b.agent_review, null), foundAt: b.found_at, importedAt: b.imported_at,
    fingerprint: b.fingerprint, recurrenceHint: b.recurrence_hint,
    origin: json<Record<string, any>>(b.origin, {}), originAuditId: b.origin_audit_id, audit, runId: b.run_id, resultId: b.result_id,
    source: b.source as string, testKey: b.test_key as string | null, tags: json<string[]>(b.tags, []),
    workflowStatus: b.workflow_status as WorkflowStatus, assignee: b.assignee as string, resolvedSuspectedAt: b.resolved_suspected_at as string | null, closedAt: b.closed_at as string | null,
    ci: ciDetail(b as Parameters<typeof ciDetail>[0]), events: bugEvents(id),
    refs, attachments, revisions, pendingUpdate: pending,
    duplicateOf: dupOf ?? null,
    duplicates: db.prepare("SELECT id, title FROM bug_reports WHERE duplicate_of_id = ?").all(id) as { id: number; title: string }[],
    similar: b.fingerprint ? (db.prepare("SELECT id, title, review_status AS status FROM bug_reports WHERE project_id = ? AND fingerprint = ? AND id != ? ORDER BY id DESC LIMIT 10").all(b.project_id, b.fingerprint, id) as { id: number; title: string; status: string }[]) : [],
    latestRun: runStanding(b as { id: number; audit_id: number | null }),
    publications: db.prepare("SELECT id, destination, destination_ref, mode, state, external_id, external_url, error, attachments_state, content_sent, created_at, completed_at FROM bug_publications WHERE bug_report_id = ? ORDER BY id").all(id),
  };
}

export function listAudits(projectId: number) {
  const rows = db.prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM bug_reports b WHERE b.audit_id = a.id) AS bugs,
      (SELECT COUNT(*) FROM bug_reports b WHERE b.audit_id = a.id AND b.review_status = 'proposed') AS proposed,
      (SELECT COUNT(*) FROM audit_imports i WHERE i.audit_id = a.id) AS imports
    FROM audits a WHERE a.project_id = ? ORDER BY a.last_imported_at DESC, a.id DESC`).all(projectId) as Record<string, any>[];
  return rows.map((a) => ({
    id: a.id, agentAuditId: a.agent_audit_id, title: a.title, agent: [a.agent_name, a.agent_version].filter(Boolean).join(" "), model: a.agent_model,
    startedAt: a.started_at, finishedAt: a.finished_at, reviewStatus: a.review_status, reviewMethod: a.review_method,
    source: a.source, github: a.github_repo ? { repo: a.github_repo, runId: a.github_run_id, artifactId: a.github_artifact_id } : null,
    runId: a.run_id, runState: a.run_state === "linked" && a.run_id == null ? "deleted" : a.run_state, hasReport: !!a.narrative_stored_name, bugs: a.bugs, proposed: a.proposed, imports: a.imports, lastImportedAt: a.last_imported_at, ...planCounts(a.id),
  }));
}

/** GitHub packages the checker refused. They are not retried; the reason is shown so the agent's output can be fixed. */
export function listRejectedPackages(projectId: number) {
  return db.prepare(`
    SELECT g.artifact_id AS artifactId, g.run_id AS runId, g.name, g.note, g.seen_at AS seenAt, s.owner || '/' || s.repo AS repo
    FROM github_artifacts g JOIN github_sources s ON s.id = g.source_id WHERE s.project_id = ? AND g.outcome = 'rejected' ORDER BY g.seen_at DESC LIMIT 50`).all(projectId);
}

export function auditReportText(id: number): string {
  const a = db.prepare("SELECT narrative_stored_name FROM audits WHERE id = ?").get(id) as { narrative_stored_name: string | null } | undefined;
  if (!a?.narrative_stored_name) throw new AuditError(404, "This audit has no stored report");
  try {
    return readFileSync(join(UPLOAD_DIR, a.narrative_stored_name), "utf8");
  } catch {
    throw new AuditError(404, "The stored report file is missing");
  }
}

// ---------- Review ----------

const exists = (id: number) => {
  const b = db.prepare("SELECT id, project_id, review_status FROM bug_reports WHERE id = ?").get(id) as { id: number; project_id: number; review_status: string } | undefined;
  if (!b) throw new AuditError(404, "Bug report not found");
  return b;
};

/**
 * A person decides a bug's severity (or takes the decision back with null). Saves who, which account, when and why, and logs it. Only a change is saved and logged;
 * the same value again is nothing. Runs inside the caller's transaction.
 */
function decideSeverity(id: number, to: Sev | null, reason?: string) {
  const b = db.prepare("SELECT human_severity, agent_severity, source FROM bug_reports WHERE id = ?").get(id) as Record<string, any>;
  const from = b.human_severity as Sev | null;
  if (from === to) return;
  const who = actorName();
  db.prepare("UPDATE bug_reports SET human_severity = ?, severity_by = ?, severity_by_user_id = ?, severity_at = datetime('now'), severity_reason = ? WHERE id = ?")
    .run(to, who, actorUserId(), to ? reason ?? "" : "", id);
  const before = from ?? (b.agent_severity as string | null);
  const what = to === null ? `Severity decision removed (back to the suggestion ${sevWord(b.agent_severity)}), ${who}`
    : !from && to === b.agent_severity ? `Severity ${sevWord(to)} (${b.source === "ci" ? "default from CI" : "AI suggestion"}) confirmed, ${who}`
    : `Severity ${sevWord(before)} → ${sevWord(to)}, ${who}`;
  addEvent(id, "user", "severity", reason ? `${what}: ${reason}` : what);
}

/** A human edits the working copy. The agent's version stays in the revisions; a later import will not overwrite this. */
export function updateBugReport(id: number, patch: { title?: string; description?: string; steps?: string[]; expected?: string; actual?: string; environment?: string; url?: string; humanSeverity?: Sev | null; severityReason?: string }) {
  exists(id);
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [col, v] of [["title", patch.title], ["description", patch.description], ["expected", patch.expected], ["actual", patch.actual], ["environment", patch.environment], ["url", patch.url]] as const) {
    if (v !== undefined) { sets.push(`${col} = ?`); args.push(v); }
  }
  if (patch.steps !== undefined) { sets.push("steps = ?"); args.push(JSON.stringify(patch.steps)); }
  if (!sets.length && patch.humanSeverity === undefined) throw new AuditError(400, "Nothing to change");
  db.transaction(() => {
    // The severity is a decision of its own: it is saved with who and why, and it does not count as an edit of the text (edited_at guards the text against a later import).
    if (sets.length) db.prepare(`UPDATE bug_reports SET ${sets.join(", ")}, edited_at = datetime('now') WHERE id = ?`).run(...args, id);
    if (patch.humanSeverity !== undefined) decideSeverity(id, patch.humanSeverity, patch.severityReason);
  })();
}

/**
 * Only a person calls this. Confirming does not publish anything anywhere. When the person confirms with a severity (the one the screen showed, or one they changed),
 * it is saved as their decision together with the confirmation, or neither is saved.
 */
export function reviewBugReport(id: number, status: "proposed" | "accepted" | "rejected", note?: string, severity?: { value: Sev; reason?: string }) {
  const current = exists(id);
  // A confirmed bug is not restored to Suggested: restoring is for what was dismissed (or marked a duplicate by mistake).
  if (status === "proposed" && current.review_status === "accepted") throw new AuditError(409, "This is a confirmed bug. It cannot be moved back to Suggested.");
  if (severity && status !== "accepted") throw new AuditError(400, "A severity is decided when the bug is confirmed");
  db.transaction(() => {
    db.prepare(`UPDATE bug_reports SET review_status = ?, reviewed_at = CASE WHEN ? = 'proposed' THEN NULL ELSE datetime('now') END,
        review_note = COALESCE(?, review_note), duplicate_of_id = NULL, reviewed_by = ?, reviewed_by_user_id = ? WHERE id = ?`).run(status, status, note ?? null, actorName(), actorUserId(), id);
    if (severity) decideSeverity(id, severity.value, severity.reason);
  })();
}

/** Records that this report is the same bug as another report of the project. Nothing is merged. */
export function markDuplicate(id: number, ofId: number, note?: string) {
  const b = exists(id);
  if (id === ofId) throw new AuditError(400, "A report cannot be a duplicate of itself");
  const other = exists(ofId);
  if (other.project_id !== b.project_id) throw new AuditError(400, "That report is in another project");
  const target = db.prepare("SELECT duplicate_of_id FROM bug_reports WHERE id = ?").get(ofId) as { duplicate_of_id: number | null };
  if (target.duplicate_of_id === id) throw new AuditError(400, "That report is already marked as a duplicate of this one");
  db.prepare("UPDATE bug_reports SET review_status = 'duplicate', duplicate_of_id = ?, reviewed_at = datetime('now'), review_note = COALESCE(?, review_note), reviewed_by = ?, reviewed_by_user_id = ? WHERE id = ?").run(ofId, note ?? null, actorName(), actorUserId(), id);
}

/** Notes that an existing issue in Jira, Linear or elsewhere already covers this report. Nothing is sent to that system. */
export function linkExternalIssue(id: number, input: { destination: "jira" | "linear" | "other"; url: string; externalId?: string }) {
  exists(id);
  let host: string;
  try {
    const u = new URL(input.url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    host = u.host;
  } catch {
    throw new AuditError(400, "The link must be a web address (https://...)");
  }
  try {
    return db.prepare("INSERT INTO bug_publications (bug_report_id, destination, destination_ref, mode, state, external_id, external_url, completed_at) VALUES (?, ?, ?, 'linked_existing', 'sent', ?, ?, datetime('now')) RETURNING id")
      .get(id, input.destination, host, (input.externalId ?? "").slice(0, 100), input.url.slice(0, 2000)) as { id: number };
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) throw new AuditError(409, `This report is already linked to an issue in ${host}.`);
    throw e;
  }
}

export function unlinkExternalIssue(publicationId: number) {
  const p = db.prepare("SELECT mode FROM bug_publications WHERE id = ?").get(publicationId) as { mode: string } | undefined;
  if (!p) throw new AuditError(404, "Link not found");
  if (p.mode !== "linked_existing") throw new AuditError(400, "Only links to existing issues can be removed here");
  db.prepare("DELETE FROM bug_publications WHERE id = ?").run(publicationId);
}

/** A person chooses the agent's newer version over the current working copy. Review status and links to external issues stay. */
export function applyPendingUpdate(id: number) {
  const b = db.prepare("SELECT project_id, applied_rev, latest_rev FROM bug_reports WHERE id = ?").get(id) as { project_id: number; applied_rev: number; latest_rev: number } | undefined;
  if (!b) throw new AuditError(404, "Bug report not found");
  if (!(b.latest_rev > b.applied_rev)) throw new AuditError(400, "There is no newer version to apply");
  const rev = db.prepare("SELECT payload FROM bug_revisions WHERE bug_report_id = ? AND rev = ?").get(id, b.latest_rev) as { payload: string };
  const p = json<Payload>(rev.payload, null as unknown as Payload);
  const project = db.prepare("SELECT key FROM projects WHERE id = ?").get(b.project_id) as { key: string };
  const drop: string[] = [];
  db.transaction(() => {
    db.prepare(`UPDATE bug_reports SET title = ?, description = ?, steps = ?, expected = ?, actual = ?, environment = ?, url = ?, tool_impact = ?, agent_severity = ?,
        confidence = ?, agent_review = ?, found_at = ?, fingerprint = ?, recurrence_hint = ?, applied_rev = ? WHERE id = ?`)
      .run(p.title, p.description, JSON.stringify(p.steps), p.expected, p.actual, p.environment, p.url, p.toolImpact ? JSON.stringify(p.toolImpact) : null, p.agentSeverity,
        p.confidence, p.agentReview ? JSON.stringify(p.agentReview) : null, toSqlDate(p.foundAt), p.fingerprint, p.recurrenceOf, b.latest_rev, id);
    replaceRefs(id, resolveRefs(b.project_id, project.key, p.refs));
    const keep = new Set(p.evidence.map((e) => attKey(e.path, e.sha256)));
    for (const r of db.prepare("SELECT id, declared_path, sha256, stored_name FROM bug_attachments WHERE bug_report_id = ?").all(id) as { id: number; declared_path: string; sha256: string | null; stored_name: string | null }[]) {
      if (keep.has(attKey(r.declared_path, r.sha256))) db.prepare("UPDATE bug_attachments SET active = 1 WHERE id = ?").run(r.id);
      else { db.prepare("DELETE FROM bug_attachments WHERE id = ?").run(r.id); if (r.stored_name) drop.push(r.stored_name); }
    }
    linkBugRun(id);
  })();
  removeFiles(drop);
}

/** A person keeps the current working copy. The same newer version will not be flagged again. */
export function ignorePendingUpdate(id: number) {
  const b = db.prepare("SELECT latest_rev FROM bug_reports WHERE id = ?").get(id) as { latest_rev: number } | undefined;
  if (!b) throw new AuditError(404, "Bug report not found");
  const drop: string[] = [];
  db.transaction(() => {
    db.prepare("UPDATE bug_reports SET ignored_rev = ? WHERE id = ?").run(b.latest_rev, id);
    // Evidence that only belonged to the ignored version is not kept.
    for (const r of db.prepare("SELECT id, stored_name FROM bug_attachments WHERE bug_report_id = ? AND active = 0").all(id) as { id: number; stored_name: string | null }[]) {
      db.prepare("DELETE FROM bug_attachments WHERE id = ?").run(r.id);
      if (r.stored_name) drop.push(r.stored_name);
    }
  })();
  removeFiles(drop);
}

// ---------- Deleting ----------

/** Names of the files a report owns, for deletion by the caller. */
export function bugFiles(bugIds: number[]): string[] {
  if (!bugIds.length) return [];
  return (db.prepare(`SELECT stored_name FROM bug_attachments WHERE stored_name IS NOT NULL AND bug_report_id IN (${bugIds.map(() => "?").join(",")})`).all(...bugIds) as { stored_name: string }[]).map((r) => r.stored_name);
}

export function deleteBugReport(id: number, force = false) {
  const b = exists(id);
  const guarded = b.review_status === "accepted" || hasPublication(id);
  if (guarded && !force) throw new AuditError(409, "This report is accepted or linked to an external issue. Confirm to delete it here (the external issue is not touched).");
  const files = bugFiles([id]);
  db.prepare("DELETE FROM bug_reports WHERE id = ?").run(id);
  removeFiles(files);
}

/** Which reports an audit deletion would remove and which it would keep. Only untouched proposals go; reviewed, edited or linked ones stay. */
/** The plan of one audit for its view (plan items, coverage gaps and the requirements they name, matched as they are now). */
export function getAuditPlan(auditId: number) {
  const p = auditPlan(auditId);
  if (!p) throw new AuditError(404, "Audit not found");
  return p;
}
export function previewAuditDeletion(auditId: number) {
  const a = db.prepare("SELECT id, title FROM audits WHERE id = ?").get(auditId) as { id: number; title: string } | undefined;
  if (!a) throw new AuditError(404, "Audit not found");
  const bugs = db.prepare("SELECT id, review_status, edited_at FROM bug_reports WHERE audit_id = ?").all(auditId) as { id: number; review_status: string; edited_at: string | null }[];
  const removable = bugs.filter((b) => b.review_status === "proposed" && !b.edited_at && !hasPublication(b.id));
  const manual = manualTestsOfAudit(auditId);
  return {
    title: a.title, removable: removable.map((b) => b.id), deleted: removable.length, kept: bugs.length - removable.length,
    manualRemovable: manual.removable, manualDeleted: manual.deleted, manualKept: manual.kept,
    plan: planCounts(auditId),
  };
}

export function deleteAudit(auditId: number) {
  const prev = previewAuditDeletion(auditId);
  const files = bugFiles(prev.removable);
  const narrative = (db.prepare("SELECT narrative_stored_name FROM audits WHERE id = ?").get(auditId) as { narrative_stored_name: string | null }).narrative_stored_name;
  db.transaction(() => {
    for (const id of prev.removable) db.prepare("DELETE FROM bug_reports WHERE id = ?").run(id);
    for (const id of prev.manualRemovable) db.prepare("DELETE FROM manual_tests WHERE id = ?").run(id);
    db.prepare("UPDATE manual_tests SET audit_id = NULL WHERE audit_id = ?").run(auditId);
    // The rest stay as standalone reports (audit_id becomes NULL); their origin and evidence are on the reports themselves.
    db.prepare("UPDATE bug_reports SET audit_id = NULL WHERE audit_id = ?").run(auditId);
    db.prepare("DELETE FROM audits WHERE id = ?").run(auditId);
  })();
  removeFiles([...files, ...(narrative ? [narrative] : [])]);
  return { deleted: prev.deleted, kept: prev.kept, manualDeleted: prev.manualDeleted, manualKept: prev.manualKept };
}

/** Files that belong to audits and bug reports of a project, for project deletion. */
export function projectAuditFiles(projectId: number): string[] {
  const att = db.prepare("SELECT a.stored_name FROM bug_attachments a JOIN bug_reports b ON b.id = a.bug_report_id WHERE b.project_id = ? AND a.stored_name IS NOT NULL").all(projectId) as { stored_name: string }[];
  const nar = db.prepare("SELECT narrative_stored_name AS stored_name FROM audits WHERE project_id = ? AND narrative_stored_name IS NOT NULL").all(projectId) as { stored_name: string }[];
  return [...att, ...nar].map((r) => r.stored_name);
}
