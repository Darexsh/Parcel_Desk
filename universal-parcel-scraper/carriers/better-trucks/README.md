# Better Trucks

Better Trucks is a US last-mile carrier that delivers parcels for e-commerce shippers. Tracked
through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://tracking.bettertrucks.com/api/tracking/{number}?isFromExternalTracking=true`,
   as the tracking page at `tracking.bettertrucks.com/tracking?trackingNumber={number}` makes it.
   It needs no cookie, token, key or browser. The JSON reply holds the parcel's current status,
   its history newest first and its addresses.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- A number it does not know is HTTP 200 with the status `UNKNOWN` ("Invalid tracking no") and an
  empty history, which the page shows as "Shipment can't be found". Old numbers come back the
  same way. A reply for another number is inconclusive. A 404 or a redirect is a moved route.
- The number goes in upper case, and the reply names it in upper case.
- Recognition makes the same request.

## Notes

- A scan's `object_created` is UTC without its offset: the page reads it as UTC, and the scan's
  `relative_time` labels the same digits Greenwich Mean Time. Its local reading there carries the
  offset at the scan's place, such as `GMT-05:00`. A scan's time keeps that offset when both
  readings are the same instant, and stays in UTC otherwise. The reply gives `GMT+00:00` to a
  scan it has no position for, which stays in UTC too.
- The scan's `status` code stages it; a hub scan's code ends with the hub's, as in
  `SCANNED_AT_HUB_HOS`. The page leaves the second creation row (`TRANSACTION_CREATED`) and
  dispatch failures (`ONFLEET_FAILED`) out of its history, and so does the adapter. Record changes
  and a corrected address move nothing. Once the address is corrected, the wait for its
  confirmation no longer sets the status: the page then shows the scan before both.
- The page shows "In Transit" for an out-for-delivery scan. The adapter keeps the reply's own
  wording and stage. A return to the station, which the reply can word with its code, reads
  "Return To Station" as on the page.
- Only a hub scan with a town keeps its coordinates. The others can sit at the shipper's site or
  the recipient's door.
- The reply also gives the sender's and recipient's towns and ZIP codes, the recipient's position,
  who took the parcel, where it was left, why a delivery failed, delivery photos and an estimate
  the page does not show. None of them is read; only the destination country is kept. The page
  names the Vinted Go point a parcel waits at, which the adapter does not read either.

## Limitations

- The tracker also takes five-character package codes, and `BTS` followed by such a code, and
  swaps them for the tracking number they stand for. A code that short lets a made-up value open
  a stranger's parcel, so the adapter refuses them as invalid input.
- No estimate, weight, service, sender or recipient.

## Numbers

A complaint about a Better Trucks delivery gives a fifteen-character number starting `BTPA`,
which the tracker knows, and another complaint prints the same prefix with masked characters.
`better-trucks-1` suggests Better Trucks for `BTPA` and eleven letters or digits, at low
confidence because only one complete number has been seen. Shippo's integration guide shows a
`BTS_` number with eleven characters after the underscore, and a complaint one with ten. The
tracker knows neither, so no rule claims the form and Shippo's example stays in quarantine. The
samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker opens one parcel at `tracking.bettertrucks.com/tracking?trackingNumber={number}`.
The carrier's site links the same page with the number in `ShipmentId`. The library reads the
number from either parameter.

## Testing

`npm run test:carriers:live -- carriers/better-trucks`, with `BETTER_TRUCKS_TRACKING_NUMBER` and
optionally `BETTER_TRUCKS_UNKNOWN_NUMBER` set outside the repository.
