# DealerSend

DealerSend (Dealer Send Logistics) is a Hong Kong cross-border e-commerce forwarder. It takes
parcels in at its facility in Hong Kong, flies them to the destination and hands them to a partner
there, such as GOFO, USPS through an injection partner, or a Canadian partner. The adapter reads
the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://dealer-send.com/myapi/trackings/track?trackingNumbers={number}`. It
   needs no cookie, token, key or browser. The lookup takes several numbers; the adapter asks for
   one.
2. `retry`: the request once more when it fails to reach the tracker or hangs. The first try gets
   half of the budget.

- The reply is an object keyed by the number asked. Null under that key is the tracker's answer
  for a number it does not know, read as not found. A reply keyed by another number, or a shipment
  that names another, stays open.
- A 404, 410 or redirect is a moved route, not a missing parcel. A 403, or a firewall page in
  place of the JSON, is a challenge; a 503 without one is maintenance, and a 429 a rate limit. Any
  other reply that is not JSON is a schema failure.
- Recognition makes the same request.

## Notes

- Rows give a wall clock and no zone. DealerSend's own rows are on the clock of the place they
  name: Hong Kong for its facility and the flight, the destination airport for the landing. The
  partners' rows are on their facilities' clocks. They stay in `local_time`, and Node lookups
  date them by their place or leg. As on the tracking page, rows are listed by wall clock, and a
  row without one is left out.
- A row whose wall clock is ahead of the read even at UTC+14 is held back and named in
  `written_ahead`. With nothing else left, the parcel has no history yet, and its error names them.
- DealerSend's own rows carry a GUID status. The rows it relays keep the partner's numeric code,
  and those codes repeat with other meanings across partners (30 is processing in Canada and out
  for delivery in the United States), so the map reads both by their wording. "Arrived at origin
  facility" is DealerSend's acceptance in Hong Kong, and a US partner's first scan after the
  flight. A partner's acceptance or pickup that no one recorded is the journey going on.
- The shipment lists its partner's numbers. With exactly one other than the number asked, a whole
  USPS package barcode is USPS's `delivery_carrier`. A routing barcode keeps its package
  identifier, or gives nothing when that is unclear, so its ZIP code goes nowhere. GOFO is named
  only when the rows name GOFO and the number fits its layout. Any other number is kept without a
  carrier.
- Places drop the ZIP codes and street numbers in the tracker's place names, and end with the
  row's country code. The landing names the airport, such as "John F. Kennedy", which the
  [hub list](../../places/hubs.json) places at JFK. GOFO's hub in Vernon is listed there as the
  one by Los Angeles, as the gazetteer's namesakes are in other zones.
- The sender's country, the carrier's name and logo, the latest status repeated on the shipment
  and its delivery date, which repeats the last row's clock, are not read.

## Limitations

- No instants, expected delivery, weight, recipient or proof of delivery.

## Numbers

DealerSend's waybills are DSLAF, ten digits and YQ, as archived lookups on its tracking page show.
No other carrier issues the layout, so the rule has high confidence.

## Links

A link to the tracking page with `trackingNumber` opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/dealersend`, with `DEALERSEND_TRACKING_NUMBER` and
optionally `DEALERSEND_UNKNOWN_NUMBER` set outside the repository.
