# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `get_order_info` with
`language_code=pt`, newest scan first, with every field a scan carries. `delivered.json` is a
domestic parcel from the seller's pickup to the door: hidden rows, a repeated sorting scan, a
seller's location on the pickup, and a recipient's name in the tracking object and in a
delivery line the page does not show. `in-transit.json` is a parcel from abroad held at Brazilian
customs, with a customs check listed after a later scan and a seller pickup without a line of
its own. `not-found.json` is the answer for a number SPX does not know.

Numbers, names, IDs, places, coordinates and clocks are invented.
