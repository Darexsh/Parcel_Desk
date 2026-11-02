# PostEx

PostEx is a Pakistani courier for online shops. It picks orders up from the merchant, carries
them between its hubs and delivers them cash on delivery. It took over Call Courier, whose
tracking page now leads to PostEx. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://postex.pk/api/tracking-order` with the body
   `{"trackingNumber":"{number}"}`, as the tracking page sends it. It needs no cookie, token,
   key or browser. The site's server asks PostEx's tracking service and relays its JSON reply,
   `{"statusCode":"200","dist":{…}}`, the shipment under `dist` with its scans newest first.

- An unknown number is HTTP 200 with `statusCode` `200` and no `dist`, which the page reports
  as not found. A 404 or a redirect is a moved route.
- The site's server answers `{"error":…}`, with HTTP 500, when it cannot make the lookup, and
  passes the tracking service's own errors on with HTTP 200 as `{"status":…,"error":…}`. Both
  are failures, never a missing parcel.
- The shipment must name the number asked.
- Recognition makes the same request.

## Notes

- Each scan's `modifiedDatetime` carries PostEx's offset, `+0500`, and the page shows it in the
  reader's own zone, so scans are instants.
- The page lists only some of PostEx's status codes and leaves the rest out of the history. The
  adapter keeps the same ones.
- The code stages a scan. Other codes fall to the shared wording rules.
- The scan at the merchant's warehouse names the merchant, as `At SAMPLE STORE Warehouse`. The
  adapter writes `At Merchant's Warehouse` instead.
- Warehouse and hub scans name PostEx's station by a three-letter code, as `Received at LHE
  Warehouse`, which is the location. `Departed to LAHORE` names where the parcel goes next, so
  it has none.
- The customer's name and the order date are not kept. Wording loses phone numbers.

## Limitations

- No delivery estimate, weight or service.
- Former Call Courier consignments the tracker knows come back without scans, and are reported
  as known without a history. Others answer as unknown.

## Numbers

PostEx tracking numbers seen in archived lookups and customer reviews are fourteen digits, and
so are the former Call Courier consignments its tracker knows. Fourteen digits are printed by
many carriers and no known prefix or check digit sets PostEx apart, so no rule claims them; a
caller names the carrier or pastes a tracking page link. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracking page on postex.pk looks up the number it finds in `cn` when it opens. The library
reads the number from that address.

## Testing

`npm run test:carriers:live -- carriers/postex`, with `POSTEX_TRACKING_NUMBER` and optionally
`POSTEX_UNKNOWN_NUMBER` set outside the repository.
