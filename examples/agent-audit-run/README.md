# Two runs of the same audit

What a test agent leaves behind when it follows [docs/agent-audit-guide.md](../../docs/agent-audit-guide.md), twice. It is for the demo
project (`SHOP`). Every file was produced and checked with `npm run audit:package -- <folder> --write`.

| | `run-1/` (Monday) | `run-2/` (Wednesday, after a deploy) |
|---|---|---|
| `audit.id` | `shop-checkout-2026-w45` | **the same** |
| `cart-discount-total-zero` | first description | narrower description, one more revision |
| `checkout-card-field-no-label` | found | repeated, unchanged |
| `confirmation-email-subject-typo` | found | fixed, so not repeated (the report stays in Testbench) |
| `checkout-coupon-field-clears-on-error` | | new |

Try it: import `run-1` under **Bug reports, Import audit package**, then `run-2`. The second import shows 1 new, 1 unchanged and 1 updated
(or 1 waiting, if you have accepted that finding in between). Compare them before importing with:

```bash
npm run audit:package -- examples/agent-audit-run/run-2 --previous examples/agent-audit-run/run-1
```

To get a zip for the upload: `npm run audit:package -- examples/agent-audit-run/run-1 --write --zip /tmp/run-1.zip`
(this rewrites `manifest.json` with the same content it already has).

For your own project, copy a run, change `audit.project` to your project's key, and write your own findings. Keep the audit id for a repeat
of the same audit, and keep every `sourceId`.
