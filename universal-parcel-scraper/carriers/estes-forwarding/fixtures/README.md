# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `get_shipment_tracking`: the
contact metadata, then the shipment with its service, scheduled delivery, freight lines, events
in the order the service lists them and freight locations. `delivered.json` goes from the
booking to the delivery with an appointment event and one event listed twice. `in-transit.json`
is in transit with a delivery estimate, an appointment and a scheduled delivery. `not-found.json`
is the HTTP 404 answer for a number EFW does not know, and `zip-needed.json` is the answer
asking for the delivery ZIP code.

Numbers, names, places, clocks and contacts are invented.
