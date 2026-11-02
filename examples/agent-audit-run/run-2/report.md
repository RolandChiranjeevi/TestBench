# Checkout audit, week 45 (second run, Wednesday)

Same audit, repeated after the Tuesday deploy. The audit id is the same as on Monday, so Testbench treats this as a newer version of the same reports.

## What changed since the first run
- `cart-discount-total-zero`: still there, and now narrowed down: it only happens with two or more products in the cart.
- `confirmation-email-subject-typo`: fixed in the deploy. It is not repeated below.
- `checkout-coupon-field-clears-on-error`: new.
- `checkout-card-field-no-label`: unchanged.

## Findings in this package
`cart-discount-total-zero`, `checkout-card-field-no-label`, `checkout-coupon-field-clears-on-error`.

This text is the agent's own report. Testbench shows it as plain text and does not act on it.
