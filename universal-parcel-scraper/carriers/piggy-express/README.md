# Piggy Express

Piggy Express parcels use enabled universal providers. There is no dedicated adapter.

Piggy Express (PiggyExp, 小猪物流) is a Los Angeles last-mile e-commerce carrier serving the United
States and Canada; PiggyShip is its earlier brand. Its site is piggyexp.com.

## Numbers

No public tracking number has been found, so there is no rule.

## Why there is no adapter

Its tracker asks for the recipient's ZIP code with the number.

## Links

Tracker addresses on piggyexp.com and dsp-tracking.piggyship.com carry the number in their
`tracking` parameter, which the library reads. The catalog sends people to the search page, since
a lookup needs the ZIP code.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
