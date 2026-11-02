# SAT

SAT is a Ukrainian freight and parcel carrier that moves cargo between its own branches across
Ukraine, from small parcels to pallets, and brings it to the door on request. Tracked through
the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://urm.sat.ua/openws/hs/api/v2.0/tracking/json?language=uk&app=website&number={number}`,
   as the tracking page sends it, without the page's key. It needs no cookie, token or browser.
   The JSON reply has the waybill's current state and its states, oldest first.
2. `retry`: a request that fails to reach the API, or hangs, is sent once more. The first try
   gets half of the budget.

- An unknown waybill is HTTP 200 with `success` `"false"` and error code `PD2`. Another error
  code is inconclusive. A 404 or a redirect is a moved route.
- A waybill whose cargo has not reached a branch yet comes back with an empty `data`. The page
  then says the waybill is made out and SAT waits for the cargo, so the adapter answers
  registered without scans.
- The page reports a written-off waybill (`Списан`) as not found, and so does the adapter.
- The waybill must echo the number asked.
- Recognition makes the same request.

## Notes

- SAT's API documentation makes the key optional for tracking by waybill number. Without it the
  reply carries the current state and the history only, which is all the adapter reads, so it
  leaves out the key the page sends.
- States give a day without a clock, so each scan keeps its day in `local_time`.
- Each state is staged by its code (`statusRef`), the same codes the page reads to light its
  progress bar. The code is the scan's `provider_code`; the Ukrainian wording is its
  description. Cargo issued at a branch and cargo brought to the door have the same wording and
  different codes.
- A scan's location is its town. A state at a branch carries the branch's coordinates as its
  point.
- A parcel waiting at its delivery branch, or collected there, has that branch's name and
  address as its pickup point.

## Limitations

- No scan times, weight, delivery estimate or delivery time.
- SAT reuses waybill numbers, so a number answers for the newest waybill that carries it.

## Numbers

A consignment is tracked by its nine-digit waybill number, which the tracker page writes in
groups of three. Nine digits are shared by many carriers, so no rule claims them. The samples
and their sources are in [`numbers.json`](numbers.json).

## Links

`www.sat.ua/tracking/?number={number}` opens one consignment: the home page's tracking form
sends the number there, and the tracker page looks it up on load and writes the number back in
groups of three.

## Testing

`npm run test:carriers:live -- carriers/sat-ukraine`, with `SAT_UKRAINE_TRACKING_NUMBER` and
optionally `SAT_UKRAINE_UNKNOWN_NUMBER` set outside the repository.
