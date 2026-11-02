# Redur

Redur is a Spanish parcel and pallet network with its own depots in Spain and Portugal. It
also carries shipments to the rest of Europe and hands them to partners there, such as
Ciblex in France. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: `POST https://redur.es/track-trace/` with the search form's fields, the number as
   `valor`, `buscarpor=NTRACKING` and `idiomausuario=es`. The server renders the result into
   the page. It needs no account, cookie, token or browser. The form keeps an empty
   `g-recaptcha-response` field, but the page no longer loads the reCAPTCHA script; its
   Turnstile widget serves only the contact form.
2. `retry`: a lookup that fails to reach the tracker, or hangs, runs once more within the
   budget. The first try gets half of the budget.

- An unknown number gets the result block marked as an error, with no scans: not found. A
  result block with neither the error mark nor scans has no history yet.
- A 403 or a bot check is a challenge, a 429 is rate limited, and a redirect or a 404 is a
  moved tracker.
- The result block repeats the number it found; it must be the number asked.
- Recognition makes the same lookup.

## Notes

- Scans have a day and a time to the minute with no zone, so they stay wall clocks. Midnight
  marks a scan dated to the day alone: it keeps the day.
- The adapter asks the Spanish tracker. The English one leaves some wordings in Spanish. The
  wordings are mapped in [status.ts](status.ts).
- The page's progress rail ends on `Entregado`. That step sets the current status to delivered
  even when a later scan, such as a collection at the depot, says otherwise. A faded rail is
  not read, and its other steps are coarser than the scans.
- Each scan keeps its wording and depot. The package count is not kept.
- Scans of a partner's leg abroad give the partner's code, such as `Cbl-`, or `Internacional`
  as their place, and the page names no partner number, so there is no hand-off.

## Limitations

- No ETA, weight, service or delivery instant with a zone.
- Older shipments drop out of the tracker, which then answers as for an unknown number.
- The tracker also finds a shipment by its expedition number or by the sender's, the
  partner's or international references. The adapter asks only the tracking number.

## Numbers

Customers quote fourteen-digit shipment numbers in reviews on Redur's Trustpilot page and in
Portuguese complaints, and one review a seventeen-digit number. Bare digit runs are shared
with many carriers and nothing in the number points to Redur, so no rule claims them and
preflight does not ask Redur. The adapter takes fourteen digits and refuses anything else
without a request. Partner numbers, such as Ciblex's, stay with those carriers. The samples
and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page pushes `https://redur.es/track-trace/?idioma=es&buscarpor=NTRACKING&valor={number}`
to the address bar after a lookup, and that address renders the same result.

## Testing

`npm run test:carriers:live -- carriers/redur`, with `REDUR_TRACKING_NUMBER` and optionally
`REDUR_UNKNOWN_NUMBER` set outside the repository.
