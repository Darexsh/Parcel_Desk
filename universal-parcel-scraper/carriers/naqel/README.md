# Naqel Express

Naqel Express is an express and e-commerce carrier owned by Saudi Post. It delivers across
Saudi Arabia and in the other Gulf countries, and collects imports abroad that it clears and
delivers there. Tracked through its tracking page.

## How it works

1. `direct`: one `GET https://www.naqelexpress.com/en/Track/TrackShipment/{number}`, the
   page a tracking link opens, in English. It needs no cookie, token, key or browser. The
   server renders the shipment's summary and its scans, newest first under day headings.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- An unknown number is HTTP 200 with the page's own `Sorry Tracking information is not
  available` answer, which is not found. A 404 or a redirect is a moved route.
- The summary's `SHIPMENT NO` must be the waybill asked, or the waybill of the piece asked.
- Recognition makes the same request.

## Notes

- The tracking form at `/en/sa/tracking/` posts the number with a token from its own page and
  renders the same summary and scans. The link path needs neither, so the adapter uses it.
- A piece's label is its waybill followed by a five-digit piece counter. The tracker answers it
  with the waybill's summary and scans, and the waybill becomes `canonical_tracking_number`.
- Each scan's clock is its day heading and a time to the minute, with no zone. A history
  spans several zones: an import's first scans are at the site abroad that collected it, and
  Naqel works across the Gulf. The clocks stay in `local_time`, and a delivery gets no
  `delivered_at`.
- Scans carry wording only, which [status.ts](status.ts) stages. `Parcel Locker Request
  Created` is a delivery option, not a movement, and keeps no stage. The summary's current
  status `Delivered` settles a delivered shipment; other summary wording is left to the scans.
- Scans the system records, such as the waybill's creation, give `SYSTEM` as their place,
  which is not kept as a location.
- The former page named who signed for a delivery after its wording. That name, and any phone
  number, is taken out of a scan's wording. The destination city, pickup date, payment method,
  piece count and progress rail are not kept.
- The UAE site's form at `/en/ae/tracking/` finds the same waybills and words some scans
  differently. The Arabic page `/ar/Track/TrackShipment/{number}` has the same scans in Arabic.

## Limitations

- No weight, service, proof of delivery or locker name.
- The tracker forgets older shipments, which then answer not found.
- Reference numbers, which the tracking form also takes, are refused.

## Numbers

Naqel waybills are digit runs. Archived lookups on its tracker show eight digits in earlier
years and nine digits more recently. A piece's label adds a five-digit piece counter, thirteen
or fourteen digits in all. Saudi Post, which owns Naqel, accepts Naqel numbers of these four
lengths in its own tracker. No rule claims them, because many carriers print digit runs of
these lengths. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking form posts to `naqelexpress.com/en/sa/tracking/`. Archived lookups show that
`naqelexpress.com/en/Track/TrackShipment/{number}` opens one shipment; the same path also
appears without the language and under `/ar/`.

## Testing

`npm run test:carriers:live -- carriers/naqel`, with `NAQEL_TRACKING_NUMBER` and optionally
`NAQEL_UNKNOWN_NUMBER` set outside the repository.
