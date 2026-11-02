# Checkout audit, week 45 (first run, Monday)

Agent: checkout-audit-agent 0.4.0. Scope: cart, discount codes and the checkout form on the staging site.

## What was checked
- Adding products to the cart and applying SAVE10
- The checkout form, with axe-core and by reading the markup
- The confirmation email, in the mail catcher

## Findings
- `cart-discount-total-zero`: the total becomes 0 kr after a discount code (reproduced twice).
- `checkout-card-field-no-label`: the card number field has no accessible name (axe-core, confirmed in the markup).
- `confirmation-email-subject-typo`: "ordre" instead of "order".

This text is the agent's own report. Testbench shows it as plain text and does not act on it.
