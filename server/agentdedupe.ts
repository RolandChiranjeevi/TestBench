import { db } from "./db.ts";
import { AuditError } from "./auditcommon.ts";

/**
 * Discover without duplicates. An agent gives a test case, a bug report or an observation a `key`: what the thing IS (`cart:float-total`), not how it was worded. When a later
 * request hands in the same thing again, the server does not make a second post: it keeps a sighting (what the agent wrote this time, in full) and the post stays as it was.
 *
 * The rule is built to make a duplicate rather than to hide something: a post is only "the same" when ALL of these hold, and anything less makes a new post.
 *  - the key is exactly the same, in the same project (a key never reaches another project);
 *  - for a bug report, the page is the same (the path of its address, without a query or an extension) and is known on both sides;
 *  - the words of the two texts have something in common (LIKENESS_MIN), so that a key reused for something quite different is still a new post.
 * A key that exists without a match makes a new post that says so (`possibleDuplicateOf`), and its key is stored, so a person can see the two belong together.
 * Nothing here ever changes or deletes a post: the post is what a person may have reviewed.
 */
export const KEY_RX = /^[a-z0-9][a-z0-9._-]{0,60}(:[a-z0-9][a-z0-9._-]{0,60}){1,2}$/;
/**
 * The least Dice likeness of the words of two texts (title and, for a bug, its actual result). Measured on the bug reports of two real runs of the same site: the five reports that were
 * the same bug scored 0.34 to 0.85, and the highest score between two different bugs was 0.29. A guess with a narrow margin, so the key and the page are the real test: raise this to make
 * more duplicates and fewer hidden posts. test/agent-dedupe.test.ts holds the pairs.
 */
export const LIKENESS_MIN = 0.3;
export type DedupeKind = "test_case" | "bug_report" | "observation";

const STOP = new Set(["the", "and", "for", "with", "that", "this", "are", "not", "but", "from", "has", "its", "was", "when", "into", "than", "can", "after", "before"]);
const words = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9åäö]{3,}/g) ?? []).filter((w) => !STOP.has(w)));

/** Dice likeness of the words of two texts: 0 (nothing in common) to 1 (the same words). */
export function likeness(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return (2 * both) / (A.size + B.size);
}

/** The page of an address: its path without query, fragment and extension, lower case ("https://x.com/Cart.html?a=1" -> "cart", "/" -> "home"). "" when there is no address. */
export function pageOf(url: string): string {
  const raw = url.trim();
  if (!raw) return "";
  let path = raw;
  try { path = new URL(raw).pathname; } catch { path = raw.split(/[?#]/)[0]; }
  const slug = path.toLowerCase().replace(/\.[a-z0-9]{1,5}$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || (/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/?$/i.test(raw) || raw === "/" ? "home" : "");
}

interface Post { id: number; title: string; text: string; page: string; number?: number }

/** The posts that carry this key in this project (only an agent ever sets one), oldest first. */
function withKey(projectId: number, kind: DedupeKind, key: string): Post[] {
  if (kind === "test_case") {
    return (db.prepare("SELECT id, number, title, description AS text FROM cases WHERE project_id = ? AND dedupe_key = ? ORDER BY id").all(projectId, key) as Omit<Post, "page">[]).map((p) => ({ ...p, page: "" }));
  }
  if (kind === "bug_report") {
    return (db.prepare("SELECT id, title, actual AS text, url FROM bug_reports WHERE project_id = ? AND fingerprint = ? AND source = 'agent_audit' ORDER BY id").all(projectId, key) as (Omit<Post, "page"> & { url: string })[])
      .map(({ url, ...p }) => ({ ...p, page: pageOf(url) }));
  }
  return (db.prepare("SELECT id, title, evidence AS text FROM observations WHERE project_id = ? AND dedupe_key = ? ORDER BY id").all(projectId, key) as Omit<Post, "page">[]).map((p) => ({ ...p, page: "" }));
}

export interface Seen { id: number; title: string; number?: number }
/** The words of what the agent wrote in a sighting (its title and the kind's main text), so that a person who edits a post does not make it harder to match. */
const written = (kind: DedupeKind, payload: string): string => {
  try {
    const f = JSON.parse(payload) as Record<string, unknown>;
    return `${f.title ?? ""} ${(kind === "test_case" ? f.description : kind === "bug_report" ? f.actual : f.evidence) ?? ""}`;
  } catch { return ""; }
};
/**
 * Looks for the post an agent's finding is the same as. `same` is that post, or null; `similarKey` is the oldest post with the key when there is none that matches (the new post is
 * then made, and says it may be a duplicate of that one). The words are compared with the post as it is now AND with everything an agent has written about it, so that a person's edit
 * of the title never turns a later finding into a duplicate.
 */
export function lookUp(projectId: number, kind: DedupeKind, key: string, f: { title: string; text: string; url?: string }): { same: Seen | null; similarKey: Seen | null } {
  const posts = withKey(projectId, kind, key);
  const page = kind === "bug_report" ? pageOf(f.url ?? "") : "";
  const mine = `${f.title} ${f.text}`;
  const sightings = posts.length
    ? (db.prepare(`SELECT post_id, payload FROM agent_sightings WHERE kind = ? AND post_id IN (${posts.map(() => "?").join(",")})`).all(kind, ...posts.map((p) => p.id)) as { post_id: number; payload: string }[])
    : [];
  const alike = (p: Post) => [`${p.title} ${p.text}`, ...sightings.filter((x) => x.post_id === p.id).map((x) => written(kind, x.payload))].some((t) => likeness(mine, t) >= LIKENESS_MIN);
  const hit = posts.find((p) => (kind !== "bug_report" || (page !== "" && p.page === page)) && alike(p));
  const seen = (p: Post | undefined): Seen | null => (p ? { id: p.id, title: p.title, ...(p.number === undefined ? {} : { number: p.number }) } : null);
  return { same: seen(hit), similarKey: hit ? null : seen(posts[0]) };
}

/** What a request that took this discover may read about earlier posts: only posts an agent keyed, their key, title and how often they were seen again. A person's own posts have no key and are never listed. */
export function knownPosts(projectId: number, requestId: number, token: { id: number }) {
  const r = db.prepare("SELECT kind, status, claimed_token_id FROM agent_requests WHERE id = ? AND project_id = ?").get(requestId, projectId) as { kind: string; status: string; claimed_token_id: number | null } | undefined;
  if (!r) throw new AuditError(404, "Request not found");
  if (r.kind !== "discover") throw new AuditError(409, "Only a discover request can ask what is known");
  if (r.status !== "claimed" || r.claimed_token_id !== token.id) throw new AuditError(409, "The request is not taken by this token");
  // the first sighting made the post: `seen` counts the times it was handed in again
  const seen = db.prepare("SELECT MAX(COUNT(*) - 1, 0) FROM agent_sightings WHERE kind = ? AND post_id = ?").pluck();
  const list = (kind: DedupeKind, sql: string) =>
    (db.prepare(sql).all(projectId) as { id: number; key: string; title: string; number?: number }[]).map((p) => ({ ...p, seen: seen.get(kind, p.id) as number }));
  return {
    test_cases: list("test_case", "SELECT id, number, dedupe_key AS key, title FROM cases WHERE project_id = ? AND dedupe_key != '' ORDER BY id DESC LIMIT 300"),
    bug_reports: list("bug_report", "SELECT id, fingerprint AS key, title FROM bug_reports WHERE project_id = ? AND fingerprint != '' AND source = 'agent_audit' ORDER BY id DESC LIMIT 300"),
    observations: list("observation", "SELECT id, dedupe_key AS key, title FROM observations WHERE project_id = ? AND dedupe_key != '' ORDER BY id DESC LIMIT 300"),
  };
}
