import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { migrate, migrateRoles } from "../server/db.ts";

// The step from accounts without roles to accounts with roles, on a database of its own (in memory): the accounts that exist keep what they could do, once.
const fresh = () => { const d = new Database(":memory:"); d.pragma("foreign_keys = ON"); migrate(d); return d; };
const memberships = (d: Database.Database) => d.prepare("SELECT p.key AS project, u.email, m.role FROM project_members m JOIN projects p ON p.id = m.project_id JOIN users u ON u.id = m.user_id ORDER BY p.key, u.email").all();

describe("accounts that existed before roles keep their access, once", () => {
  it("every account that is not the owner becomes a tester in every project; the owner needs no row; it is logged, and not repeated", () => {
    const d = fresh();
    d.prepare("DELETE FROM app_settings WHERE key = 'roles_migrated_at'").run(); // as if this database came from before roles
    d.exec("INSERT INTO projects (name, key) VALUES ('Alpha', 'ALP'), ('Beta', 'BET')");
    d.exec("INSERT INTO users (email, name, password_hash, is_owner) VALUES ('owner@x.io', 'Owner', 'h', 1), ('a@x.io', 'A', 'h', 0), ('b@x.io', 'B', 'h', 0)");
    migrateRoles(d);
    assert.deepEqual(memberships(d), [
      { project: "ALP", email: "a@x.io", role: "tester" }, { project: "ALP", email: "b@x.io", role: "tester" },
      { project: "BET", email: "a@x.io", role: "tester" }, { project: "BET", email: "b@x.io", role: "tester" },
    ]);
    const log = d.prepare("SELECT actor_label, action, detail FROM audit_log WHERE action = 'members.migrated'").all() as { actor_label: string; detail: string }[];
    assert.equal(log.length, 1);
    assert.deepEqual([log[0].actor_label, JSON.parse(log[0].detail)], ["migration", { role: "tester", memberships: 4 }]);
    // the owner takes one back; another start does not give it back, and a new account and a new project are not touched
    d.prepare("DELETE FROM project_members WHERE project_id = 1 AND user_id = (SELECT id FROM users WHERE email = 'a@x.io')").run();
    d.exec("INSERT INTO users (email, name, password_hash) VALUES ('c@x.io', 'C', 'h'); INSERT INTO projects (name, key) VALUES ('Gamma', 'GAM')");
    migrateRoles(d);
    migrate(d);
    assert.equal(memberships(d).length, 3, "nothing was given back or added");
    assert.equal(d.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'members.migrated'").pluck().get(), 1);
  });

  it("a new installation (no accounts yet) gets nothing, and says it has been done", () => {
    const d = fresh();
    assert.equal(memberships(d).length, 0);
    assert.equal(d.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'members.migrated'").pluck().get(), 0);
    assert.ok(d.prepare("SELECT 1 FROM app_settings WHERE key = 'roles_migrated_at'").get());
  });

  it("a role must be admin, tester or viewer, and a membership goes with its project and its account", () => {
    const d = fresh();
    d.exec("INSERT INTO projects (name, key) VALUES ('Alpha', 'ALP')");
    d.exec("INSERT INTO users (email, name, password_hash) VALUES ('a@x.io', 'A', 'h')");
    assert.throws(() => d.exec("INSERT INTO project_members (project_id, user_id, role) VALUES (1, 1, 'boss')"), /CHECK/);
    d.exec("INSERT INTO project_members (project_id, user_id, role) VALUES (1, 1, 'viewer')");
    assert.throws(() => d.exec("INSERT INTO project_members (project_id, user_id, role) VALUES (1, 1, 'tester')"), /UNIQUE|PRIMARY/);
    d.exec("DELETE FROM projects WHERE id = 1");
    assert.equal(memberships(d).length, 0);
  });
});
