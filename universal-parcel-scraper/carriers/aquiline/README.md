# Aquiline

Tracks parcels of Aquiline, now AQ Tracking on aq-track.com, which gives marketplace sellers its
own number for parcels that Amazon delivers in the United States and shows Amazon's scans under
it. Buyers get these numbers instead of Amazon's.

## How it works

1. `direct`: one POST of `{"data":{"input":"<number>"}}` to the Firebase function
   `getTrackingStatus` that the tracker calls, which answers with the number, a summary status
   and Amazon's scans.
2. `retry`: the same read once more after a request fails to reach the function or hangs.

No account, key, cookie, CAPTCHA or browser is needed.

## Notes

- A number the tracker has nothing under comes back as a success with the status `Unknown` and
  no scans: not found. Another answer without scans is no answer.
- The summary status is not read: it can say `Error` over a parcel's scans. The parcel's stage is
  its newest staged scan.
- Scan times have no offset and are Amazon's, in UTC: an archived capture shows a link to one
  parcel opened at 00:09 UTC on a label created at 22:49 the evening before, a clock that would
  come later in any US zone. The shipper's handover comes at midnight and keeps its day alone.
- The shipper's facility can be given by its street address. Parts with a digit, postcodes and
  streets, are dropped from places, and a part given twice is kept once.

## Limitations

The reply names no service, Amazon number or event code. Amazon's wording is staged by the
shared rules, apart from the handover and the carrier delay the status map lists.

## Numbers

Its tracker accepts AQUAA, ten digits and YQ. A customer review and archived lookups on its own
tracker show such numbers. They come from two sources, so the rule is low, and recognition asks
the tracker.

## Links

The tracker opens a number from its path or from its `track` parameter, on both its current and
its former domain.

## Testing

`npm run test:carriers:live -- carriers/aquiline`, with `AQUILINE_TRACKING_NUMBER` and optionally
`AQUILINE_UNKNOWN_NUMBER` set outside the repository.
