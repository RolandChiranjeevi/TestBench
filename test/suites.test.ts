import "./env.ts";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { db } from "../server/db.ts";
import { moveSuite, SuiteMoveError } from "../server/suites.ts";
import { makeProject, makeSuite } from "./helpers.ts";

const children = (projectId: number, parentId: number | null) =>
  (db.prepare("SELECT name FROM suites WHERE project_id = ? AND parent_id IS ? ORDER BY position, id").all(projectId, parentId) as { name: string }[]).map((s) => s.name);

describe("moveSuite", () => {
  let p: { id: number };
  let auth: number, cart: number, checkout: number;
  beforeEach(() => {
    p = makeProject(`S${Math.random().toString(36).slice(2, 7).toUpperCase()}`);
    auth = makeSuite(p.id, "Auth");
    cart = makeSuite(p.id, "Cart");
    checkout = makeSuite(p.id, "Checkout");
  });

  it("places a suite before a sibling", () => {
    moveSuite(checkout, null, auth);
    assert.deepEqual(children(p.id, null), ["Checkout", "Auth", "Cart"]);
  });

  it("moves to the end when no sibling is given", () => {
    moveSuite(auth, null, null);
    assert.deepEqual(children(p.id, null), ["Cart", "Checkout", "Auth"]);
  });

  it("nests under another suite and keeps order among the new siblings", () => {
    moveSuite(checkout, cart, null);
    moveSuite(auth, cart, checkout);
    assert.deepEqual(children(p.id, null), ["Cart"]);
    assert.deepEqual(children(p.id, cart), ["Auth", "Checkout"]);
  });

  it("moves a nested suite back to the top level", () => {
    moveSuite(checkout, cart, null);
    moveSuite(checkout, null, cart);
    assert.deepEqual(children(p.id, null), ["Auth", "Checkout", "Cart"]);
    assert.deepEqual(children(p.id, cart), []);
  });

  it("renumbers siblings 0..n so the order is explicit", () => {
    moveSuite(cart, null, auth);
    const positions = (db.prepare("SELECT position FROM suites WHERE project_id = ? AND parent_id IS NULL ORDER BY position").all(p.id) as { position: number }[]).map((s) => s.position);
    assert.deepEqual(positions, [0, 1, 2]);
  });

  it("refuses to move a suite into itself or one of its own children", () => {
    const sub = makeSuite(p.id, "Sub", cart);
    assert.throws(() => moveSuite(cart, cart, null), (e: unknown) => e instanceof SuiteMoveError && e.status === 400);
    assert.throws(() => moveSuite(cart, sub, null), /into itself/);
    assert.deepEqual(children(p.id, cart), ["Sub"]); // nothing changed
  });

  it("refuses a parent from another project, and a 'before' that is not a sibling there", () => {
    const other = makeProject(`X${Math.random().toString(36).slice(2, 7).toUpperCase()}`);
    const foreign = makeSuite(other.id, "Foreign");
    assert.throws(() => moveSuite(auth, foreign, null), /another project/);
    assert.throws(() => moveSuite(auth, null, 999999), /not in that folder/);
    assert.throws(() => moveSuite(999999, null, null), (e: unknown) => e instanceof SuiteMoveError && e.status === 404);
    assert.deepEqual(children(p.id, null), ["Auth", "Cart", "Checkout"]);
  });
});
