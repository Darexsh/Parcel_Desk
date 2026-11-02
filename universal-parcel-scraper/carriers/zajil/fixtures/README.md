# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `mobileapi.zajil-express.org/track?shipment=`:
the shipment with its route, its current status in `current_update` and the same status as the one
row of `history`, with the reply's placeholders (`not found`, `string`, `false`). `delivered.json`
was delivered at a branch; `in-transit.json` was released from a hub. `not-found.json` is the
lookup's answer for a number it does not know, and `server-error.html` the server error it gives
for an eleven-digit number it has no shipment for.

Numbers, places, hub codes, amounts and clocks are invented.
