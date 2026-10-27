import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createIssue, LinearError, linearEnabled, listTeams, resolveTeam, type LinearTeam } from "../server/linear.ts";

const teams: LinearTeam[] = [
  { id: "11111111-aaaa", key: "ENG", name: "Engineering" },
  { id: "22222222-bbbb", key: "QA", name: "Quality" },
];
const env = (extra: Record<string, string> = {}) => ({ LINEAR_API_KEY: "lin_api_test", ...extra }) as NodeJS.ProcessEnv;

interface Call { url: string; auth: string | null; query: string; variables: any }
/** A stand-in for fetch that records the requests and answers from a queue. */
function fakeFetch(answers: (object | { status: number })[]) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, auth: (init.headers as Record<string, string>).Authorization ?? null, query: body.query, variables: body.variables });
    const a = answers.shift()!;
    if ("status" in a) return new Response("nope", { status: a.status });
    return new Response(JSON.stringify(a), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const rejects = (p: Promise<unknown>, status: number, re: RegExp) =>
  assert.rejects(p, (e: unknown) => e instanceof LinearError && e.status === status && re.test(e.message));

describe("linearEnabled", () => {
  it("is on only when a key is set", () => {
    assert.equal(linearEnabled({} as NodeJS.ProcessEnv), false);
    assert.equal(linearEnabled({ LINEAR_API_KEY: "  " } as NodeJS.ProcessEnv), false);
    assert.equal(linearEnabled(env()), true);
  });
});

describe("resolveTeam", () => {
  it("takes the requested team by id or by key, in any case", () => {
    assert.equal(resolveTeam(teams, "QA").id, "22222222-bbbb");
    assert.equal(resolveTeam(teams, "eng").id, "11111111-aaaa");
    assert.equal(resolveTeam(teams, "22222222-bbbb").key, "QA");
  });
  it("falls back to LINEAR_TEAM_ID, then to the only team", () => {
    assert.equal(resolveTeam(teams, undefined, "QA").key, "QA");
    assert.equal(resolveTeam([teams[0]]).key, "ENG");
  });
  it("refuses to guess between several teams, and rejects unknown ones", () => {
    assert.throws(() => resolveTeam(teams), /Choose which Linear team/);
    assert.throws(() => resolveTeam(teams, "NOPE"), /No Linear team matches/);
    assert.throws(() => resolveTeam(teams, undefined, "NOPE"), /LINEAR_TEAM_ID/);
    assert.throws(() => resolveTeam([]), /no teams/);
  });
});

describe("createIssue", () => {
  it("looks up the team, creates the issue, and sends the key as it is (no Bearer)", async () => {
    const { f, calls } = fakeFetch([
      { data: { teams: { nodes: teams } } },
      { data: { issueCreate: { success: true, issue: { identifier: "QA-12", url: "https://linear.app/acme/issue/QA-12/checkout-fails" } } } },
    ]);
    const issue = await createIssue({ title: "Checkout fails", description: "Steps...", teamId: "QA" }, f, env());
    assert.deepEqual(issue, { identifier: "QA-12", url: "https://linear.app/acme/issue/QA-12/checkout-fails" });
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.url === "https://api.linear.app/graphql" && c.auth === "lin_api_test"));
    assert.deepEqual(calls[1].variables.input, { teamId: "22222222-bbbb", title: "Checkout fails", description: "Steps..." });
    assert.match(calls[1].query, /issueCreate/);
  });

  it("uses LINEAR_TEAM_ID when no team is passed", async () => {
    const { f, calls } = fakeFetch([
      { data: { teams: { nodes: teams } } },
      { data: { issueCreate: { success: true, issue: { identifier: "ENG-1", url: "https://linear.app/x" } } } },
    ]);
    await createIssue({ title: "t", description: "" }, f, env({ LINEAR_TEAM_ID: "ENG" }));
    assert.equal(calls[1].variables.input.teamId, "11111111-aaaa");
  });

  it("does not create anything when the team is ambiguous", async () => {
    const { f, calls } = fakeFetch([{ data: { teams: { nodes: teams } } }]);
    await rejects(createIssue({ title: "t", description: "" }, f, env()), 400, /Choose which Linear team/);
    assert.equal(calls.length, 1); // only the team lookup
  });

  it("explains a missing key, a rejected key, an HTTP error and a GraphQL error", async () => {
    await rejects(createIssue({ title: "t", description: "" }, fakeFetch([]).f, {} as NodeJS.ProcessEnv), 400, /LINEAR_API_KEY/);
    await rejects(listTeams(fakeFetch([{ status: 401 }]).f, env()), 401, /rejected the API key/);
    await rejects(listTeams(fakeFetch([{ status: 500 }]).f, env()), 502, /HTTP 500/);
    await rejects(listTeams(fakeFetch([{ errors: [{ message: "Argument Validation Error" }] }]).f, env()), 502, /Argument Validation Error/);
  });

  it("reports a failed creation, and a network failure", async () => {
    const { f } = fakeFetch([{ data: { teams: { nodes: [teams[0]] } } }, { data: { issueCreate: { success: false, issue: null } } }]);
    await rejects(createIssue({ title: "t", description: "" }, f, env()), 502, /did not create/);
    const down = (async () => { throw new Error("ENOTFOUND"); }) as unknown as typeof fetch;
    await rejects(listTeams(down, env()), 502, /Could not reach Linear/);
  });

  it("never puts the API key into an error message", async () => {
    const e = await listTeams(fakeFetch([{ status: 401 }]).f, env()).catch((x: Error) => x);
    assert.ok(e instanceof Error && !e.message.includes("lin_api_test"));
  });
});
