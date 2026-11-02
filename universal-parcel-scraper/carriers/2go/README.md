# 2GO Express

2GO Express is the courier arm of 2GO Group, which carries documents and parcels across the
Philippines. Tracked through the lookup its tracker on `track.2go.com.ph` makes.

## How it works

1. `direct`: one `GET https://9or1cb84ae.execute-api.ap-southeast-1.amazonaws.com/prod/tracking/{number}`,
   the request the tracker's `/status/` page makes after decoding the number from its path. It
   needs no cookie, token, key or browser. The JSON reply lists the shipment's scans oldest
   first, each naming the number, and the references attached to the shipment.
2. `retry`: the same read once more when 2GO cannot be reached.

- A number the tracker holds neither as a shipment nor as an attachment gets HTTP 404 with its
  own `error` message, which is not found. Another 404 is a changed reply. API Gateway's 403
  `Missing Authentication Token` is a moved route; any other 403 is a block.
- A reference attached to a shipment gets `{"redirect":true,"trackingNumber":…}`, and the page
  opens that number next. The adapter follows it once, and keeps the answer only when the
  shipment lists the reference whole among its attachments. The result then names the
  shipment's number as its canonical number.
- Every scan must name the number asked, or the shipment a redirect named.
- Recognition makes the same request.

## Notes

- Each scan is a sentence without a code, such as `Parcel has arrived at MANILA HUB`. An
  arrival's hub is kept as the location.
- A scan's `timestamp` is a wall clock to the second, sometimes with microseconds, and names no
  zone, so it stays `local_time`.
- The adapter sends only 2GO's own number shapes, and binds a redirect to the shipment's
  attachment list rather than trusting it. The attached references are not kept.
- A delivery's wording loses who took the parcel, and every wording loses phone numbers.

## Limitations

- No estimate, weight, service or delivery time as an instant.
- The tracker holds recent shipments only, and answers older ones as not found. The API behind
  2GO's earlier tracking page, `expresscap.2go.com.ph/api/ttrace`, still answers some of them,
  with the receiver's name; the adapter does not read it.

## Numbers

2GO numbers are a capital letter, seven digits and a capital letter, the CN and document
numbers of its eTrace tracker that customers still receive. A low-confidence rule suggests 2GO
for that shape, and recognition asks the tracker whether it holds the number. 2GO Express also
issued air waybills made of AA and seven digits; the adapter reads them, but that shape has no
rule. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The library reads a number from the `tracking_no` query parameter of `/tracking` on
`express.2go.com.ph`, the older tracking page, which now forwards visitors to the 2GO Express
site. The current tracker encodes the number in Base64 inside its `/status/` path, so the
library reads no number from it.

## Testing

`npm run test:carriers:live -- carriers/2go`, with `TWOGO_TRACKING_NUMBER` and optionally
`TWOGO_UNKNOWN_NUMBER` set outside the repository.
