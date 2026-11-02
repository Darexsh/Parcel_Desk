# Uzbekistan Post

Tracks Uzbekistan Post items, its own and the S10 items other posts send to Uzbekistan, through
the lookup its tracking page at uz.post makes.

## How it works

1. `direct`: one `GET https://tracking.pochta.uz/api/v1/public/test/{number}/`, as the page
   makes it for the code in its address or field. It needs no account, cookie, token, key or
   browser.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- For an item of the post's delivery system the reply has a `header` naming the item and its
  locations and a `shipox` history with the scans newest first. Every part null is the page's
  "not found". The header must name the whole requested code.
- For an EMS item the tracker answers with the UPU's IPS record: one entry naming the code, with
  the scans of the sending post and of Uzbekistan Post. An EMS item IPS does not know is a 404
  whose reply says `order_not_found`, which is not found; any other 404 or a redirect is a moved
  route.
- A 429 is a rate limit, with the reply's `Retry-After`. A 403 or a firewall page is a challenge.
  Recognition makes the same request.

## Notes

- The delivery system's scans have a status code, Russian, Uzbek and English wordings, an
  instant in UTC and an office. Post-office scans fall in office hours only when read as UTC, and
  the page shows them in the visitor's zone, so they become Tashkent instants. The code sets the
  stage; a code the system gives no wording keeps the code as its description.
- Scans with an `external_id` were copied from the sending post's data. Their clock may be that
  post's wall clock and their office is the one that took the data in, so they keep only the
  wall clock.
- IPS scans carry the office's wall clock. Uzbekistan Post's own also carry a GMT clock, whose
  difference gives the offset; the sending post's stay `local_time`. The page shows an event's
  Russian name, else its IPS name, with the reason customs kept the item or a delivery failed.
- The adapter reads the Russian wordings, as the Russian page shows them. Office names carry a
  postcode, which the adapter drops; it also drops couriers, positions, comments and addresses.
- The reply's `gdeposilka` part, scans an aggregator relays from other carriers, is not read.

## Limitations

- The tracker has no ETA, weight, service or recipient for delivery-system items.
- Older items drop out of the tracker's records and then read as not found.
- The adapter takes only S10 codes with a valid check digit. The tracker also answers marketplace
  and hybrid-mail references, which are not Uzbekistan Post parcel numbers.

## Numbers

Uzbekistan Post prints UPU S10 numbers ending in `UZ`. Archived lookups on its tracker show
items starting `MM`, `LA` and `RX`. The issuer of an S10 code does not establish who delivers it,
so detection keeps such codes with the generic postal carrier. `uzbekistan-post-s10`, at low
confidence, makes preflight ask Uzbekistan Post about them. Mail from abroad keeps the suffix of
the post that issued it, and reaches Uzbekistan Post when a caller names it, a provider names it,
or a result gives Uzbekistan as the destination of an S10 item. The samples and their sources are
in [`numbers.json`](numbers.json).

## Links

uz.post opens one parcel at `/tracking/{number}`, with an optional `ru` or `uz` language
prefix, and older lookups pass the number in the `search` parameter. pochta.uz now sends
visitors to uz.post.

## Testing

`npm run test:carriers:live -- carriers/uzbekistan-post`, with `UZBEKISTAN_POST_TRACKING_NUMBER`
set outside the repository. Optionally set `UZBEKISTAN_POST_INBOUND_NUMBER` to check mail from
abroad, `UZBEKISTAN_POST_EMS_NUMBER` to check an EMS item and `UZBEKISTAN_POST_UNKNOWN_NUMBER` to
check a code the tracker does not know.
