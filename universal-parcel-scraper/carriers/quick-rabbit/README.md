# Quick Rabbit

Quick Rabbit is a Spanish last-mile carrier for online shops and retail, delivering in Spain
from its own sorting centre, local warehouses and couriers, and to Citibox lockers and pick-up
points. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://api.tms.quickrabbit.es/api/v1/tracking/{code}/`, the lookup the
   tracking page makes. It needs no cookie, token, key or browser.
2. `retry`: the request once more when it fails to reach the tracker or hangs. The first try
   gets half of the budget, so the retry fits in the rest.

- A code the tracker does not know gets HTTP 404 with `Package not found`, read as not found.
  Any other 404 or a redirect is a moved route, a 403 or a firewall page is a challenge, and a
  429 is a rate limit, retried after the seconds its `X-RateLimit-Reset` header names.
- The reply names the parcel's tracking code and the shipper's reference; it must hold the code
  asked for as one or the other, or the answer stays open. A parcel found by its reference keeps
  its tracking code as the canonical number.
- Recognition makes the same request.

## Notes

- Each status is an enumeration name, a category and a time labelled UTC. The page shows that
  time's digits as they come, read in UTC, so they are the wall clock the carrier shows; the
  adapter reads them on Madrid's clock.
- The page labels each status name from its translations. The adapter keeps the English label,
  with the name as the provider code, and the status map files the names under stages. A name
  the page does not label yet is staged by its category and worded from its name.
- Notes on the parcel, such as customer service contacts, address or date changes, repairs,
  compensations and operational incidents, move nothing, so they give no stage. The same goes
  for a reactivation, which only reopens the record, and for a pick-up whose label does not say
  who picked the parcel up.
- The courier's status can carry the courier's position, which can be the recipient's door, so
  it is not kept. The destination city, the shipper's reference and the progress are not kept
  either.
- The reply's estimated delivery date lies a few days after the lookup even for a parcel
  returned long ago, so it is not read.

## Limitations

- No places, scan locations, expected delivery or proof of delivery.

## Numbers

Customers quote Quick Rabbit tracking codes in public complaints: PKG, three digits, the date the
parcel was documented and nine digits. No other carrier issues the layout, so the rule has high
confidence. A universal provider files under Quick Rabbit a longer code with the same PKG, three
digits and a two-digit year, then ES, thirteen digits and a letter, and relays the tracker's
status names for it. A single parcel shows that layout, so a low rule suggests Quick Rabbit and
recognition asks the tracker; the corpus holds a made-up number in that shape. The shipper's
reference, WT and sixteen digits, also finds the parcel. Its issuer is not known, so a low rule
suggests Quick Rabbit and recognition asks the tracker.

## Links

A link to the tracking page with the code in its `ref` parameter opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/quick-rabbit`, with `QUICK_RABBIT_TRACKING_NUMBER` and
optionally `QUICK_RABBIT_UNKNOWN_NUMBER` set outside the repository.
