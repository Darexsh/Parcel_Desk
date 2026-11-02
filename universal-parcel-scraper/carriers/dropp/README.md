# Dropp

Dropp delivers online shops' parcels in Iceland, to pickup points, lockers and the door, and
brings parcels from shops abroad to Iceland. Tracked through the lookup the search on dropp.is
makes.

## How it works

1. `direct`: one `GET https://api.dropp.is/dropp/api/v1/dropp/track/json/{number}`, as the
   search on dropp.is sends it. It needs no cookie, token, key or browser. The JSON reply has
   the shipment's barcode, its sender, a flag for a home delivery and the date of each step
   the parcel reached, blank for the others.
2. `retry`: one more try when the request fails to reach the service or hangs. The first try
   gets half of the budget.

- An unknown number is HTTP 200 with a null `barcode` and `store` and no dates, which the search
  shows as "Engin sending fannst með þessum kóða" (no shipment found with this code). A 404 or a
  redirect is a moved route.
- The service matches the number whatever its case and answers with the barcode in capitals,
  which must be the whole number asked.
- Recognition makes the same request.

## Notes

- The tracker page that `api.dropp.is/dropp/track/{number}` opens shows the same steps, but
  answers an unknown number with a generic "try again later" error, so the adapter reads the
  JSON lookup instead.
- Dropp's API documentation lists a tracking read,
  `GET /dropp/api/v1/dropp/tracking/json/{number}/{language}`, that needs no key either. Its
  steps carry labels, but its reply does not name the shipment and is an empty list for an
  unknown number, so the adapter does not read it.
- The reply names each step by a key, such as `warehouse`, which is the event's
  `provider_code`. Its description is the label that documented read gives the step in English,
  such as "Parcel arrived at Dropp terminal". `etakef` is the expected arrival in Iceland, an
  estimate rather than a step, so it is not kept.
- The furthest step reached is the parcel's state, as the page fills its progress rail, and the
  steps are listed newest first.
- `transit` takes the parcel from the terminal to where it is handed out. Dropp's English calls
  it out for delivery, which it is for a home delivery. For a pickup point it stays in transit,
  since the pickup point's own step follows.
- The clocks are wall clocks to the minute, with no zone. The step on the way to Iceland can be
  recorded abroad, and the reply does not say where, so every clock stays `local_time`.
- The sender's name is not kept.

## Limitations

- No location, pickup point, weight or delivery estimate.
- Dropp's order API also knows cancelled and lost orders, but the reply has no step for either.
- The reply names no partner, so a parcel Dropp hands to another carrier has no hand-off.

## Numbers

A Dropp shipment is tracked by the barcode on its package, letters and digits only. Dropp
generates one when the merchant does not send its own order id, and its API documentation gives
no fixed layout, so no rule claims Dropp numbers. The adapter takes letters and digits with at
least one digit; the sample and its source are in [`numbers.json`](numbers.json).

## Links

`api.dropp.is/dropp/track/{number}` opens one shipment: the search on dropp.is links each
result there, and an archived lookup on Dropp's host uses that address.

## Testing

`npm run test:carriers:live -- carriers/dropp`, with `DROPP_TRACKING_NUMBER` and optionally
`DROPP_UNKNOWN_NUMBER` set outside the repository.
