# Guide for a test agent: leaving an audit package for Testbench

This is for the agent (or the person writing the agent's instructions). The contract, with every rule and limit, is
[audit-package.md](audit-package.md); this guide only says how to work so that the package is accepted and so that a repeated audit
is recognised instead of duplicated. A complete, checked example of two runs of the same audit is in
[`examples/agent-audit-run/`](../examples/agent-audit-run/).

You never decide what happens to a finding. Everything you send is a **proposal**; a person accepts or rejects it in Testbench. Do not
write a `status`, and do not try to publish anything to Jira or Linear.

## The steps

1. Choose the **project key** of the Testbench project the findings belong to (for example `SHOP`). A package for any other key is refused whole.
2. Choose the **audit id** and a **sourceId** for each finding, by the rules in the next section.
3. Make a folder (any name) and write `manifest.json` (only the `audit` part), `bugs.json`, `report.md`, and put the evidence in `evidence/`.
4. Run the check, which also fills in the file list of the manifest:

   ```bash
   npm run audit:package -- path/to/folder --write
   ```

   Fix what it prints under `error:` and run it again. Do not hand-write `sha256` or `size`.
5. For a manual upload, add `--zip path/to/audit.zip` to the same command (it only writes the zip when the package checked out). The person then
   imports the zip, or the folder, under **Bug reports, Import audit package**, and sees a preview before anything is stored.
6. For a repeated audit, add `--previous path/to/earlier/folder` to the check. It lists which ids are the same, which are new and which are not repeated.

## Stable ids: how a repeat becomes a revision, not a duplicate

Testbench identifies a report by **project + `audit.id` + `sourceId`**. Nothing else is compared. So:

| | Rule |
|---|---|
| `audit.id` | Names **one audit**, not one run. Build it from things that do not change when you repeat the audit: project, scope and the period, for example `shop-checkout-2026-w45`. **Repeating or resuming that audit reuses the id exactly.** A new audit (next week, another scope) gets a new id. Never put a time, a counter, a random value, a commit sha or the GitHub run id in it. |
| `sourceId` | Names **one finding inside the audit**. Build it from what the finding is about: area and symptom as a lowercase slug, for example `cart-discount-total-zero`. Keep it when you improve the title, the steps or the evidence. Do **not** number findings (`BUG-001`): the numbers move when the order changes, and the same bug then arrives under another id. Letters, digits and `. _ : - /` only, at most 120 characters, unique in the package. |
| `fingerprint` | Names the **same bug across audits**. Use the same slug as the `sourceId`. When next week's audit finds the bug again, it gets a new `audit.id` but the same `fingerprint`, and Testbench points the two reports out to each other. |
| `audit.github` | Leave it out unless you really know the GitHub run. It is not part of the identity. |

What a repeat does in Testbench (details in [audit-package.md](audit-package.md#importing-the-same-thing-again)):

- Same audit id and same sourceId, **identical content**: nothing changes.
- Same ids, **changed content**, and a person has not touched the report yet: the report is updated and the older version is kept as a revision.
- Same ids, changed content, and a person has reviewed, edited or linked it: **their version stays**; yours waits as a newer version they can take or ignore.
- A finding that is **not repeated** is not removed. If it is fixed, say so in `report.md`.
- A finding whose `sourceId` you changed is a **new report**, and the old one stays. That is the mistake to avoid.

Keep a small file of your own between runs if that helps you (for example the audit id and the list of sourceIds you have used), so that a
repeat picks the same values. Testbench does not need that file; the `--previous` check is the safety net.

## manifest.json

Write only the `audit` object. The check adds `format`, `version`, `files` and `parts`.

```json
{
  "audit": {
    "id": "shop-checkout-2026-w45",
    "title": "Checkout audit, week 45",
    "startedAt": "2026-11-02T09:00:00Z",
    "finishedAt": "2026-11-02T09:40:00Z",
    "project": "SHOP",
    "agent": { "name": "checkout-audit-agent", "version": "0.4.0", "model": "claude" },
    "review": { "status": "self-reviewed", "method": "every finding reproduced a second time", "reviewer": "agent" }
  }
}
```

- Times are ISO 8601 with a zone, `2026-11-02T09:00:00Z`.
- `agent` and `review` describe where the findings came from. They are kept as information and never accept anything.
- `project` is the key of the project, exactly as Testbench shows it.

## bugs.json

```json
{ "version": 1, "bugs": [ { "sourceId": "cart-discount-total-zero", "title": "…" } ] }
```

Only `sourceId` and `title` are required, but write the rest; a person decides from it.

| Field | What to write |
|---|---|
| `title` | One line, what is wrong, at most 200 characters. |
| `description` | What happens and where. Plain text. |
| `steps` | The actions, one string each, so that someone else can repeat them. |
| `expected` / `actual` | One sentence each. |
| `environment`, `url` | Where you saw it (`staging`, the page address). |
| `toolImpact` | Only when a tool reported it: `{ "tool": "axe-core", "value": "serious", "ruleId": "label" }`. This is the tool's own word, kept apart from your severity. |
| `agentSeverity` | Your own judgement: `low`, `medium`, `high` or `critical`. The person sets theirs separately. |
| `confidence` | A number from 0 to 1. |
| `foundAt` | When you found it, ISO 8601. |
| `agentReview` | `{ "status", "method", "notes" }`: how sure you are and why (`confirmed` after two reproductions, `unconfirmed` after one scan). Information only. |
| `fingerprint` | See above. |
| `refs` | `requirements` (`REQ-2`), `cases` (the project's own key, `SHOP-6`), `tests` (an automated test's full name). They are looked up only in the project you import into. A reference that is not found is shown as unresolved, so only write references you have seen; never guess a number. |
| `evidence` | `{ "path": "evidence/name.png", "label": "what it shows" }`, at most 20 per finding. |

Do not add `status`, `accepted` or similar; they are ignored. Do not put markup you want rendered anywhere: all text is shown as plain text.

## report.md

Your own readable account of the audit: scope, what was checked, what was found, what was not checked, and (on a repeat) what changed since the
last run. Plain Markdown, at most 5 MB. It is stored and shown as text. Refer to findings by their `sourceId`.

## evidence/

- Put every file a finding points to under `evidence/`, and refer to it by that path (`evidence/discount-total.png`).
- Allowed types: png, jpg, gif, webp, pdf, txt, log, md, csv, json, zip, mp4, webm. **Not** svg or html (they could run scripts).
- At most 50 MB per file, 200 findings and 1000 files per package.
- Do not use `..`, absolute paths or empty path parts.
- A file that no finding points to is not stored. Leave out what is not evidence.
- Never put secrets, tokens or personal data in evidence. A screenshot of a logged-in page can show more than you meant.

## What not to do

- Do not put test results (`results/`) or test cases (`cases.json`) in the package. They are not imported from a package; the preview warns if they are present.
- Do not change `audit.id` between repeats of the same audit, and do not renumber `sourceId`s.
- Do not edit `manifest.json`'s `files` by hand, or edit an evidence file after running the check without running it again.
- Do not put the package in a folder inside the package, or add a second `manifest.json`.

## Short instruction you can give the agent

> At the end of the audit, write an audit package for Testbench project `<KEY>` into `<folder>` as described in docs/agent-audit-guide.md.
> Use the audit id `<audit-id>` (reuse it exactly when repeating this audit). Give each finding a `sourceId` that is a lowercase slug of
> area and symptom, never a running number, and use the same slug as its `fingerprint`. Write manifest.json (audit part only), bugs.json,
> report.md and put evidence in evidence/. Then run `npm run audit:package -- <folder> --write --previous <earlier-folder>` and fix every
> error. Do not write a status for any finding.
