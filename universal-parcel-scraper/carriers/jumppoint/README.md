# Jumppoint

Jumppoint is a Hong Kong parcel delivery company with its own couriers and a network of pick-up
points, for standard and same-day delivery. Its international parcels track on a separate site.
Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://tracking-api.jumppoint.io/shipment/tracking/?trackingNumbers[]={number}`,
   as the tracking page sends it. It needs no cookie, key or browser. The JSON reply has the
   shipment's state, its expected delivery date and its status log, oldest first.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- The page adds a reCAPTCHA v3 token to each lookup. The service answers a lookup without one,
  or with the empty value the page sends when reCAPTCHA has not loaded, in full, so the adapter
  sends none. A reply refusing a missing or failed token is a challenge.
- An unknown number is HTTP 200 with the number echoed back and no state, which the page
  reports as not found. A 404, a 410 or a redirect is a moved route, and a refusal of the
  request's parameters is a changed request.
- The service rate-limits lookups and says so in `x-ratelimit-*` headers. HTTP 429 is rate
  limited.
- The shipment must echo the number asked. The service matches numbers case-sensitively, so the
  adapter sends them in upper case.
- Recognition makes the same request. A waybill nothing has moved yet has no status log, so
  recognition does not count it as known.

## Notes

- The reply gives every time in UTC. The adapter shows each on Hong Kong's clock with its
  offset, as the page does. The expected delivery date is Hong Kong's midnight of that day, kept
  as the date.
- The state heads the shipment, and the log's rows name the same states. `CONFIRMED` comes when
  a same-day waybill is confirmed and again at the warehouse before delivery; it moves nothing.
  `PASSED_TO_COURIER` comes a second before `ON_THE_WAY_TO_CUSTOMER` and counts as out for
  delivery.
- A row keeps its reason only when it is one of the coded reasons the page words itself, such as
  nobody answering the door. Free-text remarks can name who signed, so they are not kept.
- The courier's phone numbers, the merchant's order number and the pick-up point's phone and
  opening hours are not kept. The pick-up point's name and address are kept while the parcel
  waits there and after it is collected.
- The page can show a number from Jumppoint's international service, which no catalog carrier
  tracks, so there is no hand-off.

## Limitations

- No scan location or weight.
- The tracker also answers merchants' own order numbers, which no rule claims.

## Numbers

Jumppoint waybills are `JP` and twelve digits, the layout its tracker accepts. SHOPLINE's
Jumppoint help shows one on a sample printout, and Jumppoint's Open API documentation uses
others in its examples. `jumppoint-1` claims the layout. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The [tracker](https://tracking.jumppoint.io/) opens one parcel when the number is in its `q`
parameter.

## Testing

`npm run test:carriers:live -- carriers/jumppoint`, with `JUMPPOINT_TRACKING_NUMBER` and
optionally `JUMPPOINT_CREATED_NUMBER` and `JUMPPOINT_UNKNOWN_NUMBER` set outside the
repository.
