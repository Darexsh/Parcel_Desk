# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/umbraco/api/tools/trackshipment`
in English, a list with one shipment and its scans oldest first. `delivered.json` is a domestic
parcel from the sender's announcement to the delivery: one scan is repeated, the courier's calls
and a postponed delivery come before it, and the last two offices are named only by their code.
`in-transit.json` comes from abroad: the origin post's dispatch, customs, a request to complete
the address, then on its way to the delivery office, with a delivery estimate. `not-found.json`
is the answer for a number SPL does not know, and `rejected.html` the page the site's firewall
serves instead of a request it refuses.

Numbers, offices, places, clocks, coordinates and support IDs are invented.
