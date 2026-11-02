# Fixtures

`delivered.json` and `in-transit.json` follow the reply of Ship Logic's `/tracking/shipments` on
Internet Express's portal, newest scan first. `delivered.json` goes from the booking to a
delivery with a failed collection, two scans with the same clock, driver notices, events the
portal hides and a piece's own delivery scan. `in-transit.json` is a two-piece shipment between
hubs with a piece's own hub scan. `not-found.txt` is the service's plain-text answer for a
reference it does not know.

References, places, messages and clocks are invented.
