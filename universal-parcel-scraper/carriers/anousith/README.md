# Anousith Logistics

Anousith Logistics is a Lao parcel network of branches and sorting centres. A parcel goes from
the branch the sender drops it at to the branch nearest the recipient, who collects it there
or pays for a rider to bring it. Tracked through the GraphQL API its tracking pages call.

## How it works

1. `direct`: two `POST https://pro.api.anousith.express/graphql` requests with a JSON body,
   as the app sends them. `ItemsV2`, filtered on the whole bill, returns the bill's status,
   branches and dates. `ScanItems`, filtered the same way, returns the scans at branches and
   centres, newest first. They need no cookie, token, key or browser.

- The API answers only with `Referer: https://app.anousith.express/`. Without it, it
  redirects to another site, which the adapter reports as a challenge. Any User-Agent passes.
- Each query goes as the app writes it, one field per line and with its `operationName`.
  The API rejects a query on one line, and answers one root field per request.
- An unknown bill is `total: 0` with no rows, which the page reports as not found; the scans
  request is then skipped. A 404 is a moved route. The API sends its errors with HTTP 200,
  which are inconclusive.
- The bill and every scan must carry the number asked.
- Recognition makes the same requests.

## Notes

- Times are ISO instants in UTC. Read in Laos they fall in branch opening hours, and the
  page shows them in the browser's zone.
- The history is the bill's own dates, under the page's labels, with the scans between
  them. A scan at the same instant and place as a date is dropped in favour of the date.
- A bill's status is its `itemStatus`. Arrival at the destination branch is ready for
  pickup. A rider delivery the recipient asks for moves it on, and a bill marked
  `isBackward` is going back to the sender: the scans and dates of that leg are part of the
  return, and its completion is the sender getting the parcel back.
- Branches are named with their province. The pickup point is the destination branch while the
  parcel waits there.
- The queries ask for no names, phone numbers, charges or cash on delivery, although the page
  shows the sender's and recipient's.

## Limitations

- No estimated delivery, proof of delivery or rider details.
- The scans name a sorting or province centre without its province.

## Numbers

Anousith bills have thirteen digits: its public search refuses shorter input. Its tracker
page carries one such number in its share metadata. Thirteen digits are shared by several
carriers and nothing in the number points to Anousith, so no rule claims them, and
recognition never asks it. The sample records are in
[`numbers.json`](numbers.json).

## Links

The public search opens one parcel at
`app.anousith.express/landing/search_tracking/search_item` with the number as `_bill_detail`.
A shared bill opens at `bill_share` beside it, with the number as `tacking_number`.

## Testing

`npm run test:carriers:live -- carriers/anousith`, with `ANOUSITH_TRACKING_NUMBER` and
optionally `ANOUSITH_UNKNOWN_NUMBER` set outside the repository.
