import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR } from "./db.ts";

/**
 * Keeps API tokens out of the database in readable form. A token is sealed with AES-256-GCM using a random key in a file of its own in
 * the data folder (owner only). Backups hold the database and the uploads but not that file, so a backup that is shared or restored
 * elsewhere does not carry usable tokens; the token has to be entered again there.
 */
const KEY_FILE = join(DATA_DIR, ".secret-key");

function key(): Buffer {
  if (!existsSync(KEY_FILE)) writeFileSync(KEY_FILE, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  chmodSync(KEY_FILE, 0o600);
  return Buffer.from(readFileSync(KEY_FILE, "utf8").trim(), "hex");
}

/** `v1:iv:tag:ciphertext`, all base64. */
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

/** The plain text, or null when it cannot be opened (another key, damaged, or not a sealed value). */
export function unseal(sealed: string | null | undefined): string | null {
  const parts = (sealed ?? "").split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(parts[1], "base64"));
    d.setAuthTag(Buffer.from(parts[2], "base64"));
    return Buffer.concat([d.update(Buffer.from(parts[3], "base64")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** What may be shown of a token: only its last four characters. */
export const tokenHint = (token: string) => (token.length > 8 ? `…${token.slice(-4)}` : "…");
