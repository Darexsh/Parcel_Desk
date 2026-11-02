# GOFO Spain

Tracks the Spanish GOFO network, including its CIRRO Parcel waybills, through
the official anonymous JSON service. Other GOFO national services have separate
carrier ids.

## How it works

One bounded `POST /es/open-api/official/track/queryTrackV2` submits `numberList`
with the Spanish `lang` header, as the official
[tracking client](https://www.gofo.com/es/tracking-results/) does. No token,
session or browser is needed. HTTP recognition uses the same identity checks.
The adapter shares the French, Italian and Dutch regional client.

The whole requested identifier must match one record's national waybill or its
explicitly paired reference, with a Spanish destination. The
[customer support page](https://www.gofo.com/es/contact-us/) says tracking
numbers start `CIES` or `GFES`, followed by 13 or 14 digits.

## Notes

The latest summary must match the first scan. Explicit offsets are preserved,
and offset-free clocks remain local. A hub named `GOFO-` and its area's letters,
or the country alone, is no town, so such a scan has no place. A larger event
counter or the output cap marks history incomplete so enabled providers can
complete it.

Stages follow operation codes, and delivery requires affirmative wording.
"Pedido recibido" means the sender announced the parcel and GOFO is still
waiting for it. "Entrega fallida" is a failed attempt; the client's generic
alert category stays an exception. A return to the sorting centre after a
delivery problem is an exception; the client's return category establishes a
return to the sender. The service name is retained as the carrier supplies it.

## Limitations

An empty result, or a parcel listed without scans, is a `NoHistoryError`: GOFO
answers a label not yet scanned and one it never issued alike, so it stays
inconclusive rather than not-found. Proof images, recipient verification,
detailed delivery prose, failed-delivery reasons and unrelated references are
excluded. Weight has no verified unit, and estimates have no verified
active-parcel provenance.

## Live test

Set `GOFO_ES_TRACKING_NUMBER` outside Git and run
`npm run test:carriers:live -- carriers/gofo-es/adapter.live.test.ts`.
Optionally set `GOFO_ES_UNKNOWN_NUMBER` to check an inconclusive empty response.
