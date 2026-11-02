# Fixtures

Each file follows the reply of GTA AirSkip's `trackings/track-my-package` for one number: a
list of shipments, each with its number, standard status, service, weight, shipper and
consignee fields, references, attachments and its scans oldest first, each with a standard
status, type, category, name, place, wall clock, description, coordinates and proof-of-delivery
link. `delivered.json` has standard statuses on every scan, a sort hub scan repeated a fraction
of a second later, a discarded scan the page hides, terminal scans with their town in `Location`
and a delivery with a photo link. `returned.json` goes out for delivery, fails with the driver's
reason and returns to the hub. `in-transit.json` has older scans without standard statuses,
with the town before the reason in `Description`, a failed delivery and an estimate.
`not-found.json` is the answer for a number GTA AirSkip has no shipment for.

Numbers, names, addresses, towns, links, coordinates and clocks are invented.
