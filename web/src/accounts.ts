/**
 * Small helpers for the account screens (/account and, later, /admin): plain functions with no React, so they can be tested on their own.
 * The server decides in the end. What is here only helps a person on the way: a readable name for a device, and the password rules told before the form is sent.
 */

/** "Chrome on macOS", read out of a browser's user-agent text. Anything not recognised is said plainly, never guessed at. */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").trim();
  if (!ua) return "Unknown device";
  const tool = /^(curl|wget|node|python-requests|okhttp)\b/i.exec(ua);
  if (tool) return tool[1].toLowerCase() === "node" ? "Node.js" : tool[1].toLowerCase();
  const browser =
    /\bEdg(?:e|A|iOS)?\//.test(ua) ? "Edge"
    : /\bOPR\//.test(ua) ? "Opera"
    : /\b(?:Chrome|CriOS)\//.test(ua) ? "Chrome"
    : /\b(?:Firefox|FxiOS)\//.test(ua) ? "Firefox"
    : /\bSafari\//.test(ua) ? "Safari"
    : null;
  const system =
    /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /CrOS/.test(ua) ? "ChromeOS"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /Linux|X11/.test(ua) ? "Linux"
    : null;
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? "Unknown device";
}

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 1024;

/** The rules, as a list a person can read before typing. They are the server's rules (test/web-accounts.test.ts keeps the two from drifting apart). */
export const PASSWORD_RULES = [
  `At least ${PASSWORD_MIN} characters`,
  "Not only spaces, and more than two different characters",
  "Not your email address or your name",
] as const;

/** The first rule a new password breaks, in the server's words, or null. Only a hint: the server checks again. */
export function passwordProblem(password: string, who: { email?: string; name?: string } = {}): string | null {
  if (password.length < PASSWORD_MIN) return `The password must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `The password can be at most ${PASSWORD_MAX} characters`;
  if (!password.trim()) return "The password cannot be only spaces";
  if (new Set(password).size < 3) return "The password is too simple: use more than two different characters";
  const lower = password.toLowerCase();
  if ((who.email && lower === who.email.toLowerCase()) || (who.name && lower === who.name.trim().toLowerCase())) return "The password cannot be your email or your name";
  return null;
}

/** What the form needs to know before it sends: the problem to show, or null when it can go. */
export function passwordFormProblem(f: { current: string; next: string; again: string }, who: { email?: string; name?: string }): string | null {
  if (!f.current) return "Type your current password";
  if (f.next !== f.again) return "The two new passwords are not the same";
  if (f.next === f.current) return "The new password is the same as the current one";
  return passwordProblem(f.next, who);
}
