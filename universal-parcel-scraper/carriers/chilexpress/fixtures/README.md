# Fixtures

`delivered.json`, `in-transit.json` and `returned.json` follow the shape of the reply from the
`gettracking` service of Chilexpress's help centre: the order's summary (`DatosOT`), its scans
(`ListTracking`) newest first with event type, wording, facility, receiver and route notes, and
the outcome (`Respuesta`). `in-transit.json` is an order still on its way, with a repeated scan.
`returned.json` is an order that waited at a branch until its collection deadline and went back
to its sender. `not-found.json` is the reply for an order the service does not know.

`help-centre.html` is the help centre's page, which names its script. `help-centre-main.js` is
the part of that script holding the sign-in values for the help centre and for another
Chilexpress site.

Numbers, names, places, references, measures, clocks and sign-in values are invented.
