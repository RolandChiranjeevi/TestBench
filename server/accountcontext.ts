import { AsyncLocalStorage } from "node:async_hooks";
import type {} from "fastify";

/** The person signed in, as far as the code below a request needs to know. */
export interface AccountUser { id: number; email: string; name: string; isOwner: boolean; disabledAt: string | null; createdAt: string; lastLoginAt: string | null }

/**
 * Who is making the request that is being handled. It is set once, early in the request (see auth.ts), and read where a change is recorded (actor.ts), so that code that
 * writes "created by" does not need the request passed down to it. Without accounts, and outside a request (a script, a test), there is no user.
 */
const storage = new AsyncLocalStorage<{ user: AccountUser | null }>();
export const runAs = <T>(user: AccountUser | null, fn: () => T): T => storage.run({ user }, fn);
export const currentUser = (): AccountUser | null => storage.getStore()?.user ?? null;
/** Sets the user for the rest of the request being handled (called once by the login gate; each request has its own, also across awaits). */
export const enterAs = (user: AccountUser | null): void => storage.enterWith({ user });

declare module "fastify" {
  interface FastifyRequest {
    /** The person signed in with an account, or null (no accounts, an API token, or not signed in). */
    user: AccountUser | null;
    sessionId: number | null;
  }
}
