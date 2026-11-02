# Fixtures

The files follow the shape of the public tracker's three replies. Numbers, ids, towns, location
codes, vehicles and clocks are invented.

`search-found.json` is the search reply for a road shipment found under its own tracking
number, with its weight and newest milestone. `search-not-found.json` is the reply for a
reference the tracker does not hold.

`routing-delivered.json` and `information-delivered.json` are the route and notices of a road
shipment from Germany delivered in France: a planned pickup, departure and arrival stations, the
delivery round and the delivery, then a booking, a delivery appointment, a booking confirmed
after the truck left and the proof of delivery.

`routing-in-transit.json` and `information-in-transit.json` are a road shipment from Great
Britain to Greece in transit in Germany. Its British scans carry no offset. The notices hold
export customs steps, one with a detail, and an import customs step still to come, without a
date.
