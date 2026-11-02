# Fixtures

The shipments follow the reply of `/v0/customer-portal/shipments/{ID}` with the fields Relay's
tracking app reads, scans oldest first. `delivered.json` goes from the order to a delivery to a
neighbour, with a repeated warehouse scan, a failed attempt the day before, courier notes, a
proof-of-delivery photo, the recipient's address and a safe place with a door code.
`in-transit.json` is a parcel dropped off at a shop by its seller and out for delivery with
today's window, after a delay. `collection.json` waits at the shop chosen for collection.
`not-found.json` is the 404 body for an unknown ID or a wrong postcode.

Numbers, names, addresses, postcodes, places and clocks are invented.
