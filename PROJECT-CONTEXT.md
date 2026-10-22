# TestBench: project context

A short, factual baseline for anyone (or any session) starting work here. The README describes features; this describes the situation.

**Name and purpose.** TestBench is a local, single-user test management app (runs on localhost). You write manual test cases and requirements,
run them, import automated results (Playwright, TestCafe, Selenium, JUnit) from files or GitHub Actions, and produce sprint/release PDF reports
for managers. Think Testomat.io-style, in a Linear-style interface.

**Tech stack.** TypeScript on Node 24 (`tsx`); Fastify + SQLite (better-sqlite3) + zod on the server; React + Vite + TanStack Query on the web.
Tests use Node's built-in runner: `npm test`. Types: `npm run typecheck`. Dev: `npm run dev` (API 127.0.0.1:4100, web 5173).

**Current phase.** First version is feature-complete and in real use. The next features come from friction found while using it, not from the
wish list. Data is in the git-ignored `data/` folder, with an automatic daily backup in `data/backups/`.

**Key constraints.**
- Localhost only, one user. No paid services or accounts are required; the optional TypeSafe link suggestions stay off without an API key.
- Jira bug text is pasted by hand; creating bugs through the API is deliberately postponed.
- Tests and experiments must use a throwaway data folder (`TESTBENCH_DATA`), never the real `data/`.

**What "done" looks like.** Typecheck and tests pass, the change is checked on a throwaway dataset, the README is updated, and it is committed.
Pushing to `origin main` happens only when the owner says so.
