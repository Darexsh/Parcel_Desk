# Fixtures

`delivered.json`, `in-transit.json` and `not-found.json` follow the reply of `api/t/byNumber`,
the lookup the tracking search makes: three result lists, for freight, expedited and truckload
shipments, each result a shipment's current status with its service center, its pickup,
delivery, estimate and appointment clocks, its partners and its PRO as a number.

`delivered.json` is a shipment delivered within its appointment, with the signer, trailer and
the service center's address, phone and position. `in-transit.json` is a ten-digit PRO handed to
a delivery partner, whose status is the partner's arrival at its terminal, with an estimated
day and an appointment that day. `not-found.json` is the answer for a PRO the tracker does
not know.

Numbers, people's names, places, phones, clocks and references are invented; the partner is a real
carrier.
