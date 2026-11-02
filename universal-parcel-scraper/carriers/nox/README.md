# nox

nox Germany, formerly nox NachtExpress, Innight Express and TNT Innight, delivers business
consignments overnight. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://trackandtrace.app.nox.express/api/scannungen/{barcode}`, the
   request the tracking page, an Angular app, makes for the barcode in its path. It needs no
   account, cookie, token or browser. The reply is JSON: every scan of the barcode, newest first.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- The tracker matches the whole barcode, in capitals, and answers `[]` for one it does not
  know, which the page reports as unknown. A 403 or a bot check is a challenge, HTTP 429 a rate
  limit, and a 404 or a redirect a moved route.
- Every scan must name the barcode asked; a reply with another barcode's scans is inconclusive.
- Recognition makes the same request.

## Notes

- Scan clocks are wall clocks without an offset, the same the former tracker showed. They are
  dated in Europe/Berlin, a repeated hour as its first occurrence.
- Scans carry only their wording, which stages them. "Zustellung nicht im geplanten
  Zeitfenster" is a parcel left at the branch for a later night, not one out for delivery.
- The reply also carries the shipping date and internal branch and consignment numbers, which
  are not kept.
- The page shows each scan's place and remark only after the recipient's postcode is entered.
  The adapter never asks for it.

## Limitations

- No scan places, delivery estimate or weight.

## Numbers

Its label specification defines the shipping barcode as 24 digits: the client code 22, three
zeros, the sender's seven-digit customer id, the print date as YYMMDD and a six-digit serial.
`nox-1` claims that layout with low confidence, since InPost, bpost, Ciblex and Austrian Post
accept any 24 digits; recognition asks the tracker.

Archived lookups also show barcodes of SWR and 21 digits, with the same eight digits after SWR
and then the print date. Return labels start with RA and the pickup type. Detection leaves both
layouts unclaimed; the adapter takes them when nox is chosen.

The tracker also answers a sender's own barcode of C and 29 digits, which the label specification
does not define and a universal provider names nox for. The adapter takes it; detection leaves it
unclaimed until its layout is known.

nox Austria runs its own tracker and is not covered here.

## Links

The tracker opens one parcel at `/scannungen/` followed by the barcode. The former tracker read
it from a `pBarcode` parameter.

## Testing

`npm run test:carriers:live -- carriers/nox`, with `NOX_TRACKING_NUMBER` and optionally
`NOX_UNKNOWN_NUMBER` set outside the repository.
