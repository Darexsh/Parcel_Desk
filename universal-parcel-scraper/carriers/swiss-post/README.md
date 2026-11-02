# Swiss Post

Swiss Post domestic parcels and inbound international letter-post (`…CH` S10
numbers), tracked through the anonymous API behind the public `service.post.ch`
tracker. A postal item from abroad is handed off here under its own S10 number
when its carrier reports Switzerland as the destination, as is AliExpress/Cainiao
letter-post with a Swiss-issued `L…CH` number
([handoff.ts](../../core/catalog/handoff.ts)). Freight goes to
[swiss-post-cargo](../swiss-post-cargo/README.md) and PostLogistics
track-and-trace to [postlogistics](../postlogistics/README.md).

## How it works

`direct`: four or five calls on one cookie jar under `https://service.post.ch/ekp-web/api`,
each bounded at 10 s. The first four are sent once more if they fail to reach
Swiss Post or hang: until then a call gets at most half of the time left, so
the retry fits in the rest.

1. `GET /user` creates a throwaway anonymous user and returns an `x-csrf-token` header.
2. `POST /history?userId=…` with `{ searchQuery }` returns a search `hash`.
3. `GET /history/not-included/{hash}?userId=…` returns matching shipments.
   An empty array is the clean not-found.
4. `GET /shipment/id/{identity}/events` returns the scans. Optional: if it fails,
   the shipment summary is still returned, marked `summary_only`.
5. `GET /autocomplete/postoffice/id/{site}` returns the record of the office or
   My Post 24 terminal holding the parcel, only while it waits there. Optional:
   if it fails, the parcel has no pickup point.

Event wording comes from `core/rest/translations/{language}/shipment-text-messages`,
fetched once per process and language, and only when there are events. A load
that fails or comes back empty is tried again ten minutes later; until then
events fall back to their own wording, then to the built-in labels. Keys are
dotted patterns with `*` wildcards; the most specific match of the same length
wins, and the `INLAND`/`IMPORT`/`EXPORT` segment comes from the shipment's own
flags.

The table exists in English, German, French and Italian, and the lookup's
`language` picks one; any other language gets English (the tracker itself
answers it with German). Only the table changes: the event and shipment replies
are the same in every language. Stages come from codes, and a revoked scan is
recognised by its sub-event's label in all four. The identity policy in
[app.ts](app.ts) lets a scan reworded in another language take over its stored
row by provider code, instant and location, unless one of the two is revoked.

## Notes

- 18-digit `98`/`99` parcel numbers carry no check digit (identifier, franking
  licence and counter), so detection cannot reject a mistyped one.
- One cookie jar per lookup — the user, CSRF token and hash are only valid
  together, and a shared jar could leak one search's hash into another.
- During an outage any call can answer, even with HTTP 200, with Swiss Post's
  outage page, which only refreshes to `sorry.post.ch`. That answer is
  inconclusive, not a malformed reply or a missing parcel, and the call is not
  repeated.
- Exactly one result must match the number, on `shipmentNumber` or the echoed
  `internationalBarcode` — the endpoint is a search and can return neighbouring
  shipments. None or two matches are refused. Numbers are compared without
  spaces, dots or dashes, so the portal's dotted form matches.
- The newest event code overrides `globalStatus`, which lags: a MyPost24 locker
  deposit (`2102`) reads `DELIVERED` at shipment level while the parcel still
  waits for pickup. When the newest scan has no stage (an enquiry or delay
  note, a recipient's order, an unmapped code, no scans yet), `globalStatus`
  gives it. `statusMap` in [status.ts](status.ts) lists the notes and orders
  left without a stage on purpose. A pickup point may scan its own arrival
  (`1001`, `1100`) after the ready-for-pickup scan (`2101`, `2102`); the parcel
  then stays ready for pickup.
- Codes are classified, not wording. One table serves letters and parcels:
  Swiss Post's own wording table gives each mapped code the same meaning for
  both. Several English wordings mislead: "Completion of customs clearance" and
  "Arrival at the collection/delivery point" are neither active customs nor a
  delivery, and `910` and `2100` "Registered for collection" are pickup notices.
  Unmapped codes get no stage and are left to the sync.
- A wording's `{{valueParameter}}` is filled, as the tracker's page fills it,
  with the scan's `subEventAdditionalInfo`, a collection deadline. A wording
  left unfilled or filled with anything but a date is dropped.
- A shipment sent back reads "Delivered" once it reaches its sender again;
  `globalStatus` `RETURNED` or the `returned` flag turns that into returned. A
  sub-event starting `CAN` ("Revocation") withdraws its scan, which then takes
  no stage.
- While the parcel waits for pickup, the pickup notice in the shipment summary
  (`avis`) gives the site number of the office or terminal holding it, the
  arrival office first, as the tracker's own page reads it. That site's record
  becomes the pickup point: its name, then its street and its town on their own
  lines, as the pickup notice shows them. The record must name the same site.
  A terminal's record can repeat its name in place of a street, which is then
  left out; without a town the name stands alone. The notice's deadlines are
  not read. A delivered parcel has none, collected there or not.
- Weight (sent in grams), measurements (millimetres; most letters have two),
  destination country and delivery time come from the shipment summary. The
  delivery estimate is dropped once the shipment is delivered or returned.
- Timestamps are kept exactly as sent and parsed only to sort (offset-less
  values read as UTC for that comparison), but for the destination post's events
  and those of the origin offices and the pre-advice [clock.ts](clock.ts) lists.
- On a parcel Swiss Post sends abroad (`internationalExport`), the destination post's
  events (codes 901, 902, 909, 918–921, 923, 924, 926, 934, 938) come with no city,
  postcode or country, and carry that office's wall clock under Swiss Post's offset: an
  El Salvador delivery round at 12:26 local came as `12:26+02:00`. UPU's record has the
  same 12:26 at El Salvador's office, and Correos de El Salvador's own tracker dates it
  18:26:18 UTC (checked 2026-10-11). On an item to China, customs (901, 902) came at the
  11:05 and 14:30 UPU gives Beijing's and Hangzhou's offices. They are read on the clock
  of `recipientCountry` when it keeps one. In a country with several, they keep Swiss
  Post's offset, the last guess: hours off, but the reply keeps its instants. The app
  identity policy in [app.ts](app.ts) (`relabelledFrom: 'Europe/Zurich'`) lets a scan
  read on the destination's clock take over the row stored under Swiss Post's offset, by
  wall clock, provider code and location. Swiss Post's own unlocated events (813, 915)
  keep its offset. [clock.ts](clock.ts) lists
  them, and their wording for relays that give no code.
- On a parcel from abroad (`internationalImport`), the origin post's events (`912`, `913`,
  `915`) carry its office's wall clock under Swiss Post's offset too: a departure from a
  London office of exchange came at the 17:57 UPU gives that office, as `17:57+02:00`. The
  reply names no origin to read them in: `senderCountry` was empty, and the barcode's post
  can run an office in another country. So an office is placed by its name: those
  [clock.ts](clock.ts) lists (London's, "LON" and a letter) are read on their own clock,
  and the stored rows move over by the identity policy above. The others keep Swiss Post's
  offset, right for a neighbour on its clock and an hour or more off elsewhere.
- A letter's pre-advice (`859`, "will shortly be handed over") is the notice of a Chinese
  consolidator posting letters in Switzerland through its European hub, on its system's
  Beijing wall clock under Swiss Post's offset: one came at `18:12+01:00` in a reply given at
  13:58 Swiss time. It is read on Beijing's clock whatever `senderCountry` says: the reply can
  name no sender, the hub's country or Switzerland. Senders in Switzerland, for letters and
  parcels alike, give their pre-advice as `600`, which keeps Swiss Post's offset.
- Wording is only trimmed, not whitespace-collapsed, so `core/transport`'s
  `clean()` is not used.
- Scan locations keep the facility's name and number as sent ("Zürich
  Briefzentrum 801050"): the six-digit number is Swiss Post's site number, not
  the recipient's postcode (see [PRIVACY.md](https://github.com/plhery/delivery-tracker/blob/main/PRIVACY.md)). The map
  places known sites by it ([places](../../places/README.md)).
  A scan without a city keeps its explicit country; the carrier's home country is never substituted.
  A scan with neither has no location, even when it carries a number. The reply can list
  one scan twice at one instant, with and without its place; the copy without a place is dropped.
  Recipient name, address, signature and delivery instructions are never read;
  a test asserts it.

## Testing

`npm run test:carriers:live -- carriers/swiss-post` (no env
vars; checks that a valid-shaped unknown number returns a clean 404). The
fixture is constructed in the public result shape with a synthetic number.
