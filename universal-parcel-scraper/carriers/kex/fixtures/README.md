# Fixtures

Each JSON file follows the reply of the tracking page's lookup for one number: an entry echoing
the number, with the progress rail, the shipment and its scans newest first. `delivered.json`
goes from a drop-off at a service point to the delivery: the origin station's arrival carries a
suffixed code, one distribution-centre scan is repeated, the courier's call to the recipient
comes before the delivery, and the shipment carries masked and unmasked names, phone numbers, a
reference, a signature and a delivery photo. `in-transit.json` was picked up by a courier and
has left a distribution centre. `not-found.json` is the answer for a number the tracker does not
know, and `placeholder.json` the waiting row a selling platform's number gets before the parcel
reaches KEX. `service-error.json` is the service's own failure.

Numbers, names, phone numbers, references, places, coordinates and clocks are invented.
