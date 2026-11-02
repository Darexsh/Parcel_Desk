# Belpost

Tracks Belpost items, its own and the S10 items of other posts, through the lookup its tracking
page makes.

## How it works

1. `direct`: one `POST https://api.belpost.by/api/v1/tracking` with `{"number":"{number}"}`, as
   the page's form sends it. It needs no account, cookie, token, key or browser.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- The reply's `data` holds one entry naming the code, with its scans newest first. An entry
  without scans is the page's "no data on this tracking number yet", which is not found. A reply
  without the entry is inconclusive. A 422 that faults the number is invalid input; another 422
  is a changed request. A 429 is a rate limit, with the reply's `Retry-After`. A 403 or a firewall
  page is a challenge. A 404 or a redirect is a moved route.
- The entry must name the whole requested code. Recognition makes the same request.

## Notes

- Each scan has a numeric code, the system that reported it, a wall clock, an office and a
  wording. Belpost's own scans are `internal`; those of the post that sent the item, and Belpost's
  office of exchange, come as `external`. Both use the same wordings under different codes, so
  the wording sets the stage, unknown wording goes to the shared rules, and the code is kept.
- A scan's `created_at` is the scanning office's wall clock to the second, with no zone. The
  sending post's scans keep its own country's clock. The reply's `timestamp` reads every clock as
  Minsk time, so the clocks stay `local_time`.
- The wording is Russian whatever language the page asks for. The adapter sends `hl: ru`, as the
  Russian page does.
- The page shows each office's index next to its name; the adapter keeps the name only.
- The tracker limits each address to a few lookups a minute, then answers 429 with a
  `Retry-After`.

## Limitations

- The tracker has no ETA, weight, service, origin, destination, recipient or delivery instant
  with a zone.
- Older items drop out of the tracker's records and then read as not found.
- The adapter takes only S10 codes with a valid check digit.

## Numbers

Belpost's tracker takes only UPU S10 numbers: two letters, nine digits and two letters, as its
form and its own format check require. Archived lookups on belpost.by show its own items ending
`BY` with several service prefixes, among them `BP`, `BV`, `VV`, `PE`, `CP` and `RR`. The adapter
takes S10 codes from any post with a valid check digit; anything else is invalid without a
request.

A code ending `BY` is Belpost's, but the issuer of an S10 code does not establish who delivers
it, so detection keeps such codes with the generic postal carrier. `belpost-s10`, at low
confidence, makes preflight ask Belpost about them. Mail from abroad keeps the suffix of the post
that issued it, and reaches Belpost when a caller names it, a provider names it, or a result gives
Belarus as the destination of an S10 item. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracking page reads the number from its `number` parameter and looks it up when it opens,
so `belpost.by/Otsleditotpravleniye?number={number}` opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/belpost`, with `BELPOST_TRACKING_NUMBER` set outside the
repository. Optionally set `BELPOST_INBOUND_NUMBER` to check mail from abroad and
`BELPOST_UNKNOWN_NUMBER` to check a code the tracker does not know.
