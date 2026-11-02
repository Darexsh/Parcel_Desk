# GLS Switzerland

GLS parcels in Switzerland and Liechtenstein, tracked through the GROUP
recipient service behind `gls-group.eu`. This folder holds the shared GROUP
implementation (parser, status map, URL builders); [gls-de](../gls-de/README.md)
imports it unchanged. [gls-fr](../gls-fr/README.md) uses a separate French
endpoint. `gls-group.eu` links are routed by country path (see each `carrier.json`).

## How it works

`direct`, up to two GETs under `https://gls-group.eu/app/service/open/rest/GROUP/en`
(15 s timeout, 1 MB cap), with the frontend's `caller=witt002` and `millis` params.
A request that fails to reach GLS, or hangs, is sent once more: until then a
request gets at most half of the time left, so the retry fits in the rest.

1. `rstt029?match={number}`: anonymous overview. Progress bar, status and
   delivery owner, no history. It also translates a Track ID into the numeric
   parcel number the detail call needs. A Track ID is 8 characters, or the 6
   letters of a notification card. Without a stored postcode, this is the whole
   result.
2. `rstt028/{parcelNumber}?postalCode=…&tuOwnerCode=…`: detailed history, gated
   by the recipient postcode. `tuOwnerCode` is the overview's `REQUEST` owner.

A 404 with GLS's own `lastError` code means "no such parcel" and raises
`GLSSwitzerlandTrackingError` (a `NotFoundError`; gls-de narrows on it with
`instanceof`, so keep the class): `E000` for an expired parcel or `E206` for an
unknown number on the overview, and `E000` on the detail. `E609` or `E800` on
the detail is a postcode that does not match the parcel the overview found: an
`input_required` error for the postcode with reason `postcode_mismatch`, so the
owner is asked to correct it rather than told the parcel is unknown. Any other
404 is inconclusive, and a 400 or 403 can be a challenge, so it stays an
upstream error.

## Notes

- A GLS parcel number is 11 digits, printed with a check digit as a 12th
  (weights 3, 1, 3, … from the right, plus one). Nine other carriers share
  the 12-digit shape, so detection offers GLS for it only when that digit
  passes. GLS numbers are never 13 or 14 digits.
- Identity: the parcel must echo the number on `tuNo`, `trackId`, `trackingId`
  or a track/parcel reference. A 12-digit printed number may come back as its
  first 11 digits (documented in GLS ShipIT), so that alias is accepted by exact
  prefix only. A Track ID is not echoed, so a single result is accepted. Two
  matches are ambiguous; none is a different shipment.
- Swiss Post last mile: when the overview names owner `DELIVERY`/`CH01`, the
  result carries `delivery_carrier: 'swiss-post'`. The detail response omits
  the owner, so the overview's reference is merged back in.
- Status comes from the progress-bar code, then the newest classified event.
  The displayed text is the newest event's wording, because the heading text
  goes stale (a locker drop reads "Delivered" while the parcel still waits).
  `DELIVEREDPS` is `ready_for_pickup`. `retourFlag` forces a return.
- Codes beat wording: codes are stable across languages. Rows without a code use
  wording rules ordered negatives first, then `core/status`'s multilingual
  classifier. A row keeps its event number as `provider_code`, not its status
  code, so the app's review asks those wording rules alone (`statusMap`).
- "The parcel has not been handed over to GLS." is `registered`: GLS knows of
  the parcel but does not have it. It is checked before the "handed over to
  GLS" acceptance.
- Scan date and time arrive as separate offset-less fields and are read in
  `Europe/Zurich` (gls-de relabels the timezone only).
- The estimate is dropped once the parcel is delivered or in exception.
- While the parcel waits at a ParcelShop, its `parcelShop` object, the one the
  tracking page prints, gives the pickup point: the shop's name, then its
  street and town on their own lines. Without it, the scan that names the shop
  gives the name alone. The shop's id and opening hours are not read. A
  delivered parcel has none, collected there or not.
- `recognizes(number)`, the adapter's `recognize()`, reads the overview alone.
  It takes the overview's not-found codes as an unknown number and keeps any
  other failure one. Carrier recognition uses it, and the user is then asked
  for the postcode.
- The postcode is a tracking credential: sent only to `rstt028`, never to the
  overview, never logged. Scan locations keep ParcelShop name, country and
  city; the street and postcode in the same `address` object are dropped, as
  are recipient, phone, signature and references.

## Rejected approaches

- Scraping the tracking page — the frontend's own JSON endpoints are simpler.
- Asking for the postcode before the overview — the overview must run first to
  resolve a Track ID and read the Swiss Post handoff.
- Sending the postcode to the overview — it has no use for it.

## Limitations

- No history without the postcode, which is why the carrier declares it as a
  required input.
- GLS Germany recognizes the same numbers through the same overview.
  Recognition chooses this network when the caller's country is Switzerland or
  Liechtenstein, and otherwise GLS Germany, whose tracker also takes postcodes
  outside Switzerland. Group-wide `/EU/` and `/GROUP/` links go there too,
  this carrier's own portal links included. A Swiss parcel also lands here
  through a `/CH/` link or by picking it.

## Testing

`npm run test:carriers:live -- carriers/gls-ch` (no env vars;
checks that a retired published example and a wrong number both return a clean
404). Fixtures are constructed in the endpoint shapes with synthetic values.
