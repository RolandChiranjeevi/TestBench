#!/usr/bin/env node
// Looks for a secret that must never be committed: our own tokens (`tbrq_` request tokens and `tbag_` agent tokens), a few well known formats (GitHub, AWS, Anthropic and OpenAI style keys, Slack, Google
// API keys) and the body of a private key. A secret that reaches a public repository is public for good, so this runs in CI and can be run by hand. No dependencies, nothing is sent anywhere.
//
// Usage:  node scripts/secret-scan.mjs                 every file that git tracks in this working tree
//         node scripts/secret-scan.mjs --history       every line that was ever added in the history (slower; once in a while, not in CI)
//         node scripts/secret-scan.mjs --files a b c   these files (used by the tests)
// It prints one line for each finding, `file:line  rule  first-characters…`, and **never the whole secret**. Exit status 0: nothing found. 1: something found. 2: could not run.
//
// A value that is obviously made up is not a finding, so the tests and the docs can show what a token looks like: a body with fewer than 6 different characters (`tbrq_aaaa…`), a word such
// as secret, example, fake, dummy, test, sample, placeholder or redacted in it, or a run of 6 characters in a row in the alphabet or in the digits (`abcdef`, `123456`). A real token is random, and
// the chance that one of those is in it is negligible. A line that holds `secret-scan: ignore` is skipped, for the rare value that is real-looking and still fine (say why next to it).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const RULES = [
  { id: "request-token", re: /tbrq_[A-Za-z0-9_-]{20,200}/g, prefix: "tbrq_" },
  { id: "agent-token", re: /tbag_[A-Za-z0-9_-]{20,200}/g, prefix: "tbag_" },
  { id: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{30,255})\b/g },
  { id: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/g, prefix: "AKIA" },
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, prefix: "sk-ant-" },
  { id: "openai-style-key", re: /\bsk-[A-Za-z0-9]{32,}\b/g, prefix: "sk-" },
  { id: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{20,}/g },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, prefix: "AIza" },
  { id: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[ \t]*\r?\n?[A-Za-z0-9+/=\r\n \t]{40,}/g },
];

const PLACEHOLDER_WORDS = /secret|example|fake|dummy|test|sample|placeholder|redacted|your[-_]?token|xxxx|0000/i;

/** True when `body` has a run of `n` characters in a row that go up by one in the alphabet or in the digits (abcdef, 123456, ABCDEF). */
function hasRun(body, n = 6) {
  let run = 1;
  for (let i = 1; i < body.length; i++) {
    run = body.charCodeAt(i) === body.charCodeAt(i - 1) + 1 && /[A-Za-z0-9]/.test(body[i]) ? run + 1 : 1;
    if (run >= n) return true;
  }
  return false;
}

/** Is this match a value that is obviously made up? The body is what follows the prefix of the rule. */
export function isPlaceholder(match, rule) {
  const body = rule.prefix && match.startsWith(rule.prefix) ? match.slice(rule.prefix.length) : match.replace(/^[^A-Za-z0-9]*/, "");
  const content = rule.id === "private-key" ? match.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "").replace(/\s+/g, "") : body;
  return new Set(content).size < 6 || PLACEHOLDER_WORDS.test(content) || hasRun(content);
}

/** The first characters of a match and an ellipsis: enough to find it, never enough to use it. */
const preview = (match, rule) => (rule.id === "private-key" ? "-----BEGIN … PRIVATE KEY-----" : `${match.slice(0, 8)}…`);

/** The findings in `text` (the content of the file called `file`): [{ file, line, rule, preview }]. */
export function scan(text, file, firstLine = 1) {
  const found = [];
  const ignored = new Set();
  text.split("\n").forEach((l, i) => { if (l.includes("secret-scan: ignore")) ignored.add(i); });
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const line = text.slice(0, m.index).split("\n").length - 1;
      if (ignored.has(line) || isPlaceholder(m[0], rule)) continue;
      found.push({ file, line: line + firstLine, rule: rule.id, preview: preview(m[0], rule) });
    }
  }
  return found.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

const git = (...args) => {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || "").trim().split("\n")[0]}`);
  return r.stdout;
};

/** The files that git tracks, as paths. */
function trackedFiles() {
  return git("ls-files", "-z").split("\0").filter(Boolean);
}

function scanFile(path) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    return [];
  }
  if (buf.length > 2_000_000 || buf.subarray(0, 8000).includes(0)) return []; // a big or binary file (an image, a font) holds no pasted token
  return scan(buf.toString("utf8"), path);
}

/** Every line that was ever added, with the commit and the file it was added in. Slow on a long history, so it is for now and then. */
function scanHistory() {
  const out = git("log", "--all", "--no-color", "-p", "--pretty=format:@@@%h");
  const found = [];
  let commit = "", file = "";
  for (const l of out.split("\n")) {
    if (l.startsWith("@@@")) commit = l.slice(3);
    else if (l.startsWith("+++ ")) file = l.slice(4).replace(/^b\//, "");
    else if (l.startsWith("+")) for (const f of scan(l.slice(1), `${commit}:${file}`)) found.push({ ...f, line: 0 });
  }
  return found;
}

function main(argv) {
  let findings;
  try {
    if (argv.length === 0) findings = trackedFiles().flatMap(scanFile);
    else if (argv[0] === "--history" && argv.length === 1) findings = scanHistory();
    else if (argv[0] === "--files" && argv.length > 1) findings = argv.slice(1).flatMap(scanFile);
    else {
      console.error("Usage: node scripts/secret-scan.mjs [--history | --files <file>...]");
      return 2;
    }
  } catch (e) {
    console.error(`secret-scan: ${e.message}`);
    return 2;
  }
  for (const f of findings) console.log(`${f.file}${f.line ? `:${f.line}` : ""}  ${f.rule}  ${f.preview}`);
  console.error(findings.length ? `secret-scan: ${findings.length} possible secret(s) found. Remove it and rotate it if it was real; a made-up value should look made up (see the top of this script).` : "secret-scan: nothing found");
  return findings.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
