# GLS Germany

GLS parcels in Germany. Same GROUP recipient service as GLS Switzerland, so the
parser, status map and URL builders are imported from `../gls-ch/`; see
[gls-ch](../gls-ch/README.md) for the endpoints, identity checks and status
handling. This folder only adds what differs. [GLS Poland](../gls-pl/README.md)
and [GLS Austria](../gls-at/README.md), whose pages ask the same service, point
`tracking.adapter` here.

## How it works

`direct`, always two requests, because the postcode is required here: the
`rstt029` overview, then `rstt028` with the parcel number, postcode and
`REQUEST` owner code. The overview's identity is validated before the postcode
is sent, so a wrong or expired number never transmits it. A request that fails
to reach GLS, or hangs, is sent once more, as in gls-ch.

## Notes

- A GLS parcel number is 11 digits, printed with a check digit as a 12th
  (weights 3, 1, 3, … from the right, plus one). Nine other carriers share
  the 12-digit shape, so detection offers GLS for it only when that digit
  passes. GLS numbers are never 13 or 14 digits.
- HTTP 404 is a not-found when the body has GLS's `lastError: E000` for an expired
  parcel or `E206` for a number it does not know. On the detail request, `E609` or
  `E800` means the postcode does not match the parcel the overview found: it is
  an `input_required` error for the postcode with reason `postcode_mismatch`, as
  on GLS Switzerland, so the owner is asked to correct it. An overview can name
  no owner; the detail request then goes without `tuOwnerCode` and still answers
  for the right postcode. GLS also answers `E609` to a malformed request,
  so gls-ch's tests pin the detail request's shape. Any other code, or a 404 without GLS's reply, is
  inconclusive: the service also returns 404 for challenges, which must not
  look like an expired parcel. Delivered parcels age out of public history and
  then return `E000`.
- The postcode is the recipient's, in any country's format: the GROUP service
  answers for parcels GLS delivers across its network, and this carrier is
  where a GLS parcel from another country is filed. GLS refuses fewer than three
  characters or a symbol as a wrong format (HTTP 400) and answers any other
  postcode that does not match with a 404 error code, as for a wrong one. A
  Swiss or Liechtenstein postcode typed with its `CH-`, `FL-` or `LI-` prefix
  is sent as its four digits.
- The result's timezone is relabelled `Europe/Berlin`. Both services run on
  CET/CEST, so only the label changes.
- `recognizes(number)`, the adapter's `recognize()`, queries the overview on
  the `/DE/en/` variant. It returns false only for a clean not-found and
  rethrows everything else, so an outage never reads as "not GLS". It never
  sends a postcode. Carrier recognition uses it, and the user is then asked for
  the postcode (see [ROUTING.md](https://github.com/plhery/delivery-tracker/blob/main/docs/ROUTING.md)).
- `GLSGermanyTrackingError` keeps its name because
  `testing/expandedCarriers.live.test.ts` asserts it. The constructor also
  accepts a positional timeout.

## Limitations

- Recognition cannot tell a German parcel from a Swiss one. The overview is one
  group-wide service whatever its country path (the path only sets the language),
  and its overview of a delivered parcel names no owner. When both networks
  recognize a number, the caller's country decides: Switzerland or
  Liechtenstein chooses GLS Switzerland, Poland GLS Poland and Austria GLS
  Austria, which are asked about eleven or twelve digits only then. Otherwise GLS Germany
  is chosen: it is the more common network, and its tracker takes any country's
  postcode, so it reaches the history of either network's parcel. Group-wide `/EU/` and
  `/GROUP/` links come here too, as do links to the group tracker's pages for
  countries without a GLS network of their own in the catalog, such as Romania
  or Slovakia, except one whose number alone names a carrier, such as GLS
  France's. GLS Switzerland is also reached
  through a `/CH/` link or by picking it. GLS France still comes first when it
  knows the number, whatever the caller's country: its own tracker answers only
  French parcels, with the history and no postcode.

## Testing

No live test in this folder. `npm run test:carriers:live -- testing/expandedCarriers.live.test.ts`
checks that an expired public number returns `GLSGermanyTrackingError` before any
detail request.
