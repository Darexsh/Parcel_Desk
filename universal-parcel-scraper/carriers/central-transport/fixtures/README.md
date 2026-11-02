# Fixtures

The `-trace.json` files follow the reply of `GetTraceLegStatus` for one PRO number, with every
field the summary carries: the shipper and consignee, their streets and postcodes, references
and handling units. The `-history.json` files follow the reply of `GetTrackDetails` for the same
shipment, its rows grouped by day, newest day first.

`delivered-trace.json` and `delivered-history.json` are a nine-digit PRO from the pickup to the
delivery, which only the summary states. One day lists its rows out of id order and the pickup
row is repeated. `in-transit-trace.json` and `in-transit-history.json` are an eleven-digit PRO
the tracker writes with dashes: a summary newer than every row, at a current location, after a
row flagged as a service exception. `unknown.json` is the answer for a PRO the tracker does not
know.

Numbers, keys, names, streets, postcodes, places and clocks are invented, and so are the
wordings `Departed terminal`, `Arrived at terminal`, `In Transit` and `Synthetic delay`.
