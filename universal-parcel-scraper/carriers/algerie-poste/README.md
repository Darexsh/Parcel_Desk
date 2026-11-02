# Algérie Poste

Tracks Algérie Poste's EMS items, its own and those other posts send to Algeria, through the
tracker of its express subsidiary, EMS Champion Post Algérie, at ems.dz.

## How it works

1. `direct`: one `GET https://ems.dz/track/index.php?icd={number}`, the page the site's tracking
   forms open for one number. The site renders it on its server. It needs no account, cookie,
   token, key or browser.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- The page names the number in its heading, which must be the whole requested number, then lists
  the scans newest first, each with a wording, an office and a date.
- For a number it holds nothing for, the page shows the same heading over an empty timeline,
  without a notice, so an empty history is inconclusive, never not found. Recognition makes the
  same request: it confirms a known item but cannot rule a number out.
- A 403, a firewall page or a bot check, even with HTTP 200, is a challenge, a 429 a rate limit
  and a 503 maintenance. A 404, a 410 or a redirect is a moved route.

## Notes

- A scan's date is its office's wall clock to the minute, or the day alone: the histories of
  Algérie Poste's own `EY` items give days only. The page gives no zone, and the history of mail
  from abroad mixes the sending post's clocks with Algeria's, so every scan keeps its date as
  `local_time`.
- Mail from abroad carries the sending post's scans, under its offices' UPU codes.
- The page lists some scans twice, which the adapter keeps once. A row can have an office and a
  date but no wording; it is kept without a stage.
- Above a delivered EMS item's timeline, the page repeats the delivery and its date. The adapter
  reads the timeline only.
- EMS Champion Post Algérie's Android app (`com.noteasy.ems`) opens the site's mobile page in a
  web view. Its form opens `ems.dz/track/mobile.php?icd={number}`, which shows the same timeline.
- Algérie Poste's own site, poste.dz, does not answer from outside Algeria.

## Limitations

- The page has no ETA, weight, service, destination or delivery instant with a zone.
- Registered letters and parcels quoted in public reports, from abroad or of Algérie Poste's own,
  were not found on the tracker, while EMS items were. Older items drop out of its records
  unevenly.

## Numbers

Algérie Poste's international items carry UPU S10 numbers ending in `DZ`. Some of its `EY` items
do not carry a valid S10 check digit, and the tracker shows them all the same. EMS Champion Post
Algérie also gives domestic express items `EC`, `ED` or `ET` and eleven digits, as its tracking
forms' examples show. The adapter takes S10 codes from any post with a valid check digit,
Algérie Poste's own codes ending `DZ` without one, and those domestic numbers; anything else is
invalid without a request.

The issuer of an S10 code does not establish who delivers it, so detection keeps codes ending
`DZ` with the generic postal carrier. `algerie-poste-s10`, at low confidence, makes preflight ask
Algérie Poste about them, and `algerie-poste-ey` about its `EY` codes without a valid check
digit, which Chronopost's broad rule matches too. `algerie-poste-1` suggests Algérie Poste for
the domestic numbers with low confidence; La Poste's broad rule for two characters and eleven
digits matches them too. Mail from abroad reaches Algérie Poste when a caller names it, a
provider names it, or a result gives Algeria as the destination of an S10 item. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

The EMS Champion Post Algérie tracker reads a number from `icd` on `ems.dz/track/index.php`, so
one item opens at `ems.dz/track/index.php?icd={number}`. An earlier version read `icd` on
`track.ems.dz/track.php`; that host no longer answers.

## Testing

`npm run test:carriers:live -- carriers/algerie-poste`, with `ALGERIE_POSTE_TRACKING_NUMBER` set
outside the repository to an item the tracker knows. Optionally set
`ALGERIE_POSTE_INBOUND_NUMBER` to an EMS item from abroad and `ALGERIE_POSTE_UNKNOWN_NUMBER` to a
number the tracker holds nothing for.
