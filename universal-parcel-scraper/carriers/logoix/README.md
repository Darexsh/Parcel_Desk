# LogoiX

LogoiX in Freilassing gives private and business customers a delivery address in Germany,
forwards their parcels and books shipments with partner carriers across Europe, which take
them to the door. Tracked through its tracker's page.

## How it works

1. `direct`: one `GET https://www.logoix.com/cgi-bin/tnt.pl?q={number}`, as the site's Track &
   Trace form sends it. No cookie, token, key or browser is needed. The ISO-8859-1 page has the
   service the parcel travels under, LogoiX's own scans, oldest first, and, once LogoiX has
   handed the parcel over, the transport partner with its own number.
2. `retry`: when LogoiX cannot be reached or hangs, the read is sent once more. The first try
   gets half of the budget.

- An unknown number is HTTP 200 with `unbekannte Sendungsnummer` under the heading, and a
  number whose history the tracker no longer has gets `keine Daten gefunden`. Both are not
  found. A redirect or a 404 is a moved route.
- The heading and the line under it must name the number asked.
- The tracker asks for a pause of about ten seconds between lookups from one address, with
  HTTP 429 and a countdown, which is read as a rate limit for that long.
- Recognition makes the same request.

## Notes

- Scan clocks are LogoiX's wall clock to the minute without a zone, and are read as Berlin
  time.
- The scans carry no code; their wordings are mapped. Any other wording goes to the shared
  wording rules. The booking scan has two sentences on separate lines, which are joined.
- Each history page has a hidden row with the time of the lookup and a warning. It is no scan
  and is skipped; shown, the warning is read as a challenge.
- The page loads the partner's history in a second request, which shows more only for the
  recipient's postcode. The adapter does not make it. A DHL partner number whose Identcode
  check digit holds gives `delivery_carrier: 'dhl'`, and a number Austrian Post's adapter takes
  whole gives `austrian-post`, so the partner's own tracker follows the parcel from there. Other
  partners, or several partner numbers on one page, give no hand-off.
- The line under the heading names the service, such as `Schalterversand` or `Nachsendung`,
  which is kept as the service name.

## Limitations

- LogoiX's own scans stop when the partner takes over; the delivery is the partner's to report.
- No location, weight, delivery estimate or provider codes.
- The tracker drops a parcel's history after some years and then answers `keine Daten
  gefunden`.

## Numbers

LogoiX's parcel number is LIX followed by ten digits, seen in archived lookups on its tracker
from 2010 onwards. `logoix-1` claims it with high confidence. The all-zero number is a
placeholder the tracker answers with unrelated scans, so the adapter refuses it. The partner's
number on the page belongs to Austrian Post or DHL. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracker opens one parcel from its `q` parameter, which the site's search form sends.

## Testing

`npm run test:carriers:live -- carriers/logoix`, with `LOGOIX_TRACKING_NUMBER` and optionally
`LOGOIX_UNKNOWN_NUMBER` set outside the repository. The tests pause between lookups.
