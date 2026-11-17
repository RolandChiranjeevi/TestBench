/**
 * The rules for an own spec's file name and text, for the screen (instant feedback). The server (server/specs.ts) decides, and says the same: test/web-specs.test.ts holds the two together.
 * A flat file name of letters, digits, - and _ followed by exactly .spec.ts; a text of at most 200 kB (UTF-8) that is not empty.
 */
export const SPEC_NAME_MAX = 80;
export const SPEC_TEXT_MAX_BYTES = 200 * 1024;

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*\.spec\.ts$/;

/** What is wrong with a file name, in the server's words, or null when it is fine. */
export function specNameProblem(raw: string): string | null {
  const name = raw.trim();
  if (!name) return "Give the spec a file name, for example login.spec.ts";
  if (name.length > SPEC_NAME_MAX) return `The file name can be at most ${SPEC_NAME_MAX} characters`;
  if (/[\\/]/.test(name)) return "The file name cannot hold a folder: use a name like login.spec.ts, not e2e/login.spec.ts";
  if (!name.endsWith(".spec.ts")) return "The file name must end with .spec.ts";
  if (!NAME.test(name)) return "The file name can hold only letters, digits, - and _ before .spec.ts (no space, no other dot)";
  return null;
}

/** The bytes of a text in UTF-8, which is what the limit counts. */
export const textBytes = (s: string) => new TextEncoder().encode(s).length;

/** What is wrong with a spec's text, in the server's words, or null when it is fine. */
export function specTextProblem(text: string): string | null {
  if (!text.trim()) return "The spec needs its text";
  if (text.includes(String.fromCharCode(0))) return "The spec text cannot hold a NUL character";
  if (textBytes(text) > SPEC_TEXT_MAX_BYTES) return `The spec text can be at most ${SPEC_TEXT_MAX_BYTES / 1024} kB`;
  return null;
}

/** A size for a list: bytes under 1 kB, then kB with one decimal. */
export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`);
