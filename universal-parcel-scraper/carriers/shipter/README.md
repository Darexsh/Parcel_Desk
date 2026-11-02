# Shipter

Shipter parcels use enabled universal providers. There is no dedicated adapter.

Shipter is H3 Networks' cross-border shipping service from Korea, handing parcels to a delivery carrier in
the destination country. Its site is shipter.kr.

## Numbers

Its numbers are `H3`, the destination's country code, six digits and `KR`, which `shipter-1` suggests at
low confidence; the only public example is an archived lookup on its own tracker. The delivery carrier's
number stays with that carrier.

## Why there is no adapter

Its tracker reads an open JSON API without a session or CAPTCHA, which answers an unknown number with an
empty list. No adapter has been written for it yet.

## Links

The tracker takes the number in its path, on shipter.kr and on the older shiptertracking.com.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
