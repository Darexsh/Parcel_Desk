# TWS Express Courier

T.W.S. Express Courier is a courier from the Milan area that works with SDA, Poste Italiane's
express arm. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://tsmbe.it/extracking/trackingStatusLdv` with the bare waybill as a
   `text/plain` body, as the tracking page on `mytws.it` sends it. It needs no cookie, token, key
   or browser. The JSON reply has `stato` `OK` and the waybill's legs, each with its scans oldest
   first.
2. `retry`: a lookup that fails to reach the service, or hangs, runs once more within the
   budget. The first try gets half of the budget.

- A waybill the tracker does not have is HTTP 200 with `stato` `WARN` and the error
  `Errore, ldv non trovata`: not found. Another `WARN`, `KO` or `ERR` is the service's own
  failure, which the page asks to retry later, so it is inconclusive.
- A 403 or a bot check is a challenge, a 429 is rate limited, and a redirect or a 404 is a
  moved route.
- Each leg must name the waybill asked, alone or with a `/1` suffix; the reply's parcel record
  names none.
- Recognition makes the same lookup, for TWS's own waybills only.

## Notes

- A waybill can have several legs: the waybill itself, then `{number}/1` when the parcel goes
  out again after being held at the branch. The page lists them one after the other, and the
  adapter merges their scans into one history, newest first.
- Scans of a single parcel, which name its code, are listed apart on the page. The adapter
  keeps them only when the shipment has no scans of its own.
- Each scan's `data` and `ora` are Italy's wall clock to the second, with no zone, so they stay
  `local_time`.
- The `codiceStato` stages a scan; the codes are mapped in [status.ts](status.ts). A parcel held
  at the branch keeps the code of the failed attempt that led to it, with `GIACENZA` in its
  wording, and is an exception. `CONSEGNE PARTICOLARI` follows a round that delivered nothing
  without saying what happened, so it has no stage.
- The newest leg's `eta`, which the page does not show, is the expected delivery day until the
  parcel is delivered.
- Scans name a two-letter branch code rather than a place, so they have no location. The
  signer's name, the scan notes, the sender's delivery note and order numbers and the parcel
  count are not kept.
- The reply names no partner and no other carrier's number, so there is no hand-off.

## Limitations

- No location, weight, service or delivery instant with a zone.
- Older waybills drop out of the tracker, which then answers as for an unknown waybill.

## Numbers

TWS's waybills are thirteen characters: `28`, four digits, a letter and six digits, or thirteen
digits in older lookups. Archived lookups on its tracker and complaints answered by the company
or by senders show them. `tws-express-1` suggests TWS at low confidence for the lettered layout,
which SDA's own waybills also use and Poste Italiane's SDA rule suggests too; recognition
decides. The all-digit layout is shared by many carriers and stays unclaimed.

TWS also delivers Poste Delivery Business parcels for Poste Italiane, and its tracker follows
their `1UW` waybills. Complaints about TWS quote them. They stay with Poste Italiane's rule
because Poste's tracker follows them too, and TWS's recognition does not claim them; the
adapter tracks one filed under TWS. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracking page on `twsexpresscourier.it` builds `mytws.it/tracking-status;ldv={number}`,
and senders send that address to their customers. The older tracker opened one parcel at
`twsexpresscourier.it/Ricerca.aspx?ldv={number}`. The library reads the number from both.

## Testing

`npm run test:carriers:live -- carriers/tws-express`, with `TWS_EXPRESS_TRACKING_NUMBER` and
optionally `TWS_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
