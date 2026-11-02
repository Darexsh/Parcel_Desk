# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `wp-json/adp/2/shipment/status`: one
result with the shipment's status, its parties with their addresses, its references, a comment,
its pieces and weight, and its history oldest first, each row with a wall clock and its offset
in a field of its own, and the windows after the scans.

`delivered.json` is a winter shipment delivered after its billing became its status: a pickup
in a Central time state labelled with Eastern time's offset, an arrival listed twice, an out for
delivery row without a place, a delivery whose row spans the stop, and pickup and ETA windows.
`in-transit.json` is a shipment handed to a delivery partner, in the older form with clocks to
the minute: a pickup dated at midnight, a departure in the second of the hours Eastern clocks
repeat, and a delivery appointment window. `not-found.json` is the answer for a PRO the tracker
does not know.

Numbers, names, addresses, references, places, clocks and weights are invented.
