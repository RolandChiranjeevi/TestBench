---
name: testpilot-deliver
description: Transform a validated TestPilot audit package and import it into TestBench after explicit user confirmation. Use when the user invokes /testpilot-deliver or asks to deliver an audit package.
---

# TestPilot: deliver

Transform a validated audit package and import it into TestBench, after explicit
user confirmation. Dry-run first, then the real import.

Input:
- audit ID (required), for example `AUD-20261105-01`

Paths in this file are relative to this file. The contract is
`../../references/audit-contract.md`.

Before starting, read:
- `../testpilot/SKILL.md`
- `../../references/audit-contract.md`

Apply the shared boundaries, secret-handling rules and stop conditions.
Execute only this delivery workflow. Do not start the full audit.

## Rules that apply to every step

- Never print, log, echo or store the password or the session cookie. Do not use
  `set -x`, `curl -v` or `--trace`. Do not put the password on a command line.
- Never write the password or cookie into `manifest.json`, the report, evidence
  or any other file in the repository.
- Stop at the first failed step. Do not retry after a 401 or 429.
- Run no real import before the user has confirmed in a separate message.
- Each Bash call is a fresh shell. Repeat the setup block in every call that
  talks to TestBench.

## Required environment

`TESTBENCH_PASSWORD` holds the TestBench login password. Do not ask the user for
the value. If it is missing, stop and remind them to set it.

Example `.env` (`.env` is listed in `.gitignore`; keep it that way and never
commit it):

```text
TESTBENCH_PASSWORD=<the TestBench login password>
```

TestBench's audit-import route accepts a login session only. A Bearer API token
(`TESTBENCH_API_TOKEN`) is not accepted for it (agent tokens only read
requirements), so this command logs in with the password instead.

## Steps

### 1. Read the configuration

Read:

1. `config/testbench.json`
2. The project profile referenced by `activeProject`

Use from the global configuration:

- `baseUrl`

Use from the project profile:

- `projectId`
- `projectKey`
- `tokenEnvVar`
- `deliveryEnabled`

Rules:

- Do not read project-specific values from the global configuration.
- Do not store token values, passwords, cookies or target URLs in configuration.
- If the active profile is missing, invalid or unreadable, pause and ask the user.
- `deliveryEnabled` in the project profile is authoritative.
- If `deliveryEnabled` is false, stop and say delivery is disabled.
- `deliveryPath` is ignored on purpose. The endpoint is built as
  `{baseUrl}/api/projects/{projectId}/audit-import`.
- `tokenEnvVar` is not used by this command.
- Optional `passwordEnvVar`: name of the environment variable that holds the
  password. Default `TESTBENCH_PASSWORD` (hardcoded default; the config has no
  such field today).

Never hardcode the project ID. If a required field is missing, ask the user.

Refuse a `baseUrl` that uses plain `http` unless the host is `localhost`,
`127.0.0.1` or `[::1]`. The password must not cross a network unencrypted.

### 2. Check the package is validated

Read `<audit-id>/manifest.json`. If `validation.result` is not `"pass"`, stop and
show `validation.errors`. Do not build or upload anything.

### 3. Build the TestBench package

```bash
python3 tools/build_testbench_package.py <audit-id> <projectKey>
```

This writes `<audit-id>-testbench.zip` in the repository root. Stop if the
command fails or the zip is missing. Show its one-line summary (evidence files,
bugs, manual tests).

### 4. Dry-run

Use this block, with `AUD` set to the audit ID. It reads the config, logs in with
the password, uploads the zip with `dryRun=1` and writes the response to a private
temporary directory that is removed on exit. It prints only HTTP status codes.

Run it through `bash` (`bash <<'SH' ... SH`), because the interactive shell may be
zsh. Do NOT `source` or `eval` `.env`: a password may contain characters such as
`&` that the shell would interpret. Python reads the password from the
environment, or else from the raw `.env` line, and never puts it on a command line
or in the output.

```bash
bash <<'SH'
set -uo pipefail; umask 077
AUD="<audit-id>"
eval "$(python3 -I - <<'PY'
import json, shlex
g = json.load(open('config/testbench.json'))
p = json.load(open(f"config/projects/{g['activeProject']}.json"))
for k, v in (('BASE', g['baseUrl'].rstrip('/')), ('PID', str(p['projectId'])),
             ('PWVAR', p.get('passwordEnvVar', 'TESTBENCH_PASSWORD'))):
    print(f"{k}={shlex.quote(v)}")
PY
)"
case "$BASE" in http://localhost*|http://127.0.0.1*|http://\[::1\]*|[https://*](https://*)) ;;
  *) echo "Refusing plain http to a non-local host"; exit 1;; esac
[ -f "${AUD}-testbench.zip" ] || { echo "zip missing"; exit 1; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT


# Builds the login JSON. Never prints it.
BODY_PY='
import json, os, sys
name = os.environ["PWVAR"]; pw = os.environ.get(name)
if not pw and os.path.isfile(".env"):
    for line in open(".env", encoding="utf-8"):
        line = line.rstrip("\n")
        if line.startswith(name + "="):
            pw = line[len(name) + 1:]
            if len(pw) >= 2 and pw == pw[-1] and pw in "\"\x27": pw = pw[1:-1]
if not pw: sys.stderr.write("password variable not set\n"); sys.exit(2)
print(json.dumps({"password": pw}))
'
LOGIN=$(PWVAR="$PWVAR" python3 -I -c "$BODY_PY" \
 | curl -sS -o "$WORK/login.json" -w '%{http_code}' -c "$WORK/jar" -X POST \
     -H 'Content-Type: application/json' -H 'X-Testbench: 1' \
     --data-binary @- "$BASE/api/login") || { echo "login step failed"; exit 1; }
echo "login HTTP $LOGIN"
if [ "$LOGIN" != "200" ]; then
  python3 -I -c "import json;print('login error:',json.load(open('$WORK/login.json')).get('error'))" 2>/dev/null
  exit 1
fi


# Dry-run upload. The multipart field name is ignored by the server;
# the file name must end in .zip.
DRY=$(curl -sS -o "$WORK/dry.json" -w '%{http_code}' -b "$WORK/jar" -H 'X-Testbench: 1' \
  -F "file=@${AUD}-testbench.zip;type=application/zip" \
  "$BASE/api/projects/$PID/audit-import?dryRun=1")
echo "dry-run HTTP $DRY"
python3 -I - "$WORK/dry.json" "$DRY" <<'PY'
import json, sys
r = json.load(open(sys.argv))[1]
if sys.argv != "200":[2]
    print("ERROR:", r.get("error", r)); sys.exit(1)
a = r["audit"]; mt = r["manualTests"]
print(f"audit: {a['agentAuditId']} | isNew={a['isNew']} | auditId={r['auditId']} | dryRun={r['dryRun']}")
print("bugs counts:", r["counts"])
print("manual tests:", mt["counts"], "unresolved", mt["unresolvedRefs"])
print("evidence:", r["evidence"])
print("unresolvedRefs (bugs):", r["unresolvedRefs"])
print("warnings:", r["warnings"])
for i in r["items"]:
    print(f"  {i['sourceId']:<8} {i['action']:<9} sev={i['severity']} unresolved={i['unresolvedRefs']} evProblems={i['evidenceProblems']} | {i['title'][:60]}")
for i in mt["items"]:
    print(f"  {i['sourceId']:<8} {i['action']:<9} unresolved={i['unresolvedRefs']}")
PY
SH
```

The block stops on its own at a failed login and prints the server's error.
Meaning of the login code:

- 200: continue
- 401: wrong password. Stop. Do not retry.
- 429: too many wrong passwords. Stop and show the wait time. Do not retry.
- 403: missing `X-Testbench` header or forbidden host. Stop and show the error.


If the dry-run HTTP code is not 200, show the `error` field of the response
(HTTP 400 includes a reason, for example "not a readable zip file") and stop.


### 5. Show the dry-run result

Print only these fields of the response (never the cookie):


- `audit.agentAuditId`, `audit.title`, `audit.isNew`, `auditId`
- bugs: `counts.new`, `counts.unchanged`, `counts.updated`, `counts.pending`
- manual tests: `manualTests.listed` and `manualTests.counts`
- `evidence.ok` and `evidence.problems`
- `unresolvedRefs` and `manualTests.unresolvedRefs`
- `warnings[]`
- `items[]`: `sourceId`, `action`, `severity`, `unresolvedRefs`,
  `evidenceProblems`


Errors that cancel delivery: any non-200 response, or `evidence.problems > 0`.
Show them and stop. Do not run the real import.


Unresolved references and warnings do not cancel delivery by themselves, but
state them clearly in the confirmation question.


### 6. Stop and ask for confirmation

Summarise the target (`{baseUrl}`, project `{projectId}`), the audit ID and the
dry-run counts. Ask the user for explicit confirmation to run the real import.


Do not continue until the user answers yes in a new message. Anything else,
including silence, means no. If the answer is no, record nothing in
`manifest.delivery` and stop.


### 7. Real import

Repeat the setup and login from step 4 in a new Bash call, then upload without
`dryRun`:


```bash
curl -sS -o "$WORK/import.json" -w 'import HTTP %{http_code}\n' \
  -b "$WORK/jar" -H 'X-Testbench: 1' \
  -F "file=@${AUD}-testbench.zip;type=application/zip" \
  "$BASE/api/projects/$PID/audit-import"
```


A 200 response with `dryRun: false` and a numeric `auditId` is the confirmation
of acceptance. Any other result is a failed delivery.


### 8. Record the result in `manifest.delivery`

Edit only the `delivery` object of `<audit-id>/manifest.json`. Keep all other
content. Keep the contract fields (section 5.7) and add `response_summary`.


On success:


```json
{
  "status": "delivered",
  "delivered_at": "<UTC ISO 8601 now>",
  "method": "http-post",
  "target": "<baseUrl>/api/projects/<projectId>/audit-import",
  "request_reference": "<audit-id>-testbench.zip",
  "response_reference": "auditId=<auditId from the response>",
  "error": null,
  "response_summary": {
    "http_status": 200,
    "is_new": true,
    "counts": { "new": 0, "unchanged": 0, "updated": 0, "pending": 0 },
    "manual_tests": { "new": 0, "unchanged": 0, "updated": 0, "pending": 0 },
    "evidence": { "ok": 0, "problems": 0 },
    "unresolved_refs": 0
  }
}
```


Use the real values from the response. On failure use `status: "failed"`,
`delivered_at: null`, a short `error` (HTTP status and the server's `error`
text) and `response_summary: null`.


`response_summary` holds counts only. Never put the password, cookie, response
headers or the raw response in the manifest.


### 9. Report

Tell the user the result, the `auditId` in TestBench and the final counts. Say
that package validation and TestBench acceptance are separate facts, and that
everything imported is `proposed` and awaits human review in TestBench.