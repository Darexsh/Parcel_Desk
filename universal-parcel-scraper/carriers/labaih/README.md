# LaBaih

LaBaih is a Saudi delivery company for online shops. Its tracker shows each shipment with the
shop that sent it and its events through LaBaih's distribution centres. Tracked through its
tracking page.

## How it works

1. `direct`: one `GET https://track.mylabaih.com/track/en/?cn={number}`, the English version of
   the page the tracking box opens. The site renders it on its server, so the HTML holds the
   heading with the number, the shop, a progress rail and the history, newest first. It needs no
   cookie, token, key or browser.
2. `retry`: one more request after a network failure or a timeout.

- An unknown number is a redirect to `/error/404`, which leads to the tracker's "Shipment(s) Not
  Found" page. Only that redirect is not found; another redirect or a 404 is a moved page.
- The heading must show the number asked.
- A challenge page is a challenge; HTTP refusals keep their kinds.
- Recognition makes the same request.

## Notes

- The adapter reads the English page because the Arabic one leaves out the text message asking
  for the delivery location, and words a return to the facility after an attempt as an arrival
  there.
- Each scan has a wording and a wall clock without a zone, kept in `local_time`. The page gives
  no zone, so the clocks are not read as Riyadh time.
- An arrival at a distribution centre also gives its city, kept as the scan's place.
- A failed attempt keeps the reason after its colon. The page can follow it, after another colon,
  with the district or city as the recipient gave it, which is dropped, and so are phone numbers.
- The tracker shows no codes; [`status.ts`](status.ts) stages the wordings. A return to the
  facility after an attempt stays in transit, as the parcel goes out again from there. The
  messages asking for and giving the delivery location move nothing.
- The shop, the product line beside it, the shop's reference in the heading and the progress
  rail are not kept. The page names no other carrier, so there is no hand-off.

## Limitations

- No estimate, weight, service, proof of delivery or delivery time as an instant.

## Numbers

LaBaih numbers are fourteen digits. Those on its tracker begin with the date and time the
shipment was created. Fourteen-digit numbers are common to many carriers, so no rule claims them;
the adapter takes any fourteen digits and recognition tells LaBaih's from others. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

The tracking box on `mylabaih.com` opens `track.mylabaih.com/track/?cn={number}`, and the page's
English version is `track.mylabaih.com/track/en/?cn={number}`. Both are read as links.

## Testing

`npm run test:carriers:live -- carriers/labaih`, with `LABAIH_TRACKING_NUMBER` and optionally
`LABAIH_UNKNOWN_NUMBER` set outside the repository.
