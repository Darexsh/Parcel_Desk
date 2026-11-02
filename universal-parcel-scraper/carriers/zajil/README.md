# Zajil Express

Zajil Express is a Saudi courier with branches across the Kingdom. Tracked through the lookup its
tracking page makes.

## How it works

1. `direct`: one `GET https://mobileapi.zajil-express.org/track?shipment={number}`, the request the
   page at `zajil-express.com/track` makes. It needs no cookie, token, key or browser. The JSON
   reply is the shipment, its route and its current status.

- An unknown number is HTTP 404 with `[{"message":"shipment_not_found","code":"shipment_not_found"}]`,
  which is not found. A 404 without that error, or a redirect, is a moved route.
- For an eleven-digit number it has no shipment for, the lookup answers its HTTP 500 server error,
  which a failed lookup also gives; the page shows "No Shipment Found" for both. That answer is
  inconclusive (`indeterminate`, reason `portal_not_found`), never not found.
- The shipment must be the whole number asked.

## Notes

- The page shows the current status only, with its time, the route and a three-step rail. The
  reply's `history` holds that same status, so a result with a single status is marked
  `summary_only` and enabled fallbacks are asked for the earlier scans.
- A status's `date` is a wall clock without a zone, which the page shows as it comes. No offset
  is verified, so it stays in `local_time`.
- `website_update` stages each status and is its provider code; the page's script names every
  value the map reads. The wording is the Arabic line the page shows, also on its English page.
- The status's place is the branch or hub the reply names, in English. The destination country
  is kept; the route's cities, amounts to collect, branch codes and the feedback field are not.
- One read, with no retry: a number the lookup cannot answer holds the request open until it
  fails, and a second request would add another.
- No recognition: no detection rule claims Zajil numbers.
- The Android app looks shipments up at `mobileappapi.zajil-express.org/api/user/order/newtrack/{number}`,
  a host that does not accept connections.

## Limitations

- No earlier scans, estimate, weight or service.
- Twelve-digit house waybills get no answer: the lookup holds them open and then fails with its
  server error.
- Some older shipments carry the clock of a bulk update, shared by many shipments, instead of
  their status's own time.

## Numbers

Zajil shipment numbers are eleven or twelve digits; older references start with `Z`. Detection
does not claim them: the digit runs are shared by many carriers, and the `Z` references have
too few public lookups to define a layout. The adapter takes eleven or twelve digits, or `Z` and
seven digits.

## Links

The tracker opens one shipment from `zajil-express.com/track?tracking_id={number}`, also under
`/ar/`; the library reads the number from both.

## Testing

`npm run test:carriers:live -- carriers/zajil`, with `ZAJIL_TRACKING_NUMBER` and optionally
`ZAJIL_UNKNOWN_NUMBER` set outside the repository.
