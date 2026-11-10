#!/usr/bin/env node
// Checks the screens of roles with a real browser, on an instance WITH accounts (accounts are turned on here, so use a throwaway instance: an empty one, on this computer).
// It makes an owner, two projects and people with the roles admin, tester and viewer (and one with no project, and one in the other project) through the API, signs each in
// in the browser, and checks what they see and what is off for them:
//  - the role label beside the project name,
//  - the notice for a viewer, and the buttons that are off (with their reason) for a viewer but not for a tester,
//  - which settings tabs each role gets, and what the members page shows (email addresses and the forms only for an admin),
//  - that someone who is not in a project is sent away from it, and that someone in no project is told so.
// Then it runs the contrast and layout checks as a viewer and as an admin, which the other checks (on an instance without accounts) never see.
//
// Usage:  node scripts/check-roles-ui.mjs http://127.0.0.1:4100      (an EMPTY instance with no accounts, started on this computer)
import { spawnSync } from "node:child_process";
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
  check("admin: the role was changed", (await select.inputValue()) === "tester");
  await select.selectOption("viewer");
  await page.getByText("Role changed").first().waitFor({ timeout: 10_000 });
  await close();
}

// Someone who is not in the project, and someone who is in none.
{
  const { page, close } = await open("outsider", `/p/${A}/cases`);
  check("outsider: sent away from a project that is not theirs", !new URL(page.url()).pathname.startsWith(`/p/${A}/`), page.url());
  const tags = await texts(page, ".project-switch .role-tag");
  check("outsider: their own project, with their role", tags[0] === "Tester", JSON.stringify(tags));
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
  check("owner: can make a project", (await o.page.getByRole("button", { name: /New project/ }).count()) === 1);
  await o.close();
  const v = await open("viewer", `/p/${A}/cases`);
  await v.page.locator(".project-switch").click();
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
  check("account: the password field appears when the email changes", (await pw.count()) === 1);
  check("account: Save waits for it", await profile.getByRole("button", { name: "Save" }).isDisabled());
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
  check("account: only this session is left", (await sessions.locator("tbody tr").count()) === 1);

  // Password: a mismatch is caught before sending, a wrong current one is refused, the right ones work and end the other sessions.
  const other = await login("carl.new@example.com", PASSWORD);
  const password = card("Password");
  const fill = async (cur, next, again) => { await password.getByLabel("Current password").fill(cur); await password.getByLabel("New password", { exact: true }).fill(next); await password.getByLabel("New password, again").fill(again); };
  const NEW = "a brand new ui passphrase";
  await fill(PASSWORD, NEW, NEW + "x");
  await password.getByRole("button", { name: "Change password" }).click();
  check("account: two different new passwords are caught", (await password.getByRole("alert").innerText()) === "The two new passwords are not the same");
  await fill(PASSWORD, "short", "short");
  await password.getByRole("button", { name: "Change password" }).click();
  check("account: a short password is caught", /at least 10 characters/.test(await password.getByRole("alert").innerText()));
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
  check("account: a link in the sidebar", (await a.page.locator('a[href="/account"]').count()) >= 1);
  await a.close();
  const n = await open("nobody", "/");
  await n.page.getByRole("link", { name: /Your account/ }).click();
  await n.page.waitForURL("**/account");
  check("account: reachable with no project", (await n.page.getByRole("heading", { name: "Your account", level: 1 }).count()) === 1);
  await n.close();
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
for (const [who, script] of [["viewer", "check-contrast.mjs"], ["viewer", "check-layout.mjs"], ["admin", "check-contrast.mjs"]]) {
  console.log(`\n${script} as ${who}:`);
  const r = spawnSync(process.execPath, [here(script), BASE], { stdio: "inherit", env: { ...process.env, CHECK_COOKIE: `tb_sid=${cookies[who]}` } });
  if (r.status !== 0) bad++;
}
process.exit(bad ? 1 : 0);
