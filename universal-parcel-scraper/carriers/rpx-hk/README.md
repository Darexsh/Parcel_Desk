# RPX Online

RPX Online parcels use enabled universal providers. There is no dedicated adapter.

RPX is Hong Kong Lenton Group’s eCommerce parcel operation. Its tracker shares an app and
backend with DPD Hong Kong, Hub-ez and Linex; access to that backend does not establish which
operation owns a shipment.

## Retrieval

The [public tracker](https://tracking.rpxonline.com/) sends an anonymous JSON POST to
`https://apitracking.hub-ez.com/api/services/app/tracking/GetTrackingNew`. The body’s `para`
is JSON text containing `trackingNumber` and `hawbType`: `H` searches tracking numbers and
`C` searches customer references. The current request builder adds no session or verification
token and no RPX service filter. The reply’s `result` is JSON text containing shipment rows
and their scan histories.

The archived samples establish RPX’s former service and its history layout. The current
service returns empty not-found rows for numbers with confirmed archived histories. Those
rows repeat the submitted number; the echo does not confirm shipment identity or carrier
ownership.

## Links

`tracking.rpxonline.com/?trackNo={number}` opens the tracker and submits a tracking-number
search; its script also reads `trackingNumber`. The former
`rpxonline.com/component/track/{number}` page is gone.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
