# Fixtures

The `.html` files follow the order's page, `GetWixOrderTrackingDetails`, trimmed to its header,
its order panel and the script that holds the number and `historyTrans`, newest first. The
panel keeps the fields the adapter must leave out: the destination with its postcode, the POMS
number, the client references, the item count and the volume.

`in-transit.html` is an order at the receiving hub, with a paperwork row and pickup rows that
share one clock, a Room of Choice service and a weight. `delivered.html` is an order from its
registration to the delivery, with a rescheduled and a cancelled appointment, a row placed
`In Transit`, rows without a location, a code the map does not know, a repeated row and a
weight of zero. `known.json` and `unknown.json` are the number check's answers for a number the
tracker holds and one it does not.

Numbers, row ids, references, towns, postcodes and clocks are invented, and so is the wording
`Synthetic hub note`.
