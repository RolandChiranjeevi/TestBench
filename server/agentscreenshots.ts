import { db } from "./db.ts";
import { AuditError } from "./auditcommon.ts";
import { audit } from "./accounts.ts";

/**
 * Screenshots of a bug that a discover found (plan step 3b): the agent hands in at most two pictures for each bug report it made, one taken before the step that fails and one
 * when the bug shows. A picture is evidence for a person and is never analysed. The rules:
 *  - only the request token that took the request, only while it is taken, and only a discover;
 *  - only a bug report this request made itself (its origin is `$agent-<request>`): a bug that was seen again belongs to an earlier request and gets no new pictures;
 *  - at most one `before` and one `bug` per bug report, and at most SCREENSHOT_LIMITS.perRequest pictures per request;
 *  - the bytes are checked by the route with checkScreenshot (png, jpg, webp or gif by its first bytes, at most 5 MB) before this is called.
 * The picture is stored like a person's attachment, so it shows on the bug report with its label.
 */
export const SCREENSHOT_LIMITS = { perRequest: 200, perMinute: 120 };
export const SCREENSHOT_LABELS = { before: "Screenshot before", bug: "Screenshot when the bug shows" } as const;
export type ScreenshotLabel = keyof typeof SCREENSHOT_LABELS;

export function addBugScreenshot(projectId: number, requestId: number, bugId: number, token: { id: number; name: string }, ip: string, label: ScreenshotLabel,
  shot: { storedName: string; mime: string; size: number; sha256: string; ext: string }) {
  return db.transaction(() => {
    const r = db.prepare("SELECT kind, status, claimed_token_id FROM agent_requests WHERE id = ? AND project_id = ?").get(requestId, projectId) as
      { kind: string; status: string; claimed_token_id: number | null } | undefined;
    if (!r) throw new AuditError(404, "Request not found");
    if (r.kind !== "discover") throw new AuditError(409, "Screenshots can only be handed in for a bug report of a discover request");
    if (r.status === "pending") throw new AuditError(409, "The request is not taken. Take it first");
    if (r.status !== "claimed") throw new AuditError(409, "The request is already done or cancelled");
    if (r.claimed_token_id !== token.id) throw new AuditError(409, "Another token took this request");
    const origin = `$agent-${requestId}`;
    const bug = db.prepare("SELECT id, source_id FROM bug_reports WHERE id = ? AND project_id = ? AND origin_audit_id = ?").get(bugId, projectId, origin) as { id: number; source_id: string } | undefined;
    if (!bug) throw new AuditError(404, "Bug report not found among the bug reports this request made (a bug that was seen again keeps the pictures it has)");
    const name = SCREENSHOT_LABELS[label];
    if (db.prepare("SELECT 1 FROM bug_attachments WHERE bug_report_id = ? AND label = ?").get(bugId, name)) throw new AuditError(409, `This bug report already has its picture "${label}"`);
    const onRequest = db.prepare("SELECT COUNT(*) FROM bug_attachments a JOIN bug_reports b ON b.id = a.bug_report_id WHERE b.project_id = ? AND b.origin_audit_id = ? AND a.label IN (?, ?)")
      .pluck().get(projectId, origin, SCREENSHOT_LABELS.before, SCREENSHOT_LABELS.bug) as number;
    if (onRequest >= SCREENSHOT_LIMITS.perRequest) throw new AuditError(409, `This request already has ${SCREENSHOT_LIMITS.perRequest} screenshots, the most one request can hand in`);
    const filename = `${bug.source_id}-${label}.${shot.ext}`;
    const id = db.prepare(`INSERT INTO bug_attachments (bug_report_id, declared_path, filename, mime, size, sha256, label, stored_name, state, reason, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stored', '', 1) RETURNING id`).pluck().get(bugId, filename, filename, shot.mime, shot.size, shot.sha256, name, shot.storedName) as number;
    audit({ userId: null, label: `agent: ${token.name}`, ip }, "agent_request.screenshot_added", { projectId, detail: { request: requestId, bug: bugId, label, size: shot.size, credential_id: token.id } });
    return { id, bug: bugId, label, screenshotsOnRequest: onRequest + 1 };
  })();
}
