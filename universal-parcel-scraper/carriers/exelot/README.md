# Exelot

Exelot is a cross-border e-commerce carrier. Its tracker follows parcels from origin warehouses
through flights and customs to delivery, mainly into Israel. Tracked through the lookup its
tracker page makes.

## How it works

1. `direct`: one `GET https://apiv2p.exelot.com/api/v2/parcels/tracking/details/{number}?lang=en`,
   the request the script of `go.exelot.com/tracking` sends for the numbers in its address. The
   page sends it without a key, cookie or account, and so does the adapter. The answer is a list
   with one parcel per number asked.
2. `retry`: one more try when the request fails to reach Exelot or hangs. The first try gets half
   of the budget.

- An unknown number comes back with HTTP 200 as a parcel holding only its number and
  `parcelStatus: "notFound"`. That answer, for the number asked, is the only not-found.
- An empty list, the answer to a request without a number, or any reply that is not a parcel is
  a changed schema. A 404 is a moved route, and a bot check's page is a challenge.
- A parcel without scans has no history yet: it is neither found nor missing.
- The one parcel answered must carry the number asked.
- Recognition makes the same request.

## Notes

- The page also asks for the merchant's order number, which the adapter does not keep, so it
  leaves that flag out.
- A scan carries a code, sometimes a sub-code after it, English wording and an ISO clock with
  its offset. The page shows these clocks as instants, so they are kept with their offset. A
  scan with only the clock the page prints is read in UTC, as the page reads it; where a scan
  has both, they agree.
- The page shows its own title for each code, while the lookup sends older wording. The adapter
  keeps the lookup's wording and stages the scan by its code, which the status map reads from the
  page's titles and descriptions. The provider code joins the code and sub-code as the page does,
  and the stage follows the code.
- The lookup names the place of each scan, which the page does not show. Only a town with its
  country code, or a country code alone, is kept. A delivery, a refusal or a failed attempt
  happens at the recipient's address and can name part of it, so its place is never kept.
- The pickup point the page shows is kept with its name, street and town.
- The remark, the buyer's masked email and phone, the order number, the origin district, the
  delivery partner's name, number and link, and any note on a scan are not kept.

## Limitations

- No delivery estimate, weight, service, sender or recipient.
- The delivery partner the page names is not reported: its name is free text that no catalog
  carrier is matched to.

## Numbers

Exelot numbers are `XLT` followed by nine digits, which `exelot-1` claims at high confidence, so
recognition is not needed to settle the carrier. Purolator's three-letter rule leaves that prefix
to Exelot, as it does for other carriers' prefixes. The adapter sends only that shape and refuses
anything else without a request. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracking box on `exelot.com` opens `go.exelot.com/tracking?barcodes={number}`. Older
pages used `myparcel.exelot.com/tracking?barcodes={number}` and
`public.exelot.com/tracking/{number}`. The library reads the number from any of these
addresses.

## Testing

`npm run test:carriers:live -- carriers/exelot`, with `EXELOT_TRACKING_NUMBER` and optionally
`EXELOT_UNKNOWN_NUMBER` set outside the repository.
