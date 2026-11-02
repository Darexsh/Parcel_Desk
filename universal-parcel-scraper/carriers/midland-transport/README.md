# Midland Transport

Midland Transport is a freight and courier company in Atlantic Canada, based in Moncton. Midland
Courier carries its parcels and Midland LTL its freight. Tracked through its tracking page.

## How it works

1. `direct`: one `GET https://ship.midlandtransport.com/Tracking/TrackClientTrackings` with
   `TrackingNumber` and `Lang=0`, the address the home page's quick track field opens. It needs
   no cookie, key or browser. The server renders the page with the shipment's summary and its
   scans, oldest first.
2. `retry`: the request once more after a network failure or timeout. The first try gets half
   of the budget.

- An unknown number is HTTP 200 with the line `The shipment number does not exist`. The line
  names no number, so the page's search field, which repeats the number asked, must hold it. A
  404 or a redirect is a moved route.
- Imperva, in front of the page, refuses a client it blocks with a 403 or its incident page;
  both are challenges. Every page loads an Imperva script, which alone is no block. The
  package's default User-Agent passes.
- The page belongs to 2Ship, a multi-carrier shipping platform. The shipment details must name
  the number asked as `Package Tracking#` and a Midland carrier as `Carrier`; another carrier's
  shipment is inconclusive.
- No detection rule offers Midland numbers, so the adapter has no recognition.

## Notes

- Each scan row has a clock, an Activity and Midland's wording with the terminal's town and
  province in parentheses. The Activity, the platform's category such as `Picked Up` or
  `Delivery Exception`, is the scan's code and stages it. The wording is the description and
  the terminal the location.
- Clocks are wall clocks to the minute with no zone. Midland's terminals span the Eastern,
  Atlantic and Newfoundland zones, and the page does not say whose clock it shows, so they stay
  `local_time`.
- Until the first scan the table holds a `No Tracking Info` placeholder at the shipment's
  creation, and it drops that row afterwards. The adapter keeps the page's
  `Shipment Created Date` as a `Shipment Created` scan instead, so the history starts the same
  way before and after.
- The word over the dates, in the Activity's vocabulary, is the shipment's state.
- `Delivery Exception` covers the delays Midland reports with their reason, the shipper's or
  the consignee's, and is filed as an exception.
- The estimate is `Updated Expected Delivery`, else `Expected Delivery`, as a day, dropped after
  the delivery. The service is the page's `Service`, such as `Ground`. The destination's
  country is kept, not its town.
- The page shows the shipper's name, phone and email, its reference, the origin and
  destination towns, the package count and the shipment's other package numbers. None is kept.
- Midland's Courier Site, `cssportal.midlandcourier.com`, has its own track page behind an
  anonymous session, with probill and bill of lading searches. Its search also matches
  shippers' references, so an answer is not bound to one parcel, and the adapter does not use
  it.

## Limitations

- No weight, signature or proof of delivery, and no delivery time as an instant.
- The tracker drops old shipments, which then read as not found.
- Only sixteen-digit Midland Courier numbers are taken. No public source shows a Midland LTL
  probill, or whether this tracker holds one.

## Numbers

Lookups archived from Midland's tracker show Midland Courier parcels with sixteen-digit
numbers ending in a four-digit package counter. Sixteen digits are shared by many carriers
and nothing in the number points to Midland, so no rule claims them; a caller names the
carrier or pastes a tracking page link. No public source shows a Midland LTL probill.

## Links

The home page's quick track field opens one shipment at
`ship.midlandtransport.com/Tracking/TrackClientTrackings` with the number in
`TrackingNumber`. The library reads the number from that address.

## Testing

`npm run test:carriers:live -- carriers/midland-transport`, with
`MIDLAND_TRANSPORT_TRACKING_NUMBER` and optionally `MIDLAND_TRANSPORT_UNKNOWN_NUMBER` set
outside the repository.
