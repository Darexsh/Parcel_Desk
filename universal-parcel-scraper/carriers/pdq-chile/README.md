# PDQ Cargo Trader

PDQ Cargo Trader is a Chilean transport and distribution company with its own branch network,
carrying business and e-commerce shipments across Chile. Tracked through the lookup its
tracking page makes.

## How it works

1. `direct`: one `GET https://www.pdq.cl/api/tracking?q={number}`, as the tracking page sends
   it. It needs no cookie, token, key or browser. The JSON reply has the shipment's step, its
   estimated delivery day and its scans, newest first.

- The lookup answers only with its own site's `Referer`. Without it, it answers HTTP 403
  `{"motivo":"no-autorizado"}`, which the adapter reports as a challenge. Any User-Agent passes.
- An unknown guide is HTTP 404 with `{"encontrado":false,"motivo":"no-existe"}`, which the
  page reports as not found. A 404 without that reply, or a redirect, is a moved route.
- The shipment must carry the guide number asked.
- A request that fails to reach PDQ is tried once more inside the budget.
- Recognition makes the same request.

## Notes

- Each scan's `fecha` and `hora` are a wall clock to the minute, with no zone. Chile's regions
  do not share one zone all year, so the clocks stay `local_time`.
- A scan's four-letter `codigo` stages it. The page's progress rail places the codes on its
  steps; codes seen only there, on its delivery and delivered steps, fall to the wording rules.
- The shipment's `estado` decides a delivery. When the page's notice asks the recipient to
  collect the shipment at a PDQ office, it is ready for pickup there and that office is the
  pickup point. Otherwise the newest staged scan stands, then the `estado`.
- A scan's detail line, which on a delivery names who received the parcel and the driver, is
  not kept. Neither are the shipper's references, the label locator, the sender's postcode,
  the origin and destination towns, who received the parcel or the freight still to pay.

## Limitations

- No weight, service name or delivery time as an instant.
- The tracker also searches shipper references. A reference shared by several shipments makes
  it ask for the destination commune, the dispatch date or the recipient, or list the guide
  numbers; the adapter asks only by guide number and keeps nothing of such an answer.

## Numbers

PDQ guide numbers are twelve digits: the page tells a visitor whose input has another shape to
search by guide number. Many carriers share that run, so no rule claims them. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

`www.pdq.cl/tracking?q={number}` opens one shipment; the home page search builds that address.

## Testing

`npm run test:carriers:live -- carriers/pdq-chile`, with `PDQ_CHILE_TRACKING_NUMBER` and
optionally `PDQ_CHILE_UNKNOWN_NUMBER` set outside the repository.
