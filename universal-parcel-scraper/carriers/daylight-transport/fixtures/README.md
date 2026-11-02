# Fixtures

Each shipment has two files, the replies of the two lookups the MyDaylight shipment page makes:
`*.details.json` follows `api/v1/shipments/public` and `*.history.json` follows
`api/v1/shipments/history/public`, newest row first.

`delivered` goes from the pickup request to the delivery. Its details carry the shipper, the
consignee, the forwarder with their addresses, contacts and phones, customer references, items,
special instructions and a notification e-mail; its history places rows at customers' ZIP codes
and at terminals, repeats one row, and lists an appointment row out of clock order, as replies
do. `in-transit` is on its way, with a delivery window ahead and an appointment row as its newest
row. `not-found` is the HTTP 404 details answer and the empty history for a probill Daylight does
not know.

Numbers, names, references, places, postcodes, phones, e-mails and clocks are invented.
