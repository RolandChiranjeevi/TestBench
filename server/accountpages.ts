/**
 * The pages a person sees before they have a session: sign in, make the first account, accept an invitation, set a new password. Plain server-rendered HTML, like
 * the login page of the shared password, so they work without the app's scripts. Nothing from the server is put into the HTML: what a link says is fetched by the
 * page and set as text, so no value can become markup.
 */

export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const STYLE = `
  :root { color-scheme: dark light; --bg:#0b121a; --card:#111b26; --text:#eaf0f5; --muted:#9aaaba; --border:#25374a; --accent:#e78548; --on-accent:#0b121a; --err:#fb8383; }
  @media (prefers-color-scheme: light) { :root { --bg:#f1f0ea; --card:#fff; --text:#14202c; --muted:#485b6d; --border:#dddbd2; --accent:#b04a14; --on-accent:#fff; --err:#b42323; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text); font:14px/1.45 -apple-system, "Helvetica Neue", Arial, sans-serif; }
  form { width:min(380px, calc(100vw - 32px)); background:var(--card); border:1px solid var(--border); border-radius:10px; padding:24px; }
  h1 { margin:0 0 4px; font-size:18px; letter-spacing:-0.01em; }
  p { margin:0 0 16px; color:var(--muted); }
  label { display:block; margin:12px 0 6px; font-weight:500; }
  input { width:100%; height:36px; padding:0 10px; border-radius:6px; border:1px solid var(--border); background:var(--bg); color:var(--text); font:inherit; }
  input:focus { outline:2px solid var(--accent); outline-offset:-1px; }
  input[readonly] { opacity:.75; }
  button { margin-top:16px; width:100%; height:36px; border:0; border-radius:6px; background:var(--accent); color:var(--on-accent); font:inherit; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.6; cursor:default; }
  small { display:block; margin-top:4px; color:var(--muted); }
  #err { min-height:20px; margin-top:10px; color:var(--err); font-size:13px; }
`;

const COMMON_JS = `
  const $ = (id) => document.getElementById(id);
  const err = $("err"), btn = $("b");
  const show = (m) => { err.textContent = m; };
  async function call(method, url, body) {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json", "X-Testbench": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }
  function samePassword() {
    if ($("p").value !== $("p2").value) { show("The two passwords are not the same."); return false; }
    return true;
  }
`;

function shell(title: string, heading: string, lead: string, fields: string, script: string, buttonText: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Testbench</title>
<style>${STYLE}</style></head>
<body>
<form id="f" novalidate>
  <h1>${heading}</h1>
  <p id="lead">${lead}</p>
  ${fields}
  <button id="b" type="submit">${buttonText}</button>
  <div id="err" role="alert"></div>
</form>
<script>${COMMON_JS}${script}</script>
</body></html>`;
}

const email = (autocomplete: string, readonly = false) => `<label for="e">Email</label><input id="e" name="email" type="email" autocomplete="${autocomplete}" required${readonly ? " readonly" : ""}>`;
const name = `<label for="n">Your name</label><input id="n" name="name" type="text" autocomplete="name" maxlength="80" required>`;
const newPassword = `<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="new-password" minlength="10" required><small>At least 10 characters.</small>
  <label for="p2">Password again</label><input id="p2" name="password2" type="password" autocomplete="new-password" required>`;

export const loginPage = () => shell("Sign in", "Testbench", "Sign in with your email and password.",
  `${email("username")}<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>`,
  `$("f").addEventListener("submit", async (e) => {
    e.preventDefault(); show(""); btn.disabled = true;
    try {
      const r = await call("POST", "/api/login", { email: $("e").value, password: $("p").value });
      if (r.ok) { location.href = "/"; return; }
      show(r.data.error || "Could not sign in.");
    } catch { show("Could not reach the server."); }
    btn.disabled = false;
  });
  $("e").focus();`, "Sign in");

/** The very first account. When the installation has a shared password, the page asks for it too: whoever can reach the server is not enough to take it over. */
export const setupPage = () => shell("Set up", "Set up Testbench", "Make the first account. It becomes the owner: it looks after the accounts, the backups and who may create projects.",
  `${name}${email("username")}${newPassword}<div id="sp" hidden><label for="sp-in">The current shared password</label><input id="sp-in" name="setupPassword" type="password" autocomplete="off"><small>This installation has a shared password. It is needed once, to make the first account.</small></div>`,
  `let need = false;
  call("GET", "/api/setup/status").then((r) => {
    if (!r.ok || !r.data.available) { show(r.data.reason || "Setup is not available."); btn.disabled = true; return; }
    need = !!r.data.needsSetupPassword; $("sp").hidden = !need;
  });
  $("f").addEventListener("submit", async (e) => {
    e.preventDefault(); show(""); if (!samePassword()) return; btn.disabled = true;
    try {
      const r = await call("POST", "/api/setup", { name: $("n").value, email: $("e").value, password: $("p").value, ...(need ? { setupPassword: $("sp-in").value } : {}) });
      if (r.ok) { location.href = "/"; return; }
      show(r.data.error || "Could not set up.");
    } catch { show("Could not reach the server."); }
    btn.disabled = false;
  });
  $("n").focus();`, "Create the owner account");

/** An invitation: the link carries a token, the page asks what it is for and lets the person make their own account. */
export const joinPage = () => shell("Join", "Join Testbench", "Checking your invitation…",
  `${name}${email("username")}${newPassword}`,
  `const token = location.pathname.split("/")[2] || "";
  $("f").hidden = false; btn.disabled = true;
  call("GET", "/api/join/" + encodeURIComponent(token)).then((r) => {
    if (!r.ok) { $("lead").textContent = r.data.error || "This invitation cannot be used."; for (const el of document.querySelectorAll("label, input, small, button")) el.hidden = true; return; }
    $("lead").textContent = r.data.invitedBy ? r.data.invitedBy + " invited you. Make your account." : "You are invited. Make your account.";
    if (r.data.email) { $("e").value = r.data.email; $("e").readOnly = true; }
    btn.disabled = false; $("n").focus();
  });
  $("f").addEventListener("submit", async (e) => {
    e.preventDefault(); show(""); if (!samePassword()) return; btn.disabled = true;
    try {
      const r = await call("POST", "/api/join/" + encodeURIComponent(token), { name: $("n").value, email: $("e").value, password: $("p").value });
      if (r.ok) { location.href = "/"; return; }
      show(r.data.error || "Could not make the account.");
    } catch { show("Could not reach the server."); }
    btn.disabled = false;
  });`, "Create my account");

/** A one-time link from the owner (there is no email): a new password, and every session of that account ends. */
export const resetPage = () => shell("New password", "Choose a new password", "Checking your link…",
  `${newPassword}`,
  `const token = location.pathname.split("/")[2] || "";
  btn.disabled = true;
  call("GET", "/api/reset/" + encodeURIComponent(token)).then((r) => {
    if (!r.ok) { $("lead").textContent = r.data.error || "This link cannot be used."; for (const el of document.querySelectorAll("label, input, small, button")) el.hidden = true; return; }
    $("lead").textContent = "Choose a new password for " + (r.data.email || "your account") + ".";
    btn.disabled = false; $("p").focus();
  });
  $("f").addEventListener("submit", async (e) => {
    e.preventDefault(); show(""); if (!samePassword()) return; btn.disabled = true;
    try {
      const r = await call("POST", "/api/reset/" + encodeURIComponent(token), { password: $("p").value });
      if (r.ok) { location.href = "/login"; return; }
      show(r.data.error || "Could not set the password.");
    } catch { show("Could not reach the server."); }
    btn.disabled = false;
  });`, "Set the password");
