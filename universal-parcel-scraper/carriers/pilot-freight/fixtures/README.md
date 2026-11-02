# Fixtures

`delivered.json` and `in-transit.json` follow the reply of
`wwwapi.pilotdelivers.com/track/{pro in base64}/orgzip/0/dstzip/0/custnum/0` for one pro number,
newest event first, with the masked parties, line items, references, station contacts, proof of
delivery and document link the service sends. `delivered.json` goes from the booking in Texas to
a delivery in Ohio in summer time: the booking's appointment row is recorded by phone, one hub
event is repeated, and the delivery names who signed and where the freight was left.
`in-transit.json` is a shipment from California to New York in winter time whose newest row is
an appointment, with the delivery window the service estimates. `not-found.json` is the answer
for a pro number the service has no shipment under.

Numbers, names, places, clocks, references, contacts and links are invented.
