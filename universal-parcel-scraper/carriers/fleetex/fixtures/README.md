# Fixtures

Replies of the feed FleetExpress's API publishes for 17TRACK, `GET /api/v1/17track/{number}`,
with the scans oldest first and every word of a message capitalized, as the feed writes them.
`delivered.json` goes from the shipper's submitted details to a delivery, through a depot and
out for delivery, its last scan after midnight in UTC. `in-transit.json` is a parcel to collect
whose account is set to a zone ten hours ahead of UTC. `not-found.json` is the answer for a
number the feed holds no parcel under.

Numbers, shipper names and references, places and clocks are invented.
