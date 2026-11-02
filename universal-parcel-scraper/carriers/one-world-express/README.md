# One World Express

One World Express is a British cross-border parcel company. It takes parcels from its hubs to
other countries by air and hands them to a carrier there, such as Yodel in the UK or USPS in the
United States. Tracked through SmartTrack, the tracker it links for its parcels.

## How it works

1. `direct`: one `GET https://www.smarttrack.co/tracking.php?tracking_number={number}`, the page
   the tracker opens for one parcel. It needs no cookie, token, key or browser. The HTML page
   has the shipment's boxes and a table of scans under day headings, newest first.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- An unknown number gets HTTP 200 and the page's notice "No Tracking available.". A 404 is a
  moved route and a redirect another page.
- A parcel's page puts the number asked back in its search field, which must be the whole
  number. The boxes do not show it; a parcel image, when the page offers one, is named after
  it, and another number there is another parcel.
- Recognition makes the same request.

## Notes

- SmartTrack's multi-number page asks `multitracking.php` for JSON with seconds and status
  codes, but answers an unknown number with a PHP error page. The lookup on
  oneworldexpress.com's tracking page answers one with an empty HTTP 200. Neither tells a
  missing parcel apart, so the adapter reads the single-parcel page.
- Each scan's clock is a wall clock to the minute under its day's heading. The scans come from
  the origin country and the destination, and the page names no zone, so every clock stays
  `local_time`.
- Each scan has a description and SmartTrack's own Status label, which becomes the provider
  code and stages the scan. `In Transit` covers a hand-over, a sort and a departure; the shared
  rules would read the hand-over as an acceptance. A label the map does not know leaves the
  stage to the shared rules on the description, then on the label. The newest scan with a
  stage decides the status.
- The Tracking Number box holds the number of the carrier that delivers, such as a USPS
  barcode, and becomes the delivery tracking number. The page does not name that carrier, so
  there is no delivery carrier; the hand-off proposes the one whose high-confidence rule claims
  the number. When the box holds the parcel's own number or its order number, there is none.
- Descriptions lose who signed, phone numbers, e-mail addresses and any links or names set off
  in their own element. The order number (HAWB), the master air waybill, the origin country,
  the transit time and the parcel image are not kept.

## Limitations

- No delivery estimate, weight, sender or recipient, and no delivery time as an instant.
- SmartTrack also finds a parcel by its delivering carrier's number. The adapter asks it only
  about One World Express's own numbers.

## Numbers

One World Express's own numbers are `OWE` and twelve digits. An archived SmartTrack lookup
shows one with its history, and `one-world-express-1` claims the layout. The example on its
tracking page has the layout of Evri's sixteen-character numbers, which Evri's rule already
covers, so it is kept only for review. Partner numbers stay with their carriers. The samples
and their sources are in [`numbers.json`](numbers.json).

## Links

`smarttrack.co/tracking.php?tracking_number={number}` opens one parcel. A pasted SmartTrack
link names One World Express only for its own numbers, since the tracker also takes partners'
numbers. The tracking page on oneworldexpress.com loads its result into the page without
changing the address.

## Testing

`npm run test:carriers:live -- carriers/one-world-express`, with
`ONE_WORLD_EXPRESS_TRACKING_NUMBER` and optionally `ONE_WORLD_EXPRESS_UNKNOWN_NUMBER` set
outside the repository.
