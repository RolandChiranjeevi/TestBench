import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PASSWORD_MAX, PASSWORD_MIN, PASSWORD_RULES, deviceLabel, passwordFormProblem, passwordProblem } from "../web/src/accounts.ts";
import { PASSWORD_MAX as SERVER_MAX, PASSWORD_MIN as SERVER_MIN, passwordProblem as serverProblem } from "../server/accounts.ts";

// The helpers of the account screens. Pure logic: no browser, no network.

describe("deviceLabel", () => {
  const cases: [string, string][] = [
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", "Chrome on macOS"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0", "Edge on Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/110.0.0.0", "Opera on Windows"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0", "Firefox on Linux"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", "Safari on macOS"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", "Safari on iPhone"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1", "Chrome on iPhone"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
    ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", "Chrome on ChromeOS"],
    ["curl/8.7.1", "curl"],
    ["node", "Node.js"],
  ];
  for (const [ua, expected] of cases) it(expected, () => assert.equal(deviceLabel(ua), expected));

  it("says so plainly when it does not know, and never throws", () => {
    for (const ua of ["", "   ", null, undefined, "Totally Unknown/1.0", "\u0000\u0001"]) assert.equal(deviceLabel(ua), "Unknown device");
    assert.equal(deviceLabel("Mozilla/5.0 (Macintosh)"), "macOS", "a system without a browser name");
    assert.equal(deviceLabel("Safari/1"), "Safari", "a browser without a system");
    assert.doesNotThrow(() => deviceLabel("x".repeat(100_000)));
  });
});

describe("the password rules are the server's", () => {
  it("the numbers are the same", () => {
    assert.deepEqual([PASSWORD_MIN, PASSWORD_MAX], [SERVER_MIN, SERVER_MAX]);
    assert.ok(PASSWORD_RULES[0].includes(String(SERVER_MIN)));
  });

  it("for a long list of passwords, the hint says what the server says", () => {
    const who = { email: "pia@example.com", name: "Pia Person" };
    const samples = [
      "", "short", "123456789", "1234567890", "aaaaaaaaaaaa", "ababababab", "abcabcabcabc", "          ", "   a      b   ", "a long passphrase here", "Pia Person", "pia person", "PIA@EXAMPLE.COM", "pia@example.com ",
      "x".repeat(PASSWORD_MAX), "x".repeat(PASSWORD_MAX + 1), "åäö åäö åäö åäö", "pässwörd with ünicode", "\t\t\t\t\t\t\t\t\t\t\ta",
    ];
    for (const p of samples) assert.equal(passwordProblem(p, who), serverProblem(p, who), JSON.stringify(p.slice(0, 30)));
    assert.equal(passwordProblem("a long passphrase here", who), null);
  });
});

describe("what the password form checks before it sends", () => {
  const who = { email: "pia@example.com", name: "Pia Person" };
  const ok = { current: "the old passphrase", next: "a brand new passphrase", again: "a brand new passphrase" };
  it("lets a good change go", () => assert.equal(passwordFormProblem(ok, who), null));
  it("asks for the current password first", () => assert.equal(passwordFormProblem({ ...ok, current: "" }, who), "Type your current password"));
  it("notices two different new passwords", () => assert.equal(passwordFormProblem({ ...ok, again: "a brand new passphrasX" }, who), "The two new passwords are not the same"));
  it("notices an unchanged password", () => assert.equal(passwordFormProblem({ current: "same passphrase", next: "same passphrase", again: "same passphrase" }, who), "The new password is the same as the current one"));
  it("passes on the rule that is broken", () => {
    assert.equal(passwordFormProblem({ ...ok, next: "short", again: "short" }, who), `The password must be at least ${PASSWORD_MIN} characters`);
    assert.equal(passwordFormProblem({ ...ok, next: "pia@example.com", again: "pia@example.com" }, who), "The password cannot be your email or your name");
  });
});
