#!/usr/bin/env node
// Which browser checks a change needs. Contrast and layout take a long time and only mean something when something visual changed, so they are opt-in: they run when the change
// touches what the pages look like, and are skipped otherwise. The roles script (which drives the real screens as each role) runs when the screens or the server behind them change.
// One rule, used by CI and by hand, so the two cannot drift apart.
//
// Usage:  node scripts/changed-areas.mjs origin/main      what changed since this branch left origin/main (committed, uncommitted and new files)
//         node scripts/changed-areas.mjs --files a b c    the same rule for these paths (used by the test)
// It prints two lines on stdout, `visual=true|false` and `flows=true|false` (ready for $GITHUB_OUTPUT), and says why on stderr.
// When it cannot tell what changed (no such base, no common history, a shallow clone) it says true for both: when in doubt, run the checks.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** What the pages look like: the web app, the check scripts themselves, the build, the dependencies, and this workflow and rule. Contrast and layout run for these. */
const VISUAL = [
  /^web\//, /^scripts\/check-(contrast|layout)\.mjs$/, /^scripts\/lib\//, /^vite\.config\.ts$/, /^package(-lock)?\.json$/, /^\.github\/workflows\/ci\.yml$/, /^scripts\/changed-areas\.mjs$/,
];
/** What the screens do: anything visual, the server behind the screens, and the roles script itself. The roles script runs for these. */
const FLOWS = [...VISUAL, /^server\//, /^scripts\/check-roles-ui\.mjs$/];

/** Which checks the changed paths need, and the first path that made each so. Docs, tests and other files need neither. */
export function classify(files) {
  const why = (patterns) => files.find((f) => patterns.some((p) => p.test(f)));
  const v = why(VISUAL);
  const fl = why(FLOWS);
  return { visual: v !== undefined, flows: fl !== undefined, because: { visual: v, flows: fl } };
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);

/** The paths changed since the branch left `base`: committed, uncommitted and untracked. Null when that cannot be told. */
function changedSince(base) {
  try {
    const [mergeBase] = git("merge-base", base, "HEAD");
    if (!mergeBase) return null;
    return [...new Set([...git("diff", "--name-only", mergeBase), ...git("ls-files", "--others", "--exclude-standard")])];
  } catch {
    return null;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const files = args[0] === "--files" ? args.slice(1) : args[0] ? changedSince(args[0]) : null;
  if (!files) {
    console.error(args[0] ? `Cannot tell what changed since ${args[0]}: running every check.` : "Usage: node scripts/changed-areas.mjs <base> | --files <path>...");
    if (!args[0]) process.exit(2);
    console.log("visual=true\nflows=true");
  } else {
    const r = classify(files);
    console.error(`${files.length} changed file${files.length === 1 ? "" : "s"}. Contrast and layout: ${r.visual ? `run (${r.because.visual})` : "skipped, nothing visual changed"}. Roles script: ${r.flows ? `run (${r.because.flows})` : "skipped, no screen or server change"}.`);
    console.log(`visual=${r.visual}\nflows=${r.flows}`);
  }
}
