import "./env.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// The real server, started as a separate process with a password set. Own specs (S2) are made, read, changed, renamed, downloaded and removed by a signed-in person, through the browser's
// session, and by nobody else: no kind of agent token (read, proposal, request, CI) opens any of the seven routes, whether it reads or writes. A spec is only ever text: it comes back
// as a JSON string or as a plain-text download, never as a page.

const ROOT = join(import.meta.dirname, "..");
const PORT = 51000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "a long test passphrase";
const JSON_H = { "Content-Type": "application/json" };
const MARKER = "SPEC-TEXT-MARKER-4821";
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

interface Spec { id: number; projectId: number; fileName: string; status: string; size: number; text: string; testCase: { id: number; key: string } | null; history: { rev: number; kind: string; note: string }[] }
const TEXT = `import { test } from "@playwright/test";\n// ${MARKER} <script>alert(1)</script>\ntest("x", async () => {});\n`;
const make = (projectId: number, fileName: string, over: Record<string, unknown> = {}) => person(`/api/projects/${projectId}/specs`, { fileName, text: TEXT, ...over });
const get = async (id: number) => ok<Spec>(await person(`/api/specs/${id}`, undefined, "GET"));
const newCase = async (projectId: number, title: string) => (await ok<{ id: number }>(await person(`/api/projects/${projectId}/cases`, { title, status: "ready", steps: [{ action: "Do it", expected: "" }] }))).id;

before(async () => {
  server = spawn(process.execPath, ["--import", "tsx", join(ROOT, "server", "index.ts")], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TESTBENCH_DATA: mkdtempSync(join(tmpdir(), "tb-specs-http-")), TESTBENCH_PORT: String(PORT), TESTBENCH_PASSWORD: PASSWORD, NODE_ENV: "production", TESTBENCH_AUTO_BACKUP: "0" },
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
  a = (await ok<{ id: number }>(await person("/api/projects", { name: "Specs A", key: "SPX" }))).id;
  b = (await ok<{ id: number }>(await person("/api/projects", { name: "Specs B", key: "SPY" }))).id;
  await ok(await person("/api/settings/agent-proposals", { enabled: true }, "PUT"));
  const mk = async (path: string, name: string) => { const t = (await ok<{ token: string }>(await person(`/api/projects/${a}/${path}`, { name }))).token; issued.push(t); return t; };
  tokens.read = await mk("agent/tokens", "reader");
  tokens.propose = await mk("propose-tokens", "proposer");
  tokens.request = await mk("request-tokens", "requester");
  tokens.ci = await mk("ci/tokens", "ci");
});
after(() => server?.kill());

describe("a person makes, reads, changes, renames, downloads and removes a spec", () => {
  it("makes one, which then is in the list without its text, and in full when asked for", async () => {
    const made = await ok<Spec>(await make(a, "login.spec.ts"));
    assert.deepEqual([made.fileName, made.status, made.testCase, made.projectId, made.text], ["login.spec.ts", "draft", null, a, TEXT]);
    assert.deepEqual(made.history.map((h) => h.kind), ["created"]);
    const list = await ok<(Omit<Spec, "text"> & { text?: string })[]>(await person(`/api/projects/${a}/specs`, undefined, "GET"));
    const mine = list.find((x) => x.id === made.id)!;
    assert.equal(mine.size, Buffer.byteLength(TEXT));
    assert.equal("text" in mine, false, "the list holds no text");
    assert.equal((await get(made.id)).text, TEXT);
    assert.equal((await ok<unknown[]>(await person(`/api/projects/${b}/specs`, undefined, "GET"))).length, 0, "another project has none");
  });

  it("refuses a bad name, a duplicate in any case, a text that is empty or over 200 kB, a case of another project, and an unknown status", async () => {
    await ok(await make(a, "Dup.spec.ts"));
    for (const [name, re] of [["e2e/login.spec.ts", /folder/], ["login.ts", /\.spec\.ts/], ["a b.spec.ts", /only letters/], ["login.v2.spec.ts", /only letters/], ["", /file name/]] as const) {
      const res = await make(a, name);
      assert.equal(res.status, 400, name);
      assert.match(((await res.json()) as { error: string }).error, re, name);
    }
    assert.equal((await make(a, "dup.spec.ts")).status, 409);
    assert.equal((await make(a, "DUP.spec.ts")).status, 409);
    assert.equal((await make(a, "empty.spec.ts", { text: "  \n" })).status, 400);
    const big = await make(a, "big.spec.ts", { text: "a".repeat(200 * 1024 + 1) });
    assert.equal(big.status, 400);
    assert.match(((await big.json()) as { error: string }).error, /at most 200 kB/);
    assert.equal((await make(a, "fits.spec.ts", { text: "a".repeat(200 * 1024) })).status, 200, "exactly 200 kB is fine");
    const huge = await make(a, "huge.spec.ts", { text: "a".repeat(2 * 1024 * 1024) }).catch(() => null); // the server may also drop the connection
    if (huge) assert.ok([400, 413].includes(huge.status), String(huge.status));
    const other = await newCase(b, "B case");
    assert.equal((await make(a, "case.spec.ts", { caseId: other })).status, 400, "a test case of another project");
    assert.equal((await make(a, "status.spec.ts", { status: "published" })).status, 400);
    const names = (await ok<{ fileName: string }[]>(await person(`/api/projects/${a}/specs`, undefined, "GET"))).map((x) => x.fileName);
    for (const refused of ["big.spec.ts", "huge.spec.ts", "empty.spec.ts", "case.spec.ts", "status.spec.ts"]) assert.equal(names.includes(refused), false, `${refused} was not made`);
  });

  it("changes the text, the status and the test case, and a change that changes nothing makes no revision", async () => {
    const c = await newCase(a, "A case");
    const s = await ok<Spec>(await make(a, "edit.spec.ts"));
    const edited = await ok<Spec>(await person(`/api/specs/${s.id}`, { text: `${TEXT}// more\n`, status: "ready", caseId: c }, "PATCH"));
    assert.deepEqual([edited.status, edited.testCase?.id, edited.history.map((h) => h.kind)], ["ready", c, ["created", "edited", "status", "case"]]);
    const same = await ok<Spec>(await person(`/api/specs/${s.id}`, { status: "ready", caseId: c }, "PATCH"));
    assert.equal(same.history.length, 4, "nothing changed, so no revision");
    const unlinked = await ok<Spec>(await person(`/api/specs/${s.id}`, { caseId: null }, "PATCH"));
    assert.equal(unlinked.testCase, null);
    assert.equal((await person(`/api/specs/${s.id}`, { text: "" }, "PATCH")).status, 400);
    assert.equal((await person(`/api/specs/${s.id}`, { fileName: "x.spec.ts" }, "PATCH")).status, 400, "a name is changed by renaming, not by this");
    assert.equal((await person(`/api/specs/${s.id}`, { projectId: b }, "PATCH")).status, 400, "nor can a spec be moved");
    assert.equal((await person("/api/specs/999999", { status: "ready" }, "PATCH")).status, 404);
  });

  it("renames one (not onto another's name), downloads it as a file, and removes it", async () => {
    const s = await ok<Spec>(await make(a, "before.spec.ts"));
    await ok(await make(a, "taken-name.spec.ts"));
    assert.equal((await person(`/api/specs/${s.id}/rename`, { fileName: "Taken-Name.spec.ts" })).status, 409);
    assert.equal((await person(`/api/specs/${s.id}/rename`, { fileName: "a/b.spec.ts" })).status, 400);
    const renamed = await ok<Spec>(await person(`/api/specs/${s.id}/rename`, { fileName: "after.spec.ts" }));
    assert.deepEqual([renamed.fileName, renamed.history.at(-1)!.kind, renamed.history.at(-1)!.note], ["after.spec.ts", "renamed", "before.spec.ts to after.spec.ts"]);
    const file = await call(`/api/specs/${s.id}/file`, { headers: { Cookie: cookie } });
    assert.equal(file.status, 200);
    assert.match(file.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(file.headers.get("x-content-type-options"), "nosniff");
    assert.equal(file.headers.get("content-disposition"), 'attachment; filename="after.spec.ts"');
    assert.equal(await file.text(), TEXT, "the text exactly as it was written, markup and all");
    assert.equal((await call(`/api/specs/${s.id}`, { method: "DELETE", headers: { "X-Testbench": "1", Cookie: cookie } })).status, 200);
    assert.equal((await call(`/api/specs/${s.id}`, { headers: { Cookie: cookie } })).status, 404);
    assert.equal((await call(`/api/specs/${s.id}/file`, { headers: { Cookie: cookie } })).status, 404);
    assert.equal((await person(`/api/specs/${s.id}/rename`, { fileName: "x.spec.ts" })).status, 404);
  });

  it("needs the login on every route, and the browser header on every change", async () => {
    const s = await ok<Spec>(await make(a, "guarded.spec.ts"));
    const routes: [string, string, unknown?][] = [
      ["GET", `/api/projects/${a}/specs`], ["POST", `/api/projects/${a}/specs`, { fileName: "n.spec.ts", text: "x" }], ["GET", `/api/specs/${s.id}`], ["PATCH", `/api/specs/${s.id}`, { status: "ready" }],
      ["POST", `/api/specs/${s.id}/rename`, { fileName: "n.spec.ts" }], ["DELETE", `/api/specs/${s.id}`], ["GET", `/api/specs/${s.id}/file`],
    ];
    for (const [method, path, body] of routes) {
      const res = await call(path, { method, headers: { ...JSON_H, "X-Testbench": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
      assert.equal(res.status, 401, `${method} ${path} without a login`);
      if (method !== "GET") {
        const noHeader = await call(path, { method, headers: { ...JSON_H, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
        assert.equal(noHeader.status, 403, `${method} ${path} without the browser header`);
      }
    }
    assert.equal((await get(s.id)).status, "draft", "nothing changed");
  });
});

describe("no kind of agent token reaches a spec, to read it or to change it", () => {
  it("is refused on every route, for every kind of token, with and without the browser header, and nothing changes", async () => {
    const s = await ok<Spec>(await make(a, "token-target.spec.ts"));
    const before = JSON.stringify([await get(s.id), await ok(await person(`/api/projects/${a}/specs`, undefined, "GET"))]);
    const routes: [string, string, unknown?][] = [
      ["GET", `/api/projects/${a}/specs`], ["POST", `/api/projects/${a}/specs`, { fileName: "taken-by-token.spec.ts", text: "// token" }], ["GET", `/api/specs/${s.id}`],
      ["PATCH", `/api/specs/${s.id}`, { text: "// token\n", status: "ready" }], ["POST", `/api/specs/${s.id}/rename`, { fileName: "renamed-by-token.spec.ts" }], ["DELETE", `/api/specs/${s.id}`],
      ["GET", `/api/specs/${s.id}/file`],
    ];
    let tried = 0;
    for (const [kind, token] of Object.entries(tokens)) {
      for (const withHeader of [false, true]) {
        for (const [method, path, body] of routes) {
          const res = await call(path, { method, headers: { ...JSON_H, Authorization: `Bearer ${token}`, ...(withHeader ? { "X-Testbench": "1" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
          assert.ok(res.status === 401 || res.status === 403, `${kind} token: ${method} ${path} (header ${withHeader}) answered ${res.status}`);
          tried++;
        }
      }
    }
    assert.equal(tried, 4 * 2 * 7, "every kind, with and without the header, on all seven routes");
    assert.equal(JSON.stringify([await get(s.id), await ok(await person(`/api/projects/${a}/specs`, undefined, "GET"))]), before, "nothing was read into, made, changed, renamed or removed");
  });

  it("a spec's text never reaches the server's output, and no token does either", async () => {
    assert.equal(output.includes(MARKER), false, "the server did not print a spec's text");
    for (const t of issued) assert.equal(output.includes(t), false, "the server did not print a token");
  });
});
