# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/alerce/tracking`, with every field
of the shipment and its events newest first. `delivered.json` goes from the intake at a branch
to the delivery: one departure is repeated, the distribution centre's receipt was entered hours
after it happened, and the shipment carries the sender's and the recipient's details, who took
the parcel and a closed customer request. `in-transit.json` has left a distribution centre on
its way to the destination branch. `not-found.json` is the answer for a number Via Cargo does
not know, and `access-denied.json` the service's refusal of a request without the page's key.

Numbers, names, IDs, places and clocks are invented.
