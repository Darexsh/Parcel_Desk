# Fixtures

`in-transit.json` and `delivered.json` follow the reply of `GET /tracking/{number}` in the
tracker's two wordings: English rows with the place in square brackets, and English and Chinese
rows with the place in 【】. Both carry the office code after the first row's town, and the
second the destination's postcode after its town, as the tracker writes them. `delivered.json`
repeats one row. `not-found.json` is the answer for an unknown number.

`delivered.json` uses the site's own example number. Other numbers, places, postcodes and
clocks are invented.
