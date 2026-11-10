// Run by access-production.test.ts in a child process: starts the app the way a production build does and says whether it came up. Nothing listens.
process.env.TESTBENCH_NO_LISTEN = "1";
const { app } = await import("../server/index.ts");
const { REGISTERED, accessTableProblems } = await import("../server/access.ts");
await app.ready();
console.log(JSON.stringify({ ready: true, staticRoute: REGISTERED.includes("GET /*"), problems: accessTableProblems(REGISTERED) }));
await app.close();
