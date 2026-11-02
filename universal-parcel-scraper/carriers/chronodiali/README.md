# Chronodiali

Chronodiali is a Moroccan courier specialised in e-commerce deliveries, owned by Barid
Al-Maghrib and Geopost. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://projectxuaeapi.shipsy.io/api/client/integration/consignment/track?reference_number={number}`
   with the `api-key` header the tracking page's script sends. Chronodiali runs on Shipsy, and
   the key is its own account's, the same for every visitor, so the reply is Chronodiali's. It
   needs no cookie or browser. The JSON reply has the shipment and its events, newest first.
2. `retry`: a read that fails to reach Shipsy, or hangs, gets one more try within the budget.

- An unknown number is HTTP 400 with `Consignment not found`. Another error is inconclusive,
  a 404 or a redirect is a moved route, and a refused key (HTTP 401) is a challenge.
- The shipment must echo the number asked.
- Recognition makes the same request.

## Notes

- Each event's `event_time` is epoch milliseconds, so scans are instants.
- The `type` stages a scan. Its description is the page's French message for that type, and
  the reply's own English label for the types the page has no message for, such as the
  delivery run and the courier taking the parcel out on it. The page leaves those out.
- The courier's call to the recipient (`call_log`) moves nothing and is left out, as on the
  page.
- The shipment's own `status` decides its stage; a shipment without events is read from it
  alone.
- An event's hub is its location. The partner hub a parcel from abroad waits at for customs,
  `3PL HUB`, names no place and is dropped.
- The reply also holds the sender's and recipient's names, phones and addresses, the
  cash-on-delivery amount, the courier, GPS positions, delivery trips and proof-of-delivery
  images. The page shows the names, towns and amount. None of it is kept.

## Limitations

- No estimate, weight or service name.
- A parcel handed to a partner keeps Chronodiali's scans only.

## Numbers

Chronodiali's tracking page shows an example number in its search field: `CHPU` followed by 19
digits. `chronodiali-1` claims that layout, which no other carrier rule matches.

The tracker also knows references of `CD` and ten digits, which a merchant publishes as
Chronodiali's. Two letters and ten digits fit other carriers' numbers, and one example does not
establish the family, so `chronodiali-2` only suggests Chronodiali for them, with low
confidence, and recognition asks its tracker. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`chronodiali.ma/suivi_colis.html?id=` followed by the number opens one parcel: the page reads
the `id` parameter when it loads and runs the search.

## Testing

`npm run test:carriers:live -- carriers/chronodiali`, with `CHRONODIALI_TRACKING_NUMBER` and
optionally `CHRONODIALI_UNKNOWN_NUMBER` set outside the repository.
