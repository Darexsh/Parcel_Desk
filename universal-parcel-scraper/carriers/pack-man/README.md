# Pack-Man

Pack-Man is a courier for the Attica basin. Tracked through the search page on its website.

## How it works

1. `direct`: one `GET https://pack-man.gr/anazitisi-apostolis.html?code={voucher}`, as the
   page's own form sends it. It needs no cookie, token, captcha or browser, and the
   server-rendered page has the voucher, its current status and a timeline of every scan, oldest
   first.
2. `retry`: one more read when the first fails to reach Pack-Man or hangs, inside the budget.

- An unknown voucher is HTTP 200 with the notice "Δεν βρέθηκε αποστολή με αυτόν τον κωδικό",
  which does not name it. A code the page cannot read gets "Ο κωδικός δεν έχει σωστή μορφή",
  which is invalid input. Another notice is inconclusive. A 404 or a redirect is a moved route.
- The page names the voucher it found, which must be the one asked.
- Recognition makes the same request.

## Notes

- The page finds a voucher only with its hyphen, and normalized numbers drop it, so the adapter
  puts it back after the letter.
- Each scan shows its Athens wall clock to the minute, and its `datetime` adds the seconds and an
  offset. The attribute is kept when it reads the shown minute in Athens; otherwise the shown
  clock is read in Athens, an hour repeated when the clocks go back at its first occurrence.
- The scans are Greek wording without codes, mapped in [`status.ts`](status.ts), as are the short
  names of the five stages the page explains under its form. The page lists two invoicing steps
  after the delivery. They are billing, not the parcel's movement, so the adapter leaves them out
  and the delivery stays the newest scan.
- The remark under each scan is the back office's, such as "Μαζική Αλλαγή" or "Ολοκληρώθηκε", and
  is not kept.
- The former voucher search on `courier.pack-man.gr` still answers, but the website no longer
  uses it; the adapter does not ask it.

## Limitations

- No location, delivery estimate, weight, service, sender or recipient.
- A non-delivery reason, if the page gives one in a remark, is not kept.

## Numbers

Pack-Man's search page asks for the code from its SMS or receipt and gives an example voucher of
a letter, a hyphen and eight digits; a lookup archived from its former voucher search shows a
real one in that layout. The adapter takes a letter and eight digits, with or without the
hyphen. Without the hyphen, that is also the shape of other carriers' numbers, so no rule claims
it. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The search page is a GET form that sends the code as `code`, so
`pack-man.gr/anazitisi-apostolis.html?code={number}` opens one parcel. The page offers
`pack-man.gr/t/{number}` as the link to share. The former voucher search on
`courier.pack-man.gr` read the number from `r18p01`; archived lookups use that address. All
three are read as links.

## Testing

`npm run test:carriers:live -- carriers/pack-man`, with `PACK_MAN_TRACKING_NUMBER` and
optionally `PACK_MAN_UNKNOWN_NUMBER` set outside the repository.
