# Fixtures

`delivered.json` and `in-transit.json` follow the reply of the Freightways `tracking-events`
lookup, oldest scan first as it lists them.

`delivered.json` is a courier ticket with a four-letter product code, delivered with a
signatory's name, a signature, a delivery photo and an authority-to-leave tag. `in-transit.json`
is a charge label with a delivery estimate, picked up by Post Haste and put out for delivery by
New Zealand Couriers.

An unknown number gets an empty HTTP 204 reply, so it has no fixture.

Numbers, names, places, branches, tags, links and clocks are invented.
