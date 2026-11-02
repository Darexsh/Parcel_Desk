# Matkahuolto

The Finnish parcel network of bus stations, pickup points and lockers. Tracked through the
service its tracking page calls.

## How it works

1. `direct`: one `GET https://wwwservice.matkahuolto.fi/search/trackingInfo?language=en&parcelNumber={number}`.
   Matkahuolto's tracking page asks this service when it opens; it needs no cookies, key,
   account or browser.
2. `retry`: one more try when the request fails to reach Matkahuolto or hangs. The first try
   gets half of the budget.

- The reply names the number it found, which must be the requested one. An SSCC may come back
  with or without its `00`. Any other number is `SchemaError`.
- A number Matkahuolto does not know, malformed ones included, returns `{"notFound": true}`
  with HTTP 200: `NotFoundError`. Any other `notFound` reply, or a parcel without scans, is
  inconclusive. HTTP errors, redirects, an AWS WAF challenge and malformed replies keep their
  own failure kinds.
- Recognition makes the same request for Matkahuolto's own `MH` and `MA` numbers and for SSCCs,
  not for a post's S10 items, which it delivers for other posts too.

## Notes

- English is asked for because the page words every scan in English then. A changed pickup
  point still gives its reason in Finnish.
- Scans carry wording and no code. The map reads the wording, by its opening words where the
  scan goes on to name a terminal, a point or a date. Wording it does not know goes to the
  shared wording rules. A message to the recipient about the arrival keeps the stage of the
  scan before it.
- Times are Finnish wall clocks without an offset and are kept as local times.
- A scan's place is kept when it is a town, without its postcode, or a pickup point, parcel
  locker or outdoor locker with its name and street. Anything else could be an address. The
  point named by the scan that made the parcel ready for pickup is the pickup point while it
  waits there and once it is collected there.
- The product category is the service name, unless it says the parcel was paid in cash.
- Sender and receiver references, the departure station, scan coordinates, extra services and
  the last day for pickup are not read.

## Numbers

Lookups archived from Matkahuolto's tracker and parcels a shop listed show its own numbers,
`MH`, nine digits and `FI` (sometimes typed in lower case), and `MA` followed by nineteen
digits, as well as SSCCs with or without their `00`. The adapter takes those, and also partner
posts' S10 numbers, which the tracker shows; anything else is invalid without a request.

The `MH` numbers follow the UPU S10 layout with Finland's code and a valid check digit, so
detection keeps them with the generic postal carrier. Posti's tracker does not know them and
Matkahuolto's does, so `matkahuolto-2` makes preflight ask Matkahuolto first. `matkahuolto-1`
offers the `MA` layout at low confidence, since Matkahuolto does not describe it. When its
digits eleven to thirteen are `000` it also fits an Australia Post article ID, but only if a
merchant location ID began with `MA`, so Australia Post's rule leaves it to recognition.

An SSCC names whoever issued it rather than the carrier. The SSCCs Matkahuolto's tracker has
answered carry Swedish (73) or Finnish (64) GS1 company prefixes, so `matkahuolto-3` and
`matkahuolto-4` suggest Matkahuolto for those, with and without the `00`, when the check digit
passes. Other carriers share the shape, so recognition must confirm it.

## Links

Matkahuolto's tracker at `matkahuolto.fi/seuranta` reads the number from its `parcelNumber`
parameter, as do its English `/tracking` and Swedish `/uppfoljning` pages; the tracker builds
such links itself for related shipments. The library reads all three.

## Limitations

- No delivery estimate, weight, sender or offset timestamps.
- Home deliveries, failed attempts and returns have not been seen on the tracker; their
  wordings are left to the shared wording rules.
- The tracker forgets old parcels, which then return the not-found reply.

## Testing

`MATKAHUOLTO_TRACKING_NUMBER=... MATKAHUOLTO_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/matkahuolto`
