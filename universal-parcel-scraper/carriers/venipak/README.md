# Venipak

The Baltic courier in Lithuania, Latvia and Estonia. Tracked through the shipment service its
tracking page calls.

## How it works

1. `direct`: one `GET https://venipak.com/ee/en/wp-json/v1/shipment-tracker/{number}`. The
   tracking page asks this WordPress service when it opens; it needs no cookies, token, account
   or browser. The reply is JSON whose `parcels` field holds an HTML fragment listing every
   parcel of the shipment with its scans.
2. `retry`: one more try when the request fails to reach Venipak or hangs. The first try gets
   half of the budget.

- The reply echoes the number it searched, which must be the requested one, and the parcel is
  the one whose container the number names. Anything else is `SchemaError`.
- A shipment number returns all of the shipment's parcels. The reply must name the same
  shipment. With one parcel, its history is returned and its parcel number becomes
  `canonical_tracking_number`. With several, the answer is inconclusive with the reason
  `several_parcels`: nothing tells which parcel is meant.
- A number Venipak does not know returns "Shipment {number} not found": `NotFoundError`.
  "Wrong shipment ID" is `InvalidInputError`. Any other notice is inconclusive, and so is a
  redirect or a missing service.
- Recognition makes the same request for parcel numbers only; the not-found notice is the only
  unknown answer. Detection already claims parcel numbers, so preflight does not ask this
  adapter.

## Notes

- The Estonian site's English page is asked because it words every answer in English. The
  three sites share one backend, but the Lithuanian site's English page words its notices in
  Lithuanian and some statuses differently. Both wordings are mapped.
- The page marks each scan with a number that picks its icon. The numbers group statuses (2 is
  both a parcel still at the sender and one out for delivery), so stages come from the wording.
- Times are Baltic wall clocks without an offset and are kept as local times.
- A scan's text names its place after the wording. Only a terminal written in capitals and a
  Venipak locker or pickup point are kept; anything else could be an address. The locker or
  point a parcel was delivered to is its pickup point while it waits there and once it is
  collected. Scan coordinates are not read: they can locate the recipient. The page's
  postcode check is not used.
- The tracker refuses lower case, so the number is sent in capitals.
- Cloudflare answers a burst of lookups with HTTP 429, which is `rate_limited`.
- Other anonymous services were not used. `tracking.venipak.com/api/v1/events?pack_no={number}`
  gives offset timestamps and status codes, but keeps only recent parcels, leaves out some
  scans and puts addresses in its locations. `go.venipak.lt/ws/tracking?code={number}&type=1`,
  which Venipak's shop modules call, also keeps only recent parcels.

## Numbers

Venipak parcel numbers are `V`, five digits, `E` and seven digits: Venipak's own shop modules
build them from the sender's customer ID and a running serial. Lookups archived from Venipak's
tracker show them from 2015 on, sometimes typed in lower case, and `venipak-1` claims them. The
tracker also answers shipment numbers, which have grown from seven digits to nine and are
sometimes typed with leading zeros; the adapter takes seven to ten digits after at most three
zeros. Those lengths are shared with several carriers, so no rule claims them and the user
picks Venipak.

## Links

Venipak's tracking form opens one parcel at `venipak.com/lt/en/tracking/track/{number}`; the
Lithuanian and Estonian pages use `/lt/tracking/track/` and `/ee/tracking/track/`, and
Venipak's shop modules link `venipak.com/tracking/track/{number}`. Archived lookups on the
former `www.venipak.lt` used `/siuntos-kelias/track/` and `/en/tracking-information/track/`.

## Limitations

- No delivery estimate, weight, service or sender.
- A shipment number with several parcels is not tracked; each of its parcel numbers is.
- Failed deliveries and returns have not been seen on the page; their wordings are left to the
  shared classifier.
- The tracker forgets old parcels, which then return the not-found notice.

## Testing

`VENIPAK_TRACKING_NUMBER=... VENIPAK_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/venipak`
