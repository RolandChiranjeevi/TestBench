/**
 * Optional Linear connection: create a Linear issue from a failing test. Off unless LINEAR_API_KEY is set (a personal API key from
 * Linear, Settings > Account > Security & access). The key stays on the server and is sent only to api.linear.app.
 * LINEAR_TEAM_ID (a team id or its short key such as ENG) picks the default team; without it the team is chosen in the dialog.
 */

const ENDPOINT = "https://api.linear.app/graphql";

export class LinearError extends Error {
  /**
   * For a request that changes something: "rejected" means Linear answered and did not do it, "unknown" means it may or may not have
   * (timeout, broken connection, server error, an answer that could not be read). Left unset for requests that only read.
   */
  constructor(public status: 400 | 401 | 502, message: string, public outcome?: "rejected" | "unknown") {
    super(message);
  }
}

export interface LinearTeam { id: string; key: string; name: string }
export interface LinearIssue { identifier: string; url: string }

export const linearEnabled = (env: NodeJS.ProcessEnv = process.env) => !!env.LINEAR_API_KEY?.trim();

/** Linear's own explanation in an error answer, shortened. Without it a refusal for a missing permission looks like any other HTTP 400. */
async function reason(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let msg: unknown = "";
  try {
    const e = (JSON.parse(text) as { errors?: { message?: string; extensions?: { userPresentableMessage?: string } }[] }).errors?.[0];
    msg = e?.extensions?.userPresentableMessage || e?.message || "";
  } catch {
    /* not JSON: nothing worth showing */
  }
  return String(msg).replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 300);
}

async function gql<T>(query: string, variables: Record<string, unknown>, f: typeof fetch, env: NodeJS.ProcessEnv): Promise<T> {
  const key = env.LINEAR_API_KEY?.trim();
  if (!key) throw new LinearError(400, "Linear is not connected. Set LINEAR_API_KEY on the server (see the README).", "rejected");
  let res: Response;
  try {
    // Personal API keys go in the header as they are, without "Bearer".
    res = await f(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", Authorization: key }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new LinearError(502, "Could not reach Linear. Check the internet connection and try again.", "unknown");
  }
  if (res.status === 401 || res.status === 403) {
    const why = await reason(res);
    throw new LinearError(401, `Linear rejected the API key or its permissions (HTTP ${res.status}). Check the key${why ? `. Linear says: "${why}"` : ""}`, "rejected");
  }
  if (!res.ok) {
    const why = await reason(res);
    throw new LinearError(502, `Linear answered with an error (HTTP ${res.status})${why ? `: "${why}"` : "."}`, res.status >= 500 ? "unknown" : "rejected");
  }
  const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message?: string }[] } | null;
  if (!body) throw new LinearError(502, "Linear: the answer could not be read.", "unknown");
  if (body.errors?.length || !body.data) throw new LinearError(502, `Linear: ${body.errors?.[0]?.message ?? "unexpected response"}`, "rejected");
  return body.data;
}

export async function listTeams(f: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): Promise<LinearTeam[]> {
  const data = await gql<{ teams: { nodes: LinearTeam[] } }>("query { teams { nodes { id key name } } }", {}, f, env);
  return data.teams.nodes;
}

/** The team to create the issue in: the one asked for (id or key), else LINEAR_TEAM_ID, else the only team there is. */
export function resolveTeam(teams: LinearTeam[], wanted?: string | null, fallback?: string | null): LinearTeam {
  const pick = (w: string) => teams.find((t) => t.id === w || t.key.toLowerCase() === w.toLowerCase());
  const asked = wanted?.trim();
  if (asked) {
    const t = pick(asked);
    if (!t) throw new LinearError(400, `No Linear team matches "${asked}".`);
    return t;
  }
  const def = fallback?.trim();
  if (def) {
    const t = pick(def);
    if (!t) throw new LinearError(400, `LINEAR_TEAM_ID "${def}" does not match any team.`);
    return t;
  }
  if (teams.length === 1) return teams[0];
  throw new LinearError(400, teams.length ? "Choose which Linear team the issue goes in." : "The Linear account has no teams.");
}

export async function createIssue(
  input: { title: string; description: string; teamId?: string | null },
  f: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LinearIssue> {
  const team = resolveTeam(await listTeams(f, env), input.teamId, env.LINEAR_TEAM_ID);
  const data = await gql<{ issueCreate: { success: boolean; issue: LinearIssue | null } }>(
    "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }",
    { input: { teamId: team.id, title: input.title, description: input.description } },
    f,
    env,
  );
  const issue = data.issueCreate.issue;
  if (!data.issueCreate.success || !issue) throw new LinearError(502, "Linear did not create the issue.");
  return issue;
}

// ---------- Publishing a bug report (see publish.ts) ----------

export interface LinearCreated { id: string; identifier: string; url: string }

/** Testbench severity to Linear's priority (1 urgent ... 4 low, 0 none). */
export function linearPriority(severity: string | null): { value: number; label: string } {
  switch (severity) {
    case "critical": return { value: 1, label: "Urgent" };
    case "high": return { value: 2, label: "High" };
    case "medium": return { value: 3, label: "Medium" };
    case "low": return { value: 4, label: "Low" };
    default: return { value: 0, label: "No priority" };
  }
}

/**
 * Creates an issue under an id chosen by the caller (a UUID). The same id can only ever become one issue, so asking again after an
 * unclear answer cannot make a second one: it either finds the first or is refused.
 */
export async function createIssueWithId(
  input: { id: string; teamId: string; title: string; description: string; priority: number },
  f: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<LinearCreated> {
  const data = await gql<{ issueCreate: { success: boolean; issue: LinearCreated | null } | null }>(
    "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }",
    { input: { id: input.id, teamId: input.teamId, title: input.title, description: input.description, priority: input.priority } },
    f,
    env,
  );
  const made = data.issueCreate;
  if (!made?.success || !made.issue) throw new LinearError(502, "Linear did not create the issue.", "rejected");
  return made.issue;
}

/** The issue with this id, or null when there is none. */
export async function findIssue(id: string, f: typeof fetch, env: NodeJS.ProcessEnv): Promise<LinearCreated | null> {
  try {
    const data = await gql<{ issue: LinearCreated | null }>("query($id: String!) { issue(id: $id) { id identifier url } }", { id }, f, env);
    return data.issue ?? null;
  } catch (e) {
    if (e instanceof LinearError && e.outcome === "rejected" && /not found/i.test(e.message)) return null;
    throw e;
  }
}

/** Uploads one file to Linear's storage and attaches it to the issue. Throws LinearError; the issue itself is not touched on failure. */
export async function attachFile(
  input: { issueId: string; filename: string; contentType: string; bytes: Uint8Array },
  f: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const data = await gql<{ fileUpload: { success: boolean; uploadFile: { uploadUrl: string; assetUrl: string; headers: { key: string; value: string }[] } | null } | null }>(
    "mutation($contentType: String!, $filename: String!, $size: Int!) { fileUpload(contentType: $contentType, filename: $filename, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }",
    { contentType: input.contentType, filename: input.filename, size: input.bytes.length },
    f,
    env,
  );
  const up = data.fileUpload?.uploadFile;
  if (!data.fileUpload?.success || !up) throw new LinearError(502, `Linear would not take the file ${input.filename}.`);
  let target: URL;
  try {
    target = new URL(up.uploadUrl);
  } catch {
    throw new LinearError(502, "Linear gave an upload address that is not a web address.");
  }
  if (target.protocol !== "https:") throw new LinearError(502, "Linear gave an upload address that is not https.");
  let put: Response;
  try {
    // The signed address takes the file as it is. The API key is not sent there.
    put = await f(up.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": input.contentType, "Cache-Control": "public, max-age=31536000", ...Object.fromEntries(up.headers.map((h) => [h.key, h.value])) },
      body: input.bytes as unknown as BodyInit,
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new LinearError(502, `Could not upload ${input.filename} to Linear.`);
  }
  if (!put.ok) throw new LinearError(502, `Linear's storage refused ${input.filename} (HTTP ${put.status}).`);
  const att = await gql<{ attachmentCreate: { success: boolean } | null }>(
    "mutation($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }",
    { input: { issueId: input.issueId, title: input.filename, url: up.assetUrl } },
    f,
    env,
  );
  if (!att.attachmentCreate?.success) throw new LinearError(502, `Linear did not attach ${input.filename} to the issue.`);
}
