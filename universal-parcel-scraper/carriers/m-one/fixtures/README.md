# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `api.m-one.rs/api/statushistory/{number}`:
one row per scan, oldest first, each repeating the number, the sender's and recipient's names
and countries, the weight and the piece count. `delivered.json` goes from the pickup order to a
delivery after a failed attempt and a day the recipient was to collect the parcel; a transit
scan is repeated, and the pickup order's wording ends with a line break. `in-transit.json` is
redirected at the delivering distribution centre and is back in local transit. An unknown
number gets HTTP 404 with a body that never ends, so it has no fixture.

Numbers, names, depots, weights and clocks are invented.
