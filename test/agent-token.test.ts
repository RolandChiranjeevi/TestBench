import "./env.ts";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import pino from "pino";
import { db } from "../server/db.ts";
import { makeProject } from "./helpers.ts";
import { createRequirement } from "../server/requirements.ts";
import { createCiToken, authenticateCiToken, redact } from "../server/ci.ts";
import { AGENT_LIMITS, authenticateAgentToken, createAgentToken, isAgentRead, listAgentTokens, revokeAgentToken } from "../server/agenttokens.ts";
import { ACCEPTANCE_LIMITS, parseAcceptance } from "../server/acceptance.ts";
import { agentRequirementsForToken, parseAgentQuery } from "../server/agentapi.ts";
import { LOGGER_OPTIONS } from "../server/logging.ts";

let n = 0;
const proj = () => makeProject(`AT${++n}`, `Agent token ${n}`);
const bearer = (t: string) => `Bearer ${t}`;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("agent tokens", () => {
  it("are made once, with only a hash stored", () => {
    const p = proj();
    const t = createAgentToken(p.id, "qa-agent");
    assert.match(t.token, /^tbag_[A-Za-z0-9_-]{43}$/);
    assert.equal(t.prefix, t.token.slice(0, 9));
    const rows = db.prepare("SELECT * FROM agent_tokens WHERE project_id = ?").all(p.id) as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token_hash, sha256(t.token));
    assert.equal(JSON.stringify(rows).includes(t.token), false, "the token itself is nowhere in the table");
    assert.equal(JSON.stringify(rows).includes(t.token.slice(9)), false, "not even the part after the prefix");
  });

  it("are never in the list: only the prefix and the dates", () => {
    const p = proj();
    const t = createAgentToken(p.id, "listed");
    const list = listAgentTokens(p.id);
    assert.deepEqual(Object.keys(list[0]).sort(), ["createdAt", "id", "lastUsedAt", "name", "prefix", "revokedAt"]);
    assert.equal(JSON.stringify(list).includes(t.token.slice(9)), false);
    assert.equal(list[0].prefix, t.prefix);
  });

  it("are at most five active per project, and revoking one makes room", () => {
    const p = proj();
    const made = Array.from({ length: AGENT_LIMITS.tokensPerProject }, (_, i) => createAgentToken(p.id, `t${i}`));
    assert.throws(() => createAgentToken(p.id, "one too many"), /at most|can have 5/i);
    assert.equal(proj().id > 0 && createAgentToken(proj().id, "another project is not affected").id > 0, true);
    revokeAgentToken(made[0].id);
    assert.doesNotThrow(() => createAgentToken(p.id, "fits again"));
    assert.equal(listAgentTokens(p.id).length, 6, "a revoked token stays in the list, marked revoked");
  });

  it("need a name, and a project that exists", () => {
    const p = proj();
    assert.throws(() => createAgentToken(p.id, "   "), /name/);
    assert.throws(() => createAgentToken(p.id, "x".repeat(AGENT_LIMITS.nameMax + 1)), /name/);
    assert.throws(() => createAgentToken(999999, "ghost"), /Project not found/);
  });

  it("are revoked at once, and only revoking ends a token", () => {
    const p = proj();
    const t = createAgentToken(p.id, "to revoke");
    assert.equal(authenticateAgentToken(bearer(t.token), p.id), "ok");
    revokeAgentToken(t.id);
    assert.equal(authenticateAgentToken(bearer(t.token), p.id), "invalid");
    assert.doesNotThrow(() => revokeAgentToken(t.id), "revoking again is harmless");
    assert.throws(() => revokeAgentToken(999999), /not found/i);
    assert.notEqual(listAgentTokens(p.id)[0].revokedAt, null);
  });

  it("say ok for their own project, other_project for another, and invalid for everything else", () => {
    const a = proj();
    const b = proj();
    const t = createAgentToken(a.id, "a");
    assert.equal(authenticateAgentToken(bearer(t.token), a.id), "ok");
    assert.equal(authenticateAgentToken(bearer(t.token), b.id), "other_project");
    for (const bad of [undefined, "", "Bearer", `Bearer`, t.token, `Basic ${t.token}`, `Bearer ${t.token}x`, `Bearer ${t.token.slice(0, -1)}`, "Bearer tbag_" + "a".repeat(43), `Bearer ${t.token} extra`]) {
      assert.equal(authenticateAgentToken(bad, a.id), "invalid", String(bad));
    }
  });

  it("record when they were last used, only when they work", () => {
    const p = proj();
    const t = createAgentToken(p.id, "used");
    assert.equal(listAgentTokens(p.id)[0].lastUsedAt, null);
    authenticateAgentToken(bearer(t.token), 999999);
    assert.equal(listAgentTokens(p.id)[0].lastUsedAt, null, "a request for another project does not count as use");
    authenticateAgentToken(bearer(t.token), p.id);
    assert.notEqual(listAgentTokens(p.id)[0].lastUsedAt, null);
  });
});

describe("agent tokens and CI tokens are separate kinds", () => {
  it("a tbci_ token never authenticates as an agent token, and a tbag_ token never as a CI token", () => {
    const p = proj();
    const ci = createCiToken(p.id, "ci");
    const agent = createAgentToken(p.id, "agent");
    assert.match(ci.token, /^tbci_/);
    assert.equal(authenticateAgentToken(bearer(ci.token), p.id), "invalid");
    assert.equal(authenticateCiToken(bearer(agent.token), p.id), false);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM ci_tokens WHERE project_id = ?").get(p.id) as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM agent_tokens WHERE project_id = ?").get(p.id) as { n: number }).n, 1);
  });

  it("the prefix is refused before the database is asked", () => {
    const p = proj();
    // A row whose hash matches a token that does not start with tbag_: it would be found if the lookup came first.
    db.prepare("INSERT INTO agent_tokens (project_id, name, prefix, token_hash) VALUES (?, 'planted', 'plain', ?)").run(p.id, sha256("plain-token-without-the-prefix"));
    assert.equal(authenticateAgentToken(bearer("plain-token-without-the-prefix"), p.id), "invalid");
    db.prepare("INSERT INTO agent_tokens (project_id, name, prefix, token_hash) VALUES (?, 'planted2', 'tbci_', ?)").run(p.id, sha256("tbci_planted_in_the_agent_table_xxxxxxxxxxxxxxxx"));
    assert.equal(authenticateAgentToken(bearer("tbci_planted_in_the_agent_table_xxxxxxxxxxxxxxxx"), p.id), "invalid");
  });
});

describe("the one route an agent token opens", () => {
  it("is GET on /api/agent/projects/:id/requirements and nothing else", () => {
    assert.equal(isAgentRead("GET", "/api/agent/projects/3/requirements"), true);
    assert.equal(isAgentRead("GET", "/api/agent/projects/3/requirements?kind=functional"), true);
    for (const [m, u] of [["POST", "/api/agent/projects/3/requirements"], ["DELETE", "/api/agent/projects/3/requirements"], ["PUT", "/api/agent/projects/3/requirements"],
      ["GET", "/api/projects/3/agent/requirements"], ["GET", "/api/agent/projects/3/requirements/extra"], ["GET", "/api/agent/projects/x/requirements"],
      ["GET", "/api/agent/projects/3/tokens"], ["GET", "/api/projects/3/agent/tokens"], ["POST", "/api/projects/3/agent/tokens"], ["GET", "/api/projects"]] as const) {
      assert.equal(isAgentRead(m, u), false, `${m} ${u}`);
    }
  });
});

describe("acceptance criteria read from the description", () => {
  const ac = (s: string) => parseAcceptance(s);

  it("a bullet list under a label on its own line", () => {
    assert.deepEqual(ac("Users can reset the password.\n\nAcceptance criteria:\n- A mail is sent within a minute\n- The link works once\n- The old password stops working"),
      { criteria: ["A mail is sent within a minute", "The link works once", "The old password stops working"], readiness: "ready" });
  });

  it("a heading label, numbered items, and other bullet marks", () => {
    assert.deepEqual(ac("## Acceptance criteria\n\n1. First\n2) Second\n* Third\n+ Fourth").criteria, ["First", "Second", "Third", "Fourth"]);
  });

  it("the inline form after a colon, with the label in the middle of a paragraph", () => {
    assert.deepEqual(ac("The cart shows the total. Acceptance criteria: the total includes the discount code."),
      { criteria: ["the total includes the discount code."], readiness: "ready" });
    assert.deepEqual(ac("**Acceptance criteria:** the form refuses an empty name").criteria, ["the form refuses an empty name"]);
    assert.deepEqual(ac("**Acceptance criteria**: works on a phone").criteria, ["works on a phone"]);
    assert.deepEqual(ac("ACCEPTANCE CRITERIA: shouting is fine").criteria, ["shouting is fine"]);
  });

  it("the inline form with a list straight below it", () => {
    assert.deepEqual(ac("Acceptance criteria: the main flow works\n- on a phone\n- with a keyboard").criteria, ["the main flow works", "on a phone", "with a keyboard"]);
  });

  it("no label means no criteria and needs-clarification, also when there are lists and the words occur", () => {
    assert.deepEqual(ac("Users can log in.\n- with a password\n- with a link"), { criteria: [], readiness: "needs-clarification" });
    assert.deepEqual(ac("See the acceptance criteria in the ticket."), { criteria: [], readiness: "needs-clarification" });
    assert.deepEqual(ac(""), { criteria: [], readiness: "needs-clarification" });
    assert.deepEqual(ac(undefined as unknown as string), { criteria: [], readiness: "needs-clarification" });
  });

  it("a label with nothing under it gives nothing", () => {
    assert.deepEqual(ac("Acceptance criteria:\n\nThis paragraph is not a criterion."), { criteria: [], readiness: "needs-clarification" });
    assert.deepEqual(ac("Acceptance criteria:"), { criteria: [], readiness: "needs-clarification" });
  });

  it("several paragraphs: only the labelled block counts, and it ends where the list ends", () => {
    const text = "Intro paragraph with - a dash in it.\n\n- an unrelated bullet before the label\n\nAcceptance criteria:\n- One\n- Two\n\nNotes for the team.\n- not a criterion\n\n## Open questions\n- nor this";
    assert.deepEqual(ac(text).criteria, ["One", "Two"]);
  });

  it("a list with blank lines between items stays one list, and a blank line after an inline label ends it", () => {
    assert.deepEqual(ac("Acceptance criteria:\n\n- One\n\n- Two\n\n- Three").criteria, ["One", "Two", "Three"]);
    assert.deepEqual(ac("Acceptance criteria: the one inline criterion\n\n- a bullet of another paragraph").criteria, ["the one inline criterion"]);
  });

  it("several labelled blocks add up", () => {
    assert.deepEqual(ac("Acceptance criteria:\n- A\n\n## Mobile\nAcceptance criteria: B").criteria, ["A", "B"]);
  });

  it("checkboxes are dropped, wrapped lines are joined, and nothing is invented or called measurable", () => {
    assert.deepEqual(ac("Acceptance criteria:\n- [ ] Open box\n- [x] Done box\n- A long one that\n  wraps onto a second line").criteria, ["Open box", "Done box", "A long one that wraps onto a second line"]);
    const r = ac("Acceptance criteria: it feels fast");
    assert.deepEqual(Object.keys(r).sort(), ["criteria", "readiness"], "no measurable flag");
  });

  it("long criteria are cut, and there are at most 50", () => {
    assert.equal(ac(`Acceptance criteria: ${"x".repeat(2000)}`).criteria[0].length, ACCEPTANCE_LIMITS.length);
    const many = ac(`Acceptance criteria:\n${Array.from({ length: 80 }, (_, i) => `- c${i}`).join("\n")}`);
    assert.equal(many.criteria.length, ACCEPTANCE_LIMITS.criteria);
    assert.equal(many.criteria[49], "c49");
  });

  it("understands Windows line endings", () => {
    assert.deepEqual(ac("Acceptance criteria:\r\n- A\r\n- B\r\n").criteria, ["A", "B"]);
  });
});

describe("the minimal projection for an agent", () => {
  const reqs = (projectId: number) => agentRequirementsForToken(projectId).requirements;

  it("has exactly the five fields, and the id is the stable id or REQ-n", () => {
    const p = proj();
    createRequirement(p.id, { title: "Stable id one", description: "Acceptance criteria:\n- It works", source: "JIRA-1", externalId: "CHK-1" } as never);
    createRequirement(p.id, { title: "No stable id", description: "Nothing about criteria" } as never);
    const out = agentRequirementsForToken(p.id);
    assert.equal(out.format, "testbench-agent-requirements");
    assert.equal(out.project, p.key);
    assert.deepEqual(out.requirements.map((r) => Object.keys(r).sort()), [["acceptance_criteria", "readiness", "requirement_id", "source", "title"], ["acceptance_criteria", "readiness", "requirement_id", "source", "title"]]);
    assert.deepEqual(out.requirements[0], { requirement_id: "CHK-1", title: "Stable id one", source: "JIRA-1", readiness: "ready", acceptance_criteria: ["It works"] });
    assert.deepEqual(out.requirements[1], { requirement_id: "REQ-2", title: "No stable id", source: "", readiness: "needs-clarification", acceptance_criteria: [] });
    const text = JSON.stringify(out);
    for (const leaked of ["coverage", "links", "description", "wcag", "viewports", "priority", "updatedAt"]) assert.equal(text.includes(`"${leaked}"`), false, leaked);
    assert.match(out.note, /does not say that they are measurable/);
  });

  it("only active requirements, and none from other projects", () => {
    const a = proj();
    const b = proj();
    createRequirement(a.id, { title: "A active", status: "approved" } as never);
    createRequirement(a.id, { title: "A draft", status: "draft" } as never);
    createRequirement(a.id, { title: "A retired", status: "deprecated" } as never);
    createRequirement(b.id, { title: "B active", status: "approved" } as never);
    assert.deepEqual(reqs(a.id).map((r) => r.title), ["A active"]);
    assert.deepEqual(reqs(b.id).map((r) => r.title), ["B active"]);
  });

  it("can be narrowed by kind", () => {
    const p = proj();
    createRequirement(p.id, { title: "Func", kind: "functional" } as never);
    createRequirement(p.id, { title: "A11y", kind: "accessibility" } as never);
    assert.deepEqual(agentRequirementsForToken(p.id, { kind: "accessibility" }).requirements.map((r) => r.title), ["A11y"]);
  });

  it("takes only status=active and a real kind, and refuses everything else", () => {
    assert.deepEqual(parseAgentQuery({}), {});
    assert.deepEqual(parseAgentQuery({ status: "active" }), {});
    assert.deepEqual(parseAgentQuery({ kind: "usability" }), { kind: "usability" });
    for (const bad of [{ status: "all" }, { status: "draft" }, { status: "retired" }, { status: "" }, { kind: "nope" }, { limit: "5" }, { status: ["active", "all"] }, { download: "1" }]) {
      assert.throws(() => parseAgentQuery(bad), (e: Error & { status?: number }) => e.status === 400, JSON.stringify(bad));
    }
  });
});

describe("the log never holds a token or a cookie", () => {
  const capture = () => {
    let out = "";
    const stream = new Writable({ write(chunk, _enc, cb) { out += chunk; cb(); } });
    return { logger: pino(LOGGER_OPTIONS as pino.LoggerOptions, stream), text: () => out };
  };

  it("replaces the Authorization header and the cookie in a logged request", () => {
    const { logger, text } = capture();
    const token = "tbag_" + "S".repeat(43);
    logger.warn({ req: { method: "GET", url: "/x", headers: { authorization: `Bearer ${token}`, cookie: "tb_session=SECRETCOOKIE", host: "h" } } }, "request");
    logger.warn({ headers: { authorization: `Bearer ${token}` } }, "headers only");
    assert.equal(text().includes(token), false);
    assert.equal(text().includes("SECRETCOOKIE"), false);
    assert.match(text(), /\[redacted\]/);
    assert.match(text(), /"host":"h"/, "other headers are kept");
  });

  it("also masks a tbag_ or tbci_ token that is in free text", () => {
    const agent = "tbag_" + "A".repeat(43);
    const ci = "tbci_" + "B".repeat(43);
    const out = redact(`failed with ${agent} and ${ci}`);
    assert.equal(out.includes(agent) || out.includes(ci), false);
    assert.equal(out, "failed with [redacted] and [redacted]");
  });
});
