import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makeClient } from "./client.ts";
import { buildServer } from "./tools.ts";

/**
 * The TestBench MCP server, over stdio. Claude (or TestPilot) starts it as a child process:
 *   TESTBENCH_URL=http://localhost:4100 TESTBENCH_TOKEN=tbrq_... TESTBENCH_PROJECT_ID=1 npx tsx mcp/index.ts
 * stdout belongs to the MCP protocol, so everything we say goes to stderr, and the token is never said at all.
 * The routes of a request token carry the project in the address, and a token cannot be asked which project it belongs to, so the project is a setting too.
 */
const fail = (message: string): never => {
  console.error(`testbench-mcp: ${message}`);
  process.exit(1);
};

const url = process.env.TESTBENCH_URL?.trim();
const token = process.env.TESTBENCH_TOKEN?.trim();
const project = process.env.TESTBENCH_PROJECT_ID?.trim();
if (!url) fail("TESTBENCH_URL is not set (for example http://localhost:4100).");
if (!token) fail("TESTBENCH_TOKEN is not set. Make a request token for the project in TestBench and set it.");
if (!project) fail("TESTBENCH_PROJECT_ID is not set. It is the number of the project the token belongs to.");
try {
  const u = new URL(url!);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("not http");
} catch {
  fail("TESTBENCH_URL must be an http or https URL.");
}
if (!token!.startsWith("tbrq_")) fail("TESTBENCH_TOKEN is not a request token (it starts with tbrq_).");
if (!/^[1-9]\d{0,9}$/.test(project!)) fail("TESTBENCH_PROJECT_ID must be a whole number such as 1.");

const server = buildServer(makeClient({ baseUrl: url!, token: token! }), Number(project));
await server.connect(new StdioServerTransport());
console.error(`testbench-mcp: ready, talking to ${new URL(url!).origin} for project ${project}`);
