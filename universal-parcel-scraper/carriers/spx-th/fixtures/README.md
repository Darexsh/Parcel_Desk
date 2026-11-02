# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `get_order_info` with
`language_code=th`, newest scan first, with every field a scan carries. `delivered.json` is an
order SPX ships on its own, whose reply names its SPX and Shopee numbers, its driver, a
reference, a delivery estimate and the drop-off shop's address. `in-transit.json` is a parcel
from abroad held at Thai customs, with a hidden row. `not-found.json` is the answer for a number
the lookup does not find.

Numbers, names, IDs, places, coordinates and clocks are invented.
