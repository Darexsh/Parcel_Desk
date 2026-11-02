# Fixtures

`delivered.json` and `collected.json` follow the shape of the reply from Redpack's
`trackingByNumber` service: a list with one guide, its result code, its parcels and their
situations with code, wording, place, shipment-control notes and a clock labelled `+0000`.
`collected.json` is a guide whose history holds only its pickup, with code 0. `not-found.json`
is the reply for a guide the service does not know and `error.json` the service failing.
Numbers, names, places, notes, references and clocks are invented.
