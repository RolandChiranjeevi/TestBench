#!/usr/bin/env node
// Checks the screens of roles with a real browser, on an instance WITH accounts (accounts are turned on here, so use a throwaway instance: an empty one, on this computer).
// It makes an owner, two projects and people with the roles admin, tester and viewer (and one with no project, and one in the other project) through the API, signs each in
// in the browser, and checks what they see and what is off for them:
//  - the role label beside the project name,
//  - the notice for a viewer, and the buttons that are off (with their reason) for a viewer but not for a tester,
//  - which settings tabs each role gets, and what the members page shows (email addresses and the forms only for an admin),
//  - that someone who is not in a project is sent away from it, and that someone in no project is told so.
// Then it runs the contrast and layout checks as a viewer and as the owner, which the other checks (on an instance without accounts) never see (unless ROLES_SKIP_VISUAL=1).
//
// Usage:  node scripts/check-roles-ui.mjs http://127.0.0.1:4100      (an EMPTY instance with no accounts, started on this computer)
//         CHECK_CPU_THROTTLE=8 node scripts/check-roles-ui.mjs ...   (the same, with the browser 8 times slower)
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseUrlFromArgs, launchBrowser } from "./lib/pages.mjs";

const BASE = baseUrlFromArgs("check-roles-ui.mjs");
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(BASE).hostname)) {
  console.error("This makes accounts and projects on the instance it is pointed at. Use a throwaway instance on this computer (127.0.0.1).");
  process.exit(2);
}
const PASSWORD = "ui-check-passphrase-1"; // a test value for this throwaway instance
const HDR = { "X-Testbench": "1", "Content-Type": "application/json" };
const failures = [];
const check = (name, ok, detail = "") => { if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`); };
/**
 * Waits for a page to show what it should. Reading the page straight after a click or a change of address races the page (the address changes before the page has been
 * drawn, and a slow machine shows it). Checks right after a page load, which waits for the network, do not need this; checks after an interaction do.
 */
async function eventually(read, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    try { if (await read()) return true; } catch { /* the page is still changing: try again */ }
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function call(method, path, body, cookie) {
  const res = await fetch(BASE + path, { method, headers: { ...HDR, ...(cookie ? { Cookie: `tb_sid=${cookie}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return { json, cookie: /tb_sid=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] };
}

// ---------- people and projects ----------
const status = (await call("GET", "/api/auth/status")).json;
if (status.mode === "accounts" || status.mode === "locked") { console.error("This instance already has accounts. Use an empty throwaway instance."); process.exit(2); }
const owner = (await call("POST", "/api/setup", { name: "Olle Owner", email: "owner@example.com", password: PASSWORD })).cookie;
const A = (await call("POST", "/api/demo", {}, owner)).json.id;
const B = (await call("POST", "/api/projects", { name: "Beta", key: "BET" }, owner)).json.id;
async function person(name, projectId, role) {
  const invite = (await call("POST", "/api/invitations", projectId ? { projectId, role } : {}, owner)).json;
  const joined = await call("POST", `/api/join/${invite.url.split("/").pop()}`, { name, email: `${name.toLowerCase()}@example.com`, password: PASSWORD });
  return joined.cookie;
}
const login = async (email, password) => (await call("POST", "/api/login", { email, password })).cookie;
const alive = async (cookie) => (await fetch(BASE + "/api/me", { headers: { ...HDR, Cookie: `tb_sid=${cookie}` } })).status === 200;
const cookies = { carl: await person("Carl", A, "tester"), owner, admin: await person("Ada", A, "admin"), tester: await person("Tess", A, "tester"), viewer: await person("Vera", A, "viewer"), outsider: await person("Bob", B, "tester"), nobody: await person("Nina", null) };

// ---------- the browser ----------
const browser = await launchBrowser();
async function open(who, path, width = 1440) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "light" });
  await ctx.addCookies([{ name: "tb_sid", value: cookies[who], url: BASE }]);
  const page = await ctx.newPage();
  // CHECK_CPU_THROTTLE=8 makes the browser 8 times slower, like a busy machine; the checks must give the same answers (they wait for the page).
  if (Number(process.env.CHECK_CPU_THROTTLE) > 1) await (await ctx.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.CHECK_CPU_THROTTLE) });
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  return { page, close: () => ctx.close() };
}
const texts = (page, selector) => page.locator(selector).allInnerTexts().then((t) => t.map((x) => x.trim()).filter(Boolean));

// The role label beside the project name.
for (const [who, label] of [["owner", "Owner"], ["admin", "Admin"], ["tester", "Tester"], ["viewer", "Viewer"]]) {
  const { page, close } = await open(who, `/p/${A}/cases`);
  const tag = await texts(page, ".project-switch .role-tag");
  check(`${who}: the role label`, tag.length === 1 && tag[0] === label, JSON.stringify(tag));
  const notice = await page.locator(".readonly-notice").count();
  check(`${who}: the read-only notice`, notice === (who === "viewer" ? 1 : 0), `${notice}`);

  // A button that takes the tester role: off, with its reason, for a viewer; on for the others.
  const newCase = page.getByRole("button", { name: /^New case/ }).first();
  await newCase.waitFor({ timeout: 10_000 });
  const disabled = await newCase.isDisabled();
  check(`${who}: "New case" is ${who === "viewer" ? "off" : "on"}`, disabled === (who === "viewer"));
  if (who === "viewer") {
    const reason = await newCase.locator("xpath=..").getAttribute("title");
    check("viewer: the reason is given", reason === "Needs the tester role in this project", `${reason}`);
    check("viewer: the reason is in the page for a screen reader", (await page.getByText("Needs the tester role in this project").count()) > 0);
  }
  await close();
}

// Settings tabs and the members page.
const TABS = {
  owner: ["Agent access", "Project", "Members", "Data", "Keyboard shortcuts", "Account"],
  admin: ["Agent access", "Project", "Members", "Keyboard shortcuts", "Account"],
  tester: ["Members", "Keyboard shortcuts", "Account"],
  viewer: ["Members", "Keyboard shortcuts", "Account"],
};
for (const who of Object.keys(TABS)) {
  const { page, close } = await open(who, `/p/${A}/settings/members`);
  const tabs = await texts(page, 'nav[aria-label="Settings sections"] a');
  check(`${who}: settings tabs`, JSON.stringify(tabs) === JSON.stringify(TABS[who]), JSON.stringify(tabs));
  const admin = who === "owner" || who === "admin";
  check(`${who}: member rows`, (await page.locator("table tbody tr").count()) >= 3);
  check(`${who}: email column ${admin ? "shown" : "hidden"}`, (await page.getByRole("columnheader", { name: "Email" }).count()) === (admin ? 1 : 0));
  check(`${who}: add-member form ${admin ? "shown" : "hidden"}`, (await page.getByText("Add someone who has an account").count()) === (admin ? 1 : 0));
  check(`${who}: invitation form ${admin ? "shown" : "hidden"}`, (await page.getByText("Invite someone who has no account").count()) === (admin ? 1 : 0));
  await close();
}
{ // a viewer who types the address of a tab that is not theirs gets an explanation, not an error
  const { page, close } = await open("viewer", `/p/${A}/settings/agent`);
  check("viewer: a tab that is not theirs", (await page.getByText("You cannot use this page").count()) === 1);
  await close();
}
{ // an admin changes a role and the change shows
  const { page, close } = await open("admin", `/p/${A}/settings/members`);
  const select = page.getByLabel("Role of Vera");
  await select.selectOption("tester");
  await page.getByText("Role changed").waitFor({ timeout: 10_000 });
  check("admin: the role was changed", await eventually(async () => (await select.inputValue()) === "tester"));
  await select.selectOption("viewer");
  await page.getByText("Role changed").first().waitFor({ timeout: 10_000 });
  await close();
}

// Someone who is not in the project, and someone who is in none.
{
  const { page, close } = await open("outsider", `/p/${A}/cases`);
  check("outsider: sent away from a project that is not theirs", await eventually(async () => !new URL(page.url()).pathname.startsWith(`/p/${A}/`)), page.url());
  check("outsider: their own project, with their role", await eventually(async () => (await texts(page, ".project-switch .role-tag"))[0] === "Tester"), JSON.stringify(await texts(page, ".project-switch .role-tag")));
  await close();
}
{
  const { page, close } = await open("nobody", "/");
  check("nobody: told they are in no project", (await page.getByText("You are not a member of any project yet").count()) === 1);
  check("nobody: cannot create a project or load the demo", (await page.getByRole("button", { name: /Create project|Load demo/ }).count()) === 0);
  await close();
}
{ // only the owner is offered a new project
  const o = await open("owner", `/p/${A}/cases`);
  await o.page.locator(".project-switch").click();
  check("owner: can make a project", await eventually(async () => (await o.page.getByRole("button", { name: /New project/ }).count()) === 1));
  await o.close();
  const v = await open("viewer", `/p/${A}/cases`);
  await v.page.locator(".project-switch").click();
  await v.page.locator(".project-menu").waitFor({ timeout: 8000 }); // the menu is open: only then is "no New project" a real answer
  check("viewer: cannot make a project", (await v.page.getByRole("button", { name: /New project/ }).count()) === 0);
  await v.close();
}

// /account: a person's own name, email, password and sessions (Carl has his own, so the others' sessions stay as they are).
{
  const { page, close } = await open("carl", "/account");
  const card = (title) => page.locator(".card").filter({ has: page.getByRole("heading", { name: title, exact: false }) });
  check("account: the page", (await page.getByRole("heading", { name: "Your account", level: 1 }).count()) === 1);
  const profile = card("Profile");
  check("account: the profile shows the name and email", (await profile.getByLabel("Name").inputValue()) === "Carl" && (await profile.getByLabel("Email address").inputValue()) === "carl@example.com");
  check("account: one session, marked", (await card("Sessions").locator("tbody tr").count()) === 1 && (await card("Sessions").getByText("This session").count()) === 1);

  // The name needs no password.
  await profile.getByLabel("Name").fill("Carl Carlsson");
  await profile.getByRole("button", { name: "Save" }).click();
  await page.getByText("Saved", { exact: true }).first().waitFor({ timeout: 10_000 });
  check("account: the name was saved", (await (await fetch(BASE + "/api/me", { headers: { ...HDR, Cookie: `tb_sid=${cookies.carl}` } })).json()).user.name === "Carl Carlsson");

  // The email takes the current password: the field appears, Save waits for it, a wrong one is refused, the right one works.
  await profile.getByLabel("Email address").fill("carl.new@example.com");
  const pw = profile.getByLabel("Current password");
  check("account: the password field appears when the email changes", await eventually(async () => (await pw.count()) === 1));
  check("account: Save waits for it", await eventually(() => profile.getByRole("button", { name: "Save" }).isDisabled()));
  await pw.fill("not the password!!");
  await profile.getByRole("button", { name: "Save" }).click();
  await page.getByText("Changing the email address takes your current password").first().waitFor({ timeout: 10_000 });
  check("account: a wrong password changed nothing", (await (await fetch(BASE + "/api/me", { headers: { ...HDR, Cookie: `tb_sid=${cookies.carl}` } })).json()).user.email === "carl@example.com");
  await pw.fill(PASSWORD);
  await profile.getByRole("button", { name: "Save" }).click();
  await page.waitForFunction(() => document.querySelector('input[type="email"]')?.value === "carl.new@example.com" && !document.querySelector('input[autocomplete="current-password"][aria-describedby="email-needs-password"]'), null, { timeout: 10_000 });
  check("account: the email was changed", (await login("carl.new@example.com", PASSWORD)) !== undefined);

  // Sessions: two more places, sign one out, then everywhere else.
  const phone = await login("carl.new@example.com", PASSWORD);
  const laptop = await login("carl.new@example.com", PASSWORD);
  await page.reload({ waitUntil: "networkidle" });
  const sessions = card("Sessions");
  check("account: the sessions are listed", (await sessions.locator("tbody tr").count()) >= 3, `${await sessions.locator("tbody tr").count()}`);
  await sessions.getByRole("button", { name: /^Sign out .* from / }).first().click();
  await page.getByText("Signed out", { exact: true }).first().waitFor({ timeout: 10_000 });
  check("account: one session was signed out", [await alive(phone), await alive(laptop)].filter(Boolean).length === 1);
  await sessions.getByRole("button", { name: /Sign out everywhere else/ }).click();
  await page.getByText(/Signed out of \d+ other session|There were no other sessions/).first().waitFor({ timeout: 10_000 });
  check("account: everywhere else was signed out", !(await alive(phone)) && !(await alive(laptop)) && (await alive(cookies.carl)));
  check("account: only this session is left", await eventually(async () => (await sessions.locator("tbody tr").count()) === 1));

  // Password: a mismatch is caught before sending, a wrong current one is refused, the right ones work and end the other sessions.
  const other = await login("carl.new@example.com", PASSWORD);
  const password = card("Password");
  const fill = async (cur, next, again) => { await password.getByLabel("Current password").fill(cur); await password.getByLabel("New password", { exact: true }).fill(next); await password.getByLabel("New password, again").fill(again); };
  const NEW = "a brand new ui passphrase";
  await fill(PASSWORD, NEW, NEW + "x");
  await password.getByRole("button", { name: "Change password" }).click();
  check("account: two different new passwords are caught", await eventually(async () => (await password.getByRole("alert").innerText()) === "The two new passwords are not the same"));
  await fill(PASSWORD, "short", "short");
  await password.getByRole("button", { name: "Change password" }).click();
  check("account: a short password is caught", await eventually(async () => /at least 10 characters/.test(await password.getByRole("alert").innerText())));
  await fill("the wrong current one", NEW, NEW);
  await password.getByRole("button", { name: "Change password" }).click();
  await page.getByText("The current password is wrong").first().waitFor({ timeout: 10_000 });
  check("account: a wrong current password changed nothing", (await login("carl.new@example.com", PASSWORD)) !== undefined);
  await fill(PASSWORD, NEW, NEW);
  await password.getByRole("button", { name: "Change password" }).click();
  await page.getByText("Your password is changed").waitFor({ timeout: 10_000 });
  check("account: the new password works", (await login("carl.new@example.com", NEW)) !== undefined);
  let oldWorks = true; try { await login("carl.new@example.com", PASSWORD); } catch { oldWorks = false; }
  check("account: the old password does not", !oldWorks);
  check("account: another session ended, this one stays", !(await alive(other)) && (await alive(cookies.carl)));
  await close();
}
{ // the way there: from a project (the sidebar) and from having no project
  const a = await open("admin", `/p/${A}/cases`);
  check("account: a link in the sidebar", await eventually(async () => (await a.page.locator('a[href="/account"]').count()) >= 1));
  await a.close();
  const n = await open("nobody", "/");
  await n.page.getByRole("link", { name: /Your account/ }).click();
  await n.page.waitForURL("**/account");
  check("account: reachable with no project", await eventually(async () => (await n.page.getByRole("heading", { name: "Your account", level: 1 }).count()) === 1));
  await n.close();
}

// An import makes drafts; a person reviews and approves them.
{
  const key = (await call("GET", "/api/projects", undefined, owner)).json.find((x) => x.id === A).key;
  const content = JSON.stringify({ format: "testbench-requirements", version: 1, project: key, requirements: [
    { id: "UI-IMP-1", title: "Imported by the UI check, one", status: "active" }, { id: "UI-IMP-2", title: "Imported by the UI check, two", status: "approved" },
  ] });
  const { page, close } = await open("tester", `/p/${A}/requirements`);
  await page.getByRole("button", { name: /^Import/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({ name: "ui-check.json", mimeType: "application/json", buffer: Buffer.from(content) });
  check("import: the preview says they become drafts", await eventually(async () => /2 new requirements are added as drafts/.test(await dialog.innerText())));
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByText(/Imported: 2 new \(2 as drafts\)/).first().waitFor({ timeout: 10_000 });
  const banner = page.getByRole("button", { name: /^Review and approve \d+ requirements?$/ });
  check("import: a button to review and approve appears", await eventually(async () => (await banner.count()) === 1));
  const status = async () => (await call("GET", `/api/projects/${A}/requirements`, undefined, owner)).json.filter((r) => r.external_id?.startsWith("UI-IMP-")).map((r) => `${r.status}:${r.origin}`);
  check("import: they are drafts, not approved", JSON.stringify(await status()) === JSON.stringify(["draft:import", "draft:import"]), JSON.stringify(await status()));
  await close();

  const v = await open("viewer", `/p/${A}/requirements`);
  check("import: a viewer cannot approve", await eventually(async () => (await v.page.getByRole("button", { name: /^Review and approve/ }).isDisabled())));
  await v.close();

  const t = await open("tester", `/p/${A}/requirements`);
  await t.page.getByRole("button", { name: /^Review and approve \d+ requirements?$/ }).click();
  const modal = t.page.getByRole("dialog");
  await modal.getByLabel(/Approve REQ-\d+ Imported by the UI check, two/).uncheck();
  check("import: the pick is counted", await eventually(async () => (await modal.getByRole("button", { name: "Approve 1 requirement", exact: true }).count()) === 1));
  await modal.getByRole("button", { name: "Approve 1 requirement", exact: true }).click();
  await t.page.getByText("Approved 1 requirement").first().waitFor({ timeout: 10_000 });
  check("import: only the picked one was approved", JSON.stringify(await status()) === JSON.stringify(["approved:import", "draft:import"]), JSON.stringify(await status()));
  const approved = (await call("GET", `/api/projects/${A}/requirements`, undefined, owner)).json.find((r) => r.external_id === "UI-IMP-1");
  check("import: the approver is the person who approved", approved.approved_by === "Tess", `${approved.approved_by}`);
  check("import: the banner counts what is left", await eventually(async () => (await t.page.getByRole("button", { name: "Review and approve 1 requirement", exact: true }).count()) === 1));
  await t.close();
}

// AI suggestions of test cases: read, change, add to the project as drafts, and decide what becomes ready.
{
  const key = (await call("GET", "/api/projects", undefined, owner)).json.find((x) => x.id === A).key;
  const test = (n) => ({ sourceId: `ui-sugg-${n}`, title: `UI suggestion ${n}`, description: "Made by the UI check", preconditions: "", steps: ["Open the page", "Check it"], expected: `It works (${n})`, priority: "medium", category: "functional", wcag: [], refs: { requirements: [], cases: [], tests: [] } });
  const files = { "manifest.json": { format: "testbench-audit-package", version: 1, audit: { id: "ui-check-audit", title: "UI check audit", project: key, agent: { name: "ui-check-agent" } }, files: [], parts: {} },
    "bugs.json": { version: 1, bugs: [] }, "manual-tests.json": { version: 1, tests: [1, 2, 3, 4, 5, 6].map(test) } };
  const form = new FormData();
  for (const [name, content] of Object.entries(files)) { form.append("relpath", name); form.append("file", new Blob([JSON.stringify(content)], { type: "application/json" }), name); }
  const seeded = await fetch(`${BASE}/api/projects/${A}/audit-import`, { method: "POST", headers: { "X-Testbench": "1", Cookie: `tb_sid=${owner}` }, body: form });
  check("suggestions: seeded", seeded.ok, `${seeded.status}`);
  const manualRows = async () => (await call("GET", `/api/projects/${A}/manual-tests?status=all`, undefined, owner)).json.items.filter((i) => i.sourceId.startsWith("ui-sugg-"));
  const caseOf = async (title) => (await call("GET", `/api/projects/${A}/cases`, undefined, owner)).json.find((c) => c.title === title);

  const { page, close } = await open("tester", `/p/${A}/manual-tests`);
  const row = (title) => page.locator(".suggestion-row", { hasText: title });
  check("suggestions: the tabs are Suggested, Added, Rejected", await eventually(async () => JSON.stringify((await texts(page, '[role="tab"]')).map((t) => t.replace(/\d+$/, "").trim()).slice(0, 3)) === JSON.stringify(["Suggested", "Added", "Rejected"])));
  check("suggestions: marked as AI, with Add to project and Dismiss", await eventually(async () => (await row("UI suggestion 1").getByText("AI suggestion").count()) === 1 && (await row("UI suggestion 1").getByRole("button", { name: /Add to project/ }).count()) === 1 && (await row("UI suggestion 1").getByRole("button", { name: "Dismiss" }).count()) === 1));

  // One suggestion from its row.
  await row("UI suggestion 1").getByRole("button", { name: /Add to project/ }).click();
  check("suggestions: 'Added as KEY (draft)' with a link", await eventually(async () => /Added as .+ \(draft\)/.test(await page.getByRole("status").first().innerText())));
  const one = await caseOf("UI suggestion 1");
  check("suggestions: it is a draft case", one?.status === "draft", JSON.stringify(one?.status));

  // Edit first, then add: what is typed is saved with it.
  await row("UI suggestion 2").locator(".row-main").click();
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("button", { name: "Edit", exact: true }).click();
  await dlg.getByLabel("Title").fill("UI suggestion 2, in my words");
  await dlg.getByRole("button", { name: /Add to project/ }).click();
  check("suggestions: the modal says it was added as a draft", await eventually(async () => /Added as .+ \(draft\)/.test(await dlg.innerText())));
  check("suggestions: and it has the edited words", (await caseOf("UI suggestion 2, in my words"))?.status === "draft");
  await dlg.locator(".modal-footer").getByRole("button", { name: "Close", exact: true }).click();

  // Several at once: add two, dismiss one, restore it.
  await row("UI suggestion 3").getByLabel(/^Select/).check();
  await row("UI suggestion 4").getByLabel(/^Select/).check();
  check("suggestions: the selection is counted", await eventually(async () => (await page.getByRole("button", { name: "Add 2 to project", exact: true }).count()) === 1));
  await page.getByRole("button", { name: "Add 2 to project", exact: true }).click();
  check("suggestions: both were added as drafts", await eventually(async () => (await caseOf("UI suggestion 3"))?.status === "draft" && (await caseOf("UI suggestion 4"))?.status === "draft"));
  await row("UI suggestion 5").getByLabel(/^Select/).check();
  await page.getByRole("button", { name: "Dismiss 1", exact: true }).click();
  check("suggestions: a dismissed one is not deleted, it is Rejected", await eventually(async () => (await manualRows()).find((m) => m.title === "UI suggestion 5")?.status === "rejected"));
  await page.getByRole("tab", { name: /^Rejected/ }).click();
  check("suggestions: and it can be restored", await eventually(async () => (await row("UI suggestion 5").getByRole("button", { name: /Restore to Suggested/ }).count()) === 1));
  await row("UI suggestion 5").getByRole("button", { name: /Restore to Suggested/ }).click();
  check("suggestions: restored to Suggested", await eventually(async () => (await manualRows()).find((m) => m.title === "UI suggestion 5")?.status === "proposed"));
  await close();

  // A viewer can read them but not act.
  const v = await open("viewer", `/p/${A}/manual-tests`);
  check("suggestions: a viewer's Add to project is off", await eventually(async () => (await v.page.locator(".suggestion-row", { hasText: "UI suggestion 6" }).getByRole("button", { name: /Add to project/ }).isDisabled())));
  await v.close();

  // The draft case says what it is, and Mark ready is the person's decision.
  const c = await caseOf("UI suggestion 1");
  const t = await open("tester", `/p/${A}/cases?case=${c.id}`);
  check("suggestions: the case says it is an AI suggestion and a draft", await eventually(async () => (await t.page.getByText("Made from an AI suggestion. It is a draft until you mark it ready.").count()) === 1));
  check("suggestions: with the chip", (await t.page.getByText("AI suggestion · Draft").count()) >= 1);
  await t.page.getByRole("button", { name: "Mark ready" }).click();
  check("suggestions: marked ready by the person", await eventually(async () => (await caseOf("UI suggestion 1"))?.status === "ready"));
  check("suggestions: the banner is gone once it is ready", await eventually(async () => (await t.page.getByText("It is a draft until you mark it ready.").count()) === 0));
  await t.close();
  const w = await open("viewer", `/p/${A}/cases?case=${(await caseOf("UI suggestion 2, in my words")).id}`);
  check("suggestions: a viewer cannot mark it ready", await eventually(async () => (await w.page.getByRole("button", { name: "Mark ready" }).isDisabled())));
  await w.close();
}

// AI suggestions of bugs: read, change, confirm as a bug, dismiss and restore. Confirming is a person's decision and the person is saved.
{
  const key = (await call("GET", "/api/projects", undefined, owner)).json.find((x) => x.id === A).key;
  const files = { "manifest.json": { format: "testbench-audit-package", version: 1, audit: { id: "ui-bug-audit", title: "UI bug audit", project: key, agent: { name: "ui-check-agent" } }, files: [], parts: {} },
    "bugs.json": { version: 1, bugs: [1, 2, 3, 4].map((n) => ({ sourceId: `ui-bug-${n}`, title: `UI bug ${n}`, description: "Found by the UI check" })) } };
  const form = new FormData();
  for (const [name, content] of Object.entries(files)) { form.append("relpath", name); form.append("file", new Blob([JSON.stringify(content)], { type: "application/json" }), name); }
  const seeded = await fetch(`${BASE}/api/projects/${A}/audit-import`, { method: "POST", headers: { "X-Testbench": "1", Cookie: `tb_sid=${owner}` }, body: form });
  check("bug suggestions: seeded", seeded.ok, `${seeded.status}`);
  const tokenRes = (await call("POST", `/api/projects/${A}/ci/tokens`, { name: "ui check" }, owner)).json;
  const ci = await fetch(`${BASE}/api/projects/${A}/ci/test-results`, { method: "POST", headers: { ...HDR, Authorization: `Bearer ${tokenRes.token}` }, body: JSON.stringify({ runId: "ui-bug-run", commitSha: "abc1234567", branch: "main", repository: "o/r", pipelineUrl: "https://github.com/o/r/actions/runs/1", startedAt: "2026-11-04T07:00:00Z", finishedAt: "2026-11-04T07:04:00Z", results: [{ testKey: "ui-ci-bug", title: "UI CI failure", status: "failed", durationMs: 1, error: "boom", steps: [], attachments: [], tags: [] }] }) });
  check("bug suggestions: a CI failure was seeded", ci.ok, `${ci.status}`);
  const bugRows = async () => (await call("GET", `/api/projects/${A}/bug-reports?status=all`, undefined, owner)).json.items;
  const bugOf = async (title) => (await bugRows()).find((b) => b.title === title);

  const { page, close } = await open("tester", `/p/${A}/bugs`);
  const row = (title) => page.locator(".suggestion-row", { hasText: title });
  check("bug suggestions: the tabs are Suggested, Confirmed, Dismissed", await eventually(async () => JSON.stringify((await texts(page, '[role="tab"]')).map((t) => t.replace(/\d+$/, "").trim()).slice(0, 3)) === JSON.stringify(["Suggested", "Confirmed", "Dismissed"])));
  check("bug suggestions: an agent's bug is marked AI, with Confirm bug and Dismiss", await eventually(async () => (await row("UI bug 1").getByText("AI suggestion").count()) === 1 && (await row("UI bug 1").getByRole("button", { name: /Confirm bug/ }).count()) === 1 && (await row("UI bug 1").getByRole("button", { name: "Dismiss" }).count()) === 1));
  check("bug suggestions: a CI bug says From CI and is not marked AI", await eventually(async () => (await row("UI CI failure").getByText("From CI", { exact: true }).count()) === 1 && (await row("UI CI failure").getByText("AI suggestion").count()) === 0));

  // From the row.
  await row("UI bug 1").getByRole("button", { name: /Confirm bug/ }).click();
  check("bug suggestions: confirmed, with the person saved", await eventually(async () => { const b = await bugOf("UI bug 1"); return b?.status === "accepted" && b.reviewedBy === "Tess"; }));
  await page.getByRole("tab", { name: /^Confirmed/ }).click();
  check("bug suggestions: the Confirmed tab says who", await eventually(async () => (await row("UI bug 1").innerText()).includes("Confirmed by Tess")));
  check("bug suggestions: and calls it bug #N", await eventually(async () => /bug #\d+/.test(await row("UI bug 1").innerText())));
  await page.getByRole("tab", { name: /^Suggested/ }).click();

  // Edit first, then confirm: what is typed is saved with it.
  await row("UI bug 2").locator(".row-main").click();
  const dlg = page.getByRole("dialog");
  check("bug suggestions: the modal has Triage as its own section", await eventually(async () => (await dlg.locator(".section-label", { hasText: /^Triage$/ }).count()) === 1));
  await dlg.getByRole("button", { name: "Edit", exact: true }).click();
  await dlg.getByLabel("Title").fill("UI bug 2, in my words");
  await dlg.getByRole("button", { name: /Confirm bug/ }).click();
  check("bug suggestions: the modal says Confirmed as bug #N, with a link", await eventually(async () => /Confirmed as bug #\d+\. Not published anywhere\./.test(await dlg.getByRole("status").first().innerText())));
  check("bug suggestions: and it has the edited words", await eventually(async () => { const b = await bugOf("UI bug 2, in my words"); return b?.status === "accepted" && b.reviewedBy === "Tess"; }));
  check("bug suggestions: the modal says Confirmed by", await eventually(async () => (await dlg.getByText("Confirmed by Tess").count()) === 1));
  check("bug suggestions: a confirmed bug has no way back to Suggested", (await dlg.getByRole("button", { name: /Suggested/ }).count()) === 0);
  await dlg.getByRole("link", { name: /bug #\d+/ }).click();
  check("bug suggestions: the Confirmed as bug #N link keeps the same bug open", await eventually(async () => page.url().includes("bug=") && (await dlg.getByText("Confirmed by Tess").count()) === 1));
  await dlg.locator(".modal-footer").getByRole("button", { name: "Close", exact: true }).click();

  // Dismiss is not deleting, and it can be undone.
  await row("UI bug 3").getByRole("button", { name: "Dismiss" }).click();
  check("bug suggestions: a dismissed one is kept, as rejected", await eventually(async () => { const b = await bugOf("UI bug 3"); return b?.status === "rejected" && b.reviewedBy === "Tess"; }));
  await page.getByRole("tab", { name: /^Dismissed/ }).click();
  check("bug suggestions: and it can be restored", await eventually(async () => (await row("UI bug 3").getByRole("button", { name: /Restore to Suggested/ }).count()) === 1));
  await row("UI bug 3").getByRole("button", { name: /Restore to Suggested/ }).click();
  check("bug suggestions: restored to Suggested", await eventually(async () => (await bugOf("UI bug 3"))?.status === "proposed"));
  // And from the modal.
  await page.getByRole("tab", { name: /^Suggested/ }).click();
  await row("UI bug 3").getByRole("button", { name: "Dismiss" }).click();
  check("bug suggestions: dismissed again", await eventually(async () => (await bugOf("UI bug 3"))?.status === "rejected"));
  await page.getByRole("tab", { name: /^Dismissed/ }).click();
  await row("UI bug 3").locator(".row-main").click();
  await page.getByRole("dialog").getByRole("button", { name: /Restore to Suggested/ }).click();
  check("bug suggestions: restored from the modal too", await eventually(async () => (await bugOf("UI bug 3"))?.status === "proposed"));
  await page.getByRole("dialog").locator(".modal-footer").getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("tab", { name: /^Confirmed/ }).click();
  check("bug suggestions: a confirmed bug has no Restore on its row", (await row("UI bug 1").getByRole("button", { name: /Restore/ }).count()) === 0);
  await close();

  // A viewer can read them but not act.
  const v = await open("viewer", `/p/${A}/bugs`);
  check("bug suggestions: a viewer's Confirm bug and Dismiss are off", await eventually(async () => (await v.page.locator(".suggestion-row", { hasText: "UI bug 4" }).getByRole("button", { name: /Confirm bug/ }).isDisabled()) && (await v.page.locator(".suggestion-row", { hasText: "UI bug 4" }).getByRole("button", { name: "Dismiss" }).isDisabled())));
  await v.page.locator(".suggestion-row", { hasText: "UI bug 4" }).locator(".row-main").click();
  check("bug suggestions: and so are they in the modal", await eventually(async () => (await v.page.getByRole("dialog").getByRole("button", { name: /Confirm bug/ }).isDisabled()) && (await v.page.getByRole("dialog").getByRole("button", { name: "Dismiss", exact: true }).isDisabled())));
  await v.close();
  check("bug suggestions: nothing was confirmed by the viewer, the import or CI", (await bugRows()).filter((b) => b.status === "accepted").every((b) => b.reviewedBy === "Tess"));
}

// Severity: the AI suggests, a person decides. A suggestion is marked as one, Confirm bug in the modal saves what is shown as the person's decision, and every change is logged.
{
  const key = (await call("GET", "/api/projects", undefined, owner)).json.find((x) => x.id === A).key;
  const files = { "manifest.json": { format: "testbench-audit-package", version: 1, audit: { id: "ui-sev-audit", title: "UI severity audit", project: key, agent: { name: "ui-check-agent" } }, files: [], parts: {} },
    "bugs.json": { version: 1, bugs: [["1", "high"], ["2", "medium"], ["3", "low"], ["4", "high"]].map(([n, sev]) => ({ sourceId: `ui-sev-${n}`, title: `UI sev ${n}`, description: "Found by the UI check", agentSeverity: sev })) } };
  const form = new FormData();
  for (const [name, content] of Object.entries(files)) { form.append("relpath", name); form.append("file", new Blob([JSON.stringify(content)], { type: "application/json" }), name); }
  const seeded = await fetch(`${BASE}/api/projects/${A}/audit-import`, { method: "POST", headers: { "X-Testbench": "1", Cookie: `tb_sid=${owner}` }, body: form });
  check("severity: seeded", seeded.ok, `${seeded.status}`);
  const sevRows = async () => (await call("GET", `/api/projects/${A}/bug-reports?status=all`, undefined, owner)).json.items;
  const sevOf = async (title) => (await sevRows()).find((b) => b.title === title);
  const detailOf = async (title) => (await call("GET", `/api/bug-reports/${(await sevOf(title)).id}`, undefined, owner)).json;

  const { page, close } = await open("tester", `/p/${A}/bugs`);
  const row = (title) => page.locator(".suggestion-row", { hasText: title });
  check("severity: an AI suggestion is marked as one, with the word Major", await eventually(async () => (await row("UI sev 1").innerText()).includes("Major · AI suggestion")));
  check("severity: a CI default says so and is not called AI", await eventually(async () => { const t = await row("UI CI failure").innerText(); return t.includes("Default from CI") && !t.includes("AI suggestion"); }));

  // Decide it in the modal: change, give a reason, save.
  await row("UI sev 1").locator(".row-main").click();
  const dlg = page.getByRole("dialog");
  check("severity: the modal says nobody has decided", await eventually(async () => (await dlg.getByText("Not decided").count()) === 1));
  await dlg.locator("#human-sev").selectOption("critical");
  await dlg.getByLabel("Reason for the severity").fill("checkout is down");
  await dlg.getByRole("button", { name: "Set severity" }).click();
  check("severity: saved as Tess's decision, with the reason", await eventually(async () => { const b = await sevOf("UI sev 1"); const d = await detailOf("UI sev 1"); return b.severity === "critical" && b.severitySource === "human" && b.severityBy === "Tess" && d.severity.reason === "checkout is down"; }));
  check("severity: the modal says Severity set by Tess", await eventually(async () => (await dlg.getByText(/Severity set by Tess: checkout is down/).count()) === 1));
  check("severity: and the change is in the history", await eventually(async () => (await dlg.getByText("Severity Major → Critical, Tess: checkout is down").count()) === 1));
  // Taking the decision back falls back to the suggestion and is logged.
  await dlg.locator("#human-sev").selectOption("");
  await dlg.getByRole("button", { name: "Remove decision" }).click();
  check("severity: 'Not set' removes the decision", await eventually(async () => { const b = await sevOf("UI sev 1"); return b.severity === "high" && b.severitySource === "ai"; }));
  check("severity: and that is logged", await eventually(async () => (await dlg.getByText(/Severity decision removed \(back to the suggestion Major\), Tess/).count()) === 1));
  await dlg.locator(".modal-footer").getByRole("button", { name: "Close", exact: true }).click();

  // Confirm bug in the modal saves what is shown as the decision.
  await row("UI sev 2").locator(".row-main").click();
  check("severity: Confirm bug says what it will save", await eventually(async () => (await dlg.getByText("Confirm bug saves Medium as your decision.").count()) === 1));
  await dlg.getByRole("button", { name: /Confirm bug/ }).click();
  check("severity: confirmed with the severity as Tess's decision", await eventually(async () => { const b = await sevOf("UI sev 2"); return b.status === "accepted" && b.severity === "medium" && b.severitySource === "human" && b.severityBy === "Tess"; }));
  check("severity: and the history says it was an AI suggestion that was confirmed", await eventually(async () => (await dlg.getByText("Severity Medium (AI suggestion) confirmed, Tess").count()) === 1));
  // After confirming it can still be changed, and that is logged.
  await dlg.locator("#human-sev").selectOption("low");
  await dlg.getByRole("button", { name: "Change severity" }).click();
  check("severity: changed after the bug was confirmed", await eventually(async () => (await sevOf("UI sev 2"))?.severity === "low"));
  check("severity: and logged", await eventually(async () => (await dlg.getByText("Severity Medium → Low, Tess").count()) === 1));
  await dlg.locator(".modal-footer").getByRole("button", { name: "Close", exact: true }).click();

  // Confirm bug from the row confirms the bug only.
  await row("UI sev 3").getByRole("button", { name: /Confirm bug/ }).click();
  check("severity: from the row, the bug is confirmed and the severity stays a suggestion", await eventually(async () => { const b = await sevOf("UI sev 3"); return b.status === "accepted" && b.severitySource === "ai" && b.severityBy === null; }));
  await close();

  // A viewer sees it but cannot change it.
  const v = await open("viewer", `/p/${A}/bugs?bug=${(await sevOf("UI sev 4")).id}`);
  const vd = v.page.getByRole("dialog");
  check("severity: a viewer's severity controls are off", await eventually(async () => (await vd.locator("#human-sev").isDisabled()) && (await vd.getByLabel("Reason for the severity").isDisabled()) && (await vd.getByRole("button", { name: "Set severity" }).isDisabled())));
  await v.close();
  check("severity: nothing was decided by a viewer, the import or CI", (await sevRows()).filter((b) => b.severitySource === "human").every((b) => b.severityBy === "Tess"));
}

// The test plan is a workspace: the agent proposes, a person edits and decides, an import never overwrites what a person owns, and every change is in the history.
{
  const key = (await call("GET", "/api/projects", undefined, owner)).json.find((x) => x.id === A).key;
  const planItem = (n, over = {}) => ({ sourceId: `UIP-${n}`, title: `UI plan ${n}`, type: "Functional", priority: "High", steps: [`Step for ${n}`], acceptanceCriteria: `It works ${n}`, ...over });
  const send = async (items, dryRun = false) => {
    const files = { "manifest.json": { format: "testbench-audit-package", version: 1, audit: { id: "ui-plan-audit", title: "UI plan audit", project: key, agent: { name: "ui-check-agent" } }, files: [], parts: {} },
      "bugs.json": { version: 1, bugs: [] }, "test-plan.json": { version: 1, planItems: items, coverageGaps: [] } };
    const form = new FormData();
    for (const [name, content] of Object.entries(files)) { form.append("relpath", name); form.append("file", new Blob([JSON.stringify(content)], { type: "application/json" }), name); }
    return fetch(`${BASE}/api/projects/${A}/audit-import${dryRun ? "?dryRun=1" : ""}`, { method: "POST", headers: { "X-Testbench": "1", Cookie: `tb_sid=${owner}` }, body: form });
  };
  const seeded = await send([planItem(1), planItem(2), planItem(3)]);
  check("test plan: seeded", seeded.ok, `${seeded.status}`);
  const auditId = (await call("GET", `/api/projects/${A}/audits`, undefined, owner)).json.find((a) => a.agentAuditId === "ui-plan-audit").id;
  const planNow = async () => (await call("GET", `/api/audits/${auditId}/plan`, undefined, owner)).json.planItems;
  const itemNow = async (id) => (await planNow()).find((x) => x.sourceId === id);

  const { page, close } = await open("tester", `/p/${A}/test-plan?audit=${auditId}`);
  const entry = (title) => page.locator(".plan-entry", { hasText: title });
  const openRow = async (title) => { await entry(title).locator(".plan-row").click(); };
  check("test plan: what the agent sent is marked AI proposal", await eventually(async () => (await entry("UI plan 1").innerText()).includes("AI proposal")));

  // Edit and approve in one go.
  await openRow("UI plan 1");
  await entry("UI plan 1").getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator("#pf-title").fill("UI plan 1, my wording");
  await entry("UI plan 1").getByRole("button", { name: "Approve", exact: true }).click();
  check("test plan: edited and approved by Tess", await eventually(async () => { const x = await itemNow("UIP-1"); return x.title === "UI plan 1, my wording" && x.status === "approved" && x.editedBy === "Tess" && x.decidedBy === "Tess"; }));
  check("test plan: the row says Approved and Edited by Tess, not AI proposal", await eventually(async () => { const t = await entry("UI plan 1, my wording").locator(".plan-row").innerText(); return t.includes("Approved") && t.includes("Edited by Tess") && !t.includes("AI proposal"); }));

  // Reject and save as draft from the row.
  await openRow("UI plan 2");
  await entry("UI plan 2").getByRole("button", { name: "Reject", exact: true }).click();
  check("test plan: rejected", await eventually(async () => (await itemNow("UIP-2")).status === "rejected"));
  await openRow("UI plan 3");
  await entry("UI plan 3").getByRole("button", { name: "Save as draft" }).click();
  check("test plan: saved as a draft", await eventually(async () => (await itemNow("UIP-3")).status === "draft"));

  // An import of a newer plan changes nothing a person owns: the agent's version waits.
  const dry = await (await send([planItem(1, { title: "UI plan 1, agent's wording" }), planItem(3, { title: "UI plan 3, agent's wording" }), planItem(4)], true)).json();
  check("test plan: the import preview says posts are kept with the agent's version waiting", dry.testPlan.planItems.counts.pending >= 2, JSON.stringify(dry.testPlan.planItems.counts));
  const again = await send([planItem(1, { title: "UI plan 1, agent's wording" }), planItem(3, { title: "UI plan 3, agent's wording" }), planItem(4)]);
  check("test plan: the newer plan was imported", again.ok, `${again.status}`);
  check("test plan: nothing a person owns was overwritten or removed", (await itemNow("UIP-1")).title === "UI plan 1, my wording" && (await itemNow("UIP-1")).status === "approved" && (await itemNow("UIP-2")).status === "rejected" && (await itemNow("UIP-3")).title === "UI plan 3");
  check("test plan: and the new item arrived as a proposal", (await itemNow("UIP-4")).status === "proposed");
  await page.reload();
  check("test plan: the rows say an agent update is waiting", await eventually(async () => (await entry("UI plan 1, my wording").locator(".plan-row").innerText()).includes("Agent update waiting")));
  await openRow("UI plan 1, my wording");
  const banner = entry("UI plan 1, my wording").getByRole("region", { name: "Agent sent a newer version" });
  check("test plan: the banner shows the diff", await eventually(async () => (await banner.count()) === 1 && (await banner.innerText()).includes("UI plan 1, agent's wording")));
  await banner.getByRole("button", { name: "Ignore" }).click();
  check("test plan: Ignore keeps the person's text and clears the waiting version", await eventually(async () => { const x = await itemNow("UIP-1"); return x.pending === null && x.title === "UI plan 1, my wording"; }));
  await openRow("UI plan 3");
  await entry("UI plan 3").getByRole("region", { name: "Agent sent a newer version" }).getByRole("button", { name: "Apply" }).click();
  check("test plan: Apply takes the agent's text as a draft", await eventually(async () => { const x = await itemNow("UIP-3"); return x.title === "UI plan 3, agent's wording" && x.status === "draft" && x.pending === null; }));
  check("test plan: the same ignored version is not offered again", await (async () => { await send([planItem(1, { title: "UI plan 1, agent's wording" }), planItem(3, { title: "UI plan 3, agent's wording" }), planItem(4)]); return (await itemNow("UIP-1")).pending === null; })());

  // History.
  await page.getByRole("button", { name: "History" }).click();
  const hist = page.getByRole("region", { name: "Plan history" });
  check("test plan: the history says who did what", await eventually(async () => { const t = await hist.innerText(); return t.includes("Approved") && t.includes("by Tess") && t.includes("Agent sent a newer version") && t.includes("Agent import") && t.includes("Applied the agent's version") && t.includes("Ignored the agent's version"); }));
  await page.getByRole("button", { name: "History" }).click();

  // A person's own item.
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByRole("dialog").locator("#pf-title").fill("UI plan my own");
  await page.getByRole("dialog").getByRole("button", { name: "Add as draft" }).click();
  check("test plan: the person's own item is a human draft", await eventually(async () => { const x = (await planNow()).find((i) => i.title === "UI plan my own"); return x && x.origin === "human" && x.status === "draft" && x.editedBy === "Tess"; }));
  await send([planItem(1, { title: "UI plan 1, agent's wording" })]);
  check("test plan: an import that leaves it out does not remove it", (await planNow()).some((i) => i.title === "UI plan my own"));
  await close();

  // A viewer reads but cannot change.
  const v = await open("viewer", `/p/${A}/test-plan?audit=${auditId}`);
  await v.page.locator(".plan-entry", { hasText: "UI plan 1, my wording" }).locator(".plan-row").click();
  const ve = v.page.locator(".plan-entry", { hasText: "UI plan 1, my wording" });
  check("test plan: a viewer's Edit, Save as draft, Reject and Add item are off", await eventually(async () => (await ve.getByRole("button", { name: "Edit", exact: true }).isDisabled()) && (await ve.getByRole("button", { name: "Save as draft" }).isDisabled()) && (await ve.getByRole("button", { name: "Reject", exact: true }).isDisabled()) && (await v.page.getByRole("button", { name: "Add item" }).isDisabled())));
  await v.close();
  check("test plan: nothing was decided by a viewer or the import", (await planNow()).filter((x) => x.decidedBy).every((x) => x.decidedBy === "Tess"));
}

// Coverage gaps work like plan items: marked as the agent's proposal, edited and decided by a person, never overwritten or removed by an import, with one shared history.
{
  const key = (await call("GET", "/api/projects", undefined, owner)).json.find((x) => x.id === A).key;
  const gapOf = (n, over = {}) => ({ sourceId: `UIG-${n}`, description: `UI gap ${n} is not verified`, refs: { requirements: [] }, ...over });
  const sendGaps = async (gaps, dryRun = false) => {
    const files = { "manifest.json": { format: "testbench-audit-package", version: 1, audit: { id: "ui-gap-audit", title: "UI gap audit", project: key, agent: { name: "ui-check-agent" } }, files: [], parts: {} },
      "bugs.json": { version: 1, bugs: [] }, "test-plan.json": { version: 1, planItems: [{ sourceId: "UIGP-1", title: "UI gap plan item" }], coverageGaps: gaps } };
    const form = new FormData();
    for (const [name, content] of Object.entries(files)) { form.append("relpath", name); form.append("file", new Blob([JSON.stringify(content)], { type: "application/json" }), name); }
    return fetch(`${BASE}/api/projects/${A}/audit-import${dryRun ? "?dryRun=1" : ""}`, { method: "POST", headers: { "X-Testbench": "1", Cookie: `tb_sid=${owner}` }, body: form });
  };
  const seeded = await sendGaps([gapOf(1), gapOf(2), gapOf(3)]);
  check("gaps: seeded", seeded.ok, `${seeded.status}`);
  const auditId = (await call("GET", `/api/projects/${A}/audits`, undefined, owner)).json.find((a) => a.agentAuditId === "ui-gap-audit").id;
  const gapsNow = async () => (await call("GET", `/api/audits/${auditId}/plan`, undefined, owner)).json.coverageGaps;
  const gapNow = async (id) => (await gapsNow()).find((g) => g.sourceId === id);

  const { page, close } = await open("tester", `/p/${A}/test-plan?audit=${auditId}`);
  const li = (id) => page.locator(`li[data-gap="${id}"]`);
  check("gaps: what the agent sent is marked AI proposal", await eventually(async () => (await li("UIG-1").innerText()).includes("AI proposal")));

  // Edit and approve.
  await li("UIG-1").getByRole("button", { name: "Edit", exact: true }).click();
  await li("UIG-1").locator("textarea").fill("UI gap 1, my wording");
  await li("UIG-1").getByRole("button", { name: "Approve", exact: true }).click();
  check("gaps: edited and approved by Tess", await eventually(async () => { const g = await gapNow("UIG-1"); return g.description === "UI gap 1, my wording" && g.status === "approved" && g.editedBy === "Tess" && g.decidedBy === "Tess"; }));
  check("gaps: the row says Approved and Edited by Tess, not AI proposal", await eventually(async () => { const t = await li("UIG-1").innerText(); return t.includes("Approved") && t.includes("Edited by Tess") && !t.includes("AI proposal"); }));
  await li("UIG-2").getByRole("button", { name: "Reject", exact: true }).click();
  check("gaps: rejected", await eventually(async () => (await gapNow("UIG-2")).status === "rejected"));
  await li("UIG-3").getByRole("button", { name: "Save as draft" }).click();
  check("gaps: saved as a draft", await eventually(async () => (await gapNow("UIG-3")).status === "draft"));

  // A newer plan changes nothing a person owns.
  const dry = await (await sendGaps([gapOf(1, { description: "UI gap 1, agent's wording" }), gapOf(3, { description: "UI gap 3, agent's wording" }), gapOf(4)], true)).json();
  check("gaps: the import preview says gaps are kept with the agent's version waiting", dry.testPlan.coverageGaps.counts.pending >= 3, JSON.stringify(dry.testPlan.coverageGaps.counts));
  const again = await sendGaps([gapOf(1, { description: "UI gap 1, agent's wording" }), gapOf(3, { description: "UI gap 3, agent's wording" }), gapOf(4)]);
  check("gaps: the newer plan was imported", again.ok, `${again.status}`);
  check("gaps: nothing a person owns was overwritten or removed", (await gapNow("UIG-1")).description === "UI gap 1, my wording" && (await gapNow("UIG-2")).status === "rejected" && (await gapNow("UIG-3")).description === "UI gap 3 is not verified");
  check("gaps: and the new gap arrived as a proposal", (await gapNow("UIG-4")).status === "proposed");
  await page.reload();
  check("gaps: the rows say an agent update or removal is waiting", await eventually(async () => (await li("UIG-1").innerText()).includes("Agent update waiting") && (await li("UIG-2").innerText()).includes("Agent removal waiting")));
  const banner = (id) => li(id).getByRole("region", { name: "Agent sent a newer version" });
  check("gaps: the banner shows the diff", await eventually(async () => (await banner("UIG-1").count()) === 1 && (await banner("UIG-1").innerText()).includes("UI gap 1, agent's wording")));
  await banner("UIG-1").getByRole("button", { name: "Ignore" }).click();
  check("gaps: Ignore keeps the person's text and clears the waiting version", await eventually(async () => { const g = await gapNow("UIG-1"); return g.pending === null && g.description === "UI gap 1, my wording"; }));
  await banner("UIG-3").getByRole("button", { name: "Apply" }).click();
  check("gaps: Apply takes the agent's text as a draft", await eventually(async () => { const g = await gapNow("UIG-3"); return g.description === "UI gap 3, agent's wording" && g.status === "draft" && g.pending === null; }));
  await li("UIG-2").getByRole("region", { name: "Agent sent a newer version" }).getByRole("button", { name: "Keep the gap" }).click();
  check("gaps: Keep the gap keeps a gap the agent left out", await eventually(async () => { const g = await gapNow("UIG-2"); return g && g.pending === null; }));

  // One history for plan items and gaps.
  await page.getByRole("button", { name: "History" }).click();
  const hist = page.getByRole("region", { name: "Plan history" });
  check("gaps: the history has gaps and plan items, each marked", await eventually(async () => { const t = await hist.innerText(); return t.includes("Gap") && t.includes("Plan item") && t.includes("Approved") && t.includes("by Tess") && t.includes("Agent sent a newer version") && t.includes("Applied the agent's version"); }));
  await page.getByRole("button", { name: "History" }).click();

  // A person's own gap.
  await page.getByRole("button", { name: "Add gap" }).click();
  await page.getByRole("dialog").locator("textarea").fill("UI gap my own");
  await page.getByRole("dialog").getByRole("button", { name: "Add as draft" }).click();
  check("gaps: the person's own gap is a human draft", await eventually(async () => { const g = (await gapsNow()).find((x) => x.description === "UI gap my own"); return g && g.origin === "human" && g.status === "draft" && g.editedBy === "Tess"; }));
  await sendGaps([gapOf(1, { description: "UI gap 1, agent's wording" })]);
  check("gaps: an import that leaves it out does not remove it", (await gapsNow()).some((g) => g.description === "UI gap my own"));
  await close();

  // A viewer reads but cannot change.
  const v = await open("viewer", `/p/${A}/test-plan?audit=${auditId}`);
  const vli = v.page.locator('li[data-gap="UIG-1"]');
  check("gaps: a viewer's Edit, Reject, Save as draft and Add gap are off", await eventually(async () => (await vli.getByRole("button", { name: "Edit", exact: true }).isDisabled()) && (await vli.getByRole("button", { name: "Reject", exact: true }).isDisabled()) && (await vli.getByRole("button", { name: "Save as draft" }).isDisabled()) && (await v.page.getByRole("button", { name: "Add gap" }).isDisabled())));
  await v.close();
  check("gaps: nothing was decided by a viewer or the import", (await gapsNow()).filter((g) => g.decidedBy).every((g) => g.decidedBy === "Tess"));
}

// Automation suggestions: made by a fixed rule (never called AI) for an approved plan item, decided by a person; Apply makes a DRAFT test case and approves nothing.
{
  const key = (await call("GET", "/api/projects", undefined, owner)).json.find((x) => x.id === A).key;
  const plan = (n, over = {}) => ({ sourceId: `UIA-${n}`, title: `UI auto ${n}`, type: "Functional", priority: "High", steps: [`Open the page ${n}`, "Type the text"], acceptanceCriteria: "The text is shown", ...over });
  const files = { "manifest.json": { format: "testbench-audit-package", version: 1, audit: { id: "ui-auto-audit", title: "UI automation audit", project: key, agent: { name: "ui-check-agent" } }, files: [], parts: {} },
    "bugs.json": { version: 1, bugs: [] }, "test-plan.json": { version: 1, planItems: [plan(1), plan(2, { steps: [] }), plan(3), plan(4), plan(5), plan(6)], coverageGaps: [] } };
  const form = new FormData();
  for (const [name, content] of Object.entries(files)) { form.append("relpath", name); form.append("file", new Blob([JSON.stringify(content)], { type: "application/json" }), name); }
  const seeded = await fetch(`${BASE}/api/projects/${A}/audit-import`, { method: "POST", headers: { "X-Testbench": "1", Cookie: `tb_sid=${owner}` }, body: form });
  check("automation: seeded", seeded.ok, `${seeded.status}`);
  const auditId = (await call("GET", `/api/projects/${A}/audits`, undefined, owner)).json.find((a) => a.agentAuditId === "ui-auto-audit").id;
  for (const n of [1, 2, 3, 4, 6]) await call("POST", `/api/audits/${auditId}/plan/items/UIA-${n}/decision`, { status: "approved" }, owner);
  const sugs = async () => (await call("GET", `/api/audits/${auditId}/automation-suggestions`, undefined, owner)).json;
  const sugOf = async (src) => (await sugs()).find((x) => x.sourceId === src);

  const { page, close } = await open("tester", `/p/${A}/test-plan?audit=${auditId}`);
  const region = (title) => page.locator(".plan-entry", { hasText: title }).getByRole("region", { name: "Automation suggestions" });
  const openRow = async (title) => { await page.locator(".plan-entry", { hasText: title }).locator(".plan-row").click(); };
  const card = (title) => region(title).locator("[data-suggestion]");

  // An unapproved plan item gets none.
  await openRow("UI auto 5");
  check("automation: an unapproved plan item says to approve it first, and offers no button", await eventually(async () => (await region("UI auto 5").innerText()).includes("Approve this plan item") && (await region("UI auto 5").getByRole("button", { name: "Suggest automation" }).count()) === 0));

  // Ask: the rule makes a suggestion, marked as the rule's and not as AI.
  await openRow("UI auto 1");
  await region("UI auto 1").getByRole("button", { name: "Suggest automation" }).click();
  check("automation: a suggestion is made, marked Suggested by rule and not AI", await eventually(async () => { const t = await card("UI auto 1").innerText(); return t.includes("Suggested by rule") && !/\bAI\b/.test(t) && t.includes("Open the page 1"); }));
  check("automation: it is the rule's, proposed, and nobody has decided it", await eventually(async () => { const x = await sugOf("UIA-1"); return x && x.origin === "rule" && x.status === "proposed" && x.decidedBy === null && x.editedBy === null; }));
  // Edit and save as a draft.
  await card("UI auto 1").getByRole("button", { name: "Edit", exact: true }).click();
  await card("UI auto 1").getByLabel("Summary").fill("Automate the todo flow, my way");
  await card("UI auto 1").getByRole("button", { name: "Save draft" }).click();
  check("automation: edited and saved as a draft by Tess", await eventually(async () => { const x = await sugOf("UIA-1"); return x.summary === "Automate the todo flow, my way" && x.status === "draft" && x.editedBy === "Tess"; }));
  check("automation: the card says Draft", await eventually(async () => (await card("UI auto 1").innerText()).includes("Draft")));
  // Approve, then Apply.
  await card("UI auto 1").getByRole("button", { name: "Approve", exact: true }).click();
  check("automation: approved by Tess", await eventually(async () => { const x = await sugOf("UIA-1"); return x.status === "approved" && x.decidedBy === "Tess"; }));
  await card("UI auto 1").getByRole("button", { name: "Apply as draft test case" }).click();
  check("automation: Apply made a draft test case, and the suggestion stayed approved", await eventually(async () => {
    const x = await sugOf("UIA-1"); if (!x?.testCase) return false;
    const c = (await call("GET", `/api/cases/${x.testCase.id}`, undefined, owner)).json;
    return c.status === "draft" && x.status === "approved";
  }));
  check("automation: the card links the draft test case", await eventually(async () => (await card("UI auto 1").innerText()).includes("Draft test case")));
  check("automation: and Apply cannot be pressed twice", await eventually(async () => (await card("UI auto 1").getByRole("button", { name: "Apply as draft test case" }).count()) === 0));
  // The history.
  await card("UI auto 1").locator("details summary").click();
  check("automation: the history says who did what", await eventually(async () => { const t = await card("UI auto 1").innerText(); return t.includes("Suggested by rule") && t.includes("Edited") && t.includes("Approved") && t.includes("Applied as a draft test case") && t.includes("by Tess"); }));

  // Nothing to make: the message says why.
  await openRow("UI auto 2");
  await region("UI auto 2").getByRole("button", { name: "Suggest automation" }).click();
  check("automation: a plan item without steps gets nothing, and says why", await eventually(async () => (await region("UI auto 2").getByRole("status").innerText()).includes("Nothing was generated: the plan item has no steps")));
  check("automation: and nothing was stored", (await sugOf("UIA-2")) === undefined);

  // Ignore hides it, puts it back, and it is not made again.
  await openRow("UI auto 3");
  await region("UI auto 3").getByRole("button", { name: "Suggest automation" }).click();
  await eventually(async () => (await card("UI auto 3").count()) === 1);
  await card("UI auto 3").getByRole("button", { name: "Ignore" }).click();
  check("automation: Ignore hides the suggestion and says how many are ignored", await eventually(async () => (await card("UI auto 3").count()) === 0 && (await region("UI auto 3").getByRole("button", { name: /Show 1 ignored/ }).count()) === 1));
  check("automation: it is ignored, not rejected", (await sugOf("UIA-3")).status === "ignored");
  await region("UI auto 3").getByRole("button", { name: "Suggest automation" }).click();
  check("automation: asking again does not make an ignored one again", await eventually(async () => (await region("UI auto 3").getByRole("status").innerText()).includes("you ignored it") && (await sugs()).filter((x) => x.sourceId === "UIA-3").length === 1));
  await region("UI auto 3").getByRole("button", { name: /Show 1 ignored/ }).click();
  await card("UI auto 3").getByRole("button", { name: "Put back" }).click();
  check("automation: Put back returns it to Suggested", await eventually(async () => (await sugOf("UIA-3")).status === "proposed"));

  // Reject is a decision that stays.
  await openRow("UI auto 4");
  await region("UI auto 4").getByRole("button", { name: "Suggest automation" }).click();
  await eventually(async () => (await card("UI auto 4").count()) === 1);
  await card("UI auto 4").getByRole("button", { name: "Reject", exact: true }).click();
  check("automation: rejected by Tess", await eventually(async () => { const x = await sugOf("UIA-4"); return x.status === "rejected" && x.decidedBy === "Tess"; }));
  check("automation: a rejected suggestion cannot be applied", await eventually(async () => (await card("UI auto 4").getByRole("button", { name: "Apply as draft test case" }).count()) === 0));
  await close();

  // A viewer reads but cannot change.
  const v = await open("viewer", `/p/${A}/test-plan?audit=${auditId}`);
  await v.page.locator(".plan-entry", { hasText: "UI auto 1" }).locator(".plan-row").click();
  const vcard = v.page.locator(".plan-entry", { hasText: "UI auto 1" }).locator("[data-suggestion]");
  check("automation: a viewer sees the suggestion but its Edit, Reject and Ignore are off", await eventually(async () => (await vcard.getByRole("button", { name: "Edit", exact: true }).isDisabled()) && (await vcard.getByRole("button", { name: "Reject", exact: true }).isDisabled()) && (await vcard.getByRole("button", { name: "Ignore" }).isDisabled())));
  await v.page.locator(".plan-entry", { hasText: "UI auto 2" }).locator(".plan-row").click();
  check("automation: and a viewer's Suggest automation is off", await eventually(async () => await v.page.locator(".plan-entry", { hasText: "UI auto 2" }).getByRole("button", { name: "Suggest automation" }).isDisabled()));
  await v.close();
  check("automation: nothing was decided by a viewer or the rule", (await sugs()).filter((x) => x.decidedBy).every((x) => x.decidedBy === "Tess"));

  // A Playwright spec for an approved plan item: suggested, edited, approved, applied, and only then downloadable.
  const specOf = async () => (await sugs()).find((x) => x.sourceId === "UIA-6" && x.isSpec);
  const sp = await open("tester", `/p/${A}/test-plan?audit=${auditId}`);
  const sregion = sp.page.locator(".plan-entry", { hasText: "UI auto 6" }).getByRole("region", { name: "Automation suggestions" });
  const scard = sregion.locator("[data-suggestion]");
  await sp.page.locator(".plan-entry", { hasText: "UI auto 6" }).locator(".plan-row").click();
  await sregion.getByRole("button", { name: "Suggest Playwright spec" }).click();
  check("spec: a draft spec is made, marked as the rule's and as a spec, with test.fixme and a step per plan step", await eventually(async () => { const t = await scard.innerText(); return t.includes("Suggested by rule") && t.includes("Playwright spec") && !/\bAI\b/.test(t) && t.includes("test.fixme(") && t.includes("test.step(") && t.includes("Open the page 6"); }));
  check("spec: it is the rule's, proposed, named by reference and slug", await eventually(async () => { const x = await specOf(); return x && x.origin === "rule" && x.status === "proposed" && x.artifactName === "uia-6-ui-auto-6.spec.ts" && x.decidedBy === null; }));
  check("spec: there is nothing to download before Apply, in the page or on the server", await eventually(async () => (await scard.getByRole("link", { name: /Download/ }).count()) === 0 && (await fetch(`${BASE}/api/automation-suggestions/${(await specOf()).id}/spec`, { headers: { ...HDR, Cookie: `tb_sid=${cookies.tester}` } })).status === 409));
  await scard.getByRole("button", { name: "Edit", exact: true }).click();
  await scard.getByLabel(/Spec text/).fill("// edited by Tess\ntest.fixme(true, 'still a draft');\n");
  await scard.getByRole("button", { name: "Save draft" }).click();
  check("spec: the edited text is saved by Tess", await eventually(async () => { const x = await specOf(); return x.artifactText === "// edited by Tess\ntest.fixme(true, 'still a draft');\n" && x.status === "draft" && x.editedBy === "Tess"; }));
  await scard.getByRole("button", { name: "Approve", exact: true }).click();
  check("spec: approved by Tess", await eventually(async () => (await specOf()).status === "approved"));
  await scard.getByRole("button", { name: "Apply as draft spec" }).click();
  check("spec: Apply recorded who applied it, made no test case, and the suggestion stayed approved", await eventually(async () => { const x = await specOf(); return x.appliedBy === "Tess" && !!x.appliedAt && !x.testCase && x.status === "approved"; }));
  check("spec: now the card offers Download and Copy, and Apply is gone", await eventually(async () => (await scard.getByRole("link", { name: /Download/ }).count()) === 1 && (await scard.getByRole("button", { name: /Copy/ }).count()) === 1 && (await scard.getByRole("button", { name: "Apply as draft spec" }).count()) === 0));
  const got = await fetch(`${BASE}/api/automation-suggestions/${(await specOf()).id}/spec`, { headers: { ...HDR, Cookie: `tb_sid=${cookies.tester}` } });
  check("spec: the download is the edited text, an attachment with the file name, plain text", got.status === 200 && (await got.text()) === "// edited by Tess\ntest.fixme(true, 'still a draft');\n" && got.headers.get("content-disposition") === 'attachment; filename="uia-6-ui-auto-6.spec.ts"' && /^text\/plain/.test(got.headers.get("content-type") ?? "") && got.headers.get("x-content-type-options") === "nosniff");
  await sregion.getByRole("button", { name: "Suggest Playwright spec" }).click();
  check("spec: asking again makes no second spec", await eventually(async () => (await sregion.getByRole("status").innerText()).includes("already has a spec suggestion") && (await sugs()).filter((x) => x.sourceId === "UIA-6" && x.isSpec).length === 1));
  await scard.locator("details summary").click();
  check("spec: the history says who did what", await eventually(async () => { const t = await scard.innerText(); return t.includes("Suggested by rule") && t.includes("Spec text") && t.includes("Approved") && t.includes("Applied as a draft spec") && t.includes("by Tess"); }));
  await sp.close();

  const sv = await open("viewer", `/p/${A}/test-plan?audit=${auditId}`);
  const vsr = sv.page.locator(".plan-entry", { hasText: "UI auto 6" }).getByRole("region", { name: "Automation suggestions" });
  await sv.page.locator(".plan-entry", { hasText: "UI auto 6" }).locator(".plan-row").click();
  check("spec: a viewer sees it and can download it, but Suggest, Edit and Reject are off", await eventually(async () => (await vsr.getByRole("link", { name: /Download/ }).count()) === 1 && (await vsr.getByRole("button", { name: "Suggest Playwright spec" }).isDisabled()) && (await vsr.getByRole("button", { name: "Edit", exact: true }).isDisabled()) && (await vsr.getByRole("button", { name: "Reject", exact: true }).isDisabled())));
  await sv.close();
}

// Automation suggestions for an approved requirement: the same mechanism, on the requirement itself.
{
  const mk = async (title, over = {}) => (await call("POST", `/api/projects/${A}/requirements`, { title, description: `${title} is described here.`, acceptanceCriteria: "The text is shown\nThe input is cleared", priority: "high", status: "approved", ...over }, owner)).json;
  const r1 = await mk("UI req 1");
  const r2 = await mk("UI req 2", { status: "draft" });
  check("req automation: seeded", !!r1?.id && !!r2?.id, JSON.stringify([r1?.id, r2?.id]));
  const sugs = async () => (await call("GET", `/api/requirements/${r1.id}/automation-suggestions`, undefined, owner)).json;

  const { page, close } = await open("tester", `/p/${A}/requirements?req=${r1.id}`);
  const region = page.getByRole("region", { name: "Automation suggestions" });
  const card = region.locator("[data-suggestion]");
  await region.getByRole("button", { name: "Suggest automation" }).click();
  check("req automation: a suggestion is made, marked Suggested by rule and not AI, with the checks and a skeleton of steps", await eventually(async () => { const t = await card.innerText(); return t.includes("Suggested by rule") && !/\bAI\b/.test(t) && t.includes("Do what the requirement asks for: UI req 1") && t.includes("The input is cleared"); }));
  check("req automation: it is the rule's, for the requirement, proposed", await eventually(async () => { const x = (await sugs())[0]; return x && x.origin === "rule" && x.subjectKind === "requirement" && x.status === "proposed" && x.decidedBy === null; }));
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  check("req automation: approved by Tess", await eventually(async () => { const x = (await sugs())[0]; return x.status === "approved" && x.decidedBy === "Tess"; }));
  await card.getByRole("button", { name: "Apply as draft test case" }).click();
  check("req automation: Apply made a draft test case linked to the requirement, and the suggestion stayed approved", await eventually(async () => {
    const x = (await sugs())[0]; if (!x?.testCase) return false;
    const c = (await call("GET", `/api/cases/${x.testCase.id}`, undefined, owner)).json;
    const linked = (await call("GET", `/api/requirements/${r1.id}`, undefined, owner)).json.cases.some((k) => k.id === x.testCase.id);
    return c.status === "draft" && linked && x.status === "approved";
  }));
  check("req automation: the card links the draft test case, and asking again makes no second suggestion", await eventually(async () => (await card.innerText()).includes("Draft test case")));
  await region.getByRole("button", { name: "Suggest automation" }).click();
  check("req automation: it says the requirement already has one", await eventually(async () => (await region.getByRole("status").innerText()).includes("This requirement already has a suggestion") && (await sugs()).length === 1));
  await card.locator("details summary").click();
  check("req automation: the history says who did what", await eventually(async () => { const t = await card.innerText(); return t.includes("Suggested by rule") && t.includes("Approved") && t.includes("Applied as a draft test case") && t.includes("by Tess"); }));
  // The requirement's text changes after the suggestion.
  await call("PATCH", `/api/requirements/${r1.id}`, { acceptanceCriteria: "Something else entirely" }, owner);
  await page.reload();
  check("req automation: a changed requirement says so on the suggestion", await eventually(async () => (await page.getByRole("region", { name: "Automation suggestions" }).locator("[data-suggestion]").innerText()).includes("Requirement changed since")));
  await close();

  // A draft requirement gets none.
  const d = await open("tester", `/p/${A}/requirements?req=${r2.id}`);
  const dregion = d.page.getByRole("region", { name: "Automation suggestions" });
  check("req automation: a draft requirement says to approve it first, and offers no button", await eventually(async () => (await dregion.innerText()).includes("Approve this requirement") && (await dregion.getByRole("button", { name: "Suggest automation" }).count()) === 0));
  await d.close();

  // A viewer reads but cannot change.
  const v = await open("viewer", `/p/${A}/requirements?req=${r1.id}`);
  const vr = v.page.getByRole("region", { name: "Automation suggestions" });
  check("req automation: a viewer sees the suggestion, and Suggest automation, Edit and Reject are off", await eventually(async () => (await vr.getByRole("button", { name: "Suggest automation" }).isDisabled()) && (await vr.getByRole("button", { name: "Edit", exact: true }).isDisabled()) && (await vr.getByRole("button", { name: "Reject", exact: true }).isDisabled())));
  await v.close();
  check("req automation: nothing was decided by a viewer or the rule", (await sugs()).filter((x) => x.decidedBy).every((x) => x.decidedBy === "Tess"));

  // A Playwright spec for an approved requirement: suggested, edited, approved, applied, and only then downloadable.
  const r3 = await mk("UI req 3");
  const specs = async () => (await call("GET", `/api/requirements/${r3.id}/automation-suggestions`, undefined, owner)).json.filter((x) => x.isSpec);
  const fileName = `req-${(await call("GET", `/api/requirements/${r3.id}`, undefined, owner)).json.number}-ui-req-3.spec.ts`;
  const sp = await open("tester", `/p/${A}/requirements?req=${r3.id}`);
  const sregion = sp.page.getByRole("region", { name: "Automation suggestions" });
  const scard = sregion.locator("[data-suggestion]");
  await sregion.getByRole("button", { name: "Suggest Playwright spec" }).click();
  check("req spec: a draft spec is made, marked as the rule's and as a spec, with test.fixme and the criteria as TODOs", await eventually(async () => { const t = await scard.innerText(); return t.includes("Suggested by rule") && t.includes("Playwright spec") && !/\bAI\b/.test(t) && t.includes("test.fixme(") && t.includes("test.step(") && t.includes("The input is cleared"); }));
  check("req spec: it is the rule's, proposed, named req-<number>-<title>", await eventually(async () => { const x = (await specs())[0]; return x && x.origin === "rule" && x.subjectKind === "requirement" && x.status === "proposed" && x.artifactName === fileName && x.decidedBy === null; }));
  check("req spec: nothing can be downloaded before Apply, in the page or on the server", await eventually(async () => (await scard.getByRole("link", { name: /Download/ }).count()) === 0 && (await fetch(`${BASE}/api/automation-suggestions/${(await specs())[0].id}/spec`, { headers: { ...HDR, Cookie: `tb_sid=${cookies.tester}` } })).status === 409));
  await scard.getByRole("button", { name: "Edit", exact: true }).click();
  await scard.getByLabel(/Spec text/).fill("// edited by Tess\ntest.fixme(true, 'still a draft');\n");
  await scard.getByRole("button", { name: "Save draft" }).click();
  check("req spec: the edited text is saved by Tess", await eventually(async () => { const x = (await specs())[0]; return x.artifactText === "// edited by Tess\ntest.fixme(true, 'still a draft');\n" && x.status === "draft" && x.editedBy === "Tess"; }));
  await scard.getByRole("button", { name: "Approve", exact: true }).click();
  check("req spec: approved by Tess", await eventually(async () => (await specs())[0].status === "approved"));
  await scard.getByRole("button", { name: "Apply as draft spec" }).click();
  check("req spec: Apply recorded who applied it, made no test case, and the suggestion stayed approved", await eventually(async () => { const x = (await specs())[0]; return x.appliedBy === "Tess" && !!x.appliedAt && !x.testCase && x.status === "approved"; }));
  check("req spec: now the card offers Download and Copy, and Apply is gone", await eventually(async () => (await scard.getByRole("link", { name: /Download/ }).count()) === 1 && (await scard.getByRole("button", { name: /Copy/ }).count()) === 1 && (await scard.getByRole("button", { name: "Apply as draft spec" }).count()) === 0));
  const got = await fetch(`${BASE}/api/automation-suggestions/${(await specs())[0].id}/spec`, { headers: { ...HDR, Cookie: `tb_sid=${cookies.tester}` } });
  check("req spec: the download is the edited text, an attachment with the file name, plain text", got.status === 200 && (await got.text()) === "// edited by Tess\ntest.fixme(true, 'still a draft');\n" && got.headers.get("content-disposition") === `attachment; filename="${fileName}"` && /^text\/plain/.test(got.headers.get("content-type") ?? "") && got.headers.get("x-content-type-options") === "nosniff");
  await sregion.getByRole("button", { name: "Suggest Playwright spec" }).click();
  check("req spec: asking again makes no second spec", await eventually(async () => (await sregion.getByRole("status").innerText()).includes("already has a spec suggestion") && (await specs()).length === 1));
  await scard.locator("details summary").click();
  check("req spec: the history says who did what", await eventually(async () => { const t = await scard.innerText(); return t.includes("Suggested by rule") && t.includes("Spec text") && t.includes("Approved") && t.includes("Applied as a draft spec") && t.includes("by Tess"); }));
  await sp.close();

  const sv = await open("viewer", `/p/${A}/requirements?req=${r3.id}`);
  const vsr = sv.page.getByRole("region", { name: "Automation suggestions" });
  check("req spec: a viewer sees it and can download it, but Suggest, Edit and Reject are off", await eventually(async () => (await vsr.getByRole("link", { name: /Download/ }).count()) === 1 && (await vsr.getByRole("button", { name: "Suggest Playwright spec" }).isDisabled()) && (await vsr.getByRole("button", { name: "Edit", exact: true }).isDisabled()) && (await vsr.getByRole("button", { name: "Reject", exact: true }).isDisabled())));
  await sv.close();
}

// Bug drafts from a screenshot: a note and a picture, a draft by a fixed rule, edited, approved, applied (a bug report that stays proposed), and a viewer who can only read.
{
  const dir = mkdtempSync(join(tmpdir(), "tb-shot-"));
  const pic = join(dir, "screen.png");
  writeFileSync(pic, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  const drafts = async () => (await call("GET", `/api/projects/${A}/bug-drafts`, undefined, owner)).json;
  const { page, close } = await open("tester", `/p/${A}/bugs`);
  const region = page.getByRole("region", { name: "Bug drafts from screenshots" });
  const card = region.locator("[data-bug-draft]");
  check("bug draft: Make draft bug is off until there is a note and a picture", await eventually(async () => await region.getByRole("button", { name: "Make draft bug" }).isDisabled()));
  await region.getByLabel(/^Note/).fill("Cart total ignores removals\nI removed the second item and the total stayed the same.");
  await region.getByLabel(/^Screenshot/).setInputFiles(pic);
  await region.getByRole("button", { name: "Make draft bug" }).click();
  check("bug draft: a draft is made, marked Suggested by rule (not AI), with the TODO steps, expected and actual, and the picture", await eventually(async () => { const t = await card.innerText(); return t.includes("Suggested by rule") && !/\bAI\b/.test(t) && t.includes("Cart total ignores removals") && t.includes("TODO: what you expected") && t.includes("Evidence: screenshot attached. Not analysed.") && (await card.locator("img.bug-draft-shot").count()) === 1; }));
  check("bug draft: it is the rule's, proposed, nobody has decided it", await eventually(async () => { const x = (await drafts())[0]; return x && x.origin === "rule" && x.status === "proposed" && x.decidedBy === null && x.label === "SCR-1"; }));
  check("bug draft: the picture is served as an attachment, nosniff, to a signed-in member only", await eventually(async () => {
    const x = (await drafts())[0];
    const ok = await fetch(`${BASE}${x.screenshot.url}`, { headers: { ...HDR, Cookie: `tb_sid=${cookies.viewer}` } });
    const anon = await fetch(`${BASE}${x.screenshot.url}`, { headers: HDR });
    return ok.status === 200 && ok.headers.get("content-type") === "image/png" && /^attachment;/.test(ok.headers.get("content-disposition") ?? "") && ok.headers.get("x-content-type-options") === "nosniff" && anon.status !== 200;
  }));
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await card.getByLabel("Title", { exact: true }).fill("Cart total ignores removed items");
  await card.getByRole("button", { name: "Save draft" }).click();
  check("bug draft: the edit is saved by Tess as a draft", await eventually(async () => { const x = (await drafts())[0]; return x.title === "Cart total ignores removed items" && x.status === "draft" && x.editedBy === "Tess"; }));
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  check("bug draft: approved by Tess", await eventually(async () => { const x = (await drafts())[0]; return x.status === "approved" && x.decidedBy === "Tess"; }));
  await card.getByRole("button", { name: "Apply as draft bug" }).click();
  check("bug draft: Apply made a bug report that is still proposed, with the picture attached, and the draft stayed approved", await eventually(async () => {
    const x = (await drafts())[0]; if (!x?.bug) return false;
    const b = (await call("GET", `/api/bug-reports/${x.bug.id}`, undefined, owner)).json;
    return b.status === "proposed" && b.attachments.length === 1 && x.status === "approved" && x.appliedBy === "Tess";
  }));
  check("bug draft: the card links the bug report, and Apply cannot be pressed twice", await eventually(async () => (await card.getByRole("link", { name: /Bug report SCR-1/ }).count()) === 1 && (await card.getByRole("button", { name: "Apply as draft bug" }).count()) === 0));
  await page.goto(`${BASE}/p/${A}/bugs?bug=${(await drafts())[0].bug.id}`, { waitUntil: "networkidle" });
  check("bug draft: the bug report says From a screenshot and never AI suggestion", await eventually(async () => { const t = await page.locator(".modal-header").first().innerText(); return t.includes("From a screenshot") && !t.includes("AI suggestion"); }));
  await page.goto(`${BASE}/p/${A}/bugs`, { waitUntil: "networkidle" });
  await card.locator("details summary").click();
  check("bug draft: the history says who did what", await eventually(async () => { const t = await card.innerText(); return t.includes("Suggested by rule") && t.includes("Edited") && t.includes("Approved") && t.includes("Applied as a draft bug") && t.includes("by Tess"); }));
  await close();

  const v = await open("viewer", `/p/${A}/bugs`);
  const vr = v.page.getByRole("region", { name: "Bug drafts from screenshots" });
  check("bug draft: a viewer sees the draft, and Make draft bug, Edit and Reject are off", await eventually(async () => (await vr.locator("[data-bug-draft]").count()) === 1 && (await vr.getByRole("button", { name: "Make draft bug" }).isDisabled()) && (await vr.getByRole("button", { name: "Edit", exact: true }).isDisabled()) && (await vr.getByRole("button", { name: "Reject", exact: true }).isDisabled())));
  await v.close();
  check("bug draft: nothing was decided by a viewer or the rule", (await drafts()).filter((x) => x.decidedBy).every((x) => x.decidedBy === "Tess"));
}

// /admin: the owner looks after the accounts and reads the audit log; nobody else is offered it.
{
  const { page, close } = await open("owner", "/admin/accounts");
  check("admin: the page", (await page.getByRole("heading", { name: "Administration", level: 1 }).count()) === 1);
  const row = (name) => page.getByRole("row", { name: new RegExp(name) });
  check("admin: everyone is listed", await eventually(async () => (await page.locator("table").first().locator("tbody tr").count()) >= 7));
  check("admin: the owner has every project", (await row("Olle Owner").innerText()).includes("All projects (admin)"));
  check("admin: an admin's projects and role", await eventually(async () => /\(admin\)/.test(await row("Ada").innerText())));
  check("admin: a viewer's projects and role", await eventually(async () => /\(viewer\)/.test(await row("Vera").innerText())));
  check("admin: a person in no project", await eventually(async () => /none/.test(await row("Nina").innerText())));
  check("admin: the owner cannot switch off their own account", await page.getByRole("button", { name: "Switch off Olle Owner" }).isDisabled());

  // Switch an account off and on again.
  await page.getByRole("button", { name: "Switch off Nina" }).click();
  await page.getByRole("button", { name: "Switch off", exact: true }).click();
  await page.getByText("Account switched off").first().waitFor({ timeout: 10_000 });
  check("admin: the account shows as switched off", await eventually(async () => /Switched off/.test(await row("Nina").innerText())));
  check("admin: its session ended at once", !(await alive(cookies.nobody)));
  let canSignIn = true; try { await login("nina@example.com", PASSWORD); } catch { canSignIn = false; }
  check("admin: a switched-off account cannot sign in", !canSignIn);
  await page.getByRole("button", { name: "Switch on Nina" }).click();
  await page.getByRole("button", { name: "Switch on", exact: true }).click();
  await page.getByText("Account switched on").first().waitFor({ timeout: 10_000 });
  check("admin: the account shows as active again", await eventually(async () => /Active/.test(await row("Nina").innerText())));
  check("admin: and can sign in", (await login("nina@example.com", PASSWORD)) !== undefined);

  // A password reset link: shown once, works once.
  await page.getByRole("button", { name: "Make a password reset link for Tess" }).click();
  const resetUrl = await page.locator("code.inline.mono").first().innerText();
  check("admin: the reset link is shown", /\/reset\/[\w-]{20,}$/.test(resetUrl), resetUrl);
  const token = resetUrl.split("/").pop();
  check("admin: the link is for that person", (await call("GET", `/api/reset/${token}`)).json.email === "tess@example.com");
  await page.getByRole("button", { name: "I have handed it over" }).click();
  check("admin: the link is gone from the page once handed over", await eventually(async () => (await page.locator("code.inline.mono").count()) === 0));

  // An invitation with no project: made, listed, revoked.
  await page.getByLabel("Email address (optional)").fill("newbie@example.com");
  await page.getByRole("button", { name: "Make invitation link" }).click();
  const inviteUrl = await page.locator("code.inline.mono").first().innerText();
  check("admin: the invitation link is shown", /\/join\/[\w-]{20,}$/.test(inviteUrl), inviteUrl);
  const invRow = page.getByRole("row", { name: /newbie@example.com/ });
  check("admin: the open invitation is listed, with no project", await eventually(async () => /no project/.test(await invRow.innerText())));
  await invRow.getByRole("button", { name: /Revoke/ }).click();
  await page.getByText("Invitation revoked").first().waitFor({ timeout: 10_000 });
  check("admin: a revoked invitation leaves the list", await eventually(async () => (await page.getByRole("row", { name: /newbie@example.com/ }).count()) === 0));
  let usable = true; try { await call("GET", `/api/join/${inviteUrl.split("/").pop()}`); } catch { usable = false; }
  check("admin: and cannot be used", !usable);
  await close();
}
{
  const { page, close } = await open("owner", "/admin/audit-log");
  const rows = page.locator("table tbody tr");
  check("audit log: entries", await eventually(async () => (await rows.count()) >= 10));
  check("audit log: in words", await eventually(async () => /switched off Nina's account/.test(await page.locator("table").innerText())));
  check("audit log: the account switch is there with its event name", (await page.locator("table code.inline", { hasText: "account.disabled" }).count()) >= 1);
  const events = async () => (await page.locator("table tbody tr td:nth-child(3)").allInnerTexts()).map((t) => t.trim());
  for (const [label, prefix] of [["Passwords", "password."], ["Sign-ins", "login."], ["Members and roles", "member"]]) {
    await page.getByLabel("Kind of event").selectOption({ label });
    check(`audit log: the filter ${label}`, await eventually(async () => { const e = await events(); return e.length > 0 && e.every((x) => x.startsWith(prefix)); }));
  }
  await page.getByLabel("Kind of event").selectOption({ label: "Everything" });
  await eventually(async () => (await rows.count()) >= 10);
  const more = page.getByRole("button", { name: "Load older" });
  if (await eventually(async () => (await more.count()) === 1, 2000)) {
    const before = await rows.count();
    await more.click();
    check("audit log: older entries load", await eventually(async () => (await rows.count()) > before));
  }
  await close();
}
for (const who of ["admin", "tester", "viewer"]) { // nobody but the owner is offered it, and a direct visit explains why
  const { page, close } = await open(who, `/p/${A}/cases`);
  check(`${who}: no Administration link`, await eventually(async () => (await page.locator('a[href="/account"]').count()) >= 1) && (await page.locator('a[href^="/admin"]').count()) === 0);
  await page.goto(BASE + "/admin/accounts", { waitUntil: "networkidle" });
  check(`${who}: /admin explains that it is for the owner`, await eventually(async () => (await page.getByText("Only the owner can open this").count()) === 1));
  await close();
}
{
  const { page, close } = await open("owner", `/p/${A}/cases`);
  check("owner: an Administration link", await eventually(async () => (await page.locator('a[href="/admin/accounts"]').count()) >= 1));
  await close();
}
await browser.close();

if (failures.length) {
  console.error(`Roles UI: ${failures.length} problem${failures.length === 1 ? "" : "s"}:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("Roles UI OK: labels, notices, off buttons with their reason, settings tabs, members page, and people outside a project.");

// ---------- contrast and layout, as people with accounts see the app ----------
const here = (f) => fileURLToPath(new URL(f, import.meta.url));
let bad = 0;
// Contrast and layout are opt-in (see scripts/changed-areas.mjs): ROLES_SKIP_VISUAL=1 leaves this part out when nothing visual changed.
if (process.env.ROLES_SKIP_VISUAL === "1") {
  console.log("\nContrast and layout as a viewer and as the owner: skipped (ROLES_SKIP_VISUAL=1, nothing visual changed).");
  process.exit(0);
}
// The owner sees everything an admin sees and the /admin pages with their tables; a viewer sees the read-only app and the explanation on /admin.
for (const [who, script] of [["viewer", "check-contrast.mjs"], ["viewer", "check-layout.mjs"], ["owner", "check-contrast.mjs"], ["owner", "check-layout.mjs"]]) {
  console.log(`\n${script} as ${who}:`);
  const r = spawnSync(process.execPath, [here(script), BASE], { stdio: "inherit", env: { ...process.env, CHECK_COOKIE: `tb_sid=${cookies[who]}` } });
  if (r.status !== 0) bad++;
}
process.exit(bad ? 1 : 0);
