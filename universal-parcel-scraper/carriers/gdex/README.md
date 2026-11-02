# GDEX

GD Express (GDEX) is a Malaysian parcel courier with its own branches and hubs across the
country. Tracked through the guest lookup of its mobile app.

## How it works

1. `direct`: one `GET https://app.gdexpress.com/api/trackings?search={number}`, as the GDEX app
   sends it; app.gdexpress.com also serves the app on the web. It needs no cookie, token, key or
   browser. The JSON reply has one entry per number searched, with the consignment's scans newest
   first.

- An unknown number is HTTP 200 with `valid: false` and no data, which the app shows as not
  valid and the tracking page as no records found. A 404 or a redirect is a moved route.
- The entry must echo the number asked.
- Recognition makes the same request.

## Notes

- Each scan's `updatedAt` is the branch's wall clock, with no zone. GDEX scans in Malaysia, whose
  clock has no daylight saving, so scans are read in `Asia/Kuala_Lumpur`, and a delivery gives
  `delivered_at`.
- Each scan also has a category, kept as its provider code: Pickup, In Transit, Out For Delivery
  or Delivered. The category is coarse: a failed delivery is filed under In Transit. The wording
  stages a scan first, then the category; In Transit alone gives no stage, so an unfamiliar
  wording under it goes to the shared wording rules.
- The reply names no sender or receiver. A person a delivery scan names, receivers, signers and
  phone numbers are still taken out of the wording.

## Limitations

- No estimated delivery, weight or service name.
- GDEX keeps about a year of consignments; an older one reads as not found.

## Numbers

GDEX consignment numbers are ten digits or `MY` and eleven digits, as lookups archived from
GDEX's tracking pages show. `gdex-1` claims the `MY` layout. Ten digits are also DHL Express
waybills and other carriers' numbers, so no rule claims them. The samples and their sources are
in [`numbers.json`](numbers.json).

## Links

`gdexpress.com/tracking/?consignmentno={number}` opens one consignment on GDEX's website, which
sits behind a Cloudflare check that regular browsers pass. GDEX's former e-tracking page took the
number as `capture` on `web2.gdexpress.com/official/iframe/etracking_v2.php`, and the library
still reads it from such addresses.

## Testing

`npm run test:carriers:live -- carriers/gdex`, with `GDEX_TRACKING_NUMBER` and optionally
`GDEX_UNKNOWN_NUMBER` set outside the repository.
