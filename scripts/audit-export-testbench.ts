// Converts a finished audit package of the qa-run audit contract (version 1.2) into the package format Testbench imports,
// in a separate folder, and runs Testbench's own package check on the result. The input package is only read. Nothing is delivered.
//   npm run audit:export:testbench -- --input <contract package> --output <new folder> --project <Testbench key> [--overwrite]
// Exit code 0: exported and Testbench would accept it. 1: the input is not a valid finished package, or Testbench would refuse the export. 2: wrong usage.
import { ContractError } from "../server/importers/auditcontract.ts";
import { ExportError, exportToTestbench } from "../server/importers/testbenchexport.ts";

const args = process.argv.slice(2);
const flags = new Map<string, string>();
let overwrite = false;
let bad = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--overwrite") overwrite = true;
  else if (["--input", "--output", "--project"].includes(a) && args[i + 1] && !args[i + 1].startsWith("--")) flags.set(a, args[++i]);
  else bad = true;
}
const input = flags.get("--input");
const output = flags.get("--output");
const project = flags.get("--project");
if (bad || !input || !output || !project) {
  console.error("Usage: npm run audit:export:testbench -- --input <contract package> --output <new folder> --project <Testbench project key> [--overwrite]");
  if (!project && input && output) console.error("--project is required: audit contract 1.2 has no Testbench project key (for example RS).");
  process.exit(2);
}

try {
  const r = exportToTestbench({ input, output, project, overwrite });
  console.log(`Contract ${r.provenance.source.contractVersion} check of ${input}: pass (${Object.entries(r.contract.counts).map(([k, v]) => `${v} ${k}`).join(", ")})`);
  for (const w of r.contract.warnings) console.log(`contract warning: ${w}`);
  console.log(`Wrote ${r.files.length} files to ${r.output}`);
  for (const w of r.warnings) console.log(`export warning: ${w}`);
  console.log(`report.md: ${r.report.generated ? "Test plan section inserted" : "left as it is"} (${r.report.where})`);
  for (const g of r.provenance.generated) console.log(`adapter-generated: ${g.target} = ${g.value}`);
  console.log(`Testbench check: audit ${r.testbench.auditId ?? "?"} for project ${r.testbench.project ?? "?"}, ${r.testbench.sourceIds.length} finding(s), ${r.testbench.manualSourceIds.length} manual test(s)`);
  for (const w of r.testbench.warnings) console.log(`testbench warning: ${w}`);
  for (const e of r.testbench.errors) console.log(`testbench error: ${e}`);
  if (!r.testbench.ok) {
    console.log("Testbench would NOT accept the export.");
    process.exit(1);
  }
  console.log("Testbench would accept the export. Nothing was delivered.");
} catch (e) {
  if (e instanceof ExportError || e instanceof ContractError) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
