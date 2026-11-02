# Trexity

Trexity parcels use enabled universal providers. There is no dedicated adapter.

Trexity is a Canadian same-day delivery platform for local merchants, also in some US cities. Its
site is trexity.com.

## Numbers

Its tracking numbers are two groups of five letters and digits joined by a hyphen. Detection
drops the hyphen, and the ten characters left are a layout other carriers' rules take, so there
is no rule.

## Why there is no adapter

Its tracker's lookup answers anonymously only with a basic status; the map and proof of delivery
ask for the postcode and phone digits. No public number has been found to check a reply with.

## Links

The tracking page opens a number from its `t` parameter. Its token links and short links are
capabilities and are not read.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
