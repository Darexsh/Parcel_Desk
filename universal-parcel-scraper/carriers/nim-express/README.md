# Nim Express

Nim Express (นิ่มเอ็กซ์เพรส) is a Thai parcel carrier. Its branches pick parcels up from senders
and take them in at drop points, then pass them through sorting centres to the branch that
delivers. Tracked through its tracking page.

## How it works

1. `direct`: one `GET https://www.nimexpress.com/web/p/tracking?h_i={number}`, the page the
   search box on nimexpress.com opens. It needs no cookie, token, key or browser. The server
   renders a card for the number with its timeline, newest first.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- An unknown number is HTTP 200 with the card's `Tracking no. ไม่ถูกต้อง` error and an empty
  timeline, which is not found. A 404, a 410 or a redirect is a moved route.
- The card is headed by the number it answers, which must be the number asked; a card for
  another number is inconclusive and nothing from it is kept.
- The page takes up to twenty numbers at once. The adapter sends one whole twelve- or
  thirteen-digit number.
- The page answers servers outside Thailand.
- Recognition makes the same request.

## Notes

- Each entry's clock is to the second, with a Buddhist-era year. Nim Express scans in Thailand,
  and its lanes to Laos and Cambodia keep the same offset, so clocks are read as Bangkok time,
  +07:00, and give instants and `delivered_at`.
- An entry's wording is its description and stages it. The map reads it without the bill
  number, the pickup day and window or the delivery round, and also covers the wordings an
  earlier version of the page used.
- The branch, centre or drop point under an entry is its location, without the numeric code
  before a branch's name.
- The page echoes the client's IP address in a hidden field and carries a hidden, empty bill
  details table; neither is read. Its script can open a delivery map and COD documents once the
  recipient's phone number is typed. The adapter does not use them.

## Limitations

- No estimate, weight, service, sender or recipient.
- Older bills get the same error as unknown numbers, so they read as not found.

## Numbers

Nim Express bill numbers are thirteen digits: the origin branch's code, the year and month,
and a serial. Archived lookups also show a few of twelve. Many carriers use those shapes, so
Nim Express has no rule and preflight does not ask the adapter. The samples and their sources
are in [`numbers.json`](numbers.json).

## Links

The search box on nimexpress.com sends the number to `/web/p/tracking` in its `h_i` parameter,
and the page fills its tracking form from it. Older lookups used the `i` parameter.

## Testing

`npm run test:carriers:live -- carriers/nim-express`, with `NIM_EXPRESS_TRACKING_NUMBER` and
optionally `NIM_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
