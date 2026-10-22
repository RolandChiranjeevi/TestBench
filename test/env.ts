import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Imported first by every test file: each gets its own empty data folder, so tests never touch the real data/.
// (Test files run in separate processes, and server/db.ts reads this variable when it is first loaded.)
export const TEST_DATA = mkdtempSync(join(tmpdir(), "testbench-test-"));
process.env.TESTBENCH_DATA = TEST_DATA;
process.env.TESTBENCH_AUTO_BACKUP = "1";
delete process.env.TYPESAFE_API_KEY;
