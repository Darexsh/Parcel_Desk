# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `get_order_info` with
`language_code=en`, newest scan first, with every field a scan carries. `delivered.json` is a
parcel from abroad through Malaysian import to the door: a seller's drop-off abroad with its
area, a hidden row, and a delay notice worded "Exception". `in-transit.json` is a domestic
parcel left at a drop-off point whose delivery attempt failed. `not-found.json` is the answer
for a number the lookup does not find.

Numbers, names, IDs, places, coordinates and clocks are invented.
