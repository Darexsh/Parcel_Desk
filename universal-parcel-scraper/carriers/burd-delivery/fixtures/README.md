# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `TrackAndTraceStatuses?number=`,
newest status first, each status with the webshop's order number and Burd's name for the
webshop beside the parcel's barcode. `delivered.json` goes from registration, the night before
the clocks go forward, through a failed attempt to a delivery the next evening.
`in-transit.json` was not handed over on the first day, then arrived at the terminal and was
moved to another day. A number Burd does not know gets HTTP 400 with no body, which the tests
build inline.

Numbers, order numbers, webshops, ids and clocks are invented.
