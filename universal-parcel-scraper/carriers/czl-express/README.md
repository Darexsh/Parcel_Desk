# CZL Express

CZL Express parcels use enabled universal providers. There is no dedicated adapter.

CZL Express (苍正国际物流), based in Shanghai, books international express with DHL, UPS, FedEx
and SF Express and runs its own duty-paid and duty-unpaid lines on its own transport system. Its
site is exp.czl.net.

## Numbers

Shipments it books with an express carrier get that carrier's number once they reach its
warehouse, and those carriers' rules read them. No public page shows a number of its own lines
or states their layout, so there is no rule.

## Why there is no adapter

The tracker asks an open JSON service without a session, which takes several numbers at once and
answers an unknown one with no scans. No public number has shown a known parcel's reply yet. An
adapter can follow.

## Links

Tracking links carry the number as `query` on the tracking page or the tracker it embeds.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
