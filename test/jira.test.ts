import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiraIssue, JiraError, jiraBase, jiraEnabled, jiraStatus, markdownToAdf } from "../server/jira.ts";

const env = (extra: Record<string, string> = {}) =>
  ({ JIRA_BASE_URL: "https://acme.atlassian.net/", JIRA_EMAIL: "me@acme.com", JIRA_API_TOKEN: "tok_secret", JIRA_PROJECT_KEY: "SHOP", ...extra }) as NodeJS.ProcessEnv;

interface Call { url: string; method: string; auth: string | null; body: any }
type Answer = { json?: object; status?: number };
/** A stand-in for fetch that records the requests and answers from a queue. */
function fakeFetch(answers: Answer[]) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), auth: (init.headers as Record<string, string>).Authorization ?? null, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const a = answers.shift()!;
    return new Response(JSON.stringify(a.json ?? {}), { status: a.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const project = { key: "SHOP", issueTypes: [{ name: "Task" }, { name: "Bug" }, { name: "Sub-task", subtask: true }] };
const rejects = (p: Promise<unknown>, status: number, re: RegExp) =>
  assert.rejects(p, (e: unknown) => e instanceof JiraError && e.status === status && re.test(e.message));

describe("jiraEnabled / jiraBase", () => {
  it("is on only when all four values are set", () => {
    assert.equal(jiraEnabled({} as NodeJS.ProcessEnv), false);
    assert.equal(jiraEnabled(env({ JIRA_API_TOKEN: " " })), false);
    assert.equal(jiraEnabled(env()), true);
  });
  it("reduces the address to its origin and refuses plain http", () => {
    assert.equal(jiraBase(env({ JIRA_BASE_URL: "https://acme.atlassian.net/jira/software" })), "https://acme.atlassian.net");
    assert.throws(() => jiraBase(env({ JIRA_BASE_URL: "http://acme.atlassian.net" })), /https/);
    assert.throws(() => jiraBase(env({ JIRA_BASE_URL: "acme" })), /web address/);
  });
});

describe("jiraStatus", () => {
  it("checks the project and picks the Bug type, in any case", async () => {
    const { f, calls } = fakeFetch([{ json: project }]);
    assert.deepEqual(await jiraStatus(f, env({ JIRA_ISSUE_TYPE: "bug" })), { baseUrl: "https://acme.atlassian.net", project: "SHOP", issueType: "Bug" });
    assert.equal(calls[0].url, "https://acme.atlassian.net/rest/api/3/project/SHOP");
    assert.equal(calls[0].auth, "Basic " + Buffer.from("me@acme.com:tok_secret").toString("base64"));
  });
  it("lists the available types when the wanted one is missing (sub-tasks excluded)", async () => {
    await rejects(jiraStatus(fakeFetch([{ json: project }]).f, env({ JIRA_ISSUE_TYPE: "Defect" })), 400, /"Defect".*Task, Bug\./);
  });
  it("explains a bad token, a missing project, a forbidden account and a network failure", async () => {
    await rejects(jiraStatus(fakeFetch([{ status: 401 }]).f, env()), 401, /rejected the email and API token/);
    await rejects(jiraStatus(fakeFetch([{ status: 404 }]).f, env()), 400, /SHOP.*not found/);
    await rejects(jiraStatus(fakeFetch([{ status: 403, json: { errorMessages: ["No permission"] } }]).f, env()), 401, /No permission/);
    const down = (async () => { throw new Error("ENOTFOUND"); }) as unknown as typeof fetch;
    await rejects(jiraStatus(down, env()), 502, /Could not reach Jira/);
  });
  it("never puts the token into an error message", async () => {
    const e = await jiraStatus(fakeFetch([{ status: 401 }]).f, env()).catch((x: Error) => x);
    assert.ok(e instanceof Error && !e.message.includes("tok_secret"));
  });
});

describe("createJiraIssue", () => {
  it("creates the issue with an Atlassian document and returns the browse link", async () => {
    const { f, calls } = fakeFetch([{ json: project }, { status: 201, json: { id: "1", key: "SHOP-42" } }]);
    const issue = await createJiraIssue({ title: "Checkout fails", description: "**Environment:** staging\n\n1. Open cart\n2. Pay" }, f, env());
    assert.deepEqual(issue, { identifier: "SHOP-42", url: "https://acme.atlassian.net/browse/SHOP-42" });
    assert.equal(calls[1].method, "POST");
    assert.equal(calls[1].url, "https://acme.atlassian.net/rest/api/3/issue");
    const fields = calls[1].body.fields;
    assert.deepEqual(fields.project, { key: "SHOP" });
    assert.deepEqual(fields.issuetype, { name: "Bug" });
    assert.equal(fields.summary, "Checkout fails");
    assert.equal(fields.description.type, "doc");
  });
  it("shows Jira's field errors (for example a required custom field)", async () => {
    const { f } = fakeFetch([{ json: project }, { status: 400, json: { errors: { customfield_10010: "Team is required." } } }]);
    await rejects(createJiraIssue({ title: "t", description: "" }, f, env()), 400, /customfield_10010: Team is required/);
  });
});

describe("markdownToAdf", () => {
  it("turns bold labels, numbered steps and code fences into document nodes", () => {
    const doc = markdownToAdf("**Environment:** staging\n**Test:** SHOP-1 login\n\n**Steps to reproduce**\n1. Open **cart**\n2. Pay\n\n**Error output**\n```\nboom\n  at x\n```\n");
    assert.deepEqual(doc.content!.map((n) => n.type), ["paragraph", "paragraph", "orderedList", "paragraph", "codeBlock"]);
    const facts = doc.content![0].content!;
    assert.deepEqual(facts[0], { type: "text", text: "Environment:", marks: [{ type: "strong" }] });
    assert.equal(facts[2].type, "hardBreak");
    assert.equal(doc.content![2].content!.length, 2);
    assert.deepEqual(doc.content![4].content, [{ type: "text", text: "boom\n  at x" }]);
  });
  it("copes with ~~~~ fences, an unclosed fence and empty input", () => {
    assert.equal(markdownToAdf("~~~~\n```\n~~~~").content![0].type, "codeBlock");
    assert.equal(markdownToAdf("```\nnever closed").content![0].type, "codeBlock");
    assert.deepEqual(markdownToAdf("").content, []);
  });
});
