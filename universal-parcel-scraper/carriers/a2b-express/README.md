# A2B Express Logistics

A2B Express Logistics parcels use enabled universal providers. There is no dedicated adapter.

A2B Express Logistics, run by A2B Express Delivery d.o.o. in Sarajevo since 2008, is a courier and
logistics network in Bosnia and Herzegovina. It delivers express parcels across the country, runs
parcel lockers and forwards freight by air, sea and road. Its site is a2b.ba.

## Numbers

Its tracker takes a waybill number and gives no layout or example. No public page shows one, so
there is no rule.

## Why there is no adapter

The tracker is a plain page that reads the waybill number from its address, without a session,
CAPTCHA or postcode, and says when it has no data for a number. No public number has shown a known
parcel's reply yet. An adapter can follow.

## Links

Tracking links carry the number as `tracking_number` on the tracking page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
