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
const cookies = { owner, admin: await person("Ada", A, "admin"), tester: await person("Tess", A, "tester"), viewer: await person("Vera", A, "viewer"), outsider: await person("Bob", B, "tester"), nobody: await person("Nina", null) };

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
