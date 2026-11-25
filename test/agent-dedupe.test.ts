import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claimRequest, completeRequest, createRequest } from "../server/agentrequests.ts";
import { AuditError } from "../server/auditcommon.ts";
import { KEY_RX, knownPosts, LIKENESS_MIN, likeness, pageOf } from "../server/agentdedupe.ts";
import { createFinding, findingBody } from "../server/agentfindings.ts";
import { db } from "../server/db.ts";
import { createRequestToken } from "../server/requesttokens.ts";
import { makeProject } from "./helpers.ts";

// Discover without duplicates (server/agentdedupe.ts): the same thing found by a later request is a sighting, not a second post. The rule leans the other way from hiding: anything
// less than the same key, the same page (for a bug) and some words in common makes a new post.

const asAgent = (projectId: number, name: string) => {
  const token = createRequestToken(projectId, name);
  const t = { id: token.id, name };
  /** Takes a fresh discover request (the previous one is finished first: one request at a time in a project). */
  let last: number | undefined;
  const take = () => {
    if (last !== undefined) completeRequest(projectId, last, t, {});
    const req = createRequest(projectId, { kind: "discover", targetUrl: "http://localhost:3000/" }, { name: "a person", userId: null });
    claimRequest(projectId, req.id, t);
    last = req.id;
    return req.id;
  };
  return { token: t, take };
};
const make = (projectId: number, rid: number, token: { id: number; name: string }, body: unknown) => createFinding(projectId, rid, token, "127.0.0.1", findingBody.parse(body));
const count = (sql: string, ...args: unknown[]) => db.prepare(sql).pluck().get(...args) as number;
const seenAgain = (r: unknown) => (r as { seenAgain?: boolean }).seenAgain;
const possibleDuplicateOf = (r: unknown) => (r as { possibleDuplicateOf?: number }).possibleDuplicateOf;

const BUG = { kind: "bug_report", title: "Item total shows floating-point digits for some carts", actual: "$59.980000000000004", url: "https://www.saucedemo.com/checkout-step-two.html", key: "checkout-step-two:float-total" };
const CASE = { kind: "test_case", title: "Checkout with an empty cart", description: "Open the cart with nothing in it and press Checkout", key: "case:cart:empty-checkout" };
const OBS = { kind: "observation", title: "Lazy load keeps adding entries", evidence: "Pressing End loads more Loading entries", key: "lazy-load:keeps-growing" };

describe("the same thing found again is a sighting, not a second post", () => {
  it("a bug report, a test case and an observation with the same key and about the same words make one post each, and a sighting each", () => {
    const p = makeProject("DD1", "Dedupe 1");
    const a = asAgent(p.id, "agent-a");
    const first = a.take();
    const made = [BUG, CASE, OBS].map((b) => make(p.id, first, a.token, b));
    for (const m of made) assert.equal(seenAgain(m), undefined, "the first time makes a post");

    const second = a.take();
    const again = [
      make(p.id, second, a.token, { ...BUG, title: "Item total shows a floating point error, for example $59.98", actual: "$59.980000000000004 for Fleece Jacket and Bike Light" }),
      make(p.id, second, a.token, { ...CASE, title: "Checkout with an empty cart works or is refused" }),
      make(p.id, second, a.token, { ...OBS, title: "Lazy load: more Loading entries keep coming" }),
    ];
    for (const [i, r] of again.entries()) {
      assert.equal(seenAgain(r), true, `finding ${i}`);
      assert.equal(r.id, made[i].id, "it names the post that already exists");
    }
    assert.equal((again[1] as { number?: number }).number, (made[1] as { number?: number }).number, "a case gives the number it already has, which a spec's tag follows");
    assert.equal(count("SELECT COUNT(*) FROM bug_reports WHERE project_id = ?", p.id), 1);
    assert.equal(count("SELECT COUNT(*) FROM cases WHERE project_id = ?", p.id), 1);
    assert.equal(count("SELECT COUNT(*) FROM observations WHERE project_id = ?", p.id), 1);
    assert.equal(count("SELECT COUNT(*) FROM agent_sightings WHERE request_id = ?", first), 3, "the request that made a post leaves the first sighting");
    assert.equal(count("SELECT COUNT(*) FROM agent_sightings WHERE request_id = ?", second), 3);
    assert.equal(count("SELECT findings_count FROM agent_requests WHERE id = ?", second), 3, "a sighting still counts towards the request's findings");
    assert.equal(count("SELECT COUNT(*) FROM audit_log WHERE action = 'agent_request.finding_seen_again' AND detail LIKE ?", `%"request":${second},%`), 3, "and is logged");
  });

  it("the sighting keeps what the agent wrote this time, in full, and the post is left exactly as it was (a person may have worked on it)", () => {
    const p = makeProject("DD2", "Dedupe 2");
    const a = asAgent(p.id, "agent-a");
    const post = make(p.id, a.take(), a.token, BUG);
    db.prepare("UPDATE bug_reports SET title = ?, review_status = 'accepted' WHERE id = ?").run("A person's own wording", post.id);
    make(p.id, a.take(), a.token, { ...BUG, title: "Item total shows a floating point error", description: "this time with steps", steps: ["add two items"] });
    const row = db.prepare("SELECT title, review_status, description FROM bug_reports WHERE id = ?").get(post.id) as { title: string; review_status: string; description: string };
    assert.deepEqual(row, { title: "A person's own wording", review_status: "accepted", description: "" });
    const sighting = JSON.parse(db.prepare("SELECT payload FROM agent_sightings WHERE project_id = ? AND kind = 'bug_report' AND post_id = ? ORDER BY id DESC").pluck().get(p.id, post.id) as string);
    assert.equal(sighting.description, "this time with steps");
    assert.deepEqual(sighting.steps, ["add two items"]);
  });

  it("a finding without a key is always a post: nothing is compared, as before", () => {
    const p = makeProject("DD3", "Dedupe 3");
    const a = asAgent(p.id, "agent-a");
    const { key: _k, ...noKey } = BUG;
    make(p.id, a.take(), a.token, noKey);
    make(p.id, a.take(), a.token, noKey);
    assert.equal(count("SELECT COUNT(*) FROM bug_reports WHERE project_id = ?", p.id), 2);
    assert.equal(count("SELECT COUNT(*) FROM agent_sightings WHERE project_id = ?", p.id), 0, "no key, no sighting");
  });
});

describe("anything less than a match makes a post, and says it may be a duplicate", () => {
  it("the same key on ANOTHER PAGE is a new bug report (the page is the real test), with possibleDuplicateOf", () => {
    const p = makeProject("DD4", "Dedupe 4");
    const a = asAgent(p.id, "agent-a");
    const first = make(p.id, a.take(), a.token, BUG);
    const other = make(p.id, a.take(), a.token, { ...BUG, url: "https://www.saucedemo.com/cart.html" });
    assert.notEqual(other.id, first.id);
    assert.equal(possibleDuplicateOf(other), first.id);
    assert.equal(count("SELECT COUNT(*) FROM agent_sightings WHERE project_id = ? AND kind = 'bug_report' AND post_id = ?", p.id, other.id), 1, "only its own first sighting");
    assert.equal(count("SELECT COUNT(*) FROM agent_sightings WHERE project_id = ? AND kind = 'bug_report' AND post_id = ?", p.id, first.id), 1, "and none was added to the first post");
  });

  it("a bug without an address never matches (no page to compare), and an address with a query, a fragment or other letters in the name is the same page", () => {
    const p = makeProject("DD5", "Dedupe 5");
    const a = asAgent(p.id, "agent-a");
    make(p.id, a.take(), a.token, BUG);
    assert.equal(seenAgain(make(p.id, a.take(), a.token, { ...BUG, url: "" })), undefined);
    assert.equal(seenAgain(make(p.id, a.take(), a.token, { ...BUG, url: "https://www.saucedemo.com/Checkout-Step-Two?x=1#top" })), true);
    assert.equal(pageOf("https://www.saucedemo.com/"), "home");
    assert.equal(pageOf("/"), "home");
    assert.equal(pageOf(""), "");
  });

  it("a key reused for something quite different is a new post", () => {
    const p = makeProject("DD6", "Dedupe 6");
    const a = asAgent(p.id, "agent-a");
    const first = make(p.id, a.take(), a.token, OBS);
    const other = make(p.id, a.take(), a.token, { ...OBS, title: "Sort icon is not centred", evidence: "at 390 px the arrow sits low" });
    assert.notEqual(other.id, first.id);
    assert.equal(possibleDuplicateOf(other), first.id);
  });

  it("a key is only compared inside its own project", () => {
    const one = makeProject("DD7", "Dedupe 7"), two = makeProject("DD8", "Dedupe 8");
    const a = asAgent(one.id, "agent-a"), b = asAgent(two.id, "agent-b");
    make(one.id, a.take(), a.token, CASE);
    const other = make(two.id, b.take(), b.token, CASE);
    assert.equal(seenAgain(other), undefined);
    assert.equal(possibleDuplicateOf(other), undefined);
    assert.equal(count("SELECT COUNT(*) FROM cases WHERE project_id IN (?, ?)", one.id, two.id), 2);
  });

  it("a person's own test case (no key) is never matched", () => {
    const p = makeProject("DD9", "Dedupe 9");
    db.prepare("INSERT INTO cases (project_id, number, title, description, priority, status, tags, position) VALUES (?, 1, ?, ?, 'medium', 'ready', '[]', 0)").run(p.id, CASE.title, CASE.description);
    db.prepare("UPDATE projects SET next_case_number = 2 WHERE id = ?").run(p.id);
    const a = asAgent(p.id, "agent-a");
    assert.equal(seenAgain(make(p.id, a.take(), a.token, CASE)), undefined);
    assert.equal(count("SELECT COUNT(*) FROM cases WHERE project_id = ?", p.id), 2);
  });
});

describe("the key and the words", () => {
  it("a key is lower case words joined by : and -, and anything else is refused", () => {
    for (const ok of ["cart:float-total", "checkout-step-one:enter-submits-form", "case:checkout:empty-fields"]) assert.match(ok, KEY_RX, ok);
    for (const bad of ["Cart:Float", "cart", "cart:", ":x", "a b:c", "cart:float total", `${"a".repeat(70)}:x`]) {
      assert.doesNotMatch(bad, KEY_RX, bad);
      assert.equal(findingBody.safeParse({ ...BUG, key: bad }).success, false, bad);
    }
  });

  it("the threshold sits between the real pairs of two runs (the same bug, 0.34 and up) and the highest wrong pair (0.29)", () => {
    const same: [string, string][] = [
      ["An empty cart can be checked out", "An empty cart can be checked out and the order completes"],
      ["Item total shows floating-point digits for some carts", "Item total shows a floating point error, for example $59.980000000000004"],
      ["Pressing Enter in the checkout form acts as Cancel", "Pressing Enter in a checkout field goes back to the cart"],
      ["Checkout accepts a first name of only spaces, markup and an emoji", "Checkout accepts a first name that is only spaces"],
    ];
    for (const [a, b] of same) assert.ok(likeness(a, b) >= LIKENESS_MIN, `${a} / ${b}`);
    const different: [string, string][] = [
      ["Reset App State leaves the item buttons on Remove", "An unknown item id shows Item not found but Add to cart still works"],
      ["Postal code accepts letters and symbols", "Checkout accepts a first name that is only spaces"],
      ["Checkout overview is blank after a non-existent item was added", "Pressing Enter in a checkout field goes back to the cart"],
    ];
    for (const [a, b] of different) assert.ok(likeness(a, b) < LIKENESS_MIN, `${a} / ${b}`);
    assert.equal(likeness("", "anything"), 0);
  });
});

describe("what an agent may read about earlier posts", () => {
  it("lists only posts an agent keyed, with how often each was seen again, and nothing of another project or of a person", () => {
    const p = makeProject("DD10", "Dedupe 10"), q = makeProject("DD11", "Dedupe 11");
    db.prepare("INSERT INTO cases (project_id, number, title, description, priority, status, tags, position) VALUES (?, 1, 'A person case', '', 'medium', 'ready', '[]', 0)").run(p.id);
    db.prepare("UPDATE projects SET next_case_number = 2 WHERE id = ?").run(p.id);
    const a = asAgent(p.id, "agent-a"), b = asAgent(q.id, "agent-b");
    make(q.id, b.take(), b.token, OBS);
    const first = a.take();
    make(p.id, first, a.token, BUG);
    make(p.id, first, a.token, CASE);
    const second = a.take();
    make(p.id, second, a.token, BUG);
    const known = knownPosts(p.id, second, a.token);
    assert.equal(known.bug_reports.length, 1);
    assert.deepEqual({ key: known.bug_reports[0].key, seen: known.bug_reports[0].seen }, { key: BUG.key, seen: 1 });
    assert.equal(known.test_cases.length, 1, "the person's own case has no key and is not listed");
    assert.equal(known.test_cases[0].key, CASE.key);
    assert.equal(known.observations.length, 0, "the other project's observation is not listed");
  });

  it("is refused for a request this token did not take, a finished one, and a request of another project", () => {
    const p = makeProject("DD12", "Dedupe 12"), q = makeProject("DD13", "Dedupe 13");
    const a = asAgent(p.id, "agent-a"), other = asAgent(p.id, "agent-b");
    const rid = a.take();
    assert.throws(() => knownPosts(p.id, rid, other.token), (e) => e instanceof AuditError && e.status === 409);
    assert.throws(() => knownPosts(q.id, rid, a.token), (e) => e instanceof AuditError && e.status === 404);
    completeRequest(p.id, rid, a.token, {});
    assert.throws(() => knownPosts(p.id, rid, a.token), (e) => e instanceof AuditError && e.status === 409);
  });
});

describe("a sighting goes when its post goes", () => {
  it("deleting the post removes its sightings", () => {
    const p = makeProject("DD14", "Dedupe 14");
    const a = asAgent(p.id, "agent-a");
    const post = make(p.id, a.take(), a.token, CASE);
    make(p.id, a.take(), a.token, CASE);
    assert.equal(count("SELECT COUNT(*) FROM agent_sightings WHERE project_id = ? AND kind = 'test_case' AND post_id = ?", p.id, post.id), 2, "the first one and the one seen again");
    db.prepare("DELETE FROM cases WHERE id = ?").run(post.id);
    assert.equal(count("SELECT COUNT(*) FROM agent_sightings WHERE project_id = ? AND kind = 'test_case' AND post_id = ?", p.id, post.id), 0);
  });
});
