# Fixtures

`delivered.json`, `in-transit.json` and `ready.json` follow the shape of the tracking API's
reply: the parcel's state, its origin and destination locker, its scans with their type, place
and UTC clock, and its payment. Numbers, names, places, postcodes, coordinates and clocks are
invented. `not-found.json` is the reply for a parcel id the API does not know.
