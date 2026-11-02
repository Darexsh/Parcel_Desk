# PBT

PBT is a New Zealand express freight network. Its depots collect consignments and move them
between towns across both islands; its former courier business moved to NZ Post. Tracked
through its tracking page.

## How it works

1. `direct`: one `GET https://www.pbt.nz/tracking-result/?consignmentNumber={number}`, the page
   the tracking form opens. It needs no cookie, token, key or browser. The server renders the
   consignment's items, each with its latest status and its history oldest first, then the
   consignment's details.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- The page redirects a number it does not know, or no longer keeps, to the home page's form
  with `hasError=true` and the number, which is not found. A redirect naming another number is
  inconclusive. Any other redirect, a 404 or a 410 is a moved route. A Cloudflare check in place
  of the page is a challenge.
- Before opening the page, the form asks
  `/umbraco/api/consignmenttracking/CheckConsignment?consignmentNumber={number}`, which answers
  `true` or `false`. The adapter skips it: the page answers an unknown number itself.
- The page lists each item of a consignment under the consignment's number and three digits,
  with its own status and history. A consignment number is all of its items; an item number is
  that item alone, and siblings listed with it are left out. A page listing an item of another
  consignment is inconclusive and nothing from it is kept.
- The adapter sends whole numbers only.
- Recognition makes the same request.

After an identified browser challenge, `trawl` opens the same tracking address in the
configured browser service. The carrier parser checks the whole shipment identity.
Definite answers, rate limits and malformed replies do not launch a browser.
Recognition stays HTTP-only.

## Notes

- A row gives a day with a two-digit year and a wall clock to the minute, without a zone, so
  scans stay `local_time`. Rows are put newest first by their clocks: the page's order is not
  always theirs, and a pickup request can be stamped after the pickup.
- An item's heading gives its latest status, which is its current state; an item without one
  takes its newest staged row. A consignment is delivered once every item is. Until then, of
  the items still on their way, the one scanned last says where it is.
- A row's second line names the PBT site that scanned it, which is its location. Any other
  second line, such as the pickup request's reference, is not kept. The name of whoever signed
  for or received an item is dropped from the wording and the heading.
- The weight is the consignment's, so it is kept only when the answer is the whole consignment.
- The towns an item was sent from and to, the item count, the cubic volume, the network moving
  the goods, the senders' references and links in an item's heading are not kept.
- The map covers the wording of the tracker and of the tracking service it replaced.

## Limitations

- No estimate, delivery instant, service, sender or recipient.
- The tracking field also takes senders' references, which the adapter does not send.

## Numbers

PBT's tracker takes ticket and consignment note numbers. Its tracked consignments carry three
letters and seven or eight digits, and each item adds a three-digit suffix; tickets with two
letters and eight digits were also tracked. Other carriers print the same shapes, so no rule
claims them and preflight does not ask the adapter. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracker opens one consignment at `www.pbt.nz/tracking-result/` with the number in
`consignmentNumber`. The library also reads numbers from the former `results.cfm` lookups on
`pbt.com` and `pbt.co.nz`, which took `ticketNo`, and from the former `pbt.co.nz/landing.aspx`,
which took `track`.

## Testing

`npm run test:carriers:live -- carriers/pbt`, with `PBT_TRACKING_NUMBER` and optionally
`PBT_UNKNOWN_NUMBER` set outside the repository.
