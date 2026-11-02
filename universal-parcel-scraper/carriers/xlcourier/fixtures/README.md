# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `getLogisticsTrack/{number}`, oldest
scan first, with the recipient's address the page pins on its map. `delivered.json` goes from
the label through a depot and the national hub to a failed attempt, whose reason gives a phone
number, and a delivery the next week; one hub scan is repeated. `in-transit.json` has left the
national hub, with two scans on the same clock. `not-found.json` is the answer for a number
XLCourier does not know.

Numbers, addresses, places, reasons and clocks are invented.
