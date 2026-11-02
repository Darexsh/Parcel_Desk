# RPX

RPX is an Indonesian courier for domestic and international express parcels, with its own
stations across the country. Tracked through the lookup its Kiriman Express app makes for a
guest.

## How it works

1. `direct`: one `GET https://ke-api-admin-v2-x3ct6vzffa-et.a.run.app/rpx/tracking/{awb}`, as
   RPX's Kiriman Express app (`rpx.superapps.mobile`) sends it when a guest checks an AWB. It
   needs no cookie, token, key or browser. The JSON reply has the scans, newest first, and the
   delivery details.
2. `retry`: one more try when the request fails to reach the service or hangs. The first try
   gets half of the budget.

- An unknown number is HTTP 400 with RPX's own error inside `message`: "No data found. Please
  check your typing and try again". Another error there is inconclusive. A 404 or a redirect is
  a moved route.
- The service sometimes answers HTTP 500, "Internal server error", for every number, known or
  not, for long stretches. That reply is inconclusive.
- The reply does not name the AWB. The request names the whole AWB, so the adapter takes the
  reply as its answer.
- Recognition makes the same request.

## Notes

- RPX's tracking page asks for the last five digits of the recipient's phone number and a
  Cloudflare Turnstile check before it shows a parcel. The app's guest lookup asks for neither,
  so the adapter reads that instead.
- Each scan's `TRACKING_DATE` and `TRACKING_TIME` are the station's wall clock to the minute,
  with no zone. Indonesia spans three zones, so the clocks stay `local_time`.
- A scan's `TRACKING_ID` stages it; a code the map does not know goes to the shared wording
  rules. Stations are named after their place, as `RPX Cikarang`, and the place is kept. Scans
  before the pickup name no station.
- Each scan has a note that ends with the parcel's weight. The weight is taken from the newest
  note that gives one; the notes, which name consolidations and the system that made the scan,
  are not kept.
- The delivery details name the recipient, who took the parcel, the town, where the parcel was
  left, delivery photos and coordinates. None of that is kept. Their delivery estimate is kept
  while the parcel is on its way.

## Limitations

- No delivery time as an instant, sender or service name.
- Older AWBs drop out of the tracker, which then answers as for an unknown number.

## Numbers

RPX AWBs are twelve digits in its API documentation and on its corporate AWB print service.
Many carriers use twelve-digit waybills, so RPX has no rule. The samples and their sources are
in [`numbers.json`](numbers.json).

## Links

RPX's tracking page takes the AWB or a reference number in its `tracking_number[]` parameter,
then asks for the last five digits of the recipient's phone number and a security check before
it shows the history. Because of that step, the catalog has no address that opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/rpx-indonesia`, with `RPX_INDONESIA_TRACKING_NUMBER`
and optionally `RPX_INDONESIA_UNKNOWN_NUMBER` set outside the repository.
