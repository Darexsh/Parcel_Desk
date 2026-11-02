# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/api/track/{number}`: the shipment's
fields, its details as label and value rows, its scans newest first with their state, wall clock
and remark, and each piece's copy of the scans. `delivered.json` is an export from Mumbai to
London that customs holds and clears, with a failed attempt before the delivery and one arrival
scan repeated. `in-transit.json` is an export to the United States held for the shipper's
account, then handed to a partner whose number and tracking link the reply gives.
`not-found.json` is the answer for a number Bombino does not know.

Numbers, names, towns, references, links and clocks are invented.
