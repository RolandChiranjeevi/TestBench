/**
 * Optional Jira Cloud connection: create a Jira issue from a failing test. Off unless JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN and
 * JIRA_PROJECT_KEY are all set. The token (Atlassian account > Security > API tokens) stays on the server and is sent only to the
 * Jira site named in JIRA_BASE_URL. JIRA_ISSUE_TYPE (default "Bug") names the issue type to create.
 */

export class JiraError extends Error {
  constructor(public status: 400 | 401 | 502, message: string) {
    super(message);
  }
}

export interface JiraIssue { identifier: string; url: string }
export interface JiraStatus { baseUrl: string; project: string; issueType: string }

const val = (env: NodeJS.ProcessEnv, k: string) => env[k]?.trim() ?? "";
export const jiraEnabled = (env: NodeJS.ProcessEnv = process.env) => ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_PROJECT_KEY"].every((k) => val(env, k));

/** The site address without a trailing slash or path. Credentials are only ever sent over https. */
export function jiraBase(env: NodeJS.ProcessEnv = process.env): string {
  let u: URL;
  try {
    u = new URL(val(env, "JIRA_BASE_URL"));
  } catch {
    throw new JiraError(400, "JIRA_BASE_URL is not a web address. Use something like https://yourteam.atlassian.net.");
  }
  if (u.protocol !== "https:") throw new JiraError(400, "JIRA_BASE_URL must start with https://.");
  return u.origin;
}

async function call<T>(method: "GET" | "POST", path: string, body: unknown, f: typeof fetch, env: NodeJS.ProcessEnv): Promise<T> {
  if (!jiraEnabled(env)) throw new JiraError(400, "Jira is not connected. Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN and JIRA_PROJECT_KEY (see the README).");
  const auth = Buffer.from(`${val(env, "JIRA_EMAIL")}:${val(env, "JIRA_API_TOKEN")}`).toString("base64");
  const base = jiraBase(env);
  let res: Response;
  try {
    res = await f(base + path, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Basic ${auth}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new JiraError(502, "Could not reach Jira. Check JIRA_BASE_URL and the internet connection.");
  }
  if (res.status === 401) throw new JiraError(401, "Jira rejected the email and API token. Check JIRA_EMAIL and JIRA_API_TOKEN.");
  const json = (await res.json().catch(() => null)) as (T & { errorMessages?: string[]; errors?: Record<string, string> }) | null;
  if (!res.ok) {
    const detail = [...(json?.errorMessages ?? []), ...Object.entries(json?.errors ?? {}).map(([k, v]) => `${k}: ${v}`)].join("; ");
    if (res.status === 403) throw new JiraError(401, `Jira says this account may not do that${detail ? ` (${detail})` : ""}.`);
    if (res.status === 404) throw new JiraError(400, `Jira project "${val(env, "JIRA_PROJECT_KEY")}" was not found, or this account cannot see it.`);
    throw new JiraError(res.status === 400 ? 400 : 502, `Jira: ${detail || `HTTP ${res.status}`}`);
  }
  if (!json) throw new JiraError(502, "Jira: unexpected response.");
  return json;
}

/** Checks the project is reachable and has the issue type we create; returns what will be used. */
export async function jiraStatus(f: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): Promise<JiraStatus> {
  const key = val(env, "JIRA_PROJECT_KEY");
  const project = await call<{ key: string; issueTypes?: { name: string; subtask?: boolean }[] }>("GET", `/rest/api/3/project/${encodeURIComponent(key)}`, undefined, f, env);
  const wanted = val(env, "JIRA_ISSUE_TYPE") || "Bug";
  const types = (project.issueTypes ?? []).filter((t) => !t.subtask).map((t) => t.name);
  const type = types.find((t) => t.toLowerCase() === wanted.toLowerCase());
  if (!type) throw new JiraError(400, `Project ${project.key} has no issue type "${wanted}". Set JIRA_ISSUE_TYPE to one of: ${types.join(", ") || "(none)"}.`);
  return { baseUrl: jiraBase(env), project: project.key, issueType: type };
}

// ---------- Atlassian Document Format ----------

type Adf = { type: string; content?: Adf[]; text?: string; marks?: { type: string }[] };

/** "plain **bold** plain" -> text nodes, bold parts carrying the strong mark. */
function inline(s: string): Adf[] {
  const out: Adf[] = [];
  s.split(/\*\*(.+?)\*\*/g).forEach((part, i) => {
    if (part) out.push(i % 2 ? { type: "text", text: part, marks: [{ type: "strong" }] } : { type: "text", text: part });
  });
  return out;
}

/** Lines joined with hard breaks. */
function withBreaks(ls: string[]): Adf[] {
  return ls.flatMap((l, i) => (i ? [{ type: "hardBreak" } as Adf, ...inline(l)] : inline(l)));
}

/**
 * Turns the bug draft's markdown (bold labels, numbered steps, fenced code, plain paragraphs) into an Atlassian Document, which is
 * what Jira's v3 API requires for the description.
 */
export function markdownToAdf(md: string): Adf {
  const content: Adf[] = [];
  const src = md.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let list: string[] = [];
  const flushPara = () => {
    if (para.length) content.push({ type: "paragraph", content: withBreaks(para) });
    para = [];
  };
  const flushList = () => {
    if (list.length) content.push({ type: "orderedList", content: list.map((t) => ({ type: "listItem", content: [{ type: "paragraph", content: inline(t) }] })) });
    list = [];
  };
  for (let i = 0; i < src.length; i++) {
    const line = src[i];
    const fence = line.match(/^(`{3,}|~{3,})/);
    if (fence) {
      flushPara();
      flushList();
      const code: string[] = [];
      for (i++; i < src.length && !src[i].startsWith(fence[1]); i++) code.push(src[i]);
      const text = code.join("\n");
      content.push({ type: "codeBlock", content: text ? [{ type: "text", text }] : [] });
      continue;
    }
    const item = line.match(/^\d+\.\s+(.*)$/);
    if (item) {
      flushPara();
      list.push(item[1]);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return { type: "doc", content };
}

export async function createJiraIssue(
  input: { title: string; description: string },
  f: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<JiraIssue> {
  const { project, issueType, baseUrl } = await jiraStatus(f, env);
  const fields: Record<string, unknown> = { project: { key: project }, issuetype: { name: issueType }, summary: input.title };
  const doc = markdownToAdf(input.description);
  if (doc.content?.length) fields.description = doc;
  const made = await call<{ key?: string }>("POST", "/rest/api/3/issue", { fields }, f, env);
  if (!made.key) throw new JiraError(502, "Jira did not return the new issue's key.");
  return { identifier: made.key, url: `${baseUrl}/browse/${made.key}` };
}
