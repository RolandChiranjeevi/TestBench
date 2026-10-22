# Security policy

Testbench holds test data that can be sensitive: product requirements, bug details, screenshots and traces that can contain real
accounts or customer data. Please report security problems privately so they can be fixed before they are public.

## Reporting a vulnerability

Use GitHub's private reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Please include:

- what you found and where (route, page or file),
- steps to reproduce it, ideally on a throwaway instance,
- what an attacker could do with it.

Please do not open a public issue or pull request for a vulnerability, and do not test against someone else's instance.

This is a small project with one maintainer. I will read reports and reply as soon as I can, but I cannot promise a response time
and there is no bounty. You will be credited in the fix unless you prefer not to be.

## Supported versions

Only the latest commit on `main` is supported. There are no long-lived release branches yet.

## What is in scope

- Bypassing the password login, or reaching data, uploaded files, reports or traces without signing in
- Reading or writing files outside the data folder (uploads, folder import, backup and restore)
- Cross-site scripting or request forgery that works against a signed-in user
- Leaking the password, session cookies, `GITHUB_TOKEN` or `TYPESAFE_API_KEY`
- Anything that lets a request reach other hosts through the server (server-side request forgery)

## What is not

- Running without a password on a network you do not control. Testbench refuses to do this unless you set `TESTBENCH_ALLOW_NO_AUTH=1`
  yourself, and that setting is only meant for a port published on this computer.
- Limits of the shared-password model that are described in the README (no individual users, no audit trail, no password reset)
- Slowing a server down by sending very large files or many requests to an instance you are allowed to use
- Known issues in a dependency that already has an upstream advisory and no available fix

## How the login is meant to work

With `TESTBENCH_PASSWORD` set, every page, API route, uploaded file and trace needs a session. A session is a signed cookie that expires
(default 7 days) and is `HttpOnly`, `SameSite=Strict` and `Secure` over HTTPS. The password is compared with scrypt in constant time,
and five wrong attempts from one address block it for 15 minutes. Changing the password signs everyone out.
There are no user accounts, so everyone who knows the password can see and change everything.

## If you host it for other people

- Set `TESTBENCH_PASSWORD` (a long passphrase), `TESTBENCH_ALLOWED_HOSTS` and, behind a proxy, `TESTBENCH_TRUST_PROXY=1`.
- Serve it over HTTPS only. Without it the password and session cookie can be read on the network.
- Keep the container port on `127.0.0.1` and let the reverse proxy reach it, or use a private network such as Tailscale.
- Keep copies of the data somewhere other than the same server, and test restoring one.
- Give `GITHUB_TOKEN` read-only access to the repositories you import from, and nothing else.
- Update when new commits land; there are no separate security releases yet.

Testbench has not had an independent security audit.
