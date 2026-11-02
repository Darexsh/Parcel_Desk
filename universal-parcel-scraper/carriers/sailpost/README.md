# Sailpost

Sailpost is a private Italian postal network of franchised agencies that delivers letters,
registered mail, documents for public bodies and parcels. Tracked through the service its app
asks.

## How it works

1. `direct`: one `POST https://svc.sailpost.it/SailpostServices.ashx/TRACKING` with the body
   `{"Action":"TRACKING","Track":"{code}"}`, as Sailpost's Android app sends it. It needs no
   cookie, token, key or browser. The JSON reply has the item's summary and its scans, newest
   first.

- An unknown code is HTTP 200 with `Risultato: true`, the error `Nessun risultato` and no scans,
  which the app and the tracking page report as not found. Any other error, or
  `Risultato: false`, is inconclusive. A 404 or a redirect is a moved route.
- The reply's `Track` and each scan's `CodRaccom` must name the code asked.

## Notes

- The tracking page on `sailpost.it` posts the code to `/ajax/traccia2.php`, which returns the
  same history as HTML with each scan's day alone. The app's service adds the status codes and
  the scans' instants, so the adapter asks it instead.
- Each scan's `Data` is its day, as Rome's midnight with the server's offset. `DataUTC` is its
  instant, kept as Rome's time with its offset. The end of the storage period has only its day,
  with the same midnight in both, so it stays `local_time`.
- `IdStato` stages a scan. The coarse `CodStato` family fills in for a code the map does not
  know, except where a family mixes milestones: the delivered family also holds a return to the
  sender and an act served at the office, and the held family the end of the storage period, so
  an unknown code in them falls to the shared wording rules. An act counts as served ten days
  into storage while the item stays at the office, so that scan has no stage.
- The app links a scan with status 903 to Poste Italiane's tracker under the scan's `TrackVett`.
  The adapter names Poste Italiane and that number when Poste's own detection takes it whole.
- Each scan carries the office's phone, email and coordinates, and the summary the destination
  town, the item's category and Sailpost's contacts. None of them are kept. A position that
  names a party, such as `Mittente`, is not a location.
- HR Parcel, the group's e-commerce parcel service, has its own tracker and entry. The
  `/cerca-spedizione/` page on `sailpost.it` is HR Parcel's lookup.

## Limitations

- No delivered reply was seen, so the delivery's status code is unmapped and the delivery is
  staged by its family and wording.
- No weight, sender, recipient or proof of delivery.

## Numbers

The one public code with a source is a sixteen-digit act. Many carriers use that length and one
sample shows no layout, so no rule claims Sailpost codes and recognition does not ask it. The
sample and its source are in [`numbers.json`](numbers.json).

## Links

The tracking page fills its code field from `?codice=` and looks the code up when it opens, so
`sailpost.it/traccia-il-pacco/?codice={code}` opens one item. The library reads the code from
it.

## Testing

`npm run test:carriers:live -- carriers/sailpost`, with `SAILPOST_TRACKING_NUMBER` and
optionally `SAILPOST_UNKNOWN_NUMBER` set outside the repository.
