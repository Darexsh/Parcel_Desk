# Vasp Expresso

Vasp Expresso is a Portuguese parcel network, which also takes parcels to and from Kios stores,
its network of pickup and drop-off shops. Tracked through the lookup its Track and Trace page
makes.

## How it works

1. `direct`: one `GET https://www.vaspexpresso.pt/api/TrackAndTrace?term={number}`, as the
   page's script sends it. It needs no account, cookie, token, postcode or browser. The page
   loads reCAPTCHA, but the lookup sends no token. The JSON reply has the service's number,
   the flags that pick the page's progress rail, the events newest first and the current
   event.
2. `retry`: a lookup that fails to reach the site, or hangs, runs once more within the
   budget. The first try gets half of the budget.

- An unknown number is an empty HTTP 204, which the page reports as `Não existe registo`. The
  service gives the same answer for anything that is not one of its numbers.
- A 403 or a bot check is a challenge, a 429 is rate limited, and a redirect or a 404 is a
  moved route. The service answers a request without a number with HTTP 500 and a stack trace,
  which is inconclusive.
- The reply's `serviceBarCode` must be the number asked, or the volume barcode asked without
  its counter.
- Recognition makes the same lookup.

## Notes

- `eventDate` is the wall clock the page shows, with no zone. Most events also carry a record
  stamp, `createdDateUtc`, about an hour before it in summer, which fits Lisbon time. Events
  from delivery rounds carry the same value in both, so the clocks stay `local_time`.
- The event list can lack the current event the page heads it with, such as a parcel back at
  the depot after a failed round. The adapter adds it to the history when the list lacks it.
- The `eventTypeId` stages each scan and is its provider code. The page's progress rails name
  the Kios steps, which are mapped too. The rails give type 99 a return or a delivery to the
  merchant depending on the service, so it falls to the wording rules, as does any other type
  not mapped. A new delivery day and the recipient's own requests through Track My Parcel move
  nothing. The map is in [status.ts](status.ts).
- The wording is Portuguese, with English as a fallback. An incidence's reason follows its
  wording, as in `Incidência de distribuição: Destinatário Ausente`.
- A scan's place is the Kios store it names, else the depot that read it.
- A volume barcode finds its whole service, whose number becomes `canonical_tracking_number`.
- The client reference, the proof of delivery, which asks for the recipient's postcode, the
  progress rail and the volume counts are not kept.

## Limitations

- No weight, service, sender, recipient or delivery instant with a zone.
- The delivery estimate was empty in every reply seen, so its format is unknown and it is not
  read.
- A shipment of several volumes is read as a whole: a scan of one volume counts for the
  shipment.
- Older shipments drop out of the tracker, which then answers as for an unknown number.

## Numbers

Vasp's Track and Trace page asks for the parcel's number. Its API calls that a service barcode
of thirteen digits; each volume adds a three-digit counter, giving sixteen digits, and the
tracker answers both. Customers quote both in complaints, and returns dropped at Kios points
carry thirteen-digit service numbers starting `904`. Thirteen and sixteen digit runs are printed
by many carriers, so no rule claims them and preflight does not ask Vasp Expresso. The adapter
takes thirteen or sixteen digits and refuses anything else without a request. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

The Track and Trace page reads the number from `?search=` on
`vaspexpresso.pt/pt/geral/track-and-trace/` and runs the lookup, so that address opens one
parcel.

## Testing

`npm run test:carriers:live -- carriers/vasp-expresso`, with `VASP_EXPRESSO_TRACKING_NUMBER` and
optionally `VASP_EXPRESSO_UNKNOWN_NUMBER` set outside the repository.
