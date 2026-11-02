# GOFO Italy

Tracks the Italian GOFO network, including its CIRRO Parcel waybills, through
the official anonymous JSON service. Other GOFO national services have separate
carrier ids.

## How it works

One bounded `POST /it/open-api/official/track/queryTrackV2` submits `numberList`
with the Italian `lang` header, as the official
[tracking client](https://www.gofo.com/it/tracking-results/) does. No token,
session or browser is needed. HTTP recognition uses the same identity checks.

The whole requested identifier must match one record's national waybill or its
explicitly paired reference, with an Italian destination. The
[customer support page](https://www.gofo.com/it/contact-us/) describes the
national identifier families. A different GOFO-owned identifier is rejected
instead of treated as a shipper reference. A missing or free-text shipper
reference leaves the waybill to bind its record.

## Notes

The latest summary must match the first scan. The client renders the list in
its returned order; equal and unresolved clocks keep that order. Explicit
offsets are preserved, and offset-free clocks remain local. A hub named by its code, its
province's two letters and its own (`FI-ARS`) or `GOFO-` and the province's (`GOFO-NA`), is no
town, nor is the country alone, so such a scan has no place. A larger event
counter or the output cap marks history incomplete so enabled providers can
complete it.

Stages follow operation codes, with explicit failed-delivery wording refining
the alert category to a failed attempt. Delivery requires affirmative wording.
Preparing a parcel does not mean the carrier has received it. A return to the
sorting centre after a delivery problem is an exception; the client's return
category establishes a return to the sender. The service name is retained as
the carrier supplies it.

## Limitations

An empty result, or a parcel listed without scans, is a `NoHistoryError`: GOFO
answers a label not yet scanned and one it never issued alike, so it stays
inconclusive rather than not-found. Proof images, recipient verification,
detailed delivery prose and unrelated references are excluded. Weight has no
verified unit, and estimates have no verified active-parcel provenance.

## Live test

Set `GOFO_IT_TRACKING_NUMBER` outside Git and run
`npm run test:carriers:live -- carriers/gofo-it/adapter.live.test.ts`.
Optionally set `GOFO_IT_UNKNOWN_NUMBER` to check an inconclusive empty response.
