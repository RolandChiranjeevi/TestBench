import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ACCESS } from "./access.ts";
import { accountsState } from "./accounts.ts";
import { allows, roleOf } from "./members.ts";
import { projectOf, projectOfFile } from "./resolve.ts";

/**
 * Enforces server/access.ts on every request, once accounts are on (before that there are no roles and nothing here applies). It runs after the login check, so
 * `req.user` is the person signed in. For a route that needs a project role it finds the project the request is about (the :id of the route, the thing the :id
 * names, a stored file, or a field of the body), asks for the person's role in it right now (no cache: a role that was taken back stops working at once), and answers:
 *  - 404 when the person is not a member, or there is no such thing: the same answer, so a stranger cannot learn what exists;
 *  - 403 when the person is a member with too low a role, saying which role is needed.
 * The owner is an admin of every project, so for the owner a missing thing is left to the route to answer.
 */
export function registerAccessGuard(app: FastifyInstance) {
  const deny = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error });

  async function check(req: FastifyRequest, reply: FastifyReply, phase: "path" | "body") {
    if (accountsState() !== "accounts") return;
    const user = req.user;
    if (!user) return; // not signed in: the login check has answered, or a machine token is on its own route
    const pattern = req.routeOptions?.url;
    if (!pattern) return; // no such route: the not-found handler answers
    const need = ACCESS[`${req.method === "HEAD" ? "GET" : req.method} ${pattern}`];
    if (!need) return deny(reply, 500, "This route has no access rule"); // cannot happen: the server does not start without one
    if (need === "anon" || need === "user" || need === "token" || need === "custom") return;
    if (need === "owner") return user.isOwner ? undefined : deny(reply, 403, "Only the owner can do this");
    if (user.isOwner) return;
    if ((phase === "body") !== !!need.via) return; // a rule that reads the body waits for it; every other rule is decided before the body is read
    const params = req.params as Record<string, string | undefined>;
    const id = need.via ? (req.body as Record<string, unknown> | null | undefined)?.[need.via] : need.kind === "file" ? params["*"] : params.id;
    const projectId = need.kind === "file" ? projectOfFile(String(id ?? "")) : projectOf(need.kind, id);
    const role = projectId === null ? null : roleOf(user, projectId);
    if (role === null) return deny(reply, 404, "Not found");
    if (!allows(role, need.level)) return deny(reply, 403, `This needs the ${need.level} role in this project; you are a ${role}`);
  }

  app.addHook("onRequest", (req, reply) => check(req, reply, "path"));
  app.addHook("preHandler", (req, reply) => check(req, reply, "body"));
}
