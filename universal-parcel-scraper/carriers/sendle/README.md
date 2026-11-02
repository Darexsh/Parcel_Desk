# Sendle

Sendle is an Australian parcel service for small businesses. The original company closed,
and Quantium Solutions' Australian operator bought the brand and runs it in Australia only.
Tracked through the two calls its tracking page makes.

## Numbers

The tracking number printed under the label's barcode is `QSS` and nine digits, and the
booking e-mail gives an order number of `QS` and six digits; the tracker and the adapter take
both. The tracking page's help text gives the `QSS` prefix and an example, which its tracker
knows. With one example for the length, `sendle-1` only suggests Sendle, ahead of the carriers
whose rules take any twelve characters. Purolator's rule for three letters and nine digits
leaves `QSS` to Sendle. Order numbers are a short counter that other carriers' rules share, so
no rule claims them. The original Sendle's references, `S` and five to seven characters, are no
longer tracked.

## How it works

1. `direct`: the page's backend is a Convex deployment, which the adapter calls over Convex's
   HTTP API rather than the page's WebSocket client. `POST
   https://keen-orca-155.convex.cloud/api/mutation` with
   `{"path":"tracking:createChallenge","args":{},"format":"json"}` returns a proof-of-work
   challenge: an id, a salt and a difficulty. The answer is the page's: the first counter,
   written in base 36, whose SHA-256 of `salt:counter` starts with that many zero bits. Sendle
   asks for 15 bits, some 33,000 hashes, tens of milliseconds. Then `POST …/api/action` with
   `tracking:lookupTracking` and `{"reference","challengeId","nonce"}`. No cookie, key, CAPTCHA
   or browser.
2. `retry`: one more try, with a new challenge, when a call fails to reach the service or
   hangs. The first try gets half of the budget.

- The solver yields between batches of hashes and stops when the lookup's signal ends or the
  try's time runs out. A challenge of more than 20 bits, a million hashes, is a challenge
  failure rather than a lookup spent hashing.
- The lookup's `status` is `found` with the parcel, `not_found` for a number the tracker does
  not know, `rate_limited` with its wait, `check_failed` for an answer it refused, which is a
  challenge failure, and `invalid_reference` for a number of another form, which is
  inconclusive since the adapter sends only the forms the page gives as examples. Only
  `not_found` is a missing parcel.
- The service answers every call with HTTP 200. A failed call is `{"status":"error"}` with a
  request id and nothing else, so it is inconclusive. A redirect or a 404 is a moved route, and
  an HTML reply is a browser check or a changed reply.
- The parcel names the label's `trackingNumber` and its `orderNumber`; the one asked must be the
  whole number. An order number's label number becomes `canonical_tracking_number`; the order
  number itself is not kept.
- Recognition makes the same lookup for the numbers `sendle-1` offers.

## Notes

- `statusCategory` is the parcel's status: `received`, `label` (booked), `transit`,
  `delivered`, `cancelled`, `returned` or `unknown`. It decides the stage, as on the page. Within
  `transit` the page reads the newest scan for a pickup or a delivery round, so a staged scan
  there refines it; `unknown` leaves the newest staged scan.
- A booked parcel can have no scans yet; with a status that names a milestone, it is a summary
  without history.
- Scans are a `description`, newest first. The page shows a free-text line under some
  (`message`): a scan that says no more than that the parcel moves takes that line's stage,
  but its text is not kept, since a delivery's details can be written there.
- The reply gives clocks with a server's microseconds and no zone. The page shows each as it
  is and labels them Sydney time, so they stay `local_time`, to the second, and are dated on
  the catalog's Sydney zone; an offset the reply states is kept.

## Limitations

- Scans have no place, and the tracker gives no estimate, weight or service.
- The deployment name comes from the page's bundle, which also names it in the page's
  `Link: preconnect` header. A new deployment is a moved route until the adapter follows it.
- The tracker pauses lookups after many searches and says how long to wait; that is rate
  limited.

## Links

`sendle.com/tracking?ref={number}` opens the tracking page with the number filled in.

## Testing

Set `SENDLE_TRACKING_NUMBER` to a `QSS` or order number and optionally `SENDLE_UNKNOWN_NUMBER`
outside the repository, then run `npm run test:carriers:live -- carriers/sendle`.
