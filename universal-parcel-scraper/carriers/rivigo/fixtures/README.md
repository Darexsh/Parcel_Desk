# Fixtures

Replies of Zoom's consignment lookup, `GET /tracking/v2/cnote/{number}`. `not-found.json` and
`withheld.json` have the shape of live replies: the notice for a number Rivigo holds nothing
under, and the one for a consignment whose tracking it does not show. No live reply with a
history has been seen, so `delivered.json` and `in-transit.json` are built from the fields the
tracking page's script reads, with the scans oldest first and their times in epoch
milliseconds. `delivered.json` goes from a collection to a delivery through two processing
centres, with an earlier leg between them. `in-transit.json` is a booking collected later,
whose newest row is the leg it is on, with that leg's arrival estimate.

Numbers, clients, consignors, consignees, staff, places, phones and clocks are invented.
