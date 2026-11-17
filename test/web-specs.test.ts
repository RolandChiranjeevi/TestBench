import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AuditError } from "../server/auditcommon.ts";
import { cleanSpecName, createSpec, SPEC_LIMITS } from "../server/specs.ts";
import { SPEC_NAME_MAX, SPEC_TEXT_MAX_BYTES, formatBytes, specNameProblem, specTextProblem, textBytes } from "../web/src/specname.ts";
import { makeProject } from "./helpers.ts";

// The screen tells a person what is wrong with a spec's name or text before they save. The server decides, and the screen must say the same thing: these tests hold the two together.

const NUL = String.fromCharCode(0), LS = String.fromCharCode(0x2028), BIDI = String.fromCharCode(0x202e);
const serverName = (name: string) => { try { cleanSpecName(name); return null; } catch (e) { assert.ok(e instanceof AuditError); return (e as AuditError).message; } };

describe("the file name rule on the screen and on the server", () => {
  const names = [
    "login.spec.ts", "Login-Flow_2.spec.ts", "a.spec.ts", "9.spec.ts", "tc-10-checkout-with-a-coupon.spec.ts", "  padded.spec.ts  ", "a".repeat(SPEC_NAME_MAX - 8) + ".spec.ts",
    "", "   ", "e2e/login.spec.ts", "..\\x.spec.ts", "../x.spec.ts", "/abs.spec.ts", "login.ts", "login.spec.js", "login.spec.ts.txt", "login", "login v2.spec.ts", "login.v2.spec.ts",
    ".spec.ts", "-a.spec.ts", "_a.spec.ts", `log${NUL}in.spec.ts`, "log\nin.spec.ts", "lögin.spec.ts", `a${BIDI}.spec.ts`, `a${LS}.spec.ts`, "a".repeat(SPEC_NAME_MAX - 7) + ".spec.ts", "LOGIN.SPEC.TS",
  ];
  it("agree on every name, and use the same words", () => {
    for (const name of names) assert.equal(specNameProblem(name), serverName(name), JSON.stringify(name));
  });
  it("the limits are the same number", () => {
    assert.equal(SPEC_NAME_MAX, SPEC_LIMITS.nameMax);
    assert.equal(SPEC_TEXT_MAX_BYTES, SPEC_LIMITS.textBytes);
  });
});

describe("the text rule on the screen and on the server", () => {
  const serverText = (text: string) => {
    const p = makeProject(`WS${Math.random().toString(36).slice(2, 7).toUpperCase()}`, "Web specs");
    try { createSpec(p.id, { fileName: "t.spec.ts", text }); return null; } catch (e) { assert.ok(e instanceof AuditError); return (e as AuditError).message; }
  };
  it("agree on empty, NUL, the limit in UTF-8 bytes, and what is fine", () => {
    const texts = ["", "  \n\t", NUL, "// fine\n", "a".repeat(SPEC_TEXT_MAX_BYTES), "a".repeat(SPEC_TEXT_MAX_BYTES + 1), "é".repeat(SPEC_TEXT_MAX_BYTES / 2), "é".repeat(SPEC_TEXT_MAX_BYTES / 2 + 1)];
    for (const text of texts) assert.equal(specTextProblem(text), serverText(text), `${text.length} characters`);
  });
  it("counts bytes, not characters", () => {
    assert.equal(textBytes("aé"), 3);
    assert.equal(textBytes("😀"), 4);
  });
});

describe("a size for the list", () => {
  it("is bytes under 1 kB, then kB with one decimal", () => {
    assert.deepEqual([0, 1023, 1024, 1536, 204800].map(formatBytes), ["0 B", "1023 B", "1.0 kB", "1.5 kB", "200.0 kB"]);
  });
});
