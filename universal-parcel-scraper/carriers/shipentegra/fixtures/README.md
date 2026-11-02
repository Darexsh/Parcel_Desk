# Fixtures

Each file follows the reply of `track_service.php`, newest scan first, with the summary fields
the page reads. `delivered.json` goes from ShipEntegra's own three scans through export
clearance, the flight and import customs to a delivery by a Widect partner; one sorting scan is
repeated, a failed attempt names a phone number and the delivery names who signed for it.
`in-transit.json` has only ShipEntegra's scans and names UPS and its number for the onward
journey. `pending.json` waits for the seller to hand the parcel over and names ShipEntegra
itself as the last-mile carrier. `not-found.json` is the answer for a number the tracker does
not know, here nine zeros.

Numbers, account ids, names, phone numbers and clocks are invented.
