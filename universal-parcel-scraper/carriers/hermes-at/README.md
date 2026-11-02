# Hermes Austria

Hermes Austria is the Hermes network in Austria. Tracked through its own tracker on
`myhermes.at`, apart from Hermes Germany's `myhermes.de` that `hermes-de` reads. Austrian Post
delivers its parcels and Hermes Germany carries those crossing the border; the tracker shows
both legs.

## How it works

1. `direct`: one `GET https://www.myhermes.at/sendungsverfolgung/trackingnummer/{number}/`,
   the page the tracker's form opens. It needs no cookie, token, key or browser. The site
   renders the page on its server, with the parcel's numbers, the recipient's country and the
   scans, newest first.

- An unknown number gets the form with a message under it saying no parcel was found. The form
  alone is inconclusive.
- A bot check's page, which can come with HTTP 200, is a challenge. The site's
  service-unavailable page, or a redirect to it, is maintenance. Another redirect or HTTP 404
  means the route moved, not that the parcel is missing.
- The page must list the number asked. A parcel from Germany can list Hermes Germany's H
  number beside Hermes's parcel number, and either opens it.
- Recognition makes the same request and knows a parcel the page lists. No rule offers Hermes
  Austria, so recognition is not asked about one.

## Notes

- The page prints Vienna's wall clock without a zone: its Austrian scans match the instants
  Austrian Post's tracker gives the same scans. A scan in a country whose clock agrees with
  Vienna's at that moment is read in Vienna; any other keeps its wall clock in `local_time`.
- The adapter reads the German page, whose wordings the status map records. The English page
  at `/en/tracking/` translates them and prints a twelve-hour clock.
- While Austrian Post delivers, the page shows a banner that offers to redirect the parcel on
  Austrian Post's site, with Austrian Post's number for it. That number becomes the hand-off to
  `austrian-post` when Austrian Post's adapter looks such numbers up. The banners seen carry
  Hermes's fourteen-digit number, which Austrian Post's tracker also knows.
- A parcel left in an Austrian Post receiving box is ready for pickup, as Austrian Post's
  tracker records the same scan. A later scan records the recipient taking it out.
- A handover after a scan that sends the parcel back is its return to the sender.
- Only the recipient's country is kept from the details; anything more in the address is
  dropped.

## Limitations

- No weight, no delivery estimate and no pickup point.
- Older scans drop out of the page's history, and a number whose scans are all gone answers
  not found.

## Numbers

Parcels carry Hermes's fourteen-digit parcel number. Archived lookups on the tracker show it
for parcels posted at Austrian PaketShops and for parcels coming from Germany, sometimes beside
Hermes Germany's H number, which `hermes-de` claims. Hermes Germany's checksum rule and the DPD
networks' rules already suggest fourteen digits and nothing in the number names the Austrian
network, so no rule claims it for Hermes Austria and detection does not offer it. The tracker
also answers for twenty-two-digit numbers, the length of Austrian Post's barcodes, which
`austrian-post-1` suggests. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker opens one parcel at `myhermes.at/sendungsverfolgung/trackingnummer/{number}/`, and
the English page at `/en/tracking/trackingnummer/{number}/`. Both are read for Hermes Austria.

## Testing

`npm run test:carriers:live -- carriers/hermes-at`, with `HERMES_AT_TRACKING_NUMBER` and
optionally `HERMES_AT_UNKNOWN_NUMBER` set outside the repository.
