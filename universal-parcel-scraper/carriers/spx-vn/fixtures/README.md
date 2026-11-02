# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `get_order_info` with
`language_code=vi`, newest scan first, with every field a scan carries. `delivered.json` is a
domestic parcel delivered on a second round, with a hidden failed attempt, a hidden line-haul
end and a recipient's name in the tracking object. `in-transit.json` is a parcel at its first
hub after a failed pickup and a drop-off. `not-found.json` is the answer for a number the lookup
does not find.

Numbers, names, IDs, places, coordinates and clocks are invented.
