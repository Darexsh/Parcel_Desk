# Svuum

Svuum parcels use enabled universal providers. There is no dedicated adapter.

Svuum (SVUUM Α.Ε.), a licensed postal operator in Aigaleo near Athens, delivers parcels and bulky
goods for online shops and retailers, mainly in Attica, with installation on delivery,
temperature-controlled deliveries for businesses and moves. Its site is svuum.gr.

## Numbers

Its tracker takes the order number the sending shop gives, which follows each shop's own scheme. No
public number is known, so there is no rule.

## Why there is no adapter

The tracker, on its delivery platform, asks an open JSON service with the number alone, without a
login or CAPTCHA, and answers an unknown number with an empty list. No public number has shown a
known order's reply yet. An adapter can follow.

## Links

Tracking links carry the number as `tracking_number` on the `track.html` page at live.svuum.com.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
