# Fixtures

`delivered.json` and `in-transit.json` follow the reply of the app's `rpx/tracking/{awb}`
lookup: the scans newest first, each with its code, wording, station, wall clock and a note
ending in the parcel's weight, then the delivery details. `delivered.json` goes from the
shipper's booking to the delivery, with one departure scan repeated, and its delivery details
carry a recipient, a receiver, the town, where the parcel was left, photo links and
coordinates. `in-transit.json` has just reached the destination station under a code no map
knows, with a delivery estimate; its departure note gives no weight. `not-found.json` is the
HTTP 400 answer for a number RPX does not know.

Numbers, names, places, links, coordinates, weights and clocks are invented.
