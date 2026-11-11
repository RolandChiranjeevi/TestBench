import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db, UPLOAD_DIR } from "./db.ts";
import { getBugReport, SEVERITY_WORD } from "./audits.ts";
import { attachFile, createIssueWithId, findIssue, LinearError, linearPriority, listTeams, resolveTeam, type LinearCreated, type LinearTeam } from "./linear.ts";
import { seal, tokenHint, unseal } from "./secrets.ts";

/**
 * Publishing an accepted bug report to the project's destination (Linear first). Nothing here runs by itself: a person asks for the
 * preview, reads it, approves exactly that preview, and only then is anything sent. Accepting a report never calls into this file.
 *
 * Duplicates: the Linear issue is created under an id Testbench picks and stores before sending (idempotency_key). If the answer is
 * unclear (timeout, broken connection, server error) the publication stays "unknown" with that id; checking asks Linear whether an issue
 * with the id exists, and publishing again reuses the same id, so the same report can never become two issues.
 */

export class PublishError extends Error {
  constructor(public status: 400 | 404 | 409 | 502, message: string) {
    super(message);
  }
}

export const LINEAR_BASE_URL = "https://api.linear.app/graphql";
const MAX_TITLE = 255;
const MAX_DESCRIPTION = 50_000;
/** Our own limits for what is uploaded with an issue. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

interface DestRow { project_id: number; kind: string; base_url: string; team_id: string; team_key: string; team_name: string; token_enc: string | null; token_hint: string }
interface PubRow {
  id: number; bug_report_id: number; destination: string; destination_ref: string; mode: string; state: string; idempotency_key: string | null;
  preview_hash: string | null; external_id: string; external_url: string; error: string; attachments_state: string; content_sent: string; created_at: string; completed_at: string | null;
}

const linearEnv = (token: string) => ({ LINEAR_API_KEY: token }) as NodeJS.ProcessEnv;
const json = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

function asPublishError(e: unknown): PublishError {
  if (e instanceof PublishError) return e;
  if (e instanceof LinearError) return new PublishError(e.status === 502 ? 502 : 400, e.message);
  return new PublishError(502, (e as Error).message);
}

// ---------- The destination of a project ----------

export interface DestinationView {
  kind: "linear";
  baseUrl: string;
  team: { id: string; key: string; name: string };
  /** stored: a key entered for this project. environment: the server's LINEAR_API_KEY. unreadable: a stored key this installation cannot open. none: no key. */
  tokenSource: "stored" | "environment" | "unreadable" | "none";
  /** Last four characters of the stored key; never the key. */
  tokenHint: string;
  ready: boolean;
}

const destRow = (projectId: number) => db.prepare("SELECT * FROM project_destinations WHERE project_id = ?").get(projectId) as DestRow | undefined;

function authFor(row: DestRow, env: NodeJS.ProcessEnv): { token: string; source: "stored" | "environment" } | { token: null; source: "unreadable" | "none" } {
  if (row.token_enc) {
    const t = unseal(row.token_enc);
    return t ? { token: t, source: "stored" } : { token: null, source: "unreadable" };
  }
  const fromEnv = env.LINEAR_API_KEY?.trim();
  return fromEnv ? { token: fromEnv, source: "environment" } : { token: null, source: "none" };
}

function view(row: DestRow, env: NodeJS.ProcessEnv): DestinationView {
  const a = authFor(row, env);
  return {
    kind: "linear", baseUrl: row.base_url, team: { id: row.team_id, key: row.team_key, name: row.team_name },
    tokenSource: a.source, tokenHint: a.source === "stored" ? row.token_hint : "", ready: !!a.token,
  };
}

export function getDestination(projectId: number, env: NodeJS.ProcessEnv = process.env): DestinationView | null {
  const row = destRow(projectId);
  return row ? view(row, env) : null;
}

const projectExists = (projectId: number) => {
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new PublishError(404, "Project not found");
};

/** The key to try: one just typed, else the one stored for the project, else the server's. */
function tokenToTry(projectId: number, typed: string | undefined, env: NodeJS.ProcessEnv): string {
  const t = typed?.trim();
  if (t) return t;
  const row = destRow(projectId);
  const a = row ? authFor(row, env) : env.LINEAR_API_KEY?.trim() ? { token: env.LINEAR_API_KEY.trim() } : { token: null };
  if (!a.token) throw new PublishError(400, "Enter a Linear API key (Linear: Settings, Account, Security & access), or set LINEAR_API_KEY on the server.");
  return a.token;
}

/** Checks a key and returns the teams it can see, so one can be chosen. Nothing is saved. */
export async function lookupTeams(projectId: number, typedToken: string | undefined, f: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): Promise<LinearTeam[]> {
  projectExists(projectId);
  try {
    return await listTeams(f, linearEnv(tokenToTry(projectId, typedToken, env)));
  } catch (e) {
    throw asPublishError(e);
  }
}

export async function saveDestination(
  projectId: number,
  input: { token?: string; team?: string },
  f: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DestinationView> {
  projectExists(projectId);
  const existing = destRow(projectId);
  const typed = input.token?.trim() || undefined;
  const token = tokenToTry(projectId, typed, env);
  let team: LinearTeam;
  try {
    team = resolveTeam(await listTeams(f, linearEnv(token)), input.team ?? existing?.team_id, null);
  } catch (e) {
    throw asPublishError(e);
  }
  const enc = typed ? seal(typed) : (existing?.token_enc ?? null);
  const hint = typed ? tokenHint(typed) : (existing?.token_hint ?? "");
  db.prepare(`INSERT INTO project_destinations (project_id, kind, base_url, team_id, team_key, team_name, token_enc, token_hint, updated_at)
      VALUES (?, 'linear', ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(project_id) DO UPDATE SET kind = 'linear', base_url = excluded.base_url, team_id = excluded.team_id, team_key = excluded.team_key,
        team_name = excluded.team_name, token_enc = excluded.token_enc, token_hint = excluded.token_hint, updated_at = datetime('now')`)
    .run(projectId, LINEAR_BASE_URL, team.id, team.key, team.name, enc, hint);
  return getDestination(projectId, env)!;
}

export function removeDestination(projectId: number) {
  db.prepare("DELETE FROM project_destinations WHERE project_id = ?").run(projectId);
}

// ---------- Preview ----------

export interface PreviewOptions { refIds?: number[]; attachmentIds?: number[] }

export interface Preview {
  bugId: number;
  destination: { kind: "linear"; label: string; baseUrl: string; team: { id: string; key: string; name: string } } | null;
  title: string;
  description: string;
  priority: { severity: string | null; value: number; label: string; mapping: string };
  refs: { id: number; kind: string; label: string; state: string; included: boolean; sendable: boolean }[];
  attachments: { id: number; filename: string; mime: string; size: number; included: boolean; sendable: boolean; reason: string }[];
  warnings: string[];
  /** Why it cannot be published right now; empty when it can. */
  blockers: string[];
  canPublish: boolean;
  /** Covers everything that would be sent. Publishing must present the hash of the preview that was approved. */
  hash: string;
}

const KIND_LABEL: Record<string, string> = { requirement: "Requirement", case: "Test case", test: "Automated test" };
const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

function compose(d: ReturnType<typeof getBugReport>, refs: { kind: string; label: string }[], files: { filename: string; mime: string; size: number }[]): string {
  const out: string[] = [];
  if (d.description.trim()) out.push(d.description.trim(), "");
  if (d.steps.length) out.push("**Steps to reproduce**", ...d.steps.map((s, i) => `${i + 1}. ${s}`), "");
  if (d.expected.trim()) out.push("**Expected result**", d.expected.trim(), "");
  if (d.actual.trim()) out.push("**Actual result**", d.actual.trim(), "");
  const where = [d.environment && `**Environment:** ${d.environment}`, d.url && `**URL:** ${d.url}`].filter(Boolean) as string[];
  if (where.length) out.push(...where, "");
  if (refs.length) out.push("**Related in Testbench**", ...refs.map((r) => `- ${KIND_LABEL[r.kind] ?? r.kind}: ${r.label}`), "");
  if (files.length) out.push("**Evidence (attached to this issue)**", ...files.map((f) => `- ${f.filename} (${f.mime || "file"}, ${fmtSize(f.size)})`), "");
  out.push(`_Source: Testbench audit ${d.originAuditId}, report ${d.sourceId}. Accepted by a person in Testbench before it was sent._`);
  return out.join("\n").trim();
}

export function buildPreview(bugId: number, opts: PreviewOptions = {}, env: NodeJS.ProcessEnv = process.env): Preview {
  let d: ReturnType<typeof getBugReport>;
  try {
    d = getBugReport(bugId);
  } catch {
    throw new PublishError(404, "Bug report not found");
  }
  const dest = destRow(d.projectId);
  const dv = dest ? view(dest, env) : null;

  const refs = d.refs.map((r) => {
    const sendable = r.state === "resolved" && !!r.target;
    return { id: r.id, kind: r.kind, label: r.label, state: r.state, sendable, included: false };
  });
  const wantedRefs = opts.refIds ? new Set(opts.refIds) : null;
  for (const id of wantedRefs ?? []) if (!refs.some((r) => r.id === id && r.sendable)) throw new PublishError(400, `Reference ${id} is not one of this report's links that can be sent.`);
  for (const r of refs) r.included = r.sendable && (wantedRefs ? wantedRefs.has(r.id) : true);

  const atts = d.attachments.filter((a) => a.active).map((a) => {
    let reason = "";
    if (a.state !== "stored" || !a.stored_name) reason = `not stored (${a.state})`;
    else if (a.size > MAX_ATTACHMENT_BYTES) reason = `larger than ${fmtSize(MAX_ATTACHMENT_BYTES)}`;
    return { id: a.id, filename: a.filename, mime: a.mime, size: a.size, sha256: a.sha256 as string | null, included: false, sendable: !reason, reason };
  });
  const wantedAtts = opts.attachmentIds ? new Set(opts.attachmentIds) : null;
  for (const id of wantedAtts ?? []) if (!atts.some((a) => a.id === id && a.sendable)) throw new PublishError(400, `File ${id} cannot be sent with this report.`);
  let taken = 0;
  for (const a of atts) {
    if (!a.sendable) continue;
    if (wantedAtts ? wantedAtts.has(a.id) : true) {
      if (taken >= MAX_ATTACHMENTS) {
        if (wantedAtts) throw new PublishError(400, `At most ${MAX_ATTACHMENTS} files can be sent with one issue.`);
        a.sendable = false;
        a.reason = `only the first ${MAX_ATTACHMENTS} files are sent`;
      } else {
        a.included = true;
        taken++;
      }
    }
  }

  const priority = linearPriority(d.severity.effective);
  const title = d.title.trim();
  const description = compose(d, refs.filter((r) => r.included), atts.filter((a) => a.included));

  const blockers: string[] = [];
  const warnings: string[] = [];
  if (d.status !== "accepted") blockers.push(`Only reports you have accepted can be published. This one is "${d.status}".`);
  if (!dv) blockers.push("This project has no publishing destination yet. Set one up first.");
  else if (dv.tokenSource === "unreadable") blockers.push("The Linear key stored for this project cannot be read here (for example after restoring a backup). Enter the key again.");
  else if (!dv.ready) blockers.push("No Linear API key is available for this project. Enter one in the destination settings.");
  if (!title) blockers.push("The report has no title.");
  if (title.length > MAX_TITLE) blockers.push(`The title is longer than ${MAX_TITLE} characters. Shorten it before publishing.`);
  if (description.length > MAX_DESCRIPTION) blockers.push("The description is too long to send.");
  for (const p of d.publications as { id: number; destination: string; destination_ref: string; mode: string; state: string; external_id: string; external_url: string }[]) {
    if (p.destination !== "linear") continue;
    if (p.mode === "linked_existing") blockers.push(`This report is already linked to a Linear issue (${p.external_url}). Remove that link first if you want to publish a new one.`);
    else if (p.state === "sent") blockers.push(`Already published as ${p.external_id || p.external_url}.`);
    else if (p.state === "pending" && inflight.has(p.id)) blockers.push("This report is being published right now.");
    else if (["pending", "unknown", "failed"].includes(p.state) && p.destination_ref === dest?.team_id) {
      warnings.push("An earlier attempt may already have created the issue. Testbench asks Linear for it first, and reuses the same id, so no second issue is made.");
    }
  }
  if (d.severity.effective && d.severity.source !== "human") {
    warnings.push(`The severity (${SEVERITY_WORD[d.severity.effective] ?? d.severity.effective}) is only ${d.severity.source === "ci_default" ? "a default from CI" : "an AI suggestion"}. Nobody has decided it yet. It is still what is sent.`);
  }
  if (d.pendingUpdate) warnings.push("A newer version from the agent is waiting. This publishes the current working copy.");
  const unsent = refs.filter((r) => !r.sendable).length;
  if (unsent) warnings.push(`${unsent} link${unsent === 1 ? "" : "s"} cannot be sent because the target was not found in this project.`);
  const skipped = atts.filter((a) => !a.sendable).length;
  if (skipped) warnings.push(`${skipped} file${skipped === 1 ? "" : "s"} will not be sent (see the reason next to each).`);

  const hash = sha(JSON.stringify({ v: 1, team: dest?.team_id ?? null, title, description, priority: priority.value, files: atts.filter((a) => a.included).map((a) => [a.id, a.sha256]) }));
  return {
    bugId, title, description, warnings, blockers, canPublish: blockers.length === 0, hash,
    destination: dv ? { kind: "linear", label: "Linear", baseUrl: dv.baseUrl, team: dv.team } : null,
    priority: { severity: d.severity.effective, value: priority.value, label: priority.label, mapping: `${d.severity.effective ?? "no severity"} → Linear priority ${priority.label} (${priority.value})` },
    refs: refs.map(({ id, kind, label, state, included, sendable }) => ({ id, kind, label, state, included, sendable })),
    attachments: atts.map(({ id, filename, mime, size, included, sendable, reason }) => ({ id, filename, mime, size, included, sendable, reason })),
  };
}

// ---------- Publishing ----------

const inflight = new Set<number>();

export interface PublicationView {
  id: number; state: string; mode: string; externalId: string; externalUrl: string; error: string; destination: string;
  attachments: Record<string, string>; createdAt: string; completedAt: string | null; content: Record<string, any> | null;
}

export function publicationView(id: number): PublicationView {
  const p = db.prepare("SELECT * FROM bug_publications WHERE id = ?").get(id) as PubRow | undefined;
  if (!p) throw new PublishError(404, "Publication not found");
  return {
    id: p.id, state: p.state === "pending" && !inflight.has(p.id) ? "unknown" : p.state, mode: p.mode, externalId: p.external_id, externalUrl: p.external_url, error: p.error,
    destination: p.destination, attachments: json(p.attachments_state, {}), createdAt: p.created_at, completedAt: p.completed_at, content: json(p.content_sent, null),
  };
}

const latestCreated = (bugId: number, teamId: string) =>
  db.prepare("SELECT * FROM bug_publications WHERE bug_report_id = ? AND destination = 'linear' AND mode = 'created' AND destination_ref = ? ORDER BY id DESC LIMIT 1").get(bugId, teamId) as PubRow | undefined;

function markSent(id: number, issue: LinearCreated) {
  db.prepare("UPDATE bug_publications SET state = 'sent', external_id = ?, external_url = ?, error = '', completed_at = datetime('now') WHERE id = ?").run(issue.identifier, issue.url, id);
}

async function sendAttachments(pubId: number, issueId: string, ids: number[], f: typeof fetch, env: NodeJS.ProcessEnv) {
  const state = json<Record<string, string>>((db.prepare("SELECT attachments_state FROM bug_publications WHERE id = ?").get(pubId) as { attachments_state: string }).attachments_state, {});
  const bugId = (db.prepare("SELECT bug_report_id FROM bug_publications WHERE id = ?").get(pubId) as { bug_report_id: number }).bug_report_id;
  for (const id of ids) {
    const a = db.prepare("SELECT filename, mime, stored_name FROM bug_attachments WHERE id = ? AND bug_report_id = ? AND state = 'stored'").get(id, bugId) as { filename: string; mime: string; stored_name: string | null } | undefined;
    try {
      if (!a?.stored_name) throw new Error("the file is no longer stored");
      await attachFile({ issueId, filename: a.filename, contentType: a.mime || "application/octet-stream", bytes: readFileSync(join(UPLOAD_DIR, a.stored_name)) }, f, env);
      state[String(id)] = "ok";
    } catch (e) {
      state[String(id)] = `failed: ${(e as Error).message}`.slice(0, 300);
    }
    db.prepare("UPDATE bug_publications SET attachments_state = ? WHERE id = ?").run(JSON.stringify(state), pubId);
  }
}

/**
 * Creates the Linear issue for an accepted report. Needs the explicit approval and the hash of the preview that was approved; if the
 * report or the selection changed since, it is refused and the person has to look at the new preview.
 */
export async function publishBug(
  bugId: number,
  input: PreviewOptions & { previewHash: string; approve: boolean },
  f: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PublicationView> {
  if (input.approve !== true) throw new PublishError(400, "Publishing needs your explicit approval of the preview.");
  const p = buildPreview(bugId, input, env);
  if (p.blockers.length) throw new PublishError(409, p.blockers[0]);
  if (p.hash !== input.previewHash) throw new PublishError(409, "The report or your selection changed after the preview was made. Look at the new preview and approve it again.");

  const projectId = (db.prepare("SELECT project_id FROM bug_reports WHERE id = ?").get(bugId) as { project_id: number }).project_id;
  const dest = destRow(projectId)!;
  const auth = authFor(dest, env);
  if (!auth.token) throw new PublishError(400, "No Linear API key is available for this project.");
  const e = linearEnv(auth.token);
  const sendIds = p.attachments.filter((a) => a.included).map((a) => a.id);
  const content = JSON.stringify({
    title: p.title, description: p.description, priority: p.priority, team: p.destination!.team, previewHash: p.hash,
    refs: p.refs.filter((r) => r.included).map((r) => r.label),
    attachments: p.attachments.filter((a) => a.included).map((a) => ({ id: a.id, filename: a.filename, size: a.size })),
    approvedAt: new Date().toISOString(),
  });

  let row = latestCreated(bugId, dest.team_id);
  let reused = false;
  let previous = "unknown";
  if (row && row.state === "sent") throw new PublishError(409, `Already published as ${row.external_id}.`);
  if (row && inflight.has(row.id)) throw new PublishError(409, "This report is being published right now.");
  if (row) {
    reused = true;
    previous = row.state === "failed" ? "failed" : "unknown";
    db.prepare("UPDATE bug_publications SET state = 'pending', preview_hash = ?, content_sent = ?, error = '' WHERE id = ?").run(p.hash, content, row.id);
  } else {
    try {
      row = db.prepare(`INSERT INTO bug_publications (bug_report_id, destination, destination_ref, mode, state, idempotency_key, preview_hash, content_sent)
          VALUES (?, 'linear', ?, 'created', 'pending', ?, ?, ?) RETURNING *`).get(bugId, dest.team_id, randomUUID(), p.hash, content) as PubRow;
    } catch (err) {
      if (/UNIQUE/i.test((err as Error).message)) throw new PublishError(409, "This report is already being published or has been published.");
      throw err;
    }
  }
  const pub = row!;
  inflight.add(pub.id);
  let issue: LinearCreated | null = null;
  try {
    // A row that is being reused may belong to an attempt that did go through: look for its issue before creating anything.
    if (reused) issue = await findIssue(pub.idempotency_key!, f, e);
    if (!issue) issue = await createIssueWithId({ id: pub.idempotency_key!, teamId: dest.team_id, title: p.title, description: p.description, priority: p.priority.value }, f, e);
    markSent(pub.id, issue);
  } catch (err) {
    const outcome = err instanceof LinearError ? (err.outcome ?? "unknown") : "unknown";
    const msg = err instanceof LinearError ? err.message : (err as Error).message;
    if (outcome === "rejected") {
      // Linear said no: nothing was created. A first attempt leaves no local record; a reused row goes back to what it was.
      if (!reused) db.prepare("DELETE FROM bug_publications WHERE id = ?").run(pub.id);
      else db.prepare("UPDATE bug_publications SET state = ?, error = ? WHERE id = ?").run(previous, msg.slice(0, 500), pub.id);
      throw asPublishError(err);
    }
    db.prepare("UPDATE bug_publications SET state = 'unknown', error = ? WHERE id = ?").run(msg.slice(0, 500), pub.id);
    throw new PublishError(502, `${msg} Linear may already have created the issue. Use "Check status" before trying again; Testbench will not create another issue by itself.`);
  } finally {
    inflight.delete(pub.id);
  }
  // The issue exists. Files that fail now do not undo it; they are listed per file and can be retried.
  await sendAttachments(pub.id, pub.idempotency_key!, sendIds, f, e);
  return publicationView(pub.id);
}

/** Asks Linear whether the issue of an unfinished publication exists. Never creates anything. */
export async function checkPublication(pubId: number, f: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): Promise<PublicationView> {
  const pub = db.prepare("SELECT p.*, b.project_id FROM bug_publications p JOIN bug_reports b ON b.id = p.bug_report_id WHERE p.id = ?").get(pubId) as (PubRow & { project_id: number }) | undefined;
  if (!pub) throw new PublishError(404, "Publication not found");
  if (pub.mode !== "created" || !pub.idempotency_key) throw new PublishError(400, "Only a publication made from Testbench can be checked.");
  if (pub.state === "sent") return publicationView(pubId);
  if (inflight.has(pub.id)) throw new PublishError(409, "This report is being published right now.");
  const dest = destRow(pub.project_id);
  const auth = dest ? authFor(dest, env) : null;
  if (!auth?.token) throw new PublishError(400, "No Linear API key is available for this project.");
  let issue: LinearCreated | null;
  try {
    issue = await findIssue(pub.idempotency_key, linearFetch(f), linearEnv(auth.token));
  } catch (err) {
    throw asPublishError(err);
  }
  if (issue) markSent(pub.id, issue);
  else db.prepare("UPDATE bug_publications SET state = 'failed', error = ? WHERE id = ?").run("Linear has no issue with this id, so nothing was created. Publishing again reuses the same id.", pub.id);
  return publicationView(pubId);
}

const linearFetch = (f: typeof fetch) => f;

/** Tries again the files of a published issue that did not go through. */
export async function retryAttachments(pubId: number, f: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): Promise<PublicationView> {
  const pub = db.prepare("SELECT p.*, b.project_id FROM bug_publications p JOIN bug_reports b ON b.id = p.bug_report_id WHERE p.id = ?").get(pubId) as (PubRow & { project_id: number }) | undefined;
  if (!pub) throw new PublishError(404, "Publication not found");
  if (pub.mode !== "created" || pub.state !== "sent" || !pub.idempotency_key) throw new PublishError(400, "Files can only be retried for an issue that was published from Testbench.");
  const dest = destRow(pub.project_id);
  const auth = dest ? authFor(dest, env) : null;
  if (!auth?.token) throw new PublishError(400, "No Linear API key is available for this project.");
  const failed = Object.entries(json<Record<string, string>>(pub.attachments_state, {})).filter(([, v]) => v !== "ok").map(([k]) => Number(k));
  if (!failed.length) throw new PublishError(400, "Every file has already been attached.");
  await sendAttachments(pub.id, pub.idempotency_key, failed, f, linearEnv(auth.token));
  return publicationView(pubId);
}
