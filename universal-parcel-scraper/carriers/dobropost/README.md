# DobroPost

DobroPost consolidates goods bought on Chinese marketplaces at its warehouses in China and
carries them to Russia and Belarus, where a domestic carrier such as CDEK, Boxberry or Russian
Post takes the last leg. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one
   `GET https://api.dobropost.com/api/tracking/parcel?key={key}&trackCode={number}`, as the
   tracking page's script sends it for a `DBRPST` number. The key is the one that script gives
   every visitor; no cookie, token or browser is needed. The JSON reply has the dispatch and
   recipient countries and the checkpoints, newest first.
2. `retry`: the request once more when it fails to reach the service or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- An unknown number is HTTP 404 with `"Parcel with trackCode - {number} not found"`, read as not
  found when it names the number asked. Any other 404 is a moved route.
- A key the service does not accept is HTTP 403 with `"Forbidden"` and a Java stack trace, which
  is inconclusive (`session_rejected`), not a missing parcel.
- The found reply does not repeat the number. The service matches only the whole number, in
  any case: a number with a character added before or after it is not found. The request binds
  the reply to the number.
- Recognition makes the same request.

## Notes

- Every checkpoint's `date` carries Moscow's offset, as the backend writes every instant. Its
  China warehouse scans read as China's working day at that offset, so the dates are kept as
  instants and the offset is not taken from the place.
- The history is sorted by instant: the reply can list a customs scan or a deleted last-mile
  order out of turn.
- After customs, the tracker relays the domestic carrier's scans: CDEK's and Boxberry's with
  their own codes, Russian Post's operation names without a code. CDEK's wording ends with the
  town in brackets, which becomes the scan's location.
- `statusName` stages a scan; Russian Post's codeless scans are staged by their wording. An
  unknown code takes the tracker's own `statusCategoryId`, except for the categories that mix
  stages. CDEK's on-demand warehouse scan sits in the delivered category but is ready for pickup.
  A paid customs release worded as a return to China is a return.
- The reply names neither the domestic carrier nor its number, and no seller's number, so there
  is no hand-off. It holds no recipient details.
- The page sends numbers that do not start with `DBRPST` to `/api/tracking/shipment`. Those are
  not DobroPost parcel numbers, and the adapter does not look them up.

## Limitations

- No weight (the reply gives only its unit), estimate, place for DobroPost's own scans or proof
  of delivery.

## Numbers

DobroPost's parcel numbers are DBRPST and ten digits, the layout its tracker and forms ask
for; customers quote them in the carrier's own review topic. The prefix belongs to DobroPost
alone, so a high-confidence rule claims the layout. The Chinese sellers' numbers that reach its
warehouses and the domestic carrier's numbers stay with their own carriers. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page reads the number from its `trackNumber` query parameter and looks it up on
load, so that address opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/dobropost`, with `DOBROPOST_TRACKING_NUMBER` and
optionally `DOBROPOST_UNKNOWN_NUMBER` set outside the repository.
