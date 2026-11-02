# Quicksilver

Quicksilver is a Saudi courier that collects parcels from shops and delivers them across the
kingdom. Tracked through the history lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://erp.quick-silver.express/v1/customer/tracking/history?tracking_number={number}`
   with the bearer token the tracking page's script sends. The token is the same for every
   visitor, so the lookup needs no account, cookie or browser. The JSON reply has the number,
   the delivery driver's mobile number and the statuses, mostly newest first.
2. `retry`: one more try when the request fails to reach the service or hangs. The first try
   gets half of the budget.

- An unknown number is HTTP 404 with "Shipment not found", which the page words as a number
  that is incorrect or does not exist. Another HTTP 404 or a redirect is a moved route, HTTP
  401 a refused token and HTTP 400 a refused request.
- The reply's `tracking_number` must be the whole number asked.

## Notes

- Each status has a name, which is its `provider_code` and stages it, a reason, a
  proof-of-delivery photo and a clock. The reason follows the name in the wording; a station
  it opens with in `【】` becomes the location. A delivery keeps its name alone, since its
  reason could say who took the parcel, and phone numbers are dropped from every reason.
- Clocks are wall clocks to the second with no zone, so they stay `local_time`. The service
  lists some statuses out of order and some twice, so the adapter sorts them by clock and
  keeps a repeated one once.
- `Picked` comes with the earliest clock, before the order was placed, so it gets no stage.
- The driver's mobile number and the photos are not kept.
- No recognition: one public number backs the layout, and GLS Italy's rule covers it too.

## Limitations

- No instants, estimate, weight, pickup point or proof of delivery.
- Failed deliveries and returns have not been seen; their statuses fall to the shared wording
  rules.

## Numbers

Quicksilver's tracker numbers are the letters `QS` and nine digits; an archived lookup on its
tracker shows one through to delivery. `quicksilver-sa-1` suggests the layout with low
confidence, because one public number backs it and GLS Italy's low rule covers any two letters
and nine digits. The adapter sends eight to thirty letters and digits. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

The tracker opens one parcel at `erp.quick-silver.express/v2/tracking/{number}`. The tracking
page on `quick-silver.express/Tracking` reads the number from `tracking_number` and looks it up
on load.

## Testing

`npm run test:carriers:live -- carriers/quicksilver-sa`, with `QUICKSILVER_SA_TRACKING_NUMBER`
and optionally `QUICKSILVER_SA_UNKNOWN_NUMBER` set outside the repository.
