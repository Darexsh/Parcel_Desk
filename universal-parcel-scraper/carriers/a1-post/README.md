# A1 POST

A1 POST is the shipping brand of A1 Trade in Varna, Bulgaria. It sends sellers' parcels abroad,
where a partner carrier delivers them under its own label number. Tracked through the page its
tracker renders for one number.

## How it works

1. `direct`: one `GET https://a1post.bg/track.php?t={number}&l=en`, the page the tracker renders
   on its server for one number. It needs no cookie, token, captcha or browser. The page holds a
   table of rows, newest first, each a clock and a line of text. For a parcel a partner carries,
   a first row without a clock links to the partner's tracker.
2. `retry`: one more read when the first fails to reach A1 POST or hangs, inside the budget.

- The search box on `a1post.bg/en/track/` posts the number to the same address and gets the same
  rows as JSON, without the partner's link. The page is read for that link.
- A number the tracker does not know gets a single row, "Package not found", at the server's
  current time, which is not found. Beside other rows it is a changed page. An empty table is
  inconclusive, a bot check's page is a challenge, and a redirect, a 404 or a 410 is a moved page.
- The page does not repeat the number. The tracker looks up only the whole number, so the answer
  belongs to the request.
- No recognition: the numbers are the partners', and their own detection names them.

## Notes

- A1 POST's own rows say the sender's data arrived and that A1 POST processed the parcel. Their
  clocks are wall clocks to the minute from A1 POST's server, which stamps its not-found row with
  Sofia's current time in summer and in winter, so they are read in Sofia and kept as instants.
  An hour repeated when the clocks go back is read at its first occurrence.
- Archived lookups also show Bulgarian office scans on the way to A1 POST, followed by the office,
  and USPS scans followed by a US place. The office scans are read in Sofia too. A partner's scans
  can carry the clock of their own place, so they, and any row the map does not know, stay wall
  clocks in `local_time`, and the page's order stands. A ZIP code ending a row is dropped.
- The rows are mapped in [`status.ts`](status.ts), in English and in Bulgarian; the page is asked
  in English. A row the map does not know goes to the shared wording rules.
- The linked partner is the delivery carrier when the catalog knows its name, the link is on
  that carrier's host if the catalog lists it, and the link carries one number that carrier's
  rules offer. That number is the delivery tracking number when it is not the one asked; a USPS
  link carries the number asked.
- A USPS routing barcode is asked for without the recipient's ZIP code at its start.

## Limitations

- The page ends at A1 POST's processing. The partner's scans are on the partner's tracker, which
  the delivery carrier points to.
- No delivery estimate, weight, service, sender, recipient or proof of delivery.

## Numbers

The tracker takes the partner's label number. A parcel bound for the United States carries a
USPS label number, which USPS detection names, so A1 POST adds no rule. The adapter takes four to
forty letters and digits, with a digit. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`a1post.bg/track.php?t={number}` opens one parcel: the server renders the page for the number in
its `t` parameter, and an archived lookup on A1 POST's own site uses that address.

## Testing

`npm run test:carriers:live -- carriers/a1-post`, with `A1_POST_TRACKING_NUMBER` and optionally
`A1_POST_UNKNOWN_NUMBER` set outside the repository.
