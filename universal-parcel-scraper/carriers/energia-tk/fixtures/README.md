# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/rest/waybills/states` for one
receipt. `delivered.json` is a consignment handed out at its destination warehouse: its state
names who collected it, and its issue clock runs seven hours ahead of the state's own date, as
in the carrier's replies. `in-transit.json` is a consignment of three places split between a
transit warehouse and a rail trip. `not-found.json` is the 404 reply for a receipt Energia
does not know.

Numbers, names, places, coordinates, prices and clocks are invented.
