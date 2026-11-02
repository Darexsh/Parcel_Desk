# Fixtures

The fixtures follow the reply of `GET /dropp/api/v1/dropp/track/json/{number}`, which the search
on dropp.is reads: the shipment's barcode, its sender, flags for a home delivery, a flight and a
shown estimate, and a `dd.MM.yyyy HH:mm` clock for each step reached, blank for the others.
`delivered.json` is a parcel from abroad collected at a pickup point, with an arrival estimate
and two steps in the same minute. `in-transit.json` is a parcel from abroad still on its way to
Iceland. `home.json` is a domestic parcel out for home delivery. `not-found.json` is the answer
for a number Dropp does not know.

Numbers, the sender and clocks are invented.
