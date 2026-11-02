# ProShips

ProShips is a Bogotá e-commerce logistics company that delivers cross-border parcels in
Colombia, among them MailAmericas parcels from AliExpress orders. Tracked through the lookup its
tracking page makes.

## How it works

1. `direct`: a `GET https://proships.com/tracking/?tracking={number}`, the page the tracking form
   opens, whose script holds the WordPress nonce of its lookup. Then one
   `POST https://proships.com/wp-admin/admin-ajax.php` with `action=get_tracking_info`,
   `tracking_code={number}` and that nonce, as the script sends it. No cookie, key or browser is
   needed. The JSON reply carries the HTML the page shows: the number, the current status and
   the scans, newest first.
2. `retry`: both requests once more when one fails to reach the site or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- An unknown number is HTTP 200 with `{"success":false}` and "No se encontraron paquetes para el
  código" followed by the number, which is read as not found when it names the number asked.
  Any other refusal is inconclusive.
- The plugin answers a nonce it does not accept with the plain text "Error de seguridad", which
  is inconclusive (`nonce_expired`). WordPress answers an action no plugin registers with HTTP
  400, read as a moved lookup.
- The reply echoes the number as it was sent, in any case, and must name the whole number asked.
- The site loads reCAPTCHA for its contact forms; the tracking lookup sends no token.

## Notes

- Each scan's date and minute have no zone, so they stay `local_time`. For MailAmericas parcels
  the scans after the order are MailAmericas' own under ProShips' wording, with the same wall
  clocks.
- The current status decides a delivery, a return or a hold the scans have not reached yet.
- Scans carry no code, place or person. A signatory clause and phone numbers would be dropped
  from the wording.
- No recognition: ProShips delivers parcels under their senders' numbers and has no number shape
  of its own.

## Limitations

- No instants, places, estimate, weight or proof of delivery.

## Numbers

ProShips delivers parcels under the numbers their senders gave them: S10 numbers, MailAmericas
numbers and a SHEIN parcel's 360Lion number. No rule claims them for ProShips: S10 numbers belong
to the issuing network, MailAmericas' and 360Lion's rules claim their own numbers, and no number
shape of ProShips' own is known. The adapter sends eight to forty letters and digits. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

One parcel opens on proships.com under `/tracking` with the number in the `tracking`
parameter, the address the tracking form builds. An older form sent the number in the `code`
parameter. The library reads the number from either parameter.

## Testing

`npm run test:carriers:live -- carriers/proships`, with `PROSHIPS_TRACKING_NUMBER` and optionally
`PROSHIPS_UNKNOWN_NUMBER` set outside the repository.
