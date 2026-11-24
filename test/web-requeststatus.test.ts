import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REQUEST_STATUSES } from "../server/agentrequests.ts";
import { LOAD_VERDICTS } from "../server/loadtest.ts";
import { LOAD_DONE, STATUS, statusOf } from "../web/src/requestStatus.ts";

// What the status chip of a request says (web/src/requestStatus.ts). A load test that failed is not "Done" in the way a discover is.

describe("the chip of a request", () => {
  it("has a word and a tone for every status the server has, and no other", () => {
    assert.deepEqual(Object.keys(STATUS).sort(), [...REQUEST_STATUSES].sort());
    for (const s of REQUEST_STATUSES) assert.ok(STATUS[s].label && STATUS[s].title, s);
  });

  it("has a word and a tone for every verdict the server accepts, and no other", () => {
    assert.deepEqual(Object.keys(LOAD_DONE).sort(), [...LOAD_VERDICTS].sort());
  });

  it("says how a finished load test ended: Done · pass, Done · warning, Done · fail, each in its own tone", () => {
    const look = (loadVerdict: "pass" | "warning" | "fail") => statusOf({ status: "done", kind: "loadtest", loadVerdict });
    assert.deepEqual([look("pass").label, look("pass").tone], ["Done · pass", "ok"]);
    assert.deepEqual([look("warning").label, look("warning").tone], ["Done · warning", "warn"]);
    assert.deepEqual([look("fail").label, look("fail").tone], ["Done · fail", "fail"]);
    assert.equal(new Set(["pass", "warning", "fail"].map((v) => look(v as "pass").tone)).size, 3, "three verdicts, three tones: a failed test must not look like a passed one");
  });

  it("says plain Done for a done request that has no verdict, and for every other kind", () => {
    assert.equal(statusOf({ status: "done", kind: "loadtest", loadVerdict: null }).label, "Done");
    assert.equal(statusOf({ status: "done", kind: "loadtest" }).label, "Done");
    for (const kind of ["discover", "rerun", "run"]) assert.equal(statusOf({ status: "done", kind, loadVerdict: "fail" }).label, "Done", `${kind} never says Done · fail`);
  });

  it("leaves a request that is not done as it was, whatever the verdict says", () => {
    for (const status of ["pending", "claimed", "cancelled"] as const) assert.deepEqual(statusOf({ status, kind: "loadtest", loadVerdict: "fail" }), STATUS[status]);
  });
});
