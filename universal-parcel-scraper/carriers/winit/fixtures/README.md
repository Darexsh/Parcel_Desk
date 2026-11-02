# Fixtures

`delivered.json` and `in-transit.json` follow the reply of the tracker's `getTracking` lookup for
a package number, oldest scan first, with the shipment both in its tab's list and in `all`.
`delivered.json` is an order from a US warehouse delivered by FedEx: FedEx's scans carry an
offset from UTC, the warehouse's carry its zone, and the shipment names the warehouse staff's
logins and the recipient's town and postcode. `in-transit.json` is an order from a German
warehouse handed to UPS for France, with UPS's scans labelled with the warehouse's zone and a
delivery estimate. `not-found.json` is the answer for a number WINIT does not know.

Numbers, logins, places, postcodes and clocks are invented.
