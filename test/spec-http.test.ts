import "./env.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// The real server, started as a separate process with a password set. A spec for a test case (E3) is made, edited, decided, applied and downloaded by a signed-in person, and by nobody else:
// no kind of agent token (read, proposal, request, CI) opens any of these routes, whether it reads or writes. The text is downloaded as a file, never as a page.

const ROOT = join(import.meta.dirname, "..");
const PORT = 49000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "a long test passphrase";
const JSON_H = { "Content-Type": "application/json" };
let server: ChildProcess;
let output = "";
let cookie = "";

const call = (path: string, init: RequestInit = {}) => fetch(`${BASE}${path}`, init);
const person = (path: string, body?: unknown, method = "POST") =>
  call(path, { method, headers: { ...JSON_H, "X-Testbench": "1", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const ok = async <T>(res: Response) => { const raw = await res.text(); assert.ok(res.ok, raw); return JSON.parse(raw) as T; };

let a = 0;
let b = 0;
const tokens: Record<"read" | "propose" | "request" | "ci", string> = { read: "", propose: "", request: "", ci: "" };
const issued: string[] = [];

interface Suggestion { id: number; status: string; artifactName: string | null; artifactText: string; appliedAt: string | null; isSpec: boolean; subjectKind: string }
const newCase = async (projectId: number, title: string, status: string, steps: { action: string; expected: string }[]) =>
  (await ok<{ id: number; number: number }>(await person(`/api/projects/${projectId}/cases`, { title, status, steps }))).id;
const ask = (caseId: number) => person(`/api/cases/${caseId}/spec-suggestions`, {});

before(async () => {
  server = spawn(process.execPath, ["--import", "tsx", join(ROOT, "server", "index.ts")], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TESTBENCH_DATA: mkdtempSync(join(tmpdir(), "tb-spec-http-")), TESTBENCH_PORT: String(PORT), TESTBENCH_PASSWORD: PASSWORD, NODE_ENV: "production", TESTBENCH_AUTO_BACKUP: "0" },
  });
  server.stdout?.on("data", (d) => (output += d));
  server.stderr?.on("data", (d) => (output += d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await call("/api/auth/status")).ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  const login = await call("/api/login", { method: "POST", headers: { ...JSON_H, "X-Testbench": "1" }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(login.status, 200, output);
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  a = (await ok<{ id: number }>(await person("/api/projects", { name: "Spec A", key: "SPA" }))).id;
  b = (await ok<{ id: number }>(await person("/api/projects", { name: "Spec B", key: "SPB" }))).id;
  await ok(await person("/api/settings/agent-proposals", { enabled: true }, "PUT"));
  const mk = async (path: string, name: string) => { const t = (await ok<{ token: string }>(await person(`/api/projects/${a}/${path}`, { name }))).token; issued.push(t); return t; };
  tokens.read = await mk("agent/tokens", "reader");
  tokens.propose = await mk("propose-tokens", "proposer");
  tokens.request = await mk("request-tokens", "requester");
  tokens.ci = await mk("ci/tokens", "ci");
});
after(() => server?.kill());

describe("a person makes, edits, decides, applies and downloads a spec for a test case", () => {
  it("only a ready test case with steps gets one, once, and the answer is the list", async () => {
    const steps = [{ action: "Open the login page", expected: "The form is shown" }, { action: "Sign in", expected: "" }];
    const draft = await newCase(a, "Draft case", "draft", steps);
    const empty = await newCase(a, "No steps", "ready", []);
    const good = await newCase(a, "Login works", "ready", steps);
    const refused = await ask(draft);
    assert.equal(refused.status, 409);
    assert.match(((await refused.json()) as { error: string }).error, /Make the test case ready first/);
    const none = await ok<{ created: unknown[]; message: string }>(await ask(empty));
    assert.deepEqual([none.created.length, none.message], [0, "Nothing was generated: the test case has no steps. Add steps to the test case and ask again."]);
    assert.equal((await ask(999999)).status, 404);
    const made = await ok<{ created: Suggestion[]; suggestions: Suggestion[] }>(await ask(good));
    assert.equal(made.created.length, 1);
    assert.deepEqual([made.created[0].subjectKind, made.created[0].isSpec, made.created[0].status, made.created[0].appliedAt], ["case", true, "proposed", null]);
    assert.match(made.created[0].artifactName!, /^tc-\d+-login-works\.spec\.ts$/);
    assert.match(made.created[0].artifactText, /test\("Login works @SPA-\d+", async/);
    assert.equal(made.suggestions.length, 1);
    assert.equal((await ok<{ created: unknown[] }>(await ask(good))).created.length, 0, "asking again makes no second one");
    assert.equal((await ok<Suggestion[]>(await person(`/api/cases/${good}/automation-suggestions`, undefined, "GET"))).length, 1);
  });

  it("is edited, approved, applied and then downloaded as a file: plain text, an attachment, never a page; not before Apply", async () => {
    const id = await newCase(a, "Cart works", "ready", [{ action: "Open the cart", expected: "It is empty" }]);
    const s = (await ok<{ created: Suggestion[] }>(await ask(id))).created[0];
    assert.equal((await call(`/api/automation-suggestions/${s.id}/spec`, { headers: { Cookie: cookie } })).status, 409, "before Apply there is no download");
    const text = '// mine <script>alert(1)</script>\ntest("x", async () => {});\n';
    await ok(await person(`/api/automation-suggestions/${s.id}`, { artifactText: text }, "PATCH"));
    await ok(await person(`/api/automation-suggestions/${s.id}/decision`, { status: "approved" }));
    const applied = await ok<{ spec: { fileName: string }; suggestion: Suggestion }>(await person(`/api/automation-suggestions/${s.id}/apply`, {}));
    assert.equal(applied.spec.fileName, s.artifactName);
    assert.ok(applied.suggestion.appliedAt);
    const file = await call(`/api/automation-suggestions/${s.id}/spec`, { headers: { Cookie: cookie } });
    assert.equal(file.status, 200);
    assert.match(file.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(file.headers.get("x-content-type-options"), "nosniff");
    assert.equal(file.headers.get("content-disposition"), `attachment; filename="${s.artifactName}"`);
    assert.equal(await file.text(), text, "the person's text, as it is");
    assert.equal((await call(`/api/automation-suggestions/${s.id}/spec`)).status, 401, "not without a login");
  });

  it("a request without the browser header is refused, so a page cannot make one", async () => {
    const id = await newCase(a, "Header case", "ready", [{ action: "Step", expected: "" }]);
    const res = await call(`/api/cases/${id}/spec-suggestions`, { method: "POST", headers: { ...JSON_H, Cookie: cookie }, body: "{}" });
    assert.equal(res.status, 403);
  });
});

describe("no kind of agent token reaches a spec, to read it or to change it", () => {
  it("is refused on every route, for every kind of token, with and without the browser header, and nothing changes", async () => {
    const steps = [{ action: "Open the page", expected: "It loads" }];
    const id = await newCase(a, "Token case", "ready", steps);
    const s = (await ok<{ created: Suggestion[] }>(await ask(id))).created[0];
    const before = JSON.stringify(await ok<Suggestion[]>(await person(`/api/cases/${id}/automation-suggestions`, undefined, "GET")));
    const routes: [string, string, unknown?][] = [
      ["POST", `/api/cases/${id}/spec-suggestions`, {}], ["GET", `/api/cases/${id}/automation-suggestions`], ["PATCH", `/api/automation-suggestions/${s.id}`, { artifactText: "// taken\n" }],
      ["POST", `/api/automation-suggestions/${s.id}/decision`, { status: "approved" }], ["POST", `/api/automation-suggestions/${s.id}/apply`, {}], ["GET", `/api/automation-suggestions/${s.id}/spec`],
    ];
    for (const [kind, token] of Object.entries(tokens)) {
      for (const withHeader of [false, true]) {
        for (const [method, path, body] of routes) {
          const res = await call(path, { method, headers: { ...JSON_H, Authorization: `Bearer ${token}`, ...(withHeader ? { "X-Testbench": "1" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
          assert.ok(res.status === 401 || res.status === 403, `${kind} token: ${method} ${path} (header ${withHeader}) answered ${res.status}`);
        }
      }
    }
    assert.equal(JSON.stringify(await ok<Suggestion[]>(await person(`/api/cases/${id}/automation-suggestions`, undefined, "GET"))), before, "nothing was changed");
    for (const [method, path, body] of routes) {
      const res = await call(path, { method, headers: { ...JSON_H, "X-Testbench": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
      assert.equal(res.status, 401, `${method} ${path} without a login`);
    }
    for (const t of issued) assert.equal(output.includes(t), false, "the server did not print a token");
  });
});

describe("results are linked to the case by the tag, through a real import", () => {
  const upload = (projectId: number, report: unknown) => {
    const form = new FormData();
    form.set("file", new Blob([JSON.stringify(report)], { type: "application/json" }), "report.json");
    return call(`/api/projects/${projectId}/import`, { method: "POST", headers: { "X-Testbench": "1", Cookie: cookie }, body: form });
  };

  it("a Playwright report with the generated title makes its result a result of the test case, and not in another project", async () => {
    const id = await newCase(a, "Checkout works", "ready", [{ action: "Pay", expected: "A receipt is shown" }]);
    const s = (await ok<{ created: Suggestion[] }>(await ask(id))).created[0];
    const title = JSON.parse(/^ {2}test\((".*"), async/m.exec(s.artifactText)![1]) as string;
    assert.match(title, /^Checkout works @SPA-\d+$/);
    const report = { config: { rootDir: "/repo/e2e" }, stats: { startTime: "2026-01-02T03:04:05.000Z" }, suites: [{ title: s.artifactName, file: s.artifactName, specs: [{ title, file: s.artifactName, line: 3, column: 1, tests: [{ projectName: "chromium", status: "expected", results: [{ status: "passed", duration: 12, retry: 0 }] }] }] }] };
    const imp = await ok<{ runId: number; linked: number }>(await upload(a, report));
    assert.equal(imp.linked, 1);
    const run = await ok<{ results: { case_id: number | null }[] }>(await call(`/api/runs/${imp.runId}`, { headers: { Cookie: cookie } }));
    assert.deepEqual(run.results.map((r) => r.case_id), [id]);
    assert.equal((await ok<{ linked: number }>(await upload(b, report))).linked, 0, "the tag names this project's key");
  });
});
