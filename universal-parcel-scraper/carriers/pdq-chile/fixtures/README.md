# Fixtures

The replies of the tracking page's `/api/tracking?q={number}`, in the shape the live lookup
returns. `delivered.json` goes from the origin centre to a delivery after a failed attempt: one
delivery round is repeated, the failed attempt and the delivery carry a detail line naming the
recipient, and the shipment names its references, the sender's postcode and who received it.
`in-transit.json` has reached its destination city, with an estimated delivery day.
`not-found.json` is the answer, sent with HTTP 404, for a guide number PDQ does not know.

Numbers, references, names, places and clocks are invented.
