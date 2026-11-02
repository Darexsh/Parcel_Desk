# Dragon Star Curier

DSC Dragon Star Curier is a Romanian courier network. Tracked through its tracking page's own
lookup.

## How it works

1. `direct`: one `GET https://dragonstarcurier.ro/tracking-awb?awb={number}`. It needs no
   cookie, token, key or browser. The server renders the parcel's page: the number, a progress
   bar, a Status box, the current place and the scans, newest first.
2. `retry`: one more attempt after a failure to reach the tracker, inside the budget.

- The heading and the Delivery details must both repeat the number asked. They repeat it as
  sent: the tracker ignores leading zeros when it looks a number up.
- An unknown number gets the notice "Codul AWB introdus este invalid", which is not found. The
  notice does not repeat the number. "A apărut o eroare", the tracker's notice when its own
  lookup fails, is inconclusive, and so is any other notice. A 404 or a redirect is a moved
  route.
- Recognition makes the same request.

## Notes

- The Status box reads `{phase} - {newest scan}`, as `Returnat - EIA - Exceptie in Asteptare`.
  The phase, a step of the progress bar, gives the parcel's stage; it is the only place the page
  says a parcel is going back to its sender. Without a phase the map knows, the newest staged
  scan decides.
- Some scans start with DSC's code, as `PRL - Preluata`; the code is kept as `provider_code` and
  the rest as the wording. Codes and wordings are in [`statuses.json`](statuses.json); wording
  reads the same with or without diacritics.
- Scan clocks are Romanian wall clocks to the minute with no zone, so they stay `local_time`.
- Each scan's place is the hub or town that scanned it. Wording and places lose phone numbers
  and a clause naming who signed for or took the parcel.

## Limitations

- No delivery estimate, weight, service, sender or recipient, or scan time as an instant.
- No delivered parcel's page was available, so a delivery is read from the Romanian word for
  delivered, `Livrat` or `Livrată`, as its phase or scan wording.

## Numbers

AWB numbers are short bare digit runs: an archived lookup on DSC's former tracker shows seven
digits and a customer's review gives eight. The adapter takes seven to nine digits, so that the
next length also reaches the tracker. Other carriers print the same lengths, so no rule claims
them. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page at `dragonstarcurier.ro/tracking-awb` is a GET form that reads an `awb`
parameter and opens one parcel. The AWB script of the former curierdragonstar.ro site is gone.

## Testing

`npm run test:carriers:live -- carriers/dragon-star-curier`, with
`DRAGON_STAR_CURIER_TRACKING_NUMBER` and optionally `DRAGON_STAR_CURIER_UNKNOWN_NUMBER` set
outside the repository.
