# CkeEx

CkeEx parcels use enabled universal providers. There is no dedicated adapter.

CkeEx (希凯易), run by Zhejiang CKEEX International Freight Forwarding, founded in Shaoxing in
1998, sends express parcels and air freight from China through its branches in East China and
stations abroad, and resells FedEx and other carriers' services. Its site is ckeex.com.

## Numbers

Its tracker takes its own waybill numbers and shows the FedEx number of shipments it hands to
FedEx. No public page shows one of its own numbers or states their layout, so there is no rule.

## Why there is no adapter

The tracker asks an open JSON service without a session, which answers several numbers at once.
No public number has shown a known shipment's reply yet. An adapter can follow.

## Links

Tracking links carry the number as `nos` on the tracking page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
