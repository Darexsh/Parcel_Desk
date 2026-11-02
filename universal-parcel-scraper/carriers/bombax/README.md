# Bombax

Bombax parcels use enabled universal providers. There is no dedicated adapter.

Bombax Logistics is an Indian courier offering same-day, air and surface delivery. Its site is
bombax.in.

## Numbers

Its site gives no number layout and no public page shows a Bombax number, so there is no rule.

## Why there is no adapter

The tracking form carries a reCAPTCHA, but the results page it opens answers
`GET book.bombax.in/booking/Tracking?OrderNo=` without one. An unknown number gets a notice that
no order was found. No public number is known to see a found reply, and the form's CAPTCHA
suggests the carrier means to gate lookups.

## Links

The results page opens the number from its `OrderNo` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
