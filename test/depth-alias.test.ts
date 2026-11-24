import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanOptions, REQUEST_OPTIONS } from "../server/agentrequests.ts";

// "deep" was called "thorough" before. Requests saved with the old name must keep their depth: if they failed or fell back to normal, a run would silently be shallower than asked for.
describe("depth: the old name thorough", () => {
  it("the depths are quick, normal and deep", () => {
    assert.deepEqual([...REQUEST_OPTIONS.depths], ["quick", "normal", "deep"]);
  });
  it("a saved request with thorough reads as deep", () => {
    assert.equal(cleanOptions({ depth: "thorough" }).depth, "deep");
    assert.equal(cleanOptions({ depth: "deep" }).depth, "deep");
  });
  it("another word is still refused", () => {
    assert.throws(() => cleanOptions({ depth: "deeper" }), /depth must be one of quick, normal, deep/);
  });
});
