# Example checkout audit

Scope: cart, discount codes and checkout on the staging site. Time spent: about 40 minutes of exploration.

## What was checked
- Adding and removing products, changing quantities
- Discount codes (SAVE10)
- The checkout form with a keyboard and with axe-core

## Findings
1. **BUG-001** The order total becomes 0 kr after a discount code (reproduced twice).
2. **BUG-002** The card number field has no accessible name (single automated scan, not confirmed by hand).
3. **BUG-003** Typo in the confirmation email subject.

This text is the agent's own report. Testbench shows it as plain text and does not act on it.
