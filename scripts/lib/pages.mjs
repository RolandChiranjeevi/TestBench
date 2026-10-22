// Shared by the page checks (check-contrast.mjs, check-layout.mjs): which pages to open, how to start the browser.
import { chromium } from "playwright-core";

const HDR = { "X-Testbench": "1", "Content-Type": "application/json" };

/** The address of the instance to check. Required on purpose: point these checks at a throwaway instance, never at your own data. */
export function baseUrlFromArgs(script) {
  if (!process.argv[2]) {
    console.error(`Usage: node scripts/${script} <baseUrl>   (a throwaway instance, e.g. http://127.0.0.1:4100)`);
    process.exit(2);
  }
  return process.argv[2].replace(/\/$/, "");
}

/**
 * The pages to check, using the demo data. `ONLY` (comma-separated paths, from CHECK_ONLY or CONTRAST_ONLY) skips discovery and
 * checks just those paths, without calling the API (used for the sign-in page of a password-protected instance).
 * An empty instance is only filled with the demo project when CHECK_SEED=1 (or CONTRAST_SEED=1) says so.
 */
export async function discoverPages(base) {
  const only = (process.env.CHECK_ONLY ?? process.env.CONTRAST_ONLY ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (only.length) return only.map((p) => [p, p]);

  const api = async (path, init) => {
    const res = await fetch(base + path, init);
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return res.json();
  };
  let projects = await api("/api/projects");
  if (!projects.length) {
    if (process.env.CHECK_SEED !== "1" && process.env.CONTRAST_SEED !== "1") {
      console.error(`${base} has no projects. Use a throwaway instance with CHECK_SEED=1 to create the demo project there.`);
      process.exit(2);
    }
    await api("/api/demo", { method: "POST", headers: HDR, body: "{}" });
    projects = await api("/api/projects");
  }
  const pid = projects[0].id;
  const [runs, milestones, requirements, cases] = await Promise.all([
    api(`/api/projects/${pid}/runs`),
    api(`/api/projects/${pid}/milestones`),
    api(`/api/projects/${pid}/requirements`),
    api(`/api/projects/${pid}/cases`),
  ]);
  const manualRun = runs.find((r) => r.kind === "manual");
  const autoRun = runs.find((r) => r.kind === "automated");

  return [
    ["Dashboard", `/p/${pid}/dashboard`],
    ["Requirements", `/p/${pid}/requirements`],
    ["Requirement open", `/p/${pid}/requirements${requirements[0] ? `?req=${requirements[0].id}` : ""}`],
    ["Test cases", `/p/${pid}/cases`],
    ["Test case open", `/p/${pid}/cases${cases[0] ? `?case=${cases[0].id}` : ""}`],
    ["Runs", `/p/${pid}/runs`],
    ...(manualRun ? [["Manual run", `/p/${pid}/runs/${manualRun.id}`]] : []),
    ...(autoRun ? [["Automated run", `/p/${pid}/runs/${autoRun.id}`]] : []),
    ["Automated tests", `/p/${pid}/automated`],
    ["Import results", `/p/${pid}/import`],
    ["Sprint reports", `/p/${pid}/reports${milestones[0] ? `/${milestones[0].id}` : ""}`],
    ["Backup & restore", `/p/${pid}/backup`],
  ];
}

/** Chrome, the same way PDF export finds it: TESTBENCH_CHROME_PATH, or TESTBENCH_CHROME_CHANNEL (default "chrome"). */
export function launchBrowser() {
  const options = process.env.TESTBENCH_CHROME_PATH
    ? { executablePath: process.env.TESTBENCH_CHROME_PATH, args: process.env.TESTBENCH_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] }
    : { channel: process.env.TESTBENCH_CHROME_CHANNEL ?? "chrome" };
  return chromium.launch(options);
}
