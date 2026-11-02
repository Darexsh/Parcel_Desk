# M-ONE

M-ONE is the parcel courier of Serbia's Milšped group. It delivers in Serbia to the door and to
its parcel lockers. Tracked through the lookup the tracker on its home page makes.

## How it works

1. `direct`: one `GET https://api.m-one.rs/api/statushistory/{number}` with
   `Accept: application/json`, as the home page's script sends it. It needs no cookie, token,
   key or browser. The JSON reply is an array with one row per scan, oldest first.
2. `retry`: the same request once more when the first fails to reach the service or hangs. The
   first try gets half of the budget, so the retry fits in the rest.

- An unknown number is HTTP 404 with no content type and a body that never ends. The bounded
  transport gives up on that body after a short look, so the answer comes at once and is read
  as not found. A 404 with a page or JSON in it is a moved route; other paths on the API answer
  HTTP 401 with `TOKEN_MISSING`.
- Every row repeats the number, and every row must name the whole number asked.
- Recognition makes the same request.

## Notes

- Each scan's `datumStatusa` is a wall clock to the second, with no zone; the page shows it as
  it is. The clocks stay `local_time`.
- The scan's code (`ST07`) decides its stage. The tracker words each code from its current code
  table, which M-ONE has reworded: archived replies show the line-haul vehicle where the same
  scans now read local transit.
- The home page shows only the newest status, with the sender, the recipient, the weight and
  the piece count. The API's history is kept with the weight, the destination country and the
  depot some scans name. `posiljalacMesto` and `primalacMesto`, which the page labels as places,
  hold the sender's and the recipient's names and are never read.
- When its lookup fails, the page shows a fixed delivered reply for a sample number. The
  adapter reads only the API.
- The reply names no partner and no other number, so there is no hand-off.

## Limitations

- No instants, estimate or parcel locker name.
- m-one.rs sends its certificate without the intermediate one, so a client that does not fetch
  the missing certificate, such as Node or headless Chromium, cannot open the tracking link. The
  API's own host sends its whole chain.

## Numbers

M-ONE's parcels carry numbers in the UPU S10 layout with Serbia's code, the layout Pošta Srbije
uses, in the P series. Detection names Pošta Srbije for the C, E, L and R series, its own, and
keeps the others postal, where a valid S10 number with that code also suggests M-ONE
(`m-one-s10`) after Pošta Srbije, and recognition asks both. The adapter also takes the letters
RS and twelve digits, the shape of the number in the page's fixed reply. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

The home page reads a number from its bare query string, `m-one.rs/en?{number}`, and opens that
parcel's status. Such a link names M-ONE only for a number of one of its two shapes.

## Testing

`npm run test:carriers:live -- carriers/m-one`, with `M_ONE_TRACKING_NUMBER` and optionally
`M_ONE_UNKNOWN_NUMBER` set outside the repository.
