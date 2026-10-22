import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REPO_SLUG } from "../server/importers/github.ts";

describe("REPO_SLUG (owner/repo accepted for GitHub imports)", () => {
  it("accepts ordinary repository names", () => {
    for (const ok of ["owner/repo", "my-org/my.repo_1", "a/b", "Some_Org/.github", "user/repo.js", "x/...dots"]) {
      assert.match(ok, REPO_SLUG, ok);
    }
  });

  it("rejects '.' and '..' segments, which URL resolution would turn into other API paths", () => {
    for (const bad of ["../x", "x/..", "./x", "x/.", "../..", "a/../b"]) {
      assert.doesNotMatch(bad, REPO_SLUG, bad);
    }
  });

  it("rejects anything that is not exactly two plain segments", () => {
    for (const bad of ["", "owner", "a/b/c", "/repo", "owner/", "a/b ", " a/b", "https://github.com/a/b", "a/b?x=1", "a/b#frag", "a\\b", "a/b%2f"]) {
      assert.doesNotMatch(bad, REPO_SLUG, JSON.stringify(bad));
    }
  });
});
