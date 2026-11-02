# La Poste du Sénégal

Tracks La Poste du Sénégal's S10 items, its own and those other posts send to Senegal, through the
lookup the tracking box on its home page makes.

## How it works

1. `direct`: one `GET https://www.laposte.sn/wp-json/lp/v1/track?code=<code>`, as the box on
   laposte.sn's home page sends it. It needs no account, cookie, token, key or browser. The site
   relays the item's record from IPS, the UPU's system.
2. `retry`: a lookup that fails to reach the site, or hangs, is sent once more within the budget.
   The first try gets half of the budget.

- The reply gives `MailItemId`, `MatchFound` and the item's scans, oldest first. The item code must
  be the whole code asked for. No match, which the home page reports as "introuvable", is not
  found. A match without scans is inconclusive, and so is an empty reply, for which the page shows
  its connection error. The page also reports the site's own `not_found` flag as not found; that
  flag has not been seen and could stand for a failed lookup, so it is inconclusive too.
- Recognition makes the same request.
- A 429 is a rate limit, a 403 or a bot check a challenge, and a redirect or a 404 a moved route.
- The tracking page at `/suivi-colis/` asks another route of the site for the same record but
  misreads its fields when it shows them, so the adapter makes the home page's request.

## Notes

- A scan names its IPS event by number, by English name and by the French name the page shows.
  The number sets the stage: IPS numbers its events the same in every post's system. An event the
  map does not know is staged by the shared wording rules from its English name, which they read
  best, and keeps its French one.
- `LocalDate` is the scanning office's wall clock, without a zone, and no relay giving the same
  scans with offsets was found, so every scan keeps its wall clock. Senegal keeps UTC all year,
  so its offices' clocks read the same in the catalog zone.
- An office loses a postcode written in its name and is followed by its country's English name,
  without IPS's "(the)". The reason an item was kept or not delivered, and what happens next,
  follow the event's name. The next office, mail category, signatory and signature are not read.
- The country of an inward scan becomes the destination.

## Limitations

- The tracker has no ETA, weight, service, sender or recipient, and no clock with an offset.
- The adapter takes only S10 codes with a valid check digit. The home page's box sends Jotnaci
  numbers to Jotnaci's own system, whose reply has another shape and carries the recipient's
  details; the adapter does not take them.
- Customs, delivery and the scans of mail from abroad have not been seen live; the map reads their
  IPS event numbers.

## Numbers

International letters and parcels carry UPU S10 numbers ending in `SN`. Generic postal
detection keeps these numbers, and a code ending `SN` with a valid check digit only suggests
La Poste du Sénégal, which recognition asks first.

Jotnaci, the domestic goods service, numbers its items with `JT` and thirteen digits. J&T
Express prints the same layout, so no rule claims Jotnaci numbers either.

## Links

The home page's box and the tracking page show the result in place and have no address for one
item.

## Testing

`npm run test:carriers:live -- carriers/la-poste-senegal`, with `LA_POSTE_SENEGAL_TRACKING_NUMBER`
set outside the repository. Optionally set `LA_POSTE_SENEGAL_UNKNOWN_NUMBER` to check a code
without a match.
