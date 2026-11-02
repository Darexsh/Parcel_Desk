# CPS Last Mile

CPS Last Mile parcels use enabled universal providers. There is no dedicated adapter.

CPS Last Mile is the last-mile delivery brand of CPS Logistics, a freight forwarder and customs
broker based in Guatemala. It delivers Temu orders and other purchases from abroad across Guatemala.
Its site is cpslastmile.com.

## Numbers

Its tracker takes letters and digits and gives no layout or example. No public number is known, so
there is no rule.

## Why there is no adapter

The tracker asks an open JSON service on cpxbox.com without a login or CAPTCHA, which answers an
unknown number with an empty not-found reply or a server error. Its reply also carries the
recipient's name, address and phone number, which an adapter would leave out. No public number has
shown a known parcel's reply yet. An adapter can follow.

## Links

Tracking links carry the number in the path after `/wr/` on the tracker.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
