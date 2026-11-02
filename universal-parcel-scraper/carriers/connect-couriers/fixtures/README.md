# Fixtures

`delivered.json` and `in-transit.json` follow the reply of the tracking page's WordPress action:
the consignment's pieces, the progress rail and the scans grouped by day, unsorted within a
day, each with the staff account that made it. `delivered.json` goes from the sender's data
through two failed attempts to a collection at the depot. `in-transit.json` is a two-piece
consignment that has reached the depot; the other piece's delivery round is not the parcel
asked. `not-found.json` is the answer for a number Connect Couriers does not know.

Numbers, accounts, towns and clocks are invented.
