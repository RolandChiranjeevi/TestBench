/**
 * Optional Linear connection: create a Linear issue from a failing test. Off unless LINEAR_API_KEY is set (a personal API key from
 * Linear, Settings > Account > Security & access). The key stays on the server and is sent only to api.linear.app.
 * LINEAR_TEAM_ID (a team id or its short key such as ENG) picks the default team; without it the team is chosen in the dialog.
 */

const ENDPOINT = "https://api.linear.app/graphql";

export class LinearError extends Error {
  constructor(public status: 400 | 401 | 502, message: string) {
    super(message);
  }
}

export interface LinearTeam { id: string; key: string; name: string }
export interface LinearIssue { identifier: string; url: string }

export const linearEnabled = (env: NodeJS.ProcessEnv = process.env) => !!env.LINEAR_API_KEY?.trim();

async function gql<T>(query: string, variables: Record<string, unknown>, f: typeof fetch, env: NodeJS.ProcessEnv): Promise<T> {
  const key = env.LINEAR_API_KEY?.trim();
  if (!key) throw new LinearError(400, "Linear is not connected. Set LINEAR_API_KEY on the server (see the README).");
  let res: Response;
  try {
    // Personal API keys go in the header as they are, without "Bearer".
    res = await f(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", Authorization: key }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new LinearError(502, "Could not reach Linear. Check the internet connection and try again.");
  }
  if (res.status === 401 || res.status === 403) throw new LinearError(401, "Linear rejected the API key. Check LINEAR_API_KEY.");
  if (!res.ok) throw new LinearError(502, `Linear answered with an error (HTTP ${res.status}).`);
  const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message?: string }[] } | null;
  if (!body || body.errors?.length || !body.data) throw new LinearError(502, `Linear: ${body?.errors?.[0]?.message ?? "unexpected response"}`);
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
