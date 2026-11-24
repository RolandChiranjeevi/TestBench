import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// scripts/secret-scan.mjs is run in CI and by hand, so it is tested as it is run: as a program. The values below are put together while the test runs, in pieces, so that this file never holds
// a whole token in a row (the scanner reads this file too, and would be right to complain).

const root = join(import.meta.dirname, "..");
const script = join(root, "scripts", "secret-scan.mjs");
const dir = mkdtempSync(join(tmpdir(), "secret-scan-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const j = (...p: string[]) => p.join("");
const REAL: Record<string, string> = {
  "request-token": j("tb", "rq_", "A1b2C3d4E5f6G7h8I9j0K1l2M3"),
  "agent-token": j("tb", "ag_", "Zq8rT1vXw3Lm9KpB4nYd6HsGc2Jf5"),
  "github-token": j("gh", "p_", "Kq8rT1vXw3Lm9KpB4nYd6HsGc2Jf5RtYu7Io"),
  "aws-access-key-id": j("AK", "IA", "Q7XK2M9PLR4TNW8B"),
  "anthropic-key": j("sk-", "ant-", "api03-Kq8rT1vXw3Lm9KpB4nYd6HsGc2Jf"),
  "slack-token": j("xo", "xb-", "8374619205-1928374650-QwErTyUiOpAsDf"),
  "google-api-key": j("AI", "za", "Sy9Kq8rT1vXw3Lm9KpB4nYd6HsGc2Jf5RtY"),
};
const KEY = j("-----BEGIN ", "RSA PRIVATE KEY-----\n", "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun\n", "-----END ", "RSA PRIVATE KEY-----\n");

let n = 0;
const scanText = (text: string) => {
  const file = join(dir, `f${n++}.txt`);
  writeFileSync(file, text);
  const r = spawnSync(process.execPath, [script, "--files", file], { encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr, lines: r.stdout.split("\n").filter(Boolean).map((l) => l.replace(file, "FILE")) };
};

describe("what the secret scan finds", () => {
  for (const [rule, value] of Object.entries(REAL)) {
    it(`a real-looking ${rule} is found, on the right line, and never printed whole`, () => {
      const r = scanText(`one\ntwo\nkey = ${value}\nfour\n`);
      assert.equal(r.status, 1);
      assert.equal(r.lines.length, 1);
      assert.match(r.lines[0], new RegExp(`^FILE:3  ${rule}  `));
      assert.equal(r.out.includes(value), false, "the whole secret must not be in the output");
      assert.equal(r.err.includes(value), false);
    });
  }

  it("the body of a private key is found, and the header alone (as it is written in docs) is not", () => {
    const withBody = scanText(`some text\n${KEY}`);
    assert.equal(withBody.status, 1);
    assert.match(withBody.lines[0], /^FILE:2  private-key  -----BEGIN … PRIVATE KEY-----$/);
    assert.equal(scanText("Paste the -----BEGIN RSA PRIVATE KEY----- block here.\n").status, 0);
  });

  it("several findings in one file are all reported, in line order", () => {
    const r = scanText(`${REAL["github-token"]}\n\n${REAL["request-token"]}\n`);
    assert.deepEqual(r.lines.map((l) => l.split("  ").slice(0, 2).join(" ")), ["FILE:1 github-token", "FILE:3 request-token"]);
  });
});

describe("what the secret scan lets through", () => {
  const MADE_UP = [
    j("tb", "rq_", "a".repeat(24)),
    j("tb", "rq_", "secretsecretsecret"),
    j("tb", "ag_", "x".repeat(30)),
    j("tb", "rq_", "test_token_value_for_the_docs"),
    j("gh", "p_", "abcdefghijklmnopqrstuvwxyz0123456789"),
    j("AK", "IA", "IOSFODNN7EXAMPLE"),
    j("sk-", "ant-", "api03-redactedredactedredacted"),
    j("tb", "rq_", "1234567890abcdefghij"),
  ];
  for (const value of MADE_UP) {
    it(`a made-up value passes: ${value.slice(0, 12)}…`, () => {
      const r = scanText(`token: ${value}\n`);
      assert.equal(r.status, 0, r.out);
      assert.equal(r.lines.length, 0);
    });
  }

  it("a line that says secret-scan: ignore is skipped, and only that line", () => {
    const r = scanText(`${REAL["request-token"]} # secret-scan: ignore, a made-up value shown in a guide\n${REAL["github-token"]}\n`);
    assert.equal(r.status, 1);
    assert.deepEqual(r.lines.map((l) => l.split("  ")[0]), ["FILE:2"]);
  });

  it("an ordinary text, an id and a hash are not secrets", () => {
    const r = scanText("commit 9a05831d4e0f, sha512-Yb3qD8fN2o+TpLr0Zk1uVw9xJ4cE7sH6aM5gB, uuid 7d9f5c1e-3b2a-4c8d-9e6f-0a1b2c3d4e5f, tbrq_ is the prefix\n");
    assert.equal(r.status, 0, r.out);
  });
});

describe("how the program is run", () => {
  it("exits 2 and says how to use it for an unknown flag or for --files without a file", () => {
    for (const args of [["--nope"], ["--files"], ["--history", "x"]]) {
      const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
      assert.equal(r.status, 2, args.join(" "));
      assert.match(r.stderr, /Usage: node scripts\/secret-scan\.mjs/);
    }
  });

  it("a file that is not there is skipped and a binary file is not read", () => {
    const bin = join(dir, "binary.bin");
    writeFileSync(bin, Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from(REAL["github-token"])]));
    const r = spawnSync(process.execPath, [script, "--files", join(dir, "missing.txt"), bin], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout);
  });

  it("the tracked files of this repository hold no secret (the same run as CI)", () => {
    const r = spawnSync(process.execPath, [script], { encoding: "utf8", cwd: root });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  });
});
