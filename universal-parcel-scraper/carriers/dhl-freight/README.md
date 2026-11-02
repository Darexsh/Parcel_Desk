# DHL Freight

DHL Freight carries pallets and part loads by road across Europe through its own terminals.
Tracked through ActiveTracing's own search.

## How it works

1. `direct`: one `GET https://activetracing.dhl.com/DatPublic/datSelection.do` in English
   (`l=EN`). An order code or consignment ID goes in `a` with `autoSearch=true` and
   `search=consignmentId`, as the page's own links send it. A package ID goes in
   `valuePackageField` with `at=package`, as the package form sends it. It needs no cookie,
   CSRF token, key or browser. A match opens the consignment's details: a summary and the
   history, oldest first.
2. `retry`: the same read once more after a network failure or a timeout.

- An unknown number keeps the search page, with the notice that no consignment matches and the
  number repeated in its field. The search page without that notice, or repeating another
  number, is inconclusive. A 404 or a redirect is a moved route.
- A package ID sent in `a` gives an unknown package the search page without any notice, so the
  adapter uses the package form.
- The site sits behind F5's firewall. Its rejection page and its script check are a challenge,
  whatever their HTTP status.
- The details must list the number asked among the consignment's IDs, order code or packages.
- Recognition makes the same request.

## Notes

- A row's date is the terminal's wall clock to the minute, with no zone, or only a day. Both
  stay `local_time`.
- Terminals are written `DE-KOBLENZ`; the adapter turns them into `KOBLENZ, DE`. The
  out-for-delivery and delivery rows name no terminal.
- The page shows no status codes, so the sentence stages a row. `Out for Collection` means a
  driver is on the way to the shipper and stays registered.
- The consignee's postcode and an image security code unlock the proof of delivery and more
  details. The history does not need them, and the adapter does not ask for them.
- The weight, the product and the consignee's country are kept. The consignee's and shipper's
  towns, the volume, the pallet count, the pickup and delivery dates and the package list are
  not. Packages' own scans, on a separate tab, are not read.
- dhl.com's tracking page also answers these consignments through `/utapi`, with status codes
  and seconds, but Akamai's challenge turns plain HTTP clients away with HTTP 428 or a reset
  stream, so only a browser reads it. DHL's Shipment Tracking API needs a key from a developer
  account.

## Limitations

- ActiveTracing keeps consignments for six months; older numbers are not found.
- No estimated delivery, and no scan time as an instant.
- A search matching several consignments opens a list, which the adapter does not read.

## Numbers

ActiveTracing searches by order code, consignment ID or package ID. Order codes are three
letters for the terminal, two for the product and seven digits, hyphenated. No rule claims
them: detection compares numbers with hyphens stripped, and the code is then five letters and
seven digits, which another carrier's numbers also fit. Consignment IDs are nine digits or,
for domestic consignments, eleven digits with leading zeros; digit runs like these are shared
by many carriers, so no rule claims them.

Package IDs are DHL licence plates, `JND` and seventeen digits, or pallets' SSCCs.
`dhl-freight-2` suggests DHL Freight for licence plates with low confidence, because licence
plates of this kind follow a shared standard. An SSCC names whoever issued it, so no rule
claims it. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The library reads the number from `a`, `valuePackageField` or `valueShipmentOrderField` on
`activetracing.dhl.com/DatPublic/datSelection.do`, the parameters of ActiveTracing's links and
search forms.

## Browser recovery

When the direct lookup returns a bot check, configured TRAWL opens the same parcel page and
uses the same parser. Rate limits, definite answers and changed pages do not start a browser.
Recognition stays on direct HTTP. Set `FLARESOLVERR_URL` to enable recovery in the live tracking check.

## Testing

`npm run test:carriers:live -- carriers/dhl-freight`, with `DHL_FREIGHT_TRACKING_NUMBER` and
optionally `DHL_FREIGHT_UNKNOWN_NUMBER` set outside the repository.
