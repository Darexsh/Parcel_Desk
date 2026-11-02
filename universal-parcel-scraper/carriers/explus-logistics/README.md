# ExPlus Logistics

ExPlus Logistics parcels use enabled universal providers. There is no dedicated adapter.

ExPlus Logistics Pvt. Ltd., in Bengaluru, is a customs broker and courier that sends imports and
exports for businesses and online sellers, runs a duty-paid line from China to India and takes
stock to Amazon's warehouses. It is an authorised service partner of DPD. Its sites are
expluslogistics.com and explus56.com.

## Numbers

Its tracker shows the number of the carrier that delivers the last leg, whose system supplies the
scans. No public page shows one of its numbers or states their layout, so there is no rule.

## Why there is no adapter

The tracker asks an open JSON service without a session, which answers an unknown number with a
made-up received event rather than not found, so an answer does not show that a number exists.
No public number has shown a known parcel's reply yet.

## Links

Tracking links carry the number as `trackings` on the tracker's result page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
