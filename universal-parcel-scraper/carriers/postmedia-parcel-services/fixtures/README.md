# Fixtures

Replies of the tracker's API, `GET /query/{number}+{postal code}`, as the page receives them,
with the scans oldest first. `delivered.json` goes from the seller's facility to a delivery,
its first scan's province given by code and the others by name. `in-transit.json` is a parcel
out for delivery whose scans cross midnight in GMT. `not-found.json` is the answer for a
number and postal code the tracker holds nothing under.

Numbers, record ids, towns and clocks are invented.
