# Skroutz Last Mile

Skroutz Last Mile is the delivery arm of Skroutz, the Greek marketplace. It picks up orders from
the shops that sell there and delivers them to the door or to Skroutz Point lockers in Greece
and Cyprus. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://api.sendx.gr/user/hp/{voucher}`, as the tracking page asks it for
   the voucher in its address. It needs no cookie, token, key or browser. The JSON reply has
   the parcel's overall state and its scans, oldest first, each with its Greek and English
   wording, a tracking state such as `SCANNED` and a UTC instant.
2. `retry`: one more try when the request fails to reach the service or hangs. The first try
   gets half of the budget.

- An unknown voucher is HTTP 400 with the plain text `Package not found`, which the page
  reports as not found. Any other 400, a 404 or a redirect is a refused or moved route.
- The reply names no voucher. The service matches the whole voucher in the path, case
  included, and a shorter, longer or lower-case one is unknown to it, so the path binds the
  reply to the voucher asked.
- The Cypriot site, `skroutzlastmile.cy`, asks the same service; the Greek page sends a
  Cypriot parcel there.
- Recognition makes the same request.

## Notes

- Scan times are UTC instants, which the page shows in the visitor's zone. They are returned
  at Greece's offset; Cyprus keeps the same one.
- A scan's description is its English wording, or its Greek one when the English is empty. The
  page hides a scan with neither, and so does the adapter.
- The wording stages a scan, in English or Greek. The tracking state is its provider code and
  stages it when the wording is new. `PICKED_UP` files both the pickup from the shop and the
  courier taking the parcel out on a round, so it never stages a scan alone.
- A voucher without scans is registered: the page shows "Route created / Awaiting pickup". The
  answer is summary only.
- The estimate is the courier's window when the reply has one, else the day planned for the
  delivery. The page shows none once the parcel is delivered, in a locker, lost, cancelled or
  handed to another courier, and neither does the adapter.
- Each scan's `notes` hold the hub again, the courier's remarks and, on a delivery, the
  coordinates where the courier stood. The page never shows them and the adapter does not read
  them. The Skroutz order code, the failed-delivery text and the map token in the reply are not
  kept either.

## Limitations

- No scan locations other than the hub names in the wording, no weight and no proof of
  delivery.
- When another courier delivers the parcel, the page names it and links to its tracker. The
  adapter does not follow it.

## Numbers

Skroutz Last Mile calls its tracking number a voucher: thirteen capital letters and digits. An
archived lookup on Skroutz's own tracking page shows one. The shape is shared with UPU numbers
and several carriers' codes and has no prefix or check digit, so no rule claims it. The adapter
asks only for numbers of that shape. The contact form also accepts partner carriers' numbers,
which stay with those carriers.

## Links

Skroutz Last Mile's tracking page reads the voucher from the address fragment, so
`skroutzlastmile.gr/#{number}` opens one parcel. Skroutz's shipment page,
`skroutz.gr/track/{number}`, shows the same history; the library reads the voucher from it.

## Testing

`npm run test:carriers:live -- carriers/skroutz-last-mile`, with
`SKROUTZ_LAST_MILE_TRACKING_NUMBER` and optionally `SKROUTZ_LAST_MILE_UNKNOWN_NUMBER` set outside
the repository.
