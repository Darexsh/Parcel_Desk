# Fixtures

`delivered.json` and `in-transit.json` follow the reply of the app's `getresidetail`: the
waybill with its masked sender and recipient, prices and staff, and its rows oldest first, with
manifests, plates, drivers and the courier's phone. `delivered.json` goes by land from a counter
booking to the delivery: two rows share a second at a transit warehouse, the courier's first run
ends in a scheduled delivery, and a failed attempt is repeated before the delivery, whose row
names the receiver. `in-transit.json` goes by sea and has reached a transit warehouse.
`not-found.json` is the answer for a resi Indah Logistik does not know.

Numbers, names, places, plates, phones and clocks are invented.
