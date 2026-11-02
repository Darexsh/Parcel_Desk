# ePost Global

ePost Global ships US online sellers' parcels abroad: its processing centers sort them and hand
them to a delivering partner such as Spring's PostNL service, GLS, Royal Mail or DAI Post.
Tracked through the lookup its tracking page makes. Its tracker runs on PPX Track, which also serves
it on ppxtrack.com, so that name counts as ePost Global's.

## How it works

1. `direct`: one `POST https://epgtrack.com/TrackingShipment/ShipmentData` with the form field
   `id`, as the tracking page's script sends it. It needs no cookie, token, key, account or
   browser. The reply is an HTML fragment: one card whose click handler carries the shipment's
   details and scans as entity-encoded JSON, then the same scans rendered.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- The tracker also finds a shipment by its partner's number. The card counts only when it
  echoes the number asked and its details' own number is that number.
- An empty card with "We haven't received any tracking updates" is the unknown-number answer;
  the tracker gives the same for expired numbers and for anything that is not a number. A card
  without details or a shipment without scans is inconclusive, and a page without a card is a
  changed reply.
- Recognition makes the same request.

## Notes

- Rows ePost Global relays from its partner keep the partner's code, so codes collide: the map
  reads the wording. OSM Worldwide's codes name it, so its rows read as OSM's own tracker reads
  them. ePost Global's own wording comes first; a receipt after the parcel moved on is in transit,
  and a partner's announcement after shipping is no step back.
- "Shipment in Transit to the ePost Global Processing Center" follows the shipping data by a
  minute on every parcel that has it: it is the label, not a scan. The shared wording rules read
  a universal provider's copy of it the same way.
- A processing center's receipt and shipping scans are on the center's own clock, as PostNL's
  label times for the same parcels show, so they take the zone of the center's state. A state
  split between zones gives none. Every other row keeps its wall clock: the data rows carry no
  place, and partners' rows are copied from the partner's feed in its own zone, which PostNL
  mixes with UTC.
- The delivering partner is named for Spring's PostNL service, which spring-gds tracks under the
  same number, and for partners the catalog knows by name whose link, if any, is their own. The
  partner's number is the delivery tracking number. GLS's European network is not named, since
  the reply does not say which national GLS company delivers.
- Places are cut at their first word holding a digit, where partners put postcodes, depot
  numbers or street addresses. The recipient's postcode, the scans' ZIP codes, the master air
  waybill and the shipper's reference are never read.

## Numbers

ePost Global numbers are `EPG` and digits, with no check digit. Current labels print fifteen
digits; an Amazon seller's forum post lists older ones of ten to thirteen. `epost-global-1`
claims the prefix with ten to fifteen.

A shipment sent on as USPS international mail can carry USPS's S10 code instead, ending in
`US`: the tracker files it under that code. Detection names USPS, the issuing post, for those
codes: USPS's tracker follows the parcel once it reaches USPS, while ePost Global's showed only
the label of one USPS was already moving. The adapter takes any code ending in `US`.

## Links

The tracking page reads a number from its path or its `id` parameter and looks it up at once, so
`epgtrack.com/{number}` opens one shipment. On ppxtrack.com it reads the `id` parameter, or the
number at the end of a shop's `/t/{shop}/{number}` page.

## Limitations

- No delivery estimate, delivery time, weight, service, sender or recipient.
- Partners' scans keep the wall clocks ePost Global copies from them.

## Testing

`EPOST_GLOBAL_TRACKING_NUMBER=... EPOST_GLOBAL_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/epost-global`
