# GOFO Netherlands

Tracks the Dutch GOFO network, formerly CIRRO Parcel, through the official
anonymous JSON service. Other GOFO national services have separate carrier ids.

## How it works

One bounded `POST /nl/open-api/official/track/queryTrackV2` submits `numberList`
with the Dutch `lang` header, as the official
[tracking client](https://www.gofo.com/nl/tracking-results/) does. No token,
session or browser is needed. HTTP recognition uses the same identity checks.
The adapter shares the French and Italian regional client.

The whole requested identifier must match one record's national waybill or its
explicitly paired reference, with a Dutch destination. The
[customer support page](https://www.gofo.com/nl/contact-us/) says tracking
numbers start `CINL` or `GFNL`, followed by 13 or 14 digits.

## Notes

The latest summary must match the first scan. Explicit offsets are preserved,
and offset-free clocks remain local. A larger event counter or the output cap
marks history incomplete so enabled providers can complete it.

Stages follow operation codes, and delivery requires affirmative wording.
"Zending nog niet ontvangen of verwerkt" means the sender announced the parcel
and GOFO has not received it yet. The client groups failed deliveries with its
other alerts, and no Dutch failed-delivery wording has been seen, so those
alerts stay exceptions. The client's return category establishes a return to
the sender.

## Limitations

An empty result, or a parcel listed without scans, is a `NoHistoryError`: GOFO
answers a label not yet scanned and one it never issued alike, so it stays
inconclusive rather than not-found. Dutch scans carry no location. Proof images,
recipient verification, detailed delivery prose and unrelated references are
excluded.

## Live test

Set `GOFO_NL_TRACKING_NUMBER` outside Git and run
`npm run test:carriers:live -- carriers/gofo-nl/adapter.live.test.ts`.
Optionally set `GOFO_NL_UNKNOWN_NUMBER` to check an inconclusive empty response.
