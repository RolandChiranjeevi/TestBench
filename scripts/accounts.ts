// Accounts from the command line, on the server that runs Testbench. This is the way in when nobody can sign in: a new installation that is not reachable from
// this computer, an owner who lost the password, or a backup restored over an installation that had accounts.
//
//   npm run accounts -- create-owner --email anna@example.com --name "Anna Berg"
//   npm run accounts -- reset-password --email anna@example.com
//   npm run accounts -- list
//
// The password is never an argument (it would show in the process list and the shell history): it is typed at a prompt, or piped in on standard input.
// In Docker:  docker compose exec testbench npm run accounts -- create-owner --email ...
import { createInterface } from "node:readline";
import { accountsState, AccountError, createFirstOwner, listUsers, resetPasswordFromCli } from "../server/accounts.ts";

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

/** One line from standard input, or a prompt that does not echo when standard input is a terminal. */
function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return (async () => {
      let data = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) data += chunk;
      return data.split(/\r?\n/)[0] ?? "";
    })();
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void };
    let asked = false;
    out._writeToOutput = (s: string) => { if (!asked) { asked = true; process.stdout.write(s); } };
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
  });
}

async function main() {
  if (command === "list") {
    const users = listUsers();
    console.log(`State: ${accountsState()}. ${users.length} account${users.length === 1 ? "" : "s"}.`);
    for (const u of users) console.log(`  ${u.id}  ${u.email}  ${u.name}${u.isOwner ? "  (owner)" : ""}${u.disabledAt ? "  (turned off)" : ""}`);
    return;
  }
  if (command === "create-owner") {
    const email = flag("email");
    if (!email) throw new AccountError(400, "Give the email address: --email anna@example.com");
    const password = await readPassword("Password for the owner (at least 10 characters): ");
    const user = createFirstOwner({ email, name: flag("name"), password }, { label: "cli" }, { allowLocked: true });
    console.log(`Made the owner ${user.email} (${user.name}). Open Testbench and sign in.`);
    return;
  }
  if (command === "reset-password") {
    const email = flag("email");
    if (!email) throw new AccountError(400, "Give the email address: --email anna@example.com");
    const password = await readPassword("New password (at least 10 characters): ");
    const user = resetPasswordFromCli(email, password);
    console.log(`The password of ${user.email} is changed, and every session of that account has ended.`);
    return;
  }
  console.log("Usage:\n  npm run accounts -- create-owner --email <email> [--name <name>]\n  npm run accounts -- reset-password --email <email>\n  npm run accounts -- list");
  process.exitCode = command ? 2 : 0;
}

main().catch((e) => {
  console.error(e instanceof AccountError ? e.message : e);
  process.exit(1);
});
