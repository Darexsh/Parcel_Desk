# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `get_order_info` with
`language_code=id`, newest scan first, with every field a scan carries. `delivered.json` is a
domestic parcel from the seller's pickup to the door: hidden rows, a seller's location on the
pickup, a repeated sorting scan, a line-haul end, and a recipient's name in the tracking object
and in the delivery line. `in-transit.json` is a parcel between sorting centres, with a scan
whose line is empty. `not-found.json` is the answer for a number the lookup does not find, and
`no-history.json` the answer for an order without scans.

Numbers, names, IDs, places, coordinates and clocks are invented.
