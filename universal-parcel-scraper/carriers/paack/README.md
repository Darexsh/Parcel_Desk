# Paack

Last-mile carrier for online retailers in Spain, Portugal, France, Italy and the UK. Tracked
through the public recipient page, which needs the order number or label barcode and the
delivery postcode. Parcels Paack delivers for Evri International carry a number of Paack's own,
`PK` and 18 digits, which Evri International's tracker answers without the postcode.
SHEIN's Spanish parcels carry SHEIN's package number: `C` or `E`, the order date and eight
digits. Paack's page takes it with the postcode. Ecoscooting delivers other SHEIN parcels in
Spain and other carriers deliver them elsewhere, so that shape only suggests Paack.

## How it works

1. `direct`: one bounded `GET https://mydeliveries.paack.app/tracking/order?tracking_number=…&postal_code=…`
   with `redirect: 'manual'`. The page is a Remix app, so the `routes/tracking.order` loader
   response is already embedded in `window.__remixContext`; reading it avoids a second
   undocumented API call and gives exactly what the page renders.
   - Paack checks the number and postcode as a pair. A wrong pair is redirected back to the
     form with `err=true`; that redirect or an HTTP 404 is not-found.
   - The page is moving to `paack.co/shipments`, and the old host forwards some lookups there
     before checking the postcode. A redirect to the same lookup on a Paack host is followed
     once; any other redirect is `IndeterminateError`, never not-found.
   - "Order not found" / "Incorrect order number or postal code" (and French and Spanish
     variants) in the HTML or loader payload is also not-found.
   - A tracking page is the order for the pair. It does not echo a label barcode:
     `external_id` is then the retailer's own reference, so it is not compared. It does echo
     `delivery_address.post_code`; one that differs from the requested postcode in its letters
     and digits is a `SchemaError`.
   - An empty HTTP 200 is `IndeterminateError`.
   - No postcode on the parcel raises `InputRequiredError`, except for a `PK` number, which
     skips this step.
2. `evri`: for a `PK` number only, one bounded form POST to `https://globaleco.app/track`, the
   tracker [Evri](../evri/README.md) reads, with the number and nothing else.
   - The reply counts only when its **Carrier Tracking** field is the whole number asked and
     its **Carrier** field names Paack. The tracker also answers Evri barcodes and other
     partners' numbers, so any other parcel is a `SchemaError`. "Parcel not found" is
     not-found.
   - With a postcode, `direct` runs first on a first-attempt share of the budget, since only
     Paack's page has instants and the delivery window. Its not-found answers the number and
     postcode pair, so this step still follows it, as it follows a retryable failure.

## Notes

- Most numbers are retailer order numbers or label barcodes with no stable shape, so they have
  no detection rule: a rule would cost precision for every other carrier. Label numbers of
  `5340` and fourteen digits recur in public reports and on parcels Paack's page holds, so
  detection suggests Paack first for them, beside the other carriers whose rules take any
  eighteen digits. Paack is picked
  manually or through a link to its tracker, on `mydeliveries.paack.app` or under
  `paack.co/shipments/tracking`. The rest of `paack.co` is the company site.
- The `PK` numbers from Evri International hand-overs have a rule of their own. They are
  Paack's even though Evri International knows them too: detection offers Paack alone, and an
  aggregator naming the tracker "Global Eco" gives them to Paack. Evri's own result names Paack
  and the number as its delivery partner.
- The postcode is optional in the catalog. A `PK` number needs none, and a saved parcel without
  one is not locked out of every source: universal providers are asked instead. Without it,
  other numbers still raise `InputRequiredError` here.
- The postcode is half of the lookup key, so it is a credential: never log it, commit it or
  put it in an issue.
- Stages come from each entry's stable `id` and `label` (a translation key), never from the
  localized text. Both are reduced to letters and digits and matched by substring, so
  suffixed variants (`scannedAtOriginHeader`) land on the same stage.
- Failure rules run before delivery rules: `notDelivered` contains `delivered`.
- Scheduled returns (`returnToSenderScheduled`, `returnAbsent`, `returnOther`) are
  `failed_attempt`, not `returned`, so a parcel that can still be delivered stays active.
- PaackGo Point (pickup point) steps come from the tracking page's own labels and are matched
  before the generic words they contain. `droppedInPudo` is `ready_for_pickup` and
  `collectedByCustomer` is delivered, not a transit `collected`. A point that is closed, full
  or refuses the parcel (`rejectedByPudo`) is a `failed_attempt` Paack retries. A parcel that
  expires, is refused or goes unpaid at the point (`inPudoToReturn…`) is `returned`.
- While the parcel waits at a PaackGo Point, `pickup_point` is `pudo_name`, then
  `pudo_address` on the following lines, or the name alone. The address is one string Paack
  formats itself; like the page, it is kept as it comes and only broken where it holds a line
  break. A delivered parcel has none, collected there or not.
- The history is `eventList`, the four-step timeline, and `triggeredEventList`, the page's list
  of steps that happened. That list repeats the timeline's steps under the same `uniq_id` and
  adds those kept off the timeline (`timeline: false`): a failed attempt, the new attempt, the
  courier assigned to each run. Steps still to come, without a timestamp, are skipped; the rest
  are sorted newest first and capped at 100.
- A failed attempt can come as `SA014` with no label, matched as the whole code.
  `additionalDeliveryAttemptScheduled` follows it and stays a failed attempt, so the stage does
  not fall back to registered while the new attempt waits. `driverAssigned` reads "Courier
  assigned", once per run. `inProgress`, "being processed by Paack", is in transit.
- `activeEvent` decides the overall status when it maps: the banner can be ahead of the
  timeline. It stays on "Out for delivery" after a failed attempt, so a newer failed attempt,
  courier run, drop-off, delivery or return in the history replaces it. Scheduling notes and
  corrections do not. The history keeps its own per-event stages.
- Event descriptions are our own English wording. Unknown identifiers read "Shipment update".
- Aggregators relay the page's English labels instead of identifiers. `paackScan` maps those
  exact labels for them and stores the same wording as the direct lookup.
- Event times are parsed locally, not with `core/time`: the loader mixes epoch seconds,
  epoch milliseconds and ISO strings with offsets in one field, and the result keeps
  millisecond precision.
- `expected_delivery` is the delivery window, `expected_delivery_ts`, as
  `YYYY-MM-DD HH:MM–HH:MM`. Its ends are instants, and the page shows them on the delivery
  country's clock (the Canary Islands' for Spanish postcodes 35 and 38), so the result does
  too and takes that clock as its `timezone`. A window across midnight, or without an
  offset, keeps only its last day. It is dropped once delivered, returned or in exception, and
  when it ended before the newest scan. A failed attempt keeps it: it is the new attempt's.
- Through Evri International the result is that tracker's: Evri's scans up to the hand-over,
  then Paack's, in Evri's English wording and stages, with locations and the parcel's weight.
  Its clocks have no offset. Paack's, from "Arrived In Country" on, have the digits of
  Paack's own UTC instants to the second, so they become instants. Evri's are kept as
  `local_time`, and the catalog marks Paack's clocks local. It has no delivery window. Sender, destination and comments are never read.
- Retailer, recipient name, e-mail, phone, address and per-event `variables` (which
  interpolate them) are never read; a test asserts it. The PaackGo Point's pickup code
  (`pudo_passcode`), QR link and collection deadline are not read either. The delivery
  postcode is only compared with the requested one. The delivery country, and in Spain the
  postcode's province, only pick the clock.

## Limitations

- Paack's own page has no event locations: events carry only the order's country, not where
  the scan happened.
- No live PaackGo Point reply has been seen; the pickup-point labels and fields come from the
  tracking page's code and translations.

## Testing

`npm run test:carriers:live -- carriers/paack` checks that Paack's own retired API examples
return not-found, and that Evri International answers an unissued `PK` number as not-found.
Set `PAACK_TRACKING_NUMBER` and `PAACK_POSTCODE` to also track a private parcel with every
step mapped and check that another postcode is not-found. Set `PAACK_EVRI_TRACKING_NUMBER` to
track a `PK` number without a postcode.
