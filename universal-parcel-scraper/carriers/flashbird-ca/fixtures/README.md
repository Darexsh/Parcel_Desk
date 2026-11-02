# Fixtures

Synthetic replies of FlashBird's tracking service, shaped as its live replies, history oldest
first. `delivered.json` goes from the shop's shipment to the delivery, with the route's start
logged twice, and carries the delivery flag and the keys of two delivery photos.
`in-transit.json` is out for delivery, with the driver's estimate in seconds, the stops left
and the driver's position. `not-found.json` is the empty object the service answers for a
number it does not hold.

Numbers, photo keys, task and driver ids, positions and clocks are invented.
