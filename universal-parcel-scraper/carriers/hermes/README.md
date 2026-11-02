# Hermes Einrichtungs-Service

Two-man delivery of furniture and white goods into the home by appointment, in Germany. A
different company and tracking system from Hermes Germany's parcel network
([`hermes-de`](../hermes-de/)).

## How it works

1. `direct`: one anonymous `GET https://myhes.de/api/request/auftragsdaten?parcelNumber=…`
   keyed on the Lieferschein (delivery-note) number.
   - The echoed `lieferscheinnummer` must match (spaces, dots and dashes stripped, uppercased),
     so a neighbouring order is never shown under the wrong parcel.
   - The lookup also takes a piece's 20-digit SSCC (`kollinummer`), as myhes.de's own page does.
     The reply then echoes only the order's delivery note, so a valid SSCC is the one number
     accepted without an echo. `canonical_tracking_number` is then the order's delivery note,
     an identifier different from the piece's SSCC, not a normalized form of it. A long number
     the service does not take comes back as HTTP 400 with a `kollinummer` validation error,
     which does not tell an unknown number from a malformed one.
   - A valid but unknown number returns HTTP 200 with a synthetic order whose `auftragId`,
     `auftragsart` and `statusjourneyDto` are all `null`. That is not-found; accepting it
     would create a parcel stuck at pending forever.

## Notes

- Only `auftragstatusdaten` (the customer timeline the carrier's UI renders) is read. The
  internal `statusdaten` stream has duplicate scans, other identifiers and non-customer
  wording, and runs ahead of the customer timeline — merging it would announce delivery early.
- The numeric `sendungsstatusId` is the authority; German wording is a fallback for unknown
  ids. Return and cancellation wording ("retour", "zurück", "storniert") maps to
  `failed_attempt`, not `returned`.
- Rows missing wording or booking timestamp are dropped; the rest are sorted newest first and
  the newest sets the status.
- Timestamps are kept as sent (`YYYY-MM-DD HH:mm`, no offset); the declared zone is
  `Europe/Berlin`.
- The estimate is `lieferdatum`, with the `lieferzeitfensterVon`–`lieferzeitfensterBis` window
  when both are clock times, else `hesBasicLieferterminZeit`. Once delivered, `lieferdatum` is
  the delivery day, so no estimate is returned and `delivered_at` is the delivery row's time.
- The sender is the name the page shows: the specialist dealer's (`fachhaendler.name`), else
  `shopname`, else `name`. Nothing else in `versenderdaten` is read.
- The number alone unlocks the order, so treat it as a credential: never log it or put it in
  an issue.
- Not used: the appointment/address endpoints on myhes.de — they return the recipient address
  and drop-off permission, which we don't keep. The recipient block and `abstellgenehmigung`
  in the order response are never read.

## Numbers

myhes.de's FAQ gives the tracking number only as 16 to 25 digits, and says each sender sets its
own piece numbers (Kollinummern). Every archived delivery note has the same layout, though: the
year's last digit, the day of the year, six digits, `0000`, then three, five or seven digits. A
low-confidence rule suggests Hermes Einrichtungs-Service for that layout, and recognition asks
myhes.de, since these lengths are shared with other carriers. A piece's SSCC tracks too, but no
rule claims it: its company prefix is the shipper's.

## Limitations

- No scan locations. `depotdaten` names the handling depot, not where the item was scanned, so
  it is not used as a location.

## Testing

`npm run test:carriers:live -- carriers/hermes` (no env vars). It checks the corpus's
delivered order and the empty-order not-found for a wrong number.
