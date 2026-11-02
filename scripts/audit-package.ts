// Checks an audit package folder with the same code the import uses, and fills in the file list of its manifest.
//   npm run audit:package -- <folder> [--write] [--previous <folder>] [--zip <file.zip>]
// Exit code 0: the package would be accepted. 1: it would be refused, or a file in it would be dropped. 2: wrong usage.
import { resolve } from "node:path";
import { checkPackageDir, zipPackageDir } from "../server/importers/auditbuild.ts";

const args = process.argv.slice(2);
const take = (flag: string) => {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, v && !v.startsWith("--") ? 2 : 1);
  return v && !v.startsWith("--") ? v : "";
};
const write = args.includes("--write");
if (write) args.splice(args.indexOf("--write"), 1);
const previous = take("--previous");
const zip = take("--zip");
const dir = args[0];
if (!dir || args.length > 1 || previous === "" || zip === "") {
  console.error("Usage: npm run audit:package -- <folder> [--write] [--previous <folder>] [--zip <file.zip>]");
  process.exit(2);
}

const r = checkPackageDir(resolve(dir), { write, previousDir: previous ? resolve(previous) : undefined });
if (r.auditId) console.log(`Audit ${r.auditId} for project ${r.project}: ${r.sourceIds.length} finding${r.sourceIds.length === 1 ? "" : "s"} (${r.sourceIds.join(", ") || "none"})`);
if (r.compared) {
  console.log(`Compared with ${r.compared.previousAuditId}: ${r.compared.same.length} same, ${r.compared.added.length} new${r.compared.added.length ? ` (${r.compared.added.join(", ")})` : ""}, ${r.compared.missing.length} not repeated`);
}
for (const w of r.warnings) console.log(`warning: ${w}`);
for (const e of r.errors) console.log(`error: ${e}`);
if (!r.ok) {
  console.log("The package would NOT be accepted.");
  process.exit(1);
}
if (write) console.log("manifest.json updated with the current file list.");
else console.log("The package would be accepted. (Nothing was written; add --write to fill in the manifest's file list.)");
if (zip) {
  if (!write) {
    console.error("--zip needs --write, so that the zip holds a manifest that matches the files.");
    process.exit(2);
  }
  console.log(`Wrote ${resolve(zip)} (${zipPackageDir(resolve(dir), resolve(zip))} bytes). Upload it under Bug reports, Import audit package.`);
}
