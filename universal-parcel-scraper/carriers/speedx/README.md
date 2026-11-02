# SpeedX

Tracks SpeedX's `SPX` numbers through the public tracking page, without an account, a key
or a browser.

## How it works

1. `direct`: `GET https://tracking.speedx.io/{number}` with the header `RSC: 1`. The page
   answers with its React Server Components rows (`text/x-component`) instead of HTML.
   The rows hold one shipment view whose `data` object carries the number and its events.
   An unknown number gets the same page with "No tracking information for {number} is
   available at this time" instead: not found, after one request.

## Notes

- The server answers any path, malformed numbers included, so the shape is checked first.
- `data.trackingNumber` must equal the requested number, and the unknown-number sentence
  must name it. Two different shipment objects, or a shipment next to that sentence, are a
  changed page. Every page also carries Next's generic "404: This page could not be found"
  template; it says nothing about the number and is never read.
- Rows end only at a line feed, because Flight leaves U+2028 and U+2029 raw inside strings.
- An empty reply, or an error row where the view should be (the page failed while the server
  rendered it), proves nothing and is indeterminate. Next's not-found and redirect signals
  arrive as error rows too; they mean the route changed and are a changed page. A failed
  side component does not hide a view that rendered.
- Each event's `ts` is a UTC instant. It is written in the event's `timeZone`, where the
  page shows it, so a scan keeps its facility's clock. `localTs` restates the same instant
  and is not read; an event without a known zone stays in UTC.
- Event codes map through `status.ts`, then the event's category. Shipping Label Created
  is the shipper's label, and Pickup Requested the pickup the shipper booked, so both are
  `registered`, not `accepted` or in transit. Other codes stay unmapped
  for the shared wording rules. `statusMap` answers the app's review by code alone, so a code
  staged only by its category is not answered.
- The page prints each event's wording, then its note. A delivery's note says where the
  parcel was left, so a delivery keeps its wording alone.
- The reply also carries the recipient address, the merchant, references, delivery
  coordinates and proof-of-delivery links. None of it is read. Its `country` is the
  country of the recipient's postcode, which the page's proof-of-delivery check uses, and
  becomes the destination country.
- `POST /api/tracks`, which the page calls too, returns only the latest event and is not
  used. An HTML reply means a page was served instead of tracking data, and is a
  challenge. A 404 or 410 means the page moved, never an unknown number.
- SpeedX's Android app (`com.speedx.drivers`, RouteRunner) is for its drivers. The
  anonymous page already carries the full history, so no app endpoint is used.

## Limitations

- Expired histories get the same sentence as unknown numbers.
- The page's delivery estimate was always empty, so it is not read.
- Proof-of-delivery photos sit behind a recipient postcode check and are not fetched.

## Testing

`npm run test:carriers:live -- carriers/speedx` sends a well-formed unknown number. Set
`SPEEDX_TRACKING_NUMBER` to a real number to read one history.
