# GIG Logistics

GIG Logistics (GIGL) is a Nigerian courier with service centres across the country. The adapter
reads the lookup its tracking page asks for ten-digit waybills.

## Numbers

Its waybills have ten digits. The examples in GIG's API documentation start with 1, but GIG
does not document the layout, and ten digits are shared with many carriers, so no rule claims
it. The tracker also takes an "Alphacode", whose layout is not documented.

## Retrieval

The tracking page asks `GET https://agility.giglogistics.com/api/portal/trackshipment/{waybill}`
without a cookie, token or CAPTCHA, and the adapter sends the same request. One HTTP read, and
one more when the first fails to connect or hangs.

## Notes

- The lookup answers with HTTP 200 and its own `Code`: "200" with the shipment, or "400" with
  "Invalid waybill number!!" for a waybill it does not have, which is the only not-found. Another
  code is inconclusive; a redirect, a 404, a browser check or a reply that is not JSON is never
  read as a missing waybill.
- Only scans whose `Waybill` is the whole number asked are read. A reply with scans for another
  waybill only is inconclusive.
- A scan is read by its code (`Status`, such as `OKT`), which stages it, and the code's fixed
  wording (`ScanStatus.Reason`). The page shows the scan's incident text instead, which can name
  the receiver, so it is not read.
- A scan's place is the service centre's name. Anything with digits or commas, as an address
  has, is dropped.
- Scan times carry no offset. Each scan keeps its wall clock in `local_time`, and Node lookups
  date it on the zone of its place, else of the scans around it, else Nigeria's
  (`dateLocalClocks`), with the basis that chose it. An offset the reply states is kept.
- The origin and destination addresses and the scanning staff's names are never read.

## Limitations

- No estimate, weight or service, and no delivery instant: the delivery scan keeps its wall
  clock.
- An Alphacode, or any reference but ten digits, is left to the universal providers without a
  request: its layout is undocumented and the reply could not be bound to it.

## Links

`giglogistics.com/track-shipment/?waybill={number}` opens the tracking page with the waybill.

## Testing

Set `GIG_LOGISTICS_TRACKING_NUMBER` to a waybill and optionally `GIG_LOGISTICS_UNKNOWN_NUMBER`
outside the repository, then run `npm run test:carriers:live -- carriers/gig-logistics`.
