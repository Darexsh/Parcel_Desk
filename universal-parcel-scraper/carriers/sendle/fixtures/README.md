# Fixtures

The replies follow the Convex HTTP API's envelope, `{"status":"success","value":…}`, for the
tracking page's two calls.

- `challenge.json` is `tracking:createChallenge`'s proof-of-work challenge, with a lower
  difficulty than the service asks so the tests solve it at once.
- `booked.json` is `tracking:lookupTracking`'s answer for a booked label, the shape of a live
  reply: one scan whose clock has microseconds and no offset.
- `in-transit.json` follows the page's bundle: scans with the line the page shows under them
  (`message`), one listed twice, newest first.
- `not-found.json` is the answer for a number the tracker does not know.

Numbers, clocks, challenge and names are invented.
